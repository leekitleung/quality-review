/**
 * Review Utilities - Shared functions for review-gate and review-runner
 *
 * Extracted from the scripts to enable proper unit testing.
 * Functions here are pure logic with no side effects.
 */

// ============================================================================
// Score Parsing
// ============================================================================

/**
 * Parse score from review report content
 * @param {string|null|undefined} scoreContent
 * @returns {number|null}
 */
export function parseScore(scoreContent) {
  if (!scoreContent || typeof scoreContent !== 'string') {
    return null;
  }

  const patterns = [
    // Pattern 1: "Overall Score: **67/100**" or "Overall Score: 72/100 (Good)"
    /(?:总分|Overall Score|Total Score|Score)[^0-9]*(\d+)[^0-9]*\/?\s*100/i,
    // Pattern 2: "**75/100**" (standalone bold)
    /\*\*(\d+)\/100\*\*/,
    // Pattern 3: "68 / 100" or "72/100" anywhere in text
    /(\d+)\s*\/\s*100/,
    // Pattern 4: "Score: 85" (without /100) - must have Score header, NOT global
    /(?:总分|Overall Score|Total Score|Score)[^0-9]*(\d+)$/im,
  ];

  for (const pattern of patterns) {
    const match = scoreContent.match(pattern);
    if (match) {
      const scoreStr = match[1];
      if (scoreStr) {
        const score = parseInt(scoreStr, 10);
        // Validate range (0-100) and reject negative-looking inputs
        if (!isNaN(score) && score >= 0 && score <= 100) {
          // Guard: reject if the match includes a preceding minus sign
          const fullMatch = match[0];
          if (!fullMatch.includes('-' + scoreStr)) {
            return score;
          }
        }
      }
    }
  }
  return null;
}

function verificationKind(name) {
  if (/^test(?::|$)/i.test(name)) return 'test';
  if (/coverage/i.test(name)) return 'coverage';
  if (/^(?:typecheck|lint|build)(?::|$)/i.test(name)) return 'code';
  return 'generic';
}

function verificationCapabilities(command) {
  const trimmed = String(command || '').trim();
  const words = trimmed.split(/\s+/);
  const executable = words[0]?.toLowerCase();
  const capabilities = new Set();

  if (/^node(?:\.exe)?$/.test(executable)) {
    const args = words.slice(1);
    if (args[0] === 'scripts/sync-skills.mjs' && args[1] === 'check') capabilities.add('generic');
    if (args[0] === 'skills/release-quality-review/scripts/review-gate.mjs' && args.includes('--dry-run')) {
      capabilities.add('generic');
    }

    const entryOptions = [];
    for (const arg of args) {
      if (arg === '--' || !arg.startsWith('-')) break;
      entryOptions.push(arg);
    }
    if (entryOptions.some(arg => /^(?:-e|-p)(?:.|$)|^--(?:eval|print)(?:=|$)/.test(arg))) return new Set();

    const hasTestRunner = entryOptions.some(arg => arg === '--test' || arg.startsWith('--test='));
    const hasCoverage = entryOptions.some(arg =>
      arg === '--experimental-test-coverage' || arg.startsWith('--test-coverage-'));
    if (hasTestRunner) capabilities.add('test');
    if (hasTestRunner && hasCoverage) {
      capabilities.add('coverage');
    }
    if (args[0] === '--check') capabilities.add('code');
    return capabilities;
  }

  if (/^(?:jest|vitest|playwright|cypress|mocha|ava|pytest)$/.test(executable)) {
    capabilities.add('test');
    if (words.some(word => /^--coverage(?:=|$)|^--cov(?:=|$)/.test(word))) capabilities.add('coverage');
  } else if (/^(?:nyc|c8)$/.test(executable)) {
    capabilities.add('test');
    capabilities.add('coverage');
  } else if (/^(?:tsc|eslint|ruff|mypy)$/.test(executable)) {
    capabilities.add('code');
  } else if (/^(?:go|cargo|swift|deno|bun|dotnet)$/.test(executable) &&
      /^(?:test|check|build|lint|vet|clippy)$/.test(words[1] || '')) {
    const action = words[1];
    capabilities.add(action === 'test' ? 'test' : 'code');
    if (action === 'test' && words.some(word => /^-cover|^--coverage/.test(word))) capabilities.add('coverage');
  } else if (/^(?:make|cmake|ninja|mvn|gradle|xcodebuild)$/.test(executable)) {
    capabilities.add('code');
  }
  return capabilities;
}

