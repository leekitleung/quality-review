#!/usr/bin/env node
/**
 * Goal Mode Validator
 *
 * Validates that reviewer reports describe WHAT was achieved, not HOW it was implemented.
 * This enforces the "Goal Mode Constraint" - one of the five core principles.
 *
 * Usage:
 *   node goal-mode-validator.mjs --round round-001
 *   node goal-mode-validator.mjs --reviewer destructive-qa --round round-001
 *   node goal-mode-validator.mjs --file quality-reports/round-001/destructive-qa/score.md
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const PROJECT_ROOT = process.cwd();
const SKILL_DIR = join(PROJECT_ROOT, 'skills', 'release-quality-review');

// ANSI colors
const c = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
};

const log = {
  info: (msg) => console.log(`${c.blue}ℹ${c.reset} ${msg}`),
  success: (msg) => console.log(`${c.green}✓${c.reset} ${msg}`),
  warn: (msg) => console.log(`${c.yellow}⚠${c.reset} ${msg}`),
  error: (msg) => console.log(`${c.red}✗${c.reset} ${msg}`),
  title: (msg) => console.log(`\n${c.bright}${c.cyan}═══ ${msg} ═══${c.reset}\n`),
};

function parseArgs(args) {
  let targetRound = null;
  let targetReviewer = null;
  let targetFile = null;
  let verbose = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const takeValue = option => {
      const value = args[i + 1];
      if (!value || value.startsWith('-')) configurationError(`${option} requires a value`);
      i++;
      return value;
    };
    if (arg === '--round') {
      const roundArg = takeValue(arg);
      const match = roundArg.match(/^round-(\d+)$/i);
      targetRound = match ? `round-${match[1].padStart(3, '0')}` : `round-${roundArg.padStart(3, '0')}`;
    } else if (arg === '--reviewer') targetReviewer = takeValue(arg);
    else if (arg === '--file') targetFile = takeValue(arg);
    else if (arg === '--verbose' || arg === '-v') verbose = true;
    else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    } else configurationError(`unknown option: ${arg}`);
  }
  return Object.freeze({ targetRound, targetReviewer, targetFile, verbose });
}

function configurationError(message) {
  console.error(`Configuration error: ${message}`);
  console.error('Use --help for usage.');
  process.exit(4);
}
const options = parseArgs(process.argv.slice(2));

function printHelp() {
  console.log(`
${c.bright}Goal Mode Validator${c.reset}

Validates that reviewer reports describe WHAT was achieved, not HOW.

Usage:
  node goal-mode-validator.mjs --round round-001
  node goal-mode-validator.mjs --reviewer destructive-qa --round round-001
  node goal-mode-validator.mjs --file path/to/score.md

Options:
  --round <name>    Round directory (e.g., round-001)
  --reviewer <name> Specific reviewer to validate
  --file <path>     Validate a specific file
  --verbose, -v     Show detailed violation locations
  --help, -h        Show this help
`);
}

// Pattern-based detection
const GOAL_MODE_VIOLATIONS = [
  // Process descriptions (how)
  { pattern: /按照(步骤|流程|顺序)/g, message: '描述实现过程而非结果', type: 'process' },
  { pattern: /依次|逐步|先(后|来)/g, message: '描述执行顺序而非最终状态', type: 'process' },
  { pattern: /先(执行|调用|读取|写入)/g, message: '描述执行步骤', type: 'process' },
  { pattern: /然后|接下来|之后(再)/g, message: '描述操作顺序', type: 'process' },
  { pattern: /最后(完成|执行)/g, message: '描述流程终点', type: 'process' },
  { pattern: /实现了|完成了|完成了/g, message: '描述实现过程', type: 'process' },
  { pattern: /我们添加|我写的|上面的代码/g, message: '自我验证 - 引用自己的改动', type: 'self_ref' },
  { pattern: /这段代码|该函数|该模块/g, message: '描述代码而非结果', type: 'code_ref' },

  // English process descriptions
  { pattern: /step by step|follows the|proceeds with/g, message: 'Describes execution flow', type: 'process' },
  { pattern: /first, then, finally|after that|once done/g, message: 'Describes sequence', type: 'process' },
  { pattern: /we added|we implemented|we wrote/g, message: 'Self-reference to changes', type: 'self_ref' },
  { pattern: /the code (does|handles|performs)/g, message: 'Describes code behavior, not result', type: 'code_ref' },

  // Implementation-specific patterns
  { pattern: /通过(循环|递归|迭代)/g, message: '描述实现方式', type: 'implementation' },
  { pattern: /使用(了)?(Map|Set|Array|Object)/g, message: '描述数据结构选择', type: 'implementation' },
  { pattern: /采用(策略|模式|算法)/g, message: '描述实现策略', type: 'implementation' },
  { pattern: /调用了|调用了/g, message: '描述函数调用关系', type: 'implementation' },
  { pattern: /导入(了)?|引入了/g, message: '描述依赖引入', type: 'implementation' },
];

// Patterns that indicate proper goal-mode descriptions
const GOAL_MODE_INDICATORS = [
  { pattern: /返回(了)?|返回结果/g, message: '结果导向' },
  { pattern: /成功(完成)?|失败|错误/g, message: '状态描述' },
  { pattern: /数据(格式|结构|类型)/g, message: '数据规范' },
  { pattern: /API|接口|端点/g, message: '接口规范' },
  { pattern: /验证|检查|确认/g, message: '验证行为' },
  { pattern: /满足|符合|通过/g, message: '达标状态' },
  { pattern: /一致(性)?|正确(性)?/g, message: '正确性描述' },
  { pattern: /输出|input|output/g, message: '输入输出规范' },
];

// Severity scoring
const VIOLATION_SEVERITY = {
  process: 5,      // Process description
  self_ref: 10,    // Self-verification
  code_ref: 3,     // Code-centric description
  implementation: 5, // Implementation details
};

/**
 * Extract violations from content
 */
