#!/usr/bin/env node
/**
 * Goal Instruction Gate - Validates /goal directive compliance
 *
 * Checks if a goal instruction follows the correct format:
 * - Describes final state, not implementation steps
 * - Contains verifiable completion criteria
 * - Has explicit boundaries (forbidden changes)
 * - Requires evidence in final output
 * - Includes stop conditions
 *
 * Usage:
 *   node goal-instruction-gate.mjs --input "/goal ..."
 *   node goal-instruction-gate.mjs --file goal.md
 *   node goal-instruction-gate.mjs --check-round round-001
 *   cat generated-goal.md | node goal-instruction-gate.mjs --stdin
 */

import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = process.cwd();

// ANSI colors
const c = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  dim: '\x1b[2m',
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
};

// Parse arguments
const args = process.argv.slice(2);
let goalText = null;
let filePath = null;
let roundNumber = null;
let stdin = false;

for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === '--input' && args[i + 1]) {
    goalText = args[++i];
  } else if (arg === '--file' && args[i + 1]) {
    filePath = args[++i];
  } else if (arg === '--check-round' && args[i + 1]) {
    roundNumber = args[++i];
  } else if (arg === '--stdin') {
    stdin = true;
  } else if (arg === '--help' || arg === '-h') {
    printHelp();
    process.exit(0);
  }
}

function printHelp() {
  console.log(`
${c.bright}Goal Instruction Gate${c.reset}
Validates /goal directive compliance

Usage:
  node goal-instruction-gate.mjs --input "/goal ..."
  node goal-instruction-gate.mjs --file goal.md
  node goal-instruction-gate.mjs --check-round round-001
  cat generated-goal.md | node goal-instruction-gate.mjs --stdin

Options:
  --input <text>     Goal text to validate
  --file <path>      Path to goal file
  --check-round <N>  Validate goal from round N
  --stdin            Read goal from stdin
  --help, -h         Show this help

Exit Codes:
  0 = Valid goal instruction
  1 = Invalid goal instruction
  2 = Configuration error
  `);
}

// ============================================================================
// Validation Rules
// ============================================================================

const FORBIDDEN_PATTERNS = [
  // Step words
  { pattern: /第一.*步|第二.*步|第三.*步|第四.*步|第五.*步/g, name: '步骤编号' },
  { pattern: /首先|然后|接下来|之后|最后/g, name: '流程词-顺序' },
  { pattern: /首先|其次|再次|最后/g, name: '流程词-序列' },
  { pattern: /按顺序|依次|逐步|分步|逐步进行/g, name: '流程词-顺序执行' },
  { pattern: /先|再|又|还|继续/g, name: '流程词-继续' },

  // Phase words
  { pattern: /阶段[一二三四五六七八九十\d]/g, name: '阶段词' },
  { pattern: /phase\s*[12]/gi, name: 'Phase词' },
  { pattern: /milestone/gi, name: 'Milestone' },
  { pattern: /checkpoint/gi, name: 'Checkpoint' },

  // Plan words
  { pattern: /TODO|FODO|TBD/g, name: 'TODO' },
  { pattern: /任务清单|工作计划|实施计划/g, name: '计划清单' },
  { pattern: /路线图|路线选择|实施路线/g, name: '路线' },
  { pattern: /制定计划|先计划|计划后/g, name: '计划动作' },

  // Implementation words (when used in execution context)
  { pattern: /阅读代码|分析代码|理解代码|查看代码/g, name: '分析动作' },
  { pattern: /定位问题|找到问题|发现问题/g, name: '定位动作' },
  { pattern: /修改代码|改动代码|调整代码/g, name: '修改动作（流程中）' },
  { pattern: /先.*再|再.*后/g, name: '顺序执行结构' },
];

const REQUIRED_COMPONENTS = [
  { name: '验证标准', pattern: /(完成仅在以下条件|完成标准|验证标准|验证命令)/, minScore: 30 },
  { name: '边界', pattern: /(边界|不得|禁止|不能改?|不可)/, minScore: 25 },
  { name: '证据要求', pattern: /(证据|最终输出|展示|必须显示)/, minScore: 25 },
  { name: '停止条件', pattern: /(停止条件|停止并报告|若.*则停止)/, minScore: 20 },
];

const VERIFIABLE_COMMANDS = [
  'pnpm test', 'pnpm build', 'pnpm typecheck', 'pnpm lint',
  'npm test', 'npm run build', 'npm run typecheck',
  'git status', 'git diff', 'git log',
  'exit code', '退出码', '退出码为 0',
  '测试通过', '构建成功', 'lint 通过', '类型检查通过',
  'curl', 'http', '返回 200', '返回 401', '返回 500',
  'API', 'REST', 'GraphQL',
  'jest', 'vitest', 'playwright', 'cypress',
  'docker build', 'docker run', 'docker-compose',
];