function scriptNameFromCommand(command) {
  const match = String(command || '').trim().match(/^(?:npm|pnpm|yarn)\s+(?:run\s+)?([A-Za-z0-9:._-]+)(?:\s|$)/);
  return match?.[1] || null;
}

function hasMeaningfulScript(name, scripts, requiredKind = verificationKind(name), visiting = new Set()) {
  if (!name || visiting.has(name) || typeof scripts?.[name] !== 'string') return false;
  const nextVisiting = new Set(visiting).add(name);
  // Only `&&` preserves verifier failure. Fallbacks, pipelines, sequential
  // commands, backgrounding and newlines can replace a failed exit status.
  const withoutSafeAnd = scripts[name].replaceAll('&&', '');
  if (/[|;&\r\n]/.test(withoutSafeAnd)) return false;
  const segments = scripts[name].split(/\s*&&\s*/).filter(Boolean);
  return segments.some(segment => {
    const trimmed = segment.trim();
    const nested = scriptNameFromCommand(trimmed);
    if (nested) return hasMeaningfulScript(nested, scripts, requiredKind, nextVisiting);
    const capabilities = verificationCapabilities(trimmed);
    return requiredKind === 'generic' ? capabilities.size > 0 : capabilities.has(requiredKind);
  });
}

export function findTrivialVerificationScripts(scripts, commands) {
  const issues = [];
  for (const command of commands) {
    const name = scriptNameFromCommand(command);
    if (name && !hasMeaningfulScript(name, scripts)) issues.push({ command, script: name });
  }
  return issues;
}

