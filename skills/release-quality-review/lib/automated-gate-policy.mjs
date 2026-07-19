export const STRICT_COMMAND_GATE_KEYS = Object.freeze([
  'testGate', 'typecheckGate', 'buildGate', 'lintGate',
  'auditGate', 'coverageGate', 'e2eGate',
]);

export const STRICT_AUTOMATED_STATUS_KEYS = Object.freeze([
  ...STRICT_COMMAND_GATE_KEYS, 'secrets', 'circularDeps',
]);

export function requiredCommandGateKeys(profile) {
  return ['release-gate', 'full', 'agentic-release-gate'].includes(profile)
    ? STRICT_COMMAND_GATE_KEYS
    : ['testGate', 'typecheckGate'];
}
