import { existsSync } from 'fs';
import { join } from 'path';
import { log } from './constants.mjs';
import { readContainedFileSync, writeContainedFileSync } from '../../lib/security-utils.mjs';
import { redactSensitiveText } from '../../lib/security-utils.mjs';
import { reviewerPacketPassed } from './scores.mjs';

function findReviewerGateFailures(scores, reviewerPacketPassed_) {
  return Object.entries(scores || {})
    .filter(([, result]) => !reviewerPacketPassed_(result))
    .map(([reviewer, result]) => ({
      reviewer,
      score: result?.score ?? 'N/A',
      status: result?.status || 'missing',
      blockers: result?.blockers?.length || 0,
    }));
}

function assertFinalReportEligible(scores, reviewerPacketPassed_) {
  const failures = findReviewerGateFailures(scores, reviewerPacketPassed_);
  if (failures.length > 0) {
    const details = failures
      .map(failure => `${failure.reviewer}=${failure.score}/100 (${failure.status}, blockers=${failure.blockers})`)
      .join(', ');
    throw new Error(`Cannot generate release-approved report: reviewer gate failed: ${details}`);
  }
}

/**
 * Generate summary report for a round
 * @param {string} roundDir - Round directory
 * @param {string} profile - Profile name
 * @param {number} roundNumber - Round number
 * @param {object} scores - Reviewer scores object
 * @param {boolean} allPassed - Whether all reviewers passed
 * @param {object|null} evidence - Evidence object
 * @param {function} reviewerPacketPassed_ - Optional override for reviewerPacketPassed
 * @returns {boolean} Whether all passed
 */