export function hasConcreteVerificationOutput(kind, output) {
  const text = String(output || '');
  if (kind === 'test') {
    const totals = [...text.matchAll(/#\s*tests\s+(\d+)/gi)].map(match => Number(match[1]));
    const failures = [...text.matchAll(/#\s*fail\s+(\d+)/gi)].map(match => Number(match[1]));
    if (totals.length > 0 && failures.length > 0) {
      return totals.some(total => total > 0) && failures.every(failed => failed === 0);
    }
    const passed = text.match(/\b(\d+)\s+passed\b/i);
    return Boolean(passed && Number(passed[1]) > 0 && !/\b[1-9]\d*\s+failed\b/i.test(text));
  }
  if (kind === 'coverage') {
    return /(?:start of coverage report|all files\s+\|\s+\d)/i.test(text);
  }
  return true;
}

export const CLEAN_CANDIDATE_COMMANDS = [
  ['clone', 'git clone --quiet --no-local <source> <candidate>'],
  ['script-integrity', 'verify package verification scripts'],
  ['install', 'npm ci --ignore-scripts'],
  ['test', 'npm test'],
  ['coverage', 'npm run coverage'],
  ['drift', 'npm run skill:check-drift'],
  ['lint', 'npm run lint'],
  ['build', 'npm run build'],
  ['audit', 'npm audit --audit-level=high'],
  ['skill-check', 'npm run skill:check'],
  ['skill-verify', 'npm run skill:verify'],
  ['final-status', 'git status --porcelain --untracked-files=all'],
];

export function validateCleanCandidateEvidence(clean, candidateCommit, candidateTree) {
  if (!clean || clean.schema_version !== 1 || clean.status !== 'pass' || clean.exit_code !== 0 ||
      clean.isolated_checkout !== true || clean.candidate_commit !== candidateCommit ||
      clean.candidate_tree !== candidateTree || clean.isolated_commit !== candidateCommit ||
      clean.isolated_tree !== candidateTree || clean.source_status !== '' || clean.final_source_status !== '' ||
      !Array.isArray(clean.commands) || clean.commands.length !== CLEAN_CANDIDATE_COMMANDS.length) return false;
  for (let index = 0; index < CLEAN_CANDIDATE_COMMANDS.length; index++) {
    const record = clean.commands[index];
    const [expectedId, expectedCommand] = CLEAN_CANDIDATE_COMMANDS[index];
    const retainedBytes = Buffer.byteLength(record?.output || '');
    const started = Date.parse(record?.started_at);
    const finished = Date.parse(record?.finished_at);
    if (!record || record.id !== expectedId || record.command !== expectedCommand ||
        record.exit_code !== 0 || record.status !== 'pass' ||
        !Number.isFinite(started) || !Number.isFinite(finished) || finished < started ||
        typeof record.output !== 'string' || !Number.isInteger(record.output_bytes) ||
        record.output_bytes < retainedBytes || typeof record.truncated !== 'boolean' ||
        (!record.truncated && record.output_bytes !== retainedBytes)) return false;
  }
  const testRecord = clean.commands.find(record => record.id === 'test');
  const coverageRecord = clean.commands.find(record => record.id === 'coverage');
  return clean.commands.at(-1).output.trim() === '' &&
    hasConcreteVerificationOutput('test', testRecord?.output) &&
    hasConcreteVerificationOutput('coverage', coverageRecord?.output);
}

export const ROLLBACK_COMMANDS = [
  ['source-status', 'git status --porcelain --untracked-files=all'],
  ['clone', 'git clone --quiet --no-local <source> <rollback>'],
  ['isolated-commit', 'git rev-parse HEAD'],
  ['isolated-tree', 'git rev-parse HEAD^{tree}'],
  ['revert', 'git revert --no-commit <base>..HEAD'],
  ['rollback-tree', 'git write-tree'],
  ['package-manager', 'verify pre-provisioned rollback package manager'],
  ['rollback-commit', 'git commit <rollback snapshot>'],
  ['test', 'npm test'],
  ['final-source-status', 'git status --porcelain --untracked-files=all'],
];

export function validateRollbackEvidence(rollback, candidateCommit, candidateTree, baseCommit, baseTree) {
  if (!rollback || rollback.schema_version !== 1 || rollback.status !== 'pass' || rollback.exit_code !== 0 ||
      rollback.isolated_checkout !== true || rollback.candidate_commit !== candidateCommit ||
      rollback.candidate_tree !== candidateTree || rollback.isolated_commit !== candidateCommit ||
      rollback.isolated_tree !== candidateTree || rollback.base_commit !== baseCommit ||
      rollback.base_tree !== baseTree || rollback.rollback_tree !== baseTree ||
      rollback.source_status !== '' || rollback.final_source_status !== '' ||
      !Array.isArray(rollback.commands) || rollback.commands.length !== ROLLBACK_COMMANDS.length) return false;
  for (let index = 0; index < ROLLBACK_COMMANDS.length; index++) {
    const record = rollback.commands[index];
    const [expectedId, expectedCommand] = ROLLBACK_COMMANDS[index];
    const retainedBytes = Buffer.byteLength(record?.output || '');
    const started = Date.parse(record?.started_at);
    const finished = Date.parse(record?.finished_at);
    if (!record || record.id !== expectedId || record.command !== expectedCommand ||
        record.exit_code !== 0 || record.status !== 'pass' ||
        !Number.isFinite(started) || !Number.isFinite(finished) || finished < started ||
        typeof record.output !== 'string' || !Number.isInteger(record.output_bytes) ||
        record.output_bytes < retainedBytes || typeof record.truncated !== 'boolean' ||
        (!record.truncated && record.output_bytes !== retainedBytes)) return false;
  }
  return rollback.commands[0].output.trim() === '' &&
    rollback.commands[2].output.trim() === candidateCommit &&
    rollback.commands[3].output.trim() === candidateTree &&
    rollback.commands[5].output.trim() === baseTree &&
    rollback.commands[8].output.trim() !== '' &&
    rollback.commands[9].output.trim() === '';
}

// ============================================================================
// Blocker Parsing
// ============================================================================

/**
 * Parse blockers from review report content
 * @param {string|null|undefined} blockerContent
 * @returns {string[]}
 */
export function parseBlockers(blockerContent) {
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

    if (/^none(?:\.|\b)/i.test(trimmed) ||
        /^(?:no|none|无).*?(?:p0|p1|blockers?)/i.test(trimmed) ||
        /^#+\s*(?:P0|P1)(?:(?:\s*[/—–-]\s*|\s*\()(?:red\s*lines?|must\s*fix|must\s*fix\s*before\s*release)\)?)?\s*$/i.test(trimmed) ||
        trimmed.match(/^#\s+.*Blockers$/i)) {
      continue;
    }

    const severityFinding = /^(?:#{1,6}\s*|[-*+]\s*(?:\[[ xX]\]\s*)?|>\s*)?(?:\*\*)?\[?P[01]\]?(?:\*\*)?(?=\s*(?:[:：—–-]|\(|$))/i.test(trimmed);
    if (severityFinding) {
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

// ============================================================================
// YAML Result Parsing
// ============================================================================

/**
 * Parse result.yaml content into structured data
 * Handles both flat ("- P0: Description") and nested ("- priority: P0\ndescription: ...") formats
 * @param {string|null|undefined} yamlContent
 * @returns {object}
 */
export function parseYamlResult(yamlContent) {
  if (!yamlContent || typeof yamlContent !== 'string') {
    return {
      reviewer: null,
      profile: null,
      round: null,
      candidateCommit: null,
      candidateTree: null,
      reviewBackend: null,
      reviewModel: null,
      score: null,
      status: null,
      blockers: [],
      redlines: [],
      dimensions: {},
    };
  }

  const result = {
    reviewer: null,
    profile: null,
    round: null,
    candidateCommit: null,
    candidateTree: null,
    reviewBackend: null,
    reviewModel: null,
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
  let currentNestedObj = null;
  let currentItemIndent = -1;
  let nestedArrayKey = null;

  for (const line of lines) {
    const indent = line.match(/^\s*/)?.[0].length || 0;
    const trimmed = line.trim();

    if (!trimmed || trimmed.startsWith('#')) continue;

    // Array items
    if (trimmed.startsWith('- ')) {
      const item = trimmed.substring(2).trim();

      if (currentNestedObj && nestedArrayKey && indent > currentItemIndent) {
        currentNestedObj[nestedArrayKey].push(item);
        continue;
      }

      if (currentNestedObj && currentArray && indent <= currentItemIndent) {
        result[currentArray].push(currentNestedObj);
        currentNestedObj = null;
        nestedArrayKey = null;
      }

      if (currentArray && item) {
        if (currentArray === 'blockers' || currentArray === 'redlines') {
          const blockerMatch = item.match(/^(P[0-3]):\s*(.+)$/i);
          if (blockerMatch) {
            result[currentArray].push({
              priority: blockerMatch[1].toUpperCase(),
              text: blockerMatch[2],
            });
          } else if (item.includes(':')) {
            const nestedKv = item.match(/^(\w+):\s*(.+)$/);
            if (nestedKv) {
              currentNestedObj = { [nestedKv[1].trim().toLowerCase()]: nestedKv[2].trim() };
              currentItemIndent = indent;
            } else {
              result[currentArray].push(item);
            }
          } else {
            result[currentArray].push(item);
          }
        } else if (Array.isArray(result[currentArray])) {
          result[currentArray].push(item);
        }
      }
      continue;
    }

    if (currentNestedObj && currentArray && indent <= currentItemIndent) {
      result[currentArray].push(currentNestedObj);
      currentNestedObj = null;
      nestedArrayKey = null;
    }

    // Nested object continuation
    if (currentNestedObj && trimmed.includes(':')) {
      const colonIndex = trimmed.indexOf(':');
      const key = trimmed.substring(0, colonIndex).trim().toLowerCase();
      const value = trimmed.substring(colonIndex + 1).trim();
      if (key && value) {
        currentNestedObj[key] = value;
        continue;
      } else if (key && !value) {
        currentNestedObj[key] = [];
        nestedArrayKey = key;
        continue;
      }
    }

    // Key: value pairs
    const colonIndex = trimmed.indexOf(':');
    if (colonIndex > 0) {
      const key = trimmed.substring(0, colonIndex).trim().toLowerCase();
      const value = trimmed.substring(colonIndex + 1).trim();

      if (value === '' || value === '[]') {
        if (currentNestedObj && currentArray) {
          result[currentArray].push(currentNestedObj);
          currentNestedObj = null;
        }
        currentKey = key;
        currentArray = key;
        inArray = true;
        continue;
      }

      switch (key) {
        case 'reviewer':
          result.reviewer = value;
          break;
        case 'profile':
          result.profile = value;
          break;
        case 'round': {
          const roundMatch = value.match(/^(?:round-)?(\d+)$/i);
          if (roundMatch) result.round = parseInt(roundMatch[1], 10);
          break;
        }
        case 'candidate_commit':
          if (/^[0-9a-f]{40}$/i.test(value)) result.candidateCommit = value.toLowerCase();
          break;
        case 'candidate_tree':
          if (/^[0-9a-f]{40}$/i.test(value)) result.candidateTree = value.toLowerCase();
          break;
        case 'review_backend':
          if (/^(?:claude|codex)$/.test(value)) result.reviewBackend = value;
          break;
        case 'review_model':
          if (/^[A-Za-z0-9._:/-]{1,128}$/.test(value)) result.reviewModel = value;
          break;
        case 'score':
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
        case 'blockers':
        case 'redlines': {
          const inlineItems = value.match(/^\[(.*)\]$/)?.[1]
            ?.split(',')
            .map(item => item.trim().replace(/^['"]|['"]$/g, ''))
            .filter(Boolean) || [];
          result[key].push(...inlineItems);
          break;
        }
        default:
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

  if (currentNestedObj && currentArray) {
    result[currentArray].push(currentNestedObj);
  }

  return result;
}

export function validateResultYamlContract(yamlContent) {
  if (!yamlContent || typeof yamlContent !== 'string') {
    return { valid: false, error: 'result.yaml is empty' };
  }
  const required = new Map([
    ['reviewer', /^[a-z0-9-]+$/],
    ['profile', /^(?:quick|default|release-gate|full|agentic-release-gate)$/],
    ['round', /^[1-9]\d*$/],
    ['candidate_commit', /^[0-9a-f]{40}$/],
    ['candidate_tree', /^[0-9a-f]{40}$/],
    ['score', /^(?:100|[1-9]?\d)$/],
    ['status', /^(?:pass|fail)$/],
    ['review_backend', /^(?:claude|codex)$/],
    ['review_model', /^[A-Za-z0-9._:/-]{1,128}$/],
    ['blockers', /^(?:\[.*\])?$/],
    ['redlines', /^(?:\[.*\])?$/],
  ]);
  const topLevel = [];
  const seen = new Map();
  for (const line of yamlContent.split('\n')) {
    if (!line || /^\s/.test(line) || line.trimStart().startsWith('#')) continue;
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_-]*):(?:\s*(.*))?$/);
    if (!match) return { valid: false, error: 'invalid top-level YAML entry' };
    const key = match[1];
    if (!required.has(key)) return { valid: false, error: `unknown top-level field: ${key}` };
    topLevel.push(key);
    if (seen.has(key)) return { valid: false, error: `duplicate top-level field: ${key}` };
    seen.set(key, match[2] ?? '');
  }
  const requiredKeys = [...required.keys()];
  if (topLevel.slice(0, requiredKeys.length).some((key, index) => key !== requiredKeys[index])) {
    return { valid: false, error: 'required top-level fields are out of order' };
  }
  for (const [key, pattern] of required) {
    if (!seen.has(key)) return { valid: false, error: `missing top-level field: ${key}` };
    if (!pattern.test(seen.get(key))) return { valid: false, error: `invalid top-level field: ${key}` };
  }
  const parsed = parseYamlResult(yamlContent);
  const expectedStatus = parsed.score >= 90 && parsed.blockers.length === 0 && parsed.redlines.length === 0
    ? 'pass'
    : 'fail';
  if (parsed.status !== expectedStatus) {
    return { valid: false, error: `status must be ${expectedStatus} for the declared score and findings` };
  }
  return { valid: true, error: null };
}

export function strictAutomatedChecksPassed(autoChecks, evidenceValidationPassed) {
  return Boolean(autoChecks) && autoChecks.testGate?.status === 'pass' &&
    autoChecks.typecheckGate?.status === 'pass' && autoChecks.buildGate?.status === 'pass' &&
    autoChecks.lintGate?.status === 'pass' && autoChecks.auditGate?.status === 'pass' &&
    autoChecks.coverageGate?.status === 'pass' && autoChecks.e2eGate?.status === 'pass' &&
    autoChecks.secrets?.status === 'pass' && autoChecks.circularDeps?.status === 'pass' &&
    evidenceValidationPassed;
}

// ============================================================================
// Change Scale Detection
// ============================================================================

/**
 * Detect change scale from file and line counts
 * @param {string[]} changedFiles
 * @param {number} addedLines
 * @param {number} deletedLines
 * @returns {{ scale: string, files: number, additions: number, deletions: number, total: number, suggestedProfile: string, reason: string, requiresAgentic: boolean }}
 */
export function detectChangeScale(changedFiles = [], addedLines = 0, deletedLines = 0) {
  const fileCount = changedFiles.length;
  const totalChanges = addedLines + deletedLines;

  let scale = 'micro';
  let reason = '';

  if (fileCount === 0 && totalChanges === 0) {
    scale = 'none';
    reason = 'No changes detected';
  } else if (fileCount >= 50 || totalChanges >= 2000) {
    scale = 'xlarge';
    reason = 'Very large change (50+ files or 2000+ lines)';
  } else if (fileCount >= 21 || totalChanges >= 500) {
    scale = 'large';
    reason = 'Large change (21-50 files or 500-2000 lines)';
  } else if (fileCount >= 6 || totalChanges >= 100) {
    scale = 'medium';
    reason = 'Medium change (6-20 files or 100-500 lines)';
  } else if (fileCount >= 3 || totalChanges >= 50) {
    scale = 'small';
    reason = 'Small change (3-5 files or 50-100 lines)';
  } else {
    scale = 'micro';
    reason = 'Micro change (1-2 files and <50 lines)';
  }

  const profileMap = {
    micro: 'quick',
    small: 'quick',
    medium: 'default',
    large: 'release-gate',
    xlarge: 'agentic-release-gate',
    none: 'quick',
  };

  return {
    scale,
    files: fileCount,
    additions: addedLines,
    deletions: deletedLines,
    total: totalChanges,
    suggestedProfile: profileMap[scale],
    reason,
    requiresAgentic: scale === 'xlarge',
  };
}

export function calculateReviewerTimeout(baseTimeoutMs, scale, reasoningEffort = null) {
  const scaleMultipliers = {
    none: 0.5, micro: 0.5, small: 0.75, medium: 1, large: 1.5, xlarge: 2,
  };
  const effortMultipliers = {
    minimal: 0.75, low: 1, medium: 1, high: 1.25, xhigh: 1.5, max: 2,
  };
  const scaleMultiplier = scaleMultipliers[scale] ?? 1;
  const effortMultiplier = effortMultipliers[reasoningEffort] ?? 1;
  return {
    timeoutMs: Math.round(baseTimeoutMs * scaleMultiplier * effortMultiplier),
    scaleMultiplier,
    effortMultiplier,
  };
}

export function matchesTriggerConditions(changedFiles = [], diff = '', conditions = {}) {
  if (conditions.always === true) return true;
  const filePatterns = conditions.files || [];
  const contentPatterns = conditions.patterns || [];
  const fileMatched = filePatterns.some(pattern => {
    const escaped = pattern
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\?/g, '::QUESTION::')
      .replace(/\*\*\//g, '::GLOBSTAR_DIR::')
      .replace(/\*\*/g, '::GLOBSTAR::')
      .replace(/\*/g, '[^/]*')
      .replace(/::GLOBSTAR_DIR::/g, '(?:.*/)?')
      .replace(/::GLOBSTAR::/g, '.*')
      .replace(/::QUESTION::/g, '.');
    const regex = new RegExp(`^${escaped}$`);
    return changedFiles.some(file => regex.test(file));
  });
  const normalizedDiff = String(diff).toLowerCase();
  const contentMatched = contentPatterns.some(pattern => normalizedDiff.includes(String(pattern).toLowerCase()));
  return fileMatched || contentMatched;
}

/**
 * Select the reviewers required for a profile and candidate diff.
 * Conditional reviewers must declare an explicit trigger contract.
 */
export function selectReviewers(profile, changedFiles = [], diff = '') {
  const residentReviewers = profile?.resident_reviewers || [];
  const conditionalReviewers = profile?.conditional_reviewers || [];
  const adversarialReviewers = profile?.adversarial_reviewers || [];
  const triggerConditions = profile?.trigger_conditions || {};
  const triggeredConditional = [];

  for (const reviewer of conditionalReviewers) {
    const conditions = triggerConditions[reviewer];
    const hasTrigger = conditions && (
      conditions.always === true
      || (Array.isArray(conditions.files) && conditions.files.length > 0)
      || (Array.isArray(conditions.patterns) && conditions.patterns.length > 0)
    );
    if (!hasTrigger) {
      throw new Error(
        `Profile ${profile?.name || '<unknown>'} conditional reviewer ${reviewer} is missing trigger_conditions`,
      );
    }
    if (matchesTriggerConditions(changedFiles, diff, conditions)) {
      triggeredConditional.push(reviewer);
    }
  }

  const requiredAdversarial = profile?.gate?.require_adversarial
    ? adversarialReviewers
    : [];
  return {
    reviewers: [...new Set([
      ...residentReviewers,
      ...triggeredConditional,
      ...requiredAdversarial,
    ])],
    triggeredConditional,
  };
}

// ============================================================================
// YAML Profile Parsing
// ============================================================================

/**
 * Parse YAML profile configuration
 * @param {string} content
 * @param {string} name
 * @returns {object}
 */
export function parseYamlProfile(content, name) {
  const profile = {
    name,
    description: '',
    estimated_time: '',
    resident_reviewers: [],
    conditional_reviewers: [],
    adversarial_reviewers: [],
    trigger_conditions: {},
    gate: {
      min_score: 90,
      fail_on_redlines: true,
      fail_on_p0_p1_blockers: true,
      require_adversarial: false,
    },
    output: {
      verbose: false,
      include_evidence: false,
    },
  };

  const lines = content.split('\n');
  let currentSection = '';
  let currentArrayKey = '';
  let currentTriggerKey = '';
  let inCodeBlock = false;
  let codeBlockContent = '';

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    // Code blocks
    if (trimmed.startsWith('```')) {
      if (inCodeBlock) {
        inCodeBlock = false;
        parseYamlCodeBlock(codeBlockContent, profile, currentArrayKey, currentTriggerKey);
        codeBlockContent = '';
      } else {
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

    if (!trimmed || trimmed.startsWith('#')) continue;

    // Section headers
    const sectionMatch = trimmed.match(/^#{2,3}\s+(.+)$/);
    if (sectionMatch) {
      currentSection = sectionMatch[1].trim().toLowerCase();
      continue;
    }

    // Skip checkboxes
    if (trimmed.startsWith('- [') || trimmed.startsWith('- [ ]')) continue;

    // Key-value pairs
    if (trimmed.includes(':')) {
      const colonIdx = trimmed.indexOf(':');
      const key = trimmed.slice(0, colonIdx).trim();
      let value = trimmed.slice(colonIdx + 1).trim();
      value = value.split('#')[0].trim();

      // Array keys
      if (key === 'resident_reviewers') {
        currentArrayKey = 'resident_reviewers';
        if (value === '[]') profile.resident_reviewers = [];
      } else if (key === 'conditional_reviewers') {
        currentArrayKey = 'conditional_reviewers';
        if (value === '[]') profile.conditional_reviewers = [];
      } else if (key === 'adversarial_reviewers') {
        currentArrayKey = 'adversarial_reviewers';
        if (value === '[]') profile.adversarial_reviewers = [];
      } else if (key === 'trigger_conditions') {
        currentArrayKey = '';
      }

      if (currentSection === 'trigger conditions') {
        if (profile.conditional_reviewers.includes(key)) {
          currentTriggerKey = key;
          if (!profile.trigger_conditions[key]) {
            profile.trigger_conditions[key] = { files: [], patterns: [] };
          }
        }
      }

      // Scalar values
      if (key === 'profile' || (key === 'name' && !profile.name)) profile.name = value;
      else if (key === 'description') profile.description = value;
      else if (key === 'estimated_time') profile.estimated_time = value;
      else if (key === 'min_score') profile.gate.min_score = parseInt(value, 10) || 90;
      else if (key === 'fail_on_redlines') profile.gate.fail_on_redlines = value === 'true';
      else if (key === 'fail_on_p0_p1_blockers') profile.gate.fail_on_p0_p1_blockers = value === 'true';
      else if (key === 'require_adversarial') profile.gate.require_adversarial = value === 'true';
      else if (key === 'verbose') profile.output.verbose = value === 'true';
      else if (key === 'include_evidence') profile.output.include_evidence = value === 'true';
    } else if (trimmed.startsWith('- ')) {
      let item = trimmed.slice(2).trim().split('#')[0].trim();

      if (currentArrayKey === 'resident_reviewers' && item && item !== '[]') {
        profile.resident_reviewers.push(item);
      } else if (currentArrayKey === 'conditional_reviewers' && item && item !== '[]') {
        profile.conditional_reviewers.push(item);
      } else if (currentArrayKey === 'adversarial_reviewers' && item && item !== '[]') {
        profile.adversarial_reviewers.push(item);
      }
    }
  }

  return profile;
}

/**
 * Parse YAML content inside code blocks in profile files
 */
function parseYamlCodeBlock(yamlContent, profile, defaultArrayKey, defaultTriggerKey) {
  if (!yamlContent) return;

  const lines = yamlContent.split('\n');
  let currentArrayKey = defaultArrayKey || '';
  let currentTriggerKey = defaultTriggerKey || '';

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    if (trimmed.includes(':')) {
      const colonIdx = trimmed.indexOf(':');
      const key = trimmed.slice(0, colonIdx).trim();
      let value = trimmed.slice(colonIdx + 1).trim().split('#')[0].trim();

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
        const files = value.replace(/^\[|\]$/g, '').split(',').map(s => s.trim().replace(/^['"]|['"]$/g, ''));
        profile.trigger_conditions[currentTriggerKey].files = files;
      } else if (key === 'patterns' && currentTriggerKey) {
        const patterns = value.replace(/^\[|\]$/g, '').split(',').map(s => s.trim().replace(/^['"]|['"]$/g, ''));
        profile.trigger_conditions[currentTriggerKey].patterns = patterns;
      } else if (key === 'always' && currentTriggerKey) {
        profile.trigger_conditions[currentTriggerKey].always = value === 'true';
      } else if (profile.conditional_reviewers.includes(key)) {
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

    const listMatch = trimmed.match(/^-\s+(.+)$/);
    if (listMatch) {
      let item = listMatch[1].trim().replace(/\s*#.*$/, '').trim().replace(/^['"]|['"]$/g, '');

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
