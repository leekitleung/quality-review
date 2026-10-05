// Standard error message format for the skill:
//   [Component] action failed: reason. Try: suggestion.
// User-facing failures must be actionable; internal invariants must state
// which invariant broke so evidence reviewers can diagnose without a
// debugger. Keep the reason free of secrets — error messages are persisted
// into round evidence and must survive redactSensitiveText unchanged.

export function formatGateError(component, action, reason, suggestion = null) {
  const base = `[${component}] ${action} failed: ${reason}`;
  return suggestion ? `${base}. Try: ${suggestion}` : base;
}

export function gateError(component, action, reason, suggestion = null) {
  return new Error(formatGateError(component, action, reason, suggestion));
}
