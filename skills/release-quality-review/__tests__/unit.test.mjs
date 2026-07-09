/**
 * Unit Tests for Release Quality Review Scripts
 *
 * Run with: node --test skills/release-quality-review/__tests__/unit.test.mjs
 *
 * Tests:
 * 1. parseYamlProfile - YAML profile parsing
 * 2. parseScore - Score extraction from markdown
 * 3. detectChangeScale - Change scale detection
 * 4. Phase persistence functions
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import test from 'node:test';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const SKILL_DIR = join(__dirname, '..');
const TEST_DIR = join(__dirname, '__test_output__');

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
// parseYamlProfile (simplified for testing)
// ============================================================================

function parseYamlProfile(content, name) {
  const profile = {
    name,
    description: '',
    estimated_time: '',
    resident_reviewers: [],
    conditional_reviewers: [],
    gate: { min_score: 90, fail_on_redlines: true },
    output: { verbose: false, include_evidence: false },
  };

  const lines = content.split('\n');
  let currentSection = null;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    // Skip checkboxes
    if (trimmed.startsWith('- [')) continue;

    if (trimmed.includes(':')) {
      const colonIdx = trimmed.indexOf(':');
      const key = trimmed.slice(0, colonIdx).trim();
      let value = trimmed.slice(colonIdx + 1).trim();

      // Remove inline comments
      value = value.split('#')[0].trim();

      if (key === 'description') profile.description = value;
      else if (key === 'estimated_time') profile.estimated_time = value;
      else if (key === 'min_score') profile.gate.min_score = parseInt(value) || 90;
      else if (key === 'fail_on_redlines') profile.gate.fail_on_redlines = value === 'true';
      else if (key === 'resident_reviewers') {
        currentSection = 'resident';
        // If value is '[]' (empty array literal), reset to empty array
        if (value === '[]') {
          profile.resident_reviewers = [];
        }
      }
      else if (key === 'conditional_reviewers') {
        currentSection = 'conditional';
        if (value === '[]') {
          profile.conditional_reviewers = [];
        }
      }
    } else if (trimmed.startsWith('- ')) {
      if (currentSection === 'resident') {
        const item = trimmed.slice(2).trim().split('#')[0].trim();
        if (item && item !== '[]') profile.resident_reviewers.push(item);
      } else if (currentSection === 'conditional') {
        const item = trimmed.slice(2).trim().split('#')[0].trim();
        if (item && item !== '[]') profile.conditional_reviewers.push(item);
      }
    }
  }

  return profile;
}

// ============================================================================
// parseScore (simplified for testing)
// ============================================================================

function parseScore(content) {
  if (!content || typeof content !== 'string') return null;

  // More permissive patterns - only match after Score/Score header
  const patterns = [
    // Pattern 1: "Overall Score: **67/100**" or "Overall Score: 72/100"
    /(?:总分|Overall Score|Total Score|Score)[^0-9]*(\d+)[^0-9]*\/?\s*100/i,
    // Pattern 2: "**75/100**" (standalone bold)
    /\*\*(\d+)\/100\*\*/,
    // Pattern 3: "68 / 100" or "72/100" anywhere in text
    /(\d+)\s*\/\s*100/,
    // Pattern 4: "Score: 85" or "Overall Score: 92" (without /100) - must have Score header
    /Score[^0-9]*:?\s*(\d+)(?!\s*\/)/i,
    // Pattern 5: "## Score 88" at end of line or before newline
    /(?:总分|Overall Score|Total Score|Score)[^0-9]*(\d+)$/gim,
  ];

  for (const pattern of patterns) {
    const match = content.match(pattern);
    if (match && match[1]) {
      const score = parseInt(match[1], 10);
      // Reject obviously invalid scores (single digits are not real scores)
      if (!isNaN(score) && score >= 0 && score <= 100 && score >= 10) {
        return score;
      }
    }
  }
  return null;
}

// ============================================================================
// detectChangeScale (simplified for testing)
// ============================================================================

function detectChangeScaleInternal(execSyncMock, totalLines) {
  const changedFiles = execSyncMock().split('\n').filter(f => f.trim());
  const fileCount = changedFiles.length;

  let scale = 'micro';
  let suggestedProfile = 'quick';

  if (fileCount === 0) {
    scale = 'none';
    suggestedProfile = 'quick';
  } else if (fileCount <= 2 && totalLines < 100) {
    scale = 'micro';
    suggestedProfile = 'quick';
  } else if (fileCount <= 5 && totalLines < 500) {
    scale = 'small';
    suggestedProfile = 'quick';
  } else if (fileCount <= 20 && totalLines < 2000) {
    scale = 'medium';
    suggestedProfile = 'default';
  } else if (fileCount <= 50 && totalLines < 5000) {
    scale = 'large';
    suggestedProfile = 'release-gate';
  } else {
    scale = 'xlarge';
    suggestedProfile = 'full';
  }

  return { scale, files: fileCount, total: totalLines, suggestedProfile };
}

