#!/usr/bin/env node
/**
 * Evidence Source Validator - 对抗性审查自动化工具
 *
 * 检测 reviewer 评分中是否引用了不合规的证据来源
 *
 * 合规来源:
 *   - 历史文件 (不是你刚写的)
 *   - 已有测试输出 (pnpm test)
 *   - 其他 Reviewer 报告
 *
 * 不合规来源 (自我验证):
 *   - git diff 中新增的代码
 *   - "我们添加" / "我写的" / "刚才的"
 *   - 引用自己刚写的测试
 *
 * Usage:
 *   node evidence-validator.mjs --round round-001
 *   node evidence-validator.mjs --reviewer product-flow --round round-001
 */

import { readFileSync, readdirSync, existsSync, statSync } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';

const PROJECT_ROOT = process.cwd();
const REPORT_DIR = join(PROJECT_ROOT, 'quality-reports');

// Parse arguments
const args = process.argv.slice(2);
let targetRound = null;
let targetReviewer = null;

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--round' && args[i + 1]) {
    targetRound = args[++i];
  } else if (args[i] === '--reviewer' && args[i + 1]) {
    targetReviewer = args[++i];
  }
}

// ANSI colors
const c = {
  reset: '\x1b[0m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
};

const log = {
  pass: (msg) => console.log(`${c.green}✅${c.reset} ${msg}`),
  fail: (msg) => console.log(`${c.red}❌${c.reset} ${msg}`),
  warn: (msg) => console.log(`${c.yellow}⚠️${c.reset} ${msg}`),
  info: (msg) => console.log(`${c.blue}ℹ${c.reset} ${msg}`),
};

// Get git diff files (newly added/changed)
function getGitDiffFiles() {
  try {
    const output = execSync('git diff --name-only HEAD 2>/dev/null', { encoding: 'utf-8' });
    return output.trim().split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

// Check for self-reference patterns
function checkSelfReferencePatterns(content, reviewer) {
  const violations = [];

  // Pattern 1: "我们添加" / "我写的" / "上面的代码"
  const selfRefPatterns = [
    { pattern: /我们添加|我们修改|我们实现|我们创建/g, desc: '使用"我们"' },
    { pattern: /我写的|我添加的|我实现的/g, desc: '使用"我"' },
    { pattern: /上面的代码|刚才的|刚才实现/g, desc: '引用刚写的代码' },
    { pattern: /按照上述|根据上面|依据上文/g, desc: '引用实现过程' },
  ];

  for (const { pattern, desc } of selfRefPatterns) {
    const matches = content.match(pattern);
    if (matches) {
      violations.push({ type: 'self_reference', desc, count: matches.length });
    }
  }

  return violations;
}

// Check for diff file references
function checkDiffFileReferences(content, diffFiles, reviewer) {
  const violations = [];

  for (const file of diffFiles) {
    // Normalize path for matching
    const normalizedFile = file.replace(/\\/g, '/');
    const fileName = normalizedFile.split('/').pop();

    // Check if file is referenced in content
    if (content.includes(normalizedFile) || content.includes(fileName)) {
      // Check context - is it being cited as evidence?
      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line.includes(normalizedFile) || line.includes(fileName)) {
          // Check if this looks like evidence citation
          const context = lines.slice(Math.max(0, i - 2), i + 3).join(' ');
          if (/\d+行|line \d+|:\d+|存在|有|通过|正确|符合|验证/g.test(context)) {
            violations.push({
              type: 'diff_file_reference',
              file: normalizedFile,
              line: i + 1,
              desc: `引用 diff 中新增的文件作为证据`
            });
          }
        }
      }
    }
  }

  return violations;
}

