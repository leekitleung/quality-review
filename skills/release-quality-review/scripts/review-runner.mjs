#!/usr/bin/env node
/**
 * Review Runner - Orchestrates Multi-Reviewer Quality Reviews
 *
 * This script orchestrates the full review workflow:
 * 1. Load profile configuration
 * 2. Detect conditional reviewers based on changes
 * 3. Collect evidence
 * 4. Run reviewers in sequence or parallel
 * 5. Aggregate results
 * 6. Run gate check
 *
 * Usage:
 *   node review-runner.mjs --profile release-gate
 *   node review-runner.mjs --profile quick --parallel
 *   node review-runner.mjs --dry-run
 *   node review-runner.mjs --target <dir>  # Review a specific directory (self-review)
 */

import { readFileSync, existsSync, readdirSync, realpathSync, statSync, writeFileSync, mkdirSync } from 'fs';
import { join, relative } from 'path';
import { execFileSync as nodeExecFileSync, spawn } from 'child_process';
import {
  parseYamlProfile as parseYamlProfileShared, parseYamlResult, selectReviewers,
  validateResultYamlContract,
} from '../lib/review-utils.mjs';
import { persistPhasePlan, persistPhaseResult } from '../lib/phase-persistence.mjs';
import { createCandidateRuntime } from '../lib/candidate-runtime.mjs';
import {
  createSubprocessEnv, ensureContainedDirectorySync, isPathWithin,
  outerSandboxAttestationFromEnv, readContainedFile, readContainedFileSync, redactSensitiveText,
  resolveWithinRoot, writeContainedFile,
} from '../lib/security-utils.mjs';

const PROJECT_ROOT = process.cwd();
const SKILL_DIR = join(PROJECT_ROOT, 'skills', 'release-quality-review');
const REPORT_DIR = join(PROJECT_ROOT, 'quality-reports');
const CONFIG_FILE = join(SKILL_DIR, 'review-config.yaml');
const TOOL_ENV = createSubprocessEnv();
const OUTER_SANDBOX_ATTESTATION = outerSandboxAttestationFromEnv();
const {
  env: CANDIDATE_ENV, execSync, execFileSync,
} = createCandidateRuntime(PROJECT_ROOT, 'runner', OUTER_SANDBOX_ATTESTATION);
const REVIEWER_TIMEOUT_MS = parsePositiveDuration(process.env.RELEASE_QUALITY_REVIEWER_TIMEOUT_MS, 15 * 60 * 1000);
const REVIEWER_KILL_GRACE_MS = parsePositiveDuration(process.env.RELEASE_QUALITY_REVIEWER_KILL_GRACE_MS, 5000);
const REVIEWER_RETRY_MAX = parseInt(process.env.RELEASE_QUALITY_REVIEWER_RETRY_MAX || '2', 10);
const RETRY_BASE_DELAY_MS = parseInt(process.env.RELEASE_QUALITY_RETRY_BASE_DELAY_MS || '1000', 10);
const RETRY_MAX_JITTER_MS = parseInt(process.env.RELEASE_QUALITY_RETRY_MAX_JITTER_MS || '300', 10);
const REVIEWER_START_DELAY_MS = parseInt(process.env.RELEASE_QUALITY_REVIEWER_START_DELAY_MS || '0', 10);

// Scale-based timeout multipliers (apply to base REVIEWER_TIMEOUT_MS)
const SCALE_TIMEOUT_MULTIPLIERS = {
  micro: 0.5,   // 7.5 minutes
  small: 0.75,   // ~11 minutes
  medium: 1.0,   // 15 minutes (default)
  large: 1.5,    // 22.5 minutes
  xlarge: 2.0,   // 30 minutes
};

// Write reviewer output files from orchestrator (parse agent output and write)
async function writeReviewerFilesFromOutput(reviewerDir, outputContent, reviewerName, profile, round, candidateCommit, candidateTree) {
  // Parse output - look for YAML blocks or markdown formatted sections
  let resultYaml = '';
  let scoreContent = '';
  let blockersContent = '';
  let improvementsContent = '';

  const lines = outputContent.split('\n');
  let inResultBlock = false;
  let inScore = false;
  let inBlockers = false;
  let inImprovements = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Detect section transitions
    if ((line.includes('result.yaml') || line.includes('candidate_commit:')) && !inScore) {
      inResultBlock = true;
      inImprovements = false;
    }

    if (inResultBlock && line.trim() === '---') {
      // YAML block end marker
      inResultBlock = false;
      continue;
    }

    if (line.includes('score.md') || (inResultBlock && line.includes('score:')) || (line.includes('Overall Score') && !inScore)) {
      inResultBlock = false;
      inScore = true;
      inBlockers = false;
      inImprovements = false;
    }

    if (inScore && (line.includes('blockers.md') || line.includes('## Blockers') || line.includes('## P0') || line.includes('## P1'))) {
      inScore = false;
      inBlockers = true;
      inImprovements = false;
    }

    if (inBlockers && (line.includes('improvement-list.md') || line.includes('## Improvements') || line.includes('## P2') || line.includes('## P3'))) {
      inBlockers = false;
      inImprovements = true;
    }

    // Extract content based on current section
    if (inResultBlock && !inScore) {
      resultYaml += line + '\n';
    }

    if (inScore && !inBlockers && !inImprovements) {
      scoreContent += line + '\n';
    }

    if (inBlockers && !inImprovements) {
      blockersContent += line + '\n';
    }

    if (inImprovements) {
      improvementsContent += line + '\n';
    }
  }

  // Write result.yaml
  if (resultYaml.trim() && resultYaml.includes('candidate_commit:')) {
    try {
      await writeContainedFile(reviewerDir, join(reviewerDir, 'result.yaml'), resultYaml);
    } catch (e) {
      console.error(`Failed to write result.yaml: ${e.message}`);
    }
  }

  // Write score.md
  if (scoreContent.trim()) {
    try {
      await writeContainedFile(reviewerDir, join(reviewerDir, 'score.md'), scoreContent);
    } catch (e) {
      console.error(`Failed to write score.md: ${e.message}`);
    }
  } else {
    const fallback = `# ${reviewerName} - Round ${round}\n\n## Overall Score: 0/100\n\n---\n\nReview output parsing incomplete.\n`;
    try {
      await writeContainedFile(reviewerDir, join(reviewerDir, 'score.md'), fallback);
    } catch (e) {
      console.error(`Failed to write score.md: ${e.message}`);
    }
  }

  // Write blockers.md
  if (blockersContent.trim()) {
    try {
      await writeContainedFile(reviewerDir, join(reviewerDir, 'blockers.md'), blockersContent);
    } catch (e) {
      console.error(`Failed to write blockers.md: ${e.message}`);
    }
  } else {
    const fallback = `# Blockers - ${reviewerName}\n\n## P0 (Must Fix)\n- None found\n\n## P1 (Must Fix)\n- Reviewer output could not be parsed into the required packet.\n\n---\n`;
    try {
      await writeContainedFile(reviewerDir, join(reviewerDir, 'blockers.md'), fallback);
    } catch (e) {
      console.error(`Failed to write blockers.md: ${e.message}`);
    }
  }

  // Write improvement-list.md
  if (improvementsContent.trim()) {
    try {
      await writeContainedFile(reviewerDir, join(reviewerDir, 'improvement-list.md'), improvementsContent);
    } catch (e) {
      console.error(`Failed to write improvement-list.md: ${e.message}`);
    }
  } else {
    const fallback = `# Improvements - ${reviewerName}\n\n## P2 (Should Fix)\n- No improvements listed\n\n## P3 (Nice to Have)\n- None\n`;
    try {
      await writeContainedFile(reviewerDir, join(reviewerDir, 'improvement-list.md'), fallback);
    } catch (e) {
      console.error(`Failed to write improvement-list.md: ${e.message}`);
    }
  }
}