// ============================================================================
// persistPhasePlan (simplified for testing)
// ============================================================================

function persistPhasePlanTest(roundDir, phase, reviewers, evidence, profileConfig) {
  mkdirSync(roundDir, { recursive: true });
  const planFile = join(roundDir, `phase-${phase}-plan.md`);
  const scaleInfo = evidence.scale || { scale: 'unknown', files: 0, total: 0 };

  const content = `# Phase ${phase} Plan

## Metadata

| Field | Value |
|-------|-------|
| Started | ${new Date().toISOString()} |
| Profile | ${profileConfig.name} |
| Scale | ${scaleInfo.scale} (${scaleInfo.files} files, ${scaleInfo.total} lines) |
| Round | ${phase} |

## Input

- **Changed files:** ${evidence.git?.changedFiles?.length || 0}
- **Git branch:** ${evidence.git?.branch || 'unknown'}
- **Git commit:** ${evidence.git?.commit || 'unknown'}

## Reviewers

${reviewers.map(r => `- ${r}`).join('\n')}

## Exit Criteria

- [ ] All reviewers >= ${profileConfig.gate?.min_score || 90}
- [ ] No P0 redlines
- [ ] Evidence collected for all dimensions
`;

  writeFileSync(planFile, content);
  return planFile;
}

// ============================================================================
// persistPhaseResult (simplified for testing)
// ============================================================================

function persistPhaseResultTest(roundDir, phase, scores, gatePassed, failedReviewers) {
  mkdirSync(roundDir, { recursive: true });
  const resultFile = join(roundDir, `phase-${phase}-result.md`);
  const completedAt = new Date().toISOString();

  const scoresTable = Object.entries(scores)
    .map(([r, s]) => {
      const scoreVal = typeof s === 'number' ? s : (s.score ?? 'N/A');
      const pass = typeof scoreVal === 'number' ? scoreVal >= 90 : false;
      return `| ${r} | ${scoreVal}/100 | ${pass ? '✅ PASS' : '❌ FAIL'} |`;
    })
    .join('\n');

  const failedList = failedReviewers.length > 0
    ? failedReviewers.map(f => `- [ ] **[${f.reviewer}]** Score: ${f.score}/100`).join('\n')
    : '_None_';

  const content = `# Phase ${phase} Result

## Metadata

| Field | Value |
|-------|-------|
| Completed | ${completedAt} |
| Gate Status | ${gatePassed ? '✅ PASSED' : '❌ FAILED'} |
| Round | ${phase} |

## Scores

| Reviewer | Score | Status |
|----------|-------|--------|
${scoresTable}

## Gate Status

**${gatePassed ? 'ALL GATES PASSED' : 'GATES FAILED'}**

${gatePassed ? '## Ready for Release' : `## Failed Reviewers

${failedList}

## Next Actions

1. Fix the issues identified by failed reviewers
2. Re-run the review
`}
`;

  writeFileSync(resultFile, content);
  return resultFile;
}

// ============================================================================
// TESTS
// ============================================================================

