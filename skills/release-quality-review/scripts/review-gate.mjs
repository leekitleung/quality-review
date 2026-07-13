#!/usr/bin/env node
/**
 * Review Gate - Deterministic Quality Gate
 *
 * A deterministic script that runs quality reviews and determines
 * if a release is ready. This is the last line of defense before
 * a release is allowed.
 *
 * Usage:
 *   node review-gate.mjs --profile release-gate    # Full review
 *   node review-gate.mjs --profile quick          # Quick review (resident only)
 *   node review-gate.mjs --reviewer destructive-qa  # Single reviewer
 *   node review-gate.mjs --check-redlines         # Only check redlines
 *   node review-gate.mjs --round 3                # Continue from round 3
 *   node review-gate.mjs --collect-evidence        # Auto collect evidence
 *   node review-gate.mjs --dry-run               # Validate without running
 */

import { readFileSync, existsSync, readdirSync, statSync } from 'fs';
import { join, dirname, resolve, extname, relative } from 'path';
import { fileURLToPath } from 'url';
import { readFile } from 'fs/promises';
import { createHash } from 'node:crypto';
import { persistPhasePlan } from '../lib/phase-persistence.mjs';
import { createCandidateRuntime } from '../lib/candidate-runtime.mjs';
import {
  parseScore as parseScoreShared,
  parseBlockers as parseBlockersShared,
  parseYamlResult as parseYamlResultShared,
  parseYamlProfile as parseYamlProfileShared,
  matchesTriggerConditions,
  validateCleanCandidateEvidence,
} from '../lib/review-utils.mjs';
import {
  containsSensitiveText, ensureContainedDirectorySync, readContainedFileSync,
  redactSensitiveText, writeContainedFile, writeContainedFileSync,
} from '../lib/security-utils.mjs';

// Use process.cwd() as the reliable project root
const PROJECT_ROOT = process.cwd();
const SKILL_DIR = join(PROJECT_ROOT, 'skills', 'release-quality-review');
const REPORT_DIR = join(PROJECT_ROOT, 'quality-reports');
const CONFIG_FILE = join(SKILL_DIR, 'review-config.yaml');
const {
  isolatedHome: ISOLATED_HOME, execSync, execFileSync,
  prepareCheckout: prepareCandidateCheckout, readIdentity: readCheckoutIdentity,
  validateCheckout: validateCandidateCheckout,
} = createCandidateRuntime(PROJECT_ROOT, 'gate');

// ANSI colors
const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
};

const log = {
  info: (msg) => console.log(`${colors.blue}ℹ${colors.reset} ${msg}`),
  success: (msg) => console.log(`${colors.green}✓${colors.reset} ${msg}`),
  warn: (msg) => console.log(`${colors.yellow}⚠${colors.reset} ${msg}`),
  error: (msg) => console.log(`${colors.red}✗${colors.reset} ${msg}`),
  title: (msg) => console.log(`\n${colors.bright}${colors.cyan}═══ ${msg} ═══${colors.reset}\n`),
};

function parseCliArgs(args) {
  const options = {
    profile: 'release-gate', singleReviewer: null, checkRedlinesOnly: false,
    roundNumber: null, collectEvidence: true, dryRun: false,
    excludeReviewers: [], detectScale: false, userSpecifiedProfile: false,
    validateEvidence: true, checkGoalMode: false, diffBase: 'HEAD',
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
  if (arg === '--profile' && args[i + 1]) {
    options.profile = args[i + 1];
    options.userSpecifiedProfile = true;
    i++;
  } else if (arg === '--reviewer' && args[i + 1]) {
    options.singleReviewer = args[i + 1];
    i++;
  } else if (arg === '--check-redlines') {
    options.checkRedlinesOnly = true;
  } else if (arg === '--check-goal-mode') {
    options.checkGoalMode = true;
  } else if (arg === '--round' && args[i + 1]) {
    const roundArg = args[++i];
    if (!/^\d+$/.test(roundArg) && !/^round-\d+$/i.test(roundArg)) {
      log.error('Invalid --round: expected a positive integer or round-NNN');
      process.exit(4);
    }
    // Support both "3" and "round-003" formats
    const match = roundArg.match(/^round-(\d+)$/i);
    const parsed = match ? parseInt(match[1], 10) : parseInt(roundArg, 10);
    // Guard against NaN (e.g., "round-null" or invalid input)
    if (!Number.isInteger(parsed) || parsed < 1) {
      log.error('Invalid --round: expected a positive integer');
      process.exit(4);
    }
    options.roundNumber = parsed;
  } else if (arg === '--no-collect') {
    options.collectEvidence = false;
  } else if (arg === '--collect-evidence') {
    options.collectEvidence = true;
  } else if (arg === '--dry-run') {
    options.dryRun = true;
  } else if (arg === '--exclude-reviewer' && args[i + 1]) {
    options.excludeReviewers.push(args[i + 1]);
    i++;
  } else if (arg === '--detect-scale') {
    options.detectScale = true;
  } else if (arg === '--validate-evidence') {
    options.validateEvidence = true;
  } else if (arg === '--no-validate-evidence') {
    options.validateEvidence = false;
  } else if (arg === '--base' && args[i + 1]) {
    options.diffBase = args[i + 1];
    i++;
  } else if (arg === '--help' || arg === '-h') {
    printHelp();
    process.exit(0);
  } else {
    log.error(`Unknown or incomplete option: ${arg}`);
    process.exit(4);
  }
  }
  options.excludeReviewers = Object.freeze([...options.excludeReviewers]);
  return Object.freeze(options);
}

const {
  profile, singleReviewer, checkRedlinesOnly, roundNumber: requestedRoundNumber,
  collectEvidence, dryRun, excludeReviewers, detectScale, userSpecifiedProfile,
  validateEvidence, checkGoalMode, diffBase,
} = parseCliArgs(process.argv.slice(2));

function latestExistingRound() {
  ensureContainedDirectorySync(PROJECT_ROOT, REPORT_DIR);
  const rounds = readdirSync(REPORT_DIR)
    .map(name => name.match(/^round-(\d+)$/)?.[1])
    .filter(Boolean)
    .map(Number);
  return rounds.length ? Math.max(...rounds) : 1;
}

const roundNumber = requestedRoundNumber ?? latestExistingRound();

if (!/^[a-z0-9-]+$/.test(profile) || (singleReviewer && !/^[a-z0-9-]+$/.test(singleReviewer))) {
  log.error('Invalid profile or reviewer name');
  process.exit(4);
}
if (excludeReviewers.some(name => !/^[a-z0-9-]+$/.test(name))) {
  log.error('Invalid excluded reviewer name');
  process.exit(4);
}
if (!validateEvidence && ['release-gate', 'full', 'agentic-release-gate'].includes(profile)) {
  log.error('--no-validate-evidence is not allowed for strict profiles');
  process.exit(4);
}

function resolveDiffBase(ref) {
  if (ref === 'HEAD') return 'HEAD';
  if (!/^[A-Za-z0-9._/@-]+$/.test(ref)) {
    log.error(`Invalid --base ref: ${ref}`);
    process.exit(4);
  }
  try {
    return execFileSync('git', ['merge-base', ref, 'HEAD'], {
      encoding: 'utf-8', cwd: PROJECT_ROOT, timeout: 10000,
    }).trim();
  } catch {
    log.error(`Unable to resolve --base ref: ${ref}`);
    process.exit(4);
  }
}
const resolvedDiffBase = resolveDiffBase(diffBase);

// ============================================================================
// Right-size Throttle: Change Scale Detection
// ============================================================================

/**
 * Detect the scale of changes based on git diff stats
 * @returns {{ scale: string, files: number, additions: number, deletions: number, total: number, suggestedProfile: string }}
 */
function detectChangeScale() {
  try {
    // Use diffBase to compare against a specific commit range
    // Default: git diff HEAD (working tree). Use --base origin/main to compare branches.
    const diff = execFileSync('git', ['diff', '--numstat', resolvedDiffBase], {
      encoding: 'utf-8',
      cwd: PROJECT_ROOT,
      timeout: 10000,
    });

    let totalFiles = 0;
    let totalAdditions = 0;
    let totalDeletions = 0;

    for (const line of diff.split('\n')) {
      const match = line.match(/^(\d+|-)\s+(\d+|-)\s+(.+)$/);
      if (match) {
        totalFiles++;
        totalAdditions += parseInt(match[1]) || 0;
        totalDeletions += parseInt(match[2]) || 0;
      }
    }
    const untracked = execFileSync('git', ['ls-files', '--others', '--exclude-standard'], {
      encoding: 'utf-8', cwd: PROJECT_ROOT, timeout: 10000,
    }).trim().split('\n').filter(Boolean);
    totalFiles += untracked.length;

    const totalChanges = totalAdditions + totalDeletions;

    // Determine scale based on file count and line count
    let scale = 'micro';
    let reason = '';

    if (totalFiles >= 50 || totalChanges >= 2000) {
      scale = 'xlarge';
      reason = 'Very large change (50+ files or 2000+ lines)';
    } else if (totalFiles >= 21 || totalChanges >= 500) {
      scale = 'large';
      reason = 'Large change (21-50 files or 500-2000 lines)';
    } else if (totalFiles >= 6 || totalChanges >= 100) {
      scale = 'medium';
      reason = 'Medium change (6-20 files or 100-500 lines)';
    } else if (totalFiles >= 3 || totalChanges >= 50) {
      scale = 'small';
      reason = 'Small change (3-5 files or 50-100 lines)';
    } else {
      scale = 'micro';
      reason = 'Micro change (1-2 files and <50 lines)';
    }

    // Profile mapping
    const profileMap = {
      micro: 'quick',
      small: 'quick',
      medium: 'default',
      large: 'release-gate',
      xlarge: 'agentic-release-gate',  // XLarge 规模强制使用 agentic gate
    };

    return {
      scale,
      files: totalFiles,
      additions: totalAdditions,
      deletions: totalDeletions,
      total: totalChanges,
      suggestedProfile: profileMap[scale],
      reason,
      requiresAgentic: scale === 'xlarge',
    };
  } catch (e) {
    return {
      scale: 'unknown',
      files: 0,
      additions: 0,
      deletions: 0,
      total: 0,
      suggestedProfile: 'release-gate',
      reason: 'Could not detect changes, using default',
      requiresAgentic: false,
    };
  }
}