function parsePositiveDuration(value, fallback) {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

// ANSI colors
const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const color = value => useColor ? value : '';
const c = {
  reset: color('\x1b[0m'),
  bright: color('\x1b[1m'),
  dim: color('\x1b[2m'),
  red: color('\x1b[31m'),
  green: color('\x1b[32m'),
  yellow: color('\x1b[33m'),
  blue: color('\x1b[34m'),
  cyan: color('\x1b[36m'),
  magenta: color('\x1b[35m'),
};

const log = {
  info: (msg) => console.log(`${c.blue}ℹ${c.reset} ${msg}`),
  success: (msg) => console.log(`${c.green}✓${c.reset} ${msg}`),
  warn: (msg) => console.log(`${c.yellow}⚠${c.reset} ${msg}`),
  error: (msg) => console.log(`${c.red}✗${c.reset} ${msg}`),
  title: (msg) => console.log(`\n${c.bright}${c.cyan}═══ ${msg} ═══${c.reset}\n`),
};

function parseCliArgs(args) {
  const options = {
    profile: 'release-gate', roundNumber: null, parallel: false, dryRun: false,
    skipEvidence: false, reviewerOverride: null, targetDir: null,
    checkGoalMode: false, diffBase: 'HEAD', agentCli: null, model: null,
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--profile' && args[i + 1]) options.profile = args[++i];
  else if (arg === '--round' && args[i + 1]) {
    const value = args[++i];
    if (!/^\d+$/.test(value)) {
      console.error('Invalid --round: expected a positive integer');
      process.exit(4);
    }
    const parsed = parseInt(value, 10);
    if (!Number.isInteger(parsed) || parsed < 1) {
      console.error('Invalid --round: expected a positive integer');
      process.exit(4);
    }
    options.roundNumber = parsed;
  }
  else if (arg === '--parallel') options.parallel = true;
  else if (arg === '--dry-run') options.dryRun = true;
  else if (arg === '--skip-evidence') options.skipEvidence = true;
  else if (arg === '--reviewer' && args[i + 1]) options.reviewerOverride = args[++i];
  else if (arg === '--target' && args[i + 1]) options.targetDir = args[++i];
  else if (arg === '--check-goal-mode') options.checkGoalMode = true;
  else if (arg === '--base' && args[i + 1]) options.diffBase = args[++i];
  else if (arg === '--agent' && args[i + 1]) {
    const agent = args[++i];
    if (!['claude', 'codex'].includes(agent)) {
      console.error('Invalid --agent: must be "claude" or "codex"');
      process.exit(4);
    }
    options.agentCli = agent;
  }
  else if (arg === '--model' && args[i + 1]) options.model = args[++i];
  else if (arg === '--help' || arg === '-h') {
    printHelp();
    process.exit(0);
  }
  else {
    console.error(`Unknown or incomplete option: ${arg}`);
    process.exit(4);
  }
  }
  return Object.freeze(options);
}

const {
  profile, roundNumber, parallel, dryRun, skipEvidence, reviewerOverride,
  targetDir, checkGoalMode, diffBase, agentCli, model,
} = parseCliArgs(process.argv.slice(2));

if (!/^[a-z0-9-]+$/.test(profile) || (reviewerOverride && !/^[a-z0-9-]+$/.test(reviewerOverride))) {
  console.error('Invalid profile or reviewer name');
  process.exit(4);
}

function validateAgentModel(agent, selectedModel) {
  if (!agent || !selectedModel) return 'actual reviews require explicit --agent and --model';
  if (!/^[A-Za-z0-9._:/-]{1,128}$/.test(selectedModel)) return 'invalid --model value';
  const claudeModel = /^(?:claude-|sonnet$|opus$|haiku$)/i.test(selectedModel);
  if (agent === 'codex' && claudeModel) return `model ${selectedModel} is not valid for codex backend`;
  if (agent === 'claude' && !claudeModel) return `model ${selectedModel} is not valid for claude backend`;
  return null;
}

if (!dryRun) {
  const modelError = validateAgentModel(agentCli, model);
  if (modelError) {
    console.error(modelError);
    process.exit(4);
  }
}

function resolveDiffBase(ref) {
  if (ref === 'HEAD') return 'HEAD';
  if (!/^[A-Za-z0-9._/@-]+$/.test(ref)) {
    console.error(`Invalid --base ref: ${ref}`);
    process.exit(4);
  }
  try {
    return nodeExecFileSync('git', ['merge-base', ref, 'HEAD'], {
      encoding: 'utf-8', cwd: PROJECT_ROOT, timeout: 10000, env: TOOL_ENV,
    }).trim();
  } catch {
    console.error(`Unable to resolve --base ref: ${ref}`);
    process.exit(4);
  }
}
const resolvedDiffBase = resolveDiffBase(diffBase);

// Resolve target directory (self-review target vs project root)
function resolveReviewTarget(relative) {
  try {
    return relative ? resolveWithinRoot(PROJECT_ROOT, relative, 'review target') : PROJECT_ROOT;
  } catch (error) {
    console.error(error.message);
    process.exit(4);
  }
}
const REVIEW_TARGET = resolveReviewTarget(targetDir);
if (!existsSync(REVIEW_TARGET) || !statSync(REVIEW_TARGET).isDirectory()) {
  console.error(`Review target is not a directory: ${REVIEW_TARGET}`);
  process.exit(4);
}
if (!isPathWithin(realpathSync(PROJECT_ROOT), realpathSync(REVIEW_TARGET))) {
  console.error('Review target resolves outside the repository');
  process.exit(4);
}

function printHelp() {
  console.log(`
${c.bright}Review Runner - Quality Review Orchestrator${c.reset}

Usage:
  node review-runner.mjs [options]

Options:
  --profile <name>   Profile: quick, default, release-gate, full, agentic-release-gate
  --round <N>        Round number (auto-detected if not specified)
  --parallel         Run reviewers in parallel
  --agent <type>     Required backend for actual reviews: claude or codex
  --model <name>     Required backend-compatible model for actual reviews
  --reviewer <name>  Run only this reviewer
  --target <path>    Review target directory (for self-review: skills/release-quality-review)
  --skip-evidence    Skip automatic evidence collection
  --dry-run          Validate configuration without running
  --check-goal-mode  Enable goal mode constraint check
  --base <ref>       Git diff base for change detection (default: HEAD)
  --help, -h         Show this help

Examples:
  node review-runner.mjs --profile release-gate --agent codex --model gpt-5.4
  node review-runner.mjs --profile default --parallel --agent claude --model claude-sonnet-4-6
  node review-runner.mjs --agent codex --model gpt-5.4
  node review-runner.mjs --reviewer destructive-qa --dry-run
  node review-runner.mjs --target skills/release-quality-review --profile quick --dry-run
  `);
}

// Load YAML profile
function loadProfile(profileName) {
  const profilePath = join(SKILL_DIR, 'profiles', `${profileName}.yaml`);
  if (!existsSync(profilePath)) {
    log.error(`Profile not found: ${profileName}`);
    log.error(`Looking for: ${profilePath}`);
    return null;
  }

  try {
    const content = readFileSync(profilePath, 'utf-8');
    return parseYamlProfileShared(content, profileName);
  } catch (e) {
    log.error(`Failed to load profile: ${e.message}`);
    return null;
  }
}

// Load reviewer definitions
function loadReviewer(name) {
  const path = join(SKILL_DIR, 'reviewers', `${name}.md`);
  if (!existsSync(path)) return null;
  return readFileSync(path, 'utf-8');
}

// Collect evidence with config
function collectEvidence(config) {
  log.info('Collecting evidence...');
  const isSelfReview = REVIEW_TARGET !== PROJECT_ROOT;
  const targetName = isSelfReview ? 'Skill Self-Review' : 'Project';

  const evidence = {
    timestamp: new Date().toISOString(),
    target: targetName,
    git: {},
    structure: {},
    config: {},
  };
  const gitOptions = {
    encoding: 'utf-8', cwd: PROJECT_ROOT, env: CANDIDATE_ENV,
    sandboxReadOnlyRoots: [PROJECT_ROOT],
  };

  // Git info (always from PROJECT_ROOT)
  let gitEvidenceError = null;
  try {
    evidence.git = {
      branch: execSync('git branch --show-current 2>/dev/null', gitOptions).trim(),
      commit: execSync('git rev-parse --short HEAD 2>/dev/null', gitOptions).trim(),
      status: execSync('git status --short 2>/dev/null', gitOptions).trim(),
      diffStats: execSync(`git diff --stat ${resolvedDiffBase} 2>/dev/null`, gitOptions).trim(),
    };

    // For self-review, only show changes in the skill directory
    if (isSelfReview) {
      evidence.git.changedFiles = execSync(
        `git diff --name-only ${resolvedDiffBase} 2>/dev/null | grep "^skills/release-quality-review/" || true`,
        gitOptions
      ).trim().split('\n').filter(Boolean);
      evidence.git.diff = execSync(
        `git diff ${resolvedDiffBase} 2>/dev/null -- "skills/release-quality-review/" || true`,
        { ...gitOptions, maxBuffer: 10 * 1024 * 1024 }
      ).trim();
    } else {
      evidence.git.changedFiles = execSync(`git diff --name-only ${resolvedDiffBase} 2>/dev/null`, gitOptions)
        .trim().split('\n').filter(Boolean);
      evidence.git.diff = execSync(`git diff ${resolvedDiffBase} 2>/dev/null`, { ...gitOptions, maxBuffer: 10 * 1024 * 1024 }).trim();
    }
    const untracked = execFileSync('git', ['ls-files', '--others', '--exclude-standard'], {
      encoding: 'utf-8', cwd: PROJECT_ROOT, timeout: 10000, env: CANDIDATE_ENV,
      sandboxReadOnlyRoots: [PROJECT_ROOT],
    }).trim().split('\n').filter(Boolean);
    evidence.git.changedFiles = [...new Set([...(evidence.git.changedFiles || []), ...untracked])];
  } catch (e) {
    gitEvidenceError = e;
    log.warn(`Could not collect git info: ${redactSensitiveText(e.message)}`);
  }
  if (gitEvidenceError) {
    throw new Error(`git evidence collection failed: ${redactSensitiveText(gitEvidenceError.message)}`);
  }
  if (evidence.git.status !== '') throw new Error('source checkout must be clean before evidence collection');

  // Project/Skill structure (from REVIEW_TARGET)
  const targetRoot = REVIEW_TARGET;
  try {
    if (existsSync(join(targetRoot, 'apps'))) {
      evidence.structure.apps = readdirSync(join(targetRoot, 'apps')).filter(f => {
        try { return statSync(join(targetRoot, 'apps', f)).isDirectory(); } catch { return false; }
      });
    }
    if (existsSync(join(targetRoot, 'packages'))) {
      evidence.structure.packages = readdirSync(join(targetRoot, 'packages')).filter(f => {
        try { return statSync(join(targetRoot, 'packages', f)).isDirectory(); } catch { return false; }
      });
    }
    // For skill self-review, list the skill structure
    if (isSelfReview) {
      evidence.structure.skill = {
        reviewers: readdirSync(join(targetRoot, 'reviewers')).filter(f => f.endsWith('.md')),
        rubrics: readdirSync(join(targetRoot, 'rubrics')).filter(f => f.endsWith('.md')),
        scripts: readdirSync(join(targetRoot, 'scripts')).filter(f => f.endsWith('.mjs')),
        profiles: readdirSync(join(targetRoot, 'profiles')).filter(f => f.endsWith('.yaml')),
      };
    }

    const targetFiles = listFiles(targetRoot);
    evidence.structure.testFiles = String(targetFiles.filter(file => /\.(test|spec)\.ts$/.test(file)).length);
    evidence.structure.sourceFiles = String(targetFiles.filter(file => /\.(ts|tsx)$/.test(file) && !file.endsWith('.d.ts')).length);

    // Calculate test ratio
    const testCount = parseInt(evidence.structure.testFiles) || 0;
    const sourceCount = parseInt(evidence.structure.sourceFiles) || 1;
    evidence.structure.testRatio = Math.round((testCount / sourceCount) * 100) / 100;

    // Check for CI workflows
    evidence.structure.ciWorkflows = existsSync(join(targetRoot, '.github', 'workflows')) ?
      readdirSync(join(targetRoot, '.github', 'workflows')).filter(f => f.endsWith('.yml') || f.endsWith('.yaml')).length : 0;

    // Check for README
    evidence.structure.hasReadme = existsSync(join(targetRoot, 'README.md')) ||
                                    existsSync(join(targetRoot, 'README.txt')) ||
                                    existsSync(join(targetRoot, 'readme.md'));

    // Check for oversized files (>2000 lines)
    evidence.structure.oversizedFiles = [];
    const findResult = targetFiles.filter(file => /\.(ts|tsx)$/.test(file)).slice(0, 50);
    for (const file of findResult) {
      try {
        const lines = readFileSync(file, 'utf-8').split('\n').length;
        if (lines > 2000) {
          evidence.structure.oversizedFiles.push({ file, lines });
        }
      } catch {}
    }
    evidence.structure.largeFiles = evidence.structure.oversizedFiles.length;

  } catch (e) {
    // Ignore - some checks may fail
  }

  // Gate is the single producer and validator of automated command evidence.
  evidence.testResults = { available: false, delegatedToGate: true };

  log.success(`Git: ${evidence.git.branch || '?'} @ ${evidence.git.commit || '?'}`);
  log.success(`Changed: ${evidence.git.changedFiles?.length || 0} files`);

  return evidence;
}

function collectDryRunEvidence() {
  const targetPrefix = REVIEW_TARGET === PROJECT_ROOT
    ? null
    : relative(PROJECT_ROOT, REVIEW_TARGET).replaceAll('\\', '/');
  const pathArgs = targetPrefix ? ['--', targetPrefix] : [];
  const changedFiles = nodeExecFileSync(
    'git',
    ['diff', '--name-only', resolvedDiffBase, ...pathArgs],
    { cwd: PROJECT_ROOT, encoding: 'utf8', timeout: 10000, env: TOOL_ENV },
  ).trim().split('\n').filter(Boolean);
  const untracked = nodeExecFileSync(
    'git',
    ['ls-files', '--others', '--exclude-standard'],
    { cwd: PROJECT_ROOT, encoding: 'utf8', timeout: 10000, env: TOOL_ENV },
  ).trim().split('\n').filter(file => file && (!targetPrefix || file.startsWith(`${targetPrefix}/`)));
  const diff = nodeExecFileSync(
    'git',
    ['diff', resolvedDiffBase, ...pathArgs],
    { cwd: PROJECT_ROOT, encoding: 'utf8', timeout: 10000, maxBuffer: 10 * 1024 * 1024, env: TOOL_ENV },
  );
  return {
    timestamp: new Date().toISOString(),
    git: { changedFiles: [...new Set([...changedFiles, ...untracked])], diff },
    structure: {},
  };
}

function listFiles(root) {
  const files = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue;
    const full = join(root, entry.name);
    if (entry.isDirectory()) files.push(...listFiles(full));
    else if (entry.isFile()) files.push(full);
  }
  return files;
}

