# Release Candidate 1.0.0

This repository has no prior release tag, so the existing `1.0.0` package version is the
first release candidate rather than a version bump from an earlier published build.

## Scope

- Reject reviewer test evidence containing non-zero failure counts, including multi-digit counts.
- Bind test, coverage, audit, build, typecheck, and lint evidence to command-specific output summaries.
- Keep reviewer packet command evidence fail-closed across Markdown and YAML-shaped inputs.
- Bind passing reviewer packet summaries to canonical evidence derived from the same persisted Gate round.

## Required approval

Release approval requires the `release-gate` profile to pass for the candidate commit. A tag or
publication must not be created from this candidate until the generated final report records that
all selected reviewers scored at least 90 with no P0/P1 blocker or redline.
