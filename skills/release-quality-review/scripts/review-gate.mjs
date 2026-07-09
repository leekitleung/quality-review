#!/usr/bin/env node
/**
 * Review Gate - Deterministic Quality Gate
 *
 * A deterministic script that runs quality reviews and determines
 * if a release is ready. This is the last line of defense before
 * a release is allowed.
 *
 * Usage:
 *   node review-gate.mjs --profile release-gate    # Full review
 *   node review-gate.mjs --profile quick          # Quick review (resident only)
 *   node review-gate.mjs --reviewer destructive-qa  # Single reviewer
 *   node review-gate.mjs --check-redlines         # Only check redlines
 *   node review-gate.mjs --round 3                # Continue from round 3
 *   node review-gate.mjs --parallel               # Run reviewers in parallel
 *   node review-gate.mjs --collect-evidence        # Auto collect evidence
 *   node review-gate.mjs --dry-run               # Validate without running
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';
import { readFile } from 'fs/promises';

// Use process.cwd() as the reliable project root
const PROJECT_ROOT = process.cwd();
const SKILL_DIR = join(PROJECT_ROOT, 'skills', 'release-quality-review');
const REPORT_DIR = join(PROJECT_ROOT, 'quality-reports');
const CONFIG_FILE = join(SKILL_DIR, 'review-config.yaml');

// ANSI colors
const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
};

const log = {
  info: (msg) => console.log(`${colors.blue}ℹ${colors.reset} ${msg}`),
  success: (msg) => console.log(`${colors.green}✓${colors.reset} ${msg}`),
  warn: (msg) => console.log(`${colors.yellow}⚠${colors.reset} ${msg}`),
  error: (msg) => console.log(`${colors.red}✗${colors.reset} ${msg}`),
  title: (msg) => console.log(`\n${colors.bright}${colors.cyan}═══ ${msg} ═══${colors.reset}\n`),
};

// Parse arguments
const args = process.argv.slice(2);
let profile = 'release-gate';
let singleReviewer = null;
let checkRedlinesOnly = false;
let roundNumber = 1;
let parallel = false;
let collectEvidence = true;
let dryRun = false;
let excludeReviewers = [];
let detectScale = false;
let userSpecifiedProfile = false;
let validateEvidence = true; // 对抗性审查：验证证据来源是否合规
let checkGoalMode = false; // Goal 模式约束：强制描述最终状态而非实现步骤

for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === '--profile' && args[i + 1]) {
    profile = args[i + 1];
    userSpecifiedProfile = true;
    i++;
  } else if (arg === '--reviewer' && args[i + 1]) {
    singleReviewer = args[i + 1];
    i++;
  } else if (arg === '--check-redlines') {
    checkRedlinesOnly = true;
  } else if (arg === '--check-goal-mode') {
    checkGoalMode = true;
  } else if (arg === '--round' && args[i + 1]) {
    const roundArg = args[++i];
    // Support both "3" and "round-003" formats
    const match = roundArg.match(/^round-(\d+)$/i);
    const parsed = match ? parseInt(match[1], 10) : parseInt(roundArg, 10);
    // Guard against NaN (e.g., "round-null" or invalid input)
    roundNumber = isNaN(parsed) ? 1 : parsed;
  } else if (arg === '--parallel') {
    parallel = true;
  } else if (arg === '--no-collect') {
    collectEvidence = false;
  } else if (arg === '--collect-evidence') {
    collectEvidence = true;
  } else if (arg === '--dry-run') {
    dryRun = true;
  } else if (arg === '--exclude-reviewer' && args[i + 1]) {
    excludeReviewers.push(args[i + 1]);
    i++;
  } else if (arg === '--detect-scale') {
    detectScale = true;
  } else if (arg === '--validate-evidence') {
    validateEvidence = true;
  } else if (arg === '--no-validate-evidence') {
    validateEvidence = false;
  } else if (arg === '--help' || arg === '-h') {
    printHelp();
    process.exit(0);
  }
}

// ============================================================================
// Right-size Throttle: Change Scale Detection
// ============================================================================

/**
 * Detect the scale of changes based on git diff stats
 * @returns {{ scale: string, files: number, additions: number, deletions: number, total: number, suggestedProfile: string }}
 */
function detectChangeScale() {
  try {
    const diff = execSync('git diff --stat --numstat HEAD 2>/dev/null', {
      encoding: 'utf-8',
      cwd: PROJECT_ROOT,
      timeout: 10000,
    });

    let totalFiles = 0;
    let totalAdditions = 0;
    let totalDeletions = 0;

    for (const line of diff.split('\n')) {
      const match = line.match(/^(\d+|-)\s+(\d+|-)\s+(.+)$/);
      if (match) {
        totalFiles++;
        totalAdditions += parseInt(match[1]) || 0;
        totalDeletions += parseInt(match[2]) || 0;
      }
    }

    const totalChanges = totalAdditions + totalDeletions;

    // Determine scale based on file count and line count
    let scale = 'micro';
    let reason = '';

    if (totalFiles >= 50 || totalChanges >= 2000) {
      scale = 'xlarge';
      reason = 'Very large change (50+ files or 2000+ lines)';
    } else if (totalFiles >= 21 || totalChanges >= 500) {
      scale = 'large';
      reason = 'Large change (21-50 files or 500-2000 lines)';
    } else if (totalFiles >= 6 || totalChanges >= 100) {
      scale = 'medium';
      reason = 'Medium change (6-20 files or 100-500 lines)';
    } else if (totalFiles >= 3 || totalChanges >= 50) {
      scale = 'small';
      reason = 'Small change (3-5 files or 50-100 lines)';
    } else {
      scale = 'micro';
      reason = 'Micro change (1-2 files and <50 lines)';
    }

    // Profile mapping
    const profileMap = {
      micro: 'quick',
      small: 'quick',
      medium: 'default',
      large: 'release-gate',
      xlarge: 'agentic-release-gate',  // XLarge 规模强制使用 agentic gate
    };

    return {
      scale,
      files: totalFiles,
      additions: totalAdditions,
      deletions: totalDeletions,
      total: totalChanges,
      suggestedProfile: profileMap[scale],
      reason,
      requiresAgentic: scale === 'xlarge',
    };
  } catch (e) {
    return {
      scale: 'unknown',
      files: 0,
      additions: 0,
      deletions: 0,
      total: 0,
      suggestedProfile: 'release-gate',
      reason: 'Could not detect changes, using default',
      requiresAgentic: false,
    };
  }
}

/**
 * Print scale detection results
 */
function printScaleDetection(scaleInfo) {
  console.log('');
  console.log(`${colors.bright}${colors.cyan}═══════════════════════════════════════════════════${colors.reset}`);
  console.log(`${colors.bright}${colors.cyan}    Release Quality Gate - Change Scale Detection${colors.reset}`);
  console.log(`${colors.bright}${colors.cyan}═══════════════════════════════════════════════════${colors.reset}`);
  console.log('');

  console.log(`${colors.blue}ℹ${colors.reset} Detected Changes:`);
  console.log(`   Files: ${scaleInfo.files}`);
  console.log(`   Additions: ${scaleInfo.additions > 0 ? '+' : ''}${scaleInfo.additions}`);
  console.log(`   Deletions: ${scaleInfo.deletions > 0 ? '-' : ''}${scaleInfo.deletions}`);
  console.log(`   Total: ${scaleInfo.total} lines`);
  console.log('');

  console.log(`${colors.blue}ℹ${colors.reset} Scale: ${colors.bright}${scaleInfo.scale}${colors.reset}`);
  console.log(`   ${scaleInfo.reason}`);
  console.log('');

  console.log(`${colors.blue}ℹ${colors.reset} Suggested Profile: ${colors.bright}${scaleInfo.suggestedProfile}${colors.reset}`);
  if (scaleInfo.requiresAgentic) {
    console.log(`   ${colors.yellow}⚠${colors.reset} XLarge change: agentic-review is recommended`);
  }
  console.log('');

  if (userSpecifiedProfile) {
    console.log(`${colors.blue}ℹ${colors.reset} User Override: Using --profile ${profile}`);
  } else {
    console.log(`${colors.blue}ℹ${colors.reset} Override with: ${colors.cyan}--profile <name>${colors.reset}`);
  }
  console.log('');
}