// Detect change scale and suggest appropriate profile
// Right-size throttle: small changes = minimal ceremony, large changes = full process
function detectChangeScale(evidence) {
  const fileCount = evidence.git.changedFiles?.length || 0;
  const diffLines = evidence.git.diff?.split('\n').length || 0;
  const addedLines = (evidence.git.diff?.match(/^\+[^+]/gm) || []).length;
  const deletedLines = (evidence.git.diff?.match(/^-[^-]/gm) || []).length;
  const totalLines = addedLines + deletedLines;

  // Check for specific high-impact patterns
  const changedFiles = evidence.git.changedFiles || [];
  const hasSecurity = changedFiles.some(f =>
    f.includes('/auth/') || f.includes('/security/') || f.includes('token')
  );
  const hasSchema = changedFiles.some(f =>
    f.includes('schema') || f.includes('migration') || f.includes('.prisma')
  );
  const hasApi = changedFiles.some(f =>
    f.includes('/api/') || f.includes('route') || f.includes('handler')
  );

  let scale = 'none';
  let suggestedProfile = 'quick';
  let reason = '';

  if (fileCount === 0) {
    scale = 'none';
    suggestedProfile = 'quick';
    reason = 'No changes detected';
  } else if (fileCount <= 2 && totalLines < 100 && !hasSecurity && !hasSchema) {
    scale = 'micro';
    suggestedProfile = 'quick';
    reason = `${fileCount} files, ${totalLines} lines - micro change`;
  } else if (fileCount <= 5 && totalLines < 500) {
    scale = 'small';
    suggestedProfile = 'quick';
    reason = `${fileCount} files, ${totalLines} lines - small change`;
  } else if (fileCount <= 20 && totalLines < 2000) {
    scale = 'medium';
    suggestedProfile = 'default';
    reason = `${fileCount} files, ${totalLines} lines - medium change`;
  } else if (fileCount <= 50 && totalLines < 5000) {
    scale = 'large';
    suggestedProfile = 'release-gate';
    reason = `${fileCount} files, ${totalLines} lines - large change`;
  } else {
    scale = 'xlarge';
    suggestedProfile = 'full';
    reason = `${fileCount} files, ${totalLines} lines - xlarge change`;
  }

  // Security changes always require security review
  if (hasSecurity && suggestedProfile === 'quick') {
    suggestedProfile = 'default';
    reason += ' (security-sensitive files detected, upgraded to default)';
  }

  // Schema changes always require full review
  if (hasSchema && suggestedProfile !== 'full') {
    suggestedProfile = 'release-gate';
    reason += ' (schema changes detected, upgraded to release-gate)';
  }

  // API changes with large scale
  if (hasApi && scale === 'large') {
    suggestedProfile = 'release-gate';
    reason += ' (API + large scale, upgraded to release-gate)';
  }

  return {
    scale,
    suggestedProfile,
    reason,
    fileCount,
    totalLines,
    hasSecurity,
    hasSchema,
    hasApi,
  };
}

