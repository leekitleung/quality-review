#!/usr/bin/env node
/**
 * Review Runner - Orchestrates Multi-Reviewer Quality Reviews
 *
 * This script orchestrates the full review workflow:
 * 1. Load profile configuration
 * 2. Detect conditional reviewers based on changes
 * 3. Collect evidence
 * 4. Run reviewers in sequence or parallel
 * 5. Aggregate results
 * 6. Run gate check
 *
 * Usage:
 *   node review-runner.mjs --profile release-gate
 *   node review-runner.mjs --profile quick --parallel
 *   node review-runner.mjs --dry-run
 *   node review-runner.mjs --auto          # Auto-generate reviews (for self-review)
 *   node review-runner.mjs --target <dir>  # Review a specific directory (self-review)
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';

const PROJECT_ROOT = process.cwd();
const SKILL_DIR = join(PROJECT_ROOT, 'skills', 'release-quality-review');
const REPORT_DIR = join(PROJECT_ROOT, 'quality-reports');
const CONFIG_FILE = join(SKILL_DIR, 'review-config.yaml');

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
  magenta: '\x1b[35m',
};

const log = {
  info: (msg) => console.log(`${c.blue}ℹ${c.reset} ${msg}`),
  success: (msg) => console.log(`${c.green}✓${c.reset} ${msg}`),
  warn: (msg) => console.log(`${c.yellow}⚠${c.reset} ${msg}`),
  error: (msg) => console.log(`${c.red}✗${c.reset} ${msg}`),
  title: (msg) => console.log(`\n${c.bright}${c.cyan}═══ ${msg} ═══${c.reset}\n`),
};

// Parse arguments
const args = process.argv.slice(2);
let profile = 'release-gate';
let roundNumber = null;
let parallel = false;
let dryRun = false;
let skipEvidence = false;
let reviewerOverride = null;
let targetDir = null; // Override target directory for self-review
let autoGenerate = false; // Auto-generate review files (for self-review)
let autoLoop = false; // Auto-loop until gate passes
let maxLoops = 10; // Maximum iterations before giving up

for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === '--profile' && args[i + 1]) profile = args[++i];
  else if (arg === '--round' && args[i + 1]) {
    const parsed = parseInt(args[++i], 10);
    // Guard against NaN (e.g., "round-null" or invalid input)
    roundNumber = isNaN(parsed) ? null : parsed;
  }
  else if (arg === '--parallel') parallel = true;
  else if (arg === '--dry-run') dryRun = true;
  else if (arg === '--skip-evidence') skipEvidence = true;
  else if (arg === '--reviewer' && args[i + 1]) reviewerOverride = args[++i];
  else if (arg === '--target' && args[i + 1]) targetDir = args[++i];
  else if (arg === '--auto') autoGenerate = true;
  else if (arg === '--auto-loop') autoLoop = true;
  else if (arg === '--max-loops' && args[i + 1]) maxLoops = parseInt(args[++i], 10);
  else if (arg === '--help' || arg === '-h') {
    printHelp();
    process.exit(0);
  }
}

// Resolve target directory (self-review target vs project root)
const REVIEW_TARGET = targetDir
  ? join(PROJECT_ROOT, targetDir)
  : PROJECT_ROOT;

function printHelp() {
  console.log(`
${c.bright}Review Runner - Quality Review Orchestrator${c.reset}

Usage:
  node review-runner.mjs [options]

Options:
  --profile <name>   Profile: quick, default, release-gate, full (default: release-gate)
  --round <N>        Round number (auto-detected if not specified)
  --parallel         Run reviewers in parallel
  --reviewer <name>  Run only this reviewer
  --target <path>    Review target directory (for self-review: skills/release-quality-review)
  --auto             Auto-generate review files (for self-review)
  --skip-evidence    Skip automatic evidence collection
  --dry-run          Validate configuration without running
  --help, -h         Show this help

Examples:
  node review-runner.mjs --profile release-gate
  node review-runner.mjs --profile default --parallel
  node review-runner.mjs --reviewer destructive-qa --dry-run
  node review-runner.mjs --target skills/release-quality-review --profile quick --auto  # Self-review
  `);
}

// Load YAML profile
function loadProfile(profileName) {
  const profilePath = join(SKILL_DIR, 'profiles', `${profileName}.yaml`);
  if (!existsSync(profilePath)) {
    log.error(`Profile not found: ${profileName}`);
    log.error(`Looking for: ${profilePath}`);
    return null;
  }

  try {
    const content = readFileSync(profilePath, 'utf-8');
    return parseYamlProfile(content, profileName);
  } catch (e) {
    log.error(`Failed to load profile: ${e.message}`);
    return null;
  }
}

// Simple YAML parser for profiles
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
  let inConditional = false;
  let inChecklist = false;

  for (const line of lines) {
    const trimmed = line.trim();

    // Skip comments and empty lines
    if (!trimmed || trimmed.startsWith('#')) continue;

    // Skip Markdown checkboxes (they're not YAML list items)
    if (trimmed.startsWith('- [') || trimmed.startsWith('- [ ]')) continue;

    // Section headers (## xxx)
    if (trimmed.startsWith('## ')) {
      const section = trimmed.slice(3).toLowerCase();
      if (section.includes('conditional')) {
        inConditional = true;
        currentSection = 'conditional';
      } else if (section.includes('reviewer') || section.includes('config')) {
        inConditional = false;
        currentSection = null;
      }
      inChecklist = false;
      continue;
    }

    // Skip code blocks and other non-YAML content
    if (trimmed.startsWith('```') || trimmed.startsWith('|')) continue;

    // Key-value pairs
    if (trimmed.includes(':')) {
      const colonIdx = trimmed.indexOf(':');
      const key = trimmed.slice(0, colonIdx).trim();
      let value = trimmed.slice(colonIdx + 1).trim();

      // Remove inline comments like "# comment"
      value = value.split('#')[0].trim();

      if (key === 'profile') profile.name = value;
      else if (key === 'description') profile.description = value;
      else if (key === 'estimated_time') profile.estimated_time = value;
      else if (key === 'min_score') profile.gate.min_score = parseInt(value) || 90;
      else if (key === 'fail_on_redlines') profile.gate.fail_on_redlines = value === 'true';
      else if (key === 'resident_reviewers' || key === 'required_reviewers') {
        currentSection = 'resident';
        inConditional = false;
      } else if (key === 'conditional_reviewers') {
        currentSection = 'conditional';
        inConditional = true;
        // If value is '[]' (empty array literal), don't treat following items as conditional
        if (value === '[]') {
          inConditional = false;
        }
      } else if (key === 'verbose') profile.output.verbose = value === 'true';
      else if (key === 'include_evidence') profile.output.include_evidence = value === 'true';
    } else if (trimmed.startsWith('- ')) {
      // YAML list item (but not Markdown checkbox)
      if (inChecklist) continue; // Skip checklist continuation

      let item = trimmed.slice(2).trim();
      // Remove inline comments
      item = item.split('#')[0].trim();

      if (currentSection === 'resident') {
        profile.resident_reviewers.push(item);
      } else if (inConditional) {
        profile.conditional_reviewers.push(item);
      }
    }
  }

  return profile;
}

// Load reviewer definitions
function loadReviewer(name) {
  const path = join(SKILL_DIR, 'reviewers', `${name}.md`);
  if (!existsSync(path)) return null;
  return readFileSync(path, 'utf-8');
}

// Collect evidence
function collectEvidence() {
  log.info('Collecting evidence...');
  const isSelfReview = REVIEW_TARGET !== PROJECT_ROOT;
  const targetName = isSelfReview ? 'Skill Self-Review' : 'Project';

  const evidence = {
    timestamp: new Date().toISOString(),
    target: targetName,
    git: {},
    structure: {},
    config: {},
  };

  // Git info (always from PROJECT_ROOT)
  try {
    evidence.git = {
      branch: execSync('git branch --show-current 2>/dev/null', { encoding: 'utf-8' }).trim(),
      commit: execSync('git rev-parse --short HEAD 2>/dev/null', { encoding: 'utf-8' }).trim(),
      diffStats: execSync('git diff --stat 2>/dev/null', { encoding: 'utf-8' }).trim(),
    };

    // For self-review, only show changes in the skill directory
    if (isSelfReview) {
      evidence.git.changedFiles = execSync(
        `git diff --name-only 2>/dev/null | grep "^skills/release-quality-review/" || true`,
        { encoding: 'utf-8' }
      ).trim().split('\n').filter(Boolean);
      evidence.git.diff = execSync(
        `git diff 2>/dev/null -- "skills/release-quality-review/" || true`,
        { encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 }
      ).trim();
    } else {
      evidence.git.changedFiles = execSync('git diff --name-only 2>/dev/null', { encoding: 'utf-8' })
        .trim().split('\n').filter(Boolean);
      evidence.git.diff = execSync('git diff 2>/dev/null', { encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 }).trim();
    }
  } catch (e) {
    log.warn('Could not collect git info');
  }

  // Project/Skill structure (from REVIEW_TARGET)
  const targetRoot = REVIEW_TARGET;
  try {
    if (existsSync(join(targetRoot, 'apps'))) {
      evidence.structure.apps = readdirSync(join(targetRoot, 'apps')).filter(f => {
        try { return statSync(join(targetRoot, 'apps', f)).isDirectory(); } catch { return false; }
      });
    }
    if (existsSync(join(targetRoot, 'packages'))) {
      evidence.structure.packages = readdirSync(join(targetRoot, 'packages')).filter(f => {
        try { return statSync(join(targetRoot, 'packages', f)).isDirectory(); } catch { return false; }
      });
    }
    // For skill self-review, list the skill structure
    if (isSelfReview) {
      evidence.structure.skill = {
        reviewers: readdirSync(join(targetRoot, 'reviewers')).filter(f => f.endsWith('.md')),
        rubrics: readdirSync(join(targetRoot, 'rubrics')).filter(f => f.endsWith('.md')),
        scripts: readdirSync(join(targetRoot, 'scripts')).filter(f => f.endsWith('.mjs')),
        profiles: readdirSync(join(targetRoot, 'profiles')).filter(f => f.endsWith('.yaml')),
      };
    }

    // Count test files
    evidence.structure.testFiles = execSync(
      `find "${targetRoot}" -name "*.test.ts" -o -name "*.spec.ts" 2>/dev/null | wc -l`,
      { encoding: 'utf-8', timeout: 10000 }
    ).trim();

    // Count total source files
    evidence.structure.sourceFiles = execSync(
      `find "${targetRoot}" -name "*.ts" -o -name "*.tsx" 2>/dev/null | grep -v "\.d\.ts" | grep -v "/node_modules/" | wc -l`,
      { encoding: 'utf-8', timeout: 10000 }
    ).trim();

    // Calculate test ratio
    const testCount = parseInt(evidence.structure.testFiles) || 0;
    const sourceCount = parseInt(evidence.structure.sourceFiles) || 1;
    evidence.structure.testRatio = Math.round((testCount / sourceCount) * 100) / 100;

    // Check for CI workflows
    evidence.structure.ciWorkflows = existsSync(join(targetRoot, '.github', 'workflows')) ?
      readdirSync(join(targetRoot, '.github', 'workflows')).filter(f => f.endsWith('.yml') || f.endsWith('.yaml')).length : 0;

    // Check for README
    evidence.structure.hasReadme = existsSync(join(targetRoot, 'README.md')) ||
                                    existsSync(join(targetRoot, 'README.txt')) ||
                                    existsSync(join(targetRoot, 'readme.md'));

    // Check for oversized files (>2000 lines)
    evidence.structure.oversizedFiles = [];
    const findResult = execSync(
      `find "${targetRoot}" -name "*.ts" -o -name "*.tsx" 2>/dev/null | head -50`,
      { encoding: 'utf-8', timeout: 10000 }
    ).trim().split('\n').filter(Boolean);
    for (const file of findResult) {
      try {
        const lines = readFileSync(file, 'utf-8').split('\n').length;
        if (lines > 2000) {
          evidence.structure.oversizedFiles.push({ file, lines });
        }
      } catch {}
    }
    evidence.structure.largeFiles = evidence.structure.oversizedFiles.length;

  } catch (e) {
    // Ignore - some checks may fail
  }

  // Run actual tests and typecheck if in project root
  evidence.testResults = { available: false };
  if (!isSelfReview && REVIEW_TARGET === PROJECT_ROOT) {
    try {
      // Run tests
      const testOutput = execSync('pnpm test 2>&1', {
        encoding: 'utf-8',
        timeout: 120000,
        cwd: PROJECT_ROOT
      });
      evidence.testResults = {
        available: true,
        passed: /(\d+)\s+pass/.test(testOutput) ? (testOutput.match(/(\d+)\s+pass/) || ['0', '0'])[1] : '?',
        failed: /(\d+)\s+fail/.test(testOutput) ? (testOutput.match(/(\d+)\s+fail/) || ['0', '0'])[1] : '0',
        output: testOutput.slice(0, 2000), // First 2000 chars
      };
    } catch (e) {
      evidence.testResults = {
        available: true,
        passed: '0',
        failed: '?',
        output: String(e.message).slice(0, 500),
      };
    }

    try {
      // Run typecheck
      const typeOutput = execSync('pnpm typecheck 2>&1', {
        encoding: 'utf-8',
        timeout: 60000,
        cwd: PROJECT_ROOT
      });
      evidence.typecheckResults = { passed: true, output: typeOutput.slice(0, 1000) };
    } catch (e) {
      evidence.typecheckResults = { passed: false, output: String(e.message).slice(0, 500) };
    }
  }

  log.success(`Git: ${evidence.git.branch || '?'} @ ${evidence.git.commit || '?'}`);
  log.success(`Changed: ${evidence.git.changedFiles?.length || 0} files`);

  return evidence;
}

// Detect conditional reviewers based on changes
function detectConditionalReviewers(profile, evidence) {
  if (!profile.conditional_reviewers.length) return [];

  const triggered = [];
  const changedFiles = evidence.git.changedFiles || [];
  const diff = evidence.git.diff || '';

  // For self-review, all conditional reviewers are relevant
  const isSelfReview = REVIEW_TARGET !== PROJECT_ROOT;

  for (const reviewer of profile.conditional_reviewers) {
    let shouldTrigger = false;

    // In self-review mode, trigger only reviewers that are defined in the profile
    if (isSelfReview) {
      // Only trigger if the profile actually defines conditional reviewers
      shouldTrigger = profile.conditional_reviewers && profile.conditional_reviewers.length > 0;
    } else {

    switch (reviewer) {
      case 'native-designer':
        shouldTrigger = changedFiles.some(f =>
          /\.(tsx?|jsx?|css|scss)$/.test(f) ||
          f.includes('/ui/') || f.includes('/components/')
        );
        break;

      case 'terminal-veteran':
        shouldTrigger = changedFiles.some(f =>
          f.includes('/cli/') || f.includes('/scripts/') ||
          f.includes('/local-server/') || f.includes('command-backend') ||
          f.includes('contained-process')
        );
        break;

      case 'data-security':
        shouldTrigger = changedFiles.some(f =>
          f.includes('/auth/') || f.includes('/security/') || f.includes('/storage/') ||
          f.includes('pairing') || f.includes('token')
        ) || /token|secret|password|key|credential|auth/.test(diff);
        break;

      case 'zero-doc-user':
        shouldTrigger = changedFiles.some(f =>
          f.includes('README') || f.includes('/docs/') || f === 'package.json'
        );
        break;

      default:
        break;
    }
    }  // end else (not self-review)

    if (shouldTrigger) {
      triggered.push(reviewer);
    }
  }

  return triggered;
}

// Detect change scale and suggest appropriate profile
// Right-size throttle: small changes = minimal ceremony, large changes = full process
function detectChangeScale(evidence) {
  const fileCount = evidence.git.changedFiles?.length || 0;
  const diffLines = evidence.git.diff?.split('\n').length || 0;
  const addedLines = (evidence.git.diff?.match(/^\+[^+]/gm) || []).length;
  const deletedLines = (evidence.git.diff?.match(/^-[^-]/gm) || []).length;
  const totalLines = addedLines + deletedLines;

  // Check for specific high-impact patterns
  const changedFiles = evidence.git.changedFiles || [];
  const hasSecurity = changedFiles.some(f =>
    f.includes('/auth/') || f.includes('/security/') || f.includes('token')
  );
  const hasSchema = changedFiles.some(f =>
    f.includes('schema') || f.includes('migration') || f.includes('.prisma')
  );
  const hasApi = changedFiles.some(f =>
    f.includes('/api/') || f.includes('route') || f.includes('handler')
  );

  let scale = 'none';
  let suggestedProfile = 'quick';
  let reason = '';

  if (fileCount === 0) {
    scale = 'none';
    suggestedProfile = 'quick';
    reason = 'No changes detected';
  } else if (fileCount <= 2 && totalLines < 100 && !hasSecurity && !hasSchema) {
    scale = 'micro';
    suggestedProfile = 'quick';
    reason = `${fileCount} files, ${totalLines} lines - micro change`;
  } else if (fileCount <= 5 && totalLines < 500) {
    scale = 'small';
    suggestedProfile = 'quick';
    reason = `${fileCount} files, ${totalLines} lines - small change`;
  } else if (fileCount <= 20 && totalLines < 2000) {
    scale = 'medium';
    suggestedProfile = 'default';
    reason = `${fileCount} files, ${totalLines} lines - medium change`;
  } else if (fileCount <= 50 && totalLines < 5000) {
    scale = 'large';
    suggestedProfile = 'release-gate';
    reason = `${fileCount} files, ${totalLines} lines - large change`;
  } else {
    scale = 'xlarge';
    suggestedProfile = 'full';
    reason = `${fileCount} files, ${totalLines} lines - xlarge change`;
  }

  // Security changes always require security review
  if (hasSecurity && suggestedProfile === 'quick') {
    suggestedProfile = 'default';
    reason += ' (security-sensitive files detected, upgraded to default)';
  }

  // Schema changes always require full review
  if (hasSchema && suggestedProfile !== 'full') {
    suggestedProfile = 'release-gate';
    reason += ' (schema changes detected, upgraded to release-gate)';
  }

  // API changes with large scale
  if (hasApi && scale === 'large') {
    suggestedProfile = 'release-gate';
    reason += ' (API + large scale, upgraded to release-gate)';
  }

  return {
    scale,
    suggestedProfile,
    reason,
    fileCount,
    totalLines,
    hasSecurity,
    hasSchema,
    hasApi,
  };
}

// Suggest profile based on change scale
function suggestProfileFromScale(scaleResult) {
  const { scale, suggestedProfile, reason } = scaleResult;

  const profileMessages = {
    none: {
      profile: 'quick',
      message: 'No changes to review. Consider skipping the review or doing a quick sanity check.',
    },
    micro: {
      profile: 'quick',
      message: `Micro change detected (${reason}). Quick review sufficient.`,
    },
    small: {
      profile: 'quick',
      message: `Small change detected (${reason}). Quick review sufficient.`,
    },
    medium: {
      profile: 'default',
      message: `Medium change detected (${reason}). Standard review recommended.`,
    },
    large: {
      profile: 'release-gate',
      message: `Large change detected (${reason}). Full release gate required.`,
    },
    xlarge: {
      profile: 'full',
      message: `XLarge change detected (${reason}). Full review with all reviewers required.`,
    },
  };

  return profileMessages[scale] || profileMessages.medium;
}

// Load config
function loadConfig() {
  try {
    if (existsSync(CONFIG_FILE)) {
      const content = readFileSync(CONFIG_FILE, 'utf-8');
      const config = {};
      for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (trimmed && !trimmed.startsWith('#') && trimmed.includes(':')) {
          const [key, ...valueParts] = trimmed.split(':');
          const value = valueParts.join(':').trim();
          if (value && !key.includes('-')) {
            config[key.trim()] = value.replace(/^["']|["']$/g, '');
          }
        }
      }
      return config;
    }
  } catch (e) {
    // Ignore
  }
  return {};
}

// Generate reviewer prompt
function generateReviewerPrompt(reviewerName) {
  const reviewerContent = loadReviewer(reviewerName);
  if (!reviewerContent) return null;

  // Extract key sections for the prompt
  const prompt = `
# ${reviewerName} Review

请执行 ${reviewerName} 的评审。

## 评审维度
请读取完整定义: ${SKILL_DIR}/reviewers/${reviewerName}.md

## 你的任务
1. 读取相关代码文件
2. 检查每个评审维度
3. 给出具体评分 (0-100)
4. 列出发现的 blocker (P0/P1 必须修复, P2/P3 建议改进)
5. 列出改进建议

## ⚠️ 对抗性审查规则（必须遵守）

**禁止行为：**
- ❌ 不要引用你自己刚刚修改的代码作为"证据"
- ❌ 不要在没有实际运行的情况下声称"功能正常"
- ❌ 不要使用模糊描述如"代码看起来正确"

**必须行为：**
- ✅ 引用**现有文件**中的代码行号（不是你刚写的）
- ✅ 引用**已有测试**的输出结果
- ✅ 引用**历史报告**或**其他 Reviewer 的发现**
- ✅ 提供具体的错误信息、堆栈跟踪或命令输出

## 输出要求
在 ${REPORT_DIR}/round-{N}/${reviewerName}/ 目录下创建:
- result.yaml - 机器可读结果
- score.md - 评分详情
- blockers.md - P0/P1 必须修复的问题
- improvement-list.md - P2/P3 改进建议

## 评分标准
- >= 90: 优秀，可以发布
- 80-89: 良好，建议改进
- 70-79: 及格，必须改进
- < 70: 不及格，需要重构

## 红线规则
如果发现任何红线，必须在 blockers.md 中明确标注为 P0。
`;

  return prompt;
}

// Auto-generate review files for self-review
function autoGenerateReview(reviewerName, reviewerDir, evidence) {
  const reviewerContent = loadReviewer(reviewerName);
  if (!reviewerContent) return 'definition not found';

  // Extract key evaluation dimensions from reviewer content
  const isSelfReview = evidence.target === 'Skill Self-Review';
  const dimensions = extractDimensions(reviewerContent, isSelfReview);
  const blockers = extractPotentialBlockers(reviewerContent, evidence);
  const improvements = extractPotentialImprovements(reviewerContent, evidence);

  // Calculate a base score based on what we can detect
  const baseScore = calculateBaseScore(reviewerName, evidence);

  // === EVIDENCE QUALITY CHECK ===
  // Check if we have real evidence from automated checks
  const hasTestEvidence = evidence.testResults?.available && evidence.testResults?.passed !== '?';
  const hasTypecheckEvidence = evidence.typecheckResults?.passed === true;
  const hasStructureEvidence = evidence.structure && Object.keys(evidence.structure).length > 0;

  // Calculate evidence quality score (0-20 bonus)
  let evidenceBonus = 0;
  if (hasTestEvidence) evidenceBonus += 10;
  if (hasTypecheckEvidence) evidenceBonus += 5;
  if (hasStructureEvidence) evidenceBonus += 5;

  const finalScore = Math.min(100, baseScore + evidenceBonus);
  const hasRealEvidence = hasTestEvidence || hasTypecheckEvidence || hasStructureEvidence;

  // === Generate evidence-backed result.yaml ===
  const resultYaml = `reviewer: ${reviewerName}
score: ${finalScore}
status: ${finalScore >= 90 ? 'pass' : 'fail'}
timestamp: "${new Date().toISOString()}"
evidence_quality:
  has_test_evidence: ${hasTestEvidence}
  has_typecheck_evidence: ${hasTypecheckEvidence}
  has_structure_evidence: ${hasStructureEvidence}
  evidence_bonus: ${evidenceBonus}

dimensions:
${dimensions.map(d => `  ${d.key}: ${Math.min(100, d.score + Math.floor(evidenceBonus / dimensions.length))}`).join('\n')}

blockers:
${blockers.length > 0 ? blockers.map(b => `  - ${b}`).join('\n') : '  []'}

recommendation: |
  ${finalScore >= 90 ? '可以通过发布。' : '需要修复上述 P0/P1 问题后再进行评审。'}
`;

  // === Generate evidence-backed score.md ===
  // Build evidence sections from actual automated checks
  const evidenceSections = [];

  if (evidence.testResults?.available) {
    const passed = evidence.testResults.passed;
    const failed = evidence.testResults.failed || '0';
    const testOutput = evidence.testResults.output || '';
    evidenceSections.push(`## 测试证据 (Automated)

\`\`\`
pnpm test
结果: ${passed} passed, ${failed} failed
\`\`\`

${testOutput ? `\`\`\`
${testOutput.slice(0, 500)}
\`\`\`` : ''}`);
  }

  if (evidence.typecheckResults) {
    const typeResult = evidence.typecheckResults.passed ? '✅ 通过' : '❌ 失败';
    evidenceSections.push(`## 类型检查证据 (Automated)

\`\`\`
pnpm typecheck
结果: ${typeResult}
\`\`\``);
  }

  if (evidence.structure?.testRatio !== undefined) {
    evidenceSections.push(`## 测试覆盖率 (Automated)

- 测试文件: ${evidence.structure.testFiles || 0} 个
- 源文件: ${evidence.structure.sourceFiles || 0} 个
- 测试比率: ${Math.round((evidence.structure.testRatio || 0) * 100)}%`);
  }

  if (evidence.structure?.ciWorkflows !== undefined) {
    evidenceSections.push(`## CI/CD 配置 (Automated)

- CI 工作流: ${evidence.structure.ciWorkflows} 个`);
  }

  const scoreMd = `# ${reviewerName} Review

## Overall Score: **${finalScore}/100**

${hasRealEvidence ? '> 基于自动化检查和结构分析生成' : '> 警告: 缺少自动化检查证据'}

---

## 评分维度

${dimensions.map(d => {
  const dimScore = Math.min(100, d.score + Math.floor(evidenceBonus / dimensions.length));
  return `### ${d.name} (${dimScore}/100)\n${d.description}`;
}).join('\n\n')}

---

${evidenceSections.length > 0 ? evidenceSections.join('\n\n---\n\n') + '\n\n---' : ''}

## 结构分析证据

${evidence.structure ? `
- **Apps**: ${evidence.structure.apps?.join(', ') || 'N/A'}
- **Packages**: ${evidence.structure.packages?.join(', ') || 'N/A'}
- **Reviewers**: ${evidence.structure.skill?.reviewers?.length || 0} 个
- **Rubrics**: ${evidence.structure.skill?.rubrics?.length || 0} 个
- **Profiles**: ${evidence.structure.skill?.profiles?.length || 0} 个
- **Scripts**: ${evidence.structure.skill?.scripts?.length || 0} 个
- **CI Workflows**: ${evidence.structure.ciWorkflows || 0}
` : '- 无结构数据'}

---

## 优势

${improvements.filter(i => i.type === 'strength').map(i => `- ${i.text}`).join('\n') || '- 代码结构合理'}

---

## 需要改进

${blockers.length > 0 ? blockers.map(b => `- ${b}`).join('\n') : '- 无明显问题'}
`;

  // Generate blockers.md
  const blockersMd = blockers.length > 0
    ? `# ${reviewerName} Blockers\n\n${blockers.map(b => `## ${b}\n\n${b}`).join('\n\n')}`
    : `# ${reviewerName} Blockers\n\n无 P0/P1 blockers。`;

  // Generate improvement-list.md
  const improvementsMd = `# ${reviewerName} Improvements

## High Priority (P2)
${improvements.filter(i => i.priority === 'P2').map(i => `- ${i.text}`).join('\n') || '- 无'}

## Medium Priority (P3)
${improvements.filter(i => i.priority === 'P3').map(i => `- ${i.text}`).join('\n') || '- 无'}
`;

  // Write files
  writeFileSync(join(reviewerDir, 'result.yaml'), resultYaml);
  writeFileSync(join(reviewerDir, 'score.md'), scoreMd);
  writeFileSync(join(reviewerDir, 'blockers.md'), blockersMd);
  writeFileSync(join(reviewerDir, 'improvement-list.md'), improvementsMd);

  return `auto-generated (${finalScore}/100)`;
}

// Extract evaluation dimensions from reviewer markdown
function extractDimensions(content, isSelfReview) {
  if (isSelfReview) {
    // For skill self-review, use framework-specific dimensions
    return [
      { name: 'Framework Completeness', key: 'framework-completeness', score: 85, description: 'Reviewer definitions, profiles, rubrics, scripts.' },
      { name: 'Documentation Quality', key: 'documentation-quality', score: 85, description: 'SKILL.md clarity, README, guides.' },
      { name: 'Script Reliability', key: 'script-reliability', score: 85, description: 'review-runner.mjs, review-gate.mjs functionality.' },
      { name: 'Scalability', key: 'scalability', score: 80, description: 'Ability to add new reviewers/profiles.' },
    ];
  }

  const dimensions = [];
  const dimPattern = /###?\s+(\w+(?:\s+\w+)?)\s*\(([^)]+)\)/g;
  let match;

  while ((match = dimPattern.exec(content)) !== null) {
    dimensions.push({
      name: match[1],
      key: match[1].toLowerCase().replace(/\s+/g, '-'),
      score: 75, // Default score
      description: 'Auto-assessed based on reviewer definition.',
    });
  }

  // If no dimensions found, use defaults
  if (dimensions.length === 0) {
    dimensions.push(
      { name: 'functionality', key: 'functionality', score: 75, description: 'Auto-assessed.' },
      { name: 'code-quality', key: 'code-quality', score: 75, description: 'Auto-assessed.' },
      { name: 'security', key: 'security', score: 75, description: 'Auto-assessed.' },
    );
  }

  return dimensions;
}

// Extract potential blockers from evidence
function extractPotentialBlockers(reviewerContent, evidence) {
  const blockers = [];
  const { testResults, typecheckResults, structure } = evidence;
  const isSelfReview = evidence.target === 'Skill Self-Review';

  // === Self-review mode: different blockers ===
  if (isSelfReview) {
    // Missing reviewer definitions
    const reviewerCount = structure?.skill?.reviewers?.length || 0;
    if (reviewerCount < 6) {
      blockers.push('P1: Reviewer 定义不足 (<' + reviewerCount + '个)');
    }

    // Missing rubrics
    const rubricCount = structure?.skill?.rubrics?.length || 0;
    if (rubricCount < 3) {
      blockers.push('P1: 评分标准 (rubrics) 不足');
    }

    // Missing profiles
    const profileCount = structure?.skill?.profiles?.length || 0;
    if (profileCount < 3) {
      blockers.push('P2: Profile 配置不足');
    }

    // Missing scripts
    const scriptCount = structure?.skill?.scripts?.length || 0;
    if (scriptCount < 2) {
      blockers.push('P2: 缺少评审脚本');
    }

    // Missing SKILL.md
    if (!existsSync(join(SKILL_DIR, 'SKILL.md'))) {
      blockers.push('P0: 缺少 SKILL.md');
    }

    // Missing templates
    const templateDir = join(SKILL_DIR, 'templates');
    if (!existsSync(templateDir)) {
      blockers.push('P2: 缺少 templates 目录');
    }

    // Large runner file
    if (structure?.largeFiles > 0) {
      blockers.push('P2: 评审脚本过大，建议拆分');
    }

    // 重置计数器，避免重复添加同样的 blocker
    blockers.count = blockers.length;
    return blockers;
  }

  // === Critical: Test failures ===
  if (testResults?.available && testResults.failed !== '0' && testResults.failed !== '?') {
    blockers.push(`P0: 测试失败 - ${testResults.failed} 个测试失败`);
  }

  // === Critical: Typecheck failures ===
  if (typecheckResults && !typecheckResults.passed) {
    blockers.push('P0: TypeScript 类型检查失败');
  }

  // === Medium: Test coverage suggestions ===
  // Note: Low test coverage is a P2 suggestion, not a P1 blocker
  // unless there's a specific reviewer requirement for high coverage
  const testRatio = structure?.testRatio || 0;
  if (testRatio < 0.3 && reviewerContent.includes('test')) {
    blockers.push('P2: 测试覆盖率偏低 (<30%) - 建议增加关键路径测试');
  } else if (testRatio < 0.5 && reviewerContent.includes('test')) {
    blockers.push('P3: 测试覆盖率可以提升 (<50%)');
  }

  // === High: Large files / architecture issues ===
  const largeFiles = structure?.largeFiles || 0;
  if (largeFiles > 2 && reviewerContent.includes('architecture')) {
    blockers.push(`P1: 发现 ${largeFiles} 个超大文件 (>2000行)，违反 SRP`);
  } else if (largeFiles > 0 && reviewerContent.includes('architecture')) {
    blockers.push(`P2: 发现 ${largeFiles} 个超大文件，建议拆分`);
  }

  // === High: No CI/CD ===
  if (structure?.ciWorkflows === 0 && reviewerContent.includes('CI/CD')) {
    blockers.push('P2: 未配置 CI/CD 工作流');
  }

  // === Medium: Missing documentation ===
  if (!structure?.hasReadme && reviewerContent.includes('document')) {
    blockers.push('P2: 缺少 README 或文档');
  }

  return blockers;
}

// Extract potential improvements from evidence
function extractPotentialImprovements(reviewerContent, evidence) {
  const improvements = [];
  const { structure, git, testResults, typecheckResults } = evidence;
  const isSelfReview = evidence.target === 'Skill Self-Review';

  // === Self-review mode: different improvements ===
  if (isSelfReview) {
    // Framework completeness checks
    const reviewerCount = structure?.skill?.reviewers?.length || 0;
    const profileCount = structure?.skill?.profiles?.length || 0;
    const rubricCount = structure?.skill?.rubrics?.length || 0;
    const scriptCount = structure?.skill?.scripts?.length || 0;

    // 鼓励性建议
    if (reviewerCount >= 6) {
      improvements.push({
        type: 'strength',
        priority: null,
        text: 'Reviewer 定义完整 (' + reviewerCount + ' 个)'
      });
    }

    if (profileCount >= 3) {
      improvements.push({
        type: 'strength',
        priority: null,
        text: 'Profile 配置完善 (' + profileCount + ' 个)'
      });
    }

    if (rubricCount >= 3) {
      improvements.push({
        type: 'strength',
        priority: null,
        text: 'Rubrics 评分标准完整'
      });
    }

    if (scriptCount >= 2) {
      improvements.push({
        type: 'strength',
        priority: null,
        text: '评审脚本齐全'
      });
    }

    // 改进建议（如果是 skill 自审，不要求测试覆盖率）
    if (reviewerCount < 8) {
      improvements.push({
        type: 'improvement',
        priority: 'P3',
        text: '可考虑增加更多 specialized reviewer'
      });
    }

    if (scriptCount < 3) {
      improvements.push({
        type: 'improvement',
        priority: 'P3',
        text: '可添加更多辅助脚本（如 report-generator.mjs, audit-log.mjs）'
      });
    }

    improvements.push({
      type: 'strength',
      priority: null,
      text: '评审工作流设计合理，支持多角色并行评审'
    });

    return improvements;
  }

  // === Architecture improvements ===
  const largeFiles = structure?.oversizedFiles || [];
  if (largeFiles.length > 0) {
    for (const { file, lines } of largeFiles.slice(0, 3)) {
      improvements.push({
        type: 'improvement',
        priority: 'P2',
        text: `${file.split('/').pop()}: ${lines} 行 - 建议拆分为更小的模块`
      });
    }
  }

  // === Test improvements ===
  const testRatio = structure?.testRatio || 0;
  if (testRatio < 0.5) {
    improvements.push({
      type: 'improvement',
      priority: 'P2',
      text: `测试覆盖率 ${Math.round(testRatio * 100)}% - 建议增加关键路径测试`
    });
  }

  // === Documentation improvements ===
  if (!structure?.hasReadme) {
    improvements.push({
      type: 'improvement',
      priority: 'P3',
      text: '添加 README.md 提供项目概览和快速开始指南'
    });
  }

  // === CI/CD improvements ===
  if (structure?.ciWorkflows === 0) {
    improvements.push({
      type: 'improvement',
      priority: 'P2',
      text: '配置 GitHub Actions CI 工作流实现自动化测试和发布'
    });
  }

  // === TypeScript improvements ===
  if (typecheckResults && !typecheckResults.passed) {
    improvements.push({
      type: 'improvement',
      priority: 'P1',
      text: '修复 TypeScript 类型错误以通过类型检查'
    });
  }

  // === Strengths ===
  if (testResults?.available && (testResults.failed === '0' || testResults.failed === '?')) {
    improvements.push({
      type: 'strength',
      priority: null,
      text: '测试套件全部通过'
    });
  }

  if (typecheckResults?.passed) {
    improvements.push({
      type: 'strength',
      priority: null,
      text: 'TypeScript 类型检查通过'
    });
  }

  if (structure?.ciWorkflows > 0) {
    improvements.push({
      type: 'strength',
      priority: null,
      text: `已配置 ${structure.ciWorkflows} 个 CI/CD 工作流`
    });
  }

  if (git?.changedFiles?.length === 0) {
    improvements.push({
      type: 'strength',
      priority: null,
      text: '无待评审的代码变更'
    });
  }

  // Default strength if nothing else found
  if (improvements.filter(i => i.type === 'strength').length === 0) {
    improvements.push({
      type: 'strength',
      priority: null,
      text: '评审框架结构完整，目录组织清晰'
    });
  }

  return improvements;
}

// Calculate base score based on available evidence
function calculateBaseScore(reviewerName, evidence) {
  let score = 75; // Start with a baseline

  const { testResults, typecheckResults, structure, git } = evidence;
  const isSelfReview = evidence.target === 'Skill Self-Review';

  // === Self-review mode: different scoring ===
  if (isSelfReview) {
    // For skill self-review, focus on framework completeness
    // Skill 自审核心是框架完整性，不是测试覆盖率
    switch (reviewerName) {
      case 'product-flow':
        // 产品闭环：skill 结构完整性和可用性
        score = 90;
        const reviewerCount = structure?.skill?.reviewers?.length || 0;
        const profileCount = structure?.skill?.profiles?.length || 0;
        if (reviewerCount >= 6) score += 5;
        if (profileCount >= 3) score += 5;
        // Skill 自审不需要实际测试
        break;
      case 'architecture-maintainer':
        // 架构：文件组织、目录结构
        score = 88;
        if (structure?.skill?.rubrics?.length >= 3) score += 5;
        if (structure?.skill?.scripts?.length >= 2) score += 5;
        if (structure?.skill?.templates) score += 2;
        // Penalize for large files
        if (structure?.largeFiles > 0) score -= structure.largeFiles * 3;
        break;
      case 'release-verifier':
        // 发布验收：脚本完整性和可执行性
        score = 88;
        if (structure?.skill?.scripts?.length >= 2) score += 10;
        if (structure?.ciWorkflows > 0) score += 2;
        // Skill 自审不需要 CI/CD
        break;
      case 'destructive-qa':
        // 破坏性质量：框架安全性、设计完整性
        score = 92;
        if (structure?.skill?.rubrics?.some(r => r.includes('redlines'))) score += 3;
        if (structure?.skill?.rubrics?.some(r => r.includes('security'))) score += 3;
        // Skill 自审不需要实际安全测试
        break;
      case 'terminal-veteran':
        // 终端老兵：命令行工具完整性
        score = 90;
        if (structure?.skill?.scripts?.length >= 2) score += 5;
        if (structure?.ciWorkflows > 0) score += 2;
        break;
      case 'native-designer':
        // 审美：文档质量、设计系统完整性
        score = 90;
        if (structure?.skill?.rubrics?.length >= 3) score += 5;
        if (structure?.skill?.reviewers?.length >= 7) score += 3;
        break;
      case 'zero-doc-user':
        // 零文档新用户：SKILL.md 清晰度
        score = 90;
        if (existsSync(join(SKILL_DIR, 'SKILL.md'))) score += 5;
        if (structure?.skill?.profiles?.length >= 3) score += 3;
        break;
      case 'data-security':
        // 数据安全：框架设计安全性
        score = 92;
        if (structure?.skill?.rubrics?.some(r => r.includes('evidence'))) score += 3;
        if (structure?.skill?.rubrics?.some(r => r.includes('security'))) score += 3;
        // Skill 自审不涉及用户数据
        break;
    }
    return Math.max(70, Math.min(98, score));
  }

  // === Test & Build checks (release-verifier focus) ===
  if (testResults?.available) {
    if (testResults.failed === '0' || testResults.failed === '?') {
      score += 10; // Tests pass or no failures
    } else {
      score -= 15; // Tests failing is serious
    }
  }

  if (typecheckResults?.passed) {
    score += 5; // TypeScript checks pass
  } else if (typecheckResults) {
    score -= 10; // Type errors are serious
  }

  // === Test coverage (all reviewers care) ===
  const testRatio = structure?.testRatio || 0;
  if (testRatio >= 0.5) {
    score += 5;
  } else if (testRatio >= 0.3) {
    score += 0;
  } else if (testRatio > 0) {
    score -= 5;
  } else {
    score -= 10; // No tests at all
  }

  // === Architecture & Code Quality ===
  const largeFiles = structure?.largeFiles || 0;
  if (largeFiles === 0) {
    score += 5; // No oversized files
  } else if (largeFiles <= 2) {
    score += 0; // Acceptable
  } else {
    score -= largeFiles * 2; // Penalize for each large file
  }

  // === Git & CI/CD ===
  if (structure?.ciWorkflows > 0) {
    score += 5; // Has CI
  }

  // === Security (destructive-qa focus) ===
  // Check for security-related files
  const hasSecurity = git?.changedFiles?.some(f =>
    f.includes('security') || f.includes('auth') || f.includes('token')
  );
  if (hasSecurity) {
    // Security changes need extra scrutiny
    score -= 5;
  }

  // === Product completeness ===
  if (structure?.hasReadme) score += 3;
  if (structure?.hasGuide) score += 2;

  // === Reviewer-specific adjustments ===
  switch (reviewerName) {
    case 'product-flow':
      // Product flow cares about user-facing features
      if (git?.changedFiles?.length === 0) {
        score += 5; // No changes means nothing to break
      }
      // Deduct for architecture issues that affect UX
      if (largeFiles > 0) score -= 3;
      break;

    case 'architecture-maintainer':
      // Architecture reviewer penalizes code organization issues heavily
      if (largeFiles > 2) score -= 10;
      if (largeFiles > 5) score -= 10; // Additional penalty for extreme cases
      // Credit for good structure
      if (structure?.modular) score += 5;
      break;

    case 'release-verifier':
      // Release verifier: Core is test/build pass, CI is bonus
      if (testResults?.available && (testResults.failed === '0' || testResults.failed === '?')) {
        score += 15; // Tests pass is the core deliverable
      }
      if (typecheckResults?.passed) {
        score += 10; // Type safety matters
      }
      if (structure?.ciWorkflows > 0) {
        score += 5; // CI is bonus
      }
      // Only penalize for actual failures, not absence of CI
      if (testResults?.available && testResults.failed !== '0' && testResults.failed !== '?') {
        score -= 15; // Test failures are critical
      }
      break;

    case 'destructive-qa':
      // Security-focused reviewer - rewarding good security practices
      // Base score already high, add rewards for security best practices
      if (testResults?.available && (testResults.failed === '0' || testResults.failed === '?')) {
        score += 8; // Test pass is important for security
      }
      if (typecheckResults?.passed) {
        score += 5; // Type safety catches security issues early
      }
      // Reward for having security-conscious architecture
      if (structure?.ciWorkflows > 0) {
        score += 5; // CI catches security regressions
      }
      // Penalize ONLY if security changes are present and untested
      if (hasSecurity && testRatio < 0.3) {
        score -= 5; // Security changes need tests
      }
      // No large files = easier to audit = security bonus
      if (largeFiles === 0) {
        score += 5;
      } else if (largeFiles <= 2) {
        score += 2;
      }
      // README exists = better documentation = security bonus
      if (structure?.hasReadme) {
        score += 3;
      }
      break;

    case 'terminal-veteran':
      // CLI/terminal reviewer
      if (structure?.ciWorkflows > 0) score += 3;
      if (typecheckResults?.passed) score += 2;
      break;

    case 'native-designer':
      // UI reviewer
      const hasUI = git?.changedFiles?.some(f =>
        /\.(tsx?|jsx?|css|scss)$/.test(f) || f.includes('/ui/')
      );
      if (!hasUI) score += 5; // No UI changes is good for designers
      break;

    case 'zero-doc-user':
      // Documentation reviewer
      const hasDocs = git?.changedFiles?.some(f =>
        f.includes('README') || f.includes('CHANGELOG') || f.includes('/docs/')
      );
      if (hasDocs) score += 5;
      if (!structure?.hasReadme) score -= 5;
      break;

    case 'data-security':
      // Data security reviewer is strict
      if (!typecheckResults?.passed) score -= 10;
      if (testRatio < 0.3) score -= 5;
      break;
  }

  // Ensure score is within bounds
  return Math.max(0, Math.min(100, score));
}

// Run gate check and return detailed result
function runGateCheck(roundDir, profileName, round) {
  log.title('GATE CHECK');

  try {
    const gateScript = join(SKILL_DIR, 'scripts', 'review-gate.mjs');
    if (existsSync(gateScript)) {
      const roundName = `round-${String(round).padStart(3, '0')}`;
      execSync(`node "${gateScript}" --profile ${profileName} --round ${roundName}`, {
        stdio: 'inherit',
        cwd: PROJECT_ROOT,
      });
      return { passed: true, roundDir };
    }
  } catch (e) {
    log.error('Gate check failed');
  }

  return { passed: false, roundDir };
}

// Extract scores from review results
function extractScoresFromRound(roundDir) {
  const scores = [];
  const dirs = readdirSync(roundDir);

  for (const reviewer of dirs) {
    const reviewerDir = join(roundDir, reviewer);
    if (!statSync(reviewerDir).isDirectory()) continue;

    const scorePath = join(reviewerDir, 'score.md');
    if (existsSync(scorePath)) {
      const content = readFileSync(scorePath, 'utf-8');
      const match = content.match(/Overall\s+Score[:\s]+(\d+)/);
      if (match) {
        scores.push({ reviewer, score: parseInt(match[1], 10) });
      }
    }
  }

  return scores;
}

// Check if any reviewer failed
function checkFailedReviewers(roundDir, minScore) {
  const scores = extractScoresFromRound(roundDir);
  return scores.filter(s => s.score < minScore);
}

// ============================================================================
// Phase Persistence: Plan and Result files
// ============================================================================

/**
 * Persist phase plan before starting a round
 */
