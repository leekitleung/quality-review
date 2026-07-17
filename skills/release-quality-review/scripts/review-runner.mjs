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
 *   node review-runner.mjs --target <dir>  # Review a specific directory (self-review)
 */

import { readFileSync, existsSync, readdirSync, realpathSync, statSync, writeFileSync, mkdirSync } from 'fs';
import { join, relative } from 'path';
import { execFileSync as nodeExecFileSync, spawn } from 'child_process';
import { createHash } from 'node:crypto';
import {
  calculateReviewerTimeout,
  detectChangeScale as detectCanonicalChangeScale,
  parseYamlProfile as parseYamlProfileShared, parseYamlResult, selectReviewers,
  validateResultYamlContract,
} from '../lib/review-utils.mjs';
import {
  extractResultScoresFromRound, persistPhasePlan, persistPhaseResult,
} from '../lib/phase-persistence.mjs';
import { createCandidateRuntime } from '../lib/candidate-runtime.mjs';
import {
  fetchRadarReviewerModel, selectRadarReviewerModel, validateReviewModelIdentity,
} from '../lib/model-selector.mjs';
import {
  createSubprocessEnv, ensureContainedDirectorySync, isPathWithin,
  outerSandboxAttestationFromEnv, readContainedFile, readContainedFileSync, redactSensitiveText,
  resolveReportDirectory, resolveWithinRoot, writeContainedFile,
} from '../lib/security-utils.mjs';

const PROJECT_ROOT = process.cwd();
const SKILL_DIR = join(PROJECT_ROOT, 'skills', 'release-quality-review');
let REPORT_DIR;
try {
  REPORT_DIR = resolveReportDirectory(PROJECT_ROOT);
} catch (error) {
  console.error(error.message);
  process.exit(4);
}
const CONFIG_FILE = join(SKILL_DIR, 'review-config.yaml');
const TOOL_ENV = createSubprocessEnv();
const OUTER_SANDBOX_ATTESTATION = outerSandboxAttestationFromEnv();
const {
  env: CANDIDATE_ENV, execSync, execFileSync,
} = createCandidateRuntime(PROJECT_ROOT, 'runner', OUTER_SANDBOX_ATTESTATION);
const REVIEWER_TIMEOUT_MS = parsePositiveDuration(process.env.RELEASE_QUALITY_REVIEWER_TIMEOUT_MS, 15 * 60 * 1000);
const REVIEWER_KILL_GRACE_MS = parsePositiveDuration(process.env.RELEASE_QUALITY_REVIEWER_KILL_GRACE_MS, 5000);
const REVIEWER_RETRY_MAX = parseInt(process.env.RELEASE_QUALITY_REVIEWER_RETRY_MAX || '2', 10);
const RETRY_BASE_DELAY_MS = parseInt(process.env.RELEASE_QUALITY_RETRY_BASE_DELAY_MS || '1000', 10);
const RETRY_MAX_JITTER_MS = parseInt(process.env.RELEASE_QUALITY_RETRY_MAX_JITTER_MS || '300', 10);
const REVIEWER_START_DELAY_MS = parseInt(process.env.RELEASE_QUALITY_REVIEWER_START_DELAY_MS || '0', 10);