function extractViolations(content, filePath) {
  const violations = [];
  const lines = content.split('\n');

  for (const pattern of GOAL_MODE_VIOLATIONS) {
    let match;
    const regex = new RegExp(pattern.pattern.source, pattern.pattern.flags);
    while ((match = regex.exec(content)) !== null) {
      // Find the line number
      let lineNum = 1;
      let charPos = 0;
      for (let i = 0; i < lines.length; i++) {
        const lineLen = lines[i].length + 1;
        if (charPos + lineLen > match.index) {
          lineNum = i + 1;
          break;
        }
        charPos += lineLen;
      }

      violations.push({
        type: pattern.type,
        message: pattern.message,
        line: lineNum,
        text: match[0],
        severity: VIOLATION_SEVERITY[pattern.type],
        context: lines.slice(Math.max(0, lineNum - 2), lineNum + 1).join('\n'),
      });
    }
  }

  return violations;
}

/**
 * Calculate goal mode score
 */
function calculateGoalModeScore(content, violations) {
  // Base score starts at 100
  let score = 100;

  // Deduct for violations
  for (const v of violations) {
    score -= v.severity;
  }

  // Bonus for goal-mode indicators
  let indicatorCount = 0;
  for (const indicator of GOAL_MODE_INDICATORS) {
    const regex = new RegExp(indicator.pattern.source, indicator.pattern.flags);
    if (regex.test(content)) {
      indicatorCount++;
    }
  }

  // Add up to 5 points for indicators
  score += Math.min(5, indicatorCount);

  // Ensure bounds
  return Math.max(0, Math.min(100, score));
}

/**
 * Validate a single file
 */
function validateFile(filePath) {
  if (!existsSync(filePath)) {
    log.error(`File not found: ${filePath}`);
    return { valid: false, violations: [], score: 0 };
  }

  const content = readFileSync(filePath, 'utf-8');
  const violations = extractViolations(content, filePath);
  const score = calculateGoalModeScore(content, violations);

  return {
    valid: score >= 80, // 80% threshold for goal mode compliance
    violations,
    score,
    lineCount: content.split('\n').length,
  };
}

/**
 * Validate a reviewer's output
 */
function validateReviewer(roundDir, reviewerName) {
  const reviewerDir = join(roundDir, reviewerName);
  const scorePath = join(reviewerDir, 'score.md');

  if (!existsSync(reviewerDir)) {
    return null;
  }

  const result = {
    reviewer: reviewerName,
    scoreMd: null,
    blockersMd: null,
    improvementsMd: null,
    overallScore: 100,
    violations: [],
    passed: true,
  };

  // Validate score.md (main review report)
  if (existsSync(scorePath)) {
    result.scoreMd = validateFile(scorePath);
    result.overallScore = result.scoreMd.score;
    result.violations.push(...result.scoreMd.violations.map(v => ({
      ...v,
      file: 'score.md'
    })));
  }

  // Validate blockers.md
  const blockersPath = join(reviewerDir, 'blockers.md');
  if (existsSync(blockersPath)) {
    result.blockersMd = validateFile(blockersPath);
    // Blockers can be more prescriptive, so lower threshold
    if (result.blockersMd.score < 70) {
      result.violations.push(...result.blockersMd.violations.map(v => ({
        ...v,
        file: 'blockers.md',
        severity: Math.floor(v.severity / 2), // Half severity for blockers
      })));
    }
  }

  // Validate improvement-list.md
  const improvementsPath = join(reviewerDir, 'improvement-list.md');
  if (existsSync(improvementsPath)) {
    result.improvementsMd = validateFile(improvementsPath);
    // Improvements are suggestions, higher tolerance
    if (result.improvementsMd.score < 60) {
      result.violations.push(...result.improvementsMd.violations.map(v => ({
        ...v,
        file: 'improvement-list.md',
        severity: Math.floor(v.severity / 2),
      })));
    }
  }

  // Recalculate overall score with adjusted violations
  result.overallScore = 100 - result.violations.reduce((sum, v) => sum + v.severity, 0);
  result.overallScore = Math.max(0, Math.min(100, result.overallScore));
  result.passed = result.overallScore >= 80;

  return result;
}