export function generateSummary(roundDir, profile, roundNumber, scores, allPassed, evidence = null, reviewerPacketPassed_ = reviewerPacketPassed) {
  const reportPath = join(roundDir, 'summary.md');
  const timestamp = new Date().toISOString();
  // Never trust a caller-provided pass flag: summaries are evidence artifacts,
  // so their verdict must agree with every reviewer packet.
  const reviewerResults = Object.values(scores || {});
  const computedAllPassed = reviewerResults.length > 0 &&
    reviewerResults.every(result => reviewerPacketPassed_(result));
  const effectiveAllPassed = Boolean(allPassed) && computedAllPassed;

  let content = `# Quality Review Summary - Round ${roundNumber}\n\n`;
  content += `**Profile:** ${profile}\n`;
  content += `**Generated:** ${timestamp}\n`;

  if (evidence) {
    content += `**Git:** ${evidence.git?.branch} @ ${evidence.git?.commit}\n`;
  }
  content += `**Final arbitration evidence:** \`evidence/final-arbitration.json\`\n`;

  if (evidence && evidence.automatedChecks) {
    const ac = evidence.automatedChecks;
    content += `## Automated Gate Checks\n\n`;
    content += `| Check | Status | Details |\n`;
    content += `|-------|--------|--------|\n`;

    const testIcon = ac.testGate?.status === 'pass' ? '✅' : '❌';
    content += `| test | ${testIcon} ${ac.testGate?.status} | ${ac.testGate?.status === 'pass' ? 'Passed' : 'See evidence'} |\n`;

    const typeIcon = ac.typecheckGate?.status === 'pass' ? '✅' : '❌';
    content += `| typecheck | ${typeIcon} ${ac.typecheckGate?.status} | ${ac.typecheckGate?.status === 'pass' ? 'Passed' : 'See evidence'} |\n`;

    const buildIcon = ac.buildGate?.status === 'pass' ? '✅' : '❌';
    content += `| build | ${buildIcon} ${ac.buildGate?.status || 'unknown'} | ${ac.buildGate?.status === 'pass' ? 'Passed' : 'See evidence'} |\n`;
    const lintIcon = ac.lintGate?.status === 'pass' ? '✅' : '❌';
    content += `| lint | ${lintIcon} ${ac.lintGate?.status || 'unknown'} | ${ac.lintGate?.status === 'pass' ? 'Passed' : 'See evidence'} |\n`;
    const auditIcon = ac.auditGate?.status === 'pass' ? '✅' : '❌';
    content += `| audit | ${auditIcon} ${ac.auditGate?.status || 'unknown'} | ${ac.auditGate?.status === 'pass' ? 'Passed' : 'See evidence'} |\n`;

    if (ac.coverageGate) {
      const coverageIcon = ac.coverageGate.status === 'pass' ? '✅' : '❌';
      content += `| coverage | ${coverageIcon} ${ac.coverageGate.status} | ${ac.coverageGate.status === 'pass' ? 'Measured' : 'See evidence'} |\n`;
    }
    if (ac.e2eGate) {
      const e2eIcon = ac.e2eGate.status === 'pass' ? '✅' : '❌';
      content += `| E2E | ${e2eIcon} ${ac.e2eGate.status} | ${ac.e2eGate.status === 'pass' ? 'Passed' : 'See evidence'} |\n`;
    }

    const sizeIcon = ac.oversizedFiles?.status === 'pass' ? '✅' : '⚠️';
    const sizeIssues = ac.oversizedFiles?.issues || [];
    content += `| File sizes | ${sizeIcon} ${sizeIssues.length} oversized | ${sizeIssues.slice(0, 2).map(i => `${i.lines}L ${i.path.split('/').pop()}`).join(', ') || 'OK'} |\n`;

    const circIcon = ac.circularDeps?.status === 'pass' ? '✅' : '❌';
    const circIssues = ac.circularDeps?.issues || [];
    content += `| Circular deps | ${circIcon} | ${circIssues.length > 0 ? circIssues[0].substring(0, 50) : 'None found'} |\n`;

    const secretIcon = ac.secrets?.status === 'pass' ? '✅' : '⚠️';
    const secretIssues = ac.secrets?.issues || [];
    content += `| Secrets scan | ${secretIcon} | ${secretIssues.length > 0 ? secretIssues.length + ' potential' : 'Clean'} |\n`;

    content += `\n`;

    const allIssues = [
      ...(ac.oversizedFiles?.issues || []).map(i => `⚠️ **Oversized file**: ${i.path} (${i.lines} lines)`),
      ...(ac.secrets?.issues || []).map(i => `⚠️ **Potential secret**: ${String(i).substring(0, 100)}`),
      ...(ac.circularDeps?.issues || []).filter(i => typeof i === 'string').map(i => `❌ **Circular dep**: ${i.substring(0, 100)}`),
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

  content += `## Scores\n\n`;
  content += `| Reviewer | Score | Status | Blockers |\n`;
  content += `|----------|-------|--------|----------|\n`;

  let totalPassed = 0;
  let totalReviewed = 0;
  let totalBlockers = 0;

  for (const [reviewer, result] of Object.entries(scores)) {
    totalReviewed++;
    if (result.score !== null) {
      const passed = reviewerPacketPassed_(result);
      const status = !result.isValidReviewer ? '❌ INVALID' : passed ? '✅ PASS' : '❌ FAIL';
      const blockerCount = result.blockers?.length || 0;
      totalBlockers += blockerCount;
      content += `| ${reviewer} | ${result.score}/100 | ${status} | ${blockerCount > 0 ? `⚠ ${blockerCount}` : '-'} |\n`;
      if (passed) totalPassed++;
    } else if (result.hasReport) {
      content += `| ${reviewer} | N/A | ⚠ INCOMPLETE | ${result.blockers?.length || 0} |\n`;
    } else {
      content += `| ${reviewer} | - | ⏳ PENDING | - |\n`;
    }
  }

  content += `\n`;
  content += `**Total:** ${totalPassed}/${totalReviewed} passed, ${totalBlockers} blockers\n\n`;

  const allBlockers = Object.entries(scores)
    .filter(([, r]) => r.blockers && r.blockers.length > 0)
    .flatMap(([name, r]) => r.blockers.map(b => ({ reviewer: name, blocker: b })));

  if (allBlockers.length > 0) {
    content += `## Blockers Detail\n\n`;
    for (const { reviewer, blocker } of allBlockers) {
      content += `- **${reviewer}:** ${redactSensitiveText(String(blocker))}\n`;
    }
    content += `\n`;
  }

  content += `---\n\n`;

  if (effectiveAllPassed) {
    content += `## ✅ ALL REVIEWERS PASSED\n\n`;
    content += `This release has passed all quality gates. It is ready to ship.\n`;
    content += `\nTo generate the final report:\n`;
    content += `\`\`\`bash\n`;
    content += `npm run skill:gate -- --profile ${profile} --round ${roundNumber}\n`;
    content += `\`\`\`\n`;
  } else {
    content += `## ❌ QUALITY GATE FAILED\n\n`;
    content += `This release has not passed quality gates. Fix the issues below and re-run review.\n\n`;
    content += `**To continue:** launch the failed or pending reviewers as independent host agents, write their four required report files, then re-run this same round.\n\n`;

    if (allBlockers.length > 0) {
      content += `**Top priorities to fix:**\n\n`;
      allBlockers.slice(0, 5).forEach(({ reviewer, blocker }, i) => {
        content += `${i + 1}. [${reviewer}] ${redactSensitiveText(String(blocker))}\n`;
      });
    }
  }

  writeContainedFileSync(roundDir, reportPath, content);
  log.success(`Summary written to: ${reportPath}`);
  return effectiveAllPassed;
}

/**
 * Generate final report when all gates pass
 * @param {string} roundDir - Round directory
 * @param {object} scores - Reviewer scores object
 * @param {object|null} evidence - Evidence object
 * @param {string} profile - Profile name
 * @param {function} reviewerPacketPassed_ - Optional override for reviewerPacketPassed
 * @returns {string} Report path
 */
export function generateFinalReport(roundDir, scores, evidence = null, profile, reviewerPacketPassed_ = reviewerPacketPassed) {
  // This function is intentionally fail-closed so callers cannot create an
  // APPROVED report by passing a stale or optimistic gate boolean upstream.
  assertFinalReportEligible(scores, reviewerPacketPassed_);

  const reportPath = join(roundDir, 'final-report.md');
  const timestamp = new Date().toISOString();

  let content = `# 🎉 RELEASE APPROVED\n\n`;
  content += `**Date:** ${timestamp}\n`;
  content += `**Status:** APPROVED FOR RELEASE\n`;

  if (evidence) {
    content += `**Git:** ${evidence.git?.branch} @ ${evidence.git?.commit}\n`;
  }

  content += `\n---\n\n`;
  content += `## Final Scores\n\n`;
  content += `| Reviewer | Score | Gate |\n`;
  content += `|----------|-------|------|\n`;

  for (const [reviewer, result] of Object.entries(scores)) {
    const status = reviewerPacketPassed_(result) ? '✅ PASS' : '❌ FAIL';
    content += `| ${reviewer} | ${result.score}/100 | ${status} |\n`;
  }

  content += `\n---\n\n`;
  content += `## Release Checklist\n\n`;
  content += `- [x] All reviewers >= 90/100\n`;
  content += `- [x] No P0/P1 redlines\n`;
  content += `- [x] Tests passed\n`;
  content += `- [x] Typecheck passed\n`;
  if (['release-gate', 'full', 'agentic-release-gate'].includes(profile)) {
    content += `- [x] Build, lint, audit, coverage, E2E and source-secret scan passed\n`;
  }
  if (profile === 'agentic-release-gate') {
    content += `- [x] Clean-candidate verification passed for the exact commit/tree\n`;
    content += `- [x] Evidence and Goal instruction validation passed\n`;
  }
  content += `\n`;
  content += `---\n\n`;
  content += `*Generated by Release Quality Review Skill*\n`;
  content += `*Tool: release-quality-review gate*\n`;

  writeContainedFileSync(roundDir, reportPath, content);
  log.success(`Final report: ${reportPath}`);
  return reportPath;
}

/**
 * Write phase boundary marker for persistent handoff
 * @param {string} roundDir - Round directory
 * @param {number} roundNumber - Round number
 * @param {string} phase - Current phase
 * @param {string|null} nextPhase - Next phase
 * @returns {string} Boundary path
 */
export function writePhaseBoundary(roundDir, roundNumber, phase, nextPhase = null) {
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
Run: \`npm run skill:gate -- --round ${roundNumber + 1} --profile release-gate\`

---
*Generated by Release Quality Review Skill*
`;

  writeContainedFileSync(roundDir, boundaryPath, content);
  log.success(`Phase boundary written: ${boundaryPath}`);
  return boundaryPath;
}

/**
 * Update metadata.json with scale information
 * @param {string} roundDir - Round directory
 * @param {object} scaleInfo - Scale detection info
 */
export function updateMetadataWithScale(roundDir, scaleInfo) {
  const metaPath = join(roundDir, 'metadata.json');
  try {
    let meta = {};
    if (existsSync(metaPath)) {
      meta = JSON.parse(readContainedFileSync(roundDir, metaPath, 'utf-8'));
    }
    meta.scale = scaleInfo;
    writeContainedFileSync(roundDir, metaPath, JSON.stringify(meta, null, 2));
  } catch (e) {
    // Ignore - metadata update is best-effort
  }
}