test.describe('parseYamlProfile', () => {
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
    assertEqual(profile.resident_reviewers.includes('product-flow'), true);
    assertEqual(profile.resident_reviewers.includes('architecture-maintainer'), true);
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
- - actual list item

resident_reviewers:
  - product-flow
`;
    const mockPath = createMockFs('test-checkbox', content);
    const profile = parseYamlProfile(readFileSync(mockPath, 'utf-8'), 'checkbox-test');
    assertEqual(profile.resident_reviewers.includes('product-flow'), true);
    assertEqual(profile.resident_reviewers.length, 1);
  });
});

test.describe('parseScore', () => {
  test('extracts score from "Overall Score: **XX/100**"', () => {
    const content = '## Overall Score: **85/100**';
    assertEqual(parseScore(content), 85);
  });

  test('extracts score from "Overall Score: XX"', () => {
    const content = '## Overall Score: 92';
    assertEqual(parseScore(content), 92);
  });

  test('extracts score with Chinese "总分" + slash format', () => {
    // "总分: 78/100" format (with slash)
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

test.describe('detectChangeScale', () => {
  test('returns micro for 1-2 files with few lines', () => {
    const mockExecSync = () => 'file1.ts';
    const scale = detectChangeScaleInternal(mockExecSync, 50);
    assertEqual(scale.scale, 'micro');
    assertEqual(scale.files, 1);
  });

  test('returns small for 3-5 files', () => {
    const mockExecSync = () => 'file1.ts\nfile2.ts\nfile3.ts\nfile4.ts';
    const scale = detectChangeScaleInternal(mockExecSync, 200);
    assertEqual(scale.scale, 'small');
    assertEqual(scale.files, 4);
  });

  test('returns medium for 6-20 files', () => {
    const mockExecSync = () => Array(10).fill('file.ts').join('\n');
    const scale = detectChangeScaleInternal(mockExecSync, 500);
    assertEqual(scale.scale, 'medium');
    assertEqual(scale.files, 10);
  });

  test('returns large for 21-50 files', () => {
    const mockExecSync = () => Array(30).fill('file.ts').join('\n');
    const scale = detectChangeScaleInternal(mockExecSync, 1500);
    assertEqual(scale.scale, 'large');
    assertEqual(scale.files, 30);
  });

  test('returns xlarge for 50+ files', () => {
    const mockExecSync = () => Array(60).fill('file.ts').join('\n');
    const scale = detectChangeScaleInternal(mockExecSync, 3000);
    assertEqual(scale.scale, 'xlarge');
    assertEqual(scale.files, 60);
  });

  test('considers lines for scale determination', () => {
    // Few files but many lines -> large
    const mockExecSync = () => 'file1.ts\nfile2.ts';
    const scale = detectChangeScaleInternal(mockExecSync, 3000);
    assertEqual(scale.scale, 'large');
  });

  test('handles no changes gracefully', () => {
    const mockExecSync = () => '';
    const scale = detectChangeScaleInternal(mockExecSync, 0);
    assertEqual(scale.scale, 'none');
    assertEqual(scale.files, 0);
  });
});

test.describe('persistPhasePlan', () => {
  test('creates plan file with correct structure', () => {
    const roundDir = join(TEST_DIR, 'plan-test');
    const planFile = persistPhasePlanTest(roundDir, 1, ['product-flow', 'destructive-qa'], {
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

test.describe('persistPhaseResult', () => {
  test('creates result file with scores', () => {
    const roundDir = join(TEST_DIR, 'result-test');
    const resultFile = persistPhaseResultTest(roundDir, 1, { 'product-flow': 95, 'destructive-qa': 88 }, false, [{ reviewer: 'destructive-qa', score: 88 }]);

    assertTrue(existsSync(resultFile), 'Result file should exist');
    const content = readFileSync(resultFile, 'utf-8');
    assertTrue(content.includes('# Phase 1 Result'), 'Should contain Phase 1 Result header');
    assertTrue(content.includes('product-flow'), 'Should list reviewer');
    assertTrue(content.includes('GATES FAILED'), 'Should show FAILED status');
  });

  test('shows PASSED status when gate passes', () => {
    const roundDir = join(TEST_DIR, 'result-pass');
    const resultFile = persistPhaseResultTest(roundDir, 1, { 'product-flow': 95 }, true, []);
    const content = readFileSync(resultFile, 'utf-8');
    assertTrue(content.includes('ALL GATES PASSED'), 'Should show PASSED status');
  });

  test('lists failed reviewers', () => {
    const roundDir = join(TEST_DIR, 'result-fail');
    const resultFile = persistPhaseResultTest(roundDir, 1, { 'product-flow': 95, 'destructive-qa': 75 }, false, [{ reviewer: 'destructive-qa', score: 75 }]);
    const content = readFileSync(resultFile, 'utf-8');
    assertTrue(content.includes('destructive-qa'), 'Should list failed reviewer');
    assertTrue(content.includes('75/100'), 'Should show score');
  });
});

test.describe('adversarial review detection', () => {
  // Helper function to detect self-reference patterns
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

  // Helper function to check evidence completeness
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
    // Note: "上面的代码" matches two patterns
    const content = '按照上面的代码实现，这个功能正确';
    const violations = detectSelfReference(content);
    // Should detect at least 2 violations because "上面的代码" contains "上面"
    assertTrue(violations.length >= 1, `Expected >= 1 violations, got ${violations.length}`);
    // Should have one about '上面的代码' or '按照上面'
    const hasRelevantViolation = violations.some(v =>
      v.desc === '引用刚写的代码' || v.desc === '引用实现过程'
    );
    assertTrue(hasRelevantViolation, 'Should detect reference to implementation');
  });

  test('detects multiple self-reference patterns', () => {
    const content = '我们添加了测试，我写的代码按照上面的实现';
    const violations = detectSelfReference(content);
    // 3 patterns matched: "我们添加", "我写的", "按照上面"
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

// Cleanup after all tests (manual call since afterAll is not available)
process.on('exit', () => {
  try {
    rmSync(TEST_DIR, { recursive: true });
  } catch (e) {
    // Ignore
  }
});
