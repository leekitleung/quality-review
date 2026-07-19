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

test('reviewer timeout accounts for canonical scale and locked reasoning effort', () => {
  const base = 15 * 60 * 1000;
  assertEqual(calculateReviewerTimeout(base, 'medium', 'low').timeoutMs, base);
  const highAssurance = calculateReviewerTimeout(base, 'large', 'max');
  assertEqual(highAssurance.scaleMultiplier, 1.5);
  assertEqual(highAssurance.effortMultiplier, 2);
  assertEqual(highAssurance.timeoutMs, 45 * 60 * 1000);
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
  test('parses the canonical exact result template without throwing', () => {
    const content = readFileSync(join(SKILL_DIR, 'templates', 'result.yaml'), 'utf-8');
    const result = parseYamlResult(content);
    assertTrue(Array.isArray(result.blockers), 'blockers should be an array');
    assertTrue(Array.isArray(result.redlines), 'redlines should be an array');
    assertEqual(result.status, 'pass|fail');
    assertEqual(result.blockers.length, 0);
    assertEqual(result.redlines.length, 0);
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
review_backend: codex
review_model: gpt-test-review
blockers: []
redlines: []
`;
  test('accepts only the exact 11-field packet', () => {
    assertEqual(validateResultYamlContract(canonical).valid, true);
  });
  test('rejects duplicate, slash-form, nested, and non-lowercase machine fields', () => {
    for (const invalid of [
      `${canonical}score: 96\n`,
      canonical.replace('score: 95', 'score: 95/100'),
      canonical.replace('score: 95', 'score:\n  total: 95'),
      canonical.replace('status: pass', 'status: PASS'),
      canonical.replace('review_backend: codex', 'review_backend: claude-code'),
      canonical.replace('review_model: gpt-test-review', 'review_model: model with spaces'),
    ]) assertEqual(validateResultYamlContract(invalid).valid, false);
  });
  test('rejects reordered required fields and unknown top-level fields', () => {
    const reversed = canonical.split('\n').slice(0, 7).reverse().join('\n');
    assertEqual(validateResultYamlContract(`${reversed}\n`).valid, false);
    assertEqual(validateResultYamlContract(canonical.replace('profile:', 'unexpected_authority: trusted\nprofile:')).valid, false);
    for (const field of ['summary', 'dimensions', 'evidence', 'notes', 'verdict']) {
      assertEqual(validateResultYamlContract(`${canonical}${field}: unsupported\n`).valid, false);
    }
  });
  test('requires status to match score and veto findings', () => {
    assertEqual(validateResultYamlContract(canonical.replace('score: 95', 'score: 89')).valid, false);
    assertEqual(validateResultYamlContract(canonical.replace('status: pass', 'status: fail')).valid, false);
    assertEqual(validateResultYamlContract(canonical
      .replace('status: pass', 'status: fail')
      .replace('blockers: []', 'blockers:\n  - P1-TEST')).valid, true);
  });
});

test.describe('Radar reviewer model selection', () => {
  const now = new Date('2026-07-17T12:00:00+08:00');
  const entry = (model, effort, score, cost = 10, wall = 1000, recent = [score]) => ({
    model,
    label: `${model} ${effort}`,
    latest: {
      model, reasoning_effort: effort, score, valid_tasks: 10,
      cost_usd: cost, wall_seconds: wall,
    },
    recent_days: recent.map(value => ({ score: value })),
  });

  test('prefers an IQ-qualified lightweight Codex model', () => {
    const snapshot = radarSnapshot({
      heavy: entry('gpt-heavy', 'max', 150),
      light: entry('gpt-light', 'low', 120),
      medium: entry('gpt-medium', 'medium', 110),
      claude: entry('claude-opus', 'high', 200),
    });
    assertEqual(extractRadarCandidates(snapshot).length, 3);
    const selected = selectRadarReviewerModel(snapshot, { now });
    assertEqual(selected.model, 'gpt-light');
    assertEqual(selected.reasoningEffort, 'low');
    assertEqual(selected.selection.mode, 'radar-lightweight-qualified');
    assertEqual(selected.selection.target_met, true);
  });

  test('uses a qualified non-lightweight model when no lightweight model qualifies', () => {
    const selected = selectRadarReviewerModel(radarSnapshot({
      light: entry('gpt-light', 'low', 95),
      high: entry('gpt-high', 'high', 120),
    }), { now });
    assertEqual(selected.model, 'gpt-high');
    assertEqual(selected.selection.mode, 'radar-qualified-highest');
  });

  test('uses the highest IQ model for high-assurance profiles', () => {
    const selected = selectRadarReviewerModel(radarSnapshot({
      light: entry('gpt-light', 'low', 120),
      heavy: entry('gpt-heavy', 'max', 150),
    }), { now, preferLightweight: false });
    assertEqual(selected.model, 'gpt-heavy');
    assertEqual(selected.selection.mode, 'radar-high-assurance-highest');
    assertEqual(selected.selection.review_tier, 'high-assurance');
  });

  test('uses the highest score when every candidate is at or below IQ 100', () => {
    const selected = selectRadarReviewerModel(radarSnapshot({
      low: entry('gpt-low', 'low', 90),
      high: entry('gpt-high', 'high', 100),
      medium: entry('gpt-medium', 'medium', 95),
    }), { now });
    assertEqual(selected.model, 'gpt-high');
    assertEqual(selected.selection.mode, 'radar-highest-score-fallback');
    assertEqual(selected.selection.target_met, false);
  });

  test('breaks equal-score ties by recent stability, effort, cost, and model id', () => {
    const selected = selectRadarReviewerModel(radarSnapshot({
      unstable: entry('gpt-unstable', 'low', 110, 1, 100, [40, 80, 110]),
      stable: entry('gpt-stable', 'low', 110, 20, 2000, [110, 110, 110]),
    }), { now });
    assertEqual(selected.model, 'gpt-stable');
  });

  test('rejects stale snapshots and malformed candidate identities', () => {
    let staleError = '';
    try {
      selectRadarReviewerModel(radarSnapshot({}, '2026-07-01T00:00:00Z'), { now });
    } catch (error) {
      staleError = error.message;
    }
    assertTrue(staleError.includes('stale'));
    for (const latest of [
      { model: 'gpt-low-sample', reasoning_effort: 'low', score: 150, valid_tasks: 9 },
      { model: 'gpt-missing-sample', reasoning_effort: 'low', score: 150 },
      { model: 'gpt-invalid-effort', reasoning_effort: 'extreme', score: 150, valid_tasks: 10 },
      { model: 'gpt-control\u001b]0;title\u0007', reasoning_effort: 'low', score: 150, valid_tasks: 10 },
    ]) {
      let candidateError = '';
      try {
        selectRadarReviewerModel(radarSnapshot({ bad: { model: latest.model, latest } }), { now });
      } catch (error) {
        candidateError = error.message;
      }
      assertTrue(candidateError.includes('no usable Codex model'), JSON.stringify(latest));
    }
  });

  test('fetches, hashes, and validates the online Radar response', async () => {
    const body = JSON.stringify(radarSnapshot({
      valid: entry('gpt-online', 'medium', 120),
    }, now.toISOString()));
    const selected = await fetchRadarReviewerModel({
      now,
      fetchImpl: async () => ({ ok: true, text: async () => body }),
    });
    assertEqual(selected.model, 'gpt-online');
    assertEqual(selected.selection.snapshot_sha256, createHash('sha256').update(body).digest('hex'));

    for (const [fetchImpl, expected] of [
      [async () => { throw new Error('offline'); }, 'Radar request failed: offline'],
      [async () => ({ ok: false, status: 503 }), 'HTTP 503'],
      [async () => ({ ok: true, text: async () => { throw new Error('body failed'); } }), 'body failed'],
      [async () => ({ ok: true, text: async () => '{invalid' }), 'not valid JSON'],
    ]) {
      await assertRejects(
        fetchRadarReviewerModel({ now, fetchImpl }),
        expected,
      );
    }
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
  checks.circularDeps = { status: 'warn', issues: ['a.mjs -> b.mjs -> a.mjs'] };
  assertEqual(strictAutomatedChecksPassed(checks, true), false);
  checks.circularDeps = { status: 'warn', issues: ['circular dependency scan encountered error'] };
  assertEqual(strictAutomatedChecksPassed(checks, true), false);
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

test('phase score extraction uses the strict result packet, not score.md display text', () => {
  const roundDir = join(TEST_DIR, 'phase-result-score-source');
  const reviewerDir = join(roundDir, 'product-flow');
  mkdirSync(reviewerDir, { recursive: true });
  writeFileSync(join(reviewerDir, 'result.yaml'), [
    'reviewer: product-flow',
    'profile: quick',
    'round: 1',
    `candidate_commit: ${'1'.repeat(40)}`,
    `candidate_tree: ${'2'.repeat(40)}`,
    'score: 95',
    'status: pass',
    'review_backend: codex',
    `review_model: ${TEST_CODEX_MODEL}`,
    'blockers: []',
    'redlines: []',
    '',
  ].join('\n'));
  writeFileSync(join(reviewerDir, 'score.md'), '## 总分: 12/100\n');

  assertEqual(JSON.stringify(extractResultScoresFromRound(roundDir)), JSON.stringify([
    { reviewer: 'product-flow', score: 95 },
  ]));
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

  test('accepts TAP summary labels without comment prefixes', () => {
    const content = 'Command: npm test\nExit code: 0\nOutput: TAP version 13; tests 132; pass 132; fail 0\n测试通过';
    assertEqual(extractCommandEvidence(content).length, 1);
    assertTrue(extractTestOutputs(content).includes('tests 132'));
    assertEqual(checkMissingEvidenceOutput(content).length, 0);
  });

  test('accepts TAP ok-count output summaries', () => {
    const content = 'Command: npm test\nExit code: 0\nOutput: TAP version 13; 174 ok\n所有测试通过';
    assertEqual(extractCommandEvidence(content).length, 1);
    assertEqual(checkMissingEvidenceOutput(content).length, 0);
  });

  test('rejects failed TAP output even when it includes ok counts', () => {
    const outputs = [
      '174 ok; # fail 1; not ok 175',
      '174 ok; # fail 10',
      '174 ok; 10 failed',
      '174 ok; failed: 12',
    ];
    for (const output of outputs) {
      const content = `Command: npm test\nExit code: 0\nOutput: ${output}`;
      assertEqual(extractCommandEvidence(content).length, 0);
    }
  });

  test('accepts node syntax-check output as concrete command evidence', () => {
    const content = 'Command: npm run typecheck\nExit code: 0\nOutput: node --check scripts/review-gate.mjs';
    assertEqual(extractCommandEvidence(content).length, 1);
    assertEqual(checkMissingEvidenceOutput(`${content}\ntypecheck passed`).length, 0);
  });

  test('accepts strict YAML command evidence packets', () => {
    const content = 'command: "npm test"\nexit_code: 0\noutput_summary: "# tests 25; # pass 25; # fail 0"';
    assertEqual(extractCommandEvidence(content).length, 1);
  });

  test('rejects YAML evidence for commands outside the shared verification set', () => {
    const content = 'command: "echo green"\nexit_code: 0\noutput_summary: "# tests 25; # pass 25; # fail 0"';
    assertEqual(extractCommandEvidence(content).length, 0);
  });

  test('rejects prose evidence for commands outside the shared verification set', () => {
    const content = 'Command: echo green\nExit code: 0\nOutput: # tests 25; # pass 25; # fail 0';
    assertEqual(extractCommandEvidence(content).length, 0);
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

process.on('exit', () => {
  try {
    rmSync(TEST_DIR, { recursive: true });
    rmdirSync(TEST_ROOT);
  } catch {
    // Another test worker may still own the shared parent.
  }
});
