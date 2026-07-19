import { execFileSync } from 'node:child_process';

import { selectReviewers } from '../../lib/review-utils.mjs';
import { PROFILES, loadYamlProfile } from './config.mjs';

export function selectGateReviewers({
  skillDir, projectRoot, profile, resolvedDiffBase, excludeReviewers,
  singleReviewer, userSpecifiedProfile, log,
}) {
  if (['release-gate', 'full', 'agentic-release-gate'].includes(profile) && excludeReviewers.length > 0) {
    throw new Error('Strict profiles do not allow --exclude-reviewer');
  }

  let reviewers = [];
  let profileConfig = PROFILES[profile] || PROFILES['release-gate'];
  const yamlProfile = loadYamlProfile(skillDir, profile);
  if (yamlProfile) {
    log.info(`Loaded YAML profile: ${yamlProfile.name}`);
    log.info(` Resident reviewers: ${JSON.stringify(yamlProfile.resident_reviewers)}`);
    log.info(` Conditional reviewers: ${JSON.stringify(yamlProfile.conditional_reviewers)}`);
    const gitOutput = execFileSync('git', ['diff', '--name-only', resolvedDiffBase], {
      encoding: 'utf8', cwd: projectRoot, timeout: 10000,
    });
    const untracked = execFileSync('git', ['ls-files', '--others', '--exclude-standard'], {
      encoding: 'utf8', cwd: projectRoot, timeout: 10000,
    });
    const changedFiles = [...new Set(`${gitOutput}\n${untracked}`.split('\n').filter(file => file.trim()))];
    const diffContent = execFileSync('git', ['diff', resolvedDiffBase], {
      encoding: 'utf8', cwd: projectRoot, timeout: 10000, maxBuffer: 10 * 1024 * 1024,
    });
    let selection;
    try {
      selection = selectReviewers(yamlProfile, changedFiles, diffContent);
    } catch (error) {
      throw new Error(`Invalid reviewer configuration: ${error.message}`);
    }
    reviewers = selection.reviewers;
    if (selection.triggeredConditional.length > 0) {
      log.info(`Conditional reviewers triggered: ${selection.triggeredConditional.join(', ')}`);
    }
    if (yamlProfile.gate?.require_adversarial && yamlProfile.adversarial_reviewers?.length > 0) {
      log.info(`Adversarial reviewers (required): ${JSON.stringify(yamlProfile.adversarial_reviewers)}`);
    }
    profileConfig = {
      name: yamlProfile.name,
      description: yamlProfile.description,
      reviewers,
      gate: yamlProfile.gate,
    };
  } else if (userSpecifiedProfile) {
    throw new Error(`Profile not found: ${profile}`);
  } else {
    reviewers = profileConfig.reviewers;
  }

  reviewers = reviewers.filter(reviewer => !excludeReviewers.includes(reviewer));
  if (singleReviewer) reviewers = [singleReviewer];
  reviewers = [...new Set(reviewers)];
  if (reviewers.length === 0) throw new Error('GATE BLOCKED - no reviewers selected');
  return { reviewers, profileConfig };
}