/**
 * Print scale detection results
 */
function printScaleDetection(scaleInfo) {
  console.log('');
  console.log(`${colors.bright}${colors.cyan}═══════════════════════════════════════════════════${colors.reset}`);
  console.log(`${colors.bright}${colors.cyan}    Release Quality Gate - Change Scale Detection${colors.reset}`);
  console.log(`${colors.bright}${colors.cyan}═══════════════════════════════════════════════════${colors.reset}`);
  console.log('');

  console.log(`${colors.blue}ℹ${colors.reset} Detected Changes:`);
  console.log(`   Files: ${scaleInfo.files}`);
  console.log(`   Additions: ${scaleInfo.additions > 0 ? '+' : ''}${scaleInfo.additions}`);
  console.log(`   Deletions: ${scaleInfo.deletions > 0 ? '-' : ''}${scaleInfo.deletions}`);
  console.log(`   Total: ${scaleInfo.total} lines`);
  console.log('');

  console.log(`${colors.blue}ℹ${colors.reset} Scale: ${colors.bright}${scaleInfo.scale}${colors.reset}`);
  console.log(`   ${scaleInfo.reason}`);
  console.log('');

  console.log(`${colors.blue}ℹ${colors.reset} Suggested Profile: ${colors.bright}${scaleInfo.suggestedProfile}${colors.reset}`);
  if (scaleInfo.requiresAgentic) {
    console.log(`   ${colors.yellow}⚠${colors.reset} XLarge change: agentic-review is recommended`);
  }
  console.log('');

  if (userSpecifiedProfile) {
    console.log(`${colors.blue}ℹ${colors.reset} User Override: Using --profile ${profile}`);
  } else {
    console.log(`${colors.blue}ℹ${colors.reset} Override with: ${colors.cyan}--profile <name>${colors.reset}`);
  }
  console.log('');
}

// Run scale detection and exit if requested
if (detectScale) {
  const scaleInfo = detectChangeScale();
  printScaleDetection(scaleInfo);
  process.exit(0);
}

// Detect scale at startup (non-blocking)
const startupScaleInfo = detectChangeScale();


function printHelp() {
  console.log(`
${colors.bright}Review Gate - Deterministic Quality Gate${colors.reset}

Usage:
  node review-gate.mjs [options]

Options:
  --profile <name>       Profile: quick, default, release-gate, full, agentic-release-gate
  --reviewer <name>     Run only this reviewer
  --round <N>           Round number (auto-detected if not specified)
  --check-redlines      Only check for redlines (P0/P1 blockers)
  --check-goal-mode     Enable goal mode constraint (describe final state, not steps)
  --no-collect          Skip automatic evidence collection
  --collect-evidence    Force evidence collection (default)
  --exclude-reviewer N  Exclude reviewer N from this run
  --detect-scale         Detect change scale and suggest profile
  --validate-evidence   Enable evidence source validation (default: true)
  --no-validate-evidence Skip evidence source validation (对抗性审查)
  --base <ref>          Git diff base for change detection (default: HEAD, use "origin/main" for branch comparison)
  --dry-run             Validate configuration without running
  --help, -h            Show this help

Profiles:
  quick         Minimal resident reviewers (product-flow, architecture-maintainer)
  default       Standard PR review (product-flow, destructive-qa, terminal-veteran)
  release-gate  Full release gate (all residents + terminal-veteran)
  full          Complete review (all 8 reviewers)
  agentic-release-gate  Full independent and adversarial release arbitration

Exit Codes:
  0 = All gates passed
  1 = Gates failed
  2 = Unexpected runtime error
  4 = Configuration or invalid CLI input

Examples:
  npm run skill:gate -- --profile release-gate
  npm run skill:gate -- --detect-scale
  npm run skill:gate -- --round 2 --profile default
  npm run skill:gate -- --reviewer destructive-qa --round 2
  `);
}

// Load configuration
function loadConfig() {
  try {
    if (existsSync(CONFIG_FILE)) {
      const content = readFileSync(CONFIG_FILE, 'utf-8');
      const config = {
        verification: {},
        gate: {},
      };
      const lines = content.split('\n');
      let currentSection = '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;

        // Section headers
        if (trimmed.startsWith('verification:') || trimmed.startsWith('gate:')) {
          currentSection = trimmed.replace(':', '').trim();
          continue;
        }

        if (trimmed && trimmed.includes(':')) {
          const [key, ...valueParts] = trimmed.split(':');
          const value = valueParts.join(':').trim();

          if (value) {
            const cleanValue = value.replace(/^["']|["']$/g, '');

            // Map to correct section
            if (currentSection === 'verification' || ['test', 'build', 'lint', 'typecheck', 'e2e', 'audit'].includes(key.trim())) {
              config.verification[key.trim()] = cleanValue;
            } else if (currentSection === 'gate' || ['min_score', 'fail_on_redlines', 'fail_on_p0_p1_blockers'].includes(key.trim())) {
              config.gate[key.trim()] = cleanValue;
            } else {
              config[key.trim()] = cleanValue;
            }
          }
        }
      }
      return config;
    }
  } catch (e) {
    log.warn(`Could not load config: ${e.message}`);
  }
  return { verification: {}, gate: {} };
}

// Load YAML profile configuration
function loadYamlProfile(profileName) {
  const profilePath = join(SKILL_DIR, 'profiles', `${profileName}.yaml`);
  if (!existsSync(profilePath)) return null;
  try {
    return parseYamlProfileShared(readFileSync(profilePath, 'utf-8'), profileName);
  } catch (error) {
    log.warn(`Could not load profile ${profileName}: ${error.message}`);
    return null;
  }
}

// Detect conditional reviewers based on git changes
function detectConditionalReviewers(profile) {
  if (!profile.conditional_reviewers || profile.conditional_reviewers.length === 0) {
    return [];
  }

  const triggered = [];
  const triggerConditions = profile.trigger_conditions || {};

  try {
    // Get changed files
    const gitOutput = execFileSync('git', ['diff', '--name-only', resolvedDiffBase], {
      encoding: 'utf-8',
      cwd: PROJECT_ROOT,
      timeout: 10000,
    });
    const untracked = execFileSync('git', ['ls-files', '--others', '--exclude-standard'], {
      encoding: 'utf-8', cwd: PROJECT_ROOT, timeout: 10000,
    });
    const changedFiles = [...new Set(`${gitOutput}\n${untracked}`.split('\n').filter(f => f.trim()))];
    const diffContent = execFileSync('git', ['diff', resolvedDiffBase], {
      encoding: 'utf-8', cwd: PROJECT_ROOT, timeout: 10000, maxBuffer: 10 * 1024 * 1024,
    });

    for (const reviewer of profile.conditional_reviewers) {
      const conditions = triggerConditions[reviewer];
      if (!conditions) {
        // No specific conditions - always trigger
        triggered.push(reviewer);
        continue;
      }

      const matched = matchesTriggerConditions(changedFiles, diffContent, conditions);

      if (matched) {
        triggered.push(reviewer);
      }
    }
  } catch (e) {
    // Git not available - skip conditional detection
    log.warn('Could not detect conditional reviewers: git not available');
  }

  return triggered;
}

// Reviewer profiles
const PROFILES = {
  'quick': {
    name: 'Quick Review',
    description: 'Minimal resident reviewers only',
    reviewers: ['product-flow', 'architecture-maintainer'],
  },
  'default': {
    name: 'Default Review',
    description: 'Standard PR review',
    reviewers: ['product-flow', 'destructive-qa', 'terminal-veteran'],
  },
  'release-gate': {
    name: 'Release Gate Review',
    description: 'Full release gate - required before publish',
    reviewers: [
      'product-flow',
      'architecture-maintainer',
      'release-verifier',
      'destructive-qa',
      'terminal-veteran'
    ],
  },
  'full': {
    name: 'Full Review',
    description: 'All reviewers including conditional triggers',
    reviewers: [
      'product-flow',
      'architecture-maintainer',
      'release-verifier',
      'destructive-qa',
      'native-designer',
      'zero-doc-user',
      'terminal-veteran',
      'data-security'
    ],
  },
};

// Load reviewer definition
function loadReviewer(name) {
  const path = join(SKILL_DIR, 'reviewers', `${name}.md`);
  if (!existsSync(path)) {
    return null;
  }
  return readFileSync(path, 'utf-8');
}
// Collect evidence automatically
function collectEvidence_(config) {
  log.info('Collecting evidence...');

  const evidence = {
    timestamp: new Date().toISOString(),
    git: {},
    files: {},
    automatedChecks: {},
  };

  // Git info
  try {
    evidence.git = {
      branch: execSync('git branch --show-current 2>/dev/null || echo ""', { encoding: 'utf-8' }).trim(),
      commit: execSync('git rev-parse HEAD 2>/dev/null || echo ""', { encoding: 'utf-8' }).trim().substring(0, 8),
      status: execSync('git status --short 2>/dev/null || echo ""', { encoding: 'utf-8' }).trim(),
      diff: execFileSync('git', ['diff', '--stat', resolvedDiffBase], { encoding: 'utf-8' }).trim(),
    };
  } catch (e) {
    log.warn('Could not collect git evidence');
  }
  if (evidence.git.status !== '') {
    throw new Error('source checkout must be clean before evidence collection');
  }

  // Package info
  try {
    const packageJson = join(PROJECT_ROOT, 'package.json');
    if (existsSync(packageJson)) {
      const pkg = JSON.parse(readFileSync(packageJson, 'utf-8'));
      evidence.files.package = {
        name: pkg.name,
        version: pkg.version,
        scripts: Object.keys(pkg.scripts || {}),
      };
    }
  } catch (e) {
    // Ignore
  }

  // Automated checks with config
  const candidateRoot = prepareCandidateCheckout();
  const initialCheckout = readCheckoutIdentity(candidateRoot);
  evidence.automatedChecks = runAutomatedChecks(config, candidateRoot, initialCheckout);

  return evidence;
}

function redactEvidence(value) {
  return redactSensitiveText(value);
}

async function persistEvidence(roundDir, evidence, profileName, reviewers) {
  const evidenceDir = join(roundDir, 'evidence');
  ensureContainedDirectorySync(roundDir, evidenceDir);
  const automatedContent = `${JSON.stringify(evidence.automatedChecks, null, 2)}\n`;
  const cleanCandidatePath = join(evidenceDir, 'clean-candidate.json');
  const cleanCandidateContent = existsSync(cleanCandidatePath)
    ? readContainedFileSync(roundDir, cleanCandidatePath, 'utf8')
    : null;
  const metadata = {
    profile: profileName,
    round: roundNumber,
    reviewers,
    collected_at: evidence.timestamp,
    git: evidence.git,
    files: evidence.files,
    candidate_commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: PROJECT_ROOT, encoding: 'utf8' }).trim(),
    candidate_tree: execFileSync('git', ['rev-parse', 'HEAD^{tree}'], { cwd: PROJECT_ROOT, encoding: 'utf8' }).trim(),
    automated_checks_sha256: createHash('sha256').update(automatedContent).digest('hex'),
    clean_candidate_sha256: cleanCandidateContent === null
      ? null
      : createHash('sha256').update(cleanCandidateContent).digest('hex'),
  };
  await writeContainedFile(PROJECT_ROOT, join(evidenceDir, 'automated-checks.json'), automatedContent);
  await writeContainedFile(PROJECT_ROOT, join(roundDir, 'metadata.json'), `${JSON.stringify(metadata, null, 2)}\n`);
}