// Run scale detection and exit if requested
if (detectScale) {
  const scaleInfo = detectChangeScale();
  printScaleDetection(scaleInfo);
  process.exit(0);
}

// Detect scale at startup (non-blocking)
const startupScaleInfo = detectChangeScale();


function printHelp() {
  console.log(`
${colors.bright}Review Gate - Deterministic Quality Gate${colors.reset}

Usage:
  node review-gate.mjs [options]

Options:
  --profile <name>       Review profile: quick, default, release-gate, full (default: release-gate)
  --reviewer <name>     Run only this reviewer
  --round <N>           Round number (auto-detected if not specified)
  --check-redlines      Only check for redlines (P0/P1 blockers)
  --check-goal-mode     Enable goal mode constraint (describe final state, not steps)
  --parallel            Run reviewers in parallel (experimental)
  --no-collect          Skip automatic evidence collection
  --collect-evidence    Force evidence collection (default)
  --exclude-reviewer N  Exclude reviewer N from this run
  --detect-scale         Detect change scale and suggest profile
  --validate-evidence   Enable evidence source validation (default: true)
  --no-validate-evidence Skip evidence source validation (对抗性审查)
  --dry-run             Validate configuration without running
  --help, -h            Show this help

Profiles:
  quick         Minimal resident reviewers (product-flow, architecture-maintainer)
  default       Standard PR review (product-flow, destructive-qa, terminal-veteran)
  release-gate  Full release gate (all residents + terminal-veteran)
  full          Complete review (all 8 reviewers)

Exit Codes:
  0 = All gates passed
  1 = Gates failed
  2 = Configuration error

Examples:
  node review-gate.mjs --profile release-gate
  node review-gate.mjs --detect-scale
  node review-gate.mjs --round 2 --profile default
  node review-gate.mjs --reviewer destructive-qa --dry-run
  `);
}

// Load configuration
function loadConfig() {
  try {
    if (existsSync(CONFIG_FILE)) {
      const content = readFileSync(CONFIG_FILE, 'utf-8');
      // Simple YAML parser for our config
      const config = {};
      const lines = content.split('\n');
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed && !trimmed.startsWith('#') && trimmed.includes(':')) {
          const [key, ...valueParts] = trimmed.split(':');
          const value = valueParts.join(':').trim();
          if (value) {
            config[key.trim()] = value.replace(/^["']|["']$/g, '');
          }
        }
      }
      return config;
    }
  } catch (e) {
    log.warn(`Could not load config: ${e.message}`);
  }
  return {};
}

