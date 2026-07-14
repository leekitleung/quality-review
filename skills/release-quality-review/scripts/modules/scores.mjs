import { existsSync } from 'fs';
import { join } from 'path';
import { log } from './constants.mjs';
import { readContainedFileSync } from '../../lib/security-utils.mjs';
import { parseScore, parseBlockers, parseYamlResult } from '../../lib/review-utils.mjs';

/**
 * Validate reviewer identity by checking if reviewer definition exists
 * @param {string} skillDir - Skill directory
 * @param {string} reviewer - Reviewer name
 * @returns {object} Validation result { valid, error }
 */
export function validateReviewerIdentity(skillDir, reviewer) {
  const reviewerPath = join(skillDir, 'reviewers', `${reviewer}.md`);
  if (!existsSync(reviewerPath)) {
    return { valid: false, error: `Unknown reviewer: ${reviewer}` };
  }
  return { valid: true };
}

/**
 * Load existing scores for reviewers in a round
 * @param {string} roundDir - Round directory
 * @param {string[]} reviewers - List of reviewers
 * @param {string} expectedCandidateCommit - Expected candidate commit
 * @param {string} expectedCandidateTree - Expected candidate tree
 * @param {string} profile - Profile name
 * @param {number} roundNumber - Round number
 * @param {function} validateReviewerIdentity - Reviewer validator
 * @returns {object} Results map keyed by reviewer name
 */
export function loadExistingScores(roundDir, reviewers, expectedCandidateCommit, expectedCandidateTree, profile, roundNumber, validateReviewerIdentity) {
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
    let status = null;
    let declaredReviewer = null;
    let declaredProfile = null;
    let declaredRound = null;
    let declaredCandidateCommit = null;
    let declaredCandidateTree = null;
    let packetError = null;

    // Try result.yaml first (if exists)
    if (existsSync(resultYamlPath)) {
      try {
        const yamlContent = readContainedFileSync(roundDir, resultYamlPath, 'utf-8');
        const yamlResult = parseYamlResult(yamlContent);

        if (yamlResult.score !== null) {
          score = yamlResult.score;
          scoreSource = 'result.yaml';
        }
        status = yamlResult.status;
        declaredReviewer = yamlResult.reviewer;
        declaredProfile = yamlResult.profile;
        declaredRound = yamlResult.round;
        declaredCandidateCommit = yamlResult.candidateCommit;
        declaredCandidateTree = yamlResult.candidateTree;

        const resultBlockers = yamlResult.blockers.map(b => {
          if (typeof b === 'string') return b;
          // Preserve all blocker object formats
          const priority = b.priority || b.severity || b.level || 'P?';
          const text = b.text || b.description || b.message || b.content || JSON.stringify(b);
          return `${priority}: ${text}`;
        });
        if (resultBlockers.length > 0) {
          blockers = resultBlockers;
        }

        // Merge redlines into blockers (they carry veto power)
        if (yamlResult.redlines.length > 0) {
          const redlineBlockers = yamlResult.redlines.map(b => {
            if (typeof b === 'string') return b;
            const priority = b.priority || b.severity || b.level || 'P0';
            const text = b.text || b.description || b.message || b.content || JSON.stringify(b);
            return `${priority}: ${text}`;
          });
          blockers = [...blockers, ...redlineBlockers];
        }

        hasReport = true;
      } catch (e) {
        packetError = `Invalid result.yaml: ${e.message}`;
      }
    }

    // Fall back to score.md for score (if result.yaml didn't have one)
    if (existsSync(scorePath)) {
      try {
        const content = readContainedFileSync(roundDir, scorePath, 'utf-8');
        const parsedScore = parseScore(content);
        if (score === null && parsedScore !== null) {
          score = parsedScore;
          scoreSource = 'score.md';
        } else if (score !== null && parsedScore !== null && parsedScore !== score) {
          packetError = `Score mismatch: result.yaml=${score}, score.md=${parsedScore}`;
        }

        const blockerMatch = content.match(/^##\s+Blockers?\s*$\n([\s\S]*?)(?=^##?\s|(?![\s\S]))/im);
        if (blockerMatch) {
          blockers.push(...parseBlockers(blockerMatch[1]));
        }

        hasReport = true;
      } catch (e) {
        packetError = `Invalid score.md: ${e.message}`;
      }
    }

    // Load blockers.md independently
    if (existsSync(blockerPath)) {
      try {
        const blockerContent = readContainedFileSync(roundDir, blockerPath, 'utf-8');
        blockers.push(...parseBlockers(blockerContent));
        hasReport = true;
      } catch (e) {
        packetError = `Invalid blockers.md: ${e.message}`;
      }
    }

    // Load improvements
    if (existsSync(improvementPath)) {
      try {
        improvements = readContainedFileSync(roundDir, improvementPath, 'utf-8');
        hasReport = true;
      } catch (e) {
        packetError = `Invalid improvement-list.md: ${e.message}`;
      }
    }

    // Validate reviewer identity
    const validation = validateReviewerIdentity(reviewer, profile);
    const requiredFiles = [resultYamlPath, scorePath, blockerPath, improvementPath];
    const packetPresent = requiredFiles.some(existsSync);
    if (packetPresent && !requiredFiles.every(existsSync)) packetError = 'Incomplete reviewer packet: four required files are mandatory';
    if (packetPresent && declaredReviewer !== reviewer) packetError = `Reviewer identity mismatch: expected ${reviewer}, got ${declaredReviewer || 'missing'}`;
    if (packetPresent && declaredProfile !== profile) packetError = `Profile mismatch: expected ${profile}, got ${declaredProfile || 'missing'}`;
    if (packetPresent && declaredRound !== roundNumber) packetError = `Round mismatch: expected ${roundNumber}, got ${declaredRound ?? 'missing'}`;
    if (packetPresent && declaredCandidateCommit !== expectedCandidateCommit) packetError = `Candidate commit mismatch: expected ${expectedCandidateCommit}, got ${declaredCandidateCommit || 'missing'}`;
    if (packetPresent && declaredCandidateTree !== expectedCandidateTree) packetError = `Candidate tree mismatch: expected ${expectedCandidateTree}, got ${declaredCandidateTree || 'missing'}`;
    if (packetPresent && !['pass', 'fail'].includes(String(status || '').toLowerCase())) packetError = 'result.yaml status must be pass or fail';
    blockers = [...new Set(blockers.map(item => typeof item === 'string' ? item : JSON.stringify(item)))];

    results[reviewer] = {
      score,
      scoreSource,
      status,
      hasReport,
      blockers,
      improvements,
      isValidReviewer: validation.valid && !packetError,
      validationError: packetError || validation.error,
    };
  }

  return results;
}

/**
 * Check if a reviewer packet passed the gate
 * @param {object} result - Reviewer result
 * @param {number} minScore - Minimum score threshold (default: 90)
 * @returns {boolean} Whether packet passed
 */
export function reviewerPacketPassed(result, minScore = 90) {
  return result?.isValidReviewer === true &&
    result.score !== null &&
    result.score >= minScore &&
    String(result.status || '').toLowerCase() === 'pass' &&
    (result.blockers?.length || 0) === 0;
}
