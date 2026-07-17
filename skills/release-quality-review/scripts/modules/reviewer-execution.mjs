import { spawn } from 'node:child_process';
import { join, relative } from 'node:path';

import {
  ensureContainedDirectorySync, redactSensitiveText, writeContainedFile,
} from '../../lib/security-utils.mjs';

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isPermanentAgentFailure(diagnostic) {
  const message = String(diagnostic || '').toLowerCase();
  const httpStatus = message.match(/\b(?:http(?:\/\d(?:\.\d)?)?\s*)?([45]\d\d)\b/);
  if (httpStatus) {
    const status = Number(httpStatus[1]);
    if (status >= 400 && status < 500 && ![408, 425, 429].includes(status)) return true;
  }
  return [
    /\binsufficient(?:_|\s)+(?:balance|quota|credits?)\b/,
    /\b(?:invalid|incorrect|missing|expired|revoked)(?:_|\s)+(?:api(?:_|\s)+)?key\b/,
    /\b(?:authentication failed|account (?:deactivated|disabled)|billing (?:error|required))\b/,
    /\b(?:model|deployment)\b.{0,80}\b(?:does not exist|invalid|not found|unsupported|unavailable)\b/,
    /\b(?:invalid|unknown|unsupported)\b.{0,40}\bmodel\b/,
    /\b(?:enoent|command not found)\b/,
  ].some(pattern => pattern.test(message));
}

function extractStructuredAgentFailure(agent, stdout) {
  if (agent !== 'codex') return '';
  const failures = [];
  for (const line of String(stdout || '').split('\n')) {
    try {
      const event = JSON.parse(line);
      if (event?.type === 'turn.failed' && typeof event.error?.message === 'string') {
        failures.push(event.error.message);
      }
    } catch {
      // Non-JSON output is diagnostic only and must not control retry behavior.
    }
  }
  return failures.join('\n');
}