// === NEW: CROSS-FILE REFERENCE VERIFICATION ===
// Check if file:line references actually exist in the codebase
function verifyFileLineReferences(content, roundDir) {
  const violations = [];
  const warnings = [];

  // Find all file:line references
  const fileLinePattern = /([a-zA-Z][^\s:]+\.(ts|tsx|js|jsx|mjs)):(\d+)/g;
  let match;
  const refs = [];

  while ((match = fileLinePattern.exec(content)) !== null) {
    refs.push({
      file: match[1],
      line: parseInt(match[3], 10),
      full: match[0]
    });
  }

  // For each reference, check if the file exists
  for (const ref of refs) {
    // Normalize the file path relative to project root
    const projectRoot = PROJECT_ROOT;
    const possiblePaths = [
      join(projectRoot, ref.file),
      join(projectRoot, 'apps', ref.file),
      join(projectRoot, 'packages', ref.file),
      join(roundDir, '..', '..', ref.file),
    ];

    let fileExists = false;
    let checkedPath = null;

    for (const path of possiblePaths) {
      if (existsSync(path)) {
        fileExists = true;
        checkedPath = path;
        break;
      }
    }

    // If file doesn't exist, flag as violation
    if (!fileExists) {
      violations.push({
        type: 'invalid_file_reference',
        desc: `引用了不存在的文件: ${ref.file}:${ref.line}`,
        ref: ref.full
      });
    } else if (checkedPath && ref.line > 0) {
      // Verify the line number is reasonable
      try {
        const fileContent = readFileSync(checkedPath, 'utf-8');
        const lineCount = fileContent.split('\n').length;

        if (ref.line > lineCount) {
          violations.push({
            type: 'invalid_line_reference',
            desc: `引用了 ${ref.file}:${ref.line} 但文件仅有 ${lineCount} 行`,
            ref: ref.full
          });
        } else if (ref.line > lineCount * 0.95) {
          // Warning for near-end-of-file references
          warnings.push({
            type: 'suspicious_line_reference',
            desc: `引用了 ${ref.file}:${ref.line}（接近文件末尾 ${lineCount} 行）`,
            ref: ref.full
          });
        }
      } catch {
        // Ignore read errors
      }
    }
  }

  return { violations, warnings, totalRefs: refs.length };
}

// Check for missing evidence output
function checkMissingEvidenceOutput(content, reviewer) {
  const violations = [];

  // Claims that need output proof
  const claims = [
    { pattern: /测试通过|tests? passed|test.*success/g, need: 'pnpm test 输出' },
    { pattern: /类型检查通过|typecheck.*passed|tsc.*success/g, need: 'pnpm typecheck 输出' },
    { pattern: /构建成功|build.*success|build.*pass/g, need: 'pnpm build 输出' },
    { pattern: /功能正常|功能正确|工作正常/g, need: '实际运行证据' },
  ];

  for (const { pattern, need } of claims) {
    if (pattern.test(content)) {
      // Check if there's actual output cited
      const hasOutput = /(pnpm|npm|yarn)\s+(test|build|typecheck)/.test(content) ||
                       /passed|failed|error|success/.test(content);
      if (!hasOutput) {
        violations.push({
          type: 'missing_evidence_output',
          claim: pattern.source,
          need,
          desc: `声称"通过"但没有实际命令输出`
        });
      }
    }
  }

  return violations;
}

