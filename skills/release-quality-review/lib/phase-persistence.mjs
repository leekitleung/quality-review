import { existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parseYamlResult, validateResultYamlContract } from './review-utils.mjs';
import { ensureContainedDirectorySync, readContainedFileSync, writeContainedFileSync } from './security-utils.mjs';

export function extractResultScoresFromRound(roundDir) {
  const scores = [];
  for (const reviewer of readdirSync(roundDir)) {
    const reviewerDir = join(roundDir, reviewer);
    if (!statSync(reviewerDir).isDirectory()) continue;
    const resultPath = join(reviewerDir, 'result.yaml');
    if (!existsSync(resultPath)) continue;
    const content = readContainedFileSync(roundDir, resultPath, 'utf8');
    const contract = validateResultYamlContract(content);
    if (!contract.valid) throw new Error(`${reviewer}/result.yaml: ${contract.error}`);
    const result = parseYamlResult(content);
    scores.push({ reviewer, score: result.score });
  }
  return scores;
}

export function getReviewerFocus(reviewerName) {
  const focuses = {
    'product-flow': 'user-facing functionality and completion',
    'architecture-maintainer': 'code structure and module boundaries',
    'release-verifier': 'test coverage and build reproducibility',
    'destructive-qa': 'security vulnerabilities and edge cases',
    'terminal-veteran': 'CLI/terminal UX and error messages',
    'native-designer': 'UI consistency and design system compliance',
    'zero-doc-user': 'documentation and onboarding experience',
    'data-security': 'token handling and data protection',
    'adversarial-completion': 'pseudo-completion detection',
    'evidence-integrity': 'evidence authenticity and completeness',
    'goal-compliance': 'goal alignment and scope adherence',
    'regression-risk': 'regression risk and backward compatibility',
    'handoff-integrity': 'handoff completeness and artifact quality',
  };
  return focuses[reviewerName] || 'quality and correctness';
}

export function persistPhasePlan(roundDir, phase, reviewers, evidence, profileConfig) {
  ensureContainedDirectorySync(dirname(roundDir), roundDir);
  const planFile = join(roundDir, `phase-${phase}-plan.md`);
  const scaleInfo = evidence.scale || { scale: 'unknown', fileCount: 0, totalLines: 0 };
  const fileCount = scaleInfo.fileCount ?? scaleInfo.files ?? 0;
  const totalLines = scaleInfo.totalLines ?? scaleInfo.total ?? 0;
  const content = `# Phase ${phase} Plan

## Metadata

| Field | Value |
|-------|-------|
| Started | ${new Date().toISOString()} |
| Profile | ${profileConfig.name} |
| Scale | ${scaleInfo.scale} (${fileCount} files, ${totalLines} lines) |
| Round | ${phase} |

## Input

- **Changed files:** ${evidence.git?.changedFiles?.length || 0}
- **Git branch:** ${evidence.git?.branch || 'unknown'}
- **Git commit:** ${evidence.git?.commit || 'unknown'}

## Reviewers

${reviewers.map(reviewer => `- ${reviewer}`).join('\n')}

## Goals

${reviewers.map(reviewer => `- ${reviewer}: Verify ${getReviewerFocus(reviewer)}`).join('\n')}

## Exit Criteria

- [ ] All reviewers >= ${profileConfig.gate?.min_score || 90}
- [ ] No P0 redlines
- [ ] Evidence collected for all dimensions

## Notes

_(Add notes before starting this phase)_
`;
  writeContainedFileSync(roundDir, planFile, content);
  return planFile;
}

export function persistPhaseResult(roundDir, phase, scores, gatePassed, failedReviewers) {
  ensureContainedDirectorySync(dirname(roundDir), roundDir);
  const resultFile = join(roundDir, `phase-${phase}-result.md`);
  const completedAt = new Date().toISOString();
  const scoresTable = Object.entries(scores)
    .map(([reviewer, score]) => {
      const scoreValue = typeof score === 'number' ? score : (score.score ?? 'N/A');
      const passed = typeof scoreValue === 'number' && scoreValue >= 90;
      return `| ${reviewer} | ${scoreValue}/100 | ${passed ? '✅ PASS' : '❌ FAIL'} |`;
    })
    .join('\n');
  const failedList = failedReviewers.length > 0
    ? failedReviewers.map(failure => `- [ ] **[${failure.reviewer}]** Score: ${failure.score}/100`).join('\n')
    : '_None_';
  const content = `# Phase ${phase} Result

## Metadata

| Field | Value |
|-------|-------|
| Completed | ${completedAt} |
| Gate Status | ${gatePassed ? '✅ PASSED' : '❌ FAILED'} |
| Round | ${phase} |

## Scores

| Reviewer | Score | Status |
|----------|-------|--------|
${scoresTable}

## Gate Status

**${gatePassed ? 'ALL GATES PASSED' : 'GATES FAILED'}**

${gatePassed ? '## Ready for Release' : `## Failed Reviewers

${failedList}

## Next Actions

1. Fix the issues identified by failed reviewers
2. Re-run the review: \`node review-runner.mjs --round ${phase + 1}\`
3. Or aggregate a specific reviewer packet for diagnostics: \`npm run skill:gate -- --reviewer <name> --round ${phase}\`
`}

## Timeline

- Phase started: See phase-${phase}-plan.md
- Phase completed: ${completedAt}
`;
  writeContainedFileSync(roundDir, resultFile, content);
  return resultFile;
}
