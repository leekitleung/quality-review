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