function validCommandEvidence(record, expectedCommand) {
  const started = Date.parse(record?.started_at);
  const finished = Date.parse(record?.finished_at);
  const retainedBytes = Buffer.byteLength(record?.output || '');
  return record && record.command === expectedCommand &&
    typeof record.started_at === 'string' && typeof record.finished_at === 'string' &&
    Number.isFinite(started) && Number.isFinite(finished) && finished >= started &&
    Number.isInteger(record.exit_code) && ['pass', 'fail'].includes(record.status) &&
    (record.status === 'pass') === (record.exit_code === 0) &&
    typeof record.output === 'string' && Number.isInteger(record.output_bytes) &&
    record.output_bytes >= retainedBytes && typeof record.truncated === 'boolean' &&
    (record.truncated || record.output_bytes === retainedBytes);
}

function validCandidateCheckoutEvidence(record, expectedCommit, expectedTree) {
  return record?.status === 'pass' && record.source_commit === expectedCommit && record.source_tree === expectedTree &&
    record.initial?.commit === expectedCommit && record.initial?.tree === expectedTree && record.initial?.status === '' &&
    record.final?.commit === expectedCommit && record.final?.tree === expectedTree && record.final?.status === '';
}

function collectReviewerPacketDigests(roundDir, packetReviewers) {
  const requiredFiles = ['result.yaml', 'score.md', 'blockers.md', 'improvement-list.md'];
  const digests = {};
  for (const reviewer of packetReviewers) {
    const reviewerDir = join(roundDir, reviewer);
    const paths = requiredFiles.map(file => join(reviewerDir, file));
    if (!paths.every(existsSync)) continue;
    try {
      const hash = createHash('sha256');
      for (let index = 0; index < requiredFiles.length; index++) {
        const content = readContainedFileSync(roundDir, paths[index]);
        hash.update(`${requiredFiles[index]}\0${Buffer.byteLength(content)}\0`);
        hash.update(content);
      }
      digests[reviewer] = hash.digest('hex');
    } catch {
      digests[reviewer] = null;
    }
  }
  return digests;
}

function persistFinalArbitration(roundDir, passed, reason, packetReviewers = []) {
  const evidenceDir = join(roundDir, 'evidence');
  ensureContainedDirectorySync(roundDir, evidenceDir);
  const record = {
    command: redactSensitiveText(['node', ...process.argv.slice(1)].join(' ')),
    recorded_at: new Date().toISOString(),
    profile,
    round: roundNumber,
    status: passed ? 'pass' : 'fail',
    exit_code: passed ? 0 : 1,
    reason,
    candidate_commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: PROJECT_ROOT, encoding: 'utf8' }).trim(),
    candidate_tree: execFileSync('git', ['rev-parse', 'HEAD^{tree}'], { cwd: PROJECT_ROOT, encoding: 'utf8' }).trim(),
    reviewer_packet_sha256: collectReviewerPacketDigests(roundDir, packetReviewers),
  };
  const content = `${JSON.stringify(record, null, 2)}\n`;
  if (containsSensitiveText(content)) throw new Error('final arbitration contains sensitive text');
  writeContainedFileSync(roundDir, join(evidenceDir, 'final-arbitration.json'), content);
}

function runEvidenceCommand(command, cwd = PROJECT_ROOT) {
  const startedAt = new Date().toISOString();
  let rawOutput = '';
  let exitCode = 0;
  try {
    const candidateReportRoot = join(cwd, 'quality-reports');
    rawOutput = execSync(`${command} 2>&1`, {
      encoding: 'utf-8', cwd, timeout: 120000,
      sandboxReadOnlyRoots: cwd === PROJECT_ROOT ? [] : [cwd],
      sandboxWriteRoots: cwd === PROJECT_ROOT ? [ISOLATED_HOME] : [ISOLATED_HOME, candidateReportRoot],
    });
  } catch (error) {
    exitCode = Number.isInteger(error.status) ? error.status : 1;
    rawOutput = String(error.stdout || error.stderr || error.message || 'command failed');
  }
  const redacted = redactEvidence(rawOutput);
  return {
    command: redactEvidence(command),
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    exit_code: exitCode,
    status: exitCode === 0 ? 'pass' : 'fail',
    output: redacted.slice(-8000),
    output_bytes: Buffer.byteLength(redacted),
    truncated: Buffer.byteLength(redacted) > Buffer.byteLength(redacted.slice(-8000)),
  };
}

function scanCircularDependencies() {
  const tracked = execFileSync('git', ['ls-files', 'skills', 'scripts'], {
    cwd: PROJECT_ROOT, encoding: 'utf8', timeout: 30000,
  }).trim().split('\n').filter(file => /\.(?:js|mjs|ts)$/.test(file));
  const files = new Set(tracked.map(file => resolve(PROJECT_ROOT, file)));
  const graph = new Map();
  for (const file of files) {
    const content = readFileSync(file, 'utf8');
    const dependencies = [];
    const importPattern = /(?:import|export)\s+(?:[^'";]+?\s+from\s+)?['"](\.[^'"]+)['"]|import\(\s*['"](\.[^'"]+)['"]\s*\)/g;
    for (const match of content.matchAll(importPattern)) {
      const specifier = match[1] || match[2];
      const base = resolve(dirname(file), specifier);
      const candidates = extname(base)
        ? [base]
        : [base, `${base}.js`, `${base}.mjs`, `${base}.ts`, join(base, 'index.js'), join(base, 'index.mjs'), join(base, 'index.ts')];
      const dependency = candidates.find(candidate => files.has(candidate));
      if (dependency) dependencies.push(dependency);
    }
    graph.set(file, dependencies);
  }

  const visiting = new Set();
  const visited = new Set();
  const cycles = [];
  function visit(file, trail) {
    if (visiting.has(file)) {
      const start = trail.indexOf(file);
      cycles.push([...trail.slice(start), file].map(item => item.slice(PROJECT_ROOT.length + 1)).join(' --> '));
      return;
    }
    if (visited.has(file)) return;
    visiting.add(file);
    for (const dependency of graph.get(file) || []) visit(dependency, [...trail, file]);
    visiting.delete(file);
    visited.add(file);
  }
  for (const file of files) visit(file, []);
  return [...new Set(cycles)];
}