// Load YAML profile configuration
function loadYamlProfile(profileName) {
  const profilePath = join(SKILL_DIR, 'profiles', `${profileName}.yaml`);
  if (!existsSync(profilePath)) {
    return null;
  }

  try {
    const content = readFileSync(profilePath, 'utf-8');
    const profile = {
      name: profileName,
      description: '',
      resident_reviewers: [],
      conditional_reviewers: [],
      adversarial_reviewers: [],  // 对抗性审查器 (XLarge 规模强制启用)
      trigger_conditions: {},
      gate: {
        min_score: 90,
        fail_on_redlines: true,
        fail_on_p0_p1_blockers: true,
        require_adversarial: false,  // 是否强制要求对抗性审查器
      },
      output: {
        verbose: true,
        include_evidence: true,
      }
    };

    // Simple YAML parser for profile files
    const lines = content.split('\n');
    let currentSection = '';
    let currentArrayKey = '';
    let currentTriggerKey = '';
    let inCodeBlock = false;
    let codeBlockContent = '';

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmed = line.trim();

      // Track code blocks - extract YAML content
      if (trimmed.startsWith('```')) {
        if (inCodeBlock) {
          // End of code block - parse the accumulated content
          inCodeBlock = false;
          parseYamlContent(codeBlockContent, profile, currentArrayKey, currentTriggerKey);
          codeBlockContent = '';
        } else {
          // Check if this is a YAML code block
          const langMatch = trimmed.match(/^```(yaml)?/);
          if (langMatch) {
            inCodeBlock = true;
          }
        }
        continue;
      }

      if (inCodeBlock) {
        codeBlockContent += line + '\n';
        continue;
      }

      // Skip comments and empty lines
      if (!trimmed || trimmed.startsWith('#')) continue;

      // Section headers (## or ###)
      const sectionMatch = trimmed.match(/^#{2,3}\s+(.+)$/);
      if (sectionMatch) {
        currentSection = sectionMatch[1].trim().toLowerCase();
        continue;
      }

      // Detect indentation level
      const indentMatch = line.match(/^(\s*)/);
      const indent = indentMatch ? indentMatch[1].length : 0;

      // Key-value pairs outside code blocks
      const kvMatch = trimmed.match(/^(\w[\w-]*):\s*(.*)$/);
      if (kvMatch) {
        const key = kvMatch[1].trim();
        const value = kvMatch[2].trim();

        // Array keys
        if (key === 'resident_reviewers') {
          currentArrayKey = 'resident_reviewers';
        } else if (key === 'conditional_reviewers') {
          currentArrayKey = 'conditional_reviewers';
        } else if (key === 'trigger_conditions') {
          currentArrayKey = '';
        }

        if (currentSection === 'trigger conditions') {
          if (['terminal-veteran', 'native-designer', 'data-security', 'zero-doc-user'].includes(key)) {
            currentTriggerKey = key;
            if (!profile.trigger_conditions[key]) {
              profile.trigger_conditions[key] = { files: [], patterns: [] };
            }
          }
        }

        // Top-level scalar values
        if (indent === 0) {
          if (key === 'profile') profile.name = value;
          else if (key === 'description') profile.description = value;
          else if (key === 'min_score') profile.gate.min_score = parseInt(value, 10) || 90;
          else if (key === 'fail_on_redlines') profile.gate.fail_on_redlines = value === 'true';
          else if (key === 'fail_on_p0_p1_blockers') profile.gate.fail_on_p0_p1_blockers = value === 'true';
        }
      }
    }

    return profile;
  } catch (e) {
    log.warn(`Could not load profile ${profileName}: ${e.message}`);
    return null;
  }
}

// Parse YAML content from code block
function parseYamlContent(yamlContent, profile, defaultArrayKey, defaultTriggerKey) {
  if (!yamlContent) return;

  const lines = yamlContent.split('\n');
  let currentArrayKey = defaultArrayKey || '';
  let currentTriggerKey = defaultTriggerKey || '';

  for (const rawLine of lines) {
    const line = rawLine.replace(/^\s+/, ''); // Remove leading whitespace
    const trimmed = line.trim();

    if (!trimmed || trimmed.startsWith('#')) continue;

    // Key-value pairs
    const kvMatch = trimmed.match(/^(\w[\w-]*):\s*(.*)$/);
    if (kvMatch) {
      const key = kvMatch[1].trim();
      const value = kvMatch[2].trim();

      if (key === 'resident_reviewers') {
        currentArrayKey = 'resident_reviewers';
        currentTriggerKey = '';
      } else if (key === 'conditional_reviewers') {
        currentArrayKey = 'conditional_reviewers';
        currentTriggerKey = '';
      } else if (key === 'adversarial_reviewers') {
        currentArrayKey = 'adversarial_reviewers';
        currentTriggerKey = '';
      } else if (key === 'trigger_conditions') {
        currentArrayKey = '';
        currentTriggerKey = '';
      } else if (key === 'gate') {
        currentArrayKey = '';
      } else if (key === 'files' && currentTriggerKey) {
        const filesStr = value.replace(/^\[|\]$/g, '');
        const files = filesStr.split(',').map(s => s.trim().replace(/^['"]|['"]$/g, ''));
        profile.trigger_conditions[currentTriggerKey].files = files;
      } else if (key === 'patterns' && currentTriggerKey) {
        const patternsStr = value.replace(/^\[|\]$/g, '');
        const patterns = patternsStr.split(',').map(s => s.trim().replace(/^['"]|['"]$/g, ''));
        profile.trigger_conditions[currentTriggerKey].patterns = patterns;
      } else if (['terminal-veteran', 'native-designer', 'data-security', 'zero-doc-user'].includes(key)) {
        currentTriggerKey = key;
        currentArrayKey = '';
        if (!profile.trigger_conditions[key]) {
          profile.trigger_conditions[key] = { files: [], patterns: [] };
        }
      } else if (key === 'min_score') {
        profile.gate.min_score = parseInt(value, 10) || 90;
      } else if (key === 'fail_on_redlines') {
        profile.gate.fail_on_redlines = value === 'true';
      } else if (key === 'fail_on_p0_p1_blockers') {
        profile.gate.fail_on_p0_p1_blockers = value === 'true';
      } else if (key === 'require_adversarial') {
        profile.gate.require_adversarial = value === 'true';
      }
      continue;
    }

    // List items
    const listMatch = trimmed.match(/^-\s+(.+)$/);
    if (listMatch) {
      let item = listMatch[1].trim();
      item = item.replace(/\s*#.*$/, '').trim();
      item = item.replace(/^['"]|['"]$/g, '');

      if (currentArrayKey === 'resident_reviewers' && item) {
        profile.resident_reviewers.push(item);
      } else if (currentArrayKey === 'conditional_reviewers' && item) {
        profile.conditional_reviewers.push(item);
      } else if (currentArrayKey === 'adversarial_reviewers' && item) {
        profile.adversarial_reviewers.push(item);
      }
    }
  }
}

// Detect conditional reviewers based on git changes
function detectConditionalReviewers(profile) {
  if (!profile.conditional_reviewers || profile.conditional_reviewers.length === 0) {
    return [];
  }

  const triggered = [];
  const triggerConditions = profile.trigger_conditions || {};

  try {
    // Get changed files
    const gitOutput = execSync('git diff --name-only HEAD 2>/dev/null || echo ""', {
      encoding: 'utf-8',
      cwd: PROJECT_ROOT,
      timeout: 10000,
    });
    const changedFiles = gitOutput.split('\n').filter(f => f.trim());

    for (const reviewer of profile.conditional_reviewers) {
      const conditions = triggerConditions[reviewer];
      if (!conditions) {
        // No specific conditions - always trigger
        triggered.push(reviewer);
        continue;
      }

      const { files = [], patterns = [] } = conditions;

      // Check file patterns
      let matched = false;
      for (const pattern of files) {
        // Simple glob matching
        const regex = new RegExp(
          pattern
            .replace(/\*\*/g, '.*')
            .replace(/\*/g, '[^/]*')
            .replace(/\?/g, '.')
        );

        for (const file of changedFiles) {
          if (regex.test(file)) {
            matched = true;
            break;
          }
        }
        if (matched) break;
      }

      if (matched) {
        triggered.push(reviewer);
      }
    }
  } catch (e) {
    // Git not available - skip conditional detection
    log.warn('Could not detect conditional reviewers: git not available');
  }

  return triggered;
}

// Reviewer profiles
const PROFILES = {
  'quick': {
    name: 'Quick Review',
    description: 'Minimal resident reviewers only',
    reviewers: ['product-flow', 'architecture-maintainer'],
  },
  'default': {
    name: 'Default Review',
    description: 'Standard PR review',
    reviewers: ['product-flow', 'destructive-qa', 'terminal-veteran'],
  },
  'release-gate': {
    name: 'Release Gate Review',
    description: 'Full release gate - required before publish',
    reviewers: [
      'product-flow',
      'architecture-maintainer',
      'release-verifier',
      'destructive-qa',
      'terminal-veteran'
    ],
  },
  'full': {
    name: 'Full Review',
    description: 'All reviewers including conditional triggers',
    reviewers: [
      'product-flow',
      'architecture-maintainer',
      'release-verifier',
      'destructive-qa',
      'native-designer',
      'zero-doc-user',
      'terminal-veteran',
      'data-security'
    ],
  },
};

// Load reviewer definition
function loadReviewer(name) {
  const path = join(SKILL_DIR, 'reviewers', `${name}.md`);
  if (!existsSync(path)) {
    return null;
  }
  return readFileSync(path, 'utf-8');
}

// Parse score from review report
// SECURITY: This function is critical for gate integrity
function parseScore(scoreContent) {
  if (!scoreContent || typeof scoreContent !== 'string') {
    return null;
  }

  // More permissive patterns that match common formats
  const patterns = [
    // Pattern 1: "Overall Score: **67/100**" or "Overall Score: 72/100 (Good)"
    // Handles: spaces around /, bold markers, trailing text
    /(?:总分|Overall Score|Total Score|Score)[^0-9]*(\d+)[^0-9]*\/?\s*100/i,
    // Pattern 2: "**75/100**" (standalone bold)
    /\*\*(\d+)\/100\*\*/,
    // Pattern 3: "68 / 100" or "72/100" anywhere in text
    /(\d+)\s*\/\s*100/,
    // Pattern 4: "Score: 85" (without /100) - less preferred
    /(?:总分|Overall Score|Total Score|Score)[^0-9]*(\d+)$/gim,
  ];

  for (const pattern of patterns) {
    const match = scoreContent.match(pattern);
    if (match) {
      // Get the captured number - pattern 3 captures in match[1], others in match[1]
      const scoreStr = match[1];
      if (scoreStr) {
        const score = parseInt(scoreStr, 10);
        // Validate range (0-100)
        if (!isNaN(score) && score >= 0 && score <= 100) {
          return score;
        }
      }
    }
  }
  return null;
}

// Parse blockers from review report
function parseBlockers(blockerContent) {
  if (!blockerContent || typeof blockerContent !== 'string') {
    return [];
  }

  const lines = blockerContent.split('\n');
  const blockers = [];
  let currentBlocker = null;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      if (currentBlocker) {
        blockers.push(currentBlocker);
        currentBlocker = null;
      }
      continue;
    }

    // Skip lines that explicitly say no blockers
    if (trimmed.includes('无 P0') || trimmed.includes('无 P1') ||
        trimmed.includes('no P0') || trimmed.includes('no P1') ||
        trimmed.includes('无 blockers') || trimmed.includes('no blockers') ||
        trimmed.match(/^#\s+.*Blockers$/i)) {
      continue;
    }

    if (trimmed.includes('P0') || trimmed.includes('P1') ||
        trimmed.includes('❌') || trimmed.includes('红') ||
        trimmed.includes('[ ]') || trimmed.match(/^[-*]\s+\[/)) {
      if (currentBlocker) {
        blockers.push(currentBlocker);
      }
      currentBlocker = trimmed;
    } else if (currentBlocker) {
      currentBlocker += ' ' + trimmed;
    }
  }

  if (currentBlocker) {
    blockers.push(currentBlocker);
  }

  return blockers;
}

// Collect evidence automatically
function collectEvidence_() {
  log.info('Collecting evidence...');

  const evidence = {
    timestamp: new Date().toISOString(),
    git: {},
    files: {},
    automatedChecks: {},
  };

  // Git info
  try {
    evidence.git = {
      branch: execSync('git branch --show-current 2>/dev/null || echo ""', { encoding: 'utf-8' }).trim(),
      commit: execSync('git rev-parse HEAD 2>/dev/null || echo ""', { encoding: 'utf-8' }).trim().substring(0, 8),
      status: execSync('git status --short 2>/dev/null || echo ""', { encoding: 'utf-8' }).trim(),
      diff: execSync('git diff --stat 2>/dev/null || echo ""', { encoding: 'utf-8' }).trim(),
    };
  } catch (e) {
    log.warn('Could not collect git evidence');
  }

  // Package info
  try {
    const packageJson = join(PROJECT_ROOT, 'package.json');
    if (existsSync(packageJson)) {
      const pkg = JSON.parse(readFileSync(packageJson, 'utf-8'));
      evidence.files.package = {
        name: pkg.name,
        version: pkg.version,
        scripts: Object.keys(pkg.scripts || {}),
      };
    }
  } catch (e) {
    // Ignore
  }

  // Automated checks
  evidence.automatedChecks = runAutomatedChecks();

  return evidence;
}

// Run automated gate checks
function runAutomatedChecks() {
  const checks = {
    oversizedFiles: { status: 'pass', issues: [] },
    circularDeps: { status: 'pass', issues: [] },
    secrets: { status: 'pass', issues: [] },
    testGate: { status: 'unknown', output: '' },
    typecheckGate: { status: 'unknown', output: '' },
  };

  // Check 1: Oversized files (>2000 lines)
  log.info('Checking for oversized files...');
  try {
    const output = execSync(
      'find apps packages -name "*.ts" -type f -exec wc -l {} + 2>/dev/null | sort -rn | head -20',
      { encoding: 'utf-8', cwd: PROJECT_ROOT, timeout: 30000 }
    );
    const lines = output.trim().split('\n');
    for (const line of lines) {
      const match = line.trim().match(/^\s*(\d+)\s+(.+)$/);
      if (match) {
        const [count, path] = [parseInt(match[1], 10), match[2]];
        if (count > 2000) {
          checks.oversizedFiles.issues.push({ path, lines: count });
          checks.oversizedFiles.status = 'warn';
        }
      }
    }
  } catch (e) {
    log.warn('Could not check file sizes');
  }

  // Check 2: Circular dependencies (basic heuristic)
  log.info('Checking for circular dependencies...');
  try {
    // Try madge first
    const madgeOutput = execSync(
      'npx madge --circular --extensions ts apps packages 2>&1 || echo ""',
      { encoding: 'utf-8', cwd: PROJECT_ROOT, timeout: 30000 }
    );
    if (madgeOutput.includes('Circular dependencies found') || madgeOutput.includes('-->')) {
      checks.circularDeps.status = 'fail';
      checks.circularDeps.issues = madgeOutput.split('\n').filter(l => l.includes('-->'));
    }
  } catch (e) {
    // madge might not be installed, try manual check
    try {
      const files = execSync(
        'find apps packages -name "index.ts" -type f 2>/dev/null | head -10',
        { encoding: 'utf-8', cwd: PROJECT_ROOT, timeout: 10000 }
      ).trim().split('\n');

      if (files.length > 5) {
        // Too many barrel files might indicate design issues
        checks.circularDeps.issues.push('High number of barrel exports detected - manual review needed');
        checks.circularDeps.status = 'warn';
      }
    } catch (e2) {
      // Ignore
    }
  }

  // Check 3: Secrets in source
  log.info('Checking for secrets in source...');
  try {
    const secretsOutput = execSync(
      'grep -rn "password\\|secret\\|api_key\\|private_key\\|aws_secret" ' +
      '--include="*.ts" --include="*.tsx" --include="*.js" --include="*.json" ' +
      'apps packages 2>/dev/null | grep -v "\\.d\\.ts\\|node_modules\\|_test\\|mock\\|example\\|test\\|spec" | head -10 || echo ""',
      { encoding: 'utf-8', cwd: PROJECT_ROOT, timeout: 30000 }
    ).trim();

    if (secretsOutput && secretsOutput.length > 0) {
      checks.secrets.status = 'warn';
      checks.secrets.issues = secretsOutput.split('\n').slice(0, 5);
    }
  } catch (e) {
    // No secrets found
  }

  // Check 4: Test gate
  log.info('Running test gate...');
  try {
    const testOutput = execSync('pnpm test 2>&1', { encoding: 'utf-8', cwd: PROJECT_ROOT, timeout: 120000 });
    checks.testGate.status = 'pass';
    checks.testGate.output = 'Tests passed';
  } catch (e) {
    checks.testGate.status = 'fail';
    checks.testGate.output = e.message.substring(0, 500);
  }

  // Check 5: Typecheck gate
  log.info('Running typecheck gate...');
  try {
    const typeOutput = execSync('pnpm typecheck 2>&1', { encoding: 'utf-8', cwd: PROJECT_ROOT, timeout: 120000 });
    checks.typecheckGate.status = 'pass';
    checks.typecheckGate.output = 'Typecheck passed';
  } catch (e) {
    checks.typecheckGate.status = 'fail';
    checks.typecheckGate.output = e.message.substring(0, 500);
  }

  return checks;
}

// Check if a reviewer report exists
function reviewerReportExists(roundDir, reviewer) {
  const scorePath = join(roundDir, reviewer, 'score.md');
  const blockerPath = join(roundDir, reviewer, 'blockers.md');
  return existsSync(scorePath) || existsSync(blockerPath);
}

// Simple YAML parser for result.yaml
// SECURITY: Used to validate reviewer scores - must be correct
function parseYamlResult(yamlContent) {
  if (!yamlContent || typeof yamlContent !== 'string') {
    return {
      reviewer: null,
      score: null,
      status: null,
      blockers: [],
      redlines: [],
      dimensions: {},
    };
  }

  const result = {
    reviewer: null,
    score: null,
    status: null,
    blockers: [],
    redlines: [],
    dimensions: {},
  };

  const lines = yamlContent.split('\n');
  let currentKey = null;
  let currentArray = null;
  let inArray = false;

  for (const line of lines) {
    const trimmed = line.trim();

    // Skip comments and empty lines
    if (!trimmed || trimmed.startsWith('#')) continue;

    // Check for array items
    if (trimmed.startsWith('- ')) {
      const item = trimmed.substring(2).trim();
      if (currentArray && item) {
        if (currentArray === 'blockers' || currentArray === 'redlines') {
          // Parse blockers like "P1: Description" or "- P2: Description"
          const blockerMatch = item.match(/^(P[0-3]):\s*(.+)$/i);
          if (blockerMatch) {
            result[currentArray].push({ priority: blockerMatch[1].toUpperCase(), text: blockerMatch[2] });
          } else {
            result[currentArray].push(item);
          }
        } else {
          result[currentArray].push(item);
        }
      }
      continue;
    }

    // Check for key: value
    const colonIndex = trimmed.indexOf(':');
    if (colonIndex > 0) {
      const key = trimmed.substring(0, colonIndex).trim().toLowerCase();
      const value = trimmed.substring(colonIndex + 1).trim();

      // Handle array markers
      if (value === '' || value === '[]') {
        currentKey = key;
        currentArray = key;
        inArray = true;
        continue;
      }

      // Parse values
      switch (key) {
        case 'reviewer':
          result.reviewer = value;
          break;
        case 'score':
          // Handle "85/100" or just "85"
          const scoreMatch = value.match(/^(\d+)(?:\/100)?$/);
          if (scoreMatch) {
            const score = parseInt(scoreMatch[1], 10);
            if (score >= 0 && score <= 100) {
              result.score = score;
            }
          }
          break;
        case 'status':
          result.status = value;
          break;
        default:
          // Check for dimension scores like "module-clarity: 17/25"
          const dimMatch = value.match(/^(\d+)\/(\d+)$/);
          if (dimMatch) {
            result.dimensions[key] = {
              score: parseInt(dimMatch[1], 10),
              max: parseInt(dimMatch[2], 10),
            };
          }
      }

      inArray = false;
      currentArray = null;
    }
  }

  return result;
}

// Validate reviewer identity
// SECURITY: Prevents fake reviewers from bypassing the gate
function validateReviewerIdentity(reviewer, profile) {
  const reviewerPath = join(SKILL_DIR, 'reviewers', `${reviewer}.md`);

  // Check if reviewer definition exists
  if (!existsSync(reviewerPath)) {
    return { valid: false, error: `Unknown reviewer: ${reviewer}` };
  }

  // Check if reviewer is in the current profile
  const profileConfig = PROFILES[profile];
  if (profileConfig && !profileConfig.reviewers.includes(reviewer)) {
    return { valid: false, error: `Reviewer ${reviewer} not in profile ${profile}` };
  }

  return { valid: true };
}

// Load existing scores for a round
// SECURITY: This function validates score authenticity
function loadExistingScores(roundDir, reviewers) {
  const results = {};

  for (const reviewer of reviewers) {
    const reviewerDir = join(roundDir, reviewer);
    const scorePath = join(reviewerDir, 'score.md');
    const blockerPath = join(reviewerDir, 'blockers.md');
    const improvementPath = join(reviewerDir, 'improvement-list.md');
    const resultYamlPath = join(reviewerDir, 'result.yaml');

    let score = null;
    let blockers = [];
    let improvements = null;
    let hasReport = false;
    let scoreSource = null;

    // Priority: result.yaml > score.md (for score)
    // Blockers: blockers.md OR result.yaml OR score.md

    // Try result.yaml first (if exists)
    if (existsSync(resultYamlPath)) {
      try {
        const yamlContent = readFileSync(resultYamlPath, 'utf-8');
        const yamlResult = parseYamlResult(yamlContent);

        if (yamlResult.score !== null) {
          score = yamlResult.score;
          scoreSource = 'result.yaml';
        }

        if (yamlResult.blockers.length > 0) {
          blockers = yamlResult.blockers.map(b =>
            typeof b === 'string' ? b : `${b.priority}: ${b.text}`
          );
        }

        hasReport = true;
      } catch (e) {
        // result.yaml exists but couldn't be parsed - fall through to score.md
      }
    }

    // Fall back to score.md for score (if result.yaml didn't have one)
    if (score === null && existsSync(scorePath)) {
      try {
        const content = readFileSync(scorePath, 'utf-8');
        const parsedScore = parseScore(content);
        if (parsedScore !== null) {
          score = parsedScore;
          scoreSource = 'score.md';
        }

        // Also extract blockers from score.md if not found in result.yaml
        if (blockers.length === 0) {
          // Look for "Blockers" or "## Blockers" section in score.md
          const blockerMatch = content.match(/(?:##\s+)?Blockers?\s*\n([\s\S]*?)(?:\n##|\n#|$)/i);
          if (blockerMatch) {
            const blockerSection = blockerMatch[1];
            blockers = parseBlockers(blockerSection);
          }
        }

        hasReport = true;
      } catch (e) {
        // score.md exists but couldn't be read
      }
    }

    // Load blockers.md if exists and blockers still empty
    if (blockers.length === 0 && existsSync(blockerPath)) {
      try {
        const blockerContent = readFileSync(blockerPath, 'utf-8');
        blockers = parseBlockers(blockerContent);
        hasReport = true;
      } catch (e) {
        // Ignore
      }
    }

    // Load improvements
    if (existsSync(improvementPath)) {
      try {
        improvements = readFileSync(improvementPath, 'utf-8');
        hasReport = true;
      } catch (e) {
        // Ignore
      }
    }

    // Validate reviewer identity
    const validation = validateReviewerIdentity(reviewer, profile);

    results[reviewer] = {
      score,
      scoreSource, // Track where the score came from
      hasReport,
      blockers,
      improvements,
      isValidReviewer: validation.valid,
      validationError: validation.error,
    };
  }

  return results;
}

// Generate summary report
function generateSummary(roundDir, profile, scores, allPassed, evidence = null) {
  const reportPath = join(roundDir, 'summary.md');
  const timestamp = new Date().toISOString();

  let content = `# Quality Review Summary - Round ${roundNumber}\n\n`;
  content += `**Profile:** ${profile}\n`;
  content += `**Generated:** ${timestamp}\n`;

  if (evidence) {
    content += `**Git:** ${evidence.git.branch} @ ${evidence.git.commit}\n`;
  }

  if (evidence && evidence.automatedChecks) {
    const ac = evidence.automatedChecks;
    content += `## Automated Gate Checks\n\n`;
    content += `| Check | Status | Details |\n`;
    content += `|-------|--------|--------|\n`;

    const testIcon = ac.testGate.status === 'pass' ? '✅' : '❌';
    content += `| pnpm test | ${testIcon} ${ac.testGate.status} | ${ac.testGate.output.substring(0, 50)} |\n`;

    const typeIcon = ac.typecheckGate.status === 'pass' ? '✅' : '❌';
    content += `| pnpm typecheck | ${typeIcon} ${ac.typecheckGate.status} | ${ac.typecheckGate.output.substring(0, 50)} |\n`;

    const sizeIcon = ac.oversizedFiles.status === 'pass' ? '✅' : '⚠️';
    content += `| File sizes | ${sizeIcon} ${ac.oversizedFiles.issues.length} oversized | ${ac.oversizedFiles.issues.slice(0, 2).map(i => `${i.lines}L ${i.path.split('/').pop()}`).join(', ') || 'OK'} |\n`;

    const circIcon = ac.circularDeps.status === 'pass' ? '✅' : '❌';
    content += `| Circular deps | ${circIcon} | ${ac.circularDeps.issues.length > 0 ? ac.circularDeps.issues[0].substring(0, 50) : 'None found'} |\n`;

    const secretIcon = ac.secrets.status === 'pass' ? '✅' : '⚠️';
    content += `| Secrets scan | ${secretIcon} | ${ac.secrets.issues.length > 0 ? ac.secrets.issues.length + ' potential' : 'Clean'} |\n`;

    content += `\n`;

    // Add detail section for issues
    const allIssues = [
      ...ac.oversizedFiles.issues.map(i => `⚠️ **Oversized file**: ${i.path} (${i.lines} lines)`),
      ...ac.secrets.issues.map(i => `⚠️ **Potential secret**: ${i.substring(0, 100)}`),
      ...ac.circularDeps.issues.filter(i => typeof i === 'string').map(i => `❌ **Circular dep**: ${i.substring(0, 100)}`),
    ];

    if (allIssues.length > 0) {
      content += `### Automated Check Issues\n\n`;
      allIssues.forEach((issue, i) => {
        content += `${i + 1}. ${issue}\n`;
      });
      content += `\n`;
    }
  }

  content += `---\n\n`;

  // Score table
  content += `## Scores\n\n`;
  content += `| Reviewer | Score | Status | Blockers |\n`;
  content += `|----------|-------|--------|----------|\n`;

  let totalPassed = 0;
  let totalReviewed = 0;
  let totalBlockers = 0;

  for (const [reviewer, result] of Object.entries(scores)) {
    totalReviewed++;
    if (result.score !== null) {
      const status = result.score >= 90 ? '✅ PASS' : '❌ FAIL';
      const blockerCount = result.blockers.length;
      totalBlockers += blockerCount;
      content += `| ${reviewer} | ${result.score}/100 | ${status} | ${blockerCount > 0 ? `⚠ ${blockerCount}` : '-'} |\n`;
      if (result.score >= 90) totalPassed++;
    } else if (result.hasReport) {
      content += `| ${reviewer} | N/A | ⚠ INCOMPLETE | ${result.blockers.length} |\n`;
    } else {
      content += `| ${reviewer} | - | ⏳ PENDING | - |\n`;
    }
  }

  content += `\n`;
  content += `**Total:** ${totalPassed}/${totalReviewed} passed, ${totalBlockers} blockers\n\n`;

  // Blockers detail
  const allBlockers = Object.entries(scores)
    .filter(([, r]) => r.blockers && r.blockers.length > 0)
    .flatMap(([name, r]) => r.blockers.map(b => ({ reviewer: name, blocker: b })));

  if (allBlockers.length > 0) {
    content += `## Blockers Detail\n\n`;
    for (const { reviewer, blocker } of allBlockers) {
      content += `- **${reviewer}:** ${blocker}\n`;
    }
    content += `\n`;
  }

  // Overall status
  content += `---\n\n`;
  if (allPassed) {
    content += `## ✅ ALL REVIEWERS PASSED\n\n`;
    content += `This release has passed all quality gates. It is ready to ship.\n`;
    content += `\nTo generate the final report:\n`;
    content += `\`\`\`bash\n`;
    content += `node skills/release-quality-review/scripts/review-gate.mjs --generate-final\n`;
    content += `\`\`\`\n`;
  } else {
    content += `## ❌ QUALITY GATE FAILED\n\n`;
    content += `This release has not passed quality gates. Fix the issues below and re-run review.\n\n`;
    content += `**To continue:**\n`;
    content += `\`\`\`bash\n`;
    content += `node skills/release-quality-review/scripts/review-runner.mjs --profile ${profile} --round ${roundNumber + 1}\n`;
    content += `\`\`\`\n\n`;

    // Show top blockers
    if (allBlockers.length > 0) {
      content += `**Top priorities to fix:**\n\n`;
      allBlockers.slice(0, 5).forEach(({ reviewer, blocker }, i) => {
        content += `${i + 1}. [${reviewer}] ${blocker}\n`;
      });
    }
  }

  writeFileSync(reportPath, content);
  log.success(`Summary written to: ${reportPath}`);
  return allPassed;
}

// Generate Phase boundary marker for persistent handoff
function writePhaseBoundary(roundDir, roundNumber, phase, nextPhase) {
  const boundaryPath = join(roundDir, 'PHASE-COMPLETE.md');
  const timestamp = new Date().toISOString();

  const content = `# Phase ${phase} Complete - Quality Gate Handoff

## Phase Information
- **Current Phase**: ${phase}
- **Next Phase**: ${nextPhase || 'END (Release Complete)'}
- **Round**: ${roundNumber}
- **Completed At**: ${timestamp}

## Handoff Checklist

### Must Complete Before Next Phase
- [ ] All P0/P1 blockers resolved
- [ ] All reviewer scores >= 90/100
- [ ] Evidence source validation passed
- [ ] Goal mode constraint satisfied (if enabled)
- [ ] Phase boundary marked

### Evidence Files Required
- [ ] result.yaml (machine-readable results)
- [ ] score.md (reviewer scoring details)
- [ ] blockers.md (P0/P1 issues)
- [ ] improvement-list.md (P2/P3 suggestions)
- [ ] metadata.json (review metadata)

## Next Phase Criteria

### For Gate Pass
1. All reviewers >= 90/100
2. No P0/P1 redlines
3. Evidence validation passed
4. Phase boundary marked

### For Next Review Round
Run: \`node review-gate.mjs --round ${roundNumber + 1} --profile release-gate\`

---
*Generated by Release Quality Review Skill*
`;

  writeFileSync(boundaryPath, content);
  log.success(`Phase boundary written: ${boundaryPath}`);
  return boundaryPath;
}

// Generate final report when all gates pass
function generateFinalReport(scores, evidence = null) {
  const reportPath = join(REPORT_DIR, 'final-report.md');
  const timestamp = new Date().toISOString();

  let content = `# 🎉 RELEASE APPROVED\n\n`;
  content += `**Date:** ${timestamp}\n`;
  content += `**Status:** APPROVED FOR RELEASE\n`;

  if (evidence) {
    content += `**Git:** ${evidence.git.branch} @ ${evidence.git.commit}\n`;
  }

  content += `\n---\n\n`;
  content += `## Final Scores\n\n`;
  content += `| Reviewer | Score | Gate |\n`;
  content += `|----------|-------|------|\n`;

  for (const [reviewer, result] of Object.entries(scores)) {
    const status = result.score >= 90 ? '✅' : '❌';
    content += `| ${reviewer} | ${result.score}/100 | ${status} |\n`;
  }

  content += `\n---\n\n`;
  content += `## Release Checklist\n\n`;
  content += `- [x] All reviewers >= 90/100\n`;
  content += `- [x] No P0/P1 redlines\n`;
  content += `- [ ] Tests passing\n`;
  content += `- [ ] Build successful\n`;
  content += `- [ ] Changelog updated\n`;
  content += `- [ ] Version bumped\n\n`;
  content += `---\n\n`;
  content += `*Generated by Release Quality Review Skill*\n`;
  content += `*Tool: cli-bridge quality gate*\n`;

  writeFileSync(reportPath, content);
  log.success(`Final report: ${reportPath}`);
  return reportPath;
}

// ============================================================================
// Right-size Throttle: Include scale in metadata
// ============================================================================

/**
 * Update metadata.json with scale information
 */
function updateMetadataWithScale(roundDir) {
  const metaPath = join(roundDir, 'metadata.json');
  try {
    let meta = {};
    if (existsSync(metaPath)) {
      meta = JSON.parse(readFileSync(metaPath, 'utf-8'));
    }
    meta.scale = startupScaleInfo;
    writeFileSync(metaPath, JSON.stringify(meta, null, 2));
  } catch (e) {
    // Ignore - metadata update is best-effort
  }
}

// Main gate check
async function runGate() {
  // Show scale detection at startup
  if (!userSpecifiedProfile) {
    log.info(`Change scale: ${colors.bright}${startupScaleInfo.scale}${colors.reset} (${startupScaleInfo.files} files, ${startupScaleInfo.total} lines)`);
    if (startupScaleInfo.suggestedProfile !== profile) {
      log.info(`Suggested profile: ${colors.cyan}${startupScaleInfo.suggestedProfile}${colors.reset} (use --profile to override)`);
    }
  }

  const config = loadConfig();

  // Determine reviewers to run
  let reviewers = [];
  let profileConfig = PROFILES[profile] || PROFILES['release-gate'];

  // Try to load YAML profile first (overrides PROFILES object)
  const yamlProfile = loadYamlProfile(profile);
  if (yamlProfile) {
    log.info(`Loaded YAML profile: ${yamlProfile.name}`);
    log.info(`  Resident reviewers: ${JSON.stringify(yamlProfile.resident_reviewers)}`);
    log.info(`  Conditional reviewers: ${JSON.stringify(yamlProfile.conditional_reviewers)}`);

    // Start with resident reviewers
    reviewers = [...yamlProfile.resident_reviewers];

    // Detect and add conditional reviewers
    const triggeredConditional = detectConditionalReviewers(yamlProfile);
    if (triggeredConditional.length > 0) {
      log.info(`Conditional reviewers triggered: ${triggeredConditional.join(', ')}`);
      reviewers = [...reviewers, ...triggeredConditional];
    }

    // Add adversarial reviewers if required (XLarge scale)
    if (yamlProfile.gate?.require_adversarial && yamlProfile.adversarial_reviewers?.length > 0) {
      log.info(`Adversarial reviewers (required): ${JSON.stringify(yamlProfile.adversarial_reviewers)}`);
      reviewers = [...reviewers, ...yamlProfile.adversarial_reviewers];
    }

    profileConfig = {
      name: yamlProfile.name,
      description: yamlProfile.description,
      reviewers: reviewers,
      gate: yamlProfile.gate,
    };
  } else {
    // Fall back to PROFILES object
    reviewers = profileConfig.reviewers.filter(r => !excludeReviewers.includes(r));
  }

  // Single reviewer mode overrides profile
  if (singleReviewer) {
    reviewers = [singleReviewer];
  }

  // Dry run mode
  if (dryRun) {
    log.info(`Dry run mode - validating configuration`);
    log.info(`Profile: ${profile}`);
    log.info(`Reviewers: ${reviewers.join(', ')}`);
    log.info(`Round: ${roundNumber}`);

    // Validate reviewer files exist
    for (const reviewer of reviewers) {
      const exists = existsSync(join(SKILL_DIR, 'reviewers', `${reviewer}.md`));
      log.info(`  ${exists ? '✓' : '✗'} ${reviewer}: ${exists ? 'found' : 'MISSING'}`);
    }

    return true;
  }

  // Title
  console.log('');
  log.title('RELEASE QUALITY GATE');
  log.info(`Profile: ${colors.bright}${profile}${colors.reset}`);
  log.info(`Reviewers: ${reviewers.join(', ')}`);
  if (parallel) log.info(`Mode: parallel`);
  console.log('');

  // Determine round directory
  let roundDir = join(REPORT_DIR, `round-${String(roundNumber).padStart(3, '0')}`);

  // Check if this is a new round or continuing
  const isNewRound = !existsSync(roundDir);
  if (isNewRound) {
    mkdirSync(roundDir, { recursive: true });
    log.info(`New round: ${roundDir}`);
  } else {
    log.info(`Continuing round: ${roundDir}`);
  }

  // Collect evidence if requested
  let evidence = null;
  if (collectEvidence) {
    try {
      evidence = collectEvidence_();
      log.success(`Evidence collected`);
    } catch (e) {
      log.warn(`Evidence collection failed: ${e.message}`);
    }
  }

  // Load existing scores
  const existingScores = loadExistingScores(roundDir, reviewers);
  const pendingReviewers = reviewers.filter(r => !existingScores[r].hasReport);
  const completedReviewers = reviewers.filter(r => existingScores[r].hasReport);

  // Check for redlines only mode
  if (checkRedlinesOnly) {
    log.title('REDLINE CHECK');
    const allBlockers = Object.entries(existingScores)
      .filter(([, r]) => r.blockers && r.blockers.length > 0)
      .flatMap(([name, r]) => r.blockers.map(b => ({ reviewer: name, blocker: b })));

    if (allBlockers.length === 0) {
      log.success('No redlines found!');
      return true;
    } else {
      log.error(`Found ${allBlockers.length} redlines:`);
      allBlockers.forEach(({ reviewer, blocker }, i) => {
        console.log(`  ${i + 1}. [${reviewer}] ${blocker}`);
      });
      return false;
    }
  }

  // Show pending reviewers
  if (pendingReviewers.length > 0) {
    log.title('PENDING REVIEWS');
    for (const reviewer of pendingReviewers) {
      const reviewerContent = loadReviewer(reviewer);
      if (reviewerContent) {
        const reviewerDir = join(roundDir, reviewer);
        mkdirSync(reviewerDir, { recursive: true });
        console.log(`  ${colors.cyan}${reviewer}${colors.reset}`);
      } else {
        log.warn(`  ${reviewer}: reviewer definition not found`);
      }
    }
    console.log('');
  }

  // Show completed reviewers with scores
  if (completedReviewers.length > 0) {
    log.title('COMPLETED REVIEWS');
    for (const reviewer of completedReviewers) {
      const reviewerResult = existingScores[reviewer];
      const score = reviewerResult.score;
      const blockerCount = reviewerResult.blockers?.length || 0;
      const isValid = reviewerResult.isValidReviewer;
      const scoreSource = reviewerResult.scoreSource;

      // Validate reviewer identity
      if (!isValid) {
        console.log(`  ${colors.red}✗${colors.reset} ${reviewer}: ${colors.red}INVALID REVIEWER${colors.reset}`);
        console.log(`    ${colors.yellow}⚠${colors.reset} ${reviewerResult.validationError}`);
        continue;
      }

      if (score !== null) {
        const icon = score >= 90 ? '✅' : '❌';
        const blockerIcon = blockerCount > 0 ? ` ${colors.yellow}⚠${blockerCount}${colors.reset}` : '';
        const sourceNote = scoreSource === 'result.yaml' ? ` ${colors.dim}(verified)${colors.reset}` : '';
        console.log(`  ${icon} ${reviewer}: ${score}/100${blockerIcon}${sourceNote}`);
      } else if (reviewerResult.hasReport) {
        console.log(`  ${colors.yellow}⚠${colors.reset} ${reviewer}: incomplete${blockerCount > 0 ? ` ${colors.yellow}⚠${blockerCount}${colors.reset}` : ''}`);
      }
    }
    console.log('');
  }

  // Calculate overall status (moved up for evidence validation check)
  // SECURITY: All reviewers must be valid, have scores, and pass the 90 threshold
  // SECURITY: Evidence must pass source validation (对抗性审查)
  const allValid = reviewers.every(r => existingScores[r].isValidReviewer !== false);
  const allHaveScores = reviewers.every(r => existingScores[r].score !== null);

  // ============================================================================
  // P3: 对抗性审查 - 运行 evidence-validator 检查证据来源合规性
  // ============================================================================
  let evidenceValidationPassed = true;
  let evidenceValidationResults = null;

  if (validateEvidence && allHaveScores) {
    log.title('EVIDENCE SOURCE VALIDATION');
    try {
      const evidenceValidatorScript = join(SKILL_DIR, 'scripts', 'evidence-validator.mjs');
      if (existsSync(evidenceValidatorScript)) {
        const roundName = `round-${String(roundNumber).padStart(3, '0')}`;
        log.info(`Running evidence-validator for ${roundName}...`);

        // Run evidence validator and capture output
        const validatorOutput = execSync(
          `node "${evidenceValidatorScript}" --round ${roundName}`,
          { encoding: 'utf-8', cwd: PROJECT_ROOT, timeout: 60000 }
        );

        // Check if validation passed
        if (validatorOutput.includes('✅ All reviewers passed')) {
          log.success('Evidence source validation passed');
        } else {
          evidenceValidationPassed = false;
          log.warn('Evidence validation found issues');
          console.log(validatorOutput);

          // Also save to file
          const validationReportPath = join(roundDir, 'evidence-validation.md');
          writeFileSync(validationReportPath, `# Evidence Source Validation\n\n${validatorOutput}\n`);
          log.info(`Validation report: ${validationReportPath}`);
        }
        evidenceValidationResults = validatorOutput;
      }
    } catch (e) {
      // Validator might exit 1 on violations - that's expected
      if (e.stdout) {
        evidenceValidationPassed = false;
        log.warn('Evidence validation found issues');
        console.log(e.stdout);

        // Save report
        const validationReportPath = join(roundDir, 'evidence-validation.md');
        writeFileSync(validationReportPath, `# Evidence Source Validation\n\n${e.stdout}\n`);
      } else {
        log.warn(`Evidence validator error: ${e.message}`);
      }
    }
  }

  // ============================================================================
  // P1: Goal Mode Constraint Check - 强制描述最终状态而非实现步骤
  // ============================================================================
  let goalModeViolations = [];
  if (checkGoalMode && allHaveScores) {
    log.title('GOAL MODE CONSTRAINT CHECK');

    // 检测 score.md 中是否描述了实现步骤而非目标达成
    const goalModePatterns = [
      { pattern: /实现了|添加了|写了|创建了|修改了/g, desc: '描述实现动作而非目标状态' },
      { pattern: /按照.*步骤|分.*步|逐步/g, desc: '描述实现过程而非最终状态' },
      { pattern: /我们添加|我写的|上面的代码/g, desc: '使用第一人称或引用过程' },
    ];

    for (const reviewer of reviewers) {
      const reviewerDir = join(roundDir, reviewer);
      const scorePath = join(reviewerDir, 'score.md');

      if (existsSync(scorePath)) {
        const content = readFileSync(scorePath, 'utf-8');

        for (const { pattern, desc } of goalModePatterns) {
          // Reset lastIndex for global patterns
          pattern.lastIndex = 0;
          const matches = content.match(pattern);
          if (matches && matches.length > 0) {
            goalModeViolations.push({
              reviewer,
              desc,
              count: matches.length,
            });
            log.warn(`${reviewer}: ${desc} (${matches.length} 处)`);
          }
        }
      }
    }

    if (goalModeViolations.length === 0) {
      log.success('Goal mode constraint satisfied - all reviewers describe final state');
    } else {
      log.error(`${goalModeViolations.length} goal mode violations detected`);
    }
  }

  // ============================================================================
  // P2: Goal Instruction Gate - 验证生成的 goal 指令是否合规
  // ============================================================================
  let goalInstructionResult = null;
  const goalGateScript = join(SKILL_DIR, 'scripts', 'goal-instruction-gate.mjs');

  if (existsSync(goalGateScript) && existsSync(join(roundDir, 'generated-goal.md'))) {
    log.title('GOAL INSTRUCTION VALIDATION');

    try {
      const goalFile = join(roundDir, 'generated-goal.md');
      const goalText = readFileSync(goalFile, 'utf-8');

      // Run goal instruction gate
      const gateOutput = execSync(
        `node "${goalGateScript}" --file "${goalFile}"`,
        { encoding: 'utf-8', cwd: PROJECT_ROOT, timeout: 30000 }
      );

      // Parse score from output
      const scoreMatch = gateOutput.match(/Score:\s*(\d+)/);
      const score = scoreMatch ? parseInt(scoreMatch[1], 10) : 0;
      const passed = gateOutput.includes('判定：合格') || gateOutput.includes('✓');

      goalInstructionResult = { passed, score };

      if (passed) {
        log.success(`Goal instruction valid (${score}/100)`);
      } else {
        log.error(`Goal instruction invalid (${score}/100)`);
        console.log(gateOutput);

        // Save validation report
        const validationReport = join(roundDir, 'goal-instruction-validation.md');
        writeFileSync(validationReport, `# Goal Instruction Validation\n\n${gateOutput}\n`);
        log.info(`Validation report: ${validationReport}`);
      }
    } catch (e) {
      // Gate script exits 1 on validation failure
      if (e.stdout) {
        goalInstructionResult = { passed: false, score: 0 };
        log.error('Goal instruction validation failed');
        console.log(e.stdout);
      } else {
        log.warn(`Goal instruction gate error: ${e.message}`);
      }
    }
  }

  // Calculate overall status
  // SECURITY: All reviewers must be valid, have scores, and pass the 90 threshold
  // SECURITY: Evidence must pass source validation (对抗性审查)
  // SECURITY: Goal mode constraint must be satisfied (if enabled)
  // SECURITY: Goal instruction must be valid (goal 指令生成器)
  const allPassed = allHaveScores && reviewers.every(r => existingScores[r].score >= 90);

  // Only P0/P1 blockers are true "redlines" - P2/P3 are suggestions, not blockers
  const hasRedlines = Object.values(existingScores).some(r =>
    r.blockers && r.blockers.some(b =>
      typeof b === 'string' ?
        /\bP0\b|\bP1\b/i.test(b) :
        (b.priority === 'P0' || b.priority === 'P1')
    )
  );
  const hasInvalidReviewers = Object.values(existingScores).some(r => !r.isValidReviewer);
  const goalInstructionValid = !goalInstructionResult || goalInstructionResult.passed;
  const gatePassed = allPassed && !hasRedlines && evidenceValidationPassed &&
                     (!checkGoalMode || goalModeViolations.length === 0) &&
                     goalInstructionValid;

  // Summary
  log.title('GATE STATUS');

  // SECURITY: Block if any reviewer is invalid
  if (hasInvalidReviewers) {
    log.error('GATE BLOCKED - Invalid reviewers detected');
    for (const [reviewer, result] of Object.entries(existingScores)) {
      if (!result.isValidReviewer) {
        log.error(`  - ${reviewer}: ${result.validationError}`);
      }
    }
    generateSummary(roundDir, profile, existingScores, false, evidence);
    return false;
  }

  if (allHaveScores) {
    if (gatePassed) {
      log.success('All gates PASSED!');
      log.success('Evidence source validation passed');
      log.success('Goal mode constraint satisfied');

      // P4: Persistent Handoff - Write Phase boundary marker
      const currentPhase = roundNumber;
      const nextPhase = 'END (Release Complete)';
      writePhaseBoundary(roundDir, roundNumber, currentPhase, nextPhase);

      generateSummary(roundDir, profile, existingScores, true, evidence);

      // Generate final report
      const finalPath = generateFinalReport(existingScores, evidence);
      console.log('');
      log.success('🎉 Release is ready!');
      return true;
    } else {
      log.error('GATE FAILED');
      if (hasRedlines) {
        log.error('Redlines detected - blocking release');
      }
      if (!evidenceValidationPassed) {
        log.error('Evidence source validation failed - self-verification detected');
      }
      if (checkGoalMode && goalModeViolations.length > 0) {
        log.error('Goal mode constraint violated - describing implementation steps instead of final state');
      }
      if (goalInstructionResult && !goalInstructionResult.passed) {
        log.error(`Goal instruction invalid (${goalInstructionResult.score}/100) - contains plan language`);
      }
      generateSummary(roundDir, profile, existingScores, false, evidence);
      return false;
    }
  } else {
    const completed = completedReviewers.length;
    const total = reviewers.length;
    console.log(`  Progress: ${completed}/${total} completed`);
    console.log('');
    log.info('To complete this review, run the pending reviewers:');
    console.log('');
    for (const reviewer of pendingReviewers) {
      console.log(`  ${colors.magenta}node review-gate.mjs --reviewer ${reviewer}${colors.reset}`);
    }
    console.log('');

    // P4: Persistent Handoff - Write Phase boundary for intermediate rounds
    writePhaseBoundary(roundDir, roundNumber, roundNumber, roundNumber + 1);

    generateSummary(roundDir, profile, existingScores, false, evidence);
    return false;
  }
}

// Run the gate
runGate()
  .then(passed => {
    process.exit(passed ? 0 : 1);
  })
  .catch(err => {
    log.error(`Gate error: ${err.message}`);
    process.exit(2);
  });