// Suggest profile based on change scale
function suggestProfileFromScale(scaleResult) {
  const { scale, suggestedProfile, reason } = scaleResult;

  const profileMessages = {
    none: {
      profile: 'quick',
      message: 'No changes to review. Consider skipping the review or doing a quick sanity check.',
    },
    micro: {
      profile: 'quick',
      message: `Micro change detected (${reason}). Quick review sufficient.`,
    },
    small: {
      profile: 'quick',
      message: `Small change detected (${reason}). Quick review sufficient.`,
    },
    medium: {
      profile: 'default',
      message: `Medium change detected (${reason}). Standard review recommended.`,
    },
    large: {
      profile: 'release-gate',
      message: `Large change detected (${reason}). Full release gate required.`,
    },
    xlarge: {
      profile: 'full',
      message: `XLarge change detected (${reason}). Full review with all reviewers required.`,
    },
  };

  return profileMessages[scale] || profileMessages.medium;
}

// Load config
function loadConfig() {
  try {
    if (existsSync(CONFIG_FILE)) {
      const content = readFileSync(CONFIG_FILE, 'utf-8');
      const config = {
        verification: {},
        gate: {},
        execution: {},
      };
      let currentSection = '';

      for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;

        // Section headers
        if (trimmed.startsWith('verification:') || trimmed.startsWith('gate:') || trimmed.startsWith('execution:')) {
          currentSection = trimmed.replace(':', '').trim();
          continue;
        }

        if (trimmed && trimmed.includes(':')) {
          const [key, ...valueParts] = trimmed.split(':');
          const value = valueParts.join(':').trim();

          if (value && !key.includes('-')) {
            const cleanValue = value.replace(/^["']|["']$/g, '');

            // Map to correct section
            if (currentSection === 'verification' || ['test', 'build', 'lint', 'typecheck', 'e2e', 'audit'].includes(key.trim())) {
              config.verification[key.trim()] = cleanValue;
            } else if (currentSection === 'gate' || ['min_score', 'fail_on_redlines', 'fail_on_p0_p1_blockers'].includes(key.trim())) {
              config.gate[key.trim()] = cleanValue;
            } else if (currentSection === 'execution' || ['start_delay_ms', 'timeout_ms', 'retry_max'].includes(key.trim())) {
              config.execution[key.trim()] = cleanValue;
            } else {
              config[key.trim()] = cleanValue;
            }
          }
        }
      }
      return config;
    }
  } catch (e) {
    // Ignore
  }
  return { verification: {}, gate: {} };
}

// Get current git commit info
function getGitInfo() {
  try {
    return {
      commit: nodeExecFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: PROJECT_ROOT, encoding: 'utf8', timeout: 10000,
      }).trim(),
      tree: nodeExecFileSync('git', ['rev-parse', 'HEAD^{tree}'], {
        cwd: PROJECT_ROOT, encoding: 'utf8', timeout: 10000,
      }).trim(),
    };
  } catch (e) {
    return { commit: 'unknown', tree: 'unknown' };
  }
}

// Generate reviewer prompt
function generateReviewerPrompt(reviewerName, currentRound, candidateIdentity, reviewBackend, reviewModel) {
  const reviewerContent = loadReviewer(reviewerName);
  if (!reviewerContent) return null;
  const { commit: candidateCommit, tree: candidateTree } = candidateIdentity;

  // Extract key sections for the prompt
  const prompt = `
# ${reviewerName} Review

请执行 ${reviewerName} 的评审。

## 评审维度
请读取完整定义: ${SKILL_DIR}/reviewers/${reviewerName}.md

## 你的任务
1. 读取相关代码文件
2. 检查每个评审维度
3. 给出具体评分 (0-100)
4. 列出发现的 blocker (P0/P1 必须修复, P2/P3 建议改进)
5. 列出改进建议

## ⚠️ 对抗性审查规则（必须遵守）

**禁止行为：**
- ❌ 不要引用你自己刚刚修改的代码作为"证据"
- ❌ 不要在没有实际运行的情况下声称"功能正常"
- ❌ 不要使用模糊描述如"代码看起来正确"

**必须行为：**
- ✅ 引用**现有文件**中的代码行号（不是你刚写的）
- ✅ 引用**已有测试**的输出结果
- ✅ 引用**历史报告**或**其他 Reviewer 的发现**
- ✅ 提供具体的错误信息、堆栈跟踪或命令输出

## 输出要求
在 ${REPORT_DIR}/round-{N}/${reviewerName}/ 目录下创建:
- result.yaml - 机器可读结果
- score.md - 评分详情
- blockers.md - P0/P1 必须修复的问题
- improvement-list.md - P2/P3 改进建议

result.yaml 的前七个顶层字段必须严格使用以下格式；score 必须是整数，status 必须是小写 pass 或 fail，不能改名、嵌套或改成对象：
\`\`\`yaml
reviewer: ${reviewerName}
profile: ${profile}
round: ${currentRound}
candidate_commit: ${candidateCommit}
candidate_tree: ${candidateTree}
score: <0-100 integer>
status: <pass|fail>
review_backend: ${reviewBackend}
review_model: ${reviewModel}
\`\`\`
实际输出目录必须是 ${REPORT_DIR}/round-${String(currentRound).padStart(3, '0')}/${reviewerName}/。

## 评分标准
- >= 90: 优秀，可以发布
- 80-89: 良好，建议改进
- 70-79: 及格，必须改进
- < 70: 不及格，需要重构

## 红线规则
如果发现任何红线，必须在 blockers.md 中明确标注为 P0。
`;

  return prompt;
}