// Run automated gate checks
function runAutomatedChecks(config, candidateRoot, initialCheckout) {
  const checks = {
    oversizedFiles: { status: 'pass', issues: [] },
    circularDeps: { status: 'pass', issues: [] },
    secrets: { status: 'pass', issues: [] },
    testGate: null,
    typecheckGate: null,
    buildGate: null,
    lintGate: null,
    auditGate: null,
    coverageGate: null,
  };

  // Get commands from config or use defaults
  const testCmd = config?.verification?.test || 'pnpm test';
  const typecheckCmd = config?.verification?.typecheck || 'pnpm typecheck';
  const buildCmd = config?.verification?.build || 'pnpm build';
  const lintCmd = config?.verification?.lint || 'pnpm lint';
  const auditCmd = config?.verification?.audit || 'npm audit --audit-level=high';
  const coverageCmd = config?.verification?.coverage || 'npm run coverage';

  // Check 1: Oversized files (>2000 lines)
  log.info('Checking for oversized files...');
  try {
    const output = execSync(
      'find skills scripts .claude .agents -type f \\( -name "*.ts" -o -name "*.js" -o -name "*.mjs" \\) -exec wc -l {} + 2>/dev/null | sort -rn | head -20',
      { encoding: 'utf-8', cwd: PROJECT_ROOT, timeout: 30000 }
    );
    const lines = output.trim().split('\n');
    for (const line of lines) {
      const match = line.trim().match(/^\s*(\d+)\s+(.+)$/);
      if (match) {
        const [count, path] = [parseInt(match[1], 10), match[2]];
        if (path !== 'total' && count > 2000) {
          checks.oversizedFiles.issues.push({ path, lines: count });
          checks.oversizedFiles.status = 'warn';
        }
      }
    }
  } catch (e) {
    log.warn('Could not check file sizes');
  }

  // Check 2: Circular dependencies using the repository's local import graph.
  log.info('Checking for circular dependencies...');
  try {
    const cycles = scanCircularDependencies();
    if (cycles.length > 0) {
      checks.circularDeps.status = 'fail';
      checks.circularDeps.issues = cycles;
    }
  } catch (e) {
    checks.circularDeps.status = 'fail';
    checks.circularDeps.issues = [`circular dependency scan failed: ${e.message}`];
  }

  // Check 3: Secrets in source
  log.info('Checking for secrets in source...');
  try {
    const tracked = execFileSync('git', ['ls-files'], { encoding: 'utf-8', cwd: PROJECT_ROOT }).trim().split('\n');
    const untracked = execFileSync('git', ['ls-files', '--others', '--exclude-standard'], { encoding: 'utf-8', cwd: PROJECT_ROOT }).trim().split('\n');
    const candidates = [...new Set([...tracked, ...untracked])].filter(file =>
      file && !/(^|\/)(__tests__|fixtures|node_modules|quality-reports)(\/|$)/.test(file)
    );
    for (const file of candidates) {
      const absolute = join(PROJECT_ROOT, file);
      if (!existsSync(absolute) || statSync(absolute).isDirectory()) continue;
      const content = readFileSync(absolute, 'utf8');
      if (containsSensitiveText(content)) checks.secrets.issues.push(`${file}:[REDACTED]`);
      if (checks.secrets.issues.length >= 10) break;
    }
    if (checks.secrets.issues.length > 0) {
      checks.secrets.status = 'fail';
    }
  } catch (e) {
    checks.secrets.status = 'fail';
    checks.secrets.issues = ['source scan failed closed'];
  }

  // Check 4: Test gate
  log.info(`Running test gate: ${testCmd}`);
  checks.testGate = runEvidenceCommand(testCmd, candidateRoot);

  // Check 5: Typecheck gate
  log.info(`Running typecheck gate: ${typecheckCmd}`);
  checks.typecheckGate = runEvidenceCommand(typecheckCmd, candidateRoot);

  log.info(`Running build gate: ${buildCmd}`);
  checks.buildGate = runEvidenceCommand(buildCmd, candidateRoot);

  log.info(`Running lint gate: ${lintCmd}`);
  checks.lintGate = runEvidenceCommand(lintCmd, candidateRoot);

  log.info(`Running audit gate: ${auditCmd}`);
  checks.auditGate = runEvidenceCommand(auditCmd, candidateRoot);

  if (profile === 'agentic-release-gate') {
    log.info(`Running coverage gate: ${coverageCmd}`);
    checks.coverageGate = runEvidenceCommand(coverageCmd, candidateRoot);
  }

  checks.candidateCheckout = validateCandidateCheckout(candidateRoot, initialCheckout);

  return checks;
}

// Validate reviewer identity
// SECURITY: Prevents fake reviewers from bypassing the gate
function validateReviewerIdentity(reviewer, profile) {
  const reviewerPath = join(SKILL_DIR, 'reviewers', `${reviewer}.md`);

  // Check if reviewer definition exists
  if (!existsSync(reviewerPath)) {
    return { valid: false, error: `Unknown reviewer: ${reviewer}` };
  }

  return { valid: true };
}

// Load existing scores for a round
// SECURITY: This function validates score authenticity
function loadExistingScores(roundDir, reviewers, expectedCandidateCommit, expectedCandidateTree) {
  const results = {};

  for (const reviewer of reviewers) {
    const reviewerDir = join(roundDir, reviewer);
    const scorePath = join(reviewerDir, 'score.md');
    const blockerPath = join(reviewerDir, 'blockers.md');
    const improvementPath = join(reviewerDir, 'improvement-list.md');
    const resultYamlPath = join(reviewerDir, 'result.yaml');

    let score = null;
    let blockers = [];
    let improvements = null;
    let hasReport = false;
    let scoreSource = null;
    let status = null;
    let declaredReviewer = null;
    let declaredProfile = null;
    let declaredRound = null;
    let declaredCandidateCommit = null;
    let declaredCandidateTree = null;
    let packetError = null;

    // Priority: result.yaml > score.md (for score)
    // Blockers: blockers.md OR result.yaml OR score.md

    // Try result.yaml first (if exists)
    if (existsSync(resultYamlPath)) {
      try {
        const yamlContent = readContainedFileSync(roundDir, resultYamlPath, 'utf-8');
        const yamlResult = parseYamlResultShared(yamlContent);

        if (yamlResult.score !== null) {
          score = yamlResult.score;
          scoreSource = 'result.yaml';
        }
        status = yamlResult.status;
        declaredReviewer = yamlResult.reviewer;
        declaredProfile = yamlResult.profile;
        declaredRound = yamlResult.round;
        declaredCandidateCommit = yamlResult.candidateCommit;
        declaredCandidateTree = yamlResult.candidateTree;

        // Merge blockers from result.yaml (includes nested severity objects)
        const resultBlockers = yamlResult.blockers.map(b =>
          typeof b === 'string' ? b : `${b.priority || b.severity || 'P?'}: ${b.text || b.description || b}`
        );
        if (resultBlockers.length > 0) {
          blockers = resultBlockers;
        }

        // SECURITY: redlines are mandatory P0/P1 blockers that MUST enter veto
        // parseYamlResult separates them from blockers, but loadExistingScores must re-merge
        if (yamlResult.redlines.length > 0) {
          const redlineBlockers = yamlResult.redlines.map(b =>
            typeof b === 'string' ? b : `${b.priority || b.severity || 'P0'}: ${b.text || b.description || b}`
          );
          // Merge redlines into blockers - they carry veto power
          blockers = [...blockers, ...redlineBlockers];
        }

        hasReport = true;
      } catch (e) {
        packetError = `Invalid result.yaml: ${e.message}`;
      }
    }

    // Fall back to score.md for score (if result.yaml didn't have one)
    if (existsSync(scorePath)) {
      try {
        const content = readContainedFileSync(roundDir, scorePath, 'utf-8');
        const parsedScore = parseScoreShared(content);
        if (score === null && parsedScore !== null) {
          score = parsedScore;
          scoreSource = 'score.md';
        } else if (score !== null && parsedScore !== null && parsedScore !== score) {
          packetError = `Score mismatch: result.yaml=${score}, score.md=${parsedScore}`;
        }

        // Also extract blockers from score.md if not found in result.yaml
        const blockerMatch = content.match(/^##\s+Blockers?\s*$\n([\s\S]*?)(?=^##?\s|(?![\s\S]))/im);
        if (blockerMatch) {
          blockers.push(...parseBlockersShared(blockerMatch[1]));
        }

        hasReport = true;
      } catch (e) {
        packetError = `Invalid score.md: ${e.message}`;
      }
    }

    // Load blockers.md independently; no artifact may hide another artifact's veto.
    if (existsSync(blockerPath)) {
      try {
        const blockerContent = readContainedFileSync(roundDir, blockerPath, 'utf-8');
        blockers.push(...parseBlockersShared(blockerContent));
        hasReport = true;
      } catch (e) {
        packetError = `Invalid blockers.md: ${e.message}`;
      }
    }

    // Load improvements
    if (existsSync(improvementPath)) {
      try {
        improvements = readContainedFileSync(roundDir, improvementPath, 'utf-8');
        hasReport = true;
      } catch (e) {
        packetError = `Invalid improvement-list.md: ${e.message}`;
      }
    }

    // Validate reviewer identity
    const validation = validateReviewerIdentity(reviewer, profile);
    const requiredFiles = [resultYamlPath, scorePath, blockerPath, improvementPath];
    const packetPresent = requiredFiles.some(existsSync);
    if (packetPresent && !requiredFiles.every(existsSync)) packetError = 'Incomplete reviewer packet: four required files are mandatory';
    if (packetPresent && declaredReviewer !== reviewer) packetError = `Reviewer identity mismatch: expected ${reviewer}, got ${declaredReviewer || 'missing'}`;
    if (packetPresent && declaredProfile !== profile) packetError = `Profile mismatch: expected ${profile}, got ${declaredProfile || 'missing'}`;
    if (packetPresent && declaredRound !== roundNumber) packetError = `Round mismatch: expected ${roundNumber}, got ${declaredRound ?? 'missing'}`;
    if (packetPresent && declaredCandidateCommit !== expectedCandidateCommit) packetError = `Candidate commit mismatch: expected ${expectedCandidateCommit}, got ${declaredCandidateCommit || 'missing'}`;
    if (packetPresent && declaredCandidateTree !== expectedCandidateTree) packetError = `Candidate tree mismatch: expected ${expectedCandidateTree}, got ${declaredCandidateTree || 'missing'}`;
    if (packetPresent && !['pass', 'fail'].includes(String(status || '').toLowerCase())) packetError = 'result.yaml status must be pass or fail';
    blockers = [...new Set(blockers.map(item => typeof item === 'string' ? item : JSON.stringify(item)))];

    results[reviewer] = {
      score,
      scoreSource, // Track where the score came from
      status,
      hasReport,
      blockers,
      improvements,
      isValidReviewer: validation.valid && !packetError,
      validationError: packetError || validation.error,
    };
  }

  return results;
}

function reviewerPacketPassed(result, minScore = 90) {
  return result?.isValidReviewer === true &&
    result.score !== null &&
    result.score >= minScore &&
    String(result.status || '').toLowerCase() === 'pass' &&
    (result.blockers?.length || 0) === 0;
}

function scanRoundArtifacts(roundDir) {
  const findings = [];
  const queue = [roundDir];
  let fileCount = 0;
  let totalBytes = 0;
  while (queue.length > 0) {
    const directory = queue.shift();
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const file = join(directory, entry.name);
      const label = relative(roundDir, file);
      if (entry.isSymbolicLink()) {
        findings.push(`${label}: symbolic links are not allowed`);
        continue;
      }
      if (entry.isDirectory()) {
        queue.push(file);
        continue;
      }
      if (!entry.isFile()) {
        findings.push(`${label}: unsupported artifact type`);
        continue;
      }
      fileCount++;
      const size = statSync(file).size;
      totalBytes += size;
      if (fileCount > 500 || totalBytes > 20 * 1024 * 1024 || size > 2 * 1024 * 1024) {
        findings.push(`${label}: artifact scan limit exceeded`);
        continue;
      }
      try {
        if (containsSensitiveText(readContainedFileSync(roundDir, file, 'utf8'))) {
          findings.push(`${label}: sensitive text detected`);
        }
      } catch (error) {
        findings.push(`${label}: artifact scan failed (${error.message})`);
      }
    }
  }
  return findings;
}

