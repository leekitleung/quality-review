export function resolveReviewerRuntimePolicy(agent, toolEnv) {
  const codexAuthMode = agent === 'codex'
    ? toolEnv.RELEASE_QUALITY_CODEX_AUTH_MODE || 'file'
    : null;
  if (codexAuthMode !== null && !['file', 'none'].includes(codexAuthMode)) {
    throw new Error(`Unsupported Codex reviewer auth mode: ${codexAuthMode}`);
  }
  const fixtureExecution = agent === 'codex' && codexAuthMode === 'none' &&
    Boolean(toolEnv.NODE_TEST_CONTEXT);
  return Object.freeze({
    codexAuthMode,
    fixtureExecution,
    requireExactWriteIsolation: !fixtureExecution,
  });
}
