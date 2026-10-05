// Which automated command gates a profile requires, in one module so the
// evidence collector, the persisted-evidence validator, and the arbitration
// policy cannot disagree about what "all gates ran" means. A gate absent
// from the required list is not skipped-by-favor; quick profiles genuinely
// collect less evidence, and everything required must still pass.
/**
 * Dependencies are installed in the isolated checkout before any project
 * gate runs. --ignore-scripts is mandatory: candidate lifecycle scripts are
 * untrusted code and would otherwise execute on the evidence host.
 */
export const INSTALL_GATE_COMMAND = 'npm ci --ignore-scripts --no-audit --no-fund';

export const STRICT_COMMAND_GATE_KEYS = Object.freeze([
  'installGate', 'testGate', 'typecheckGate', 'buildGate', 'lintGate',
  'auditGate', 'coverageGate', 'e2eGate',
]);

export const STRICT_AUTOMATED_STATUS_KEYS = Object.freeze([
  ...STRICT_COMMAND_GATE_KEYS, 'secrets', 'circularDeps',
]);

/**
 * Command gates a profile must collect and pass.
 * @param {string} profile - Gate profile name.
 * @returns {string[]} Gate keys; strict profiles require all eight.
 */
export function requiredCommandGateKeys(profile) {
  return ['release-gate', 'full', 'agentic-release-gate'].includes(profile)
    ? STRICT_COMMAND_GATE_KEYS
    : ['testGate', 'typecheckGate'];
}
