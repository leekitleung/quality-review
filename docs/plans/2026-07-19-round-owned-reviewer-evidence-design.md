# Round-owned reviewer evidence design

## Goal

A passing reviewer packet must cite at least one command result that is derived from and exactly
matches the current round's persisted `evidence/automated-checks.json`. Reviewer-authored text must
not create new runtime evidence.

## Design

One shared module owns the reviewer evidence contract. It derives a short canonical summary from
each supported, successful Gate command record, renders the exact `Command / Exit code / Output`
blocks inserted into reviewer prompts, parses those blocks from reviewer Markdown, and validates
them against the same round-owned records. Test commands retain their final tests/pass/fail counts;
coverage retains the all-files totals; audit retains the zero-vulnerability result; code checks use
a deterministic syntax-check summary. Unsupported, failed, contradictory, or non-matching records
produce no canonical reviewer evidence.

The runner loads persisted automated checks together with candidate metadata. Prompt generation and
packet validation receive that immutable round scope. A `status: pass` packet is accepted only when
at least one cited block exactly matches a canonical record and all runtime success claims are bound.
The standalone evidence validator uses the same contract. Delivery-packet YAML remains a separate
handoff schema and cannot authorize reviewer pass.

## Boundaries

- Extract prompt rendering and packet validation from `review-runner.mjs` into focused modules.
- Do not redesign result.yaml, delivery-packet YAML, reviewer scoring, or Gate command execution.
- Do not add cryptographic signing; the documented local trust boundary remains unchanged.
- Address documentation/security reviewer deductions only where they directly describe this flow.

## Verification

- Unit tests cover canonical summaries, rendering, exact matching, and mismatches.
- Runner/E2E tests prove invented test counts are rejected against persisted round evidence.
- Existing resume, retry, evidence validation, and final arbitration tests remain green.
- `npm test`, typecheck, build, coverage, audit, E2E, and the final Codex gpt-5.4 release gate pass.