function parsePositiveDuration(value, fallback) {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

// ANSI colors
const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const color = value => useColor ? value : '';
const c = {
  reset: color('\x1b[0m'),
  bright: color('\x1b[1m'),
  dim: color('\x1b[2m'),
  red: color('\x1b[31m'),
  green: color('\x1b[32m'),
  yellow: color('\x1b[33m'),
  blue: color('\x1b[34m'),
  cyan: color('\x1b[36m'),
  magenta: color('\x1b[35m'),
};

const log = {
  info: (msg) => console.log(`${c.blue}ℹ${c.reset} ${msg}`),
  success: (msg) => console.log(`${c.green}✓${c.reset} ${msg}`),
  warn: (msg) => console.log(`${c.yellow}⚠${c.reset} ${msg}`),
  error: (msg) => console.log(`${c.red}✗${c.reset} ${msg}`),
  title: (msg) => console.log(`\n${c.bright}${c.cyan}═══ ${msg} ═══${c.reset}\n`),
};

function parseCliArgs(args) {
  const options = {
    profile: 'release-gate', roundNumber: null, parallel: false, dryRun: false,
    skipEvidence: false, reviewerOverride: null, targetDir: null,
    checkGoalMode: false, diffBase: 'HEAD', agentCli: process.env.REVIEW_AGENT || null,
    model: process.env.REVIEW_MODEL || null,
    reasoningEffort: process.env.REVIEW_REASONING_EFFORT || null, radarSnapshot: null,
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--profile' && args[i + 1]) options.profile = args[++i];
  else if (arg === '--round' && args[i + 1]) {
    const value = args[++i];
    if (!/^\d+$/.test(value)) {
      console.error('Invalid --round: expected a positive integer');
      process.exit(4);
    }
    const parsed = parseInt(value, 10);
    if (!Number.isInteger(parsed) || parsed < 1) {
      console.error('Invalid --round: expected a positive integer');
      process.exit(4);
    }
    options.roundNumber = parsed;
  }
  else if (arg === '--parallel') options.parallel = true;
  else if (arg === '--dry-run') options.dryRun = true;
  else if (arg === '--skip-evidence') options.skipEvidence = true;
  else if (arg === '--reviewer' && args[i + 1]) options.reviewerOverride = args[++i];
  else if (arg === '--target' && args[i + 1]) options.targetDir = args[++i];
  else if (arg === '--check-goal-mode') options.checkGoalMode = true;
  else if (arg === '--base' && args[i + 1]) options.diffBase = args[++i];
  else if (arg === '--agent' && args[i + 1]) {
    const agent = args[++i];
    if (!['claude', 'codex'].includes(agent)) {
      console.error('Invalid --agent: must be "claude" or "codex"');
      process.exit(4);
    }
    options.agentCli = agent;
  }
  else if (arg === '--model' && args[i + 1]) options.model = args[++i];
  else if (arg === '--reasoning-effort' && args[i + 1]) options.reasoningEffort = args[++i];
  else if (arg === '--radar-snapshot' && args[i + 1]) options.radarSnapshot = args[++i];
  else if (arg === '--help' || arg === '-h') {
    printHelp();
    process.exit(0);
  }
  else {
    console.error(`Unknown or incomplete option: ${arg}`);
    process.exit(4);
  }
  }
  return Object.freeze(options);
}

const {
  profile, roundNumber, parallel, dryRun, skipEvidence, reviewerOverride,
  targetDir, checkGoalMode, diffBase, agentCli, model, reasoningEffort, radarSnapshot,
} = parseCliArgs(process.argv.slice(2));

if (!/^[a-z0-9-]+$/.test(profile) || (reviewerOverride && !/^[a-z0-9-]+$/.test(reviewerOverride))) {
  console.error('Invalid profile or reviewer name');
  process.exit(4);
}

const explicitModel = model && model !== 'auto' ? model : null;
if (agentCli && !['claude', 'codex'].includes(agentCli)) {
  console.error('Invalid review agent: must be "claude" or "codex"');
  process.exit(4);
}
if ((!dryRun || agentCli || model || reasoningEffort) && !agentCli) {
  console.error('actual reviews require explicit --agent');
  process.exit(4);
}
if (agentCli === 'claude' && !explicitModel) {
  console.error('claude reviews require explicit --model');
  process.exit(4);
}
if (reasoningEffort && !/^(?:minimal|low|medium|high|xhigh|max)$/.test(reasoningEffort)) {
  console.error('invalid --reasoning-effort value');
  process.exit(4);
}
if (reasoningEffort && (agentCli !== 'codex' || !explicitModel)) {
  console.error('--reasoning-effort requires an explicit Codex model');
  process.exit(4);
}
if (explicitModel) {
  const identity = validateReviewModelIdentity({
    backend: agentCli, model: explicitModel, reasoningEffort: reasoningEffort || null,
  });
  if (!identity.valid) {
    console.error(identity.error === 'invalid review model' ? 'invalid --model value' : identity.error);
    process.exit(4);
  }
}

function resolveDiffBase(ref) {
  if (ref === 'HEAD') return 'HEAD';
  if (!/^[A-Za-z0-9._/@-]+$/.test(ref)) {
    console.error(`Invalid --base ref: ${ref}`);
    process.exit(4);
  }
  try {
    return nodeExecFileSync('git', ['merge-base', ref, 'HEAD'], {
      encoding: 'utf-8', cwd: PROJECT_ROOT, timeout: 10000, env: TOOL_ENV,
    }).trim();
  } catch {
    console.error(`Unable to resolve --base ref: ${ref}`);
    process.exit(4);
  }
}
const resolvedDiffBase = resolveDiffBase(diffBase);

// Resolve target directory (self-review target vs project root)
function resolveReviewTarget(relative) {
  try {
    return relative ? resolveWithinRoot(PROJECT_ROOT, relative, 'review target') : PROJECT_ROOT;
  } catch (error) {
    console.error(error.message);
    process.exit(4);
  }
}
const REVIEW_TARGET = resolveReviewTarget(targetDir);
if (!existsSync(REVIEW_TARGET) || !statSync(REVIEW_TARGET).isDirectory()) {
  console.error(`Review target is not a directory: ${REVIEW_TARGET}`);
  process.exit(4);
}
if (!isPathWithin(realpathSync(PROJECT_ROOT), realpathSync(REVIEW_TARGET))) {
  console.error('Review target resolves outside the repository');
  process.exit(4);
}

function printHelp() {
  console.log(`
${c.bright}Review Runner - Quality Review Orchestrator${c.reset}

Usage:
  node review-runner.mjs [options]

Options:
  --profile <name>   Profile: quick, default, release-gate, full, agentic-release-gate
  --round <N>        Round number (auto-detected if not specified)
  --parallel         Run reviewers in parallel
  --agent <type>     Required backend for actual reviews: claude or codex
  --model <name>     Explicit model; Codex auto-selects from Radar when omitted
  --reasoning-effort Explicit Codex effort: minimal, low, medium, high, xhigh, max
  --radar-snapshot   Repository-relative Codex Radar JSON snapshot
  --reviewer <name>  Run only this reviewer
  --target <path>    Review target directory (for self-review: skills/release-quality-review)
  --skip-evidence    Skip automatic evidence collection
  --dry-run          Validate configuration without running
  --check-goal-mode  Enable goal mode constraint check
  --base <ref>       Git diff base for change detection (default: HEAD)
  --help, -h         Show this help

Examples:
  node review-runner.mjs --profile release-gate --agent codex
  node review-runner.mjs --profile release-gate --agent codex --model gpt-5.4
  node review-runner.mjs --profile quick --agent codex --radar-snapshot evidence/codex-radar.json --dry-run
  node review-runner.mjs --profile default --parallel --agent claude --model claude-sonnet-4-6
  node review-runner.mjs --agent codex --model gpt-5.4
  node review-runner.mjs --reviewer destructive-qa --dry-run
  node review-runner.mjs --target skills/release-quality-review --profile quick --dry-run
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
    return parseYamlProfileShared(content, profileName);
  } catch (e) {
    log.error(`Failed to load profile: ${e.message}`);
    return null;
  }
}

// Load reviewer definitions
function loadReviewer(name) {
  const path = join(SKILL_DIR, 'reviewers', `${name}.md`);
  if (!existsSync(path)) return null;
  return readFileSync(path, 'utf-8');
}

// Collect evidence with config
function collectEvidence(config) {
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
  const gitOptions = {
    encoding: 'utf-8', cwd: PROJECT_ROOT, env: CANDIDATE_ENV,
    sandboxReadOnlyRoots: [PROJECT_ROOT],
  };

  // Git info (always from PROJECT_ROOT)
  let gitEvidenceError = null;
  try {
    evidence.git = {
      branch: execSync('git branch --show-current 2>/dev/null', gitOptions).trim(),
      commit: execSync('git rev-parse --short HEAD 2>/dev/null', gitOptions).trim(),
      status: execSync('git status --short 2>/dev/null', gitOptions).trim(),
      diffStats: execSync(`git diff --stat ${resolvedDiffBase} 2>/dev/null`, gitOptions).trim(),
    };

    // For self-review, only show changes in the skill directory
    if (isSelfReview) {
      evidence.git.changedFiles = execSync(
        `git diff --name-only ${resolvedDiffBase} 2>/dev/null | grep "^skills/release-quality-review/" || true`,
        gitOptions
      ).trim().split('\n').filter(Boolean);
      evidence.git.diff = execSync(
        `git diff ${resolvedDiffBase} 2>/dev/null -- "skills/release-quality-review/" || true`,
        { ...gitOptions, maxBuffer: 10 * 1024 * 1024 }
      ).trim();
    } else {
      evidence.git.changedFiles = execSync(`git diff --name-only ${resolvedDiffBase} 2>/dev/null`, gitOptions)
        .trim().split('\n').filter(Boolean);
      evidence.git.diff = execSync(`git diff ${resolvedDiffBase} 2>/dev/null`, { ...gitOptions, maxBuffer: 10 * 1024 * 1024 }).trim();
    }
    const untracked = execFileSync('git', ['ls-files', '--others', '--exclude-standard'], {
      encoding: 'utf-8', cwd: PROJECT_ROOT, timeout: 10000, env: CANDIDATE_ENV,
      sandboxReadOnlyRoots: [PROJECT_ROOT],
    }).trim().split('\n').filter(Boolean);
    evidence.git.changedFiles = [...new Set([...(evidence.git.changedFiles || []), ...untracked])];
  } catch (e) {
    gitEvidenceError = e;
    log.warn(`Could not collect git info: ${redactSensitiveText(e.message)}`);
  }
  if (gitEvidenceError) {
    throw new Error(`git evidence collection failed: ${redactSensitiveText(gitEvidenceError.message)}`);
  }
  if (evidence.git.status !== '') throw new Error('source checkout must be clean before evidence collection');

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

    const targetFiles = listFiles(targetRoot);
    evidence.structure.testFiles = String(targetFiles.filter(file => /\.(test|spec)\.ts$/.test(file)).length);
    evidence.structure.sourceFiles = String(targetFiles.filter(file => /\.(ts|tsx)$/.test(file) && !file.endsWith('.d.ts')).length);

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
    const findResult = targetFiles.filter(file => /\.(ts|tsx)$/.test(file)).slice(0, 50);
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

  // Gate is the single producer and validator of automated command evidence.
  evidence.testResults = { available: false, delegatedToGate: true };

  log.success(`Git: ${evidence.git.branch || '?'} @ ${evidence.git.commit || '?'}`);
  log.success(`Changed: ${evidence.git.changedFiles?.length || 0} files`);

  return evidence;
}

function collectDryRunEvidence() {
  const targetPrefix = REVIEW_TARGET === PROJECT_ROOT
    ? null
    : relative(PROJECT_ROOT, REVIEW_TARGET).replaceAll('\\', '/');
  const pathArgs = targetPrefix ? ['--', targetPrefix] : [];
  const changedFiles = nodeExecFileSync(
    'git',
    ['diff', '--name-only', resolvedDiffBase, ...pathArgs],
    { cwd: PROJECT_ROOT, encoding: 'utf8', timeout: 10000, env: TOOL_ENV },
  ).trim().split('\n').filter(Boolean);
  const untracked = nodeExecFileSync(
    'git',
    ['ls-files', '--others', '--exclude-standard'],
    { cwd: PROJECT_ROOT, encoding: 'utf8', timeout: 10000, env: TOOL_ENV },
  ).trim().split('\n').filter(file => file && (!targetPrefix || file.startsWith(`${targetPrefix}/`)));
  const diff = nodeExecFileSync(
    'git',
    ['diff', resolvedDiffBase, ...pathArgs],
    { cwd: PROJECT_ROOT, encoding: 'utf8', timeout: 10000, maxBuffer: 10 * 1024 * 1024, env: TOOL_ENV },
  );
  return {
    timestamp: new Date().toISOString(),
    git: { changedFiles: [...new Set([...changedFiles, ...untracked])], diff },
    structure: {},
  };
}

function listFiles(root) {
  const files = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue;
    const full = join(root, entry.name);
    if (entry.isDirectory()) files.push(...listFiles(full));
    else if (entry.isFile()) files.push(full);
  }
  return files;
}

function detectEvidenceChangeScale(evidence) {
  const changedFiles = evidence.git.changedFiles || [];
  const addedLines = (evidence.git.diff?.match(/^\+[^+]/gm) || []).length;
  const deletedLines = (evidence.git.diff?.match(/^-[^-]/gm) || []).length;
  const canonical = detectCanonicalChangeScale(changedFiles, addedLines, deletedLines);
  return {
    ...canonical,
    fileCount: canonical.files,
    totalLines: canonical.total,
  };
}

// Load config
function loadConfig() {
  try {
    if (existsSync(CONFIG_FILE)) {
      const content = readFileSync(CONFIG_FILE, 'utf-8');
      const config = {
        verification: {},
        gate: {},
        execution: {},
      };
      let currentSection = '';

      for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;

        // Section headers
        if (trimmed.startsWith('verification:') || trimmed.startsWith('gate:') || trimmed.startsWith('execution:')) {
          currentSection = trimmed.replace(':', '').trim();
          continue;
        }

        if (trimmed && trimmed.includes(':')) {
          const [key, ...valueParts] = trimmed.split(':');
          const value = valueParts.join(':').trim();

          if (value && !key.includes('-')) {
            const cleanValue = value.replace(/^["']|["']$/g, '');

            // Map to correct section
            if (currentSection === 'verification' || ['test', 'build', 'lint', 'typecheck', 'e2e', 'audit'].includes(key.trim())) {
              config.verification[key.trim()] = cleanValue;
            } else if (currentSection === 'gate' || ['min_score', 'fail_on_redlines', 'fail_on_p0_p1_blockers'].includes(key.trim())) {
              config.gate[key.trim()] = cleanValue;
            } else if (currentSection === 'execution' || ['start_delay_ms', 'timeout_ms', 'retry_max'].includes(key.trim())) {
              config.execution[key.trim()] = cleanValue;
            } else {
              config[key.trim()] = cleanValue;
            }
          }
        }
      }
      return config;
    }
  } catch (e) {
    // Ignore
  }
  return { verification: {}, gate: {} };
}

// Get current git commit info
function getGitInfo() {
  try {
    return {
      commit: nodeExecFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: PROJECT_ROOT, encoding: 'utf8', timeout: 10000,
      }).trim(),
      tree: nodeExecFileSync('git', ['rev-parse', 'HEAD^{tree}'], {
        cwd: PROJECT_ROOT, encoding: 'utf8', timeout: 10000,
      }).trim(),
    };
  } catch (e) {
    return { commit: 'unknown', tree: 'unknown' };
  }
}

// Generate reviewer prompt
function generateReviewerPrompt(
  reviewerName, currentRound, candidateIdentity, reviewBackend, reviewModel, reviewReasoningEffort,
) {
  const reviewerContent = loadReviewer(reviewerName);
  if (!reviewerContent) return null;
  const { commit: candidateCommit, tree: candidateTree } = candidateIdentity;

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
- ❌ 不要运行 review-runner、review-gate、npm test、npm run build 或其他共享测试/门禁命令
- ❌ 不要修改源码、本轮共享 metadata/evidence，或其他 Reviewer 的目录

**必须行为：**
- ✅ 引用**现有文件**中的代码行号（不是你刚写的）
- ✅ 引用**已有测试**的输出结果
- ✅ 使用本轮已持久化的 evidence/automated-checks.json 引用共享测试结果，并摘录命令、exit code 和测试摘要
- ✅ score.md 必须至少包含一个 validator 可解析的共享证据块；从 JSON 原样填写实际数字，例如：
  Command: npm test
  Exit code: 0
  Output: # tests <N>; # pass <N>; # fail 0
- ✅ 其他命令也必须使用同样的 Command/Exit code/Output 三行格式，Output 包含原始摘要
- ❌ 不得只写“测试通过”“共享证据为 pass”而省略命令、exit code 或输出摘要
- ✅ 引用**历史报告**或**其他 Reviewer 的发现**
- ✅ 提供具体的错误信息、堆栈跟踪或命令输出

## 输出要求
本轮 reviewer 执行身份为 ${reviewBackend}/${reviewModel}，reasoning effort 为 ${reviewReasoningEffort || 'backend default'}。
在 ${REPORT_DIR}/round-{N}/${reviewerName}/ 目录下创建:
- result.yaml - 机器可读结果
- score.md - 评分详情
- blockers.md - P0/P1 必须修复的问题
- improvement-list.md - P2/P3 改进建议

你只允许写入上面列出的四个 packet 文件。result.yaml 只允许包含下列 11 个顶层字段，顺序和名称必须完全一致；不得添加 summary、dimensions、evidence 或任何其他顶层字段。score 必须是整数，status 必须是小写 pass 或 fail。仅当 score >= 90 且 blockers/redlines 都为空时 status 才能是 pass；其他情况必须是 fail：
\`\`\`yaml
reviewer: ${reviewerName}
profile: ${profile}
round: ${currentRound}
candidate_commit: ${candidateCommit}
candidate_tree: ${candidateTree}
score: <0-100 integer>
status: <pass|fail>
review_backend: ${reviewBackend}
review_model: ${reviewModel}
blockers: []
redlines: []
\`\`\`
实际输出目录必须是 ${REPORT_DIR}/round-${String(currentRound).padStart(3, '0')}/${reviewerName}/。

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

// Validate resume artifacts for credibility
async function validateResumeArtifacts(
  reviewerDir, reviewer, expectedProfile, expectedRound, currentIdentity,
  expectedBackend, expectedModel,
) {
  const requiredFiles = ['result.yaml', 'score.md', 'blockers.md', 'improvement-list.md'];
  try {
    const contents = await Promise.all(requiredFiles.map(file =>
      readContainedFile(reviewerDir, join(reviewerDir, file), 'utf8').catch(error => ({ error, file }))
    ));
    const missingFiles = contents.filter(value => typeof value !== 'string').map(value => value.file);
    if (missingFiles.length > 0) return { valid: false, reason: `missing: ${missingFiles.join(', ')}` };
    const yamlContent = contents[0];
    const contract = validateResultYamlContract(yamlContent);
    if (!contract.valid) return { valid: false, reason: contract.error };
    const parsed = parseYamlResult(yamlContent);
    const mismatches = [];
    if (parsed.reviewer !== reviewer) mismatches.push(`reviewer=${parsed.reviewer ?? 'missing'}`);
    if (parsed.profile !== expectedProfile) mismatches.push(`profile=${parsed.profile ?? 'missing'}`);
    if (parsed.round !== expectedRound) mismatches.push(`round=${parsed.round ?? 'missing'}`);
    if (parsed.candidateCommit !== currentIdentity.commit) mismatches.push(`candidate_commit=${parsed.candidateCommit ?? 'missing'}`);
    if (parsed.candidateTree !== currentIdentity.tree) mismatches.push(`candidate_tree=${parsed.candidateTree ?? 'missing'}`);
    if (parsed.reviewBackend !== expectedBackend) mismatches.push(`review_backend=${parsed.reviewBackend ?? 'missing'}`);
    if (parsed.reviewModel !== expectedModel) mismatches.push(`review_model=${parsed.reviewModel ?? 'missing'}`);
    if (!Number.isInteger(parsed.score) || parsed.score < 0 || parsed.score > 100) mismatches.push('score=invalid');
    if (!['pass', 'fail'].includes(parsed.status)) mismatches.push(`status=${parsed.status ?? 'missing'}`);
    const emptyFiles = requiredFiles.filter((_file, index) => contents[index].trim() === '');
    if (emptyFiles.length > 0) mismatches.push(`empty=${emptyFiles.join(',')}`);
    if (mismatches.length > 0) return { valid: false, reason: mismatches.join('; ') };
    return { valid: true, score: parsed.score, status: parsed.status };
  } catch (e) {
    return { valid: false, reason: `parse error: ${e.message}` };
  }
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function isPermanentAgentFailure(diagnostic) {
  const message = String(diagnostic || '').toLowerCase();
  const httpStatus = message.match(/\b(?:http(?:\/\d(?:\.\d)?)?\s*)?([45]\d\d)\b/);
  if (httpStatus) {
    const status = Number(httpStatus[1]);
    if (status >= 400 && status < 500 && ![408, 425, 429].includes(status)) return true;
  }
  return [
    /\binsufficient(?:_|\s)+(?:balance|quota|credits?)\b/,
    /\b(?:invalid|incorrect|missing|expired|revoked)(?:_|\s)+(?:api(?:_|\s)+)?key\b/,
    /\b(?:authentication failed|account (?:deactivated|disabled)|billing (?:error|required))\b/,
    /\b(?:model|deployment)\b.{0,80}\b(?:does not exist|invalid|not found|unsupported|unavailable)\b/,
    /\b(?:invalid|unknown|unsupported)\b.{0,40}\bmodel\b/,
    /\b(?:enoent|command not found)\b/,
  ].some(pattern => pattern.test(message));
}

function getAgentInvocation(agent, selectedModel, selectedEffort, prompt) {
  if (agent === 'claude') {
    return {
      command: 'claude',
      args: ['-p', '--model', selectedModel, '--permission-mode', 'acceptEdits', '--no-session-persistence', prompt],
    };
  }
  if (agent === 'codex') {
    const effortArgs = selectedEffort
      ? ['--config', `model_reasoning_effort=${JSON.stringify(selectedEffort)}`]
      : [];
    return {
      command: 'codex',
      args: ['exec', '--model', selectedModel, ...effortArgs, '--ephemeral', '--sandbox', 'workspace-write', '--cd', PROJECT_ROOT, prompt],
    };
  }
  return { command: agent, args: ['-p', prompt] };
}

function loadRoundBackendLock(roundDir) {
  const lockPath = resolveWithinRoot(roundDir, 'review-backend.json', 'review backend lock');
  if (!existsSync(lockPath)) return null;
  try {
    return JSON.parse(readContainedFileSync(roundDir, lockPath, 'utf8'));
  } catch (error) {
    const failure = new Error(`invalid review backend lock: ${error.message}`);
    failure.exitCode = 4;
    throw failure;
  }
}

async function resolveReviewIdentity(roundDir) {
  if (!agentCli) return null;
  const existing = loadRoundBackendLock(roundDir);
  if (!explicitModel && existing) {
    if (existing.backend !== agentCli || typeof existing.model !== 'string' || !existing.model) {
      const failure = new Error(`round backend is locked to ${existing.backend || 'invalid'}, cannot use ${agentCli}`);
      failure.exitCode = 4;
      throw failure;
    }
    const identity = {
      backend: existing.backend,
      model: existing.model,
      reasoningEffort: existing.reasoning_effort ?? null,
      selection: existing.selection || { mode: 'legacy-round-lock', selected_by: 'round-lock' },
    };
    const validation = validateReviewModelIdentity(identity);
    if (!validation.valid) {
      const failure = new Error(`invalid review backend lock: ${validation.error}`);
      failure.exitCode = 4;
      throw failure;
    }
    return identity;
  }
  if (explicitModel) {
    return {
      backend: agentCli,
      model: explicitModel,
      reasoningEffort: reasoningEffort || null,
      selection: {
        mode: 'explicit',
        selected_by: process.argv.slice(2).includes('--model') ? 'user' : 'environment',
      },
    };
  }
  try {
    let selected;
    const preferLightweight = ['quick', 'default'].includes(profile);
    if (radarSnapshot) {
      const snapshotPath = resolveWithinRoot(PROJECT_ROOT, radarSnapshot, 'Radar snapshot');
      const body = readContainedFileSync(PROJECT_ROOT, snapshotPath, 'utf8');
      selected = selectRadarReviewerModel(JSON.parse(body), { preferLightweight });
      selected.selection.source = relative(PROJECT_ROOT, snapshotPath);
      selected.selection.snapshot_sha256 = createHash('sha256').update(body).digest('hex');
    } else {
      selected = await fetchRadarReviewerModel({ preferLightweight });
    }
    const identity = { backend: 'codex', ...selected };
    const validation = validateReviewModelIdentity(identity, { requireReasoningEffort: true });
    if (!validation.valid) throw new Error(validation.error);
    return identity;
  } catch (error) {
    const failure = new Error(
      `Codex Radar could not select a reviewer model: ${error.message}. ` +
      'The main agent must choose a model and rerun with --model.',
    );
    failure.exitCode = 4;
    throw failure;
  }
}

function bindRoundBackend(roundDir, identity) {
  const requestedValidation = validateReviewModelIdentity(identity);
  if (!requestedValidation.valid) {
    const failure = new Error(`invalid review identity: ${requestedValidation.error}`);
    failure.exitCode = 4;
    throw failure;
  }
  const lockPath = resolveWithinRoot(roundDir, 'review-backend.json', 'review backend lock');
  const record = {
    backend: identity.backend,
    model: identity.model,
    reasoning_effort: identity.reasoningEffort,
    selection: identity.selection,
  };
  try {
    writeFileSync(lockPath, `${JSON.stringify(record, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    return record;
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  const existing = loadRoundBackendLock(roundDir);
  const existingValidation = validateReviewModelIdentity({
    backend: existing.backend,
    model: existing.model,
    reasoningEffort: existing.reasoning_effort ?? null,
  });
  if (!existingValidation.valid) {
    const failure = new Error(`invalid review backend lock: ${existingValidation.error}`);
    failure.exitCode = 4;
    throw failure;
  }
  if (!['claude', 'codex'].includes(existing.backend) || existing.backend !== identity.backend) {
    const failure = new Error(`round backend is locked to ${existing.backend || 'invalid'}, cannot use ${identity.backend}`);
    failure.exitCode = 4;
    throw failure;
  }
  if (typeof existing.model !== 'string' || existing.model !== identity.model) {
    const failure = new Error(`round model is locked to ${existing.model || 'invalid'}, cannot use ${identity.model}`);
    failure.exitCode = 4;
    throw failure;
  }
  if ((existing.reasoning_effort ?? null) !== identity.reasoningEffort) {
    const failure = new Error(`round reasoning effort is locked to ${existing.reasoning_effort ?? 'default'}, cannot use ${identity.reasoningEffort ?? 'default'}`);
    failure.exitCode = 4;
    throw failure;
  }
  return existing;
}

async function bindRoundMetadata(roundDir, identity) {
  const metadataPath = join(roundDir, 'metadata.json');
  if (!existsSync(metadataPath)) return;
  const metadata = JSON.parse(readContainedFileSync(roundDir, metadataPath, 'utf8'));
  const identityEffort = identity.reasoningEffort ?? identity.reasoning_effort ?? null;
  if (metadata.review_backend && metadata.review_backend !== identity.backend) {
    throw new Error(`round metadata backend is locked to ${metadata.review_backend}, cannot use ${identity.backend}`);
  }
  if (metadata.review_model && metadata.review_model !== identity.model) {
    throw new Error(`round metadata model is locked to ${metadata.review_model}, cannot use ${identity.model}`);
  }
  if ('review_reasoning_effort' in metadata && metadata.review_reasoning_effort !== identityEffort) {
    throw new Error(`round metadata reasoning effort is locked to ${metadata.review_reasoning_effort ?? 'default'}, cannot use ${identityEffort ?? 'default'}`);
  }
  metadata.review_backend = identity.backend;
  metadata.review_model = identity.model;
  metadata.review_reasoning_effort = identityEffort;
  metadata.model_selection = identity.selection;
  await writeContainedFile(roundDir, metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);
}

// Run gate check and return detailed result
function runGateCheck(roundDir, profileName, round) {
  log.title('GATE CHECK');

  try {
    const gateScript = join(SKILL_DIR, 'scripts', 'review-gate.mjs');
    if (existsSync(gateScript)) {
      const args = [gateScript, '--profile', profileName, '--round', String(round), '--no-collect'];
      if (checkGoalMode) args.push('--check-goal-mode');
      if (diffBase !== 'HEAD') args.push('--base', diffBase);
      nodeExecFileSync('node', args, {
        stdio: 'inherit',
        cwd: PROJECT_ROOT,
        env: TOOL_ENV,
      });
      return { passed: true, roundDir };
    }
  } catch (e) {
    const exit = Number.isInteger(e.status) ? e.status : 'spawn-error';
    const signal = e.signal ? `, signal ${e.signal}` : '';
    log.error(`Gate check failed (exit ${exit}${signal})`);
    return { passed: false, roundDir, exitCode: e.status ?? null, signal: e.signal ?? null };
  }

  return { passed: false, roundDir };
}

function persistRoundEvidenceBeforeReview(roundDir, profileName, round) {
  const gateScript = join(SKILL_DIR, 'scripts', 'review-gate.mjs');
  const args = [gateScript, '--profile', profileName, '--round', String(round)];
  if (diffBase !== 'HEAD') args.push('--base', diffBase);
  try {
    nodeExecFileSync('node', args, {
      cwd: PROJECT_ROOT,
      env: TOOL_ENV,
      encoding: 'utf8',
      timeout: 10 * 60 * 1000,
      maxBuffer: 20 * 1024 * 1024,
    });
  } catch (error) {
    if (error.status !== 1) throw error;
  }

  const required = [
    join(roundDir, 'metadata.json'),
    join(roundDir, 'evidence', 'automated-checks.json'),
  ];
  const missing = required.filter(file => !existsSync(file));
  if (missing.length > 0) {
    throw new Error(`round evidence persistence failed: missing ${missing.map(file => file.replace(`${roundDir}/`, '')).join(', ')}`);
  }
}

function loadPersistedRoundScope(roundDir) {
  const metadataFile = join(roundDir, 'metadata.json');
  if (!existsSync(metadataFile)) throw new Error('cannot skip evidence without candidate-bound metadata.json');
  const metadata = JSON.parse(readContainedFileSync(roundDir, metadataFile, 'utf8'));
  const identity = getGitInfo();
  if (metadata.candidate_commit !== identity.commit || metadata.candidate_tree !== identity.tree ||
      metadata.base_commit !== resolvedDiffBase) {
    throw new Error('persisted round scope does not match the current candidate or diff base');
  }
  return {
    timestamp: metadata.collected_at,
    git: metadata.git || {},
    files: metadata.files || {},
    scale: metadata.scale || {},
    structure: {},
  };
}

// Run single review iteration
async function runSingleReviewIteration(profileConfig, currentRound, onReviewComplete, requestedIdentity) {
  const roundDir = join(REPORT_DIR, `round-${String(currentRound).padStart(3, '0')}`);

  console.log(`\n${c.blue}ℹ${c.reset} Round: ${currentRound}`);
  console.log(`${c.blue}ℹ${c.reset} Report: ${roundDir}`);

  if (!dryRun) {
    ensureContainedDirectorySync(PROJECT_ROOT, REPORT_DIR);
    ensureContainedDirectorySync(REPORT_DIR, roundDir);
  }

  if (!dryRun && profile === 'agentic-release-gate') {
    const requiredArtifacts = ['generated-goal.md', 'changes.md', 'diff-summary.md', 'risk.md', 'handoff.md'];
    const missingArtifacts = requiredArtifacts.filter(file => !existsSync(join(roundDir, file)));
    if (missingArtifacts.length > 0) {
      console.error(`Agentic review artifacts must exist before reviewer launch: ${missingArtifacts.join(', ')}`);
      process.exit(4);
    }
  }

  // Collect evidence with config
  const config = loadConfig();
  const evidence = dryRun
    ? collectDryRunEvidence()
    : skipEvidence
      ? (profile === 'agentic-release-gate'
          ? loadPersistedRoundScope(roundDir)
          : { timestamp: new Date().toISOString(), git: {}, structure: {} })
      : collectEvidence(config);

  // Detect change scale (right-size throttle)
  const scaleInfo = skipEvidence && evidence.scale?.scale
    ? {
        ...evidence.scale,
        fileCount: evidence.scale.fileCount ?? evidence.scale.files ?? evidence.git.changedFiles?.length ?? 0,
        totalLines: evidence.scale.totalLines ?? evidence.scale.total ?? 0,
      }
    : detectEvidenceChangeScale(evidence);
  evidence.scale = scaleInfo; // Attach scale info to evidence

  // Log scale detection result
  console.log(`\n${c.blue}ℹ Change Scale:${c.reset} ${scaleInfo.scale} (${scaleInfo.fileCount} files, ${scaleInfo.totalLines} lines)`);
  console.log(`${c.blue}ℹ Suggested Profile:${c.reset} ${scaleInfo.suggestedProfile}`);
  if (scaleInfo.reason !== `${scaleInfo.fileCount} files, ${scaleInfo.totalLines} lines - ${scaleInfo.scale} change`) {
    console.log(`${c.blue}ℹ Reason:${c.reset} ${scaleInfo.reason}`);
  }

  let reviewerSelection;
  try {
    reviewerSelection = selectReviewers(
      profileConfig,
      evidence.git.changedFiles || [],
      evidence.git.diff || '',
    );
  } catch (error) {
    console.error(`Invalid reviewer configuration: ${error.message}`);
    process.exit(4);
  }
  const triggeredConditional = reviewerSelection.triggeredConditional;
  const allReviewers = reviewerOverride ? [reviewerOverride] : reviewerSelection.reviewers;

  if (dryRun) {
    console.log(`\n${c.yellow}DRY RUN MODE${c.reset}`);
    console.log('\nSelected reviewers:');
    let valid = true;
    for (const name of allReviewers) {
      const exists = existsSync(join(SKILL_DIR, 'reviewers', `${name}.md`));
      console.log(`  ${exists ? c.green + '✓' : c.red + '✗'} ${name}`);
      valid &&= exists;
    }
    if (!valid) process.exit(4);
    console.log(`\n${c.green}Dry run complete${c.reset}`);
    return { roundDir, evidence, allReviewers, results: [] };
  }

  // Persist phase plan BEFORE running reviews
  persistPhasePlan(roundDir, currentRound, allReviewers, evidence, profileConfig);
  if (!skipEvidence) {
    persistRoundEvidenceBeforeReview(roundDir, profile, currentRound);
  }

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
  let reviewFailure = null;
  const scale = evidence.scale?.scale || 'medium';

  const lockedIdentity = bindRoundBackend(roundDir, requestedIdentity);
  await bindRoundMetadata(roundDir, lockedIdentity);
  const resolvedAgent = lockedIdentity.backend;
  const resolvedModel = lockedIdentity.model;
  const resolvedEffort = lockedIdentity.reasoning_effort ?? null;
  const timeoutPolicy = calculateReviewerTimeout(REVIEWER_TIMEOUT_MS, scale, resolvedEffort);
  const scaledTimeout = timeoutPolicy.timeoutMs;
  log.info(`Using agent: ${resolvedAgent}, model: ${resolvedModel}, reasoning effort: ${resolvedEffort || 'backend default'}`);
  const candidateIdentity = getGitInfo();
  const reviewerPrompts = new Map(allReviewers.map(reviewer => [
    reviewer, generateReviewerPrompt(
      reviewer, currentRound, candidateIdentity, resolvedAgent, resolvedModel, resolvedEffort,
    ),
  ]));

  // Use config for delays
  const startDelay = config.execution?.start_delay_ms
    ? parseInt(config.execution.start_delay_ms, 10)
    : REVIEWER_START_DELAY_MS;

  const activeReviewers = new Map();
  let parallelAbortReason = null;
  const abortAll = (reason, kind) => {
    if (parallelAbortReason) return;
    parallelAbortReason = reason;
    for (const abort of activeReviewers.values()) abort(reason, kind);
  };

  const runReviewerAttempt = (reviewer, reviewerDir, prompt, attempt, abortPeers) => new Promise(resolve => {
    const invocation = getAgentInvocation(resolvedAgent, resolvedModel, resolvedEffort, prompt);
    const reviewerReportDir = relative(
      PROJECT_ROOT,
      join(REPORT_DIR, '.reviewer-sandboxes', `round-${String(currentRound).padStart(3, '0')}`, reviewer),
    );
    const proc = spawn(invocation.command, invocation.args, {
      cwd: PROJECT_ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
      env: { ...TOOL_ENV, RELEASE_QUALITY_REPORT_DIR: reviewerReportDir },
    });
    let stdoutTail = '';
    let stderrTail = '';
    let internalDiagnostic = '';
    let processError = '';
    let settled = false;
    let abortedKind = null;
    let forceTimer = null;
    let timeoutTimer = null;
    const key = `${reviewer}-${attempt}`;
    const appendTail = (current, data) => (current + data.toString()).slice(-4000);
    const combinedDiagnostic = () => [stdoutTail, stderrTail, processError, internalDiagnostic]
      .filter(Boolean).join('\n').slice(-4000);
    const signalProcessTree = signal => {
      if (!proc.pid) return false;
      try {
        if (process.platform === 'win32') {
          const args = ['/pid', String(proc.pid), '/t'];
          if (signal === 'SIGKILL') args.push('/f');
          spawn('taskkill', args, { stdio: 'ignore', env: CANDIDATE_ENV }).unref();
        } else {
          process.kill(-proc.pid, signal);
        }
        return true;
      } catch (error) {
        if (error.code !== 'ESRCH') internalDiagnostic = appendTail(internalDiagnostic, `\nprocess-tree ${signal} failed: ${error.message}`);
        return false;
      }
    };
    const finish = async (code, eventStatus = null) => {
      if (settled) return;
      settled = true;
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (forceTimer) clearTimeout(forceTimer);
      activeReviewers.delete(key);
      const postValidation = await validateResumeArtifacts(
        reviewerDir, reviewer, profile, currentRound, candidateIdentity,
        resolvedAgent, resolvedModel,
      );
      const complete = postValidation.valid;
      const timedOutWithValidPacket = abortedKind === 'timeout' && complete;
      const status = timedOutWithValidPacket ? 'completed' :
        (eventStatus || (!abortedKind && code === 0 && complete ? 'completed' : 'failed'));
      if (!complete && postValidation.reason) {
        internalDiagnostic = appendTail(internalDiagnostic, `\npacket validation failed: ${postValidation.reason}`);
      }
      console.log(`  ${status === 'completed' ? c.green + '✓' : c.red + '✗'}${c.reset} ${reviewer}${attempt > 1 ? ` (attempt ${attempt})` : ''}: ${status}`);
      const diagnostic = combinedDiagnostic();
      if (status === 'failed' && diagnostic) {
        console.log(`    ${redactSensitiveText(diagnostic).replace(/\s+/g, ' ').slice(-500)}`);
      }
      const permanentSource = [stderrTail, processError].filter(Boolean).join('\n');
      resolve({
        name: reviewer, status, attempt, diagnostic, abortedKind,
        permanentFailure: isPermanentAgentFailure(permanentSource),
      });
    };
    const abort = (reason, kind = 'aborted') => {
      if (settled || abortedKind) return;
      abortedKind = kind;
      internalDiagnostic = appendTail(internalDiagnostic, `\n${reason}`);
      signalProcessTree('SIGTERM');
      forceTimer = setTimeout(() => {
        if (settled) return;
        signalProcessTree('SIGKILL');
        forceTimer = setTimeout(() => void finish(null, 'failed'), 100);
      }, REVIEWER_KILL_GRACE_MS);
    };

    proc.stdout.on('data', data => { stdoutTail = appendTail(stdoutTail, data); });
    proc.stderr.on('data', data => { stderrTail = appendTail(stderrTail, data); });
    activeReviewers.set(key, abort);
    timeoutTimer = setTimeout(() => {
      const reason = `${reviewer} timed out after ${scaledTimeout}ms (scale: ${scale})`;
      console.log(`  ${c.red}✗${c.reset} ${reason}`);
      if (abortPeers) abortAll(reason, 'timeout');
      else abort(reason, 'timeout');
    }, scaledTimeout);
    proc.on('close', code => {
      if (abortedKind) return;
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (!signalProcessTree('SIGTERM')) {
        void finish(code);
        return;
      }
      forceTimer = setTimeout(() => {
        signalProcessTree('SIGKILL');
        forceTimer = setTimeout(() => void finish(code), 100);
      }, REVIEWER_KILL_GRACE_MS);
    });
    proc.on('error', error => {
      processError = error.message;
      console.log(`  ${c.red}✗${c.reset} ${reviewer}: ${error.message}`);
      if (abortPeers) abortAll(`${reviewer} process error: ${error.message}`, 'process-error');
      void finish(null, 'error');
    });
  });

  const runReviewer = async (reviewer, delay, abortPeers) => {
    const reviewerDir = join(roundDir, reviewer);
    ensureContainedDirectorySync(roundDir, reviewerDir);
    const validation = await validateResumeArtifacts(
      reviewerDir, reviewer, profile, currentRound, candidateIdentity,
      resolvedAgent, resolvedModel,
    );
    if (validation.valid) {
      console.log(`  ${c.blue}↷${c.reset} ${reviewer}: validated resume (score: ${validation.score ?? 'unknown'})`);
      return { name: reviewer, status: 'completed', skipped: true };
    }
    if (validation.reason) {
      console.log(`  ${c.yellow}⚡${c.reset} ${reviewer}: invalidating stale artifacts (${validation.reason}), re-running`);
    }
    await sleep(delay);
    const prompt = reviewerPrompts.get(reviewer);
    if (!prompt) {
      console.log(`  ${c.red}✗${c.reset} ${reviewer}: definition not found`);
      return { name: reviewer, status: 'failed' };
    }
    await writeContainedFile(roundDir, join(reviewerDir, 'prompt.md'), prompt);

    let lastResult = null;
    for (let attempt = 1; attempt <= REVIEWER_RETRY_MAX + 1; attempt++) {
      if (attempt > 1) {
        const retryDelay = RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 2) + Math.random() * RETRY_MAX_JITTER_MS;
        log.info(`  Retry ${attempt - 1}/${REVIEWER_RETRY_MAX} for ${reviewer}: waiting ${Math.round(retryDelay)}ms`);
        await sleep(retryDelay);
      }
      lastResult = await runReviewerAttempt(reviewer, reviewerDir, prompt, attempt, abortPeers);
      if (lastResult.status === 'completed' || lastResult.abortedKind) return lastResult;
      if (lastResult.permanentFailure) {
        log.warn(`  ${reviewer}: not retrying permanent Agent failure`);
        return lastResult;
      }
    }
    return { ...lastResult, attempts: REVIEWER_RETRY_MAX + 1 };
  };

  if (parallel) {
    log.info(`Execution: parallel, Scale: ${scale}, Effort: ${resolvedEffort || 'default'}, Timeout: ${scaledTimeout}ms ` +
      `(base: ${REVIEWER_TIMEOUT_MS}ms, scale x${timeoutPolicy.scaleMultiplier}, effort x${timeoutPolicy.effortMultiplier}), Start delay: ${startDelay}ms`);
    try {
      nodeExecFileSync(resolvedAgent, ['--help'], { cwd: PROJECT_ROOT, timeout: 10000, stdio: 'ignore', env: TOOL_ENV });
    } catch {
      log.error(`Parallel mode requires ${agentCli} CLI on PATH; no reviewer agents were launched.`);
      process.exit(5);
    }
    const parallelResults = await Promise.all(allReviewers.map(reviewer => runReviewer(reviewer, startDelay, true)));
    results.push(...parallelResults);
    if (parallelResults.some(result => result.status !== 'completed')) {
      const error = new Error(parallelAbortReason || 'one or more reviewer agents failed');
      error.exitCode = 5;
      reviewFailure = error;
    }
  } else {
    log.info(`Execution: sequential with ${startDelay}ms delays`);
    for (let i = 0; i < allReviewers.length; i++) {
      const reviewer = allReviewers[i];
      const result = await runReviewer(reviewer, i > 0 ? startDelay : 0, false);
      results.push(result);
      if (onReviewComplete) onReviewComplete(reviewer, join(roundDir, reviewer), evidence);
    }
    const failedResults = results.filter(result => result.status !== 'completed');
    if (failedResults.length > 0) {
      const error = new Error(`Sequential review failed for: ${failedResults.map(result => result.name).join(', ')}`);
      error.exitCode = 5;
      reviewFailure = error;
    }
  }

  // Write metadata
  const { diff: _sensitiveDiff, ...safeGitEvidence } = evidence.git || {};
  const meta = {
    profile,
    round: currentRound,
    reviewBackend: resolvedAgent,
    reviewModel: resolvedModel,
    reviewReasoningEffort: resolvedEffort,
    modelSelection: lockedIdentity.selection || null,
    reviewers: allReviewers,
    triggeredConditional,
    timestamp: new Date().toISOString(),
    gate: profileConfig.gate,
    scale: scaleInfo, // Change scale detection result
    parallelExecution: {
      enabled: parallel,
      baseTimeout: REVIEWER_TIMEOUT_MS,
      scaledTimeout: scaledTimeout,
      scaleMultiplier: timeoutPolicy.scaleMultiplier,
      effortMultiplier: timeoutPolicy.effortMultiplier,
      retryMax: REVIEWER_RETRY_MAX,
    },
    evidence: {
      git: safeGitEvidence,
      structure: evidence.structure,
    },
  };
  await writeContainedFile(roundDir, join(roundDir, 'runner-metadata.json'), JSON.stringify(meta, null, 2));

  console.log(`\n${c.green}✓${c.reset} Metadata written`);
  if (reviewFailure) throw reviewFailure;
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
    process.exit(4);
  }
  if (reviewerOverride && !loadReviewer(reviewerOverride)) {
    log.error(`Unknown reviewer: ${reviewerOverride}`);
    process.exit(4);
  }

  console.log(`\n${c.blue}ℹ${c.reset} Profile: ${profileConfig.name}`);
  console.log(`${c.blue}ℹ${c.reset} ${profileConfig.description || ''}`);
  if (profileConfig.estimated_time) {
    console.log(`${c.blue}ℹ${c.reset} Estimated time: ${profileConfig.estimated_time}`);
  }

  const minScore = profileConfig.gate?.min_score || 90;

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

  const prospectiveRoundDir = join(REPORT_DIR, `round-${String(effectiveRound).padStart(3, '0')}`);
  const reviewIdentity = await resolveReviewIdentity(prospectiveRoundDir);
  if (reviewIdentity) {
    console.log(`${c.blue}ℹ${c.reset} Model selection: ${reviewIdentity.selection.mode} -> ${reviewIdentity.model}` +
      `${reviewIdentity.reasoningEffort ? ` (${reviewIdentity.reasoningEffort})` : ''}`);
  }

  await runSingleReviewIteration(profileConfig, effectiveRound, () => {}, reviewIdentity);
  if (dryRun) return;

  // Determine round directory for gate check (same as iteration)
  const roundDir = join(REPORT_DIR, `round-${String(effectiveRound).padStart(3, '0')}`);

  // Run gate check
  console.log(`\n${c.cyan}═══ Running Gate Check ═══${c.reset}`);
  const gateResult = runGateCheck(roundDir, profile, effectiveRound);

  // Persist phase result AFTER gate check
  const scores = extractResultScoresFromRound(roundDir);
  const scoresObj = {};
  scores.forEach(s => { scoresObj[s.reviewer] = s.score; });
  const failedReviewers = scores.filter(s => s.score < minScore);
  persistPhaseResult(roundDir, effectiveRound, scoresObj, gateResult.passed, failedReviewers);

  console.log(`\n${c.cyan}═══ Summary ═══${c.reset}\n`);
  console.log(`  Round: ${effectiveRound}`);
  console.log(`  Gate: ${gateResult.passed ? c.green + 'PASSED' : c.red + 'FAILED'}${c.reset}`);

  if (!gateResult.passed) {
    console.log(`\n${c.yellow}Next steps:${c.reset}`);
    console.log(`  1. Fix issues identified by failed reviewers`);
    console.log(`  2. Launch the failed reviewers as independent Codex/Claude host agents`);
    console.log(`  3. Re-run: npm run skill:gate -- --profile ${profile} --round ${effectiveRound}`);
    process.exit(1);
  }
}

main().catch(err => {
  console.error(`\n${c.red}Error:${c.reset}`, err.message);
  process.exit(err.exitCode || 1);
});