// Validate resume artifacts for credibility
async function validateResumeArtifacts(
  reviewerDir, reviewer, expectedProfile, expectedRound, currentIdentity,
  expectedBackend, expectedModel,
) {
  const requiredFiles = ['result.yaml', 'score.md', 'blockers.md', 'improvement-list.md'];
  try {
    const contents = await Promise.all(requiredFiles.map(file =>
      readContainedFile(reviewerDir, join(reviewerDir, file), 'utf8').catch(error => ({ error, file }))
    ));
    const missingFiles = contents.filter(value => typeof value !== 'string').map(value => value.file);
    if (missingFiles.length > 0) return { valid: false, reason: `missing: ${missingFiles.join(', ')}` };
    const yamlContent = contents[0];
    const contract = validateResultYamlContract(yamlContent);
    if (!contract.valid) return { valid: false, reason: contract.error };
    const parsed = parseYamlResult(yamlContent);
    const mismatches = [];
    if (parsed.reviewer !== reviewer) mismatches.push(`reviewer=${parsed.reviewer ?? 'missing'}`);
    if (parsed.profile !== expectedProfile) mismatches.push(`profile=${parsed.profile ?? 'missing'}`);
    if (parsed.round !== expectedRound) mismatches.push(`round=${parsed.round ?? 'missing'}`);
    if (parsed.candidateCommit !== currentIdentity.commit) mismatches.push(`candidate_commit=${parsed.candidateCommit ?? 'missing'}`);
    if (parsed.candidateTree !== currentIdentity.tree) mismatches.push(`candidate_tree=${parsed.candidateTree ?? 'missing'}`);
    if (parsed.reviewBackend !== expectedBackend) mismatches.push(`review_backend=${parsed.reviewBackend ?? 'missing'}`);
    if (parsed.reviewModel !== expectedModel) mismatches.push(`review_model=${parsed.reviewModel ?? 'missing'}`);
    if (!Number.isInteger(parsed.score) || parsed.score < 0 || parsed.score > 100) mismatches.push('score=invalid');
    if (!['pass', 'fail'].includes(parsed.status)) mismatches.push(`status=${parsed.status ?? 'missing'}`);
    const emptyFiles = requiredFiles.filter((_file, index) => contents[index].trim() === '');
    if (emptyFiles.length > 0) mismatches.push(`empty=${emptyFiles.join(',')}`);
    if (mismatches.length > 0) return { valid: false, reason: mismatches.join('; ') };
    return { valid: true, score: parsed.score, status: parsed.status };
  } catch (e) {
    return { valid: false, reason: `parse error: ${e.message}` };
  }
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function getAgentInvocation(agent, selectedModel, prompt) {
  if (agent === 'claude') {
    return {
      command: 'claude',
      args: ['-p', '--model', selectedModel, '--permission-mode', 'acceptEdits', '--no-session-persistence', prompt],
    };
  }
  if (agent === 'codex') {
    return {
      command: 'codex',
      args: ['exec', '--model', selectedModel, '--ephemeral', '--sandbox', 'workspace-write', '--cd', PROJECT_ROOT, prompt],
    };
  }
  return { command: agent, args: ['-p', prompt] };
}

function bindRoundBackend(roundDir, backend, selectedModel) {
  const lockPath = resolveWithinRoot(roundDir, 'review-backend.json', 'review backend lock');
  const record = { backend, model: selectedModel };
  try {
    writeFileSync(lockPath, `${JSON.stringify(record, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    return record;
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  let existing;
  try {
    existing = JSON.parse(readContainedFileSync(roundDir, lockPath, 'utf8'));
  } catch (error) {
    const failure = new Error(`invalid review backend lock: ${error.message}`);
    failure.exitCode = 4;
    throw failure;
  }
  if (!['claude', 'codex'].includes(existing.backend) || existing.backend !== backend) {
    const failure = new Error(`round backend is locked to ${existing.backend || 'invalid'}, cannot use ${backend}`);
    failure.exitCode = 4;
    throw failure;
  }
  if (typeof existing.model !== 'string' || existing.model !== selectedModel) {
    const failure = new Error(`round model is locked to ${existing.model || 'invalid'}, cannot use ${selectedModel}`);
    failure.exitCode = 4;
    throw failure;
  }
  return existing;
}

async function bindRoundMetadata(roundDir, backend, selectedModel) {
  const metadataPath = join(roundDir, 'metadata.json');
  if (!existsSync(metadataPath)) return;
  const metadata = JSON.parse(readContainedFileSync(roundDir, metadataPath, 'utf8'));
  if (metadata.review_backend && metadata.review_backend !== backend) {
    throw new Error(`round metadata backend is locked to ${metadata.review_backend}, cannot use ${backend}`);
  }
  if (metadata.review_model && metadata.review_model !== selectedModel) {
    throw new Error(`round metadata model is locked to ${metadata.review_model}, cannot use ${selectedModel}`);
  }
  metadata.review_backend = backend;
  metadata.review_model = selectedModel;
  await writeContainedFile(roundDir, metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);
}

// Scale-based timeout calculation
function getScaledTimeout(scale, baseTimeout = REVIEWER_TIMEOUT_MS) {
  const multiplier = SCALE_TIMEOUT_MULTIPLIERS[scale] || 1.0;
  return Math.round(baseTimeout * multiplier);
}

// Run gate check and return detailed result
function runGateCheck(roundDir, profileName, round) {
  log.title('GATE CHECK');

  try {
    const gateScript = join(SKILL_DIR, 'scripts', 'review-gate.mjs');
    if (existsSync(gateScript)) {
      const args = [gateScript, '--profile', profileName, '--round', String(round), '--no-collect'];
      if (checkGoalMode) args.push('--check-goal-mode');
      if (diffBase !== 'HEAD') args.push('--base', diffBase);
      nodeExecFileSync('node', args, {
        stdio: 'inherit',
        cwd: PROJECT_ROOT,
        env: TOOL_ENV,
      });
      return { passed: true, roundDir };
    }
  } catch (e) {
    const exit = Number.isInteger(e.status) ? e.status : 'spawn-error';
    const signal = e.signal ? `, signal ${e.signal}` : '';
    log.error(`Gate check failed (exit ${exit}${signal})`);
    return { passed: false, roundDir, exitCode: e.status ?? null, signal: e.signal ?? null };
  }

  return { passed: false, roundDir };
}

function persistRoundEvidenceBeforeReview(roundDir, profileName, round) {
  const gateScript = join(SKILL_DIR, 'scripts', 'review-gate.mjs');
  const args = [gateScript, '--profile', profileName, '--round', String(round)];
  if (diffBase !== 'HEAD') args.push('--base', diffBase);
  try {
    nodeExecFileSync('node', args, {
      cwd: PROJECT_ROOT,
      env: TOOL_ENV,
      encoding: 'utf8',
      timeout: 10 * 60 * 1000,
      maxBuffer: 20 * 1024 * 1024,
    });
  } catch (error) {
    if (error.status !== 1) throw error;
  }

  const required = [
    join(roundDir, 'metadata.json'),
    join(roundDir, 'evidence', 'automated-checks.json'),
  ];
  const missing = required.filter(file => !existsSync(file));
  if (missing.length > 0) {
    throw new Error(`round evidence persistence failed: missing ${missing.map(file => file.replace(`${roundDir}/`, '')).join(', ')}`);
  }
}

function loadPersistedRoundScope(roundDir) {
  const metadataFile = join(roundDir, 'metadata.json');
  if (!existsSync(metadataFile)) throw new Error('cannot skip evidence without candidate-bound metadata.json');
  const metadata = JSON.parse(readContainedFileSync(roundDir, metadataFile, 'utf8'));
  const identity = getGitInfo();
  if (metadata.candidate_commit !== identity.commit || metadata.candidate_tree !== identity.tree ||
      metadata.base_commit !== resolvedDiffBase) {
    throw new Error('persisted round scope does not match the current candidate or diff base');
  }
  return {
    timestamp: metadata.collected_at,
    git: metadata.git || {},
    files: metadata.files || {},
    scale: metadata.scale || {},
    structure: {},
  };
}

// Extract scores from review results
function extractScoresFromRound(roundDir) {
  const scores = [];
  const dirs = readdirSync(roundDir);

  for (const reviewer of dirs) {
    const reviewerDir = join(roundDir, reviewer);
    if (!statSync(reviewerDir).isDirectory()) continue;

    const scorePath = join(reviewerDir, 'score.md');
    if (existsSync(scorePath)) {
      const content = readFileSync(scorePath, 'utf-8');
      const match = content.match(/Overall\s+Score[:\s]+(\d+)/);
      if (match) {
        scores.push({ reviewer, score: parseInt(match[1], 10) });
      }
    }
  }

  return scores;
}

// Check if any reviewer failed
function checkFailedReviewers(roundDir, minScore) {
  const scores = extractScoresFromRound(roundDir);
  return scores.filter(s => s.score < minScore);
}

// Run single review iteration
async function runSingleReviewIteration(profileConfig, currentRound, onReviewComplete) {
  const roundDir = join(REPORT_DIR, `round-${String(currentRound).padStart(3, '0')}`);

  console.log(`\n${c.blue}ℹ${c.reset} Round: ${currentRound}`);
  console.log(`${c.blue}ℹ${c.reset} Report: ${roundDir}`);

  if (!dryRun) {
    ensureContainedDirectorySync(PROJECT_ROOT, REPORT_DIR);
    ensureContainedDirectorySync(REPORT_DIR, roundDir);
  }

  if (!dryRun && profile === 'agentic-release-gate') {
    const requiredArtifacts = ['generated-goal.md', 'changes.md', 'diff-summary.md', 'risk.md', 'handoff.md'];
    const missingArtifacts = requiredArtifacts.filter(file => !existsSync(join(roundDir, file)));
    if (missingArtifacts.length > 0) {
      console.error(`Agentic review artifacts must exist before reviewer launch: ${missingArtifacts.join(', ')}`);
      process.exit(4);
    }
  }

  // Collect evidence with config
  const config = loadConfig();
  const evidence = dryRun
    ? collectDryRunEvidence()
    : skipEvidence
      ? (profile === 'agentic-release-gate'
          ? loadPersistedRoundScope(roundDir)
          : { timestamp: new Date().toISOString(), git: {}, structure: {} })
      : collectEvidence(config);

  // Detect change scale (right-size throttle)
  const scaleInfo = skipEvidence && evidence.scale?.scale
    ? {
        ...evidence.scale,
        fileCount: evidence.scale.fileCount ?? evidence.scale.files ?? evidence.git.changedFiles?.length ?? 0,
        totalLines: evidence.scale.totalLines ?? evidence.scale.total ?? 0,
      }
    : detectChangeScale(evidence);
  evidence.scale = scaleInfo; // Attach scale info to evidence

  // Log scale detection result
  console.log(`\n${c.blue}ℹ Change Scale:${c.reset} ${scaleInfo.scale} (${scaleInfo.fileCount} files, ${scaleInfo.totalLines} lines)`);
  console.log(`${c.blue}ℹ Suggested Profile:${c.reset} ${scaleInfo.suggestedProfile}`);
  if (scaleInfo.reason !== `${scaleInfo.fileCount} files, ${scaleInfo.totalLines} lines - ${scaleInfo.scale} change`) {
    console.log(`${c.blue}ℹ Reason:${c.reset} ${scaleInfo.reason}`);
  }

  let reviewerSelection;
  try {
    reviewerSelection = selectReviewers(
      profileConfig,
      evidence.git.changedFiles || [],
      evidence.git.diff || '',
    );
  } catch (error) {
    console.error(`Invalid reviewer configuration: ${error.message}`);
    process.exit(4);
  }
  const triggeredConditional = reviewerSelection.triggeredConditional;
  const allReviewers = reviewerOverride ? [reviewerOverride] : reviewerSelection.reviewers;

  if (dryRun) {
    console.log(`\n${c.yellow}DRY RUN MODE${c.reset}`);
    console.log('\nSelected reviewers:');
    let valid = true;
    for (const name of allReviewers) {
      const exists = existsSync(join(SKILL_DIR, 'reviewers', `${name}.md`));
      console.log(`  ${exists ? c.green + '✓' : c.red + '✗'} ${name}`);
      valid &&= exists;
    }
    if (!valid) process.exit(4);
    console.log(`\n${c.green}Dry run complete${c.reset}`);
    return { roundDir, evidence, allReviewers, results: [] };
  }

  // Persist phase plan BEFORE running reviews
  persistPhasePlan(roundDir, currentRound, allReviewers, evidence, profileConfig);
  if (!skipEvidence) {
    persistRoundEvidenceBeforeReview(roundDir, profile, currentRound);
  }

  console.log(`\n${c.cyan}Reviewers:${c.reset}`);
  console.log(`  Resident: ${profileConfig.resident_reviewers.join(', ')}`);
  if (triggeredConditional.length > 0) {
    console.log(`  Triggered: ${triggeredConditional.join(', ')}`);
  }
  if (reviewerOverride) {
    console.log(`  Override: ${reviewerOverride}`);
  }

  // Run reviewers
  console.log(`\n${c.cyan}═══ Running Reviews ═══${c.reset}\n`);
  const results = [];
  let reviewFailure = null;
  const scale = evidence.scale?.scale || 'medium';
  const scaledTimeout = getScaledTimeout(scale);

  const resolvedAgent = agentCli;
  const resolvedModel = model;
  bindRoundBackend(roundDir, resolvedAgent, resolvedModel);
  await bindRoundMetadata(roundDir, resolvedAgent, resolvedModel);
  log.info(`Using agent: ${resolvedAgent}, model: ${resolvedModel}`);
  const candidateIdentity = getGitInfo();
  const reviewerPrompts = new Map(allReviewers.map(reviewer => [
    reviewer, generateReviewerPrompt(
      reviewer, currentRound, candidateIdentity, resolvedAgent, resolvedModel,
    ),
  ]));

  // Use config for delays
  const startDelay = config.execution?.start_delay_ms
    ? parseInt(config.execution.start_delay_ms, 10)
    : REVIEWER_START_DELAY_MS;

  if (parallel) {
    log.info(`Execution: parallel, Scale: ${scale}, Timeout: ${scaledTimeout}ms (base: ${REVIEWER_TIMEOUT_MS}ms), Start delay: ${startDelay}ms`);
    try {
      nodeExecFileSync(resolvedAgent, ['--help'], { cwd: PROJECT_ROOT, timeout: 10000, stdio: 'ignore', env: TOOL_ENV });
    } catch {
      log.error(`Parallel mode requires ${agentCli} CLI on PATH; no reviewer agents were launched.`);
      process.exit(5);
    }

    const activeReviewers = new Map();
    let parallelAbortReason = null;
    const abortAll = reason => {
      if (parallelAbortReason) return;
      parallelAbortReason = reason;
      for (const abort of activeReviewers.values()) abort(reason);
    };

    // Parallel execution with retry support
    const parallelResults = await Promise.all(allReviewers.map(reviewer => new Promise(async (resolve) => {
      const reviewerDir = join(roundDir, reviewer);
      ensureContainedDirectorySync(roundDir, reviewerDir);

      // Check if reviewer already has credible results (resume support)
      const validation = await validateResumeArtifacts(
        reviewerDir, reviewer, profile, currentRound, candidateIdentity,
        resolvedAgent, resolvedModel,
      );
      if (validation.valid) {
        console.log(`  ${c.blue}↷${c.reset} ${reviewer}: validated resume (score: ${validation.score ?? 'unknown'})`);
        resolve({ name: reviewer, status: 'completed', skipped: true });
        return;
      }
      if (validation.reason) {
        console.log(`  ${c.yellow}⚡${c.reset} ${reviewer}: invalidating stale artifacts (${validation.reason}), re-running`);
      }

      // Optional operator-configured start staggering; zero means fully parallel launch.
      await sleep(startDelay);

      const prompt = reviewerPrompts.get(reviewer);
      if (!prompt) {
        resolve({ name: reviewer, status: 'failed' });
        return;
      }
      await writeContainedFile(roundDir, join(reviewerDir, 'prompt.md'), prompt);

      let attempt = 0;
      let lastError = null;

      while (attempt <= REVIEWER_RETRY_MAX) {
        attempt++;
        if (attempt > 1) {
          const exponentialDelay = RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 2);
          const jitter = Math.random() * RETRY_MAX_JITTER_MS;
          log.info(`  Retry ${attempt - 1}/${REVIEWER_RETRY_MAX} for ${reviewer}: waiting ${Math.round(exponentialDelay + jitter)}ms`);
          await new Promise(r => setTimeout(r, exponentialDelay + jitter));
        }

        const result = await new Promise(innerResolve => {
          const invocation = getAgentInvocation(resolvedAgent, resolvedModel, prompt);
          const proc = spawn(invocation.command, invocation.args, {
            cwd: PROJECT_ROOT,
            stdio: ['ignore', 'pipe', 'pipe'],
            detached: process.platform !== 'win32',
            env: TOOL_ENV,
          });
          let diagnostic = '';
          let settled = false;
          let aborted = false;
          let abortedByTimeout = false;
          let forceTimer = null;
          const retainTail = data => { diagnostic = (diagnostic + data.toString()).slice(-4000); };
          const signalProcessTree = signal => {
            if (!proc.pid) return false;
            try {
              if (process.platform === 'win32') {
                const args = ['/pid', String(proc.pid), '/t'];
                if (signal === 'SIGKILL') args.push('/f');
                spawn('taskkill', args, { stdio: 'ignore', env: CANDIDATE_ENV }).unref();
              } else {
                process.kill(-proc.pid, signal);
              }
              return true;
            } catch (error) {
              if (error.code !== 'ESRCH') diagnostic = `${diagnostic}\nprocess-tree ${signal} failed: ${error.message}`.slice(-4000);
              return false;
            }
          };
          proc.stdout.on('data', retainTail);
          proc.stderr.on('data', retainTail);
          const finish = async (code, eventStatus = null) => {
            if (settled) return;
            settled = true;
            clearTimeout(timeoutTimer);
            if (forceTimer) clearTimeout(forceTimer);
            activeReviewers.delete(`${reviewer}-${attempt}`);

            let postValidation = await validateResumeArtifacts(
              reviewerDir, reviewer, profile, currentRound, candidateIdentity,
              resolvedAgent, resolvedModel,
            );

            // Preserve canonical files written by the reviewer; parse stdout only as a fallback.
            if (!postValidation.valid && code === 0 && diagnostic.trim()) {
              try {
                await writeReviewerFilesFromOutput(
                  reviewerDir, diagnostic, reviewer, profile, currentRound,
                  candidateIdentity.commit, candidateIdentity.tree
                );
                postValidation = await validateResumeArtifacts(
                  reviewerDir, reviewer, profile, currentRound, candidateIdentity,
                  resolvedAgent, resolvedModel,
                );
              } catch (e) {
                console.log(`  ${c.yellow}⚡${c.reset} ${reviewer}: file write parse error: ${e.message}`);
              }
            }

            const complete = postValidation.valid;
            const status = eventStatus || (!aborted && code === 0 && complete ? 'completed' : 'failed');
            console.log(`  ${status === 'completed' ? c.green + '✓' : c.red + '✗'}${c.reset} ${reviewer}${attempt > 1 ? ` (attempt ${attempt})` : ''}: ${status}`);
            if (status === 'failed' && diagnostic) console.log(`    ${redactSensitiveText(diagnostic).replace(/\s+/g, ' ').slice(-500)}`);
            innerResolve({ name: reviewer, status, attempt, diagnostic, abortedByTimeout });
          };
          const abort = reason => {
            if (settled || aborted) return;
            aborted = true;
            abortedByTimeout = true;
            diagnostic = `${diagnostic}\n${reason}`.slice(-4000);
            signalProcessTree('SIGTERM');
            forceTimer = setTimeout(() => {
              if (settled) return;
              signalProcessTree('SIGKILL');
              forceTimer = setTimeout(() => void finish(null, 'failed'), 100);
            }, REVIEWER_KILL_GRACE_MS);
          };
          activeReviewers.set(`${reviewer}-${attempt}`, abort);
          const timeoutTimer = setTimeout(() => {
            const reason = `${reviewer} timed out after ${scaledTimeout}ms (scale: ${scale})`;
            console.log(`  ${c.red}✗${c.reset} ${reason}`);
            abortAll(reason);
          }, scaledTimeout);
          proc.on('close', code => {
            if (aborted) return;
            clearTimeout(timeoutTimer);
            if (!signalProcessTree('SIGTERM')) {
              void finish(code);
              return;
            }
            forceTimer = setTimeout(() => {
              signalProcessTree('SIGKILL');
              forceTimer = setTimeout(() => void finish(code), 100);
            }, REVIEWER_KILL_GRACE_MS);
          });
          proc.on('error', error => {
            console.log(`  ${c.red}✗${c.reset} ${reviewer}: ${error.message}`);
            void finish(null, 'error');
            abortAll(`${reviewer} process error: ${error.message}`);
          });
        });

        // Check if this attempt succeeded
        if (result.status === 'completed') {
          resolve(result);
          return;
        }
        lastError = result.diagnostic;

        // Timeout-induced abort: do not retry, propagate failure immediately
        if (result.abortedByTimeout) {
          resolve(result);
          return;
        }

        // If not the last attempt, retry
        if (attempt <= REVIEWER_RETRY_MAX) {
          continue;
        }
      }

      // All retries exhausted
      resolve({ name: reviewer, status: 'failed', attempts: attempt, lastError });
    })));
    results.push(...parallelResults);
    if (parallelResults.some(result => result.status !== 'completed')) {
      const error = new Error(parallelAbortReason || 'one or more reviewer agents failed');
      error.exitCode = 5;
      reviewFailure = error;
    }
  } else {
    // Sequential mode: execute reviewers one by one with delays
    log.info(`Execution: sequential with ${startDelay}ms delays`);
    for (let i = 0; i < allReviewers.length; i++) {
      const reviewer = allReviewers[i];
      const reviewerDir = join(roundDir, reviewer);
      ensureContainedDirectorySync(roundDir, reviewerDir);

      // Check resume artifacts first
      const validation = await validateResumeArtifacts(
        reviewerDir, reviewer, profile, currentRound, candidateIdentity,
        resolvedAgent, resolvedModel,
      );
      if (validation.valid) {
        console.log(`  ${c.blue}↷${c.reset} ${reviewer}: validated resume (score: ${validation.score ?? 'unknown'})`);
        results.push({ name: reviewer, status: 'completed', skipped: true });
        continue;
      }
      if (validation.reason) {
        console.log(`  ${c.yellow}⚡${c.reset} ${reviewer}: invalidating stale artifacts (${validation.reason}), re-running`);
      }

      // Add delay between reviewers (skip delay for first reviewer if no previous ran)
      if (i > 0) {
        await sleep(startDelay);
      }

      const prompt = reviewerPrompts.get(reviewer);
      if (!prompt) {
        console.log(`  ${c.red}✗${c.reset} ${reviewer}: definition not found`);
        results.push({ name: reviewer, status: 'failed' });
        continue;
      }
      await writeContainedFile(roundDir, join(reviewerDir, 'prompt.md'), prompt);

      // Execute reviewer via CLI
      let attempt = 0;
      let lastError = null;
      let status = 'pending';

      while (attempt <= REVIEWER_RETRY_MAX && status !== 'completed') {
        attempt++;
        if (attempt > 1) {
          const delay = RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 2) + Math.random() * RETRY_MAX_JITTER_MS;
          log.info(`  Retry ${attempt - 1}/${REVIEWER_RETRY_MAX} for ${reviewer}: waiting ${Math.round(delay)}ms`);
          await sleep(delay);
        }

        const invocation = getAgentInvocation(resolvedAgent, resolvedModel, prompt);
        const proc = spawn(invocation.command, invocation.args, {
          cwd: PROJECT_ROOT,
          stdio: ['ignore', 'pipe', 'pipe'],
          detached: process.platform !== 'win32',
          env: TOOL_ENV,
        });

        let diagnostic = '';
        let settled = false;
        let forceTimer = null;
        const retainTail = data => { diagnostic = (diagnostic + data.toString()).slice(-4000); };
        const signalProcessTree = signal => {
          if (!proc.pid) return false;
          try {
            if (process.platform === 'win32') {
              const args = ['/pid', String(proc.pid), '/t'];
              if (signal === 'SIGKILL') args.push('/f');
              spawn('taskkill', args, { stdio: 'ignore', env: CANDIDATE_ENV }).unref();
            } else {
              process.kill(-proc.pid, signal);
            }
            return true;
          } catch (error) {
            if (error.code !== 'ESRCH') diagnostic = `${diagnostic}\nprocess-tree ${signal} failed: ${error.message}`.slice(-4000);
            return false;
          }
        };
        const timeoutTimer = setTimeout(() => {
          if (!settled) {
            diagnostic = `${diagnostic}\n${reviewer} timed out after ${scaledTimeout}ms; sending SIGTERM`.slice(-4000);
            signalProcessTree('SIGTERM');
            forceTimer = setTimeout(() => {
              if (!settled) signalProcessTree('SIGKILL');
            }, REVIEWER_KILL_GRACE_MS);
          }
        }, scaledTimeout);

        proc.stdout.on('data', retainTail);
        proc.stderr.on('data', retainTail);

        const exitCode = await new Promise(resolve => {
          const finish = code => {
            if (settled) return;
            settled = true;
            resolve(code);
          };
          proc.on('close', code => {
            if (!signalProcessTree('SIGTERM')) {
              finish(code);
              return;
            }
            forceTimer = setTimeout(() => {
              signalProcessTree('SIGKILL');
              forceTimer = setTimeout(() => finish(code), 100);
            }, REVIEWER_KILL_GRACE_MS);
          });
          proc.on('error', err => { diagnostic = err.message; finish(-1); });
        });

        clearTimeout(timeoutTimer);
        if (forceTimer) clearTimeout(forceTimer);

        let postValidation = await validateResumeArtifacts(
          reviewerDir, reviewer, profile, currentRound, candidateIdentity,
          resolvedAgent, resolvedModel,
        );

        // Preserve canonical files written by the reviewer; parse stdout only as a fallback.
        if (!postValidation.valid && exitCode === 0 && diagnostic.trim()) {
          try {
            await writeReviewerFilesFromOutput(
              reviewerDir, diagnostic, reviewer, profile, currentRound,
              candidateIdentity.commit, candidateIdentity.tree
            );
            postValidation = await validateResumeArtifacts(
              reviewerDir, reviewer, profile, currentRound, candidateIdentity,
              resolvedAgent, resolvedModel,
            );
          } catch (e) {
            console.log(`  ${c.yellow}⚡${c.reset} ${reviewer}: file write parse error: ${e.message}`);
          }
        }

        const complete = postValidation.valid;
        if (complete && exitCode === 0) {
          status = 'completed';
          console.log(`  ${c.green}✓${c.reset} ${reviewer}: completed`);
        } else {
          if (diagnostic) {
            console.log(`  ${c.red}✗${c.reset} ${reviewer}${attempt > 1 ? ` (attempt ${attempt})` : ''}: ${redactSensitiveText(diagnostic).replace(/\s+/g, ' ').slice(-300)}`);
          } else {
            console.log(`  ${c.red}✗${c.reset} ${reviewer}${attempt > 1 ? ` (attempt ${attempt})` : ''}: failed (exit ${exitCode})`);
          }
          lastError = diagnostic;
        }
      }

      results.push({ name: reviewer, status, diagnostic: lastError });
      if (onReviewComplete) onReviewComplete(reviewer, reviewerDir, evidence);
    }

    // Check for failures in sequential mode
    const failedResults = results.filter(r => r.status !== 'completed' && r.status !== 'skipped');
    if (failedResults.length > 0) {
      const error = new Error(`Sequential review failed for: ${failedResults.map(r => r.name).join(', ')}`);
      error.exitCode = 5;
      reviewFailure = error;
    }
  }

  // Write metadata
  const { diff: _sensitiveDiff, ...safeGitEvidence } = evidence.git || {};
  const meta = {
    profile,
    round: currentRound,
    reviewBackend: resolvedAgent,
    reviewModel: resolvedModel,
    reviewers: allReviewers,
    triggeredConditional,
    timestamp: new Date().toISOString(),
    gate: profileConfig.gate,
    scale: scaleInfo, // Change scale detection result
    parallelExecution: {
      enabled: parallel,
      baseTimeout: REVIEWER_TIMEOUT_MS,
      scaledTimeout: scaledTimeout,
      scaleMultiplier: SCALE_TIMEOUT_MULTIPLIERS[scale],
      retryMax: REVIEWER_RETRY_MAX,
    },
    evidence: {
      git: safeGitEvidence,
      structure: evidence.structure,
    },
  };
  await writeContainedFile(roundDir, join(roundDir, 'runner-metadata.json'), JSON.stringify(meta, null, 2));

  console.log(`\n${c.green}✓${c.reset} Metadata written`);
  if (reviewFailure) throw reviewFailure;
}

// Main
async function main() {
  console.log(`\n${c.bright}${c.cyan}═══════════════════════════════════════════════════${c.reset}`);
  console.log(`${c.bright}${c.cyan}    Release Quality Review - Orchestrator${c.reset}`);
  console.log(`${c.bright}${c.cyan}═══════════════════════════════════════════════════${c.reset}`);

  // Load profile
  const profileConfig = loadProfile(profile);
  if (!profileConfig) {
    log.error('Failed to load profile, exiting');
    process.exit(4);
  }
  if (reviewerOverride && !loadReviewer(reviewerOverride)) {
    log.error(`Unknown reviewer: ${reviewerOverride}`);
    process.exit(4);
  }

  console.log(`\n${c.blue}ℹ${c.reset} Profile: ${profileConfig.name}`);
  console.log(`${c.blue}ℹ${c.reset} ${profileConfig.description || ''}`);
  if (profileConfig.estimated_time) {
    console.log(`${c.blue}ℹ${c.reset} Estimated time: ${profileConfig.estimated_time}`);
  }

  const minScore = profileConfig.gate?.min_score || 90;

// Normal single-run mode
  // CRITICAL: Calculate round number BEFORE running reviews to avoid round-null
  let effectiveRound = roundNumber;
  if (effectiveRound === null) {
    let maxRound = 0;
    if (existsSync(REPORT_DIR)) {
      const rounds = readdirSync(REPORT_DIR).filter(d => d.startsWith('round-'));
      for (const r of rounds) {
        const num = parseInt(r.replace('round-', ''), 10);
        if (!isNaN(num) && num > maxRound) maxRound = num;
      }
    }
    effectiveRound = maxRound + 1;
  }
  console.log(`${c.blue}ℹ${c.reset} Running round: ${effectiveRound}`);

  await runSingleReviewIteration(profileConfig, effectiveRound, () => {});
  if (dryRun) return;

  // Determine round directory for gate check (same as iteration)
  const roundDir = join(REPORT_DIR, `round-${String(effectiveRound).padStart(3, '0')}`);

  // Run gate check
  console.log(`\n${c.cyan}═══ Running Gate Check ═══${c.reset}`);
  const gateResult = runGateCheck(roundDir, profile, effectiveRound);

  // Persist phase result AFTER gate check
  const scores = extractScoresFromRound(roundDir);
  const scoresObj = {};
  scores.forEach(s => { scoresObj[s.reviewer] = s.score; });
  const failedReviewers = scores.filter(s => s.score < minScore);
  persistPhaseResult(roundDir, effectiveRound, scoresObj, gateResult.passed, failedReviewers);

  console.log(`\n${c.cyan}═══ Summary ═══${c.reset}\n`);
  console.log(`  Round: ${effectiveRound}`);
  console.log(`  Gate: ${gateResult.passed ? c.green + 'PASSED' : c.red + 'FAILED'}${c.reset}`);

  if (!gateResult.passed) {
    console.log(`\n${c.yellow}Next steps:${c.reset}`);
    console.log(`  1. Fix issues identified by failed reviewers`);
    console.log(`  2. Launch the failed reviewers as independent Codex/Claude host agents`);
    console.log(`  3. Re-run: npm run skill:gate -- --profile ${profile} --round ${effectiveRound}`);
    process.exit(1);
  }
}

main().catch(err => {
  console.error(`\n${c.red}Error:${c.reset}`, err.message);
  process.exit(err.exitCode || 1);
});