// Check for file:line references quality
function checkEvidenceQuality(content) {
  const issues = [];
  const violations = [];

  // Count evidence citations
  const fileLineRefs = content.match(/[a-zA-Z][^\s:]+\.(ts|tsx|js|jsx|mjs):\d+/g) || [];
  const commandOutputs = content.match(/(pnpm|npm|yarn)\s+\w+\s*(2>&1|output)?/g) || [];
  const testOutputs = content.match(/(\d+\s+(passed|failed|skipped)|✓|✗|PASS|FAIL)/g) || [];

  // Check for vague evidence
  const vaguePatterns = [
    { pattern: /代码看起来正确|看起来没问题|应该能工作|代码正确/g, desc: '主观描述' },
    { pattern: /根据经验|通常|一般说来/g, desc: '主观判断' },
  ];

  for (const { pattern, desc } of vaguePatterns) {
    if (pattern.test(content)) {
      issues.push({ type: 'vague_evidence', desc });
    }
  }

  // MINIMUM EVIDENCE THRESHOLD: At least 5 file:line refs OR 1 command output OR 1 test result
  // Accept automated evidence (command outputs) as valid
  const hasMinimumEvidence = fileLineRefs.length >= 5 || commandOutputs.length >= 1 || testOutputs.length >= 1;
  if (!hasMinimumEvidence) {
    violations.push({
      type: 'insufficient_evidence',
      desc: `证据不足：仅 ${fileLineRefs.length} 个文件引用, ${commandOutputs.length} 个命令输出, ${testOutputs.length} 个测试结果`,
      minRefs: 5,
      minCommands: 1,
    });
  }

  // HOLLOW DESCRIPTION DETECTION: Self Assessment, Auto-assessed, N/A patterns
  // NOTE: Auto-generated reviews with real evidence are VALID - only flag if no evidence
  const hasTestOutput = /(\d+\s+pass|passed|failed)/.test(content);
  const hasCommandOutput = /(pnpm|npm|yarn)\s+(test|build|typecheck)/.test(content);
  const hasFileRefs = /[a-zA-Z][^\s:]+\.(ts|tsx|js|jsx|mjs):\d+/.test(content);

  // Only flag "Auto" patterns if there's no real evidence
  const hasRealEvidence = hasTestOutput || hasCommandOutput || hasFileRefs;

  const hollowPatterns = [
    { pattern: /Self Assessment(?!.*evidence)/i, desc: '自我评估模式（应使用独立审查）', onlyIfNoEvidence: true },
    { pattern: /需要人工补充|人工评审(?!.*自动化)/i, desc: '需要人工介入（应自动完成）', onlyIfNoEvidence: true },
    { pattern: /需要进一步检查|需确认|further check(?!.*已完成)/i, desc: '未完成审查', onlyIfNoEvidence: true },
    { pattern: /\*\*(N\/A|n\/a)\*\*/i, desc: 'N/A 占位符（缺乏具体评分）', onlyIfNoEvidence: false },
  ];

  for (const { pattern, desc, onlyIfNoEvidence } of hollowPatterns) {
    if (pattern.test(content)) {
      // Only flag if either:
      // 1. This pattern should always be flagged, OR
      // 2. This pattern is only flagged when there's no real evidence AND there really isn't
      if (!onlyIfNoEvidence || (!hasRealEvidence && !hasFileRefs)) {
        violations.push({ type: 'hollow_description', desc });
      }
    }
  }

  // === P1: GOAL MODE CONSTRAINT CHECK (Contextual) ===
  // Detect implementation steps being described as goals
  // Use context to reduce false positives
  const goalViolationPatterns = [
    { pattern: /实现了.*功能|实现了.*模块|实现了.*组件/g, desc: '描述实现而非目标达成', falsePositiveContext: ['目标', '验收', '需求'] },
    { pattern: /按照.*步骤.*实现|分.*步骤.*实现|逐步.*实现/g, desc: '描述实现步骤而非最终状态' },
    { pattern: /添加了.*代码|写了.*函数|创建了.*类/g, desc: '描述代码变更而非功能结果', falsePositiveContext: ['为了', '实现', '满足'] },
    { pattern: /我们.*实现|我们.*添加|我.*写了/g, desc: '自我描述实现过程' },
  ];

  for (const { pattern, desc, falsePositiveContext } of goalViolationPatterns) {
    const matches = content.match(pattern);
    if (matches) {
      // Check if this is a false positive (mentioned in goal/requirement context)
      let isFalsePositive = false;
      if (falsePositiveContext) {
        for (const ctx of falsePositiveContext) {
          // Check surrounding context (±50 chars)
          for (const match of matches) {
            const matchIndex = content.indexOf(match);
            const context = content.slice(Math.max(0, matchIndex - 50), matchIndex + match.length + 50);
            if (context.includes('目标') || context.includes('验收条件') || context.includes('需求')) {
              // This might be describing a goal requirement, not implementation
              if (ctx === '目标' || ctx === '验收' || ctx === '需求') {
                isFalsePositive = true;
                break;
              }
            }
          }
          if (isFalsePositive) break;
        }
      }

      if (!isFalsePositive) {
        violations.push({ type: 'goal_mode_violation', desc, count: matches.length });
      }
    }
  }

  // === NEW: SCORE-EVIDENCE CONSISTENCY CHECK ===
  // When a reviewer claims high score but has insufficient evidence, flag it
  const scoreMatch = content.match(/(?:总分|Overall Score|Total Score|Score)[^0-9]*(\d+)[^0-9]*\/?\s*100/i);
  if (scoreMatch) {
    const claimedScore = parseInt(scoreMatch[1], 10);
    const evidenceCount = fileLineRefs.length + commandOutputs.length * 2 + testOutputs.length * 2;

    // High score + low evidence = suspicious
    if (claimedScore >= 85 && evidenceCount < 3) {
      violations.push({
        type: 'score_evidence_inconsistency',
        desc: `声称 ${claimedScore} 分但仅有 ${evidenceCount} 个证据（高分低证）`,
        suggestedScore: Math.min(claimedScore, 60)
      });
    } else if (claimedScore >= 90 && evidenceCount < 5) {
      // Even stricter for claiming pass
      violations.push({
        type: 'score_evidence_inconsistency',
        desc: `声称 ${claimedScore} 分（通过）但仅有 ${evidenceCount} 个证据，不足 5 个`,
        suggestedScore: Math.min(claimedScore, 55)
      });
    }
  }

  return {
    fileLineRefs: fileLineRefs.length,
    commandOutputs: commandOutputs.length,
    testOutputs: testOutputs.length,
    issues,
    violations,
    hasMinimumEvidence,
    claimedScore: scoreMatch ? parseInt(scoreMatch[1], 10) : null,
    evidenceCount: fileLineRefs.length + commandOutputs.length + testOutputs.length,
  };
}

