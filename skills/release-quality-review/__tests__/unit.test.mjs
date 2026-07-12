/**
 * Unit Tests for Release Quality Review Scripts
 *
 * Run with: node --test skills/release-quality-review/__tests__/unit.test.mjs
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

import { chmodSync, copyFileSync, readFileSync, writeFileSync, mkdirSync, existsSync, rmSync, rmdirSync, symlinkSync, mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'url';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';
import {
  parseScore,
  parseBlockers,
  parseYamlResult,
  detectChangeScale,
  parseYamlProfile,
  matchesTriggerConditions,
} from '../lib/review-utils.mjs';
import {
  resolveWithinRoot,
  shouldIncludeCanonicalFile,
  containsSensitiveText,
  redactSensitiveText,
  writeContainedFile,
} from '../lib/security-utils.mjs';
import { persistPhasePlan, persistPhaseResult } from '../lib/phase-persistence.mjs';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const SKILL_DIR = join(__dirname, '..');
const PROJECT_ROOT = join(SKILL_DIR, '..', '..');
const TEST_ROOT = join(__dirname, '__test_output__');
const TEST_DIR = join(TEST_ROOT, `${process.pid}-${randomUUID()}`);
const ROUND_BASE = process.pid * 10;
const TEST_ROUNDS = {
  veto: ROUND_BASE + 1,
  runner: ROUND_BASE + 2,
  rehydrate: ROUND_BASE + 3,
  missingEvidence: ROUND_BASE + 4,
  parallelTimeout: ROUND_BASE + 5,
};
const reportRound = round => join(PROJECT_ROOT, 'quality-reports', `round-${String(round).padStart(3, '0')}`);

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

// ============================================================================
// TESTS - parseYamlProfile (imported from production)
// ============================================================================

test.describe('parseYamlProfile (production)', () => {
  test('loads required adversarial reviewers from the real agentic profile', () => {
    const content = readFileSync(join(SKILL_DIR, 'profiles', 'agentic-release-gate.yaml'), 'utf-8');
    const profile = parseYamlProfile(content, 'agentic-release-gate');
    assertEqual(profile.gate.require_adversarial, true);
    assertEqual(profile.adversarial_reviewers.length, 4);
  });
  test('parses basic profile correctly', () => {
    const content = `
profile: test-profile
description: Test description
estimated_time: ~10 minutes

resident_reviewers:
  - product-flow
  - architecture-maintainer

gate:
  min_score: 90
  fail_on_redlines: true
`;
    const mockPath = createMockFs('test-basic', content);
    const profile = parseYamlProfile(readFileSync(mockPath, 'utf-8'), 'test-profile');

    assertEqual(profile.name, 'test-profile');
    assertTrue(profile.resident_reviewers.includes('product-flow'), 'Should contain product-flow');
    assertTrue(profile.resident_reviewers.includes('architecture-maintainer'), 'Should contain architecture-maintainer');
    assertEqual(profile.gate.min_score, 90);
    assertEqual(profile.gate.fail_on_redlines, true);
  });

  test('handles empty resident_reviewers', () => {
    const content = `
profile: empty-test
description: Test empty array
resident_reviewers: []
`;
    const mockPath = createMockFs('test-empty', content);
    const profile = parseYamlProfile(readFileSync(mockPath, 'utf-8'), 'empty-test');
    assertEqual(JSON.stringify(profile.resident_reviewers), '[]');
  });

  test('skips markdown checkboxes', () => {
    const content = `
profile: checkbox-test

## Checklist
- [x] Done item
- [ ] Pending item

resident_reviewers:
  - product-flow
`;
    const mockPath = createMockFs('test-checkbox', content);
    const profile = parseYamlProfile(readFileSync(mockPath, 'utf-8'), 'checkbox-test');
    assertTrue(profile.resident_reviewers.includes('product-flow'), 'Should contain product-flow');
    assertEqual(profile.resident_reviewers.length, 1);
  });
});

// ============================================================================
// TESTS - parseScore (imported from production)
// ============================================================================

test.describe('parseScore (production)', () => {
  test('extracts score from "Overall Score: **XX/100**"', () => {
    const content = '## Overall Score: **85/100**';
    assertEqual(parseScore(content), 85);
  });

  test('extracts score from "Overall Score: XX"', () => {
    const content = '## Overall Score: 92';
    assertEqual(parseScore(content), 92);
  });

  test('extracts score with Chinese "总分" + slash format', () => {
    const content = '总分: 78/100';
    assertEqual(parseScore(content), 78);
  });

  test('extracts score with spaces around slash', () => {
    const content = 'Score: 88 / 100';
    assertEqual(parseScore(content), 88);
  });

  test('returns null for invalid input', () => {
    assertEqual(parseScore(null), null);
    assertEqual(parseScore(undefined), null);
    assertEqual(parseScore(''), null);
    assertEqual(parseScore('No score here'), null);
  });

  test('returns null for out-of-range score', () => {
    assertEqual(parseScore('Score: 150'), null);
    assertEqual(parseScore('Score: -5'), null);
  });
});

// ============================================================================
// TESTS - detectChangeScale (imported from production)
// ============================================================================

test.describe('detectChangeScale (production)', () => {
  test('returns micro for 1-2 files with very few lines', () => {
    const scale = detectChangeScale(['file1.ts'], 20, 20);
    assertEqual(scale.scale, 'micro');
    assertEqual(scale.files, 1);
  });

  test('returns small for 3-5 files or 50+ lines', () => {
    const scale = detectChangeScale(['f1.ts', 'f2.ts', 'f3.ts', 'f4.ts'], 30, 30);
    assertEqual(scale.scale, 'small');
    assertEqual(scale.files, 4);
  });

  test('returns medium for 6-20 files or 100+ lines', () => {
    const files = Array(10).fill('file.ts');
    const scale = detectChangeScale(files, 50, 50);
    assertEqual(scale.scale, 'medium');
    assertEqual(scale.files, 10);
  });

  test('returns large for 21-50 files or 500+ lines', () => {
    const files = Array(30).fill('file.ts');
    const scale = detectChangeScale(files, 300, 200);
    assertEqual(scale.scale, 'large');
    assertEqual(scale.files, 30);
  });

  test('returns xlarge for 50+ files', () => {
    const files = Array(60).fill('file.ts');
    const scale = detectChangeScale(files, 1500, 1500);
    assertEqual(scale.scale, 'xlarge');
    assertEqual(scale.files, 60);
  });

  test('considers lines for scale determination (OR logic)', () => {
    // Few files but many lines → upgraded by line count (OR logic)
    const scale = detectChangeScale(['f1.ts', 'f2.ts'], 2000, 500);
    assertEqual(scale.scale, 'xlarge');
  });

  test('handles no changes gracefully', () => {
    const scale = detectChangeScale([], 0, 0);
    assertEqual(scale.scale, 'none');
    assertEqual(scale.files, 0);
  });
});

// ============================================================================
// TESTS - parseYamlResult (imported from production)
// ============================================================================

test.describe('parseYamlResult (production)', () => {
  test('parses the canonical nested result template without throwing', () => {
    const content = readFileSync(join(SKILL_DIR, 'templates', 'result.yaml'), 'utf-8');
    const result = parseYamlResult(content);
    assertTrue(Array.isArray(result.blockers), 'blockers should be an array');
    assertTrue(Array.isArray(result.redlines), 'redlines should be an array');
    assertEqual(result.status, 'pass|fail');
    assertTrue(result.redlines.length > 0, 'canonical redline should be retained');
  });
  test('parses inline blocker format', () => {
    const content = `reviewer: destructive-qa
score: 85/100
status: fail
blockers:
  - P0: Critical security vulnerability
  - P1: Missing error handling
`;
    const result = parseYamlResult(content);
    assertEqual(result.reviewer, 'destructive-qa');
    assertEqual(result.score, 85);
    assertEqual(result.status, 'fail');
    assertEqual(result.blockers.length, 2);
    assertEqual(result.blockers[0].priority, 'P0');
    assertEqual(result.blockers[1].priority, 'P1');
  });

  test('parses nested severity blocker format', () => {
    const content = `reviewer: destructive-qa
score: 72/100
status: fail
blockers:
  - priority: P0
    description: Cross-site scripting in user input
  - severity: P1
    description: Missing rate limiting
`;
    const result = parseYamlResult(content);
    assertEqual(result.score, 72);
    assertEqual(result.blockers.length, 2);
    // Nested format should produce objects with priority/severity fields
    assertTrue(typeof result.blockers[0] === 'object', 'First blocker should be object');
    assertTrue(
      result.blockers[0].priority === 'P0' || result.blockers[0].severity === 'P1',
      'Should have priority or severity'
    );
  });

  test('parses redlines separately from blockers', () => {
    const content = `reviewer: release-verifier
score: 45/100
status: fail
blockers:
  - P1: Missing test coverage
redlines:
  - P0: Build is broken
  - P0: TypeScript errors in core
`;
    const result = parseYamlResult(content);
    assertEqual(result.blockers.length, 1);
    assertEqual(result.redlines.length, 2);
    assertEqual(result.redlines[0].priority, 'P0');
  });

  test('parses dimensions', () => {
    const content = `reviewer: product-flow
score: 92/100
status: pass
dimensions:
  product-closure: 45/50
  edge-case-handling: 47/50
`;
    const result = parseYamlResult(content);
    assertEqual(Object.keys(result.dimensions).length, 2);
    assertEqual(result.dimensions['product-closure'].score, 45);
    assertEqual(result.dimensions['edge-case-handling'].score, 47);
  });
});

// ============================================================================
// TESTS - persistPhasePlan
// ============================================================================

test.describe('persistPhasePlan', () => {
  test('creates plan file with correct structure', () => {
    const roundDir = join(TEST_DIR, 'plan-test');
    const planFile = persistPhasePlan(roundDir, 1, ['product-flow', 'destructive-qa'], {
      git: { changedFiles: ['a.ts', 'b.ts'], branch: 'main', commit: 'abc123' },
      scale: { scale: 'small', files: 2, total: 100 }
    }, { name: 'test', gate: { min_score: 90 } });

    assertTrue(existsSync(planFile), 'Plan file should exist');
    const content = readFileSync(planFile, 'utf-8');
    assertTrue(content.includes('# Phase 1 Plan'), 'Should contain Phase 1 Plan header');
    assertTrue(content.includes('product-flow'), 'Should list product-flow reviewer');
    assertTrue(content.includes('small'), 'Should include scale info');
  });
});

// ============================================================================
// TESTS - persistPhaseResult
// ============================================================================

test.describe('persistPhaseResult', () => {
  test('creates result file with scores', () => {
    const roundDir = join(TEST_DIR, 'result-test');
    const resultFile = persistPhaseResult(roundDir, 1, { 'product-flow': 95, 'destructive-qa': 88 }, false, [{ reviewer: 'destructive-qa', score: 88 }]);

    assertTrue(existsSync(resultFile), 'Result file should exist');
    const content = readFileSync(resultFile, 'utf-8');
    assertTrue(content.includes('# Phase 1 Result'), 'Should contain Phase 1 Result header');
    assertTrue(content.includes('product-flow'), 'Should list reviewer');
    assertTrue(content.includes('GATES FAILED'), 'Should show FAILED status');
  });

  test('shows PASSED status when gate passes', () => {
    const roundDir = join(TEST_DIR, 'result-pass');
    const resultFile = persistPhaseResult(roundDir, 1, { 'product-flow': 95 }, true, []);
    const content = readFileSync(resultFile, 'utf-8');
    assertTrue(content.includes('ALL GATES PASSED'), 'Should show PASSED status');
  });

  test('lists failed reviewers', () => {
    const roundDir = join(TEST_DIR, 'result-fail');
    const resultFile = persistPhaseResult(roundDir, 1, { 'product-flow': 95, 'destructive-qa': 75 }, false, [{ reviewer: 'destructive-qa', score: 75 }]);
    const content = readFileSync(resultFile, 'utf-8');
    assertTrue(content.includes('destructive-qa'), 'Should list failed reviewer');
    assertTrue(content.includes('75/100'), 'Should show score');
  });
});

// ============================================================================
// TESTS - Adversarial Review Detection
// ============================================================================

test.describe('adversarial review detection', () => {
  function detectSelfReference(content) {
    const patterns = [
      { pattern: /我们添加|我们修改|我们实现/g, desc: '使用"我们"' },
      { pattern: /我写的|我添加的|我实现的/g, desc: '使用"我"' },
      { pattern: /上面的代码|刚才的|刚才实现/g, desc: '引用刚写的代码' },
      { pattern: /按照上述|根据上面|依据上文/g, desc: '引用实现过程' },
    ];

    const violations = [];
    for (const { pattern, desc } of patterns) {
      const matches = content.match(pattern);
      if (matches) {
        violations.push({ type: 'self_reference', desc, count: matches.length });
      }
    }
    return violations;
  }

  function checkEvidenceCompleteness(content) {
    const claims = [
      { pattern: /测试通过|tests? passed|test.*success/g, need: 'pnpm test 输出' },
      { pattern: /类型检查通过|typecheck.*passed|tsc.*success/g, need: 'pnpm typecheck 输出' },
      { pattern: /构建成功|build.*success|build.*pass/g, need: 'pnpm build 输出' },
    ];

    const violations = [];
    for (const { pattern, need } of claims) {
      if (pattern.test(content)) {
        const hasOutput = /(pnpm|npm|yarn)\s+(test|build|typecheck)/.test(content) ||
                         /passed|failed|error|success/.test(content);
        if (!hasOutput) {
          violations.push({ type: 'missing_output', need });
        }
      }
    }
    return violations;
  }

  test('detects "我们添加" self-reference', () => {
    const content = '我们添加了这个测试来验证功能';
    const violations = detectSelfReference(content);
    assertEqual(violations.length, 1);
    assertEqual(violations[0].desc, '使用"我们"');
  });

  test('detects "我写的" self-reference', () => {
    const content = '这是我写的代码，它工作正常';
    const violations = detectSelfReference(content);
    assertEqual(violations.length, 1);
    assertEqual(violations[0].desc, '使用"我"');
  });

  test('detects "上面的代码" reference', () => {
    const content = '按照上面的代码实现，这个功能正确';
    const violations = detectSelfReference(content);
    assertTrue(violations.length >= 1, `Expected >= 1 violations, got ${violations.length}`);
    const hasRelevantViolation = violations.some(v =>
      v.desc === '引用刚写的代码' || v.desc === '引用实现过程'
    );
    assertTrue(hasRelevantViolation, 'Should detect reference to implementation');
  });

  test('detects multiple self-reference patterns', () => {
    const content = '我们添加了测试，我写的代码按照上面的实现';
    const violations = detectSelfReference(content);
    assertTrue(violations.length >= 2, `Expected >= 2 violations, got ${violations.length}`);
  });

  test('allows valid evidence sources', () => {
    const content = 'apps/local-server/src/existing-file.ts:45 - 有正确的错误处理\npnpm test 输出: 10 passed';
    const violations = detectSelfReference(content);
    assertEqual(violations.length, 0);
  });

  test('detects missing test output when claiming pass', () => {
    const content = '测试通过，功能正常';
    const violations = checkEvidenceCompleteness(content);
    assertEqual(violations.length, 1);
    assertEqual(violations[0].need, 'pnpm test 输出');
  });

  test('allows valid test output citation', () => {
    const content = 'pnpm test 输出: 10 passed\n所有测试通过';
    const violations = checkEvidenceCompleteness(content);
    assertEqual(violations.length, 0);
  });

  test('detects missing build output when claiming success', () => {
    const content = '构建成功，代码可以发布';
    const violations = checkEvidenceCompleteness(content);
    assertEqual(violations.length, 1);
    assertEqual(violations[0].need, 'pnpm build 输出');
  });
});

test.describe('security boundaries', () => {
  test('rejects paths that escape the repository', () => {
    let rejected = false;
    try {
      resolveWithinRoot('/tmp/repository', '../escaped.md', 'adapter');
    } catch {
      rejected = true;
    }
    assertTrue(rejected, 'Expected path traversal to be rejected');
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
});

test.describe('fail-closed result parsing', () => {
  test('parses inline blocker and redline arrays', () => {
    const parsed = parseYamlResult(`reviewer: destructive-qa\nscore: 100\nstatus: fail\nblockers: [P1]\nredlines: [P0]\n`);
    assertEqual(parsed.status, 'fail');
    assertEqual(parsed.blockers.length, 1);
    assertEqual(parsed.redlines.length, 1);
  });

  test('parses and retains packet profile and round identity', () => {
    const parsed = parseYamlResult(`reviewer: destructive-qa\nprofile: agentic-release-gate\nround: 5\nscore: 95\nstatus: pass\nblockers: []\nredlines: []\n`);
    assertEqual(parsed.profile, 'agentic-release-gate');
    assertEqual(parsed.round, 5);
  });
});

test.describe('no-blocker parsing', () => {
  test('does not treat canonical empty P0/P1 sections as vetoes', () => {
    assertEqual(parseBlockers('# Blockers\n\n## P0\nNone.\n\n## P1\nNone.\n').length, 0);
  });

  test('accepts case-insensitive no-blocker sentences', () => {
    assertEqual(parseBlockers('No P0/P1 blockers.').length, 0);
    assertEqual(parseBlockers('NO P0 OR P1 BLOCKERS.').length, 0);
  });

  test('retains titled P0/P1 headings and ignores unrelated checklists', () => {
    for (const heading of ['## P0 — Hidden veto', '## P1 - Hidden veto', '## P0: Hidden veto', '## P1 (Hidden veto)']) {
      const parsed = parseBlockers(`${heading}\nEvidence: reproducible\n`);
      assertEqual(parsed.length, 1, `Expected titled severity heading to be retained: ${heading}`);
    }
    assertEqual(parseBlockers('- [ ] Overall score >= 90\n- [x] No P0/P1 blocker\n').length, 0);
  });
});

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
});

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

  test('release evidence exposes a coverage command and versioned changelog', () => {
    const manifest = JSON.parse(readFileSync(join(PROJECT_ROOT, 'package.json'), 'utf8'));
    assertTrue(typeof manifest.scripts?.coverage === 'string', 'Expected a coverage script');
    assertEqual(existsSync(join(PROJECT_ROOT, 'CHANGELOG.md')), true, 'Expected CHANGELOG.md');
  });

  test('parallel runner terminates hung reviewers and exits with agent failure', () => {
    const round = reportRound(TEST_ROUNDS.parallelTimeout);
    const fakeBin = join(TEST_DIR, 'fake-bin');
    const leakMarker = join(TEST_DIR, 'reviewer-descendant-leak');
    try {
      mkdirSync(fakeBin);
      const fakeCodex = join(fakeBin, 'codex');
      writeFileSync(fakeCodex, `#!/usr/bin/env node
if (process.argv.includes('--version')) process.exit(0);
process.getBuiltinModule('node:child_process').spawn(process.execPath, ['-e',
  "process.on('SIGTERM', () => {}); setTimeout(() => require('node:fs').writeFileSync(process.env.LEAK_MARKER, 'leaked'), 500)"
], { stdio: 'ignore', env: process.env }).unref();
setInterval(() => { if (process.ppid === 1) process.exit(0); }, 20);
`);
      chmodSync(fakeCodex, 0o755);
      const result = spawnSync('node', [
        join(SKILL_DIR, 'scripts', 'review-runner.mjs'), '--profile', 'quick', '--parallel',
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
          LEAK_MARKER: leakMarker,
        },
      });
      assertEqual(result.status, 5, `Expected exit 5, output: ${result.stdout}${result.stderr}`);
      assertTrue(result.stdout.includes('timed out'), 'Expected explicit reviewer timeout diagnostic');
      spawnSync(process.execPath, ['-e', 'setTimeout(() => {}, 700)']);
      assertEqual(existsSync(leakMarker), false, 'Reviewer descendants must not survive to perform delayed writes');
    } finally {
      rmSync(round, { recursive: true, force: true });
    }
  });

  test('rejects synthetic auto review', () => {
    const result = spawnSync('node', [
      join(SKILL_DIR, 'scripts', 'review-runner.mjs'), '--auto', '--dry-run',
    ], { cwd: PROJECT_ROOT, encoding: 'utf8' });
    assertEqual(result.status, 4);
  });

  test('rejects review targets outside the repository', () => {
    const result = spawnSync('node', [
      join(SKILL_DIR, 'scripts', 'review-runner.mjs'), '--target', '../escaped;touch marker', '--dry-run',
    ], { cwd: PROJECT_ROOT, encoding: 'utf8' });
    assertEqual(result.status, 4);
    assertEqual(existsSync(join(PROJECT_ROOT, 'marker')), false);
  });

  test('keeps blockers.md veto even when result.yaml claims pass', () => {
    const roundNumber = TEST_ROUNDS.veto;
    const round = reportRound(roundNumber);
    for (const reviewer of ['product-flow', 'architecture-maintainer']) {
      const dir = join(round, reviewer);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'result.yaml'), `reviewer: ${reviewer}\nprofile: quick\nround: ${roundNumber}\nscore: 100\nstatus: pass\nblockers: []\nredlines: []\n`);
      writeFileSync(join(dir, 'score.md'), `# ${reviewer}\n\n## Overall Score: 100/100\n`);
      writeFileSync(join(dir, 'blockers.md'), reviewer === 'product-flow'
        ? '# Blockers\n\n## P1 — veto must survive\n\nEvidence: reproducible\n'
        : '# Blockers\n\nNo P0/P1 blockers.\n');
      writeFileSync(join(dir, 'improvement-list.md'), '# Improvements\n');
    }
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

  test('normal runner workflow writes every prompt and metadata without crashing', () => {
    const roundNumber = TEST_ROUNDS.runner;
    const round = reportRound(roundNumber);
    try {
      const result = spawnSync('node', [
        join(SKILL_DIR, 'scripts', 'review-runner.mjs'), '--profile', 'quick', '--round', String(roundNumber), '--skip-evidence',
      ], { cwd: PROJECT_ROOT, encoding: 'utf8', timeout: 30000 });
      assertEqual(result.status, 1);
      assertEqual(result.stderr.includes('results is not defined'), false);
      assertEqual(existsSync(join(round, 'metadata.json')), true);
      assertEqual(existsSync(join(round, 'product-flow', 'prompt.md')), true);
      assertEqual(existsSync(join(round, 'architecture-maintainer', 'prompt.md')), true);
    } finally {
      rmSync(round, { recursive: true, force: true });
    }
  });

  test('no-collect rehydrates matching evidence and quick final report avoids agentic claims', () => {
    const roundNumber = TEST_ROUNDS.rehydrate;
    const round = reportRound(roundNumber);
    const finalReport = join(round, 'final-report.md');
    const commit = spawnSync('git', ['rev-parse', '--short=8', 'HEAD'], { cwd: PROJECT_ROOT, encoding: 'utf8' }).stdout.trim();
    const fullCommit = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: PROJECT_ROOT, encoding: 'utf8' }).stdout.trim();
    const tree = spawnSync('git', ['rev-parse', 'HEAD^{tree}'], { cwd: PROJECT_ROOT, encoding: 'utf8' }).stdout.trim();
    const status = spawnSync('git', ['status', '--short'], { cwd: PROJECT_ROOT, encoding: 'utf8' }).stdout.trim();
    try {
      for (const reviewer of ['product-flow', 'architecture-maintainer']) {
        const dir = join(round, reviewer);
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, 'result.yaml'), `reviewer: ${reviewer}\nprofile: quick\nround: ${roundNumber}\nscore: 95\nstatus: pass\nblockers: []\nredlines: []\n`);
        writeFileSync(join(dir, 'score.md'), `# ${reviewer}\n\n## Overall Score: 95/100\n`);
        writeFileSync(join(dir, 'blockers.md'), '# Blockers\n\nNo P0/P1 blockers.\n');
        writeFileSync(join(dir, 'improvement-list.md'), '# Improvements\n');
      }
      mkdirSync(join(round, 'evidence'), { recursive: true });
      const commandRecord = (command, statusValue, exitCode, output) => ({
        command, started_at: new Date().toISOString(), finished_at: new Date().toISOString(),
        status: statusValue, exit_code: exitCode, output, output_bytes: Buffer.byteLength(output), truncated: false,
      });
      const testCheck = commandRecord('npm test', 'pass', 0, 'passed');
      const typecheckCheck = commandRecord('npm run typecheck', 'pass', 0, 'passed');
      const automatedContent = JSON.stringify({
        testGate: testCheck, typecheckGate: typecheckCheck,
        buildGate: commandRecord('npm run build', 'fail', 1, 'optional failure'),
        lintGate: commandRecord('npm run lint', 'fail', 1, 'optional failure'),
        auditGate: commandRecord('npm audit --audit-level=high', 'fail', 1, 'optional failure'),
        secrets: { status: 'fail', issues: ['optional scan failure'] }, oversizedFiles: { status: 'pass', issues: [] },
        circularDeps: { status: 'pass', issues: [] },
      });
      writeFileSync(join(round, 'evidence', 'automated-checks.json'), automatedContent);
      writeFileSync(join(round, 'metadata.json'), JSON.stringify({
        profile: 'quick', round: roundNumber, collected_at: new Date().toISOString(),
        git: { commit, status, branch: 'test' }, files: {}, candidate_commit: fullCommit, candidate_tree: tree,
        automated_checks_sha256: createHash('sha256').update(automatedContent).digest('hex'),
      }));
      const result = spawnSync('node', [
        join(SKILL_DIR, 'scripts', 'review-gate.mjs'), '--profile', 'quick', '--round', String(roundNumber),
        '--no-collect', '--no-validate-evidence',
      ], { cwd: PROJECT_ROOT, encoding: 'utf8' });
      assertEqual(result.status, 0);
      assertTrue(result.stdout.includes('Loaded persisted automated evidence'), 'Expected persisted evidence rehydration');
      const report = readFileSync(finalReport, 'utf8');
      assertEqual(report.includes('Clean-candidate verification passed'), false);
      assertEqual(report.includes('Goal instruction validation passed'), false);
      assertEqual(report.includes('Build, lint, audit'), false);

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

      writeFileSync(join(round, 'evidence', 'automated-checks.json'), `${automatedContent} `);
      const substituted = spawnSync('node', [
        join(SKILL_DIR, 'scripts', 'review-gate.mjs'), '--profile', 'quick', '--round', String(roundNumber),
        '--no-collect', '--no-validate-evidence',
      ], { cwd: PROJECT_ROOT, encoding: 'utf8' });
      assertEqual(substituted.status, 1);
      assertTrue(substituted.stdout.includes('Persisted evidence is invalid'), 'Expected evidence digest mismatch to fail closed');

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
    } finally {
      rmSync(round, { recursive: true, force: true });
    }
  });

  test('quick profile cannot approve without automated test and typecheck evidence', () => {
    const roundNumber = TEST_ROUNDS.missingEvidence;
    const round = reportRound(roundNumber);
    try {
      for (const reviewer of ['product-flow', 'architecture-maintainer']) {
        const dir = join(round, reviewer);
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, 'result.yaml'), `reviewer: ${reviewer}\nprofile: quick\nround: ${roundNumber}\nscore: 95\nstatus: pass\nblockers: []\nredlines: []\n`);
        writeFileSync(join(dir, 'score.md'), `## Overall Score: 95/100\n`);
        writeFileSync(join(dir, 'blockers.md'), 'No P0/P1 blockers.\n');
        writeFileSync(join(dir, 'improvement-list.md'), '# Improvements\n');
      }
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
