#!/usr/bin/env node
/**
 * Evidence Source Validator - 对抗性审查自动化工具
 *
 * 检测 reviewer 评分中是否引用了不合规的证据来源
 *
 * 合规来源包括独立 Reviewer 检查的候选 diff、真实命令输出和其他 Reviewer 报告。
 * 不合规来源是执行者总结、Reviewer 在评审中自行写入的产物，以及缺少运行证据的功能声明。
 *
 * Usage:
 *   node evidence-validator.mjs --round round-001
 *   node evidence-validator.mjs --reviewer product-flow --round round-001
 */

import { readFileSync, readdirSync, existsSync, statSync } from 'fs';
import { isAbsolute, join } from 'path';
import { execFileSync } from 'child_process';
import { parseYamlResult, validateResultYamlContract } from '../lib/review-utils.mjs';
import { validateReviewModelIdentity } from '../lib/model-selector.mjs';
import {
  checkFindingEvidenceBindings, checkMissingEvidenceOutput, extractCommandEvidence,
  extractFileLineReferences, extractTestOutputs,
  resolveFileReference,
} from '../lib/evidence-utils.mjs';
import { resolveReportDirectory } from '../lib/security-utils.mjs';

const PROJECT_ROOT = process.cwd();
let REPORT_DIR;
try {
  REPORT_DIR = resolveReportDirectory(PROJECT_ROOT);
} catch (error) {
  console.error(error.message);
  process.exit(4);
}

