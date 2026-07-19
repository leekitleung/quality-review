import { detectChangeScale, selectReviewers } from '../../lib/review-utils.mjs';

function detectEvidenceChangeScale(evidence) {
  const changedFiles = evidence.git.changedFiles || [];
  const addedLines = (evidence.git.diff?.match(/^\+[^+]/gm) || []).length;
  const deletedLines = (evidence.git.diff?.match(/^-[^-]/gm) || []).length;
  const canonical = detectChangeScale(changedFiles, addedLines, deletedLines);
  return { ...canonical, fileCount: canonical.files, totalLines: canonical.total };
}

export function resolveRunnerReviewPlan(profileConfig, evidence, reviewerOverride = null) {
  const scaleInfo = evidence.scale?.scale
    ? {
        ...evidence.scale,
        fileCount: evidence.scale.fileCount ?? evidence.scale.files ?? evidence.git.changedFiles?.length ?? 0,
        totalLines: evidence.scale.totalLines ?? evidence.scale.total ?? 0,
      }
    : detectEvidenceChangeScale(evidence);
  evidence.scale = scaleInfo;

  const gateReviewers = Array.isArray(evidence.reviewers) ? evidence.reviewers : null;
  const selectedReviewers = gateReviewers || selectReviewers(
    profileConfig, evidence.git.changedFiles || [], evidence.git.diff || '',
  ).reviewers;
  const allReviewers = reviewerOverride ? [reviewerOverride] : selectedReviewers;
  const conditionalReviewers = new Set(profileConfig.conditional_reviewers || []);
  return {
    scaleInfo,
    allReviewers,
    triggeredConditional: allReviewers.filter(name => conditionalReviewers.has(name)),
  };
}