// ============================================================================
// Validation Functions
// ============================================================================

function validateGoalInstruction(goalText) {
  const issues = [];
  const warnings = [];
  let score = 100;

  if (!goalText || typeof goalText !== 'string') {
    return {
      valid: false,
      score: 0,
      issues: ['Goal text is empty or invalid'],
      warnings: [],
    };
  }

  // Trim and normalize
  goalText = goalText.trim();

  // Check 1: Must start with /goal
  if (!goalText.toLowerCase().startsWith('/goal')) {
    issues.push({
      type: 'STRUCTURE',
      severity: 'P0',
      message: 'Goal 指令必须以 /goal 开头',
      suggestion: '在指令前添加 /goal',
    });
    score -= 50;
  }

  // Check 2: Forbidden patterns
  for (const { pattern, name } of FORBIDDEN_PATTERNS) {
    pattern.lastIndex = 0; // Reset for global patterns
    const matches = goalText.match(pattern);
    if (matches && matches.length > 0) {
      issues.push({
        type: 'FORBIDDEN_PATTERN',
        severity: 'P0',
        message: `包含禁止词"${name}"：${matches.slice(0, 3).join(', ')}`,
        suggestion: '将描述改为最终状态，而非执行步骤',
      });
      score -= 15 * matches.length;
    }
  }

  // Check 3: Required components
  for (const { name, pattern, minScore } of REQUIRED_COMPONENTS) {
    pattern.lastIndex = 0;
    if (!pattern.test(goalText)) {
      issues.push({
        type: 'MISSING_COMPONENT',
        severity: 'P1',
        message: `缺少必要元素：${name}`,
        suggestion: `添加 ${name} 描述`,
      });
      score -= minScore;
    }
  }

  // Check 4: Verifiable commands
  const hasVerifiable = VERIFIABLE_COMMANDS.some(cmd =>
    goalText.toLowerCase().includes(cmd.toLowerCase())
  );
  if (!hasVerifiable) {
    issues.push({
      type: 'MISSING_VERIFICATION',
      severity: 'P0',
      message: '缺少可验证的完成标准',
      suggestion: '添加具体命令或验证条件，如 pnpm test 退出码为 0',
    });
    score -= 30;
  }

  // Check 5: Boundary check (must be prohibitive, not prescriptive)
  const boundaryMatch = goalText.match(/边界[：:]([^。]+)/);
  if (boundaryMatch) {
    const boundaryText = boundaryMatch[1];
    // Check if boundary uses "不得/禁止/不能" vs "应该/需要/必须"
    const isProhibitive = /不得|禁止|不能|不可/.test(boundaryText);
    const isPrescriptive = /应该|需要|必须|建议/.test(boundaryText) && !isProhibitive;

    if (isPrescriptive) {
      warnings.push({
        type: 'BOUNDARY_STYLE',
        message: '边界描述应使用禁止语气（不得/禁止），而非建议语气',
        suggestion: '改为：不得修改 X，替代：应该修改 X',
      });
      score -= 5;
    }
  }

  // Check 6: Evidence requirement specificity
  const evidenceMatch = goalText.match(/证据[：:]([^。]+)/);
  if (evidenceMatch) {
    const evidenceText = evidenceMatch[1];
    // Check for specific evidence items
    const hasCommandEvidence = /(命令|退出码|command)/i.test(evidenceText);
    const hasDiffEvidence = /(diff|变更|change)/i.test(evidenceText);
    const hasStatusEvidence = /(status|状态)/i.test(evidenceText);

    const evidenceSpecificity = [hasCommandEvidence, hasDiffEvidence, hasStatusEvidence]
      .filter(Boolean).length;

    if (evidenceSpecificity === 0) {
      warnings.push({
        type: 'EVIDENCE_VAGUE',
        message: '证据要求不够具体',
        suggestion: '明确列出需要展示的命令、diff、status 等',
      });
      score -= 5;
    }
  }

  // Check 7: Stop condition completeness
  const stopMatch = goalText.match(/停止条件[：:]([^。]+)/);
  if (stopMatch) {
    const stopText = stopMatch[1];
    const hasSuccessStop = /(达成|完成|满足).*停止/i.test(stopText);
    const hasBlockStop = /(阻塞|无法|缺少|需要).*停止/i.test(stopText);

    if (!hasSuccessStop) {
      warnings.push({
        type: 'STOP_INCOMPLETE',
        message: '停止条件缺少"达成即停止"',
        suggestion: '添加：达成即停止',
      });
      score -= 5;
    }

    if (!hasBlockStop) {
      warnings.push({
        type: 'STOP_INCOMPLETE',
        message: '停止条件缺少阻塞场景',
        suggestion: '添加：如果需要 X 则停止并报告',
      });
      score -= 5;
    }
  }

  // Check 8: Length check
  if (goalText.length < 50) {
    warnings.push({
      type: 'LENGTH_TOO_SHORT',
      message: 'Goal 指令过短，可能缺少必要元素',
      suggestion: '确保包含最终状态、验证标准、边界、证据要求、停止条件',
    });
    score -= 10;
  }

  // Clamp score
  score = Math.max(0, Math.min(100, score));

  // Determine validity
  const valid = score >= 90 && issues.filter(i => i.severity === 'P0').length === 0;

  return {
    valid,
    score,
    issues,
    warnings,
  };
}