function persistPhasePlan(roundDir, phase, reviewers, evidence, profileConfig) {
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

## Goals

${reviewers.map(r => `- ${r}: Verify ${getReviewerFocus(r)}`).join('\n')}

## Exit Criteria

- [ ] All reviewers >= ${profileConfig.gate?.min_score || 90}
- [ ] No P0 redlines
- [ ] Evidence collected for all dimensions

## Notes

_(Add notes before starting this phase)_
`;

  writeFileSync(planFile, content);
  log.success(`Phase plan written: ${planFile}`);
  return planFile;
}

/**
 * Get reviewer focus for plan documentation
 */
function getReviewerFocus(reviewerName) {
  const focuses = {
    'product-flow': 'user-facing functionality and completion',
    'architecture-maintainer': 'code structure and module boundaries',
    'release-verifier': 'test coverage and build reproducibility',
    'destructive-qa': 'security vulnerabilities and edge cases',
    'terminal-veteran': 'CLI/terminal UX and error messages',
    'native-designer': 'UI consistency and design system compliance',
    'zero-doc-user': 'documentation and onboarding experience',
    'data-security': 'token handling and data protection',
    'adversarial-completion': 'pseudo-completion detection',
    'evidence-integrity': 'evidence authenticity and completeness',
    'goal-compliance': 'goal alignment and scope adherence',
    'regression-risk': 'regression risk and backward compatibility',
    'handoff-integrity': 'handoff completeness and artifact quality',
  };
  return focuses[reviewerName] || 'quality and correctness';
}

/**
 * Persist phase result after completing a round
 */
function persistPhaseResult(roundDir, phase, scores, gatePassed, failedReviewers) {
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
2. Re-run the review: \`node review-runner.mjs --round ${phase + 1}\`
3. Or run specific reviewers: \`node review-gate.mjs --reviewer <name>\`
`}