export async function executeReviewers(options) {
  const {
    allReviewers, roundDir, reportDir, projectRoot, currentRound, profile,
    candidateIdentity, resolvedAgent, resolvedModel, resolvedEffort, reviewerPrompts,
    startDelay, parallel, scale, scaledTimeout, timeoutPolicy, baseTimeout,
    retryMax, retryBaseDelayMs, retryMaxJitterMs, killGraceMs, toolEnv, candidateEnv,
    getAgentInvocation, validatePacket, log, colors, onReviewComplete, evidence,
  } = options;
  const results = [];
  const activeReviewers = new Map();
  let parallelAbortReason = null;

  const abortAll = (reason, kind) => {
    if (parallelAbortReason) return;
    parallelAbortReason = reason;
    for (const abort of activeReviewers.values()) abort(reason, kind);
  };

  const runReviewerAttempt = (reviewer, reviewerDir, prompt, attempt, abortPeers) => new Promise(resolve => {
    const invocation = getAgentInvocation(resolvedAgent, resolvedModel, resolvedEffort, prompt);
    const reviewerReportDir = relative(
      projectRoot,
      join(reportDir, '.reviewer-sandboxes', `round-${String(currentRound).padStart(3, '0')}`, reviewer),
    );
    const proc = spawn(invocation.command, invocation.args, {
      cwd: projectRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
      env: { ...toolEnv, RELEASE_QUALITY_REPORT_DIR: reviewerReportDir },
    });
    let stdoutTail = '';
    let stderrTail = '';
    let internalDiagnostic = '';
    let processError = '';
    let settled = false;
    let abortedKind = null;
    let forceTimer = null;
    let timeoutTimer = null;
    const key = `${reviewer}-${attempt}`;
    const appendTail = (current, data) => (current + data.toString()).slice(-4000);
    const combinedDiagnostic = () => [stdoutTail, stderrTail, processError, internalDiagnostic]
      .filter(Boolean).join('\n').slice(-4000);
    const signalProcessTree = signal => {
      if (!proc.pid) return false;
      try {
        if (process.platform === 'win32') {
          const args = ['/pid', String(proc.pid), '/t'];
          if (signal === 'SIGKILL') args.push('/f');
          spawn('taskkill', args, { stdio: 'ignore', env: candidateEnv }).unref();
        } else {
          process.kill(-proc.pid, signal);
        }
        return true;
      } catch (error) {
        if (error.code !== 'ESRCH') {
          internalDiagnostic = appendTail(internalDiagnostic, `\nprocess-tree ${signal} failed: ${error.message}`);
        }
        return false;
      }
    };
    const finish = async (code, eventStatus = null) => {
      if (settled) return;
      settled = true;
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (forceTimer) clearTimeout(forceTimer);
      activeReviewers.delete(key);
      const postValidation = await validatePacket(
        reviewerDir, reviewer, profile, currentRound, candidateIdentity, resolvedAgent, resolvedModel,
      );
      const complete = postValidation.valid;
      const timedOutWithValidPacket = abortedKind === 'timeout' && complete;
      const status = timedOutWithValidPacket ? 'completed' :
        (eventStatus || (!abortedKind && code === 0 && complete ? 'completed' : 'failed'));
      if (!complete && postValidation.reason) {
        internalDiagnostic = appendTail(internalDiagnostic, `\npacket validation failed: ${postValidation.reason}`);
      }
      console.log(`  ${status === 'completed' ? colors.green + '✓' : colors.red + '✗'}${colors.reset} ${reviewer}${attempt > 1 ? ` (attempt ${attempt})` : ''}: ${status}`);
      const diagnostic = combinedDiagnostic();
      if (status === 'failed' && diagnostic) {
        console.log(`    ${redactSensitiveText(diagnostic).replace(/\s+/g, ' ').slice(-500)}`);
      }
      const permanentSource = [extractStructuredAgentFailure(resolvedAgent, stdoutTail), processError]
        .filter(Boolean).join('\n');
      resolve({
        name: reviewer, status, attempt, diagnostic, abortedKind,
        permanentFailure: isPermanentAgentFailure(permanentSource),
      });
    };
    const abort = (reason, kind = 'aborted') => {
      if (settled || abortedKind) return;
      abortedKind = kind;
      internalDiagnostic = appendTail(internalDiagnostic, `\n${reason}`);
      signalProcessTree('SIGTERM');
      forceTimer = setTimeout(() => {
        if (settled) return;
        signalProcessTree('SIGKILL');
        forceTimer = setTimeout(() => void finish(null, 'failed'), 100);
      }, killGraceMs);
    };

    proc.stdout.on('data', data => { stdoutTail = appendTail(stdoutTail, data); });
    proc.stderr.on('data', data => { stderrTail = appendTail(stderrTail, data); });
    activeReviewers.set(key, abort);
    timeoutTimer = setTimeout(() => {
      const reason = `${reviewer} timed out after ${scaledTimeout}ms (scale: ${scale})`;
      console.log(`  ${colors.red}✗${colors.reset} ${reason}`);
      if (abortPeers) abortAll(reason, 'timeout');
      else abort(reason, 'timeout');
    }, scaledTimeout);
    proc.on('close', code => {
      if (abortedKind) return;
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (!signalProcessTree('SIGTERM')) {
        void finish(code);
        return;
      }
      forceTimer = setTimeout(() => {
        signalProcessTree('SIGKILL');
        forceTimer = setTimeout(() => void finish(code), 100);
      }, killGraceMs);
    });
    proc.on('error', error => {
      processError = error.message;
      console.log(`  ${colors.red}✗${colors.reset} ${reviewer}: ${error.message}`);
      if (abortPeers) abortAll(`${reviewer} process error: ${error.message}`, 'process-error');
      void finish(null, 'error');
    });
  });

  const runReviewer = async (reviewer, delay, abortPeers) => {
    const reviewerDir = join(roundDir, reviewer);
    ensureContainedDirectorySync(roundDir, reviewerDir);
    const validation = await validatePacket(
      reviewerDir, reviewer, profile, currentRound, candidateIdentity, resolvedAgent, resolvedModel,
    );
    if (validation.valid) {
      console.log(`  ${colors.blue}↷${colors.reset} ${reviewer}: validated resume (score: ${validation.score ?? 'unknown'})`);
      return { name: reviewer, status: 'completed', skipped: true };
    }
    if (validation.reason) {
      console.log(`  ${colors.yellow}⚡${colors.reset} ${reviewer}: invalidating stale artifacts (${validation.reason}), re-running`);
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
      lastResult = await runReviewerAttempt(reviewer, reviewerDir, prompt, attempt, abortPeers);
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
