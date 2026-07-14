import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { log } from './constants.mjs';
import { parseYamlProfile } from '../../lib/review-utils.mjs';

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
  try {
    if (existsSync(configFile)) {
      const content = readFileSync(configFile, 'utf-8');
      const config = {
        verification: {},
        gate: {},
      };
      const lines = content.split('\n');
      let currentSection = '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;

        if (trimmed.startsWith('verification:') || trimmed.startsWith('gate:')) {
          currentSection = trimmed.replace(':', '').trim();
          continue;
        }

        if (trimmed && trimmed.includes(':')) {
          const [key, ...valueParts] = trimmed.split(':');
          const value = valueParts.join(':').trim();

          if (value) {
            const cleanValue = value.replace(/^["']|["']$/g, '');

            if (currentSection === 'verification' || ['test', 'build', 'lint', 'typecheck', 'e2e', 'audit'].includes(key.trim())) {
              config.verification[key.trim()] = cleanValue;
            } else if (currentSection === 'gate' || ['min_score', 'fail_on_redlines', 'fail_on_p0_p1_blockers'].includes(key.trim())) {
              config.gate[key.trim()] = cleanValue;
            } else {
              config[key.trim()] = cleanValue;
            }
          }
        }
      }
      // Validate threshold consistency
      const configProfile = config.profile || 'default';
      validateProfileThreshold(configProfile, config);
      return config;
    }
  } catch (e) {
    log.warn(`Could not load config: ${e.message}`);
  }
  return { verification: {}, gate: {} };
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
