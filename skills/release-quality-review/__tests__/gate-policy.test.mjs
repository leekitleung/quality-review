/**
 * Gate Policy Integration Tests
 *
 * Note: These tests use POSIX shell fixtures (/usr/bin/env sh).
 * On Windows, use WSL2 for full test coverage.
 */

import { platform } from 'node:process';

if (platform === 'win32') {
  console.log('Skipping gate-policy tests on Windows - requires POSIX shell (use WSL2)');
  process.exit(0);
}

import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, rmdirSync, utimesSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { resolveReportDirectory } from '../lib/security-utils.mjs';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const SKILL_DIR = join(__dirname, '..');
const PROJECT_ROOT = join(SKILL_DIR, '..', '..');
const TEST_ROOT = join(tmpdir(), 'release-quality-review-gate-tests');
const TEST_DIR = join(TEST_ROOT, `${process.pid}-${randomUUID()}`);
const TEST_CODEX_MODEL = 'gpt-test-review';
const ROUND_BASE = process.pid * 20;
const TEST_ROUNDS = {
  evidenceForgery: ROUND_BASE + 7,
  veto: ROUND_BASE + 11,
};
const reportRound = round => join(
  resolveReportDirectory(PROJECT_ROOT),
  `round-${String(round).padStart(3, '0')}`,
);
const runnerRound = round => {
  const dir = reportRound(round);
  const commit = spawnSync('git', ['rev-parse', 'HEAD'], {
    cwd: PROJECT_ROOT, encoding: 'utf8',
  }).stdout.trim();
  const tree = spawnSync('git', ['rev-parse', 'HEAD^{tree}'], {
    cwd: PROJECT_ROOT, encoding: 'utf8',
  }).stdout.trim();
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'metadata.json'), JSON.stringify({
    profile: 'quick', round, collected_at: new Date().toISOString(),
    reviewers: ['product-flow', 'architecture-maintainer'],
    candidate_commit: commit, candidate_tree: tree, base_commit: commit, base_tree: tree,
    git: { branch: 'test', commit: commit.slice(0, 8), status: '', changedFiles: [] },
    files: {}, scale: { scale: 'none', files: 0, total: 0 },
  }));
  mkdirSync(join(dir, 'evidence'), { recursive: true });
  writeFileSync(join(dir, 'evidence', 'automated-checks.json'), JSON.stringify({
    testGate: {
      command: 'npm test', status: 'pass', exit_code: 0,
      output: '# tests 1\\n# pass 1\\n# fail 0',
    },
    typecheckGate: {
      command: 'npm run typecheck', status: 'pass', exit_code: 0,
      output: 'node --check scripts/review-gate.mjs',
    },
  }));
  return dir;
};

function assertEqual(actual, expected, message) {
  if (actual !== expected) throw new Error(`${message || 'Values differ'}: expected ${expected}, got ${actual}`);
}

function assertTrue(condition, message) {
  if (!condition) throw new Error(message);
}

function installCleanStatusGitWrapper(binDir) {
  const systemGit = spawnSync('/usr/bin/env', ['sh', '-c', 'command -v git'], {
    encoding: 'utf8',
  }).stdout.trim();
  const wrapper = join(binDir, 'git');
  writeFileSync(wrapper, `#!/bin/sh
if [ "\$1" = "status" ] && [ "\$2" = "--short" ]; then exit 0; fi
exec ${JSON.stringify(systemGit)} "\$@"
`);
  chmodSync(wrapper, 0o755);
}

mkdirSync(TEST_DIR, { recursive: true });
const cleanGitBin = join(TEST_DIR, 'clean-git-bin');
mkdirSync(cleanGitBin, { recursive: true });
installCleanStatusGitWrapper(cleanGitBin);
process.env.PATH = `${cleanGitBin}:${process.env.PATH}`;

test.describe('Gate policy integration', () => {
  test('retention enforcement deletes only confirmed expired round directories and audits the action', () => {
    const repository = join(TEST_DIR, `retention-${randomUUID()}`);
    const reportRoot = join(repository, 'quality-reports');
    const expired = join(reportRoot, 'round-001');
    const current = join(reportRoot, 'round-002');
    mkdirSync(expired, { recursive: true });
    mkdirSync(current, { recursive: true });
    const old = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
    utimesSync(expired, old, old);
    const script = join(PROJECT_ROOT, 'scripts', 'check-report-retention.mjs');

    const audit = spawnSync(process.execPath, [script, '--days', '30'], { cwd: repository, encoding: 'utf8' });
    assertEqual(audit.status, 1, `${audit.stdout}${audit.stderr}`);
    assertEqual(existsSync(expired), true, 'Non-destructive audit removed an expired round');

    const unconfirmed = spawnSync(process.execPath, [script, '--days', '30', '--delete'], {
      cwd: repository, encoding: 'utf8',
    });
    assertEqual(unconfirmed.status, 4, `${unconfirmed.stdout}${unconfirmed.stderr}`);
    assertEqual(existsSync(expired), true, 'Unconfirmed retention command removed a round');

    const enforced = spawnSync(process.execPath, [
      script, '--days', '30', '--delete', '--confirm', 'DELETE-EXPIRED-ROUNDS',
    ], { cwd: repository, encoding: 'utf8' });
    assertEqual(enforced.status, 0, `${enforced.stdout}${enforced.stderr}`);
    assertEqual(existsSync(expired), false, 'Confirmed expired round was not deleted');
    assertEqual(existsSync(current), true, 'Current round must be retained');
    const auditRecord = JSON.parse(readFileSync(join(reportRoot, 'retention-audit.jsonl'), 'utf8').trim());
    assertEqual(JSON.stringify(auditRecord.deleted_rounds), JSON.stringify(['round-001']));
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