function parseArgs(args) {
  let targetRound = null;
  let targetReviewer = null;
  let diffBase = 'HEAD';
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--help' || args[i] === '-h') {
      console.log('Usage: evidence-validator.mjs --round round-NNN [--reviewer name] [--base ref]');
      process.exit(0);
    } else if (args[i] === '--round' && args[i + 1]) targetRound = args[++i];
    else if (args[i] === '--reviewer' && args[i + 1]) targetReviewer = args[++i];
    else if (args[i] === '--base' && args[i + 1]) diffBase = args[++i];
    else {
      console.error(`Unknown or incomplete option: ${args[i]}`);
      console.error('Use --help for usage.');
      process.exit(4);
    }
  }
  return Object.freeze({ targetRound, targetReviewer, diffBase });
}
const options = parseArgs(process.argv.slice(2));
if (!/^[A-Za-z0-9._/@-]+$/.test(options.diffBase)) {
  console.error(`Invalid --base ref: ${options.diffBase}`);
  process.exit(4);
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
function getGitDiffFiles(diffBase) {
  try {
    const output = execFileSync('git', ['diff', '--name-only', diffBase], {
      encoding: 'utf-8', cwd: PROJECT_ROOT, timeout: 10000,
    });
    return output.trim().split('\n').filter(Boolean);
  } catch {
    console.error(`Invalid --base ref or unreadable diff: ${diffBase}`);
    console.error('Usage: evidence-validator.mjs --round round-NNN [--reviewer name] --base <ref>');
    process.exit(4);
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

// === NEW: CROSS-FILE REFERENCE VERIFICATION ===
// Check if file:line references actually exist in the codebase
function verifyFileLineReferences(content, roundDir) {
  const violations = [];
  const warnings = [];

  const refs = extractFileLineReferences(content);
  let trackedFiles = null;
  const uniqueTrackedBasename = file => {
    if (file.includes('/') || file.includes('\\')) return null;
    trackedFiles ||= execFileSync('git', ['ls-files'], { cwd: PROJECT_ROOT, encoding: 'utf8' })
      .split('\n').filter(Boolean);
    const matches = trackedFiles.filter(candidate => candidate.split('/').at(-1) === file);
    return matches.length === 1 ? join(PROJECT_ROOT, matches[0]) : null;
  };

  // For each reference, check if the file exists
  for (const ref of refs) {
    const directPath = resolveFileReference(PROJECT_ROOT, ref.file);
    if (!directPath) {
      violations.push({
        type: 'invalid_file_reference',
        desc: `引用了仓库外的文件: ${ref.file}:${ref.line}`,
        ref: ref.full,
      });
      continue;
    }
    // Normalize the file path relative to project root
    const projectRoot = PROJECT_ROOT;
    const possiblePaths = isAbsolute(ref.file) ? [directPath] : [
      join(roundDir, ref.file),
      directPath,
      uniqueTrackedBasename(ref.file),
      join(projectRoot, 'apps', ref.file),
      join(projectRoot, 'packages', ref.file),
      join(roundDir, '..', '..', ref.file),
      join(projectRoot, 'skills', 'release-quality-review', ref.file),
    ];

    let fileExists = false;
    let checkedPath = null;

    for (const path of possiblePaths) {
      if (path && existsSync(path)) {
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

// Check for file:line references quality
function checkEvidenceQuality(content) {
  const issues = [];
  const violations = [];

  // Count evidence citations
  const fileLineRefs = extractFileLineReferences(content);
  const commandOutputs = extractCommandEvidence(content);
  const testOutputs = extractTestOutputs(content);

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
  const hasTestOutput = testOutputs.length > 0;
  const hasCommandOutput = commandOutputs.length > 0;
  const hasFileRefs = fileLineRefs.length > 0;

  // Only flag "Auto" patterns if there's no real evidence
  const hasRealEvidence = hasTestOutput || hasCommandOutput || hasFileRefs;

  const hollowPatterns = [
    { pattern: /Self Assessment(?!.*evidence)/i, desc: '自我评估模式（应使用独立审查）', onlyIfNoEvidence: true },
    { pattern: /需要人工补充|人工评审(?!.*自动化)/i, desc: '需要人工介入（应自动完成）', onlyIfNoEvidence: true },
    { pattern: /需要进一步检查|需确认|further check(?!.*已完成)/i, desc: '未完成审查', onlyIfNoEvidence: true },
    { pattern: /\*\*(N\/A|n\/a)\*\*/i, desc: 'N/A 未提供适用性证据', onlyIfNoEvidence: true },
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
function validateReviewer(roundDir, reviewer, diffFiles, candidateIdentity) {
  const reviewerDir = join(roundDir, reviewer);
  const scorePath = join(reviewerDir, 'score.md');
  const resultPath = join(reviewerDir, 'result.yaml');
  const blockersPath = join(reviewerDir, 'blockers.md');

  if (!existsSync(scorePath)) {
    return {
      reviewer,
      status: 'violations',
      violations: [{ type: 'missing_score_report', desc: '缺少必需的 score.md，不能验证 reviewer 证据' }],
      warnings: [],
      totalViolations: 1,
      totalWarnings: 0,
    };
  }

  const scoreContent = readFileSync(scorePath, 'utf-8');
  const blockersContent = existsSync(blockersPath) ? readFileSync(blockersPath, 'utf8') : '';
  const content = `${scoreContent}\n${blockersContent}`;
  const allViolations = [];
  const allWarnings = [];
  let packet = null;

  if (!existsSync(resultPath)) {
    allViolations.push({ type: 'missing_result_packet', desc: '缺少必需的 result.yaml，无法绑定候选身份' });
  } else {
    const yamlContent = readFileSync(resultPath, 'utf8');
    const contract = validateResultYamlContract(yamlContent);
    if (!contract.valid) {
      allViolations.push({ type: 'invalid_result_schema', desc: contract.error });
    }
    packet = parseYamlResult(yamlContent);
    if (!candidateIdentity.valid || packet.candidateCommit !== candidateIdentity.commit || packet.candidateTree !== candidateIdentity.tree) {
      allViolations.push({
        type: 'candidate_identity_mismatch',
        desc: `reviewer packet 未绑定当前 candidate commit/tree`,
      });
    }
    if (!candidateIdentity.reviewIdentityValid ||
        packet.reviewBackend !== candidateIdentity.backend ||
        packet.reviewModel !== candidateIdentity.model) {
      allViolations.push({
        type: 'review_backend_model_mismatch',
        desc: 'reviewer packet 未绑定本轮 backend/model',
      });
    }
  }

  // Run all checks
  allViolations.push(...checkSelfReferencePatterns(content, reviewer));
  // Independent reviewers may cite candidate diff code for static claims. Runtime
  // claims still require command/test evidence, and self-authored language is rejected.
  allViolations.push(...checkMissingEvidenceOutput(content));
  if (packet) {
    allViolations.push(...checkFindingEvidenceBindings(
      [...packet.blockers, ...packet.redlines], blockersContent,
    ));
  }

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
function main({ targetRound, targetReviewer, diffBase }) {
  // Find latest round if not specified
  let resolvedRound = targetRound;
  if (!resolvedRound) {
    const rounds = readdirSync(REPORT_DIR)
      .filter(d => d.startsWith('round-'))
      .sort();
    resolvedRound = rounds[rounds.length - 1] || 'round-001';
  }

  const roundDir = join(REPORT_DIR, resolvedRound);

  if (!existsSync(roundDir)) {
    console.error(`${c.red}❌ Round directory not found: ${roundDir}${c.reset}`);
    process.exit(1);
  }

  console.log(`${c.blue}ℹ${c.reset} Validating: ${resolvedRound}`);

  // Get diff files
  const diffFiles = getGitDiffFiles(diffBase);
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
  let candidateIdentity = {
    commit: null, tree: null, valid: false,
    backend: null, model: null, reviewIdentityValid: false,
  };
  try {
    const metadata = JSON.parse(readFileSync(join(roundDir, 'metadata.json'), 'utf8'));
    const backendLock = JSON.parse(readFileSync(join(roundDir, 'review-backend.json'), 'utf8'));
    const commit = metadata.candidate_commit;
    const tree = metadata.candidate_tree;
    candidateIdentity = {
      commit,
      tree,
      valid: /^[0-9a-f]{40}$/i.test(commit || '') && /^[0-9a-f]{40}$/i.test(tree || ''),
      backend: backendLock.backend,
      model: backendLock.model,
      reviewIdentityValid: validateReviewModelIdentity({
        backend: backendLock.backend,
        model: backendLock.model,
        reasoningEffort: backendLock.reasoning_effort ?? null,
      }).valid &&
        metadata.review_backend === backendLock.backend && metadata.review_model === backendLock.model &&
        (!('reasoning_effort' in backendLock) ||
          (metadata.review_reasoning_effort ?? null) === (backendLock.reasoning_effort ?? null)),
    };
  } catch {
    log.fail('Missing or invalid metadata/backend identity');
  }

  const results = reviewers.map(r => validateReviewer(roundDir, r, diffFiles, candidateIdentity));

  // SECURITY: Require minimum reviewer count for gate integrity
  // A delivery packet with 0 reviewers is an incomplete review
  const MIN_REVIEWERS = targetReviewer ? 1 : 2;
  if (reviewers.length < MIN_REVIEWERS) {
    const emptyResult = {
      reviewer: '__GATE__',
      status: 'violations',
      violations: [{
        type: 'insufficient_reviewers',
        desc: `仅 ${reviewers.length} 个 reviewer（至少需要 ${MIN_REVIEWERS} 个）。缺少 score.md 和 result.yaml。`,
      }],
      warnings: [],
      quality: {
        fileLineRefs: 0,
        commandOutputs: 0,
        testOutputs: 0,
        issues: [],
        violations: [],
        hasMinimumEvidence: false,
        claimedScore: null,
        evidenceCount: 0,
      },
      totalViolations: 1,
      totalWarnings: 0,
      fileRefCheck: { totalRefs: 0, violations: [], warnings: [] },
    };
    results.push(emptyResult);
    log.fail(`Insufficient reviewers: ${reviewers.length}/${MIN_REVIEWERS} minimum`);
  }

  // Generate and print report
  const report = generateReport(results);
  console.log(report);

  // Exit code
  const hasViolations = results.some(r => r.violations.length > 0);
  process.exit(hasViolations ? 1 : 0);
}

main(options);
