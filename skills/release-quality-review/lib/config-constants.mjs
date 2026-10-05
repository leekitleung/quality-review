// Centralized operational constants for the release-quality-review skill.
// Every value must stay byte-identical to the inline literal it replaced:
// these timeouts and buffers are part of the evidence contract that
// validateAutomatedEvidence and the gate policy reason about. Change a value
// only together with the tests and persisted evidence that observe it.

/**
 * Subprocess timeouts in milliseconds, ordered from shortest to longest.
 * - VERSION_CHECK: `--version` style probes of external tooling.
 * - GIT_OPERATION: single git metadata commands (status, rev-parse, diff).
 * - GIT_CLONE: cloning the candidate repository for isolated verification.
 * - REPO_SCAN: bulk repository or file-tree listings (ls-files, find/wc).
 * - EVIDENCE_COMMAND: default per-command evidence execution in the gate.
 * - GOAL_INSTRUCTION: goal-gate script checks on generated artifacts.
 * - NPM_OPERATION: npm pack / install during package verification.
 * - EVIDENCE_VALIDATION: the standalone evidence validator subprocess.
 * - ROLLBACK_OPERATION: rollback verification commands (full reinstall+test).
 * - GATE_SUBPROCESS: the review-gate invoked end-to-end from review-runner.
 * - REVIEWER: default reviewer execution budget; runtime override via
 *   RELEASE_QUALITY_REVIEWER_TIMEOUT_MS.
 */
export const TIMEOUTS = Object.freeze({
  VERSION_CHECK: 5_000,
  GIT_OPERATION: 10_000,
  GIT_CLONE: 30_000,
  REPO_SCAN: 30_000,
  EVIDENCE_COMMAND: 30_000,
  GOAL_INSTRUCTION: 30_000,
  NPM_OPERATION: 60_000,
  EVIDENCE_VALIDATION: 60_000,
  ROLLBACK_OPERATION: 180_000,
  GATE_SUBPROCESS: 600_000,
  REVIEWER: 900_000,
});

/**
 * Child-process stdout/stderr caps in bytes. Evidence records truncate
 * silently once exceeded, so a buffer smaller than the expected output of a
 * command is a correctness bug, not a tuning knob.
 */
export const MAX_BUFFER = Object.freeze({
  GIT_OUTPUT: 10 * 1024 * 1024,
  ROLLBACK_OUTPUT: 8 * 1024 * 1024,
  GATE_OUTPUT: 20 * 1024 * 1024,
});

/**
 * POSIX permissions for report directories and files. Report contents can
 * carry reviewer output that was never meant to be world-readable, so the
 * umask is tightened explicitly rather than inherited.
 */
export const FILE_PERMISSIONS = Object.freeze({
  REPORT_DIR: 0o700,
  REPORT_FILE: 0o600,
});

/**
 * Artifact scan limits for scanRoundArtifacts. The scan is a bounded safety
 * net over untrusted round output, not a full audit: past these limits the
 * scanner reports `artifact scan limit exceeded` instead of reading further.
 */
export const SCAN_LIMITS = Object.freeze({
  MAX_FILES: 500,
  MAX_TOTAL_BYTES: 20 * 1024 * 1024,
  MAX_FILE_BYTES: 2 * 1024 * 1024,
});
