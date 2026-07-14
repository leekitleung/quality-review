#!/usr/bin/env node
/**
 * Review Gate - Deterministic Quality Gate
 * Main entry point that orchestrates all modules
 */

import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execSync, execFileSync } from 'child_process';
import { createHash } from 'node:crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = process.cwd();
const SKILL_DIR = join(PROJECT_ROOT, 'skills', 'release-quality-review');
const REPORT_DIR = join(PROJECT_ROOT, 'quality-reports');
const CONFIG_FILE = join(SKILL_DIR, 'review-config.yaml');

// Import from modules
import { colors, log } from './modules/constants.mjs';
import { parseCliArgs } from './modules/cli.mjs';
import { PROFILES, loadConfig, loadYamlProfile, loadReviewer } from './modules/config.mjs';
import { detectChangeScale, printScaleDetection } from './modules/scale.mjs';
import {
  validCommandEvidence,
  validCandidateCheckoutEvidence,
  collectEvidence,
  persistEvidence,
  persistFinalArbitration,
  runEvidenceCommand,
  runAutomatedChecks,
  scanCircularDependencies,
} from './modules/evidence.mjs';
import {
  validateReviewerIdentity,
  loadExistingScores,
  reviewerPacketPassed,
} from './modules/scores.mjs';
import { scanRoundArtifacts } from './modules/scanner.mjs';
import {
  generateSummary,
  generateFinalReport,
  writePhaseBoundary,
  updateMetadataWithScale,
} from './modules/reports.mjs';
import { getReviewerFocus, persistPhasePlan } from '../lib/phase-persistence.mjs';

// Import from utils (already shared)
import {
  parseScore,
  parseBlockers,
  parseYamlResult,
  matchesTriggerConditions,
  findTrivialVerificationScripts,
  hasConcreteVerificationOutput,
  validateCleanCandidateEvidence,
  validateRollbackEvidence,
} from '../lib/review-utils.mjs';
import {
  containsSensitiveText,
  redactSensitiveText,
  ensureContainedDirectorySync,
  readContainedFileSync,
  writeContainedFileSync,
} from '../lib/security-utils.mjs';

import { createCandidateRuntime } from '../lib/candidate-runtime.mjs';
const { prepareCheckout, readIdentity, validateCheckout } = createCandidateRuntime(PROJECT_ROOT, 'gate');

// CLI and options
const options = parseCliArgs(process.argv.slice(2));
const {
  profile,
  singleReviewer,
  checkRedlinesOnly,
  roundNumber,
  collectEvidence: collectEvidenceOpt,
  dryRun,
  excludeReviewers,
  validateEvidence,
  checkGoalMode,
  diffBase,
} = options;

// Resolve diff base
let resolvedDiffBase = diffBase;
try {
  resolvedDiffBase = execSync(`git rev-parse ${diffBase} 2>/dev/null || echo "${diffBase}"`, { encoding: 'utf-8' }).trim();
} catch {}

// Detect scale at startup
let startupScaleInfo = { scale: 'micro', files: 0, additions: 0, deletions: 0, total: 0, suggestedProfile: 'quick' };
if (options.detectScale) {
  startupScaleInfo = detectChangeScale(PROJECT_ROOT, resolvedDiffBase);
  printScaleDetection(startupScaleInfo, options.userSpecifiedProfile, profile);
}

// Command execution wrapper
function execSync_(cmd, opts = {}) {
  try {
    return execSync(cmd, { encoding: 'utf-8', timeout: opts.timeout ?? 30000, cwd: opts.cwd ?? PROJECT_ROOT, ...opts });
  } catch (err) {
    if (err.stdout && !opts.suppressOutput) console.error(err.stdout);
    if (err.stderr && !opts.suppressOutput) console.error(err.stderr);
    return err.stdout?.trim?.() ?? '';
  }
}

