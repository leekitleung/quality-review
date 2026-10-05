import { existsSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';

import { wrapCandidateCommand } from '../../lib/security-utils.mjs';
import { prepareCodexHome, prepareZcodeHome, reviewerAuthRoots } from './reviewer-auth.mjs';
import { resolveReviewerRuntimePolicy } from './reviewer-runtime-policy.mjs';

function invocationReadRoot(command, searchPath) {
  if (isAbsolute(command) && existsSync(command)) return dirname(command);
  for (const directory of String(searchPath || '').split(':').filter(Boolean)) {
    if (existsSync(join(directory, command))) return directory;
  }
  return null;
}

export function prepareReviewerRuntime({
  invocation, resolvedAgent, toolEnv, candidateEnv, reviewerSandboxDir,
  projectRoot, reviewerReportDir, outerSandboxAttestation,
}) {
  const policy = resolveReviewerRuntimePolicy(resolvedAgent, toolEnv);
  const executableRoot = invocationReadRoot(invocation.command, toolEnv.PATH);
  const codexHome = resolvedAgent === 'codex'
    ? prepareCodexHome(toolEnv, reviewerSandboxDir, policy.codexAuthMode)
    : null;
  // zcode resolves its config from HOME, which already points at the sandbox:
  // copying the credentials in is the only preparation needed.
  if (resolvedAgent === 'zcode') prepareZcodeHome(toolEnv, reviewerSandboxDir);
  const wrapped = wrapCandidateCommand(invocation.command, invocation.args, {
    readOnlyRoots: [
      projectRoot,
      // zcode reads its credentials from the copied-in sandbox home, so only
      // claude needs the host auth root mounted read-only.
      ...(resolvedAgent === 'claude' ? reviewerAuthRoots(resolvedAgent, toolEnv) : []),
      executableRoot,
    ].filter(Boolean),
    writeRoots: [reviewerSandboxDir],
    allowNetwork: true,
    outerSandboxAttestation,
    requireExactWriteIsolation: policy.requireExactWriteIsolation,
  });
  const reviewerEnv = {
    ...candidateEnv,
    PATH: toolEnv.PATH,
    HOME: reviewerSandboxDir,
    TMPDIR: reviewerSandboxDir,
    TMP: reviewerSandboxDir,
    TEMP: reviewerSandboxDir,
    RELEASE_QUALITY_REPORT_DIR: reviewerReportDir,
  };
  if (resolvedAgent === 'codex') reviewerEnv.CODEX_HOME = codexHome;
  else if (resolvedAgent === 'claude') {
    const authRoot = reviewerAuthRoots(resolvedAgent, toolEnv)[0];
    if (authRoot) reviewerEnv.CLAUDE_CONFIG_DIR = authRoot;
  }
  return { wrapped, reviewerEnv, policy };
}