// Generate summary report
function generateSummary(roundDir, profile, scores, allPassed, evidence = null) {
  const reportPath = join(roundDir, 'summary.md');
  const timestamp = new Date().toISOString();

  let content = `# Quality Review Summary - Round ${roundNumber}\n\n`;
  content += `**Profile:** ${profile}\n`;
  content += `**Generated:** ${timestamp}\n`;

  if (evidence) {
    content += `**Git:** ${evidence.git.branch} @ ${evidence.git.commit}\n`;
  }
  content += `**Final arbitration evidence:** \`evidence/final-arbitration.json\`\n`;

  if (evidence && evidence.automatedChecks) {
    const ac = evidence.automatedChecks;
    content += `## Automated Gate Checks\n\n`;
    content += `| Check | Status | Details |\n`;
    content += `|-------|--------|--------|\n`;

    const testIcon = ac.testGate.status === 'pass' ? '✅' : '❌';
    content += `| test | ${testIcon} ${ac.testGate.status} | ${ac.testGate.status === 'pass' ? 'Passed' : 'See evidence'} |\n`;

    const typeIcon = ac.typecheckGate.status === 'pass' ? '✅' : '❌';
    content += `| typecheck | ${typeIcon} ${ac.typecheckGate.status} | ${ac.typecheckGate.status === 'pass' ? 'Passed' : 'See evidence'} |\n`;

    const buildIcon = ac.buildGate?.status === 'pass' ? '✅' : '❌';
    content += `| build | ${buildIcon} ${ac.buildGate?.status || 'unknown'} | ${ac.buildGate?.status === 'pass' ? 'Passed' : 'See evidence'} |\n`;
    const lintIcon = ac.lintGate?.status === 'pass' ? '✅' : '❌';
    content += `| lint | ${lintIcon} ${ac.lintGate?.status || 'unknown'} | ${ac.lintGate?.status === 'pass' ? 'Passed' : 'See evidence'} |\n`;
    const auditIcon = ac.auditGate?.status === 'pass' ? '✅' : '❌';
    content += `| audit | ${auditIcon} ${ac.auditGate?.status || 'unknown'} | ${ac.auditGate?.status === 'pass' ? 'Passed' : 'See evidence'} |\n`;

    if (ac.coverageGate) {
      const coverageIcon = ac.coverageGate.status === 'pass' ? '✅' : '❌';
      content += `| coverage | ${coverageIcon} ${ac.coverageGate.status} | ${ac.coverageGate.status === 'pass' ? 'Measured' : 'See evidence'} |\n`;
    }

    const sizeIcon = ac.oversizedFiles.status === 'pass' ? '✅' : '⚠️';
    content += `| File sizes | ${sizeIcon} ${ac.oversizedFiles.issues.length} oversized | ${ac.oversizedFiles.issues.slice(0, 2).map(i => `${i.lines}L ${i.path.split('/').pop()}`).join(', ') || 'OK'} |\n`;

    const circIcon = ac.circularDeps.status === 'pass' ? '✅' : '❌';
    content += `| Circular deps | ${circIcon} | ${ac.circularDeps.issues.length > 0 ? ac.circularDeps.issues[0].substring(0, 50) : 'None found'} |\n`;

    const secretIcon = ac.secrets.status === 'pass' ? '✅' : '⚠️';
    content += `| Secrets scan | ${secretIcon} | ${ac.secrets.issues.length > 0 ? ac.secrets.issues.length + ' potential' : 'Clean'} |\n`;

    content += `\n`;

    // Add detail section for issues
    const allIssues = [
      ...ac.oversizedFiles.issues.map(i => `⚠️ **Oversized file**: ${i.path} (${i.lines} lines)`),
      ...ac.secrets.issues.map(i => `⚠️ **Potential secret**: ${i.substring(0, 100)}`),
      ...ac.circularDeps.issues.filter(i => typeof i === 'string').map(i => `❌ **Circular dep**: ${i.substring(0, 100)}`),
    ];

    if (allIssues.length > 0) {
      content += `### Automated Check Issues\n\n`;
      allIssues.forEach((issue, i) => {
        content += `${i + 1}. ${issue}\n`;
      });
      content += `\n`;
    }
  }

  content += `---\n\n`;

  // Score table
  content += `## Scores\n\n`;
  content += `| Reviewer | Score | Status | Blockers |\n`;
  content += `|----------|-------|--------|----------|\n`;

  let totalPassed = 0;
  let totalReviewed = 0;
  let totalBlockers = 0;

  for (const [reviewer, result] of Object.entries(scores)) {
    totalReviewed++;
    if (result.score !== null) {
      const passed = reviewerPacketPassed(result);
      const status = !result.isValidReviewer ? '❌ INVALID' : passed ? '✅ PASS' : '❌ FAIL';
      const blockerCount = result.blockers.length;
      totalBlockers += blockerCount;
      content += `| ${reviewer} | ${result.score}/100 | ${status} | ${blockerCount > 0 ? `⚠ ${blockerCount}` : '-'} |\n`;
      if (passed) totalPassed++;
    } else if (result.hasReport) {
      content += `| ${reviewer} | N/A | ⚠ INCOMPLETE | ${result.blockers.length} |\n`;
    } else {
      content += `| ${reviewer} | - | ⏳ PENDING | - |\n`;
    }
  }

  content += `\n`;
  content += `**Total:** ${totalPassed}/${totalReviewed} passed, ${totalBlockers} blockers\n\n`;

  // Blockers detail
  const allBlockers = Object.entries(scores)
    .filter(([, r]) => r.blockers && r.blockers.length > 0)
    .flatMap(([name, r]) => r.blockers.map(b => ({ reviewer: name, blocker: b })));

  if (allBlockers.length > 0) {
    content += `## Blockers Detail\n\n`;
    for (const { reviewer, blocker } of allBlockers) {
      content += `- **${reviewer}:** ${redactEvidence(String(blocker))}\n`;
    }
    content += `\n`;
  }

  // Overall status
  content += `---\n\n`;
  if (allPassed) {
    content += `## ✅ ALL REVIEWERS PASSED\n\n`;
    content += `This release has passed all quality gates. It is ready to ship.\n`;
    content += `\nTo generate the final report:\n`;
    content += `\`\`\`bash\n`;
    content += `npm run skill:gate -- --profile ${profile} --round ${roundNumber}\n`;
    content += `\`\`\`\n`;
  } else {
    content += `## ❌ QUALITY GATE FAILED\n\n`;
    content += `This release has not passed quality gates. Fix the issues below and re-run review.\n\n`;
    content += `**To continue:** launch the failed or pending reviewers as independent host agents, write their four required report files, then re-run this same round.\n\n`;

    // Show top blockers
    if (allBlockers.length > 0) {
      content += `**Top priorities to fix:**\n\n`;
      allBlockers.slice(0, 5).forEach(({ reviewer, blocker }, i) => {
        content += `${i + 1}. [${reviewer}] ${redactEvidence(String(blocker))}\n`;
      });
    }
  }

  writeContainedFileSync(roundDir, reportPath, content);
  log.success(`Summary written to: ${reportPath}`);
  return allPassed;
}

// Generate Phase boundary marker for persistent handoff
function writePhaseBoundary(roundDir, roundNumber, phase, nextPhase) {
  const boundaryPath = join(roundDir, 'PHASE-COMPLETE.md');
  const timestamp = new Date().toISOString();

  const content = `# Phase ${phase} Complete - Quality Gate Handoff

## Phase Information
- **Current Phase**: ${phase}
- **Next Phase**: ${nextPhase || 'END (Release Complete)'}
- **Round**: ${roundNumber}
- **Completed At**: ${timestamp}

## Handoff Checklist

### Must Complete Before Next Phase
- [ ] All P0/P1 blockers resolved
- [ ] All reviewer scores >= 90/100
- [ ] Evidence source validation passed
- [ ] Goal mode constraint satisfied (if enabled)
- [ ] Phase boundary marked

### Evidence Files Required
- [ ] result.yaml (machine-readable results)
- [ ] score.md (reviewer scoring details)
- [ ] blockers.md (P0/P1 issues)
- [ ] improvement-list.md (P2/P3 suggestions)
- [ ] metadata.json (review metadata)

## Next Phase Criteria

### For Gate Pass
1. All reviewers >= 90/100
2. No P0/P1 redlines
3. Evidence validation passed
4. Phase boundary marked

### For Next Review Round
Run: \`npm run skill:gate -- --round ${roundNumber + 1} --profile release-gate\`

---
*Generated by Release Quality Review Skill*
`;

  writeContainedFileSync(roundDir, boundaryPath, content);
  log.success(`Phase boundary written: ${boundaryPath}`);
  return boundaryPath;
}

