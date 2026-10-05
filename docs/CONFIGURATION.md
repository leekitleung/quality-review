# Configuration Guide

Operational constants live in one module so the skill's scripts and the
repository's verification tooling cannot drift apart:

```
skills/release-quality-review/lib/config-constants.mjs
```

`scripts/doctor.mjs`, `scripts/verify-package.mjs`, and
`scripts/verify-clean-candidate.mjs` import the same constants. Values there
are part of the evidence contract — the gate policy and persisted evidence
reason about them — so change a value only together with the tests that
observe it.

## TIMEOUTS

Subprocess timeouts in milliseconds.

| Constant | Value | Used for |
|---|---|---|
| `VERSION_CHECK` | 5 000 | `--version` probes of external tooling |
| `GIT_OPERATION` | 10 000 | single git metadata commands (status, rev-parse, diff) |
| `GIT_CLONE` | 30 000 | cloning the candidate repository |
| `REPO_SCAN` | 30 000 | bulk listings (`git ls-files`, `find`/`wc` scans) |
| `EVIDENCE_COMMAND` | 30 000 | default per-command evidence execution in the gate |
| `GOAL_INSTRUCTION` | 30 000 | goal-gate checks on generated artifacts |
| `NPM_OPERATION` | 60 000 | `npm pack` / `npm install` in package verification |
| `EVIDENCE_VALIDATION` | 60 000 | standalone evidence validator subprocess |
| `ROLLBACK_OPERATION` | 180 000 | rollback verification (reinstall + full test suite) |
| `GATE_SUBPROCESS` | 600 000 | review-gate invoked end-to-end from the runner |
| `REVIEWER` | 900 000 | default reviewer budget; see env overrides below |

`MAX_BUFFER` caps child-process output (`GIT_OUTPUT` 10 MB, `ROLLBACK_OUTPUT`
8 MB, `GATE_OUTPUT` 20 MB). A buffer smaller than a command's expected output
is a correctness bug, not a tuning knob: evidence records truncate silently.

`FILE_PERMISSIONS` (report directories `0o700`, report files `0o600`) are POSIX
semantics; see `docs/WINDOWS-SETUP.md` for the NTFS caveat.

`SCAN_LIMITS` bound the artifact scanner (`MAX_FILES` 500, `MAX_TOTAL_BYTES`
20 MB, `MAX_FILE_BYTES` 2 MB); past the limit the scanner reports
`artifact scan limit exceeded` instead of reading further.

## Environment overrides

| Variable | Default | Meaning |
|---|---|---|
| `RELEASE_QUALITY_REVIEWER_TIMEOUT_MS` | `TIMEOUTS.REVIEWER` (15 min) | base reviewer deadline before scale/effort multipliers |
| `RELEASE_QUALITY_REVIEWER_RETRY_MAX` | `2` | reviewer relaunch attempts |
| `RELEASE_QUALITY_RETRY_BASE_DELAY_MS` | `1000` | retry backoff base |
| `RELEASE_QUALITY_RETRY_MAX_JITTER_MS` | `300` | retry backoff jitter cap |
| `RELEASE_QUALITY_REVIEWER_START_DELAY_MS` | `0` | parallel-mode start delay |
| `RELEASE_QUALITY_REVIEWER_KILL_GRACE_MS` | `5000` | grace period before reviewer kill |
| `REVIEW_AGENT` / `REVIEW_MODEL` / `REVIEW_REASONING_EFFORT` | unset | default reviewer backend (`claude`, `codex` or `zcode`), model, effort; claude/zcode require an explicit model (zcode: GLM-family ids) |

The effective reviewer deadline is
`RELEASE_QUALITY_REVIEWER_TIMEOUT_MS × scale multiplier × effort multiplier`
(`lib/review-utils.mjs` `calculateReviewerTimeout`); a `max`-effort `xlarge`
review therefore runs up to 2 × 2 = 4× the base. Slow CI environments should
raise the base timeout via the environment variable instead of editing the
constants.

## Error message format

User-facing failures follow `[Component] action failed: reason. Try:
suggestion.` (`lib/error-messages.mjs`). Messages are persisted into round
evidence and must remain redaction-safe.
