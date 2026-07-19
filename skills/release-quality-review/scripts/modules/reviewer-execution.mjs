import { join } from 'node:path';

import {
  ensureContainedDirectorySync, writeContainedFile,
} from '../../lib/security-utils.mjs';
import { createReviewerAttemptExecutor } from './reviewer-process.mjs';

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export async function executeReviewers(options) {
  const {
    allReviewers, roundDir, currentRound, profile,
    candidateIdentity, resolvedAgent, resolvedModel, resolvedEffort, reviewerPrompts,
    startDelay, parallel, scale, scaledTimeout, timeoutPolicy, baseTimeout,
    retryMax, retryBaseDelayMs, retryMaxJitterMs, validatePacket, log, colors,
    onReviewComplete, evidence,
  } = options;
  const results = [];
  const activeReviewers = new Map();
  let parallelAbortReason = null;

  const abortAll = (reason, kind) => {
    if (parallelAbortReason) return;
    parallelAbortReason = reason;
    for (const abort of activeReviewers.values()) abort(reason, kind);
  };

  const runReviewerAttempt = createReviewerAttemptExecutor(options, activeReviewers, abortAll);

  const runReviewer = async (reviewer, delay, abortPeers) => {
    const reviewerDir = join(roundDir, reviewer);
    const reviewerSandboxDir = join(
      options.reportDir, '.reviewer-sandboxes',
      `round-${String(currentRound).padStart(3, '0')}`, reviewer,
    );
    ensureContainedDirectorySync(roundDir, reviewerDir);
    ensureContainedDirectorySync(options.reportDir, reviewerSandboxDir);
    const validation = await validatePacket(
      reviewerDir, reviewer, profile, currentRound, candidateIdentity, resolvedAgent, resolvedModel,
    );
    if (validation.valid) {
      console.log(`  [round-${String(currentRound).padStart(3, '0')}/${reviewer}] ${colors.blue}↷${colors.reset} validated resume (score: ${validation.score ?? 'unknown'})`);
      return { name: reviewer, status: 'completed', skipped: true };
    }
    if (validation.reason) {
      console.log(`  [round-${String(currentRound).padStart(3, '0')}/${reviewer}] ${colors.yellow}⚡${colors.reset} invalidating stale artifacts (${validation.reason}), re-running`);
    }
    await sleep(delay);
    const prompt = reviewerPrompts.get(reviewer);
    if (!prompt) {
      console.log(`  ${colors.red}✗${colors.reset} ${reviewer}: definition not found`);
      return { name: reviewer, status: 'failed' };
    }
    await writeContainedFile(roundDir, join(reviewerDir, 'prompt.md'), prompt);

    let lastResult = null;
    for (let attempt = 1; attempt <= retryMax + 1; attempt++) {
      if (attempt > 1) {
        const retryDelay = retryBaseDelayMs * Math.pow(2, attempt - 2) + Math.random() * retryMaxJitterMs;
        log.info(`  Retry ${attempt - 1}/${retryMax} for ${reviewer}: waiting ${Math.round(retryDelay)}ms`);
        await sleep(retryDelay);
      }
      lastResult = await runReviewerAttempt(
        reviewer, reviewerDir, reviewerSandboxDir, prompt, attempt, abortPeers,
      );
      if (lastResult.status === 'completed' || lastResult.abortedKind) return lastResult;
      if (lastResult.permanentFailure) {
        log.warn(`  ${reviewer}: not retrying permanent Agent failure`);
        return lastResult;
      }
    }
    return { ...lastResult, attempts: retryMax + 1 };
  };

  if (parallel) {
    log.info(`Execution: parallel, Scale: ${scale}, Effort: ${resolvedEffort || 'default'}, Timeout: ${scaledTimeout}ms ` +
      `(base: ${baseTimeout}ms, scale x${timeoutPolicy.scaleMultiplier}, effort x${timeoutPolicy.effortMultiplier}), Start delay: ${startDelay}ms`);
    try {
      await options.preflightAgent(resolvedAgent);
    } catch {
      const error = new Error(`Parallel mode requires ${resolvedAgent} CLI on PATH; no reviewer agents were launched.`);
      error.exitCode = 5;
      throw error;
    }
    const parallelResults = await Promise.all(allReviewers.map(reviewer => runReviewer(reviewer, startDelay, true)));
    results.push(...parallelResults);
    if (parallelResults.some(result => result.status !== 'completed')) {
      const error = new Error(parallelAbortReason || 'one or more reviewer agents failed');
      error.exitCode = 5;
      return { results, reviewFailure: error };
    }
  } else {
    log.info(`Execution: sequential with ${startDelay}ms delays`);
    for (let i = 0; i < allReviewers.length; i++) {
      const reviewer = allReviewers[i];
      const result = await runReviewer(reviewer, i > 0 ? startDelay : 0, false);
      results.push(result);
      if (onReviewComplete) onReviewComplete(reviewer, join(roundDir, reviewer), evidence);
    }
    const failedResults = results.filter(result => result.status !== 'completed');
    if (failedResults.length > 0) {
      const error = new Error(`Sequential review failed for: ${failedResults.map(result => result.name).join(', ')}`);
      error.exitCode = 5;
      return { results, reviewFailure: error };
    }
  }

  return { results, reviewFailure: null };
}