// Generate final report when all gates pass
function generateFinalReport(roundDir, scores, evidence = null) {
  const reportPath = join(roundDir, 'final-report.md');
  const timestamp = new Date().toISOString();

  let content = `# 🎉 RELEASE APPROVED\n\n`;
  content += `**Date:** ${timestamp}\n`;
  content += `**Status:** APPROVED FOR RELEASE\n`;

  if (evidence) {
    content += `**Git:** ${evidence.git.branch} @ ${evidence.git.commit}\n`;
  }

  content += `\n---\n\n`;
  content += `## Final Scores\n\n`;
  content += `| Reviewer | Score | Gate |\n`;
  content += `|----------|-------|------|\n`;

  for (const [reviewer, result] of Object.entries(scores)) {
    const status = reviewerPacketPassed(result) ? '✅ PASS' : '❌ FAIL';
    content += `| ${reviewer} | ${result.score}/100 | ${status} |\n`;
  }

  content += `\n---\n\n`;
  content += `## Release Checklist\n\n`;
  content += `- [x] All reviewers >= 90/100\n`;
  content += `- [x] No P0/P1 redlines\n`;
  content += `- [x] Tests passed\n`;
  content += `- [x] Typecheck passed\n`;
  if (['release-gate', 'full', 'agentic-release-gate'].includes(profile)) {
    content += `- [x] Build, lint, audit and source-secret scan passed\n`;
  }
  if (profile === 'agentic-release-gate') {
    content += `- [x] Clean-candidate verification passed for the exact commit/tree\n`;
    content += `- [x] Evidence and Goal instruction validation passed\n`;
  }
  content += `\n`;
  content += `---\n\n`;
  content += `*Generated by Release Quality Review Skill*\n`;
  content += `*Tool: release-quality-review gate*\n`;

  writeContainedFileSync(roundDir, reportPath, content);
  log.success(`Final report: ${reportPath}`);
  return reportPath;
}

// ============================================================================
// Right-size Throttle: Include scale in metadata
// ============================================================================

/**
 * Update metadata.json with scale information
 */
function updateMetadataWithScale(roundDir) {
  const metaPath = join(roundDir, 'metadata.json');
  try {
    let meta = {};
    if (existsSync(metaPath)) {
      meta = JSON.parse(readContainedFileSync(roundDir, metaPath, 'utf-8'));
    }
    meta.scale = startupScaleInfo;
    writeContainedFileSync(roundDir, metaPath, JSON.stringify(meta, null, 2));
  } catch (e) {
    // Ignore - metadata update is best-effort
  }
}