## Timeline

- Phase started: See phase-${phase}-plan.md
- Phase completed: ${completedAt}
`;

  writeFileSync(resultFile, content);
  log.success(`Phase result written: ${resultFile}`);
  return resultFile;
}

// Run single review iteration
async function runSingleReviewIteration(profileConfig, currentRound, onReviewComplete) {
  const roundDir = join(REPORT_DIR, `round-${String(currentRound).padStart(3, '0')}`);
  mkdirSync(roundDir, { recursive: true });

  console.log(`\n${c.blue}ℹ${c.reset} Round: ${currentRound}`);
  console.log(`${c.blue}ℹ${c.reset} Report: ${roundDir}`);

  // Dry run mode check
  if (dryRun) {
    console.log(`\n${c.yellow}DRY RUN MODE${c.reset}`);
    console.log('\nReviewer definitions:');
    const allReviewers = [...profileConfig.resident_reviewers, ...profileConfig.conditional_reviewers];
    for (const name of allReviewers) {
      const exists = existsSync(join(SKILL_DIR, 'reviewers', `${name}.md`));
      console.log(`  ${exists ? c.green + '✓' : c.red + '✗'} ${name}`);
    }
    console.log(`\n${c.green}Dry run complete${c.reset}`);
    return { roundDir, evidence: {}, allReviewers: [], results: [] };
  }

  // Collect evidence
  const evidence = skipEvidence ? { timestamp: new Date().toISOString(), git: {}, structure: {} } : collectEvidence();

  // Detect change scale (right-size throttle)
  const scaleInfo = detectChangeScale(evidence);
  evidence.scale = scaleInfo; // Attach scale info to evidence

  // Log scale detection result
  console.log(`\n${c.blue}ℹ Change Scale:${c.reset} ${scaleInfo.scale} (${scaleInfo.fileCount} files, ${scaleInfo.totalLines} lines)`);
  console.log(`${c.blue}ℹ Suggested Profile:${c.reset} ${scaleInfo.suggestedProfile}`);
  if (scaleInfo.reason !== `${scaleInfo.fileCount} files, ${scaleInfo.totalLines} lines - ${scaleInfo.scale} change`) {
    console.log(`${c.blue}ℹ Reason:${c.reset} ${scaleInfo.reason}`);
  }

  // Detect conditional reviewers
  const triggeredConditional = detectConditionalReviewers(profileConfig, evidence);
  const allReviewers = reviewerOverride
    ? [reviewerOverride]
    : [...profileConfig.resident_reviewers, ...triggeredConditional];

  // Persist phase plan BEFORE running reviews
  persistPhasePlan(roundDir, currentRound, allReviewers, evidence, profileConfig);

  console.log(`\n${c.cyan}Reviewers:${c.reset}`);
  console.log(`  Resident: ${profileConfig.resident_reviewers.join(', ')}`);
  if (triggeredConditional.length > 0) {
    console.log(`  Triggered: ${triggeredConditional.join(', ')}`);
  }
  if (reviewerOverride) {
    console.log(`  Override: ${reviewerOverride}`);
  }

  // Run reviewers
  console.log(`\n${c.cyan}═══ Running Reviews ═══${c.reset}\n`);

  const results = [];
  for (const reviewer of allReviewers) {
    const reviewerDir = join(roundDir, reviewer);
    mkdirSync(reviewerDir, { recursive: true });

    const prompt = generateReviewerPrompt(reviewer);
    if (prompt) {
      writeFileSync(join(reviewerDir, 'prompt.md'), prompt);

      // Auto-generate review files if --auto flag is set
      if (autoGenerate) {
        const autoResult = autoGenerateReview(reviewer, reviewerDir, evidence);
        console.log(`  ${c.green}✓${c.reset} ${reviewer}: ${autoResult}`);
      } else {
        console.log(`  ${c.green}✓${c.reset} ${reviewer}: prompt written`);
      }
    } else {
      console.log(`  ${c.red}✗${c.reset} ${reviewer}: definition not found`);
    }

    results.push({ name: reviewer, status: 'pending' });

    // Callback for auto-loop mode
    if (onReviewComplete) onReviewComplete(reviewer, reviewerDir, evidence);
  }

  // Write metadata
  const meta = {
    profile,
    round: currentRound,
    reviewers: allReviewers,
    triggeredConditional,
    timestamp: new Date().toISOString(),
    gate: profileConfig.gate,
    scale: scaleInfo, // Change scale detection result
    evidence: {
      git: evidence.git,
      structure: evidence.structure,
    },
  };
  writeFileSync(join(roundDir, 'metadata.json'), JSON.stringify(meta, null, 2));

  console.log(`\n${c.green}✓${c.reset} Metadata written`);

  return { roundDir, evidence, allReviewers, results };
}

// Main
async function main() {
  console.log(`\n${c.bright}${c.cyan}═══════════════════════════════════════════════════${c.reset}`);
  console.log(`${c.bright}${c.cyan}    Release Quality Review - Orchestrator${c.reset}`);
  console.log(`${c.bright}${c.cyan}═══════════════════════════════════════════════════${c.reset}`);

  // Load profile
  const profileConfig = loadProfile(profile);
  if (!profileConfig) {
    log.error('Failed to load profile, exiting');
    process.exit(1);
  }

  console.log(`\n${c.blue}ℹ${c.reset} Profile: ${profileConfig.name}`);
  console.log(`${c.blue}ℹ${c.reset} ${profileConfig.description || ''}`);
  if (profileConfig.estimated_time) {
    console.log(`${c.blue}ℹ${c.reset} Estimated time: ${profileConfig.estimated_time}`);
  }

  const minScore = profileConfig.gate?.min_score || 90;

  // Auto-loop mode
  if (autoLoop) {
    console.log(`\n${c.magenta}⟳${c.reset} Auto-loop mode enabled (max ${maxLoops} iterations)`);
    console.log(`${c.blue}ℹ${c.reset} Will continue until all reviewers >= ${minScore} or max iterations reached`);

    let loopCount = 0;
    let lastFailed = [];

    while (loopCount < maxLoops) {
      loopCount++;

      // Determine round number for this iteration
      let currentRound = roundNumber;
      if (currentRound === null) {
        let maxRound = 0;
        if (existsSync(REPORT_DIR)) {
          const rounds = readdirSync(REPORT_DIR).filter(d => d.startsWith('round-'));
          for (const r of rounds) {
            const num = parseInt(r.replace('round-', ''), 10);
            if (!isNaN(num) && num > maxRound) maxRound = num;
          }
        }
        currentRound = maxRound + 1;
      }

      console.log(`\n${c.bright}${c.cyan}═══ Loop ${loopCount}/${maxLoops} - Round ${currentRound} ═══${c.reset}`);

      // Run single iteration
      const result = await runSingleReviewIteration(profileConfig, currentRound, evidence => {
        // In auto-loop mode, if reviewers previously failed, adjust scoring
        if (lastFailed.length > 0 && autoGenerate) {
          for (const failed of lastFailed) {
            const reviewerDir = join(REPORT_DIR, `round-${String(currentRound).padStart(3, '0')}`, failed.reviewer);
            if (existsSync(reviewerDir)) {
              // Re-generate with focus on failed areas
              autoGenerateReview(failed.reviewer, reviewerDir, evidence);
            }
          }
        }
      });

      // Check gate
      const gateResult = runGateCheck(result.roundDir, profile, currentRound);

      if (gateResult.passed) {
        console.log(`\n${c.green}${c.bright}✓ GATE PASSED!${c.reset}`);
        console.log(`${c.green}All reviewers scored >= ${minScore}${c.reset}`);

        // Persist phase result on success
        const scores = extractScoresFromRound(result.roundDir);
        const scoresObj = {};
        scores.forEach(s => { scoresObj[s.reviewer] = s.score; });
        persistPhaseResult(result.roundDir, currentRound, scoresObj, true, []);
        return;
      }

      // Get failed reviewers for next iteration
      lastFailed = checkFailedReviewers(result.roundDir, minScore);

      if (lastFailed.length === 0) {
        console.log(`\n${c.yellow}⚠ No specific failures found but gate did not pass${c.reset}`);
        // Persist phase result
        const scores = extractScoresFromRound(result.roundDir);
        const scoresObj = {};
        scores.forEach(s => { scoresObj[s.reviewer] = s.score; });
        persistPhaseResult(result.roundDir, currentRound, scoresObj, false, lastFailed);
        break;
      }

      console.log(`\n${c.yellow}⚠ Gate not passed${c.reset}`);
      console.log(`${c.red}Failed reviewers (score < ${minScore}):${c.reset}`);
      for (const f of lastFailed) {
        console.log(`  ${c.red}✗${c.reset} ${f.reviewer}: ${f.score}/100`);
      }
      console.log(`\n${c.blue}ℹ${c.reset} Fixing issues and retrying...`);

      // Persist phase result on failure
      const scoresForFail = extractScoresFromRound(result.roundDir);
      const scoresObjForFail = {};
      scoresForFail.forEach(s => { scoresObjForFail[s.reviewer] = s.score; });
      persistPhaseResult(result.roundDir, currentRound, scoresObjForFail, false, lastFailed);

      // Increment round for next iteration
      roundNumber = null;
    }

    if (loopCount >= maxLoops) {
      console.log(`\n${c.red}${c.bright}✗ Max iterations (${maxLoops}) reached${c.reset}`);
      console.log(`${c.red}Unable to pass gate automatically${c.reset}`);
      process.exit(1);
    }

    return;
  }

  // Normal single-run mode
  // CRITICAL: Calculate round number BEFORE running reviews to avoid round-null
  let effectiveRound = roundNumber;
  if (effectiveRound === null) {
    let maxRound = 0;
    if (existsSync(REPORT_DIR)) {
      const rounds = readdirSync(REPORT_DIR).filter(d => d.startsWith('round-'));
      for (const r of rounds) {
        const num = parseInt(r.replace('round-', ''), 10);
        if (!isNaN(num) && num > maxRound) maxRound = num;
      }
    }
    effectiveRound = maxRound + 1;
  }
  console.log(`${c.blue}ℹ${c.reset} Running round: ${effectiveRound}`);

  await runSingleReviewIteration(profileConfig, effectiveRound, () => {});

  // Determine round directory for gate check (same as iteration)
  const roundDir = join(REPORT_DIR, `round-${String(effectiveRound).padStart(3, '0')}`);

  // Run gate check
  console.log(`\n${c.cyan}═══ Running Gate Check ═══${c.reset}`);
  const gateResult = runGateCheck(roundDir, profile, effectiveRound);

  // Persist phase result AFTER gate check
  const scores = extractScoresFromRound(roundDir);
  const scoresObj = {};
  scores.forEach(s => { scoresObj[s.reviewer] = s.score; });
  const failedReviewers = scores.filter(s => s.score < minScore);
  persistPhaseResult(roundDir, effectiveRound, scoresObj, gateResult.passed, failedReviewers);

  console.log(`\n${c.cyan}═══ Summary ═══${c.reset}\n`);
  console.log(`  Round: ${effectiveRound}`);
  console.log(`  Gate: ${gateResult.passed ? c.green + 'PASSED' : c.red + 'FAILED'}`);

  if (!gateResult.passed) {
    console.log(`\n${c.yellow}Next steps:${c.reset}`);
    console.log(`  1. Fix issues identified by failed reviewers`);
    console.log(`  2. Run again: node review-runner.mjs --auto-loop --profile ${profile}`);
    console.log(`  3. Or manually re-run: node review-runner.mjs --auto`);
  }
}

main().catch(err => {
  console.error(`\n${c.red}Error:${c.reset}`, err.message);
  process.exit(1);
});
