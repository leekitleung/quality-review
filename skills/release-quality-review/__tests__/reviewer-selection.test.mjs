/**
 * Unit Tests for Release Quality Review Scripts
 *
 * Run with: npm test
 *
 * Tests import production code from lib/review-utils.mjs - no simplified reimplementations.
 *
 * Tests:
 * 1. parseYamlProfile - YAML profile parsing (from production code)
 * 2. parseScore - Score extraction from markdown (from production code)
 * 3. detectChangeScale - Change scale detection (from production code)
 * 4. Phase persistence functions
 * 5. parseYamlResult - result.yaml parsing (from production code)
 */

import { chmodSync, copyFileSync, readFileSync, writeFileSync, mkdirSync, existsSync, rmSync, rmdirSync, symlinkSync, mkdtempSync, cpSync } from 'fs';
import { join, relative } from 'path';
import { tmpdir, userInfo } from 'node:os';
import { fileURLToPath } from 'url';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';
import {
  parseScore,
  parseBlockers,
  parseYamlResult,
  calculateReviewerTimeout,
  detectChangeScale,
  parseYamlProfile,
  matchesTriggerConditions,
  selectReviewers,
  findTrivialVerificationScripts,
  hasConcreteVerificationOutput,
  CLEAN_CANDIDATE_COMMANDS,
  ROLLBACK_COMMANDS,
  validateCleanCandidateEvidence,
  validateRollbackEvidence,
  validateResultYamlContract,
  strictAutomatedChecksPassed,
} from '../lib/review-utils.mjs';
import {
  resolveWithinRoot,
  resolveReportDirectory,
  ensureContainedDirectorySync,
  isPathWithin,
  isRealDirectory,
  shouldIncludeCanonicalFile,
  containsSensitiveText,
  createCandidateSubprocessEnv,
  createSubprocessEnv,
  outerSandboxAttestationFromEnv,
  redactSensitiveText,
  wrapCandidateCommand,
  readContainedFileSync,
  writeContainedFileSync,
  writeContainedFile,
} from '../lib/security-utils.mjs';
import {
  extractResultScoresFromRound, persistPhasePlan, persistPhaseResult,
} from '../lib/phase-persistence.mjs';
import {
  checkFindingEvidenceBindings, checkMissingEvidenceOutput, extractCommandEvidence,
  extractFileLineReferences, extractTestOutputs,
  resolveFileReference,
} from '../lib/evidence-utils.mjs';
import { detectChangeScale as detectGateChangeScale, printScaleDetection } from '../scripts/modules/scale.mjs';
import { printHelp as printGateHelp } from '../scripts/modules/cli.mjs';
import {
  collectEvidence, formatGitEvidenceFailure, prepareTrustedAuditWorkspace,
  runAutomatedChecks, runEvidenceCommand,
} from '../scripts/modules/evidence.mjs';
import { createCandidateRuntime, validateCandidateCheckoutIdentity } from '../lib/candidate-runtime.mjs';
import {
  extractRadarCandidates, fetchRadarReviewerModel, selectRadarReviewerModel,
} from '../lib/model-selector.mjs';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const SKILL_DIR = join(__dirname, '..');
const PROJECT_ROOT = join(SKILL_DIR, '..', '..');
const TEST_ROOT = join(tmpdir(), 'release-quality-review-tests');
const TEST_DIR = join(TEST_ROOT, `${process.pid}-${randomUUID()}`);
const TEST_CODEX_MODEL = 'gpt-test-review';
const TEST_CLAUDE_MODEL = 'claude-test-review';
const ROUND_BASE = process.pid * 10;
const TEST_ROUNDS = {
  veto: ROUND_BASE + 1,
  runner: ROUND_BASE + 2,
  rehydrate: ROUND_BASE + 3,
  missingEvidence: ROUND_BASE + 4,
  parallelTimeout: ROUND_BASE + 5,
  parallelSuccess: ROUND_BASE + 6,
  evidenceForgery: ROUND_BASE + 7,
};
const reportRound = round => join(resolveReportDirectory(PROJECT_ROOT), `round-${String(round).padStart(3, '0')}`);
const runnerRound = round => {
  const dir = reportRound(round);
  const commit = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: PROJECT_ROOT, encoding: 'utf8' }).stdout.trim();
  const tree = spawnSync('git', ['rev-parse', 'HEAD^{tree}'], { cwd: PROJECT_ROOT, encoding: 'utf8' }).stdout.trim();
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'metadata.json'), JSON.stringify({
    profile: 'quick', round, collected_at: new Date().toISOString(), reviewers: ['product-flow', 'architecture-maintainer'],
    candidate_commit: commit, candidate_tree: tree, base_commit: commit, base_tree: tree,
    git: { branch: 'test', commit: commit.slice(0, 8), status: '', changedFiles: [] },
    files: {}, scale: { scale: 'none', files: 0, total: 0 },
  }));
  return dir;
};

