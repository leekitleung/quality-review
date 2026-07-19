import { join } from 'node:path';

import { checkMissingEvidenceOutput } from '../../lib/evidence-utils.mjs';
import { validateReviewerEvidenceBlocks } from '../../lib/reviewer-evidence-contract.mjs';
import { parseYamlResult, validateResultYamlContract } from '../../lib/review-utils.mjs';
import { readContainedFile } from '../../lib/security-utils.mjs';

export async function validateReviewerPacket({
  reviewerDir, reviewer, expectedProfile, expectedRound, currentIdentity,
  expectedBackend, expectedModel, automatedChecks,
}) {
  const requiredFiles = ['result.yaml', 'score.md', 'blockers.md', 'improvement-list.md'];
  try {
    const contents = await Promise.all(requiredFiles.map(file =>
      readContainedFile(reviewerDir, join(reviewerDir, file), 'utf8').catch(error => ({ error, file }))
    ));
    const missingFiles = contents.filter(value => typeof value !== 'string').map(value => value.file);
    if (missingFiles.length > 0) return { valid: false, reason: `missing: ${missingFiles.join(', ')}` };
    const contract = validateResultYamlContract(contents[0]);
    if (!contract.valid) return { valid: false, reason: contract.error };

    const parsed = parseYamlResult(contents[0]);
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

    const packetEvidence = `${contents[1]}\n${contents[2]}`;
    if (parsed.status === 'pass') {
      const evidenceValidation = validateReviewerEvidenceBlocks(packetEvidence, automatedChecks);
      if (!evidenceValidation.valid) mismatches.push(evidenceValidation.reason);
      if (checkMissingEvidenceOutput(packetEvidence).length > 0) {
        mismatches.push('unsupported success claim in passing packet');
      }
    }

    const emptyFiles = requiredFiles.filter((_file, index) => contents[index].trim() === '');
    if (emptyFiles.length > 0) mismatches.push(`empty=${emptyFiles.join(',')}`);
    if (mismatches.length > 0) return { valid: false, reason: mismatches.join('; ') };
    return { valid: true, score: parsed.score, status: parsed.status };
  } catch (error) {
    return { valid: false, reason: `parse error: ${error.message}` };
  }
}
