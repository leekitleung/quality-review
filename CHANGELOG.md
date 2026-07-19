# Changelog

## Unreleased

- Add the canonical `release-quality-review` Skill, Claude/Codex adapters, registry, lock file, synchronization checks, and CI validation.
- Enforce conjunctive reviewer scoring, P0/P1 redlines, authenticated evidence, clean-candidate verification, contained report writes, and round-scoped final arbitration.
- Add independent reviewer orchestration, delivery-packet validation, regression tests, coverage evidence, and executable usage documentation.
- Select Codex reviewer models from validated Codex Radar data, lock model and reasoning effort per round, and fail closed to an explicit host-selected model when Radar is unavailable.
- Fix deep-optimization-lab startup and profile command injection, unify review scale and machine-score contracts, bind blocker evidence per finding, and make reviewer timeouts scale- and effort-aware.
- Stop retrying permanent reviewer Agent failures while preserving exponential-backoff retries for transient failures.
- Unify parallel and sequential reviewer execution, isolate retry classification from reviewer stdout, reject inconsistent packet verdicts, require parseable shared-evidence excerpts, and ignore empty localized P0/P1 headings.
- Consume Codex JSON `turn.failed` events for retry classification so model output on either output stream cannot forge a permanent provider failure.
- Remove mutable report-root globals, recognize labeled empty severity headings and TAP label summaries, bind machine findings to Markdown sections, and surface sandbox recovery at the point of failure.
- Make the Gate the sole production evidence collector, require command evidence for passing reviewer packets, and bootstrap deep-optimization baselines in clean workspaces.
- Bind actual Runner launches to the Gate-owned reviewer selection persisted for the same candidate and round.
- Keep evidence startup, Git identity reads, metadata loading, and final Gate arbitration asynchronous; reject passing reviewer packets without structured command evidence before accepting an attempt; and cover collector-level sandbox startup recovery.
- Fail closed on persisted-evidence dirty-worktree drift, preserve silent verification timeout diagnostics, split release tests by ownership, and move reviewer lifecycle/retry orchestration into an execution engine.
- Restore non-agentic persisted-scope resume, centralize verification command policy, reject shell and symlink manifest escapes, and split runner lifecycle, reviewer selection, and Gate E2E tests into separate entry points.
- Reject non-zero multi-digit failure summaries and bind each reviewer command to a command-specific output contract so audit, code-check, or sandbox text cannot forge test evidence.
- Derive canonical reviewer evidence blocks from the current round's persisted automated checks and reject passing packets whose command, exit code, or summary does not match them exactly.
- Split Gate reviewer selection, persisted-evidence loading, reviewer process lifecycle, and policy integration tests into focused modules while preserving fail-closed behavior.
- Unify strict command-gate policy, bind fail packets and finding-specific citations, verify the packed artifact, expand CI release checks, and add doctor, examples, and retention-policy commands.
- Isolate each reviewer in a private writable sandbox with host-owned packet publication, use a meaningful `HEAD~1` default base, minimize persisted Git metadata, enforce report retention with an audited deletion mode, and split verification-script policy from the shared utility module.
- Give isolated Codex reviewers a minimal private authentication home and an authenticated HTTP Responses provider, disable unrelated remote plugin services, and rely on the enforced exact-write outer sandbox instead of an unsupported nested CLI sandbox.