function radarSnapshot(comparisons, updatedAt = '2026-07-17T10:00:00+08:00') {
  return { schema_version: '2.0', model_iq: { updated_at: updatedAt, comparisons } };
}

// Create test directory at module load time
mkdirSync(TEST_DIR, { recursive: true });

// ============================================================================
// Test Utilities
// ============================================================================

function createMockFs(profileName, content) {
  const mockFile = join(TEST_DIR, `${profileName}.yaml`);
  writeFileSync(mockFile, content);
  return mockFile;
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${expected}, got ${actual}`);
  }
}

function assertTrue(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function assertRejects(promise, expectedMessage) {
  let message = '';
  try {
    await promise;
  } catch (error) {
    message = error.message;
  }
  assertTrue(message.includes(expectedMessage), `Expected rejection containing ${expectedMessage}, got ${message}`);
}

function installCleanStatusGitWrapper(binDir) {
  const systemGit = spawnSync('/usr/bin/env', ['sh', '-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim();
  const wrapper = join(binDir, 'git');
  writeFileSync(wrapper, `#!/bin/sh
if [ "\$1" = "status" ] && [ "\$2" = "--short" ]; then exit 0; fi
exec ${JSON.stringify(systemGit)} "\$@"
`);
  chmodSync(wrapper, 0o755);
}

const REAL_TEST_PATH = process.env.PATH;
const CLEAN_GIT_BIN = join(TEST_DIR, 'clean-git-bin');
mkdirSync(CLEAN_GIT_BIN, { recursive: true });
installCleanStatusGitWrapper(CLEAN_GIT_BIN);
process.env.PATH = `${CLEAN_GIT_BIN}:${REAL_TEST_PATH}`;

// ============================================================================
// TESTS - parseYamlProfile (imported from production)
// ============================================================================

test.describe('conditional reviewer triggers', () => {
  test('triggers from diff content patterns when file globs do not match', () => {
    assertEqual(matchesTriggerConditions(
      ['README.md'],
      '+ const credential = input;',
      { files: ['**/auth/**'], patterns: ['credential'] }
    ), true);
  });

  test('anchors glob patterns to the full path', () => {
    assertEqual(matchesTriggerConditions(
      ['not-components/file.ts'],
      '',
      { files: ['**/components/**'], patterns: [] }
    ), false);
  });

  test('matches globstar directories at the repository root', () => {
    assertEqual(matchesTriggerConditions(
      ['scripts/sync-skills.mjs'],
      '',
      { files: ['**/scripts/**'], patterns: [] }
    ), true);
  });

  test('selects agentic reviewers from the candidate diff without self-review expansion', () => {
    const profile = parseYamlProfile(
      readFileSync(join(SKILL_DIR, 'profiles', 'agentic-release-gate.yaml'), 'utf8'),
      'agentic-release-gate',
    );
    const selection = selectReviewers(profile, ['README.md'], '+ Update installation docs');

    assertEqual(selection.reviewers.length, 9);
    assertEqual(JSON.stringify(selection.triggeredConditional), JSON.stringify(['zero-doc-user']));
    assertTrue(!selection.reviewers.includes('native-designer'), 'README must not trigger native-designer');
    for (const reviewer of profile.adversarial_reviewers) {
      assertTrue(selection.reviewers.includes(reviewer), `${reviewer} must be required`);
    }
  });

  test('triggers each agentic conditional reviewer for its declared risk surface', () => {
    const profile = parseYamlProfile(
      readFileSync(join(SKILL_DIR, 'profiles', 'agentic-release-gate.yaml'), 'utf8'),
      'agentic-release-gate',
    );
    const cases = [
      { reviewer: 'terminal-veteran', files: ['skills/example/scripts/run.mjs'], diff: '' },
      { reviewer: 'native-designer', files: ['apps/ui/panel.tsx'], diff: '' },
      { reviewer: 'data-security', files: ['lib/worker.js'], diff: '+ enforce sandbox permission' },
      { reviewer: 'zero-doc-user', files: ['skills/example/SKILL.md'], diff: '' },
    ];

    for (const item of cases) {
      const selection = selectReviewers(profile, item.files, item.diff);
      assertTrue(selection.triggeredConditional.includes(item.reviewer), `${item.reviewer} should trigger`);
    }
  });

  test('can select all 12 agentic reviewers when every risk surface is present', () => {
    const profile = parseYamlProfile(
      readFileSync(join(SKILL_DIR, 'profiles', 'agentic-release-gate.yaml'), 'utf8'),
      'agentic-release-gate',
    );
    const selection = selectReviewers(
      profile,
      ['README.md', 'apps/ui/panel.tsx', 'scripts/release.mjs', 'lib/security-utils.mjs'],
      '+ enforce sandbox permission',
    );
    assertEqual(selection.reviewers.length, 12);
    assertEqual(selection.triggeredConditional.length, 4);
  });

  test('rejects a conditional reviewer without an explicit trigger contract', () => {
    let error = null;
    try {
      selectReviewers({
        name: 'invalid-profile',
        resident_reviewers: ['product-flow'],
        conditional_reviewers: ['terminal-veteran'],
        adversarial_reviewers: [],
        trigger_conditions: {},
        gate: {},
      });
    } catch (caught) {
      error = caught;
    }
    assertTrue(error instanceof Error, 'Missing trigger contract must throw');
    assertTrue(error.message.includes('terminal-veteran'), 'Error must name the invalid reviewer');
  });

  test('keeps every real profile valid and preserves its baseline reviewer count', () => {
    const expectedCounts = {
      quick: 2,
      default: 2,
      'release-gate': 4,
      full: 8,
      'agentic-release-gate': 8,
    };
    for (const [profileName, expectedCount] of Object.entries(expectedCounts)) {
      const parsed = parseYamlProfile(
        readFileSync(join(SKILL_DIR, 'profiles', `${profileName}.yaml`), 'utf8'),
        profileName,
      );
      assertEqual(selectReviewers(parsed).reviewers.length, expectedCount, `${profileName} baseline count`);
    }
  });

  test('uses the shared reviewer selector in both runner and gate', () => {
    const runner = readFileSync(join(SKILL_DIR, 'scripts', 'review-runner.mjs'), 'utf8');
    const runnerPlan = readFileSync(join(SKILL_DIR, 'scripts', 'modules', 'runner-review-plan.mjs'), 'utf8');
    const gate = readFileSync(join(SKILL_DIR, 'scripts', 'review-gate.mjs'), 'utf8');
    const gateSelection = readFileSync(join(SKILL_DIR, 'scripts', 'modules', 'gate-reviewer-selection.mjs'), 'utf8');
    assertTrue(runnerPlan.includes('selectReviewers('), 'Runner must use shared selection');
    assertTrue(gate.includes('selectGateReviewers('), 'Gate must delegate reviewer selection');
    assertTrue(gateSelection.includes('selectReviewers('), 'Gate selection must use shared selection');
    assertTrue(!runner.includes('function detectConditionalReviewers('), 'Runner must not retain divergent selection');
    assertTrue(runnerPlan.includes('detectChangeScale, selectReviewers'),
      'Runner must import canonical change-scale detection');
    assertTrue(!runnerPlan.includes('function detectChangeScale(evidence)'),
      'Runner must not retain divergent change-scale thresholds');
  });

  test('runner and gate dry runs select the same reviewers for the current diff', () => {
    const env = { ...process.env, NO_COLOR: '1' };
    const runner = spawnSync('node', [
      join(SKILL_DIR, 'scripts', 'review-runner.mjs'),
      '--profile', 'agentic-release-gate', '--dry-run', '--base', 'HEAD',
    ], { cwd: PROJECT_ROOT, encoding: 'utf8', env });
    const gate = spawnSync('node', [
      join(SKILL_DIR, 'scripts', 'review-gate.mjs'),
      '--profile', 'agentic-release-gate', '--dry-run', '--base', 'HEAD',
    ], { cwd: PROJECT_ROOT, encoding: 'utf8', env });
    assertEqual(runner.status, 0, `Runner dry run failed: ${runner.stderr}`);
    assertEqual(gate.status, 0, `Gate dry run failed: ${gate.stderr}`);

    const runnerBlock = runner.stdout.split('Selected reviewers:')[1].split('Dry run complete')[0];
    const runnerReviewers = [...runnerBlock.matchAll(/^\s+✓\s+([a-z0-9-]+)$/gm)].map(match => match[1]);
    const gateLine = gate.stdout.split('\n').find(line => line.startsWith('ℹ Reviewers: '));
    const gateReviewers = gateLine.slice('ℹ Reviewers: '.length).split(', ');
    assertEqual(JSON.stringify(runnerReviewers), JSON.stringify(gateReviewers));
  });

  test('runner self-review dry run does not expand agentic selection to all 12 reviewers', () => {
    const runner = spawnSync('node', [
      join(SKILL_DIR, 'scripts', 'review-runner.mjs'),
      '--profile', 'agentic-release-gate', '--target', 'skills/release-quality-review',
      '--dry-run', '--base', 'HEAD',
    ], { cwd: PROJECT_ROOT, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' } });
    assertEqual(runner.status, 0, `Runner self-review dry run failed: ${runner.stderr}`);
    const selectedBlock = runner.stdout.split('Selected reviewers:')[1].split('Dry run complete')[0];
    const selected = [...selectedBlock.matchAll(/^\s+✓\s+([a-z0-9-]+)$/gm)].map(match => match[1]);
    assertTrue(selected.length < 12, `Self-review unexpectedly selected all reviewers: ${selected.join(', ')}`);
    assertTrue(!selected.includes('native-designer'), 'Non-UI skill self-review must not trigger native-designer');
  });
});

process.on('exit', () => {
  try { rmSync(TEST_DIR, { recursive: true }); rmdirSync(TEST_ROOT); } catch { /* shared worker cleanup */ }
});