async function runGate() {
  if (!options.userSpecifiedProfile) {
    log.info(`Change scale: ${colors.bright}${startupScaleInfo.scale}${colors.reset} (${startupScaleInfo.files} files, ${startupScaleInfo.total} lines)`);
    if (startupScaleInfo.suggestedProfile !== profile) {
      log.info(`Suggested profile: ${colors.cyan}${startupScaleInfo.suggestedProfile}${colors.reset} (use --profile to override)`);
    }
  }

  const config = loadConfig(join(SKILL_DIR, 'review-config.yaml'));
  const strictProfileRequested = ['release-gate', 'full', 'agentic-release-gate'].includes(profile);
  if (strictProfileRequested && excludeReviewers.length > 0) {
    log.error('Strict profiles do not allow --exclude-reviewer');
    return false;
  }

  // Determine reviewers to run
  let reviewers = [];
  let profileConfig = PROFILES[profile] || PROFILES['release-gate'];

  const yamlProfile = loadYamlProfile(SKILL_DIR, profile);
  if (yamlProfile) {
    log.info(`Loaded YAML profile: ${yamlProfile.name}`);
    log.info(` Resident reviewers: ${JSON.stringify(yamlProfile.resident_reviewers)}`);
    log.info(` Conditional reviewers: ${JSON.stringify(yamlProfile.conditional_reviewers)}`);

    reviewers = [...yamlProfile.resident_reviewers];
    const triggeredConditional = (() => {
      if (!yamlProfile.conditional_reviewers || yamlProfile.conditional_reviewers.length === 0) return [];
      const gitOutput = execFileSync('git', ['diff', '--name-only', resolvedDiffBase], { encoding: 'utf-8', cwd: PROJECT_ROOT, timeout: 10000 });
      const untracked = execFileSync('git', ['ls-files', '--others', '--exclude-standard'], { encoding: 'utf-8', cwd: PROJECT_ROOT, timeout: 10000 });
      const changedFiles = [...new Set(`${gitOutput}\n${untracked}`.split('\n').filter(f => f.trim()))];
      const diffContent = execFileSync('git', ['diff', resolvedDiffBase], { encoding: 'utf-8', cwd: PROJECT_ROOT, timeout: 10000, maxBuffer: 10 * 1024 * 1024 });
      return yamlProfile.conditional_reviewers.filter(r => {
        const conditions = (yamlProfile.trigger_conditions || {})[r];
        return !conditions || matchesTriggerConditions(changedFiles, diffContent, conditions);
      });
    })();
    if (triggeredConditional.length > 0) {
      log.info(`Conditional reviewers triggered: ${triggeredConditional.join(', ')}`);
      reviewers = [...reviewers, ...triggeredConditional];
    }

    if (yamlProfile.gate?.require_adversarial && yamlProfile.adversarial_reviewers?.length > 0) {
      log.info(`Adversarial reviewers (required): ${JSON.stringify(yamlProfile.adversarial_reviewers)}`);
      reviewers = [...reviewers, ...yamlProfile.adversarial_reviewers];
    }

    profileConfig = {
      name: yamlProfile.name,
      description: yamlProfile.description,
      reviewers: reviewers,
      gate: yamlProfile.gate,
    };
    reviewers = reviewers.filter(r => !excludeReviewers.includes(r));
  } else {
    if (options.userSpecifiedProfile) {
      log.error(`Profile not found: ${profile}`);
      return false;
    }
    reviewers = profileConfig.reviewers.filter(r => !excludeReviewers.includes(r));
  }

  if (singleReviewer) {
    reviewers = [singleReviewer];
  }
  reviewers = [...new Set(reviewers)];
  if (reviewers.length === 0) {
    log.error('GATE BLOCKED - no reviewers selected');
    return false;
  }

  // Dry run mode
  if (dryRun) {
    log.info(`Dry run mode - validating configuration`);
    log.info(`Profile: ${profile}`);
    log.info(`Reviewers: ${reviewers.join(', ')}`);
    log.info(`Round: ${roundNumber}`);
    for (const reviewer of reviewers) {
      const exists = existsSync(join(SKILL_DIR, 'reviewers', `${reviewer}.md`));
      log.info(` ${exists ? '✓' : '✗'} ${reviewer}: ${exists ? 'found' : 'MISSING'}`);
    }
    return reviewers.every(r => existsSync(join(SKILL_DIR, 'reviewers', `${r}.md`)));
  }

  // Logging and setup
  console.log('');
  log.title('RELEASE QUALITY GATE');
  log.info(`Profile: ${colors.bright}${profile}${colors.reset}`);
  log.info(`Reviewers: ${reviewers.join(', ')}`);
  console.log('');

  ensureContainedDirectorySync(PROJECT_ROOT, REPORT_DIR);
  let roundDir = join(REPORT_DIR, `round-${String(roundNumber).padStart(3, '0')}`);

  const isNewRound = !existsSync(roundDir);
  if (isNewRound) {
    ensureContainedDirectorySync(REPORT_DIR, roundDir);
    log.info(`New round: ${roundDir}`);
  } else {
    ensureContainedDirectorySync(REPORT_DIR, roundDir);
    log.info(`Continuing round: ${roundDir}`);
  }

  const currentCandidateCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: PROJECT_ROOT, encoding: 'utf8', timeout: 10000 }).trim();
  const currentCandidateTree = execFileSync('git', ['rev-parse', 'HEAD^{tree}'], { cwd: PROJECT_ROOT, encoding: 'utf8', timeout: 10000 }).trim();

  // Initialize isolated candidate checkout
  prepareCheckout();

  if (!isNewRound && collectEvidenceOpt) {
    const existingMetadataPath = join(roundDir, 'metadata.json');
    const existingCleanPath = join(roundDir, 'evidence', 'clean-candidate.json');
    try {
      if (existsSync(existingMetadataPath)) {
        const existingMetadata = JSON.parse(readContainedFileSync(roundDir, existingMetadataPath, 'utf8'));
        if ((existingMetadata.candidate_commit !== currentCandidateCommit || existingMetadata.candidate_tree !== currentCandidateTree)) {
          throw new Error('existing round is bound to a different candidate identity; use a fresh round');
        }
      } else if (existsSync(existingCleanPath)) {
        const existingClean = JSON.parse(readContainedFileSync(roundDir, existingCleanPath, 'utf8'));
        if ((existingClean.candidate_commit !== currentCandidateCommit || existingClean.candidate_tree !== currentCandidateTree)) {
          throw new Error('existing round is bound to a different candidate identity; use a fresh round');
        }
      }
    } catch (error) {
      log.error(`Round candidate identity check failed: ${error.message}`);
      persistFinalArbitration(roundDir, false, 'candidate identity mismatch', reviewers, process.argv);
      return false;
    }
  }

  persistFinalArbitration(roundDir, false, 'gate evaluation in progress', reviewers, process.argv);

  // Main entry: run evidence collection and quality checks
  let evidence = null;
  if (collectEvidenceOpt) {
    try {
      evidence = collectEvidence(config, PROJECT_ROOT, resolvedDiffBase, resolvedDiffBase, SKILL_DIR);
      await persistEvidence(PROJECT_ROOT, roundDir, evidence, profile, roundNumber, reviewers, resolvedDiffBase);
      log.success(`Evidence collected`);
    } catch (e) {
      log.error(`Evidence collection failed: ${e.message}`);
      return false;
    }
  } else {
    const metadataPath = join(roundDir, 'metadata.json');
    const automatedPath = join(roundDir, 'evidence', 'automated-checks.json');
    if (existsSync(metadataPath) && existsSync(automatedPath)) {
      try {
        const metadata = JSON.parse(readContainedFileSync(roundDir, metadataPath, 'utf8'));
        const automatedChecks = JSON.parse(readContainedFileSync(roundDir, automatedPath, 'utf8'));
        const fullCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: PROJECT_ROOT, encoding: 'utf8' }).trim();
        const currentTree = execFileSync('git', ['rev-parse', 'HEAD^{tree}'], { cwd: PROJECT_ROOT, encoding: 'utf8' }).trim();
        const digest = createHash('sha256').update(readContainedFileSync(roundDir, automatedPath, 'utf8')).digest('hex');
        if (metadata.candidate_commit !== fullCommit || metadata.candidate_tree !== currentTree || metadata.automated_checks_sha256 !== digest) {
          throw new Error('persisted evidence does not match the current commit and working-tree status');
        }
        // Validate command evidence structure for all gates
        const expectedCommands = {
          testGate: config?.verification?.test || 'pnpm test',
          typecheckGate: config?.verification?.typecheck || 'pnpm typecheck',
          buildGate: config?.verification?.build || 'pnpm build',
          lintGate: config?.verification?.lint || 'pnpm lint',
          auditGate: config?.verification?.audit || 'npm audit --audit-level=high',
        };
        if (profile === 'agentic-release-gate') {
          expectedCommands.coverageGate = config?.verification?.coverage || 'npm run coverage';
        }
        for (const [name, expectedCommand] of Object.entries(expectedCommands)) {
          if (!validCommandEvidence(automatedChecks[name], expectedCommand) ||
              (name === 'testGate' && !hasConcreteVerificationOutput('test', automatedChecks[name]?.output)) ||
              (name === 'coverageGate' && !hasConcreteVerificationOutput('coverage', automatedChecks[name]?.output))) {
            throw new Error(`invalid ${name} command evidence`);
          }
        }
        // Validate candidate checkout evidence
        if (automatedChecks.candidateCheckout && !validCandidateCheckoutEvidence(
          automatedChecks.candidateCheckout, metadata.candidate_commit, metadata.candidate_tree
        )) {
          throw new Error('invalid automated verification checkout evidence');
        }
        evidence = {
          timestamp: metadata.collected_at,
          git: metadata.git,
          files: metadata.files,
          automatedChecks,
        };
        log.info('Loaded persisted automated evidence for the current candidate');
      } catch (error) {
        log.error(`Persisted evidence is invalid: ${error.message}`);
        log.warn('Re-collecting evidence...');
        evidence = collectEvidence(config, projectRoot, diffBase, resolvedDiffBase, SKILL_DIR);
      }
    }
  }

  // Persist phase plan for Gate-owned rounds
  try {
    if (evidence) {
      persistPhasePlan(roundDir, roundNumber, reviewers, evidence, profileConfig);
    }
  } catch {
    // Phase plan is best-effort
  }

  // Load scores for validated reviewers
  const existingScores = loadExistingScores(roundDir, reviewers, currentCandidateCommit, currentCandidateTree, profile, roundNumber, (r, p) => validateReviewerIdentity(SKILL_DIR, r));

  const minScore = Number((profileConfig.gate?.min_score) ?? 90);
  const allValid = reviewers.every(r => existingScores[r].isValidReviewer !== false);
  const allHaveScores = reviewers.every(r => existingScores[r].score !== null);

  // Evidence source validation (对抗性审查)
  let evidenceValidationPassed = !validateEvidence;
  if (validateEvidence && allHaveScores) {
    log.title('EVIDENCE SOURCE VALIDATION');
    try {
      const evidenceValidatorScript = join(SKILL_DIR, 'scripts', 'evidence-validator.mjs');
      if (existsSync(evidenceValidatorScript)) {
        const roundName = `round-${String(roundNumber).padStart(3, '0')}`;
        const validatorOutput = execSync(`node "${evidenceValidatorScript}" --round ${roundName} --base ${resolvedDiffBase}`, { encoding: 'utf-8', cwd: PROJECT_ROOT, timeout: 60000 });
        evidenceValidationPassed = validatorOutput.includes('✅ All reviewers passed');
        if (evidenceValidationPassed) {
          log.success('Evidence source validation passed');
        } else {
          log.warn('Evidence validation found issues');
          console.log(validatorOutput);
        }
      } else {
        log.error('Evidence validator is missing');
      }
    } catch {
      evidenceValidationPassed = false;
    }
  }

  // Goal mode constraint
  let goalModeViolations = [];
  if (checkGoalMode && allHaveScores) {
    log.title('GOAL MODE CONSTRAINT CHECK');
    const goalModePatterns = [
      { pattern: /实现了|添加了|写了|创建了|修改了/g, desc: '描述实现动作而非目标状态' },
      { pattern: /按照.*步骤|分.*步|逐步/g, desc: '描述实现过程而非最终状态' },
      { pattern: /我们添加|我写的|上面的代码/g, desc: '使用第一人称或引用过程' },
    ];

    for (const reviewer of reviewers) {
      const reviewerDir = join(roundDir, reviewer);
      const scorePath = join(reviewerDir, 'score.md');
      if (existsSync(scorePath)) {
        const content = readContainedFileSync(roundDir, scorePath, 'utf-8');
        for (const { pattern, desc } of goalModePatterns) {
          pattern.lastIndex = 0;
          const matches = content.match(pattern);
          if (matches && matches.length > 0) {
            goalModeViolations.push({ reviewer, desc, count: matches.length });
            log.warn(`${reviewer}: ${desc} (${matches.length} 处)`);
          }
        }
      }
    }
    if (goalModeViolations.length === 0) {
      log.success('Goal mode constraint satisfied - all reviewers describe final state');
    }
  }

  // Goal instruction validation
  let goalInstructionResult = null;
  const goalRequired = profile === 'agentic-release-gate';
  if (!goalRequired && existsSync(join(roundDir, 'generated-goal.md'))) {
    try {
      const goalGateScript = join(SKILL_DIR, 'scripts', 'goal-instruction-gate.mjs');
      if (existsSync(goalGateScript)) {
        const plain = execSync(`node "${goalGateScript}" --file "${join(roundDir, 'generated-goal.md')}"`, { encoding: 'utf-8', cwd: PROJECT_ROOT, timeout: 30000 });
        const scoreMatch = plain.replace(/\x1b\[[0-9;]*m/g, '').match(/Score:\s*(\d+)/);
        goalInstructionResult = { passed: (scoreMatch ? parseInt(scoreMatch[1], 10) : 0) >= 90, score: scoreMatch ? parseInt(scoreMatch[1], 10) : 0 };
        if (goalInstructionResult.passed) {
          log.success(`Goal instruction valid (${goalInstructionResult.score}/100)`);
        }
      }
    } catch {}
  }

  // Calculate overall status
  const allPassed = allHaveScores && reviewers.every(r => reviewerPacketPassed(existingScores[r], minScore));
  const autoChecks = evidence?.automatedChecks;
  const strictProfile = ['release-gate', 'full', 'agentic-release-gate'].includes(profile);

  const automatedChecksPassed = strictProfile
    ? Boolean(autoChecks) && autoChecks.testGate?.status === 'pass' && autoChecks.typecheckGate?.status === 'pass' && autoChecks.buildGate?.status === 'pass' && autoChecks.lintGate?.status === 'pass' && autoChecks.auditGate?.status === 'pass' && autoChecks.secrets?.status === 'pass' && autoChecks.circularDeps?.status !== 'fail' && evidenceValidationPassed
    : Boolean(autoChecks) && autoChecks.testGate?.status === 'pass' && hasConcreteVerificationOutput('test', autoChecks?.testGate?.output);

  const vetoFindingsPresent = Object.values(existingScores).some(r => r.blockers?.some(b =>
    (typeof b === 'string' && /\bP0\b|\bP1\b/i.test(b)) || (b.priority === 'P0' || b.priority === 'P1')
  ));

  const hasRedlines = profileConfig.gate?.fail_on_p0_p1_blockers !== false && vetoFindingsPresent;
  const goalInstructionValid = goalRequired ? (goalInstructionResult?.passed === true) : true;

  const artifactCompletenessPassed = !goalRequired || profile === 'agentic-release-gate';
  const sensitiveArtifactFindings = allHaveScores ? scanRoundArtifacts(roundDir) : [];
  const generatedArtifactsSafe = sensitiveArtifactFindings.length === 0;
  const arbitrationEligible = !singleReviewer && excludeReviewers.length === 0;

  const gatePassed = allPassed && !hasRedlines && evidenceValidationPassed && goalModeViolations.length === 0 && goalInstructionValid && artifactCompletenessPassed && generatedArtifactsSafe && automatedChecksPassed && arbitrationEligible;

  log.title('GATE STATUS');

  // Check invalid reviewers first
  if (!allValid) {
    log.error('GATE BLOCKED - Invalid reviewers detected');
    for (const [reviewer, result] of Object.entries(existingScores)) {
      if (!result.isValidReviewer) {
        log.error(` - ${reviewer}: ${result.validationError}`);
      }
    }
    generateSummary(roundDir, profile, roundNumber, existingScores, false, evidence, reviewerPacketPassed);
    persistFinalArbitration(roundDir, false, 'invalid reviewer packet', reviewers, process.argv);
    return false;
  }

  if (allHaveScores && allPassed && gatePassed) {
    writePhaseBoundary(roundDir, roundNumber, String(roundNumber).padStart(3, '0'), 'END (Release Complete)');
    generateSummary(roundDir, profile, roundNumber, existingScores, true, evidence, reviewerPacketPassed);
    generateFinalReport(roundDir, existingScores, evidence, profile, reviewerPacketPassed);

    const finalArtifactFindings = scanRoundArtifacts(roundDir);
    if (finalArtifactFindings.length > 0) {
      log.error(`Final artifact security scan failed: ${finalArtifactFindings.join(', ')}`);
      persistFinalArbitration(roundDir, false, 'final artifact security scan failed', reviewers, process.argv);
      return false;
    }

    log.success('All gates PASSED!');
    log.success('Evidence source validation passed');
    log.success('Goal mode constraint satisfied');
    persistFinalArbitration(roundDir, true, 'all conjunctive gates passed', reviewers, process.argv);
    console.log('');
    log.success('🎉 Release is ready!');
    return true;
  } else if (allHaveScores) {
    log.error('GATE FAILED');
    if (autoChecks?.testGate?.status !== 'pass') log.error(`Automated test gate FAILED: tests failed or missing`);
    if (autoChecks?.typecheckGate?.status !== 'pass') log.error(`Automated typecheck gate FAILED: type errors or missing`);
    if (hasRedlines) log.error('Redlines detected - blocking release');
    if (!evidenceValidationPassed) log.error('Evidence source validation failed - self-verification detected');
    if (checkGoalMode && goalModeViolations.length > 0) log.error('Goal mode constraint violated - describing implementation steps instead of final state');
    if (goalRequired && goalInstructionResult && !goalInstructionResult.passed) log.error(`Goal instruction invalid (${goalInstructionResult.score}/100) - contains plan language`);
    if (!artifactCompletenessPassed) log.error('Required agentic Goal, evidence, risk, and handoff artifacts are incomplete');
    if (!generatedArtifactsSafe) log.error(`Generated artifact security scan failed: ${sensitiveArtifactFindings.join(', ')}`);

    generateSummary(roundDir, profile, roundNumber, existingScores, false, evidence, reviewerPacketPassed);
    persistFinalArbitration(roundDir, false, 'one or more release gates failed', reviewers, process.argv);
    return false;
  } else {
    const completed = Object.values(existingScores).filter(r => r.hasReport).length;
    console.log(` Progress: ${completed}/${reviewers.length} completed`);
    console.log('');
    log.info('To complete this review, launch these independent reviewers with the Codex/Claude host:');
    console.log('');
    for (const reviewer of reviewers) {
      if (!existingScores[reviewer].hasReport) console.log(` ${colors.magenta}${reviewer}${colors.reset}`);
    }
    console.log('');

    generateSummary(roundDir, profile, roundNumber, existingScores, false, evidence, reviewerPacketPassed);
    persistFinalArbitration(roundDir, false, 'reviewer packets pending', reviewers, process.argv);
    return false;
  }
}

// Run the gate
runGate()
  .then(passed => { process.exit(passed ? 0 : 1); })
  .catch(err => { log.error(`Gate error: ${err.message}`); process.exit(2); });
