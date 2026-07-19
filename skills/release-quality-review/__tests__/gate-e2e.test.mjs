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
import { basename, join, relative } from 'path';
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
const reviewerSandboxDir = (round, reviewer) => join(
  resolveReportDirectory(PROJECT_ROOT), '.reviewer-sandboxes', basename(round), reviewer,
);
const runnerRound = round => {
  const dir = reportRound(round);
  const commit = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: PROJECT_ROOT, encoding: 'utf8' }).stdout.trim();
  const tree = spawnSync('git', ['rev-parse', 'HEAD^{tree}'], { cwd: PROJECT_ROOT, encoding: 'utf8' }).stdout.trim();
  const baseCommit = spawnSync('git', ['rev-parse', 'HEAD~1'], { cwd: PROJECT_ROOT, encoding: 'utf8' }).stdout.trim();
  const baseTree = spawnSync('git', ['rev-parse', 'HEAD~1^{tree}'], { cwd: PROJECT_ROOT, encoding: 'utf8' }).stdout.trim();
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'metadata.json'), JSON.stringify({
    profile: 'quick', round, collected_at: new Date().toISOString(), reviewers: ['product-flow', 'architecture-maintainer'],
    candidate_commit: commit, candidate_tree: tree, base_commit: baseCommit, base_tree: baseTree,
    git: { branch: 'test', commit: commit.slice(0, 8), status: '', changedFiles: [] },
    files: {}, scale: { scale: 'none', files: 0, total: 0 },
  }));
  mkdirSync(join(dir, 'evidence'), { recursive: true });
  writeFileSync(join(dir, 'evidence', 'automated-checks.json'), JSON.stringify({
    testGate: { command: 'npm test', status: 'pass', exit_code: 0, output: '# tests 1\n# pass 1\n# fail 0' },
    typecheckGate: { command: 'npm run typecheck', status: 'pass', exit_code: 0, output: 'node --check scripts/review-gate.mjs' },
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

test.describe('CLI fail-closed integration', () => {
  test('E2E normal runner workflow writes every prompt and metadata without crashing', () => {
    const roundNumber = TEST_ROUNDS.runner;
    const round = runnerRound(roundNumber);
    const fakeBin = join(TEST_DIR, 'fake-bin-runner');
    const reviewerReportDirMarker = join(reviewerSandboxDir(round, 'product-flow'), 'reviewer-report-dir');
    try {
      mkdirSync(fakeBin);
      const fakeCodex = join(fakeBin, 'codex');
      writeFileSync(fakeCodex, `#!/usr/bin/env node
if (process.argv.includes('--help')) process.exit(0);
if (!process.argv.includes('exec')) process.exit(3);
const modelIndex = process.argv.indexOf('--model');
if (modelIndex < 0 || process.argv[modelIndex + 1] !== ${JSON.stringify(TEST_CODEX_MODEL)}) process.exit(4);
process.getBuiltinModule('node:fs').writeFileSync(
  process.getBuiltinModule('node:path').join(process.env.RELEASE_QUALITY_REPORT_DIR, 'reviewer-report-dir'),
  process.env.RELEASE_QUALITY_REPORT_DIR || '',
);
console.log('review completed');
`);
      chmodSync(fakeCodex, 0o755);
      const result = spawnSync('node', [
        join(SKILL_DIR, 'scripts', 'review-runner.mjs'), '--profile', 'quick',
        '--agent', 'codex', '--model', TEST_CODEX_MODEL,
        '--round', String(roundNumber), '--skip-evidence',
      ], {
        cwd: PROJECT_ROOT,
        encoding: 'utf8',
        timeout: 30000,
        env: {
          ...process.env,
          PATH: `${fakeBin}:${process.env.PATH}`,
          RELEASE_QUALITY_REVIEWER_RETRY_MAX: '0',
          RELEASE_QUALITY_REVIEWER_START_DELAY_MS: '1',
        },
      });
      assertEqual(result.status, 5, `Expected malformed reviewer failure, output: ${result.stdout}${result.stderr}`);
      assertEqual(result.stderr.includes('results is not defined'), false);
      assertEqual(existsSync(join(round, 'runner-metadata.json')), true);
      assertEqual(existsSync(join(round, 'product-flow', 'prompt.md')), true);
      assertEqual(existsSync(join(round, 'architecture-maintainer', 'prompt.md')), true);
      const isolatedReportDir = readFileSync(reviewerReportDirMarker, 'utf8');
      assertTrue(isolatedReportDir.includes('.reviewer-sandboxes'), isolatedReportDir);
      assertEqual(isolatedReportDir.includes(`round-${String(roundNumber).padStart(3, '0')}/`), true);
      assertEqual(
        JSON.stringify(JSON.parse(readFileSync(join(round, 'review-backend.json'), 'utf8'))),
        JSON.stringify({
          backend: 'codex', model: TEST_CODEX_MODEL, reasoning_effort: null,
          selection: { mode: 'explicit', selected_by: 'user' },
        }),
      );
      const runnerMetadata = JSON.parse(readFileSync(join(round, 'runner-metadata.json'), 'utf8'));
      assertEqual(runnerMetadata.reviewBackend, 'codex');
      assertEqual(runnerMetadata.reviewModel, TEST_CODEX_MODEL);
      assertEqual(runnerMetadata.reviewReasoningEffort, null);
      assertEqual(runnerMetadata.modelSelection.mode, 'explicit');
      const prompt = readFileSync(join(round, 'product-flow', 'prompt.md'), 'utf8');
      assertTrue(prompt.includes('review_backend: codex'));
      assertTrue(prompt.includes(`review_model: ${TEST_CODEX_MODEL}`));
      const lockedResume = spawnSync('node', [
        join(SKILL_DIR, 'scripts', 'review-runner.mjs'), '--profile', 'quick', '--dry-run',
        '--agent', 'codex', '--round', String(roundNumber), '--skip-evidence',
      ], { cwd: PROJECT_ROOT, encoding: 'utf8', timeout: 30000 });
      assertEqual(lockedResume.status, 0, `${lockedResume.stdout}${lockedResume.stderr}`);
      assertTrue(lockedResume.stdout.includes(`explicit -> ${TEST_CODEX_MODEL}`),
        'Omitted model must reuse the existing round lock without Radar');
      writeFileSync(join(round, 'review-backend.json'), JSON.stringify({ backend: 'codex' }));
      const legacyLock = spawnSync('node', [
        join(SKILL_DIR, 'scripts', 'review-runner.mjs'), '--profile', 'quick',
        '--agent', 'codex', '--model', TEST_CODEX_MODEL,
        '--round', String(roundNumber), '--skip-evidence',
      ], {
        cwd: PROJECT_ROOT,
        encoding: 'utf8',
        timeout: 30000,
        env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH}` },
      });
      assertEqual(legacyLock.status, 4, `${legacyLock.stdout}${legacyLock.stderr}`);
      assertTrue(legacyLock.stderr.includes('invalid review backend lock'));
      writeFileSync(join(round, 'review-backend.json'), JSON.stringify({ backend: 'codex', model: TEST_CODEX_MODEL }));
      const rerun = spawnSync('node', [
        join(SKILL_DIR, 'scripts', 'review-runner.mjs'), '--profile', 'quick',
        '--agent', 'codex', '--model', TEST_CODEX_MODEL,
        '--round', String(roundNumber), '--skip-evidence',
      ], {
        cwd: PROJECT_ROOT,
        encoding: 'utf8',
        timeout: 30000,
        env: {
          ...process.env,
          PATH: `${fakeBin}:${process.env.PATH}`,
          RELEASE_QUALITY_REVIEWER_RETRY_MAX: '0',
          RELEASE_QUALITY_REVIEWER_START_DELAY_MS: '1',
        },
      });
      assertEqual(rerun.status, 5);
      assertTrue(rerun.stdout.includes('invalidating stale artifacts'), 'Malformed packet must be relaunched');
      assertEqual(rerun.stdout.includes('validated resume'), false, 'Malformed packet must never be resumed');

      const modelDrift = spawnSync('node', [
        join(SKILL_DIR, 'scripts', 'review-runner.mjs'), '--profile', 'quick',
        '--agent', 'codex', '--model', 'gpt-different-review',
        '--round', String(roundNumber), '--skip-evidence',
      ], {
        cwd: PROJECT_ROOT,
        encoding: 'utf8',
        timeout: 30000,
        env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH}` },
      });
      assertEqual(modelDrift.status, 4, `${modelDrift.stdout}${modelDrift.stderr}`);
      assertTrue(modelDrift.stderr.includes(`round model is locked to ${TEST_CODEX_MODEL}`));

      const fakeClaude = join(fakeBin, 'claude');
      writeFileSync(fakeClaude, `#!/usr/bin/env node
if (process.argv.includes('--help') || process.argv.includes('--version')) process.exit(0);
process.exit(3);
`);
      chmodSync(fakeClaude, 0o755);
      const mixedBackend = spawnSync('node', [
        join(SKILL_DIR, 'scripts', 'review-runner.mjs'), '--profile', 'quick',
        '--agent', 'claude', '--model', TEST_CLAUDE_MODEL,
        '--round', String(roundNumber), '--skip-evidence',
      ], {
        cwd: PROJECT_ROOT,
        encoding: 'utf8',
        timeout: 30000,
        env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH}` },
      });
      assertEqual(mixedBackend.status, 4, `Expected backend-mixing rejection: ${mixedBackend.stdout}${mixedBackend.stderr}`);
      assertTrue(mixedBackend.stderr.includes('round backend is locked to codex, cannot use claude'));
    } finally {
      rmSync(round, { recursive: true, force: true });
    }
  });

  test('E2E agentic skip-evidence preserves candidate-bound phase scope', () => {
    const roundNumber = TEST_ROUNDS.runner + 200;
    const round = reportRound(roundNumber);
    const fakeBin = join(TEST_DIR, 'fake-bin-agentic-scope');
    const reviewerDir = reviewerSandboxDir(round, 'product-flow');
    const candidateCommit = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: PROJECT_ROOT, encoding: 'utf8' }).stdout.trim();
    const candidateTree = spawnSync('git', ['rev-parse', 'HEAD^{tree}'], { cwd: PROJECT_ROOT, encoding: 'utf8' }).stdout.trim();
    try {
      mkdirSync(fakeBin);
      installCleanStatusGitWrapper(fakeBin);
      mkdirSync(round, { recursive: true });
      writeFileSync(join(round, 'metadata.json'), JSON.stringify({
        profile: 'agentic-release-gate', round: roundNumber, collected_at: new Date().toISOString(),
        reviewers: ['product-flow'],
        git: { branch: 'test', commit: candidateCommit.slice(0, 8), status: '', diff: '+ changed\n- old', changedFiles: ['a.mjs', 'b.mjs'] },
        files: {}, scale: { scale: 'small', files: 2, additions: 1, deletions: 1, total: 2 },
        candidate_commit: candidateCommit, candidate_tree: candidateTree,
        base_commit: candidateCommit, base_tree: candidateTree,
      }));
      mkdirSync(join(round, 'evidence'), { recursive: true });
      writeFileSync(join(round, 'evidence', 'automated-checks.json'), JSON.stringify({
        testGate: { command: 'npm test', status: 'pass', exit_code: 0, output: '# tests 1\n# pass 1\n# fail 0' },
      }));
      for (const file of ['generated-goal.md', 'changes.md', 'diff-summary.md', 'risk.md', 'handoff.md']) {
        writeFileSync(join(round, file), `# ${file}\n`);
      }
      const fakeCodex = join(fakeBin, 'codex');
      writeFileSync(fakeCodex, `#!/usr/bin/env node
if (process.argv.includes('--help') || process.argv.includes('--version')) process.exit(0);
const fs = process.getBuiltinModule('node:fs');
fs.mkdirSync(${JSON.stringify(reviewerDir)}, { recursive: true });
fs.writeFileSync(${JSON.stringify(join(reviewerDir, 'result.yaml'))}, 'reviewer: product-flow\\nprofile: agentic-release-gate\\nround: ${roundNumber}\\ncandidate_commit: ${candidateCommit}\\ncandidate_tree: ${candidateTree}\\nscore: 95\\nstatus: pass\\nreview_backend: codex\\nreview_model: ${TEST_CODEX_MODEL}\\nblockers: []\\nredlines: []\\n');
fs.writeFileSync(${JSON.stringify(join(reviewerDir, 'score.md'))}, '# Score\\n\\n## Overall Score: 95/100\\nCommand: npm test\\nExit code: 0\\nOutput: # tests 1; # pass 1; # fail 0\\n');
fs.writeFileSync(${JSON.stringify(join(reviewerDir, 'blockers.md'))}, '# Blockers\\n\\nNo P0/P1 blockers.\\n');
fs.writeFileSync(${JSON.stringify(join(reviewerDir, 'improvement-list.md'))}, '# Improvements\\n');
`);
      chmodSync(fakeCodex, 0o755);
      const result = spawnSync('node', [
        join(SKILL_DIR, 'scripts', 'review-runner.mjs'), '--profile', 'agentic-release-gate',
        '--agent', 'codex', '--model', TEST_CODEX_MODEL,
        '--reviewer', 'product-flow', '--round', String(roundNumber),
        '--base', candidateCommit, '--skip-evidence',
      ], {
        cwd: PROJECT_ROOT, encoding: 'utf8', timeout: 10000,
        env: {
          ...process.env, PATH: `${fakeBin}:${process.env.PATH}`,
          RELEASE_QUALITY_OUTER_SANDBOX_ATTESTED: '1', RELEASE_QUALITY_REVIEWER_RETRY_MAX: '0',
        },
      });
      assertEqual(result.status, 1, `${result.stdout}${result.stderr}`);
      const plan = readFileSync(join(round, `phase-${roundNumber}-plan.md`), 'utf8');
      assertTrue(plan.includes('small (2 files, 2 lines)'));
      assertTrue(plan.includes('Changed files:** 2'));
      assertTrue(plan.includes(`Git commit:** ${candidateCommit.slice(0, 8)}`));
      const boundMetadata = JSON.parse(readFileSync(join(round, 'metadata.json'), 'utf8'));
      assertEqual(boundMetadata.review_backend, 'codex');
      assertEqual(boundMetadata.review_model, TEST_CODEX_MODEL);
    } finally {
      rmSync(round, { recursive: true, force: true });
    }
  });

  test('agentic runner rejects missing delivery artifacts before Agent launch', () => {
    const roundNumber = TEST_ROUNDS.runner + 250;
    const round = reportRound(roundNumber);
    const fakeBin = join(TEST_DIR, `fake-bin-agentic-preflight-${randomUUID()}`);
    const marker = join(TEST_DIR, `agent-launched-${randomUUID()}`);
    try {
      mkdirSync(fakeBin, { recursive: true });
      const fakeCodex = join(fakeBin, 'codex');
      writeFileSync(fakeCodex, `#!/usr/bin/env node
if (process.argv.includes('--version') || process.argv.includes('--help')) process.exit(0);
require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'launched');
`);
      chmodSync(fakeCodex, 0o755);
      const result = spawnSync(process.execPath, [
        join(SKILL_DIR, 'scripts', 'review-runner.mjs'), '--profile', 'agentic-release-gate',
        '--agent', 'codex', '--model', TEST_CODEX_MODEL,
        '--round', String(roundNumber), '--skip-evidence',
      ], {
        cwd: PROJECT_ROOT, encoding: 'utf8', timeout: 10000,
        env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH}` },
      });
      assertEqual(result.status, 4, `${result.stdout}${result.stderr}`);
      assertTrue(result.stderr.includes('must exist before reviewer launch'));
      assertEqual(existsSync(marker), false, 'Agent must not launch before artifact preflight');
    } finally {
      rmSync(round, { recursive: true, force: true });
    }
  });

  test('E2E no-collect rehydrates matching evidence and quick final report avoids agentic claims', () => {
    const roundNumber = TEST_ROUNDS.rehydrate;
    const round = reportRound(roundNumber);
    const finalReport = join(round, 'final-report.md');
    const commit = spawnSync('git', ['rev-parse', '--short=8', 'HEAD'], { cwd: PROJECT_ROOT, encoding: 'utf8' }).stdout.trim();
    const fullCommit = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: PROJECT_ROOT, encoding: 'utf8' }).stdout.trim();
    const tree = spawnSync('git', ['rev-parse', 'HEAD^{tree}'], { cwd: PROJECT_ROOT, encoding: 'utf8' }).stdout.trim();
    const status = spawnSync('git', ['status', '--short'], { cwd: PROJECT_ROOT, encoding: 'utf8' }).stdout.trim();
    const fakeBin = join(TEST_DIR, `fake-bin-rehydrate-${randomUUID()}`);
    const originalPath = process.env.PATH;
    try {
      mkdirSync(fakeBin);
      installCleanStatusGitWrapper(fakeBin);
      process.env.PATH = `${fakeBin}:${originalPath}`;
      for (const reviewer of ['product-flow', 'architecture-maintainer']) {
        const dir = join(round, reviewer);
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, 'result.yaml'), `reviewer: ${reviewer}\nprofile: quick\nround: ${roundNumber}\ncandidate_commit: ${fullCommit}\ncandidate_tree: ${tree}\nscore: 95\nstatus: pass\nreview_backend: codex\nreview_model: ${TEST_CODEX_MODEL}\nblockers: []\nredlines: []\n`);
        writeFileSync(join(dir, 'score.md'), `# ${reviewer}\n\n## Overall Score: 95/100\n`);
        writeFileSync(join(dir, 'blockers.md'), '# Blockers\n\nNo P0/P1 blockers.\n');
        writeFileSync(join(dir, 'improvement-list.md'), '# Improvements\n');
      }
      mkdirSync(join(round, 'evidence'), { recursive: true });
      const commandRecord = (command, statusValue, exitCode, output) => ({
        command, started_at: new Date().toISOString(), finished_at: new Date().toISOString(),
        status: statusValue, exit_code: exitCode, output, output_bytes: Buffer.byteLength(output), truncated: false,
      });
      const testCheck = commandRecord('npm test', 'pass', 0, '# tests 1\n# fail 0');
      const typecheckCheck = commandRecord('npm run typecheck', 'pass', 0, 'passed');
      const checkoutIdentity = { commit: fullCommit, tree, status: '' };
      const automatedContent = JSON.stringify({
        testGate: testCheck, typecheckGate: typecheckCheck,
        buildGate: commandRecord('npm run build', 'fail', 1, 'optional failure'),
        lintGate: commandRecord('npm run lint', 'fail', 1, 'optional failure'),
        auditGate: commandRecord('npm audit --audit-level=high', 'fail', 1, 'optional failure'),
        secrets: { status: 'fail', issues: ['optional scan failure'] }, oversizedFiles: { status: 'pass', issues: [] },
        circularDeps: { status: 'pass', issues: [] },
        candidateCheckout: {
          status: 'pass', source_commit: fullCommit, source_tree: tree,
          initial: checkoutIdentity, final: checkoutIdentity,
        },
      });
      writeFileSync(join(round, 'evidence', 'automated-checks.json'), automatedContent);
      writeFileSync(join(round, 'metadata.json'), JSON.stringify({
        profile: 'quick', round: roundNumber, collected_at: new Date().toISOString(),
        git: { commit, status, branch: 'test', changedFiles: ['README.md'] }, files: {},
        scale: { scale: 'micro', files: 1, total: 2 },
        candidate_commit: fullCommit, candidate_tree: tree,
        review_backend: 'codex', review_model: TEST_CODEX_MODEL,
        base_commit: fullCommit, base_tree: tree,
        automated_checks_sha256: createHash('sha256').update(automatedContent).digest('hex'),
      }));
      writeFileSync(join(round, 'review-backend.json'), JSON.stringify({ backend: 'codex', model: TEST_CODEX_MODEL }));
      const result = spawnSync('node', [
        join(SKILL_DIR, 'scripts', 'review-gate.mjs'), '--profile', 'quick', '--round', String(roundNumber),
        '--no-collect', '--no-validate-evidence',
      ], { cwd: PROJECT_ROOT, encoding: 'utf8', env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH}` } });
      assertEqual(result.status, 0, `Expected no-collect pass, output: ${result.stdout}${result.stderr}`);
      assertTrue(result.stdout.includes('Loaded persisted automated evidence'), 'Expected persisted evidence rehydration');
      assertEqual(existsSync(join(round, `phase-${roundNumber}-plan.md`)), true, 'Expected Gate-owned phase plan');
      const phasePlan = readFileSync(join(round, `phase-${roundNumber}-plan.md`), 'utf8');
      assertTrue(phasePlan.includes('micro (1 files, 2 lines)'), 'Phase plan must preserve persisted scale');
      assertTrue(phasePlan.includes('Changed files:** 1'), 'Phase plan must preserve persisted changed-file count');
      const report = readFileSync(finalReport, 'utf8');
      assertEqual(report.includes('Clean-candidate verification passed'), false);
      assertEqual(report.includes('Goal instruction validation passed'), false);
      assertEqual(report.includes('Build, lint, audit'), false);

      const identityPacket = join(round, 'product-flow', 'result.yaml');
      const identityPacketContent = readFileSync(identityPacket, 'utf8');
      writeFileSync(identityPacket, identityPacketContent.replace(TEST_CODEX_MODEL, 'gpt-forged-review'));
      const packetModelMismatch = spawnSync('node', [
        join(SKILL_DIR, 'scripts', 'review-gate.mjs'), '--profile', 'quick', '--round', String(roundNumber),
        '--no-collect', '--no-validate-evidence',
      ], { cwd: PROJECT_ROOT, encoding: 'utf8' });
      assertEqual(packetModelMismatch.status, 1);
      assertTrue(packetModelMismatch.stdout.includes('Review model mismatch'));
      writeFileSync(identityPacket, identityPacketContent);

      const identityMetadataPath = join(round, 'metadata.json');
      const identityMetadata = JSON.parse(readFileSync(identityMetadataPath, 'utf8'));
      writeFileSync(identityMetadataPath, JSON.stringify({ ...identityMetadata, review_model: 'gpt-forged-review' }));
      const metadataModelMismatch = spawnSync('node', [
        join(SKILL_DIR, 'scripts', 'review-gate.mjs'), '--profile', 'quick', '--round', String(roundNumber),
        '--no-collect', '--no-validate-evidence',
      ], { cwd: PROJECT_ROOT, encoding: 'utf8' });
      assertEqual(metadataModelMismatch.status, 1);
      assertTrue(metadataModelMismatch.stdout.includes('Review backend/model identity'));
      writeFileSync(identityMetadataPath, JSON.stringify(identityMetadata));

      const selection = { mode: 'radar-lightweight-qualified', observed_iq: 120 };
      writeFileSync(join(round, 'review-backend.json'), JSON.stringify({
        backend: 'codex', model: TEST_CODEX_MODEL, reasoning_effort: 'low', selection,
      }));
      writeFileSync(identityMetadataPath, JSON.stringify({
        ...identityMetadata, review_reasoning_effort: 'high', model_selection: selection,
      }));
      const effortMismatch = spawnSync('node', [
        join(SKILL_DIR, 'scripts', 'review-gate.mjs'), '--profile', 'quick', '--round', String(roundNumber),
        '--no-collect', '--no-validate-evidence',
      ], { cwd: PROJECT_ROOT, encoding: 'utf8' });
      assertEqual(effortMismatch.status, 1);
      assertTrue(effortMismatch.stdout.includes('Review backend/model identity'));
      writeFileSync(join(round, 'review-backend.json'), JSON.stringify({ backend: 'codex', model: TEST_CODEX_MODEL }));
      writeFileSync(identityMetadataPath, JSON.stringify(identityMetadata));

      rmSync(finalReport, { force: true });
      mkdirSync(finalReport);
      const unwritableFinal = spawnSync('node', [
        join(SKILL_DIR, 'scripts', 'review-gate.mjs'), '--profile', 'quick', '--round', String(roundNumber),
        '--no-collect', '--no-validate-evidence',
      ], { cwd: PROJECT_ROOT, encoding: 'utf8' });
      assertTrue(unwritableFinal.status !== 0, 'Expected final report persistence failure');
      const arbitration = JSON.parse(readFileSync(join(round, 'evidence', 'final-arbitration.json'), 'utf8'));
      assertTrue(arbitration.status !== 'pass', 'Pass arbitration must not precede durable final artifacts');
      rmSync(finalReport, { recursive: true, force: true });

      const packetPath = join(round, 'product-flow', 'result.yaml');
      const packetContent = readFileSync(packetPath, 'utf8');
      const substitutedPacket = join(TEST_DIR, 'substituted-result.yaml');
      writeFileSync(substitutedPacket, packetContent);
      rmSync(packetPath);
      symlinkSync(substitutedPacket, packetPath);
      const packetSymlink = spawnSync('node', [
        join(SKILL_DIR, 'scripts', 'review-gate.mjs'), '--profile', 'quick', '--round', String(roundNumber),
        '--no-collect', '--no-validate-evidence',
      ], { cwd: PROJECT_ROOT, encoding: 'utf8' });
      assertEqual(packetSymlink.status, 1);
      assertTrue(packetSymlink.stdout.includes('Invalid reviewers detected'), 'Expected symlinked packet rejection');
      rmSync(packetPath);
      writeFileSync(packetPath, packetContent);

      const improvementPath = join(round, 'product-flow', 'improvement-list.md');
      const improvementContent = readFileSync(improvementPath, 'utf8');
      const secretCanary = ['ghp', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ1234'].join('_');
      writeFileSync(improvementPath, `${improvementContent}\n${secretCanary}\n`);
      const sensitivePacket = spawnSync('node', [
        join(SKILL_DIR, 'scripts', 'review-gate.mjs'), '--profile', 'quick', '--round', String(roundNumber),
        '--no-collect', '--no-validate-evidence',
      ], { cwd: PROJECT_ROOT, encoding: 'utf8' });
      assertEqual(sensitivePacket.status, 1);
      assertTrue(sensitivePacket.stdout.includes('Generated artifact security scan failed'),
        'Expected sensitive reviewer packet rejection');
      assertEqual(sensitivePacket.stdout.includes(secretCanary), false, 'Gate diagnostics must not echo detected secrets');
      writeFileSync(improvementPath, improvementContent);

      writeFileSync(join(round, 'evidence', 'automated-checks.json'), `${automatedContent} `);
      const substituted = spawnSync('node', [
        join(SKILL_DIR, 'scripts', 'review-gate.mjs'), '--profile', 'quick', '--round', String(roundNumber),
        '--no-collect', '--no-validate-evidence',
      ], { cwd: PROJECT_ROOT, encoding: 'utf8' });
      // With fallback logic, invalid evidence triggers re-collection instead of fail-closed
      assertTrue(substituted.stdout.includes('Persisted evidence is invalid') || substituted.stdout.includes('Re-collecting'),
        'Expected evidence invalid warning or re-collection message');

      const contradictory = JSON.parse(automatedContent);
      contradictory.testGate.exit_code = 1;
      const contradictoryContent = JSON.stringify(contradictory);
      writeFileSync(join(round, 'evidence', 'automated-checks.json'), contradictoryContent);
      const reboundMetadata = JSON.parse(readFileSync(join(round, 'metadata.json'), 'utf8'));
      reboundMetadata.automated_checks_sha256 = createHash('sha256').update(contradictoryContent).digest('hex');
      writeFileSync(join(round, 'metadata.json'), JSON.stringify(reboundMetadata));
      const contradictoryResult = spawnSync('node', [
        join(SKILL_DIR, 'scripts', 'review-gate.mjs'), '--profile', 'quick', '--round', String(roundNumber),
        '--no-collect', '--no-validate-evidence',
      ], { cwd: PROJECT_ROOT, encoding: 'utf8' });
      assertEqual(contradictoryResult.status, 1);
      assertTrue(contradictoryResult.stdout.includes('invalid testGate command evidence'), 'Expected pass/nonzero contradiction to fail closed');

      const alteredCheckout = JSON.parse(automatedContent);
      alteredCheckout.candidateCheckout.final.status = ' M package.json';
      const alteredCheckoutContent = JSON.stringify(alteredCheckout);
      writeFileSync(join(round, 'evidence', 'automated-checks.json'), alteredCheckoutContent);
      reboundMetadata.automated_checks_sha256 = createHash('sha256').update(alteredCheckoutContent).digest('hex');
      writeFileSync(join(round, 'metadata.json'), JSON.stringify(reboundMetadata));
      const alteredCheckoutResult = spawnSync('node', [
        join(SKILL_DIR, 'scripts', 'review-gate.mjs'), '--profile', 'quick', '--round', String(roundNumber),
        '--no-collect', '--no-validate-evidence',
      ], { cwd: PROJECT_ROOT, encoding: 'utf8' });
      assertEqual(alteredCheckoutResult.status, 1);
      assertTrue(alteredCheckoutResult.stdout.includes('invalid automated verification checkout evidence'),
        'Expected altered checkout identity to fail closed');
    } finally {
      process.env.PATH = originalPath;
      rmSync(round, { recursive: true, force: true });
    }
  });

  test('E2E rejects stale reviewer packets when the candidate changes in the same round', () => {
    const cloneRoot = join(TEST_DIR, 'candidate-drift-clone');
    const roundNumber = 991;
    const round = join(cloneRoot, 'quality-reports', `round-${String(roundNumber).padStart(3, '0')}`);
    try {
      const cloned = spawnSync('git', ['clone', '--quiet', '--no-local', PROJECT_ROOT, cloneRoot], {
        cwd: TEST_DIR, encoding: 'utf8', timeout: 30000,
      });
      assertEqual(cloned.status, 0, `Expected fixture clone, output: ${cloned.stdout}${cloned.stderr}`);
      spawnSync('git', ['config', 'user.email', 'review-test@example.invalid'], { cwd: cloneRoot });
      spawnSync('git', ['config', 'user.name', 'Review Test'], { cwd: cloneRoot });

      for (const relativePath of [
        'skills/release-quality-review/scripts/review-gate.mjs',
        'skills/release-quality-review/scripts/evidence-validator.mjs',
        'skills/release-quality-review/lib/review-utils.mjs',
        'skills/release-quality-review/lib/automated-gate-policy.mjs',
        'skills/release-quality-review/lib/verification-script-policy.mjs',
        'skills/release-quality-review/lib/evidence-utils.mjs',
        'skills/release-quality-review/lib/model-selector.mjs',
        'skills/release-quality-review/lib/candidate-runtime.mjs',
        'skills/release-quality-review/lib/sandbox-profile.mjs',
        'skills/release-quality-review/lib/security-utils.mjs',
        'skills/release-quality-review/review-config.yaml',
        'skills/release-quality-review/templates/result.yaml',
      ]) {
        copyFileSync(join(PROJECT_ROOT, relativePath), join(cloneRoot, relativePath));
      }
      cpSync(join(PROJECT_ROOT, 'skills/release-quality-review/scripts/modules'), join(cloneRoot, 'skills/release-quality-review/scripts/modules'), { recursive: true });

      const packagePath = join(cloneRoot, 'package.json');
      const packageJson = JSON.parse(readFileSync(packagePath, 'utf8'));
      for (const script of ['test', 'typecheck', 'build', 'lint', 'coverage']) {
        packageJson.scripts[script] = 'node --check skills/release-quality-review/scripts/review-gate.mjs';
      }
      packageJson.scripts['test:e2e'] = 'node --test fixture-test-runner.mjs';
      packageJson.scripts.test = 'node --test fixture-test-runner.mjs';
      packageJson.scripts.coverage = 'node --experimental-test-coverage --test fixture-test-runner.mjs';
      writeFileSync(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`);
      writeFileSync(join(cloneRoot, 'fixture-test-runner.mjs'),
        "import test from 'node:test';\ntest('fixture runner executes', () => {});\n");
      spawnSync('git', ['add', 'package.json', 'fixture-test-runner.mjs', 'skills/release-quality-review'], { cwd: cloneRoot });
      const fixtureCommit = spawnSync('git', ['commit', '-m', 'test: create fast gate fixture'], {
        cwd: cloneRoot, encoding: 'utf8', timeout: 10000,
      });
      assertEqual(fixtureCommit.status, 0, `Expected fixture commit, output: ${fixtureCommit.stdout}${fixtureCommit.stderr}`);

      const candidateCommit = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: cloneRoot, encoding: 'utf8' }).stdout.trim();
      const candidateTree = spawnSync('git', ['rev-parse', 'HEAD^{tree}'], { cwd: cloneRoot, encoding: 'utf8' }).stdout.trim();
      const diffBase = spawnSync('git', ['rev-parse', 'HEAD^'], { cwd: cloneRoot, encoding: 'utf8' }).stdout.trim();
      const baseTree = spawnSync('git', ['rev-parse', `${diffBase}^{tree}`], { cwd: cloneRoot, encoding: 'utf8' }).stdout.trim();
      for (const reviewer of ['product-flow', 'architecture-maintainer']) {
        const dir = join(round, reviewer);
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, 'result.yaml'), `reviewer: ${reviewer}\nprofile: quick\nround: ${roundNumber}\ncandidate_commit: ${candidateCommit}\ncandidate_tree: ${candidateTree}\nscore: 95\nstatus: pass\nreview_backend: codex\nreview_model: ${TEST_CODEX_MODEL}\nblockers: []\nredlines: []\n`);
        writeFileSync(join(dir, 'score.md'), `# ${reviewer}\n\n## Overall Score: 95/100\n\nEvidence: package.json:1 and npm test exit 0.\n`);
        writeFileSync(join(dir, 'blockers.md'), '# Blockers\n\nNo P0/P1 blockers.\n');
        writeFileSync(join(dir, 'improvement-list.md'), '# Improvements\n');
      }

      mkdirSync(join(round, 'evidence'), { recursive: true });
      const now = new Date().toISOString();
      const commandRecord = (command, output) => ({
        command, started_at: now, finished_at: now, status: 'pass', exit_code: 0,
        output, output_bytes: Buffer.byteLength(output), truncated: false,
      });
      const checkoutIdentity = { commit: candidateCommit, tree: candidateTree, status: '' };
      const automatedContent = JSON.stringify({
        testGate: commandRecord('npm test', '# tests 1\n# fail 0'),
        typecheckGate: commandRecord('npm run typecheck', 'passed'),
        buildGate: commandRecord('npm run build', 'passed'),
        lintGate: commandRecord('npm run lint', 'passed'),
        auditGate: commandRecord('npm audit --audit-level=high', 'found 0 vulnerabilities'),
        coverageGate: commandRecord('npm run coverage', '# tests 1\n# fail 0\n# start of coverage report'),
        e2eGate: commandRecord('npm run test:e2e', '# tests 1\n# fail 0'),
        secrets: { status: 'pass', issues: [] }, oversizedFiles: { status: 'pass', issues: [] },
        circularDeps: { status: 'pass', issues: [] },
        candidateCheckout: {
          status: 'pass', source_commit: candidateCommit, source_tree: candidateTree,
          initial: checkoutIdentity, final: checkoutIdentity,
        },
      });
      writeFileSync(join(round, 'evidence', 'automated-checks.json'), automatedContent);
      writeFileSync(join(round, 'metadata.json'), JSON.stringify({
        profile: 'quick', round: roundNumber, collected_at: now,
        git: { branch: 'test', commit: candidateCommit.slice(0, 8), status: '', changedFiles: ['package.json'] },
        files: {}, scale: { scale: 'micro', files: 1, additions: 1, deletions: 0, total: 1 },
        candidate_commit: candidateCommit, candidate_tree: candidateTree,
        review_backend: 'codex', review_model: TEST_CODEX_MODEL,
        base_commit: diffBase, base_tree: baseTree,
        automated_checks_sha256: createHash('sha256').update(automatedContent).digest('hex'),
      }));
      writeFileSync(join(round, 'review-backend.json'), JSON.stringify({ backend: 'codex', model: TEST_CODEX_MODEL }));

      const firstGate = spawnSync('node', [
        join(cloneRoot, 'skills/release-quality-review/scripts/review-gate.mjs'), '--profile', 'quick',
        '--round', String(roundNumber), '--base', diffBase, '--no-collect', '--no-validate-evidence',
      ], { cwd: cloneRoot, encoding: 'utf8', timeout: 60000 });
      assertEqual(firstGate.status, 0, `Expected candidate A to pass, output: ${firstGate.stdout}${firstGate.stderr}`);
      const arbitration = JSON.parse(readFileSync(join(round, 'evidence', 'final-arbitration.json'), 'utf8'));
      assertEqual(arbitration.candidate_commit, candidateCommit);
      assertEqual(arbitration.candidate_tree, candidateTree);
      assertEqual(Object.keys(arbitration.reviewer_packet_sha256).length, 2);

      const dirtyMarker = join(cloneRoot, 'dirty-worktree-marker.txt');
      writeFileSync(dirtyMarker, 'uncommitted drift\n');
      const dirtyGate = spawnSync('node', [
        join(cloneRoot, 'skills/release-quality-review/scripts/review-gate.mjs'), '--profile', 'quick',
        '--round', String(roundNumber), '--base', diffBase, '--no-collect', '--no-validate-evidence',
      ], { cwd: cloneRoot, encoding: 'utf8', timeout: 60000, env: { ...process.env, PATH: REAL_TEST_PATH } });
      assertEqual(dirtyGate.status, 1, `Expected dirty checkout rejection: ${dirtyGate.stdout}${dirtyGate.stderr}`);
      assertTrue(dirtyGate.stdout.includes('working-tree status'));
      rmSync(dirtyMarker);

      writeFileSync(join(cloneRoot, 'README.md'), `${readFileSync(join(cloneRoot, 'README.md'), 'utf8')}\ncandidate B\n`);
      spawnSync('git', ['add', 'README.md'], { cwd: cloneRoot });
      const secondCommit = spawnSync('git', ['commit', '-m', 'test: change candidate'], {
        cwd: cloneRoot, encoding: 'utf8', timeout: 10000,
      });
      assertEqual(secondCommit.status, 0, `Expected candidate B commit, output: ${secondCommit.stdout}${secondCommit.stderr}`);

      const candidateBCommit = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: cloneRoot, encoding: 'utf8' }).stdout.trim();
      const candidateBTree = spawnSync('git', ['rev-parse', 'HEAD^{tree}'], { cwd: cloneRoot, encoding: 'utf8' }).stdout.trim();
      const automatedB = JSON.parse(automatedContent);
      const checkoutB = { commit: candidateBCommit, tree: candidateBTree, status: '' };
      automatedB.candidateCheckout = {
        status: 'pass', source_commit: candidateBCommit, source_tree: candidateBTree,
        initial: checkoutB, final: checkoutB,
      };
      const automatedBContent = JSON.stringify(automatedB);
      writeFileSync(join(round, 'evidence', 'automated-checks.json'), automatedBContent);
      const metadataB = JSON.parse(readFileSync(join(round, 'metadata.json'), 'utf8'));
      metadataB.git.commit = candidateBCommit.slice(0, 8);
      metadataB.candidate_commit = candidateBCommit;
      metadataB.candidate_tree = candidateBTree;
      metadataB.automated_checks_sha256 = createHash('sha256').update(automatedBContent).digest('hex');
      writeFileSync(join(round, 'metadata.json'), JSON.stringify(metadataB));

      const staleGate = spawnSync('node', [
        join(cloneRoot, 'skills/release-quality-review/scripts/review-gate.mjs'), '--profile', 'quick',
        '--round', String(roundNumber), '--base', diffBase, '--no-collect', '--no-validate-evidence',
      ], { cwd: cloneRoot, encoding: 'utf8', timeout: 60000 });
      assertEqual(staleGate.status, 1, `Expected stale packets to fail, output: ${staleGate.stdout}${staleGate.stderr}`);
      assertTrue(staleGate.stdout.includes('Candidate tree mismatch'),
        `Expected explicit candidate identity diagnostic: ${staleGate.stdout}${staleGate.stderr}`);
    } finally {
      rmSync(cloneRoot, { recursive: true, force: true });
    }
  });

  test('quick profile cannot approve without automated test and typecheck evidence', () => {
    const roundNumber = TEST_ROUNDS.missingEvidence;
    const round = reportRound(roundNumber);
    const candidateCommit = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: PROJECT_ROOT, encoding: 'utf8' }).stdout.trim();
    const candidateTree = spawnSync('git', ['rev-parse', 'HEAD^{tree}'], { cwd: PROJECT_ROOT, encoding: 'utf8' }).stdout.trim();
    try {
      for (const reviewer of ['product-flow', 'architecture-maintainer']) {
        const dir = join(round, reviewer);
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, 'result.yaml'), `reviewer: ${reviewer}\nprofile: quick\nround: ${roundNumber}\ncandidate_commit: ${candidateCommit}\ncandidate_tree: ${candidateTree}\nscore: 95\nstatus: pass\nreview_backend: codex\nreview_model: ${TEST_CODEX_MODEL}\nblockers: []\nredlines: []\n`);
        writeFileSync(join(dir, 'score.md'), `## Overall Score: 95/100\n`);
        writeFileSync(join(dir, 'blockers.md'), 'No P0/P1 blockers.\n');
        writeFileSync(join(dir, 'improvement-list.md'), '# Improvements\n');
      }
      writeFileSync(join(round, 'review-backend.json'), JSON.stringify({ backend: 'codex', model: TEST_CODEX_MODEL }));
      const result = spawnSync('node', [
        join(SKILL_DIR, 'scripts', 'review-gate.mjs'), '--profile', 'quick', '--round', String(roundNumber),
        '--no-collect', '--no-validate-evidence',
      ], { cwd: PROJECT_ROOT, encoding: 'utf8' });
      assertEqual(result.status, 1);
      assertTrue(result.stdout.includes('Automated test gate FAILED'), 'Expected absent automated evidence to fail closed');
    } finally {
      rmSync(round, { recursive: true, force: true });
    }
  });
});

// Cleanup after all tests
process.on('exit', () => {
  try {
    rmSync(TEST_DIR, { recursive: true });
    rmdirSync(TEST_ROOT);
  } catch (e) {
    // Ignore
  }
});
