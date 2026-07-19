import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { log } from './constants.mjs';
import { parseYamlProfile } from '../../lib/review-utils.mjs';
import { VERIFICATION_COMMAND_NAMES } from './verification-policy.mjs';

const SECTION_KEYS = Object.freeze({
  verification: new Set(VERIFICATION_COMMAND_NAMES),
  gate: new Set([
    'min_score', 'fail_on_redlines', 'fail_on_p0_p1_blockers', 'require_all_reviewers', 'max_rounds',
  ]),
  execution: new Set(['start_delay_ms', 'timeout_ms', 'retry_max']),
});

function configurationError(message) {
  const error = new Error(message);
  error.exitCode = 4;
  return error;
}

// Reviewer profiles (frozen to prevent accidental mutation)
export const PROFILES = Object.freeze({
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
});

/**
 * Validate profile threshold consistency
 * @param {string} profileName - Profile name
 * @param {object} profileConfig - Profile config
 */
function validateProfileThreshold(profileName, profileConfig) {
  const declaredMinScore = profileConfig?.gate?.min_score;
  const runtimeMinScore = 90;
  if (declaredMinScore && Number(declaredMinScore) !== runtimeMinScore) {
    log.warn(`Profile ${profileName} declares min_score ${declaredMinScore}, runtime enforces ${runtimeMinScore}`);
  }
}

/**
 * Load config from YAML file
 * @param {string} configFile - Path to config file
 * @returns {object} Config object
 */
export function loadConfig(configFile) {
  if (!existsSync(configFile)) return { verification: {}, gate: {}, execution: {} };
  let content;
  try {
    content = readFileSync(configFile, 'utf-8');
  } catch (error) {
    throw configurationError(`Could not load config: ${error.message}`);
  }
  const config = { verification: {}, gate: {}, execution: {} };
  let currentSection = '';
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const topLevel = !/^\s/.test(line);
    const sectionMatch = topLevel && trimmed.match(/^([A-Za-z_][\w-]*):\s*$/);
    if (sectionMatch) {
      currentSection = sectionMatch[1];
      continue;
    }
    const property = trimmed.match(/^([A-Za-z_][\w-]*):\s*(.+)$/);
    if (!property) continue;
    const [, key, rawValue] = property;
    const cleanValue = rawValue.replace(/\s+#.*$/, '').replace(/^["']|["']$/g, '').trim();
    if (topLevel) {
      currentSection = '';
      config[key] = cleanValue;
      continue;
    }
    const allowed = SECTION_KEYS[currentSection];
    if (!allowed) continue;
    if (!allowed.has(key)) throw configurationError(`unknown ${currentSection} config key: ${key}`);
    config[currentSection][key] = cleanValue;
  }
  validateProfileThreshold(config.profile || 'default', config);
  return config;
}

/**
 * Load YAML profile configuration
 * @param {string} skillDir - Skill directory
 * @param {string} profileName - Profile name
 * @returns {object|null} Profile config or null
 */
export function loadYamlProfile(skillDir, profileName) {
  const profilePath = join(skillDir, 'profiles', `${profileName}.yaml`);
  if (!existsSync(profilePath)) return null;
  try {
    const profile = parseYamlProfile(readFileSync(profilePath, 'utf-8'), profileName);
    if (profile) validateProfileThreshold(profileName, profile);
    return profile;
  } catch (error) {
    log.warn(`Could not load profile ${profileName}: ${error.message}`);
    return null;
  }
}

/**
 * Load reviewer definition
 * @param {string} skillDir - Skill directory
 * @param {string} name - Reviewer name
 * @returns {string|null} Reviewer content or null
 */
export function loadReviewer(skillDir, name) {
  const path = join(skillDir, 'reviewers', `${name}.md`);
  if (!existsSync(path)) return null;
  return readFileSync(path, 'utf-8');
}