// Main validation
function validateReviewer(roundDir, reviewer, diffFiles) {
  const reviewerDir = join(roundDir, reviewer);
  const scorePath = join(reviewerDir, 'score.md');

  if (!existsSync(scorePath)) {
    return { reviewer, status: 'no_report', violations: [], warnings: [] };
  }

  const content = readFileSync(scorePath, 'utf-8');
  const allViolations = [];
  const allWarnings = [];

  // Run all checks
  allViolations.push(...checkSelfReferencePatterns(content, reviewer));
  allViolations.push(...checkDiffFileReferences(content, diffFiles, reviewer));
  allViolations.push(...checkMissingEvidenceOutput(content, reviewer));

  // === NEW: Cross-file reference verification ===
  const fileRefCheck = verifyFileLineReferences(content, roundDir);
  allViolations.push(...fileRefCheck.violations);
  allWarnings.push(...fileRefCheck.warnings);

  const quality = checkEvidenceQuality(content);

  // Include quality violations in total violations
  allViolations.push(...quality.violations);

  return {
    reviewer,
    status: allViolations.length > 0 ? 'violations' : 'pass',
    violations: allViolations,
    warnings: allWarnings,
    quality,
    totalViolations: allViolations.length,
    totalWarnings: allWarnings.length,
    fileRefCheck,
  };
}