// ============================================================================
// Output Functions
// ============================================================================

function printResult(result, goalText) {
  console.log('');
  console.log(`${c.bright}${c.cyan}═══ Goal Instruction Gate ═══${c.reset}`);
  console.log('');

  // Show the goal text (truncated)
  const displayText = goalText.length > 200
    ? goalText.slice(0, 200) + '...'
    : goalText;
  console.log(`${c.dim}Input:${c.reset} ${displayText}`);
  console.log('');

  // Score
  const scoreColor = result.score >= 90 ? c.green :
                     result.score >= 70 ? c.yellow : c.red;
  console.log(`${c.bright}Score: ${scoreColor}${result.score}/100${c.reset}`);

  // Status
  if (result.valid) {
    console.log(`${c.green}✓ 判定：合格${c.reset}`);
  } else {
    console.log(`${c.red}✗ 判定：不合格${c.reset}`);
  }

  // Issues
  if (result.issues.length > 0) {
    console.log('');
    console.log(`${c.red}${c.bright}问题 (${result.issues.length}):${c.reset}`);
    result.issues.forEach((issue, i) => {
      const sevColor = issue.severity === 'P0' ? c.red : c.yellow;
      console.log(`  ${sevColor}[${issue.severity}]${c.reset} ${issue.message}`);
      console.log(`    ${c.dim}修正：${issue.suggestion}${c.reset}`);
    });
  }

  // Warnings
  if (result.warnings.length > 0) {
    console.log('');
    console.log(`${c.yellow}${c.bright}警告 (${result.warnings.length}):${c.reset}`);
    result.warnings.forEach((warn, i) => {
      console.log(`  ${c.yellow}⚠${c.reset} ${warn.message}`);
      console.log(`    ${c.dim}建议：${warn.suggestion}${c.reset}`);
    });
  }

  // Summary
  console.log('');
  if (result.valid) {
    console.log(`${c.green}Goal 指令符合规范，可以直接使用。${c.reset}`);
  } else {
    console.log(`${c.red}Goal 指令不符合规范，请修正后再使用。${c.reset}`);

    // Provide corrected version hint
    console.log('');
    console.log(`${c.cyan}修正版格式示例：${c.reset}`);
    console.log(`${c.dim}/goal <最终状态>。完成仅在以下条件全部成立时成立：<验证命令及退出码>。边界：<禁止改动范围>。证据：<最终输出必须展示的内容>。停止条件：达成即停止；若出现<阻塞条件>则停止并报告原因。${c.reset}`);
  }

  console.log('');
}

// ============================================================================
// Main
// ============================================================================

function main() {
  // Get goal text from various sources
  if (stdin) {
    // Read from stdin
    const chunks = [];
    process.stdin.on('data', chunk => chunks.push(chunk));
    process.stdin.on('end', () => {
      goalText = chunks.join('');
      const result = validateGoalInstruction(goalText);
      printResult(result, goalText);
      process.exit(result.valid ? 0 : 1);
    });
  } else if (filePath) {
    // Read from file
    if (!existsSync(filePath)) {
      log.error(`File not found: ${filePath}`);
      process.exit(2);
    }
    goalText = readFileSync(filePath, 'utf-8');
  } else if (roundNumber) {
    // Read from round directory
    const reportDir = join(PROJECT_ROOT, 'quality-reports', roundNumber);
    const goalFile = join(reportDir, 'generated-goal.md');

    if (!existsSync(goalFile)) {
      log.error(`Goal file not found: ${goalFile}`);
      process.exit(2);
    }
    goalText = readFileSync(goalFile, 'utf-8');
  } else if (goalText) {
    // Use provided text directly
  } else {
    log.error('No goal text provided. Use --input, --file, --check-round, or --stdin');
    process.exit(2);
  }

  // Validate
  const result = validateGoalInstruction(goalText);
  printResult(result, goalText);

  // Exit with appropriate code
  process.exit(result.valid ? 0 : 1);
}

main();