// Main gate check
async function runGate() {
  // Show scale detection at startup
  if (!userSpecifiedProfile) {
    log.info(`Change scale: ${colors.bright}${startupScaleInfo.scale}${colors.reset} (${startupScaleInfo.files} files, ${startupScaleInfo.total} lines)`);
    if (startupScaleInfo.suggestedProfile !== profile) {
      log.info(`Suggested profile: ${colors.cyan}${startupScaleInfo.suggestedProfile}${colors.reset} (use --profile to override)`);
    }
  }

  const config = loadConfig();
  const strictProfileRequested = ['release-gate', 'full', 'agentic-release-gate'].includes(profile);
  if (strictProfileRequested && excludeReviewers.length > 0) {
    log.error('Strict profiles do not allow --exclude-reviewer');
    return false;
  }

  // Determine reviewers to run
  let reviewers = [];
  let profileConfig = PROFILES[profile] || PROFILES['release-gate'];

  // Try to load YAML profile first (overrides PROFILES object)
  const yamlProfile = loadYamlProfile(profile);
  if (yamlProfile) {
    log.info(`Loaded YAML profile: ${yamlProfile.name}`);
    log.info(`  Resident reviewers: ${JSON.stringify(yamlProfile.resident_reviewers)}`);
    log.info(`  Conditional reviewers: ${JSON.stringify(yamlProfile.conditional_reviewers)}`);

    // Start with resident reviewers
    reviewers = [...yamlProfile.resident_reviewers];

    // Detect and add conditional reviewers
    const triggeredConditional = detectConditionalReviewers(yamlProfile);
    if (triggeredConditional.length > 0) {
      log.info(`Conditional reviewers triggered: ${triggeredConditional.join(', ')}`);
      reviewers = [...reviewers, ...triggeredConditional];
    }

    // Add adversarial reviewers if required (XLarge scale)
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
    if (userSpecifiedProfile) {
      log.error(`Profile not found: ${profile}`);
      return false;
    }
    // Fall back to PROFILES object
    reviewers = profileConfig.reviewers.filter(r => !excludeReviewers.includes(r));
  }

  // Single reviewer mode overrides profile
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

    // Validate reviewer files exist
    let valid = true;
    for (const reviewer of reviewers) {
      const exists = existsSync(join(SKILL_DIR, 'reviewers', `${reviewer}.md`));
      log.info(`  ${exists ? '✓' : '✗'} ${reviewer}: ${exists ? 'found' : 'MISSING'}`);
      valid &&= exists;
    }
    return valid;
  }

  // Title
  console.log('');
  log.title('RELEASE QUALITY GATE');
  log.info(`Profile: ${colors.bright}${profile}${colors.reset}`);
  log.info(`Reviewers: ${reviewers.join(', ')}`);
  console.log('');

  // Determine round directory
  ensureContainedDirectorySync(PROJECT_ROOT, REPORT_DIR);
  let roundDir = join(REPORT_DIR, `round-${String(roundNumber).padStart(3, '0')}`);

  // Check if this is a new round or continuing
  const isNewRound = !existsSync(roundDir);
  if (isNewRound) {
    ensureContainedDirectorySync(REPORT_DIR, roundDir);
    log.info(`New round: ${roundDir}`);
  } else {
    ensureContainedDirectorySync(REPORT_DIR, roundDir);
    log.info(`Continuing round: ${roundDir}`);
  }
  const currentCandidateCommit = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: PROJECT_ROOT, encoding: 'utf8', timeout: 10000,
  }).trim();
  const currentCandidateTree = execFileSync('git', ['rev-parse', 'HEAD^{tree}'], {
    cwd: PROJECT_ROOT, encoding: 'utf8', timeout: 10000,
  }).trim();
  if (!isNewRound && collectEvidence) {
    const existingMetadataPath = join(roundDir, 'metadata.json');
    const existingCleanPath = join(roundDir, 'evidence', 'clean-candidate.json');
    try {
      let boundIdentity = null;
      if (existsSync(existingMetadataPath)) {
        const existingMetadata = JSON.parse(readContainedFileSync(roundDir, existingMetadataPath, 'utf8'));
        boundIdentity = {
          commit: existingMetadata.candidate_commit,
          tree: existingMetadata.candidate_tree,
        };
      } else if (existsSync(existingCleanPath)) {
        const existingClean = JSON.parse(readContainedFileSync(roundDir, existingCleanPath, 'utf8'));
        boundIdentity = {
          commit: existingClean.candidate_commit,
          tree: existingClean.candidate_tree,
        };
      }
      if (boundIdentity && (boundIdentity.commit !== currentCandidateCommit || boundIdentity.tree !== currentCandidateTree)) {
        throw new Error('existing round is bound to a different candidate identity; use a fresh round');
      }
    } catch (error) {
      log.error(`Round candidate identity check failed: ${error.message}`);
      persistFinalArbitration(roundDir, false, 'candidate identity mismatch', reviewers);
      return false;
    }
  }
  persistFinalArbitration(roundDir, false, 'gate evaluation in progress', reviewers);

  // Collect evidence if requested
  let evidence = null;
  if (collectEvidence) {
    try {
      evidence = collectEvidence_(config);
      await persistEvidence(roundDir, evidence, profile, reviewers);
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
        const automatedContent = readContainedFileSync(roundDir, automatedPath, 'utf8');
        const automatedChecks = JSON.parse(automatedContent);
        const currentCommit = execFileSync('git', ['rev-parse', '--short=8', 'HEAD'], {
          cwd: PROJECT_ROOT, encoding: 'utf8', timeout: 10000,
        }).trim();
        const currentStatus = execFileSync('git', ['status', '--short'], {
          cwd: PROJECT_ROOT, encoding: 'utf8', timeout: 10000,
        }).trim();
        const fullCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: PROJECT_ROOT, encoding: 'utf8' }).trim();
        const currentTree = execFileSync('git', ['rev-parse', 'HEAD^{tree}'], { cwd: PROJECT_ROOT, encoding: 'utf8' }).trim();
        const digest = createHash('sha256').update(automatedContent).digest('hex');
        const cleanCandidateContent = profile === 'agentic-release-gate'
          ? readContainedFileSync(roundDir, join(roundDir, 'evidence', 'clean-candidate.json'), 'utf8')
          : null;
        const cleanCandidateDigest = cleanCandidateContent === null
          ? null
          : createHash('sha256').update(cleanCandidateContent).digest('hex');
        if (metadata.profile !== profile || metadata.round !== roundNumber ||
            metadata.git?.commit !== currentCommit || metadata.git?.status !== currentStatus ||
            currentStatus !== '' ||
            metadata.candidate_commit !== fullCommit || metadata.candidate_tree !== currentTree ||
            metadata.automated_checks_sha256 !== digest ||
            (profile === 'agentic-release-gate' && metadata.clean_candidate_sha256 !== cleanCandidateDigest)) {
          throw new Error('persisted evidence does not match the current commit and working-tree status');
        }
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
          if (!validCommandEvidence(automatedChecks[name], expectedCommand)) {
            throw new Error(`invalid ${name} command evidence`);
          }
        }
        if (!validCandidateCheckoutEvidence(automatedChecks.candidateCheckout, fullCommit, currentTree)) {
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
        return false;
      }
    }
  }

  const phasePlanPath = join(roundDir, `phase-${roundNumber}-plan.md`);
  if (!existsSync(phasePlanPath)) {
    persistPhasePlan(roundDir, roundNumber, reviewers, evidence || {}, profileConfig);
  }

  // Load existing scores
  const existingScores = loadExistingScores(roundDir, reviewers, currentCandidateCommit, currentCandidateTree);
  const minScore = Number(profileConfig.gate?.min_score ?? 90);
  const pendingReviewers = reviewers.filter(r => !existingScores[r].hasReport);
  const completedReviewers = reviewers.filter(r => existingScores[r].hasReport);

  // Check for redlines only mode
  if (checkRedlinesOnly) {
    log.title('REDLINE CHECK');
    const invalidPackets = Object.values(existingScores).filter(result => !result.isValidReviewer);
    if (pendingReviewers.length > 0 || invalidPackets.length > 0) {
      log.error('Redline check is incomplete: all required reviewer packets must be complete and valid');
      return false;
    }
    const allBlockers = Object.entries(existingScores)
      .filter(([, r]) => r.blockers && r.blockers.length > 0)
      .flatMap(([name, r]) => r.blockers.map(b => ({ reviewer: name, blocker: b })));

    if (allBlockers.length === 0) {
      log.success('No redlines found!');
      return true;
    } else {
      log.error(`Found ${allBlockers.length} redlines:`);
      allBlockers.forEach(({ reviewer, blocker }, i) => {
        console.log(`  ${i + 1}. [${reviewer}] ${blocker}`);
      });
      return false;
    }
  }

  // Show pending reviewers
  if (pendingReviewers.length > 0) {
    log.title('PENDING REVIEWS');
    for (const reviewer of pendingReviewers) {
      const reviewerContent = loadReviewer(reviewer);
      if (reviewerContent) {
        const reviewerDir = join(roundDir, reviewer);
        ensureContainedDirectorySync(roundDir, reviewerDir);
        console.log(`  ${colors.cyan}${reviewer}${colors.reset}`);
      } else {
        log.warn(`  ${reviewer}: reviewer definition not found`);
      }
    }
    console.log('');
  }

  // Show completed reviewers with scores
  if (completedReviewers.length > 0) {
    log.title('COMPLETED REVIEWS');
    for (const reviewer of completedReviewers) {
      const reviewerResult = existingScores[reviewer];
      const score = reviewerResult.score;
      const blockerCount = reviewerResult.blockers?.length || 0;
      const isValid = reviewerResult.isValidReviewer;
      const scoreSource = reviewerResult.scoreSource;

      // Validate reviewer identity
      if (!isValid) {
        console.log(`  ${colors.red}✗${colors.reset} ${reviewer}: ${colors.red}INVALID REVIEWER${colors.reset}`);
        console.log(`    ${colors.yellow}⚠${colors.reset} ${reviewerResult.validationError}`);
        continue;
      }

      if (score !== null) {
        const reviewerPassed = reviewerPacketPassed(reviewerResult, minScore);
        const icon = reviewerPassed ? '✅' : '❌';
        const blockerIcon = blockerCount > 0 ? ` ${colors.yellow}⚠${blockerCount}${colors.reset}` : '';
        const sourceNote = scoreSource === 'result.yaml' ? ` ${colors.dim}(verified)${colors.reset}` : '';
        console.log(`  ${icon} ${reviewer}: ${score}/100${blockerIcon}${sourceNote}`);
      } else if (reviewerResult.hasReport) {
        console.log(`  ${colors.yellow}⚠${colors.reset} ${reviewer}: incomplete${blockerCount > 0 ? ` ${colors.yellow}⚠${blockerCount}${colors.reset}` : ''}`);
      }
    }
    console.log('');
  }

  // Calculate overall status (moved up for evidence validation check)
  // SECURITY: All reviewers must be valid, have scores, and pass the 90 threshold
  // SECURITY: Evidence must pass source validation (对抗性审查)
  const allValid = reviewers.every(r => existingScores[r].isValidReviewer !== false);
  const allHaveScores = reviewers.every(r => existingScores[r].score !== null);

  // ============================================================================
  // P3: 对抗性审查 - 运行 evidence-validator 检查证据来源合规性
  // ============================================================================
  let evidenceValidationPassed = !validateEvidence;
  let evidenceValidationResults = null;

  if (validateEvidence && allHaveScores) {
    log.title('EVIDENCE SOURCE VALIDATION');
    try {
      const evidenceValidatorScript = join(SKILL_DIR, 'scripts', 'evidence-validator.mjs');
      if (existsSync(evidenceValidatorScript)) {
        const roundName = `round-${String(roundNumber).padStart(3, '0')}`;
        log.info(`Running evidence-validator for ${roundName}...`);

        // Run evidence validator and capture output
        const validatorOutput = execFileSync('node', [evidenceValidatorScript, '--round', roundName, '--base', resolvedDiffBase], {
          encoding: 'utf-8', cwd: PROJECT_ROOT, timeout: 60000,
        });

        // Check if validation passed
        if (validatorOutput.includes('✅ All reviewers passed')) {
          evidenceValidationPassed = true;
          log.success('Evidence source validation passed');
        } else {
          evidenceValidationPassed = false;
          log.warn('Evidence validation found issues');
          console.log(validatorOutput);

          // Also save to file
          const validationReportPath = join(roundDir, 'evidence-validation.md');
          writeContainedFileSync(roundDir, validationReportPath, `# Evidence Source Validation\n\n${validatorOutput}\n`);
          log.info(`Validation report: ${validationReportPath}`);
        }
        evidenceValidationResults = validatorOutput;
      } else {
        log.error('Evidence validator is missing');
      }
    } catch (e) {
      // Validator might exit 1 on violations - that's expected
      if (e.stdout) {
        evidenceValidationPassed = false;
        log.warn('Evidence validation found issues');
        console.log(e.stdout);

        // Save report
        const validationReportPath = join(roundDir, 'evidence-validation.md');
        writeContainedFileSync(roundDir, validationReportPath, `# Evidence Source Validation\n\n${e.stdout}\n`);
      } else {
        evidenceValidationPassed = false;
        log.warn(`Evidence validator error: ${e.message}`);
      }
    }
  }

  // ============================================================================
  // P1: Goal Mode Constraint Check - 强制描述最终状态而非实现步骤
  // ============================================================================
  let goalModeViolations = [];
  if (checkGoalMode && allHaveScores) {
    log.title('GOAL MODE CONSTRAINT CHECK');

    // 检测 score.md 中是否描述了实现步骤而非目标达成
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
          // Reset lastIndex for global patterns
          pattern.lastIndex = 0;
          const matches = content.match(pattern);
          if (matches && matches.length > 0) {
            goalModeViolations.push({
              reviewer,
              desc,
              count: matches.length,
            });
            log.warn(`${reviewer}: ${desc} (${matches.length} 处)`);
          }
        }
      }
    }

    if (goalModeViolations.length === 0) {
      log.success('Goal mode constraint satisfied - all reviewers describe final state');
    } else {
      log.error(`${goalModeViolations.length} goal mode violations detected`);
    }

    // If goal-mode-validator.mjs exists, run it for detailed analysis
    const goalModeValidatorScript = join(SKILL_DIR, 'scripts', 'goal-mode-validator.mjs');
    if (existsSync(goalModeValidatorScript)) {
      try {
        const roundName = `round-${String(roundNumber).padStart(3, '0')}`;
        log.info(`Running goal-mode-validator for detailed analysis...`);

        const validatorOutput = execSync(
          `node "${goalModeValidatorScript}" --round ${roundName}`,
          { encoding: 'utf-8', cwd: PROJECT_ROOT, timeout: 60000 }
        );

        // Save detailed report
        const reportPath = join(roundDir, 'goal-mode-validation.md');
        writeContainedFileSync(roundDir, reportPath, `# Goal Mode Validation\n\n${validatorOutput}\n`);
        log.info(`Detailed report: ${reportPath}`);
      } catch (e) {
        // Validator exits 1 on violations - expected behavior
        if (e.stdout) {
          const reportPath = join(roundDir, 'goal-mode-validation.md');
          writeContainedFileSync(roundDir, reportPath, `# Goal Mode Validation\n\n${e.stdout}\n`);
          log.info(`Detailed report: ${reportPath}`);
        }
      }
    }
  }

  // ============================================================================
  // P2: Goal Instruction Gate - 验证生成的 goal 指令是否合规
  // ============================================================================
  let goalInstructionResult = null;
  const goalGateScript = join(SKILL_DIR, 'scripts', 'goal-instruction-gate.mjs');

  if (existsSync(goalGateScript) && existsSync(join(roundDir, 'generated-goal.md'))) {
    log.title('GOAL INSTRUCTION VALIDATION');

    try {
      const goalFile = join(roundDir, 'generated-goal.md');
      const goalText = readContainedFileSync(roundDir, goalFile, 'utf-8');

      // Run goal instruction gate
      const gateOutput = execSync(
        `node "${goalGateScript}" --file "${goalFile}"`,
        { encoding: 'utf-8', cwd: PROJECT_ROOT, timeout: 30000 }
      );

      // Parse score from output
      const plainGateOutput = gateOutput.replace(/\x1b\[[0-9;]*m/g, '');
      const scoreMatch = plainGateOutput.match(/Score:\s*(\d+)/);
      const score = scoreMatch ? parseInt(scoreMatch[1], 10) : 0;
      const passed = score >= 90 && plainGateOutput.includes('判定：合格');

      goalInstructionResult = { passed, score };

      if (passed) {
        log.success(`Goal instruction valid (${score}/100)`);
        const validationReport = join(roundDir, 'goal-instruction-validation.md');
        writeContainedFileSync(roundDir, validationReport, `# Goal Instruction Validation\n\n${gateOutput}\n`);
      } else {
        log.error(`Goal instruction invalid (${score}/100)`);
        console.log(gateOutput);

        // Save validation report
        const validationReport = join(roundDir, 'goal-instruction-validation.md');
        writeContainedFileSync(roundDir, validationReport, `# Goal Instruction Validation\n\n${gateOutput}\n`);
        log.info(`Validation report: ${validationReport}`);
      }
    } catch (e) {
      // Gate script exits 1 on validation failure
      if (e.stdout) {
        goalInstructionResult = { passed: false, score: 0 };
        log.error('Goal instruction validation failed');
        console.log(e.stdout);
      } else {
        log.warn(`Goal instruction gate error: ${e.message}`);
      }
    }
  }

  // Calculate overall status
  // SECURITY: All reviewers must be valid, have scores, and pass the 90 threshold
  // SECURITY: Evidence must pass source validation (对抗性审查)
  // SECURITY: Goal mode constraint must be satisfied (if enabled)
  // SECURITY: Goal instruction must be valid (goal 指令生成器)
  // SECURITY: Automated checks (test/typecheck) are mandatory gates, not just advisory
  const allPassed = allHaveScores && reviewers.every(r => reviewerPacketPassed(existingScores[r], minScore));

  // Automated checks must pass - test and typecheck are mandatory release gates
  const autoChecks = evidence?.automatedChecks;
  const strictProfile = ['release-gate', 'full', 'agentic-release-gate'].includes(profile);
  const testGateFailed = autoChecks?.testGate?.status !== 'pass';
  const typecheckGateFailed = autoChecks?.typecheckGate?.status !== 'pass';
  const buildGateFailed = autoChecks?.buildGate?.status !== 'pass';
  const lintGateFailed = autoChecks?.lintGate?.status !== 'pass';
  const auditGateFailed = autoChecks?.auditGate?.status !== 'pass';
  const coverageGateFailed = profile === 'agentic-release-gate' && autoChecks?.coverageGate?.status !== 'pass';
  const secretsGateFailed = autoChecks?.secrets?.status !== 'pass';
  const circularGateFailed = autoChecks?.circularDeps?.status === 'fail';
  const automatedChecksPassed = strictProfile
    ? Boolean(autoChecks) && !testGateFailed && !typecheckGateFailed && !buildGateFailed &&
      !lintGateFailed && !auditGateFailed && !coverageGateFailed && !secretsGateFailed &&
      !circularGateFailed && validateEvidence
    : Boolean(autoChecks) && !testGateFailed && !typecheckGateFailed;

  // Only P0/P1 blockers are true "redlines" - P2/P3 are suggestions, not blockers
  const vetoFindingsPresent = Object.values(existingScores).some(r =>
    r.blockers && r.blockers.some(b =>
      typeof b === 'string' ?
        /\bP0\b|\bP1\b/i.test(b) :
        (b.priority === 'P0' || b.priority === 'P1')
    )
  );
  const hasRedlines = profileConfig.gate?.fail_on_p0_p1_blockers !== false && vetoFindingsPresent;
  const hasInvalidReviewers = Object.values(existingScores).some(r => !r.isValidReviewer);
  const goalRequired = profile === 'agentic-release-gate';
  const goalInstructionValid = goalRequired ? goalInstructionResult?.passed === true : !goalInstructionResult || goalInstructionResult.passed;
  const requiredAgenticArtifacts = [
    'metadata.json', 'generated-goal.md', 'goal-instruction-validation.md',
    `phase-${roundNumber}-plan.md`, 'changes.md', 'diff-summary.md', 'risk.md', 'handoff.md',
    'evidence/automated-checks.json', 'evidence/clean-candidate.json',
  ];
  let cleanCandidateEvidenceValid = !goalRequired;
  const cleanCandidatePath = join(roundDir, 'evidence', 'clean-candidate.json');
  if (goalRequired && existsSync(cleanCandidatePath)) {
    try {
      const clean = JSON.parse(readContainedFileSync(roundDir, cleanCandidatePath, 'utf8'));
      const currentCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: PROJECT_ROOT, encoding: 'utf8' }).trim();
      const currentTree = execFileSync('git', ['rev-parse', 'HEAD^{tree}'], { cwd: PROJECT_ROOT, encoding: 'utf8' }).trim();
      cleanCandidateEvidenceValid = validateCleanCandidateEvidence(clean, currentCommit, currentTree);
    } catch {
      cleanCandidateEvidenceValid = false;
    }
  }
  const artifactCompletenessPassed = !goalRequired ||
    (requiredAgenticArtifacts.every(file => {
      try {
        readContainedFileSync(roundDir, join(roundDir, file), 'utf8');
        return true;
      } catch {
        return false;
      }
    }) && cleanCandidateEvidenceValid);
  const sensitiveArtifactFindings = allHaveScores ? scanRoundArtifacts(roundDir) : [];
  const generatedArtifactsSafe = sensitiveArtifactFindings.length === 0;
  const arbitrationEligible = !singleReviewer && excludeReviewers.length === 0;
  const gatePassed = allPassed && !hasRedlines && evidenceValidationPassed &&
                     (!checkGoalMode || goalModeViolations.length === 0) &&
                     goalInstructionValid && artifactCompletenessPassed && generatedArtifactsSafe &&
                     automatedChecksPassed && arbitrationEligible;

  // Summary
  log.title('GATE STATUS');

  // SECURITY: Block if any reviewer is invalid
  if (hasInvalidReviewers) {
    log.error('GATE BLOCKED - Invalid reviewers detected');
    for (const [reviewer, result] of Object.entries(existingScores)) {
      if (!result.isValidReviewer) {
        log.error(`  - ${reviewer}: ${result.validationError}`);
      }
    }
    generateSummary(roundDir, profile, existingScores, false, evidence);
    persistFinalArbitration(roundDir, false, 'invalid reviewer packet', reviewers);
    return false;
  }

  if (allHaveScores) {
    if (gatePassed) {
      // P4: Persistent Handoff - Write Phase boundary marker
      const currentPhase = roundNumber;
      const nextPhase = 'END (Release Complete)';
      writePhaseBoundary(roundDir, roundNumber, currentPhase, nextPhase);

      generateSummary(roundDir, profile, existingScores, true, evidence);
      generateFinalReport(roundDir, existingScores, evidence);
      const finalArtifactFindings = scanRoundArtifacts(roundDir);
      if (finalArtifactFindings.length > 0) {
        log.error(`Final artifact security scan failed: ${finalArtifactFindings.join(', ')}`);
        persistFinalArbitration(roundDir, false, 'final artifact security scan failed', reviewers);
        return false;
      }
      log.success('All gates PASSED!');
      log.success('Evidence source validation passed');
      log.success('Goal mode constraint satisfied');
      persistFinalArbitration(roundDir, true, 'all conjunctive gates passed', reviewers);
      console.log('');
      log.success('🎉 Release is ready!');
      return true;
    } else {
      log.error('GATE FAILED');
      if (testGateFailed) {
        log.error(`Automated test gate FAILED: ${autoChecks?.testGate?.output || 'tests failing'}`);
      }
      if (typecheckGateFailed) {
        log.error(`Automated typecheck gate FAILED: ${autoChecks?.typecheckGate?.output || 'type errors'}`);
      }
      if (buildGateFailed) {
        log.error(`Automated build gate FAILED: ${autoChecks?.buildGate?.output || 'build evidence missing'}`);
      }
      if (lintGateFailed) {
        log.error(`Automated lint gate FAILED: ${autoChecks?.lintGate?.output || 'lint evidence missing'}`);
      }
      if (auditGateFailed) {
        log.error(`Automated audit gate FAILED: ${autoChecks?.auditGate?.output || 'audit evidence missing'}`);
      }
      if (coverageGateFailed) {
        log.error(`Automated coverage gate FAILED: ${autoChecks?.coverageGate?.output || 'coverage evidence missing'}`);
      }
      if (circularGateFailed) {
        log.error(`Automated circular dependency scan FAILED: ${autoChecks?.circularDeps?.issues?.join(', ') || 'scan failed'}`);
      }
      if (secretsGateFailed) {
        log.error(`Automated secret scan FAILED: ${autoChecks?.secrets?.issues?.join(', ') || 'scan evidence missing'}`);
      }
      if (hasRedlines) {
        log.error('Redlines detected - blocking release');
      }
      if (!evidenceValidationPassed) {
        log.error('Evidence source validation failed - self-verification detected');
      }
      if (checkGoalMode && goalModeViolations.length > 0) {
        log.error('Goal mode constraint violated - describing implementation steps instead of final state');
      }
      if (goalInstructionResult && !goalInstructionResult.passed) {
        log.error(`Goal instruction invalid (${goalInstructionResult.score}/100) - contains plan language`);
      }
      if (!artifactCompletenessPassed) {
        log.error('Required agentic Goal, evidence, risk, and handoff artifacts are incomplete');
      }
      if (!generatedArtifactsSafe) {
        log.error(`Generated artifact security scan failed: ${sensitiveArtifactFindings.join(', ')}`);
      }
      generateSummary(roundDir, profile, existingScores, false, evidence);
      persistFinalArbitration(roundDir, false, 'one or more release gates failed', reviewers);
      return false;
    }
  } else {
    const completed = completedReviewers.length;
    const total = reviewers.length;
    console.log(`  Progress: ${completed}/${total} completed`);
    console.log('');
    log.info('To complete this review, launch these independent reviewers with the Codex/Claude host:');
    console.log('');
    for (const reviewer of pendingReviewers) {
      console.log(`  ${colors.magenta}${reviewer}${colors.reset}`);
    }
    console.log('');

    generateSummary(roundDir, profile, existingScores, false, evidence);
    persistFinalArbitration(roundDir, false, 'reviewer packets pending', reviewers);
    return false;
  }
}

// Run the gate
runGate()
  .then(passed => {
    process.exit(passed ? 0 : 1);
  })
  .catch(err => {
    log.error(`Gate error: ${err.message}`);
    process.exit(2);
  });