/**
 * Main validation
 */
async function main({ targetRound, targetReviewer, targetFile, verbose }) {
  const results = [];

  if (targetFile) {
    // Validate single file
    const absPath = targetFile.startsWith('/') ? targetFile : join(PROJECT_ROOT, targetFile);
    log.title('SINGLE FILE VALIDATION');
    const result = validateFile(absPath);

    if (result.violations.length > 0) {
      log.error(`Found ${result.violations.length} violations`);
      result.violations.forEach((v, i) => {
        console.log(`  ${i + 1}. [${v.type}] Line ${v.line}: ${v.message}`);
        if (verbose) {
          console.log(`     Text: "${v.text}"`);
        }
      });
    } else {
      log.success('No violations found');
    }

    console.log(`\nGoal Mode Score: ${result.score}/100`);
    console.log(`Status: ${result.valid ? c.green + 'PASS' : c.red + 'FAIL'}${c.reset}`);

    process.exit(result.valid ? 0 : 1);
  }

  if (targetRound) {
    const roundDir = join(PROJECT_ROOT, 'quality-reports', targetRound);

    if (!existsSync(roundDir)) {
      log.error(`Round directory not found: ${roundDir}`);
      process.exit(2);
    }

    log.title(`GOAL MODE VALIDATION - ${targetRound}`);

    // Get reviewer directories
    const reviewers = readdirSync(roundDir).filter(name => {
      const dir = join(roundDir, name);
      return statSync(dir).isDirectory();
    });

    if (reviewers.length === 0) {
      log.warn('No reviewer directories found');
      process.exit(0);
    }

    // Filter by specific reviewer if requested
    const targetReviewers = targetReviewer
      ? reviewers.filter(r => r === targetReviewer)
      : reviewers;

    log.info(`Validating ${targetReviewers.length} reviewer(s)`);

    // Validate each reviewer
    let allPassed = true;
    for (const reviewer of targetReviewers) {
      const result = validateReviewer(roundDir, reviewer);
      if (!result) continue;

      results.push(result);

      const status = result.passed ? c.green + '✓' : c.red + '✗';
      console.log(`\n${status} ${reviewer}: ${result.overallScore}/100`);

      if (result.violations.length > 0) {
        allPassed = false;

        // Group violations by type
        const byType = {};
        for (const v of result.violations) {
          if (!byType[v.type]) byType[v.type] = [];
          byType[v.type].push(v);
        }

        for (const [type, violations] of Object.entries(byType)) {
          const totalDeduction = violations.reduce((sum, v) => sum + v.severity, 0);
          console.log(`   [${type}] ${violations.length} violations (-${totalDeduction})`);

          if (verbose) {
            for (const v of violations.slice(0, 3)) {
              console.log(`      Line ${v.line}: ${v.message}`);
            }
            if (violations.length > 3) {
              console.log(`      ... and ${violations.length - 3} more`);
            }
          }
        }
      }
    }

    // Summary
    console.log('\n' + '='.repeat(50));
    const totalViolations = results.reduce((sum, r) => sum + r.violations.length, 0);
    const avgScore = Math.round(results.reduce((sum, r) => sum + r.overallScore, 0) / results.length);

    console.log(`\nGoal Mode Summary:`);
    console.log(`  Reviewers: ${results.length}`);
    console.log(`  Total Violations: ${totalViolations}`);
    console.log(`  Average Score: ${avgScore}/100`);
    console.log(`  Status: ${allPassed ? c.green + 'PASS' : c.red + 'FAIL'}${c.reset}`);

    if (totalViolations > 0 && verbose) {
      console.log('\nTop Violation Types:');
      const typeCounts = {};
      for (const r of results) {
        for (const v of r.violations) {
          typeCounts[v.type] = (typeCounts[v.type] || 0) + 1;
        }
      }
      const sorted = Object.entries(typeCounts).sort((a, b) => b[1] - a[1]);
      for (const [type, count] of sorted.slice(0, 5)) {
        console.log(`  ${type}: ${count}`);
      }
    }

    process.exit(allPassed ? 0 : 1);
  }

  log.error('Please specify --round or --file');
  printHelp();
  process.exit(2);
}

main(options).catch(err => {
  log.error(`Error: ${err.message}`);
  process.exit(2);
});