// Generate report
function generateReport(results) {
  let output = '\n';
  output += `${c.cyan}═══════════════════════════════════════════════════${c.reset}\n`;
  output += `${c.cyan}  Evidence Source Validation Report${c.reset}\n`;
  output += `${c.cyan}═══════════════════════════════════════════════════${c.reset}\n\n`;

  let totalViolations = 0;
  let totalWarnings = 0;
  let passCount = 0;

  for (const result of results) {
    output += `${c.blue}Reviewer: ${result.reviewer}${c.reset}\n`;

    if (result.status === 'no_report') {
      output += `  ${c.yellow}⚠️  No score.md found${c.reset}\n\n`;
      continue;
    }

    // Quality summary
    if (result.quality) {
      output += `  Evidence Quality:\n`;
      output += `    - File:Line references: ${result.quality.fileLineRefs}`;
      if (result.quality.fileLineRefs < 5) output += ` ${c.red}(需要 ≥5)${c.reset}`;
      output += '\n';
      output += `    - Command outputs: ${result.quality.commandOutputs}`;
      if (result.quality.commandOutputs < 1) output += ` ${c.red}(需要 ≥1)${c.reset}`;
      output += '\n';
      output += `    - Test results: ${result.quality.testOutputs}\n`;

      // === NEW: Show score-evidence consistency ===
      if (result.quality.claimedScore !== null) {
        output += `    - Claimed Score: ${result.quality.claimedScore}/100\n`;
        if (result.quality.claimedScore >= 85 && result.quality.evidenceCount < 5) {
          output += `      ${c.red}⚠️ 高分低证: ${result.quality.claimedScore}分 仅 ${result.quality.evidenceCount} 个证据${c.reset}\n`;
        }
      }

      if (result.quality.issues.length > 0) {
        output += `  ${c.yellow}Vague Evidence:${c.reset}\n`;
        for (const issue of result.quality.issues) {
          output += `    - ${issue.desc}\n`;
        }
      }
    }

    // === NEW: Show file reference verification ===
    if (result.fileRefCheck && result.fileRefCheck.totalRefs > 0) {
      output += `  File Reference Verification:\n`;
      output += `    - Total refs: ${result.fileRefCheck.totalRefs}\n`;
      if (result.fileRefCheck.violations.length > 0) {
        output += `    - ${c.red}❌ ${result.fileRefCheck.violations.length} invalid refs${c.reset}\n`;
      } else {
        output += `    - ${c.green}✅ All refs valid${c.reset}\n`;
      }
    }

    // Warnings
    if (result.warnings && result.warnings.length > 0) {
      totalWarnings += result.warnings.length;
      output += `  ${c.yellow}⚠️ Warnings (${result.warnings.length}):${c.reset}\n`;
      for (const w of result.warnings) {
        output += `    - [${w.type}] ${w.desc}\n`;
      }
    }

    // Violations
    if (result.violations.length > 0) {
      totalViolations += result.violations.length;
      output += `  ${c.red}❌ Violations (${result.violations.length}):${c.reset}\n`;

      for (const v of result.violations) {
        output += `    - [${v.type}] ${v.desc}`;
        if (v.file) output += ` (${v.file}:${v.line || '?'})`;
        output += '\n';
      }
    } else {
      passCount++;
      output += `  ${c.green}✅ No violations${c.reset}\n`;
    }

    output += '\n';
  }

  // Summary
  output += `${c.cyan}───────────────────────────────────────────${c.reset}\n`;
  output += `Summary:\n`;
  output += `  Reviewers: ${results.length}\n`;
  output += `  Passed: ${passCount}/${results.length}\n`;
  output += `  Total Violations: ${totalViolations}\n`;
  output += `  Total Warnings: ${totalWarnings}\n`;

  if (totalViolations === 0) {
    output += `\n${c.green}✅ All reviewers passed adversarial check!${c.reset}\n`;
  } else {
    output += `\n${c.red}❌ ${totalViolations} violations found - review required${c.reset}\n`;
  }

  return output;
}

// Main
function main() {
  // Find latest round if not specified
  if (!targetRound) {
    const rounds = readdirSync(REPORT_DIR)
      .filter(d => d.startsWith('round-'))
      .sort();
    targetRound = rounds[rounds.length - 1] || 'round-001';
  }

  const roundDir = join(REPORT_DIR, targetRound);

  if (!existsSync(roundDir)) {
    console.error(`${c.red}❌ Round directory not found: ${roundDir}${c.reset}`);
    process.exit(1);
  }

  console.log(`${c.blue}ℹ${c.reset} Validating: ${targetRound}`);

  // Get diff files
  const diffFiles = getGitDiffFiles();
  console.log(`${c.blue}ℹ${c.reset} Diff files: ${diffFiles.length}`);

  // Find reviewers - entries that are directories with reviewer output files
  const allEntries = readdirSync(roundDir);
  let reviewers = allEntries.filter(f => {
    const fullPath = join(roundDir, f);

    // Skip non-directories (like metadata.json, summary.md)
    let stat;
    try {
      stat = statSync(fullPath);
    } catch {
      return false;
    }
    if (!stat.isDirectory()) return false;

    // Check if it contains reviewer output files
    const hasScore = existsSync(join(fullPath, 'score.md'));
    const hasResult = existsSync(join(fullPath, 'result.yaml'));
    return hasScore || hasResult;
  });

  // Debug: log reviewers found
  console.log(`${c.blue}ℹ${c.reset} Reviewers found: ${reviewers.length}`);

  // Filter by target reviewer if specified
  if (targetReviewer) {
    reviewers = reviewers.filter(r => r === targetReviewer);
  }

  console.log(`${c.blue}ℹ${c.reset} Reviewers: ${reviewers.join(', ')}\n`);

  // Validate each reviewer
  const results = reviewers.map(r => validateReviewer(roundDir, r, diffFiles));

  // Generate and print report
  const report = generateReport(results);
  console.log(report);

  // Exit code
  const hasViolations = results.some(r => r.violations.length > 0);
  process.exit(hasViolations ? 1 : 0);
}

main();
