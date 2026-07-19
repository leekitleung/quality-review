export function resolveReviewerRuntimePolicy(agent, toolEnv) {
  const codexAuthMode = agent === 'codex'
    ? toolEnv.RELEASE_QUALITY_CODEX_AUTH_MODE || 'file'
    : null;
  if (codexAuthMode !== null && !['file', 'none'].includes(codexAuthMode)) {
    throw new Error(`Unsupported Codex reviewer auth mode: ${codexAuthMode}`);
  }
  const fixtureCapability = toolEnv.RELEASE_QUALITY_REVIEWER_FIXTURE_EXECUTOR;
  if (fixtureCapability !== undefined && !['0', '1'].includes(fixtureCapability)) {
    throw new Error(`Unsupported reviewer fixture capability: ${fixtureCapability}`);
  }
  const fixtureExecution = agent === 'codex' && codexAuthMode === 'none' && fixtureCapability === '1';
  return Object.freeze({
    codexAuthMode,
    fixtureExecution,
    requireExactWriteIsolation: !fixtureExecution,
  });
}
