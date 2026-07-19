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
  test('gate rejects a symlinked report root without writing outside the repository', () => {
    const sandbox = mkdtempSync(join(tmpdir(), 'quality-review-symlink-'));
    const clone = join(sandbox, 'repo');
    const external = join(sandbox, 'external');
    try {
      const cloned = spawnSync('git', ['clone', '--quiet', '--no-local', PROJECT_ROOT, clone], { encoding: 'utf8' });
      assertEqual(cloned.status, 0);
      copyFileSync(join(SKILL_DIR, 'scripts', 'review-gate.mjs'),
        join(clone, 'skills/release-quality-review/scripts/review-gate.mjs'));
      copyFileSync(join(SKILL_DIR, 'lib', 'security-utils.mjs'),
        join(clone, 'skills/release-quality-review/lib/security-utils.mjs'));
      copyFileSync(join(SKILL_DIR, 'lib', 'review-utils.mjs'),
        join(clone, 'skills/release-quality-review/lib/review-utils.mjs'));
      copyFileSync(join(SKILL_DIR, 'lib', 'model-selector.mjs'),
        join(clone, 'skills/release-quality-review/lib/model-selector.mjs'));
      mkdirSync(external);
      rmSync(join(clone, 'quality-reports'), { recursive: true, force: true });
      symlinkSync(external, join(clone, 'quality-reports'), 'dir');
      const result = spawnSync('node', [
        join(clone, 'skills/release-quality-review/scripts/review-gate.mjs'),
        '--profile', 'quick', '--round', '991', '--no-collect', '--no-validate-evidence',
      ], { cwd: clone, encoding: 'utf8' });
      assertTrue(result.status !== 0, 'Expected symlinked report root to fail');
      assertEqual(existsSync(join(external, 'round-991', 'summary.md')), false,
        'Gate must not write reports through a symlinked report root');
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });

  test('gate does not invoke an unpinned network-resolved circular scanner', () => {
    const source = readFileSync(join(SKILL_DIR, 'scripts', 'review-gate.mjs'), 'utf8');
    assertEqual(/npx\s+madge/.test(source), false);
    assertEqual(/madge[^\n]*\|\|\s*echo/.test(source), false);
  });

  test('gate and runner keep candidate writes outside the real report root', () => {
    const runner = readFileSync(join(SKILL_DIR, 'scripts', 'review-runner.mjs'), 'utf8');
    assertEqual(runner.includes('writeRoots: [REPORT_DIR, ISOLATED_HOME]'), false, 'Runner exposes report root');
    assertEqual(runner.includes('createCandidateRuntime'), true, 'Runner bypasses shared candidate runtime');
    const evidence = readFileSync(join(SKILL_DIR, 'scripts', 'modules', 'evidence.mjs'), 'utf8');
    assertEqual(evidence.includes('createCandidateRuntime'), true, 'Gate evidence collection bypasses shared candidate runtime');
    assertEqual(evidence.includes('const candidateRoot = prepareCheckout()'), true, 'Gate evidence collection lacks isolated checkout');
    const runtime = readFileSync(join(SKILL_DIR, 'lib', 'candidate-runtime.mjs'), 'utf8');
    assertEqual(runtime.includes('sandboxWriteRoots = [isolatedHome]'), true, 'Shared runtime lacks isolated write root');
    assertEqual(runtime.includes('readOnlyRoots: [projectRoot, ...sandboxReadOnlyRoots]'), false,
      'Candidate runtime exposes the host project root to every command');
  });

  test('candidate runtime cannot read a real report canary', () => {
    if (process.platform !== 'darwin') return;
    const probe = spawnSync('/usr/bin/sandbox-exec', ['-p', '(version 1) (allow default)', '/usr/bin/true'], { encoding: 'utf8' });
    if (probe.status !== 0) return;
    const candidateRoot = join(TEST_DIR, `candidate-read-${randomUUID()}`);
    const canary = join(PROJECT_ROOT, 'quality-reports', `.read-canary-${randomUUID()}`);
    mkdirSync(candidateRoot, { recursive: true });
    writeFileSync(join(candidateRoot, 'allowed.txt'), 'allowed');
    writeFileSync(canary, 'trusted');
    const runtime = createCandidateRuntime(
      PROJECT_ROOT, 'read-boundary-test', outerSandboxAttestationFromEnv(),
    );
    try {
      const script = `const fs=require('node:fs');if(fs.readFileSync('allowed.txt','utf8')!=='allowed')process.exit(2);try{fs.readFileSync(${JSON.stringify(canary)});process.exit(3)}catch{}`;
      const output = runtime.execFileSync(process.execPath, ['-e', script], {
        cwd: candidateRoot, encoding: 'utf8', sandboxReadOnlyRoots: [candidateRoot],
      });
      assertEqual(output, '');
      const shellOutput = runtime.execSync(`${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`, {
        cwd: candidateRoot, encoding: 'utf8', sandboxReadOnlyRoots: [candidateRoot],
      });
      assertEqual(shellOutput, '');
    } finally {
      rmSync(canary, { force: true });
    }
  });

  test('candidate runtime passes its trusted sandbox attestation to nested commands', () => {
    const runtime = createCandidateRuntime(PROJECT_ROOT, `nested-attestation-${randomUUID()}`);
    assertEqual(runtime.env.RELEASE_QUALITY_OUTER_SANDBOX_ATTESTED, '1');
    assertEqual(existsSync(runtime.env.RELEASE_QUALITY_OUTER_SANDBOX_READ_CANARY), true);
    assertEqual(existsSync(runtime.env.RELEASE_QUALITY_OUTER_SANDBOX_WRITE_CANARY), false);
    assertEqual(isPathWithin(runtime.isolatedHome, runtime.env.RELEASE_QUALITY_OUTER_SANDBOX_READ_CANARY), false);
    assertEqual(isPathWithin(PROJECT_ROOT, runtime.env.RELEASE_QUALITY_OUTER_SANDBOX_READ_CANARY), false);
  });

  test('candidate checkout identity guard rejects mutation', () => {
    const clean = { commit: 'a'.repeat(40), tree: 'b'.repeat(40), status: '' };
    assertEqual(validateCandidateCheckoutIdentity(clean, clean, clean).status, 'pass');
    let rejectionMessage = '';
    try {
      validateCandidateCheckoutIdentity(clean, clean, { ...clean, status: ' M README.md' });
    } catch (error) {
      rejectionMessage = error.message;
    }
    assertTrue(rejectionMessage.includes('checkout identity changed'),
      `Candidate checkout mutation must reach the identity guard; got: ${rejectionMessage}`);
    for (const altered of [
      { initial: { ...clean, commit: 'c'.repeat(40) }, final: clean },
      { initial: clean, final: { ...clean, tree: 'd'.repeat(40) } },
    ]) {
      let rejected = false;
      try {
        validateCandidateCheckoutIdentity(clean, altered.initial, altered.final);
      } catch {
        rejected = true;
      }
      assertEqual(rejected, true);
    }
  });

  test('Claude reviewer invocation accepts report edits without interactive approval', () => {
    const runner = readFileSync(join(SKILL_DIR, 'scripts', 'review-runner.mjs'), 'utf8');
    assertTrue(runner.includes("args: ['-p', '--model', selectedModel, '--permission-mode', 'acceptEdits', '--no-session-persistence', prompt]"),
      'Claude print mode must not block waiting for report write approval');
    assertTrue(runner.includes("args: ['exec', '--json', '--model', selectedModel, ...effortArgs"),
      'Codex reviewer invocation must pin the selected model');
    assertTrue(runner.includes("args: ['exec', '--json', '--model', selectedModel"),
      'Codex reviewer invocation must expose structured provider failures');
    assertTrue(runner.includes('model_reasoning_effort=${JSON.stringify(selectedEffort)}'),
      'Codex reviewer invocation must pin Radar-selected reasoning effort');
    assertEqual(runner.includes('--dangerously-skip-permissions'), false,
      'Claude reviewer must not bypass all permission checks');
  });

  test('reviewer prompt requires scalar score and exact machine verdict', () => {
    const runner = readFileSync(join(SKILL_DIR, 'scripts', 'review-runner.mjs'), 'utf8');
    const prompt = readFileSync(join(SKILL_DIR, 'scripts', 'modules', 'reviewer-prompt.mjs'), 'utf8');
    assertTrue(prompt.includes('score 必须是整数'), 'Prompt must reject object-shaped scores');
    assertTrue(prompt.includes('status 必须是小写 pass 或 fail'), 'Prompt must require a parseable verdict');
    assertTrue(prompt.includes('status 只表示你自己的 reviewer verdict'),
      'Prompt must not confuse a reviewer verdict with whole-round arbitration');
    assertTrue(prompt.includes('score: <0-100 integer>'));
    assertTrue(prompt.includes('status: <pass|fail>'));
    assertTrue(prompt.includes('review_backend: ${reviewBackend}'));
    assertTrue(prompt.includes('review_model: ${reviewModel}'));
    assertTrue(prompt.includes('只允许包含下列 11 个顶层字段'));
    assertTrue(prompt.includes('不得添加 summary、dimensions、evidence'));
    assertTrue(prompt.includes('不要运行 review-runner、review-gate、npm test、npm run build'));
    assertTrue(prompt.includes('automated-checks.json'));
    assertTrue(prompt.includes('${evidenceBlocks}'));
    assertTrue(prompt.includes('修改命令、exit code、数字或 Output 文本会使 packet fail closed'));
    assertTrue(prompt.includes('每个 blockers/redlines 条目必须在 blockers.md 中有独立标题'));
    assertEqual(runner.includes('writeReviewerFilesFromOutput'), false,
      'Runner must fail closed instead of synthesizing reviewer packet files');
    assertEqual(runner.includes('Review output parsing incomplete'), false,
      'Runner must not author fallback review evidence');
    const validator = readFileSync(join(SKILL_DIR, 'scripts', 'evidence-validator.mjs'), 'utf8');
    assertTrue(validator.includes('const fileLineRefs = extractFileLineReferences(content)'),
      'Evidence quality must count references with the canonical extractor');
  });

  test('entry scripts initialize the report root without module-global mutable state', () => {
    for (const script of ['review-runner.mjs', 'review-gate.mjs', 'evidence-validator.mjs']) {
      const content = readFileSync(join(SKILL_DIR, 'scripts', script), 'utf8');
      assertEqual(/\blet REPORT_DIR\b/.test(content), false, script);
      assertTrue(content.includes('const REPORT_DIR = resolveReportDirectoryOrExit()'), script);
    }
  });

  test('actual reviews require a backend and reject incompatible explicit models', () => {
    const runner = join(SKILL_DIR, 'scripts', 'review-runner.mjs');
    for (const [args, expected] of [
      [['--profile', 'quick'], 'require explicit --agent'],
      [['--profile', 'quick', '--agent', 'claude'], 'claude reviews require explicit --model'],
      [['--profile', 'quick', '--agent', 'codex', '--model', 'claude-sonnet-4-6'], 'not valid for codex'],
      [['--profile', 'quick', '--agent', 'claude', '--model', 'gpt-5.4'], 'not valid for claude'],
    ]) {
      const result = spawnSync('node', [runner, ...args], { cwd: PROJECT_ROOT, encoding: 'utf8' });
      assertEqual(result.status, 4, `${result.stdout}${result.stderr}`);
      assertTrue(result.stderr.includes(expected), `${result.stdout}${result.stderr}`);
    }
  });

  test('dry-run supports Codex Radar auto-selection and validates explicit identity', t => {
    const runner = join(SKILL_DIR, 'scripts', 'review-runner.mjs');
    const snapshotPath = join(resolveReportDirectory(PROJECT_ROOT), `.radar-snapshot-${process.pid}.json`);
    const escapedSnapshotPath = join(resolveReportDirectory(PROJECT_ROOT), `.radar-snapshot-link-${process.pid}.json`);
    const outsideSnapshotPath = join(tmpdir(), `.radar-snapshot-outside-${process.pid}.json`);
    t.after(() => {
      rmSync(snapshotPath, { force: true });
      rmSync(escapedSnapshotPath, { force: true });
      rmSync(outsideSnapshotPath, { force: true });
    });
    mkdirSync(resolveReportDirectory(PROJECT_ROOT), { recursive: true });
    const snapshotBody = JSON.stringify(radarSnapshot({
      light: {
        model: TEST_CODEX_MODEL,
        latest: {
          model: TEST_CODEX_MODEL, reasoning_effort: 'low', score: 120, valid_tasks: 10,
          cost_usd: 1, wall_seconds: 10,
        },
      },
    }, new Date().toISOString()));
    writeFileSync(snapshotPath, snapshotBody);
    writeFileSync(outsideSnapshotPath, snapshotBody);
    symlinkSync(outsideSnapshotPath, escapedSnapshotPath);
    const allowed = spawnSync('node', [runner, '--profile', 'quick', '--dry-run'], {
      cwd: PROJECT_ROOT, encoding: 'utf8', timeout: 30000,
    });
    assertEqual(allowed.status, 0, `${allowed.stdout}${allowed.stderr}`);
    const auto = spawnSync('node', [
      runner, '--profile', 'quick', '--dry-run', '--agent', 'codex',
      '--radar-snapshot', relative(PROJECT_ROOT, snapshotPath),
    ], { cwd: PROJECT_ROOT, encoding: 'utf8', timeout: 30000 });
    assertEqual(auto.status, 0, `${auto.stdout}${auto.stderr}`);
    assertTrue(auto.stdout.includes(`radar-lightweight-qualified -> ${TEST_CODEX_MODEL} (low)`));
    const escapedSnapshot = spawnSync('node', [
      runner, '--profile', 'quick', '--dry-run', '--agent', 'codex',
      '--radar-snapshot', relative(PROJECT_ROOT, escapedSnapshotPath),
    ], { cwd: PROJECT_ROOT, encoding: 'utf8', timeout: 30000 });
    assertEqual(escapedSnapshot.status, 4, `${escapedSnapshot.stdout}${escapedSnapshot.stderr}`);
    assertTrue(escapedSnapshot.stderr.includes('main agent must choose a model'));
    writeFileSync(snapshotPath, JSON.stringify(radarSnapshot({ malformed: {
      model: TEST_CODEX_MODEL,
      latest: {
        model: TEST_CODEX_MODEL, reasoning_effort: 'extreme', score: 150, valid_tasks: 10,
      },
    } }, new Date().toISOString())));
    const malformedSnapshot = spawnSync('node', [
      runner, '--profile', 'quick', '--dry-run', '--agent', 'codex',
      '--radar-snapshot', relative(PROJECT_ROOT, snapshotPath),
    ], { cwd: PROJECT_ROOT, encoding: 'utf8', timeout: 30000 });
    assertEqual(malformedSnapshot.status, 4, `${malformedSnapshot.stdout}${malformedSnapshot.stderr}`);
    assertTrue(malformedSnapshot.stderr.includes('main agent must choose a model'));
    for (const [args, expected] of [
      [['--model', TEST_CODEX_MODEL], 'require explicit --agent'],
      [['--agent', 'claude'], 'claude reviews require explicit --model'],
      [['--agent', 'codex', '--model', 'claude-sonnet-4-6'], 'not valid for codex'],
      [['--agent', 'claude', '--model', 'gpt-5.4'], 'not valid for claude'],
      [['--agent', 'codex', '--model', TEST_CODEX_MODEL, '--reasoning-effort', 'extreme'], 'invalid --reasoning-effort'],
      [['--agent', 'codex', '--radar-snapshot', 'missing-radar.json'], 'main agent must choose a model'],
    ]) {
      const result = spawnSync('node', [runner, '--profile', 'quick', '--dry-run', ...args], {
        cwd: PROJECT_ROOT, encoding: 'utf8', timeout: 30000,
      });
      assertEqual(result.status, 4, `${result.stdout}${result.stderr}`);
      assertTrue(result.stderr.includes(expected), `${result.stdout}${result.stderr}`);
    }
  });

  test('report directory override stays repository-relative', () => {
    assertEqual(
      resolveReportDirectory(PROJECT_ROOT, { RELEASE_QUALITY_REPORT_DIR: 'quality-reports/isolated' }),
      join(PROJECT_ROOT, 'quality-reports', 'isolated'),
    );
    for (const value of ['../outside', join(PROJECT_ROOT, 'quality-reports')]) {
      let rejected = false;
      try {
        resolveReportDirectory(PROJECT_ROOT, { RELEASE_QUALITY_REPORT_DIR: value });
      } catch {
        rejected = true;
      }
      assertEqual(rejected, true);
    }
  });

  test('extracts Markdown and punctuated file references without allowing traversal', () => {
    const absolute = join(PROJECT_ROOT, 'skills/release-quality-review/__tests__/unit.test.mjs');
    const refs = extractFileLineReferences([
      'skills/release-quality-review/lib/evidence-utils.mjs:12',
      '`skills/release-quality-review/scripts/review-runner.mjs:281`,',
      `[unit](${absolute}:1619)。`,
      'skills/release-quality-review/scripts/review-gate.mjs:42.',
    ].join('\n'));
    assertEqual(refs.length, 4);
    assertEqual(refs[1].file, 'skills/release-quality-review/scripts/review-runner.mjs');
    assertEqual(refs[2].file, absolute);
    assertEqual(refs[2].line, 1619);
    assertEqual(resolveFileReference(PROJECT_ROOT, refs[2].file), absolute);
    assertEqual(resolveFileReference(PROJECT_ROOT, '../outside.mjs'), null);
    assertEqual(resolveFileReference(PROJECT_ROOT, join(tmpdir(), 'outside.mjs')), null);
  });

  test('parallel review has no project concurrency cap or implicit start delay', () => {
    const runner = readFileSync(join(SKILL_DIR, 'scripts', 'review-runner.mjs'), 'utf8');
    const execution = readFileSync(join(SKILL_DIR, 'scripts', 'modules', 'reviewer-execution.mjs'), 'utf8');
    const config = readFileSync(join(SKILL_DIR, 'review-config.yaml'), 'utf8');
    assertTrue(runner.includes("RELEASE_QUALITY_REVIEWER_START_DELAY_MS || '0'"));
    assertTrue(execution.includes('Promise.all(allReviewers.map'));
    assertEqual(config.includes('max_concurrent'), false);
  });

  test('validator CLIs reject unknown or incomplete options with configuration exit 4', () => {
    const cases = [
      ['goal-instruction-gate.mjs', ['--input', '/goal bounded result', '--definitely-invalid']],
      ['goal-mode-validator.mjs', ['--file', 'README.md', '--definitely-invalid']],
      ['validate-delivery-packet.mjs', ['--packet', '.', '--definitely-invalid']],
      ['goal-instruction-gate.mjs', ['--file']],
      ['goal-mode-validator.mjs', ['--round']],
      ['validate-delivery-packet.mjs', ['--mode']],
    ];
    for (const [script, args] of cases) {
      const result = spawnSync('node', [join(SKILL_DIR, 'scripts', script), ...args], {
        cwd: PROJECT_ROOT, encoding: 'utf8',
      });
      assertEqual(result.status, 4, `${script}: ${result.stdout}${result.stderr}`);
      assertTrue(result.stderr.includes('Configuration error:'));
      assertEqual(result.stderr.includes('\n    at '), false);
    }
  });

  test('validator CLI help and goal stdin paths are executable', () => {
    for (const script of [
      join(SKILL_DIR, 'scripts', 'goal-instruction-gate.mjs'),
      join(SKILL_DIR, 'scripts', 'goal-mode-validator.mjs'),
      join(SKILL_DIR, 'scripts', 'validate-delivery-packet.mjs'),
      join(SKILL_DIR, 'scripts', 'evidence-validator.mjs'),
      join(SKILL_DIR, 'scripts', 'verify-rollback.mjs'),
      join(PROJECT_ROOT, 'scripts', 'verify-clean-candidate.mjs'),
      join(PROJECT_ROOT, 'scripts', 'sync-skills.mjs'),
    ]) {
      const help = spawnSync('node', [script, '--help'], {
        cwd: PROJECT_ROOT, encoding: 'utf8',
      });
      assertEqual(help.status, 0, `${script}: ${help.stdout}${help.stderr}`);
      assertTrue(help.stdout.includes('Usage:'));
    }
    for (const script of [
      join(SKILL_DIR, 'scripts', 'review-runner.mjs'),
      join(SKILL_DIR, 'scripts', 'review-gate.mjs'),
    ]) {
      const help = spawnSync('node', [script, '--help'], { cwd: PROJECT_ROOT, encoding: 'utf8' });
      assertEqual(/\x1b\[/.test(`${help.stdout}${help.stderr}`), false, `${script} emitted ANSI to a pipe`);
    }
    const stdin = spawnSync('node', [join(SKILL_DIR, 'scripts', 'goal-instruction-gate.mjs'), '--stdin'], {
      cwd: PROJECT_ROOT, encoding: 'utf8',
      input: '/goal release-quality-review 达到可发布状态。验证标准：测试、覆盖率与 Gate 均通过。边界：不降低门槛。证据：输出退出码与提交哈希。停止条件：达成即停止。',
    });
    assertEqual(stdin.status, 0, `${stdin.stdout}${stdin.stderr}`);
  });

  test('evidence CLIs redact invalid output paths and use configuration exit 4', () => {
    for (const [script, args] of [
      [join(PROJECT_ROOT, 'scripts', 'verify-clean-candidate.mjs'), ['--output', '../outside/clean-candidate.json']],
      [join(SKILL_DIR, 'scripts', 'verify-rollback.mjs'), ['--base', 'HEAD', '--output', '../outside/rollback-verification.json']],
    ]) {
      const result = spawnSync('node', [script, ...args], { cwd: PROJECT_ROOT, encoding: 'utf8' });
      assertEqual(result.status, 4, `${result.stdout}${result.stderr}`);
      assertEqual(result.stderr.includes('\n    at '), false);
      assertEqual(result.stderr.includes(PROJECT_ROOT), false);
    }
  });

  test('invalid diff and rollback base refs fail as configuration errors', () => {
    const missingRef = `missing-ref-${randomUUID()}`;
    const roundNumber = TEST_ROUNDS.runner + 400;
    const round = reportRound(roundNumber);
    mkdirSync(round, { recursive: true });
    const cases = [
      [join(SKILL_DIR, 'scripts', 'verify-rollback.mjs'), [
        '--base', missingRef, '--output', `quality-reports/round-${TEST_ROUNDS.runner}/evidence/rollback-verification.json`,
      ]],
      [join(SKILL_DIR, 'scripts', 'evidence-validator.mjs'), [
        '--round', `round-${roundNumber}`, '--reviewer', 'architecture-maintainer', '--base', missingRef,
      ]],
    ];
    try {
      for (const [script, args] of cases) {
        const result = spawnSync('node', [script, ...args], { cwd: PROJECT_ROOT, encoding: 'utf8' });
        assertEqual(result.status, 4, `${result.stdout}${result.stderr}`);
        assertEqual(result.stdout.includes('Diff files: 0'), false);
        assertEqual(result.stderr.includes('\n    at '), false);
        assertEqual(result.stderr.includes(PROJECT_ROOT), false);
      }
    } finally {
      rmSync(round, { recursive: true, force: true });
    }
  });

  test('changed validator CLIs cover success and failure boundaries', () => {
    const validGoal = join(TEST_DIR, 'valid-goal.md');
    const invalidGoal = join(TEST_DIR, 'invalid-goal.md');
    const validMode = join(TEST_DIR, 'valid-mode.md');
    const invalidMode = join(TEST_DIR, 'invalid-mode.md');
    writeFileSync(validGoal, '/goal release-quality-review 达到可发布状态。验证标准：测试、覆盖率与 Gate 均通过。边界：不降低门槛。证据：输出退出码与提交哈希。停止条件：达成即停止。');
    writeFileSync(invalidGoal, '/goal 首先修改代码，然后跳过测试，最后宣布完成。');
    writeFileSync(validMode, '发布状态已由独立证据确认。');
    writeFileSync(invalidMode, '先执行测试，然后发布。我们添加这段代码，并按照步骤逐步完成。');
    const run = (script, args) => spawnSync('node', [join(SKILL_DIR, 'scripts', script), ...args], {
      cwd: PROJECT_ROOT, encoding: 'utf8',
    });
    assertEqual(run('goal-instruction-gate.mjs', ['--file', validGoal]).status, 0);
    assertEqual(run('goal-instruction-gate.mjs', ['--file', invalidGoal]).status, 1);
    assertEqual(run('goal-mode-validator.mjs', ['--file', validMode]).status, 0);
    assertEqual(run('goal-mode-validator.mjs', ['--file', invalidMode]).status, 1);
    const missingPacket = join(TEST_DIR, 'missing-packet');
    assertEqual(run('validate-delivery-packet.mjs', ['--packet', missingPacket, '--mode', 'strict']).status, 1);
    assertEqual(run('validate-delivery-packet.mjs', ['--packet', missingPacket, '--mode', 'assisted']).status, 2);
    assertEqual(run('validate-delivery-packet.mjs', ['--packet', missingPacket, '--mode', 'legacy']).status, 3);
  });

  test('strict delivery forensics fail closed when Git cannot execute', () => {
    const fakeBin = join(TEST_DIR, `fake-git-${randomUUID()}`);
    const fakeGit = join(fakeBin, 'git');
    mkdirSync(fakeBin, { recursive: true });
    writeFileSync(fakeGit, '#!/bin/sh\nexit 127\n');
    chmodSync(fakeGit, 0o755);
    const result = spawnSync(process.execPath, [
      join(SKILL_DIR, 'scripts', 'validate-delivery-packet.mjs'),
      '--packet', 'skills/release-quality-review/templates/delivery-packet', '--mode', 'strict', '--verbose',
    ], {
      cwd: PROJECT_ROOT, encoding: 'utf8', env: { ...process.env, PATH: fakeBin },
    });
    assertEqual(result.status, 1, `${result.stdout}${result.stderr}`);
    assertTrue(`${result.stdout}${result.stderr}`.includes('Forensic analysis could not verify the Git working tree'));
  });

  test('goal-mode round validation covers reviewer success and verbose failure', () => {
    const roundNumber = TEST_ROUNDS.runner + 300;
    const round = reportRound(roundNumber);
    const reviewer = join(round, 'product-flow');
    mkdirSync(reviewer, { recursive: true });
    writeFileSync(join(reviewer, 'score.md'), '发布状态已由独立证据确认。');
    writeFileSync(join(reviewer, 'blockers.md'), '未发现阻塞项。');
    writeFileSync(join(reviewer, 'improvement-list.md'), '后续改进项已明确记录。');
    const run = args => spawnSync('node', [
      join(SKILL_DIR, 'scripts', 'goal-mode-validator.mjs'), '--round', String(roundNumber), ...args,
    ], { cwd: PROJECT_ROOT, encoding: 'utf8' });
    try {
      assertEqual(run([]).status, 0);
      writeFileSync(join(reviewer, 'score.md'), '先执行测试，然后发布。我们添加这段代码，并按照步骤逐步完成。');
      const failed = run(['--verbose']);
      assertEqual(failed.status, 1, `${failed.stdout}${failed.stderr}`);
      assertTrue(failed.stdout.includes('Top Violation Types'));
    } finally {
      rmSync(round, { recursive: true, force: true });
    }
  });

  test('runner delegates production evidence collection to the Gate', () => {
    const runner = readFileSync(join(SKILL_DIR, 'scripts', 'review-runner.mjs'), 'utf8');
    assertTrue(runner.includes('await persistRoundEvidenceBeforeReview(roundDir, profile, currentRound)'));
    assertTrue(runner.includes('evidence = await loadPersistedRoundScope(roundDir)'));
    assertTrue(runner.includes('(gateReviewers || reviewerSelection.reviewers)'),
      'Actual reviews must consume the Gate-owned reviewer selection');
    assertEqual(runner.includes('function collectEvidence('), false,
      'Runner must not maintain a second production evidence collector');
  });

  test('release evidence exposes a coverage command and versioned changelog', () => {
    const manifest = JSON.parse(readFileSync(join(PROJECT_ROOT, 'package.json'), 'utf8'));
    assertTrue(typeof manifest.scripts?.coverage === 'string', 'Expected a coverage script');
    assertEqual(existsSync(join(PROJECT_ROOT, 'CHANGELOG.md')), true, 'Expected CHANGELOG.md');
  });

  test('documented agentic workflow binds clean evidence before collection on supported CI', () => {
    const readme = readFileSync(join(PROJECT_ROOT, 'README.md'), 'utf8');
    const clean = readme.indexOf('npm run skill:verify-clean');
    const rollback = readme.indexOf('npm run skill:verify-rollback');
    const runner = readme.indexOf('npm run review -- --profile agentic-release-gate');
    const artifacts = readme.indexOf('Before any reviewer launches');
    assertTrue(clean >= 0 && runner >= 0 && clean < runner, 'Clean evidence must precede the collecting runner');
    assertTrue(rollback >= 0 && rollback < runner, 'Rollback evidence must precede the collecting runner');
    assertTrue(artifacts >= 0 && artifacts < runner, 'Agentic artifacts must precede reviewer launch');
    assertTrue(readme.includes('test ! -e "quality-reports/$REVIEW_ROUND_DIR"'), 'Workflow must reject reused rounds');
    assertEqual(readme.includes('quality-reports/round-001'), false, 'Workflow must not target tracked Round 1');
    assertTrue(readme.includes('Trust boundary:'), 'README must state the local trust boundary');
    assertTrue(readme.includes('not signatures'), 'README must distinguish drift hashes from signatures');
    assertTrue(readme.includes('codex login status'), 'Quickstart must document Codex authentication preflight');
    assertTrue(readme.includes('claude auth status'), 'Quickstart must document Claude authentication preflight');
    assertTrue(readme.includes('--agent codex'),
      'First review must select a documented backend and allow Radar model selection');
    assertTrue(readme.includes('Codex Radar'), 'README must document automatic Codex model selection');
    assertTrue(readme.includes('automatically launches reviewer processes'),
      'Quickstart must disclose that review launches external Agent processes');
    const destructiveReviewer = readFileSync(join(SKILL_DIR, 'reviewers', 'destructive-qa.md'), 'utf8');
    assertTrue(destructiveReviewer.includes('威胁模型边界'), 'Destructive QA must evaluate the supported threat model');
    assertTrue(destructiveReviewer.includes('不能单独证明'), 'Synthetic helper inputs must not be reported as workflow bypasses');
    const gate = readFileSync(join(SKILL_DIR, 'scripts', 'review-gate.mjs'), 'utf8');
    assertTrue(gate.includes("if (existsSync(join(roundDir, 'generated-goal.md')))"),
      'Agentic Gate must validate its required generated Goal');
    assertTrue(gate.includes("requiredAgenticArtifacts.every"),
      'Agentic Gate must enforce the complete delivery packet');
    const workflow = readFileSync(join(PROJECT_ROOT, '.github', 'workflows', 'skill-quality.yml'), 'utf8');
    assertTrue(workflow.includes('runs-on: macos-latest'), 'Sandbox validation requires a Darwin CI runner');
    assertTrue(workflow.includes('persist-credentials: false'), 'CI checkout credentials must not persist');
  });

  test('parallel runner terminates hung reviewers and exits with agent failure', () => {
    const round = runnerRound(TEST_ROUNDS.parallelTimeout);
    const fakeBin = join(TEST_DIR, 'fake-bin');
    const leakMarker = join(TEST_DIR, 'reviewer-descendant-leak');
    const canaryMarker = join(TEST_DIR, 'reviewer-env-canary-leak');
    try {
      mkdirSync(fakeBin);
      const fakeCodex = join(fakeBin, 'codex');
      const descendantCode = `process.on('SIGTERM', () => {}); setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(leakMarker)}, 'leaked'), 500)`;
      writeFileSync(fakeCodex, `#!/usr/bin/env node
if (process.env.AMBIENT_SECRET_CANARY) process.getBuiltinModule('node:fs').writeFileSync(${JSON.stringify(canaryMarker)}, 'leaked');
if (process.argv.includes('--version') || process.argv.includes('--help')) process.exit(0);
process.getBuiltinModule('node:child_process').spawn(process.execPath, ['-e',
  ${JSON.stringify(descendantCode)}
], { stdio: 'ignore', env: process.env }).unref();
setInterval(() => { if (process.ppid === 1) process.exit(0); }, 20);
`);
      chmodSync(fakeCodex, 0o755);
      const result = spawnSync('node', [
        join(SKILL_DIR, 'scripts', 'review-runner.mjs'), '--profile', 'quick', '--parallel',
        '--agent', 'codex', '--model', TEST_CODEX_MODEL,
        '--round', String(TEST_ROUNDS.parallelTimeout), '--skip-evidence',
      ], {
        cwd: PROJECT_ROOT,
        encoding: 'utf8',
        timeout: 3000,
        env: {
          ...process.env,
          PATH: `${fakeBin}:${process.env.PATH}`,
          RELEASE_QUALITY_REVIEWER_TIMEOUT_MS: '100',
          RELEASE_QUALITY_REVIEWER_KILL_GRACE_MS: '100',
          RELEASE_QUALITY_REVIEWER_START_DELAY_MS: '1',
          AMBIENT_SECRET_CANARY: 'ambient-secret-must-not-cross',
        },
      });
      assertEqual(result.status, 5, `Expected exit 5, output: ${result.stdout}${result.stderr}`);
      assertTrue(result.stdout.includes('timed out'), 'Expected explicit reviewer timeout diagnostic');
      spawnSync(process.execPath, ['-e', 'setTimeout(() => {}, 700)']);
      assertEqual(existsSync(leakMarker), false,
        `Reviewer descendants must not survive to perform delayed writes: ${result.stdout}${result.stderr}`);
      assertEqual(existsSync(canaryMarker), false, 'Reviewer subprocesses must not inherit ambient secrets');
    } finally {
      rmSync(round, { recursive: true, force: true });
    }
  });

  test('parallel runner cleans descendants after a successful reviewer exit', () => {
    const round = runnerRound(TEST_ROUNDS.parallelSuccess);
    const fakeBin = join(TEST_DIR, 'fake-bin-success');
    const leakMarker = join(TEST_DIR, 'successful-reviewer-descendant-leak');
    try {
      mkdirSync(fakeBin);
      const fakeCodex = join(fakeBin, 'codex');
      const reviewerDir = join(round, 'product-flow');
      const candidateCommit = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: PROJECT_ROOT, encoding: 'utf8' }).stdout.trim();
      const candidateTree = spawnSync('git', ['rev-parse', 'HEAD^{tree}'], { cwd: PROJECT_ROOT, encoding: 'utf8' }).stdout.trim();
      const descendantCode = `process.on('SIGTERM', () => {}); setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(leakMarker)}, 'survived'), 500)`;
      writeFileSync(fakeCodex, `#!/usr/bin/env node
if (process.argv.includes('--version') || process.argv.includes('--help')) process.exit(0);
const fs = process.getBuiltinModule('node:fs');
fs.mkdirSync(${JSON.stringify(reviewerDir)}, { recursive: true });
fs.writeFileSync(${JSON.stringify(join(reviewerDir, 'result.yaml'))}, 'reviewer: product-flow\\nprofile: quick\\nround: ${TEST_ROUNDS.parallelSuccess}\\ncandidate_commit: ${candidateCommit}\\ncandidate_tree: ${candidateTree}\\nscore: 95\\nstatus: pass\\nreview_backend: codex\\nreview_model: ${TEST_CODEX_MODEL}\\nblockers: []\\nredlines: []\\n');
fs.writeFileSync(${JSON.stringify(join(reviewerDir, 'score.md'))}, '# Score\\n\\n## Overall Score: 95/100\\nCommand: npm test\\nExit code: 0\\nOutput: # tests 1; # pass 1; # fail 0\\n');
fs.writeFileSync(${JSON.stringify(join(reviewerDir, 'blockers.md'))}, '# Blockers\\n\\nNo P0/P1 blockers.\\n');
fs.writeFileSync(${JSON.stringify(join(reviewerDir, 'improvement-list.md'))}, '# Improvements\\n');
process.getBuiltinModule('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(descendantCode)}], { stdio: 'ignore', env: process.env }).unref();
`);
      chmodSync(fakeCodex, 0o755);
      const result = spawnSync('node', [
        join(SKILL_DIR, 'scripts', 'review-runner.mjs'), '--profile', 'quick', '--parallel',
        '--agent', 'codex', '--model', TEST_CODEX_MODEL,
        '--reviewer', 'product-flow', '--round', String(TEST_ROUNDS.parallelSuccess), '--skip-evidence',
      ], {
        cwd: PROJECT_ROOT, encoding: 'utf8', timeout: 5000,
        env: {
          ...process.env, PATH: `${fakeBin}:${process.env.PATH}`,
          RELEASE_QUALITY_REVIEWER_TIMEOUT_MS: '1000', RELEASE_QUALITY_REVIEWER_KILL_GRACE_MS: '100',
          RELEASE_QUALITY_REVIEWER_RETRY_MAX: '0', RELEASE_QUALITY_REVIEWER_START_DELAY_MS: '1',
        },
      });
      assertEqual(result.status, 1, `Expected failed gate after successful reviewer, output: ${result.stdout}${result.stderr}`);
      assertTrue(readFileSync(join(reviewerDir, 'score.md'), 'utf8').includes('95/100'),
        'Runner must preserve reviewer-authored artifacts');
      spawnSync(process.execPath, ['-e', 'setTimeout(() => {}, 700)']);
      assertEqual(existsSync(leakMarker), false, 'Successful reviewers must not leave descendants alive');
    } finally {
      rmSync(round, { recursive: true, force: true });
    }
  });

  test('parallel runner accepts a valid packet when the Agent only hangs during shutdown', () => {
    const roundNumber = TEST_ROUNDS.parallelSuccess + 300;
    const round = runnerRound(roundNumber);
    const fakeBin = join(TEST_DIR, 'fake-bin-valid-timeout');
    try {
      mkdirSync(fakeBin);
      const fakeCodex = join(fakeBin, 'codex');
      const reviewerDir = join(round, 'product-flow');
      const candidateCommit = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: PROJECT_ROOT, encoding: 'utf8' }).stdout.trim();
      const candidateTree = spawnSync('git', ['rev-parse', 'HEAD^{tree}'], { cwd: PROJECT_ROOT, encoding: 'utf8' }).stdout.trim();
      writeFileSync(fakeCodex, `#!/usr/bin/env node
if (process.argv.includes('--version') || process.argv.includes('--help')) process.exit(0);
const fs = process.getBuiltinModule('node:fs');
fs.mkdirSync(${JSON.stringify(reviewerDir)}, { recursive: true });
fs.writeFileSync(${JSON.stringify(join(reviewerDir, 'result.yaml'))}, 'reviewer: product-flow\\nprofile: quick\\nround: ${roundNumber}\\ncandidate_commit: ${candidateCommit}\\ncandidate_tree: ${candidateTree}\\nscore: 95\\nstatus: pass\\nreview_backend: codex\\nreview_model: ${TEST_CODEX_MODEL}\\nblockers: []\\nredlines: []\\n');
fs.writeFileSync(${JSON.stringify(join(reviewerDir, 'score.md'))}, '## Overall Score: 95/100\\nCommand: npm test\\nExit code: 0\\nOutput: # tests 1; # pass 1; # fail 0\\n');
fs.writeFileSync(${JSON.stringify(join(reviewerDir, 'blockers.md'))}, 'No P0/P1 blockers.\\n');
fs.writeFileSync(${JSON.stringify(join(reviewerDir, 'improvement-list.md'))}, '# Improvements\\n');
setInterval(() => {}, 1000);
`);
      chmodSync(fakeCodex, 0o755);
      const result = spawnSync('node', [
        join(SKILL_DIR, 'scripts', 'review-runner.mjs'), '--profile', 'quick', '--parallel',
        '--agent', 'codex', '--model', TEST_CODEX_MODEL, '--reviewer', 'product-flow',
        '--round', String(roundNumber), '--skip-evidence',
      ], {
        cwd: PROJECT_ROOT, encoding: 'utf8', timeout: 5000,
        env: {
          ...process.env, PATH: `${fakeBin}:${process.env.PATH}`,
          RELEASE_QUALITY_REVIEWER_TIMEOUT_MS: '100', RELEASE_QUALITY_REVIEWER_KILL_GRACE_MS: '100',
          RELEASE_QUALITY_REVIEWER_RETRY_MAX: '0', RELEASE_QUALITY_REVIEWER_START_DELAY_MS: '1',
        },
      });
      assertEqual(result.status, 1, `Valid timed-out packet must reach Gate instead of exit 5: ${result.stdout}${result.stderr}`);
      assertTrue(result.stdout.includes('product-flow: completed'), result.stdout);
    } finally {
      rmSync(round, { recursive: true, force: true });
    }
  });

  test('runner rejects reviewer counts that do not match round-owned evidence', () => {
    const roundNumber = TEST_ROUNDS.parallelSuccess + 301;
    const round = runnerRound(roundNumber);
    const fakeBin = join(TEST_DIR, 'fake-bin-forged-round-evidence');
    try {
      const automatedPath = join(round, 'evidence', 'automated-checks.json');
      const automated = JSON.parse(readFileSync(automatedPath, 'utf8'));
      automated.testGate.output = '# tests 159\n# pass 159\n# fail 0';
      writeFileSync(automatedPath, JSON.stringify(automated));

      mkdirSync(fakeBin);
      const fakeCodex = join(fakeBin, 'codex');
      const reviewerDir = join(round, 'product-flow');
      const candidateCommit = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: PROJECT_ROOT, encoding: 'utf8' }).stdout.trim();
      const candidateTree = spawnSync('git', ['rev-parse', 'HEAD^{tree}'], { cwd: PROJECT_ROOT, encoding: 'utf8' }).stdout.trim();
      writeFileSync(fakeCodex, `#!/usr/bin/env node
if (process.argv.includes('--version') || process.argv.includes('--help')) process.exit(0);
const fs = process.getBuiltinModule('node:fs');
fs.mkdirSync(${JSON.stringify(reviewerDir)}, { recursive: true });
fs.writeFileSync(${JSON.stringify(join(reviewerDir, 'result.yaml'))}, 'reviewer: product-flow\\nprofile: quick\\nround: ${roundNumber}\\ncandidate_commit: ${candidateCommit}\\ncandidate_tree: ${candidateTree}\\nscore: 95\\nstatus: pass\\nreview_backend: codex\\nreview_model: ${TEST_CODEX_MODEL}\\nblockers: []\\nredlines: []\\n');
fs.writeFileSync(${JSON.stringify(join(reviewerDir, 'score.md'))}, '## Overall Score: 95/100\\nCommand: npm test\\nExit code: 0\\nOutput: # tests 1; # pass 1; # fail 0\\n');
fs.writeFileSync(${JSON.stringify(join(reviewerDir, 'blockers.md'))}, 'No P0/P1 blockers.\\n');
fs.writeFileSync(${JSON.stringify(join(reviewerDir, 'improvement-list.md'))}, '# Improvements\\n');
`);
      chmodSync(fakeCodex, 0o755);
      const result = spawnSync('node', [
        join(SKILL_DIR, 'scripts', 'review-runner.mjs'), '--profile', 'quick', '--parallel',
        '--agent', 'codex', '--model', TEST_CODEX_MODEL, '--reviewer', 'product-flow',
        '--round', String(roundNumber), '--skip-evidence',
      ], {
        cwd: PROJECT_ROOT, encoding: 'utf8', timeout: 5000,
        env: {
          ...process.env, PATH: `${fakeBin}:${process.env.PATH}`,
          RELEASE_QUALITY_REVIEWER_TIMEOUT_MS: '1000', RELEASE_QUALITY_REVIEWER_KILL_GRACE_MS: '100',
          RELEASE_QUALITY_REVIEWER_RETRY_MAX: '0', RELEASE_QUALITY_REVIEWER_START_DELAY_MS: '1',
        },
      });
      assertEqual(result.status, 5, `Forged round evidence must fail before Gate: ${result.stdout}${result.stderr}`);
      assertTrue(result.stdout.includes('command evidence does not match round: npm test'), result.stdout);
    } finally {
      rmSync(round, { recursive: true, force: true });
    }
  });

  for (const parallel of [true, false]) {
    test(`${parallel ? 'parallel' : 'sequential'} runner does not retry permanent Agent failures`, () => {
      const roundNumber = TEST_ROUNDS.parallelSuccess + (parallel ? 400 : 401);
      const round = runnerRound(roundNumber);
      const fakeBin = join(TEST_DIR, `fake-bin-permanent-failure-${parallel ? 'parallel' : 'sequential'}`);
      const invocationMarker = join(TEST_DIR, `permanent-failure-invocations-${parallel ? 'parallel' : 'sequential'}`);
      try {
        mkdirSync(fakeBin);
        const fakeCodex = join(fakeBin, 'codex');
        writeFileSync(fakeCodex, `#!/usr/bin/env node
if (process.argv.includes('--version') || process.argv.includes('--help')) process.exit(0);
const fs = process.getBuiltinModule('node:fs');
fs.appendFileSync(${JSON.stringify(invocationMarker)}, 'called\\n');
console.log(JSON.stringify({ type: 'turn.failed', error: { message: '403 Forbidden: insufficient balance' } }));
process.exit(1);
`);
        chmodSync(fakeCodex, 0o755);
        const args = [
          join(SKILL_DIR, 'scripts', 'review-runner.mjs'), '--profile', 'quick',
          '--agent', 'codex', '--model', TEST_CODEX_MODEL,
          '--reviewer', 'product-flow', '--round', String(roundNumber), '--skip-evidence',
        ];
        if (parallel) args.push('--parallel');
        const result = spawnSync('node', args, {
          cwd: PROJECT_ROOT, encoding: 'utf8', timeout: 5000,
          env: {
            ...process.env, PATH: `${fakeBin}:${process.env.PATH}`,
            RELEASE_QUALITY_REVIEWER_RETRY_MAX: '2', RELEASE_QUALITY_REVIEWER_START_DELAY_MS: '1',
            RELEASE_QUALITY_RETRY_BASE_DELAY_MS: '1', RELEASE_QUALITY_RETRY_MAX_JITTER_MS: '0',
          },
        });
        assertEqual(result.status, 5, `Expected Agent failure, output: ${result.stdout}${result.stderr}`);
        assertEqual(readFileSync(invocationMarker, 'utf8').trim().split('\\n').length, 1,
          `Permanent failures must launch the reviewer once: ${result.stdout}${result.stderr}`);
        assertTrue(result.stdout.includes('not retrying permanent Agent failure'),
          `Expected explicit retry decision: ${result.stdout}${result.stderr}`);
      } finally {
        rmSync(round, { recursive: true, force: true });
      }
    });
  }

  test('parallel runner ignores permanent-error text outside structured failure events', () => {
    const roundNumber = TEST_ROUNDS.parallelSuccess + 402;
    const round = runnerRound(roundNumber);
    const fakeBin = join(TEST_DIR, 'fake-bin-transient-failure');
    const invocationMarker = join(TEST_DIR, 'transient-failure-invocations');
    try {
      mkdirSync(fakeBin);
      const fakeCodex = join(fakeBin, 'codex');
      const reviewerDir = join(round, 'product-flow');
      const candidateCommit = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: PROJECT_ROOT, encoding: 'utf8' }).stdout.trim();
      const candidateTree = spawnSync('git', ['rev-parse', 'HEAD^{tree}'], { cwd: PROJECT_ROOT, encoding: 'utf8' }).stdout.trim();
      writeFileSync(fakeCodex, `#!/usr/bin/env node
if (process.argv.includes('--version') || process.argv.includes('--help')) process.exit(0);
const fs = process.getBuiltinModule('node:fs');
fs.appendFileSync(${JSON.stringify(invocationMarker)}, 'called\\n');
if (fs.readFileSync(${JSON.stringify(invocationMarker)}, 'utf8').trim().split('\\n').length === 1) {
  console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: '403 Forbidden: insufficient balance' } }));
  console.error('403 Forbidden: insufficient balance');
  process.exit(1);
}
fs.mkdirSync(${JSON.stringify(reviewerDir)}, { recursive: true });
fs.writeFileSync(${JSON.stringify(join(reviewerDir, 'result.yaml'))}, 'reviewer: product-flow\\nprofile: quick\\nround: ${roundNumber}\\ncandidate_commit: ${candidateCommit}\\ncandidate_tree: ${candidateTree}\\nscore: 95\\nstatus: pass\\nreview_backend: codex\\nreview_model: ${TEST_CODEX_MODEL}\\nblockers: []\\nredlines: []\\n');
fs.writeFileSync(${JSON.stringify(join(reviewerDir, 'score.md'))}, '## Overall Score: 95/100\\nCommand: npm test\\nExit code: 0\\nOutput: # tests 1; # pass 1; # fail 0\\n');
fs.writeFileSync(${JSON.stringify(join(reviewerDir, 'blockers.md'))}, 'No P0/P1 blockers.\\n');
fs.writeFileSync(${JSON.stringify(join(reviewerDir, 'improvement-list.md'))}, '# Improvements\\n');
`);
      chmodSync(fakeCodex, 0o755);
      const result = spawnSync('node', [
        join(SKILL_DIR, 'scripts', 'review-runner.mjs'), '--profile', 'quick', '--parallel',
        '--agent', 'codex', '--model', TEST_CODEX_MODEL,
        '--reviewer', 'product-flow', '--round', String(roundNumber), '--skip-evidence',
      ], {
        cwd: PROJECT_ROOT, encoding: 'utf8', timeout: 5000,
        env: {
          ...process.env, PATH: `${fakeBin}:${process.env.PATH}`,
          RELEASE_QUALITY_REVIEWER_RETRY_MAX: '2', RELEASE_QUALITY_REVIEWER_START_DELAY_MS: '1',
          RELEASE_QUALITY_RETRY_BASE_DELAY_MS: '1', RELEASE_QUALITY_RETRY_MAX_JITTER_MS: '0',
        },
      });
      assertEqual(result.status, 1, `Valid packet must reach the failing Gate, output: ${result.stdout}${result.stderr}`);
      assertTrue(result.stdout.includes('Retry 1/2 for product-flow'), result.stdout);
      assertTrue(result.stdout.includes('product-flow (attempt 2): completed'), result.stdout);
    } finally {
      rmSync(round, { recursive: true, force: true });
    }
  });

  test('sequential runner terminates hung reviewer descendants', () => {
    const roundNumber = TEST_ROUNDS.parallelSuccess + 100;
    const round = runnerRound(roundNumber);
    const fakeBin = join(TEST_DIR, 'fake-bin-sequential-timeout');
    const leakMarker = join(TEST_DIR, 'sequential-reviewer-descendant-leak');
    try {
      mkdirSync(fakeBin);
      const fakeCodex = join(fakeBin, 'codex');
      const descendantCode = `process.on('SIGTERM', () => {}); setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(leakMarker)}, 'leaked'), 500)`;
      writeFileSync(fakeCodex, `#!/usr/bin/env node
process.getBuiltinModule('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(descendantCode)}], { stdio: 'ignore', env: process.env });
setInterval(() => {}, 1000);
`);
      chmodSync(fakeCodex, 0o755);
      const result = spawnSync('node', [
        join(SKILL_DIR, 'scripts', 'review-runner.mjs'), '--profile', 'quick',
        '--agent', 'codex', '--model', TEST_CODEX_MODEL,
        '--reviewer', 'product-flow', '--round', String(roundNumber), '--skip-evidence',
      ], {
        cwd: PROJECT_ROOT,
        encoding: 'utf8',
        timeout: 3000,
        env: {
          ...process.env,
          PATH: `${fakeBin}:${process.env.PATH}`,
          RELEASE_QUALITY_REVIEWER_TIMEOUT_MS: '100',
          RELEASE_QUALITY_REVIEWER_KILL_GRACE_MS: '100',
          RELEASE_QUALITY_REVIEWER_RETRY_MAX: '0',
          RELEASE_QUALITY_REVIEWER_START_DELAY_MS: '1',
        },
      });
      assertEqual(result.status, 5, `Expected exit 5, output: ${result.stdout}${result.stderr}`);
      assertTrue(result.stdout.includes('timed out'), 'Expected explicit sequential timeout diagnostic');
      spawnSync(process.execPath, ['-e', 'setTimeout(() => {}, 700)']);
      assertEqual(existsSync(leakMarker), false, 'Sequential reviewer descendants must be terminated');
    } finally {
      rmSync(round, { recursive: true, force: true });
    }
  });

  test('sequential runner cleans descendants after a successful reviewer exit', () => {
    const roundNumber = TEST_ROUNDS.parallelSuccess + 101;
    const round = runnerRound(roundNumber);
    const fakeBin = join(TEST_DIR, 'fake-bin-sequential-success');
    const leakMarker = join(TEST_DIR, 'sequential-success-descendant-leak');
    try {
      mkdirSync(fakeBin);
      const fakeCodex = join(fakeBin, 'codex');
      const reviewerDir = join(round, 'product-flow');
      const candidateCommit = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: PROJECT_ROOT, encoding: 'utf8' }).stdout.trim();
      const candidateTree = spawnSync('git', ['rev-parse', 'HEAD^{tree}'], { cwd: PROJECT_ROOT, encoding: 'utf8' }).stdout.trim();
      const descendantCode = `process.on('SIGTERM', () => {}); setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(leakMarker)}, 'survived'), 500)`;
      writeFileSync(fakeCodex, `#!/usr/bin/env node
const fs = process.getBuiltinModule('node:fs');
fs.mkdirSync(${JSON.stringify(reviewerDir)}, { recursive: true });
fs.writeFileSync(${JSON.stringify(join(reviewerDir, 'result.yaml'))}, 'reviewer: product-flow\\nprofile: quick\\nround: ${roundNumber}\\ncandidate_commit: ${candidateCommit}\\ncandidate_tree: ${candidateTree}\\nscore: 95\\nstatus: pass\\nreview_backend: codex\\nreview_model: ${TEST_CODEX_MODEL}\\nblockers: []\\nredlines: []\\n');
fs.writeFileSync(${JSON.stringify(join(reviewerDir, 'score.md'))}, '# Score\\n\\n## Overall Score: 95/100\\nCommand: npm test\\nExit code: 0\\nOutput: # tests 1; # pass 1; # fail 0\\n');
fs.writeFileSync(${JSON.stringify(join(reviewerDir, 'blockers.md'))}, '# Blockers\\n\\nNo P0/P1 blockers.\\n');
fs.writeFileSync(${JSON.stringify(join(reviewerDir, 'improvement-list.md'))}, '# Improvements\\n');
process.getBuiltinModule('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(descendantCode)}], { stdio: 'ignore', env: process.env }).unref();
`);
      chmodSync(fakeCodex, 0o755);
      const result = spawnSync('node', [
        join(SKILL_DIR, 'scripts', 'review-runner.mjs'), '--profile', 'quick',
        '--agent', 'codex', '--model', TEST_CODEX_MODEL,
        '--reviewer', 'product-flow', '--round', String(roundNumber), '--skip-evidence',
      ], {
        cwd: PROJECT_ROOT, encoding: 'utf8', timeout: 5000,
        env: {
          ...process.env, PATH: `${fakeBin}:${process.env.PATH}`,
          RELEASE_QUALITY_REVIEWER_TIMEOUT_MS: '4000', RELEASE_QUALITY_REVIEWER_KILL_GRACE_MS: '100',
          RELEASE_QUALITY_REVIEWER_RETRY_MAX: '0', RELEASE_QUALITY_REVIEWER_START_DELAY_MS: '1',
        },
      });
      assertEqual(result.status, 1, `Expected failed Gate after reviewer completion, output: ${result.stdout}${result.stderr}`);
      spawnSync(process.execPath, ['-e', 'setTimeout(() => {}, 700)']);
      assertEqual(existsSync(leakMarker), false, 'Sequential successful reviewer descendants must be terminated');
    } finally {
      rmSync(round, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  test('rejects synthetic auto review', () => {
    const result = spawnSync('node', [
      join(SKILL_DIR, 'scripts', 'review-runner.mjs'), '--auto', '--dry-run',
    ], { cwd: PROJECT_ROOT, encoding: 'utf8' });
    assertEqual(result.status, 4);
  });

  test('review gate auto-detects a positive round when omitted', () => {
    const result = spawnSync('node', [
      join(SKILL_DIR, 'scripts', 'review-gate.mjs'), '--profile', 'quick', '--dry-run',
    ], { cwd: PROJECT_ROOT, encoding: 'utf8', timeout: 5000 });
    assertEqual(result.status, 0, `Expected successful dry run, output: ${result.stdout}${result.stderr}`);
    assertTrue(/Round:\s+\d+/.test(result.stdout), 'Expected an auto-detected positive round');
    assertEqual(result.stdout.includes('round-null'), false, 'Gate must never create round-null');
  });

  test('review gate rejects shell metacharacters in the diff base', () => {
    const marker = join(TEST_DIR, 'base-injection-marker');
    const result = spawnSync('node', [
      join(SKILL_DIR, 'scripts', 'review-gate.mjs'), '--profile', 'quick', '--dry-run',
      '--base', `HEAD;touch ${marker}`,
    ], { cwd: PROJECT_ROOT, encoding: 'utf8', timeout: 5000 });
    assertEqual(result.status, 4, `Expected invalid base failure, output: ${result.stdout}${result.stderr}`);
    assertEqual(existsSync(marker), false, 'Diff base must not reach a shell');
  });

  test('rejects review targets outside the repository', () => {
    const result = spawnSync('node', [
      join(SKILL_DIR, 'scripts', 'review-runner.mjs'), '--target', '../escaped;touch marker', '--dry-run',
    ], { cwd: PROJECT_ROOT, encoding: 'utf8' });
    assertEqual(result.status, 4);
    assertEqual(existsSync(join(PROJECT_ROOT, 'marker')), false);
  });

  test('evidence validator rejects a bare command token with static references', () => {
    const roundNumber = TEST_ROUNDS.evidenceForgery;
    const round = runnerRound(roundNumber);
    const reviewerDir = join(round, 'product-flow');
    const candidateCommit = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: PROJECT_ROOT, encoding: 'utf8' }).stdout.trim();
    const candidateTree = spawnSync('git', ['rev-parse', 'HEAD^{tree}'], { cwd: PROJECT_ROOT, encoding: 'utf8' }).stdout.trim();
    try {
      mkdirSync(reviewerDir, { recursive: true });
      writeFileSync(join(round, 'metadata.json'), JSON.stringify({
        candidate_commit: candidateCommit,
        candidate_tree: candidateTree,
      }));
      writeFileSync(join(reviewerDir, 'result.yaml'), `reviewer: product-flow\nprofile: quick\nround: ${roundNumber}\ncandidate_commit: ${candidateCommit}\ncandidate_tree: ${candidateTree}\nscore: 95\nstatus: pass\nreview_backend: codex\nreview_model: ${TEST_CODEX_MODEL}\nblockers: []\nredlines: []\n`);
      writeFileSync(join(reviewerDir, 'score.md'), [
        '# Product Flow',
        '## Overall Score: 95/100',
        '功能正常。运行证据：npm test。',
        'skills/release-quality-review/scripts/evidence-validator.mjs:1',
        'skills/release-quality-review/scripts/review-gate.mjs:1',
        'skills/release-quality-review/scripts/review-runner.mjs:1',
        'skills/release-quality-review/lib/review-utils.mjs:1',
        'skills/release-quality-review/lib/security-utils.mjs:1',
      ].join('\n'));
      const result = spawnSync('node', [
        join(SKILL_DIR, 'scripts', 'evidence-validator.mjs'), '--round', `round-${String(roundNumber).padStart(3, '0')}`,
        '--reviewer', 'product-flow', '--base', 'HEAD',
      ], { cwd: PROJECT_ROOT, encoding: 'utf8' });
      assertEqual(result.status, 1, `Expected forged evidence rejection, output: ${result.stdout}${result.stderr}`);
      assertTrue(result.stdout.includes('missing_evidence_output'),
        `Expected explicit missing command evidence violation, output: ${result.stdout}${result.stderr}`);

      writeFileSync(join(reviewerDir, 'score.md'), [
        '# Product Flow',
        '## Overall Score: 95/100',
        '测试通过。运行证据：npm test exit 0 metadata.json。',
        'skills/release-quality-review/scripts/evidence-validator.mjs:1',
        'skills/release-quality-review/scripts/review-gate.mjs:1',
        'skills/release-quality-review/scripts/review-runner.mjs:1',
        'skills/release-quality-review/lib/review-utils.mjs:1',
        'skills/release-quality-review/lib/security-utils.mjs:1',
      ].join('\n'));
      const markerResult = spawnSync('node', [
        join(SKILL_DIR, 'scripts', 'evidence-validator.mjs'), '--round', `round-${String(roundNumber).padStart(3, '0')}`,
        '--reviewer', 'product-flow', '--base', 'HEAD',
      ], { cwd: PROJECT_ROOT, encoding: 'utf8' });
      assertEqual(markerResult.status, 1, `Expected fake bound marker rejection, output: ${markerResult.stdout}${markerResult.stderr}`);
      assertTrue(markerResult.stdout.includes('missing_evidence_output'), 'Expected fake bound marker violation');

      writeFileSync(join(reviewerDir, 'score.md'), [
        '# Product Flow',
        '## Overall Score: 95/100',
        'skills/release-quality-review/scripts/evidence-validator.mjs:1',
        'skills/release-quality-review/scripts/review-gate.mjs:1',
        'skills/release-quality-review/scripts/review-runner.mjs:1',
        'skills/release-quality-review/lib/review-utils.mjs:1',
        'skills/release-quality-review/lib/security-utils.mjs:1',
      ].join('\n'));
      const ratioResult = spawnSync('node', [
        join(SKILL_DIR, 'scripts', 'evidence-validator.mjs'), '--round', `round-${String(roundNumber).padStart(3, '0')}`,
        '--reviewer', 'product-flow', '--base', 'HEAD',
      ], { cwd: PROJECT_ROOT, encoding: 'utf8' });
      assertEqual(ratioResult.status, 1, `Expected score ratio rejection, output: ${ratioResult.stdout}${ratioResult.stderr}`);
      assertTrue(ratioResult.stdout.includes('missing_command_evidence'),
        'Five unrelated static citations must not authorize a passing packet');
    } finally {
      rmSync(round, { recursive: true, force: true });
    }
  });

  test('Gate and clean verifier reject explicit success no-op scripts', () => {
    const repository = join(TEST_DIR, 'trivial-verification-repository');
    const clone = spawnSync('git', ['clone', '--quiet', '--no-local', PROJECT_ROOT, repository], {
      cwd: TEST_DIR, encoding: 'utf8', timeout: 30000,
    });
    assertEqual(clone.status, 0, `Expected fixture clone, output: ${clone.stdout}${clone.stderr}`);
    const manifestPath = join(repository, 'package.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    manifest.scripts.test = 'env true';
    manifest.scripts.coverage = 'command sh -c true';
    manifest.scripts.typecheck = 'bash -lc true';
    manifest.scripts.build = 'exec true';
    manifest.scripts.lint = 'nice true';
    for (const name of ['skill:check-drift', 'skill:check', 'skill:verify']) manifest.scripts[name] = 'env true';
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    spawnSync('git', ['config', 'user.email', 'test@example.invalid'], { cwd: repository, encoding: 'utf8' });
    spawnSync('git', ['config', 'user.name', 'Test'], { cwd: repository, encoding: 'utf8' });
    spawnSync('git', ['add', 'package.json'], { cwd: repository, encoding: 'utf8' });
    const commit = spawnSync('git', ['commit', '--quiet', '-m', 'forge verification scripts'], { cwd: repository, encoding: 'utf8' });
    assertEqual(commit.status, 0, `Expected fixture commit, output: ${commit.stdout}${commit.stderr}`);
    const fixtureBase = spawnSync('git', ['rev-parse', 'HEAD^'], { cwd: repository, encoding: 'utf8' }).stdout.trim();

    const gate = spawnSync(process.execPath, [
      join(SKILL_DIR, 'scripts', 'review-gate.mjs'), '--profile', 'quick', '--round', '1', '--base', fixtureBase,
    ], {
      cwd: repository,
      encoding: 'utf8',
      timeout: 30000,
      env: { ...process.env, RELEASE_QUALITY_OUTER_SANDBOX_ATTESTED: '1' },
    });
    assertEqual(gate.status, 1, `Expected no-op Gate rejection, output: ${gate.stdout}${gate.stderr}`);
    assertTrue(gate.stdout.includes('trivial or missing verification scripts'), 'Gate must name script-integrity failure');

    const outputArg = join('quality-reports', 'round-002', 'evidence', 'clean-candidate.json');
    const output = join(repository, outputArg);
    const clean = spawnSync(process.execPath, [
      join(PROJECT_ROOT, 'scripts', 'verify-clean-candidate.mjs'), '--output', outputArg,
    ], {
      cwd: repository,
      encoding: 'utf8',
      timeout: 30000,
      env: { ...process.env, RELEASE_QUALITY_OUTER_SANDBOX_ATTESTED: '1' },
    });
    assertEqual(clean.status, 1, `Expected no-op clean-verifier rejection, output: ${clean.stdout}${clean.stderr}`);
    assertTrue(existsSync(output), `Expected failed clean evidence, output: ${clean.stdout}${clean.stderr}`);
    const cleanEvidence = JSON.parse(readFileSync(output, 'utf8'));
    const scriptIntegrity = cleanEvidence.commands.find(command => command.id === 'script-integrity');
    assertEqual(scriptIntegrity?.status, 'fail');
  });

  test('Gate and clean verifier reject candidate-authored Node summary printers', () => {
    const repository = join(TEST_DIR, 'fake-node-verifier-repository');
    const clone = spawnSync('git', ['clone', '--quiet', '--no-local', PROJECT_ROOT, repository], {
      cwd: TEST_DIR, encoding: 'utf8', timeout: 30000,
    });
    assertEqual(clone.status, 0, `Expected fixture clone, output: ${clone.stdout}${clone.stderr}`);
    const manifestPath = join(repository, 'package.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    manifest.scripts.test = 'node fake-verifier.mjs --test';
    manifest.scripts.coverage = 'node fake-verifier.mjs --test --experimental-test-coverage';
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    writeFileSync(join(repository, 'fake-verifier.mjs'),
      "console.log('# tests 1\\n# fail 0\\n# start of coverage report');\n");
    spawnSync('git', ['config', 'user.email', 'test@example.invalid'], { cwd: repository, encoding: 'utf8' });
    spawnSync('git', ['config', 'user.name', 'Test'], { cwd: repository, encoding: 'utf8' });
    spawnSync('git', ['add', 'package.json', 'fake-verifier.mjs'], { cwd: repository, encoding: 'utf8' });
    const commit = spawnSync('git', ['commit', '--quiet', '-m', 'forge Node verification output'], {
      cwd: repository, encoding: 'utf8',
    });
    assertEqual(commit.status, 0, `Expected fixture commit, output: ${commit.stdout}${commit.stderr}`);
    const fixtureBase = spawnSync('git', ['rev-parse', 'HEAD^'], { cwd: repository, encoding: 'utf8' }).stdout.trim();

    const gate = spawnSync(process.execPath, [
      join(SKILL_DIR, 'scripts', 'review-gate.mjs'), '--profile', 'quick', '--round', '1', '--base', fixtureBase,
    ], {
      cwd: repository,
      encoding: 'utf8',
      timeout: 30000,
      env: { ...process.env, RELEASE_QUALITY_OUTER_SANDBOX_ATTESTED: '1' },
    });
    assertEqual(gate.status, 1, `Expected forged Node Gate rejection, output: ${gate.stdout}${gate.stderr}`);
    assertTrue(gate.stdout.includes('trivial or missing verification scripts'), 'Gate must reject forged Node scripts');

    const outputArg = join('quality-reports', 'round-002', 'evidence', 'clean-candidate.json');
    const output = join(repository, outputArg);
    const clean = spawnSync(process.execPath, [
      join(PROJECT_ROOT, 'scripts', 'verify-clean-candidate.mjs'), '--output', outputArg,
    ], {
      cwd: repository,
      encoding: 'utf8',
      timeout: 30000,
      env: { ...process.env, RELEASE_QUALITY_OUTER_SANDBOX_ATTESTED: '1' },
    });
    assertEqual(clean.status, 1, `Expected forged Node clean-verifier rejection, output: ${clean.stdout}${clean.stderr}`);
    const cleanEvidence = JSON.parse(readFileSync(output, 'utf8'));
    const scriptIntegrity = cleanEvidence.commands.find(command => command.id === 'script-integrity');
    assertEqual(scriptIntegrity?.status, 'fail');
  });

  test('Gate and clean verifier reject masked runner failures with forged summaries', () => {
    const repository = join(TEST_DIR, 'masked-runner-failure-repository');
    const clone = spawnSync('git', ['clone', '--quiet', '--no-local', PROJECT_ROOT, repository], {
      cwd: TEST_DIR, encoding: 'utf8', timeout: 30000,
    });
    assertEqual(clone.status, 0, `Expected fixture clone, output: ${clone.stdout}${clone.stderr}`);
    const manifestPath = join(repository, 'package.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    manifest.scripts.test = 'node --test failing-verifier.test.mjs >/dev/null 2>&1 || node fake-verifier.mjs';
    manifest.scripts.coverage = 'node --experimental-test-coverage --test failing-verifier.test.mjs >/dev/null 2>&1 || node fake-verifier.mjs';
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    writeFileSync(join(repository, 'failing-verifier.test.mjs'),
      "import test from 'node:test';\ntest('fixture fails', () => { throw new Error('expected'); });\n");
    writeFileSync(join(repository, 'fake-verifier.mjs'),
      "console.log('# tests 1\\n# fail 0\\n# start of coverage report');\n");
    spawnSync('git', ['config', 'user.email', 'test@example.invalid'], { cwd: repository, encoding: 'utf8' });
    spawnSync('git', ['config', 'user.name', 'Test'], { cwd: repository, encoding: 'utf8' });
    spawnSync('git', ['add', 'package.json', 'failing-verifier.test.mjs', 'fake-verifier.mjs'], {
      cwd: repository, encoding: 'utf8',
    });
    const commit = spawnSync('git', ['commit', '--quiet', '-m', 'mask runner failure'], {
      cwd: repository, encoding: 'utf8',
    });
    assertEqual(commit.status, 0, `Expected fixture commit, output: ${commit.stdout}${commit.stderr}`);
    const fixtureBase = spawnSync('git', ['rev-parse', 'HEAD^'], { cwd: repository, encoding: 'utf8' }).stdout.trim();

    const gate = spawnSync(process.execPath, [
      join(SKILL_DIR, 'scripts', 'review-gate.mjs'), '--profile', 'quick', '--round', '1', '--base', fixtureBase,
    ], {
      cwd: repository,
      encoding: 'utf8',
      timeout: 30000,
      env: { ...process.env, RELEASE_QUALITY_OUTER_SANDBOX_ATTESTED: '1' },
    });
    assertEqual(gate.status, 1, `Expected masked-failure Gate rejection, output: ${gate.stdout}${gate.stderr}`);
    assertTrue(gate.stdout.includes('trivial or missing verification scripts'), 'Gate must reject masking operators');

    const outputArg = join('quality-reports', 'round-002', 'evidence', 'clean-candidate.json');
    const output = join(repository, outputArg);
    const clean = spawnSync(process.execPath, [
      join(PROJECT_ROOT, 'scripts', 'verify-clean-candidate.mjs'), '--output', outputArg,
    ], {
      cwd: repository,
      encoding: 'utf8',
      timeout: 30000,
      env: { ...process.env, RELEASE_QUALITY_OUTER_SANDBOX_ATTESTED: '1' },
    });
    assertEqual(clean.status, 1, `Expected masked-failure clean rejection, output: ${clean.stdout}${clean.stderr}`);
    const cleanEvidence = JSON.parse(readFileSync(output, 'utf8'));
    const scriptIntegrity = cleanEvidence.commands.find(command => command.id === 'script-integrity');
    assertEqual(scriptIntegrity?.status, 'fail');
  });

  test('keeps blockers.md veto even when result.yaml claims pass', () => {
    const roundNumber = TEST_ROUNDS.veto;
    const round = reportRound(roundNumber);
    const candidateCommit = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: PROJECT_ROOT, encoding: 'utf8' }).stdout.trim();
    const candidateTree = spawnSync('git', ['rev-parse', 'HEAD^{tree}'], { cwd: PROJECT_ROOT, encoding: 'utf8' }).stdout.trim();
    for (const reviewer of ['product-flow', 'architecture-maintainer']) {
      const dir = join(round, reviewer);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'result.yaml'), `reviewer: ${reviewer}\nprofile: quick\nround: ${roundNumber}\ncandidate_commit: ${candidateCommit}\ncandidate_tree: ${candidateTree}\nscore: 100\nstatus: pass\nreview_backend: codex\nreview_model: ${TEST_CODEX_MODEL}\nblockers: []\nredlines: []\n`);
      writeFileSync(join(dir, 'score.md'), `# ${reviewer}\n\n## Overall Score: 100/100\n`);
      writeFileSync(join(dir, 'blockers.md'), reviewer === 'product-flow'
        ? '# Blockers\n\n## P1 — veto must survive\n\nEvidence: reproducible\n'
        : '# Blockers\n\nNo P0/P1 blockers.\n');
      writeFileSync(join(dir, 'improvement-list.md'), '# Improvements\n');
    }
    writeFileSync(join(round, 'review-backend.json'), JSON.stringify({ backend: 'codex', model: TEST_CODEX_MODEL }));
    try {
      const result = spawnSync('node', [
        join(SKILL_DIR, 'scripts', 'review-gate.mjs'), '--profile', 'quick', '--round', String(roundNumber),
        '--no-collect', '--no-validate-evidence',
      ], { cwd: PROJECT_ROOT, encoding: 'utf8' });
      assertEqual(result.status, 1);
      assertTrue(result.stdout.includes('GATE FAILED'), 'Expected a failed gate verdict');
      const summary = readFileSync(join(round, 'summary.md'), 'utf8');
      assertTrue(summary.includes('| product-flow | 100/100 | ❌ FAIL |'), 'Summary must not convert a blocker-bearing score into PASS');
    } finally {
      rmSync(round, { recursive: true, force: true });
    }
  });


});

process.on('exit', () => {
  try { rmSync(TEST_DIR, { recursive: true }); rmdirSync(TEST_ROOT); } catch { /* shared worker cleanup */ }
});
