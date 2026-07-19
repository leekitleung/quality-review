import { spawn } from 'node:child_process';
import { rmSync } from 'node:fs';
import { join, relative } from 'node:path';

import { isPathWithin, readContainedFile, redactSensitiveText, writeContainedFile } from '../../lib/security-utils.mjs';
import { prepareReviewerRuntime } from './reviewer-runtime.mjs';

const PACKET_FILES = ['result.yaml', 'score.md', 'blockers.md', 'improvement-list.md'];

async function publishPacket(sandboxDir, reviewerDir) {
  for (const file of PACKET_FILES) {
    const content = await readContainedFile(sandboxDir, join(sandboxDir, file), 'utf8');
    await writeContainedFile(reviewerDir, join(reviewerDir, file), content);
  }
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

export function createReviewerAttemptExecutor(options, activeReviewers, abortAll) {
  const {
    reportDir, projectRoot, currentRound, profile, candidateIdentity, resolvedAgent,
    resolvedModel, resolvedEffort, scale, scaledTimeout, killGraceMs, toolEnv,
    candidateEnv, getAgentInvocation, validatePacket, colors,
  } = options;

  return (reviewer, reviewerDir, reviewerSandboxDir, prompt, attempt, abortPeers) => new Promise(resolve => {
    const invocation = getAgentInvocation(resolvedAgent, resolvedModel, resolvedEffort, prompt);
    const reviewerReportDir = relative(
      projectRoot,
      join(reportDir, '.reviewer-sandboxes', `round-${String(currentRound).padStart(3, '0')}`, reviewer),
    );
    if (!isPathWithin(reportDir, reviewerSandboxDir)) {
      throw new Error('reviewer sandbox escapes the report root');
    }
    const { wrapped, reviewerEnv } = prepareReviewerRuntime({
      invocation, resolvedAgent, toolEnv, candidateEnv, reviewerSandboxDir,
      projectRoot, reviewerReportDir, outerSandboxAttestation: options.outerSandboxAttestation,
    });
    const proc = spawn(wrapped.command, wrapped.args, {
      cwd: projectRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
      env: reviewerEnv,
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
      let postValidation = await validatePacket(
        reviewerSandboxDir, reviewer, profile, currentRound, candidateIdentity, resolvedAgent, resolvedModel,
      );
      if (postValidation.valid) {
        try {
          await publishPacket(reviewerSandboxDir, reviewerDir);
          postValidation = await validatePacket(
            reviewerDir, reviewer, profile, currentRound, candidateIdentity, resolvedAgent, resolvedModel,
          );
          if (postValidation.valid) rmSync(reviewerSandboxDir, { recursive: true, force: true });
        } catch (error) {
          postValidation = { valid: false, reason: `packet publish failed: ${error.message}` };
        }
      }
      const complete = postValidation.valid;
      const timedOutWithValidPacket = abortedKind === 'timeout' && complete;
      const status = timedOutWithValidPacket ? 'completed' :
        (eventStatus || (!abortedKind && code === 0 && complete ? 'completed' : 'failed'));
      if (!complete && postValidation.reason) {
        internalDiagnostic = appendTail(internalDiagnostic, `\npacket validation failed: ${postValidation.reason}`);
      }
      const correlation = `round-${String(currentRound).padStart(3, '0')}/${reviewer}/attempt-${attempt}`;
      console.log(`  [${correlation}] ${status === 'completed' ? colors.green + '✓' : colors.red + '✗'}${colors.reset} ${reviewer}${attempt > 1 ? ` (attempt ${attempt})` : ''}: ${status}`);
      const diagnostic = combinedDiagnostic();
      if (status === 'failed' && diagnostic) {
        console.error(`    [${correlation}] ${redactSensitiveText(diagnostic).replace(/\s+/g, ' ').slice(-500)}`);
      }
      const permanentSource = [
        resolvedAgent === 'codex' ? extractStructuredAgentFailure(resolvedAgent, stdoutTail) : stderrTail,
        processError,
      ].filter(Boolean).join('\n');
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
      console.error(`  [round-${String(currentRound).padStart(3, '0')}/${reviewer}] ${colors.red}✗${colors.reset} ${reason}`);
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
      console.error(`  [round-${String(currentRound).padStart(3, '0')}/${reviewer}] ${colors.red}✗${colors.reset} ${reviewer}: ${error.message}`);
      if (abortPeers) abortAll(`${reviewer} process error: ${error.message}`, 'process-error');
      void finish(null, 'error');
    });
  });
}
