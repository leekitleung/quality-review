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

export const CLEAN_CANDIDATE_COMMAND_IDS = [
  'clone', 'install', 'test', 'coverage', 'drift', 'lint', 'build', 'audit', 'skill-check',
  'skill-verify', 'final-status',
];

export function validateCleanCandidateEvidence(clean, candidateCommit, candidateTree) {
  if (!clean || clean.schema_version !== 1 || clean.status !== 'pass' || clean.exit_code !== 0 ||
      clean.isolated_checkout !== true || clean.candidate_commit !== candidateCommit ||
      clean.candidate_tree !== candidateTree || clean.source_status !== '' ||
      !Array.isArray(clean.commands) || clean.commands.length !== CLEAN_CANDIDATE_COMMAND_IDS.length) return false;
  for (let index = 0; index < CLEAN_CANDIDATE_COMMAND_IDS.length; index++) {
    const record = clean.commands[index];
    const retainedBytes = Buffer.byteLength(record?.output || '');
    const started = Date.parse(record?.started_at);
    const finished = Date.parse(record?.finished_at);
    if (!record || record.id !== CLEAN_CANDIDATE_COMMAND_IDS[index] ||
        typeof record.command !== 'string' || !record.command || record.exit_code !== 0 || record.status !== 'pass' ||
        !Number.isFinite(started) || !Number.isFinite(finished) || finished < started ||
        typeof record.output !== 'string' || !Number.isInteger(record.output_bytes) ||
        record.output_bytes < retainedBytes || typeof record.truncated !== 'boolean' ||
        (!record.truncated && record.output_bytes !== retainedBytes)) return false;
  }
  return clean.commands.at(-1).output.trim() === '';
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
        /^#+\s*(?:P0|P1)\s*$/i.test(trimmed) ||
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

export function matchesTriggerConditions(changedFiles = [], diff = '', conditions = {}) {
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
        if (['terminal-veteran', 'native-designer', 'data-security', 'zero-doc-user'].includes(key)) {
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
