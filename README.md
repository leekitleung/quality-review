# Quality Review Skills

Repository-owned Agent Skills with deterministic distribution and release gates.

Requires Node.js 22+ and a Git checkout because candidate identity and rollback
checks depend on Git metadata. Clone the repository, then run `npm install`;
there are no runtime dependencies.

## First successful review

```bash
git clone <repository-url> quality-review
cd quality-review
node --version                 # v22 or newer
git rev-parse --is-inside-work-tree
npm install
npm start                      # prints runner help; it does not start a service

export REVIEW_ROUND=100
npm run review -- --profile quick --round "$REVIEW_ROUND"
# Exit 1 is healthy here while reviewer packets are pending.
# After the listed reviewers write all four packet files:
npm run skill:gate -- --profile quick --round "$REVIEW_ROUND" --no-collect
# Success ends with GATE PASSED and exit 0.
```

Choose `quick` for a small development check, `release-gate` for a normal
release, and `agentic-release-gate` for the full 12-reviewer evidence workflow.
`--base <base-ref>` is the commit before the reviewed change, for example
`--base origin/main` or `--base HEAD~1`.

Terms: the **candidate** is the exact commit/tree being reviewed; a **packet**
is one reviewer's four output files; **evidence binding** ties those files to
the candidate; **resident** reviewers always run, **conditional** reviewers run
when triggered, and **adversarial** reviewers challenge completion claims;
**arbitration** is the final Gate decision. The **host/orchestrator** is the
trusted process that launches reviewers and owns the round.

## Release quality review

The canonical source is `skills/release-quality-review/`. Claude and Codex
adapters are generated from `skill-registry.yaml`; do not edit generated
adapters directly.

```bash
# Regenerate adapters and lock hashes after canonical changes
npm run skill:sync

# Fail on adapter or lock drift, then validate reviewer discovery
npm run skill:check

# Run unit tests plus distribution validation
npm run skill:verify
npm run coverage
npm run test:e2e

# Aggregate reports and execute the release gate
npm run skill:gate -- --profile release-gate
```

The Node runner collects evidence and writes reviewer prompts. Independent
reviewers must be started by the Codex or Claude host and must write the four
required files under `quality-reports/round-NNN/<reviewer>/`; the runner never
synthesizes reviewer scores. Re-run `skill:gate` to aggregate their results.
Passing `--parallel --agent codex` to the runner launches independent ephemeral
Codex CLI reviewers concurrently and fails if any reviewer does not produce all
four files.

The first launch locks each round to its selected backend in
`review-backend.json`. Resume the round with the same `--agent`; backend mixing
fails closed. Parallel mode has no project-level concurrency cap or start delay
unless `RELEASE_QUALITY_REVIEWER_START_DELAY_MS` is explicitly set.

Trust boundary: the host/orchestrator, pinned Gate code, independent reviewers,
and report root are trusted; candidate subprocesses and their output are
untrusted. Stored SHA-256 values detect drift between collection and
arbitration, but are not signatures. A party that can rewrite Gate code,
evidence, and adjacent metadata has crossed the local trust boundary; protect
against that actor with externally signed CI artifacts or a protected remote
runner.

When macOS rejects nested `sandbox-exec`, the trusted host may set
`RELEASE_QUALITY_OUTER_SANDBOX_ATTESTED=1` only after independently enforcing an
equivalent outer filesystem boundary. Without that explicit attestation,
candidate verification fails closed.

Host workflow:

Choose an unused round first; never reuse a tracked or previously generated
round directory:

```bash
export REVIEW_ROUND=100
export REVIEW_ROUND_DIR="round-$(printf '%03d' "$REVIEW_ROUND")"
test ! -e "quality-reports/$REVIEW_ROUND_DIR"
```

1. Run `npm run review -- --profile release-gate --round "$REVIEW_ROUND"` to collect evidence
   and create prompts.
2. In Codex/Claude, launch one independent Agent per listed reviewer. Claude
   adapters are in `.claude/agents/`; canonical definitions are in
   `skills/release-quality-review/reviewers/`.
3. Require each Agent to write `result.yaml`, `score.md`, `blockers.md`, and
   `improvement-list.md` in its round directory. `result.yaml` must bind the
   exact candidate from `git rev-parse HEAD` and `git rev-parse HEAD^{tree}`.
4. Run `npm run skill:gate -- --profile release-gate --round "$REVIEW_ROUND"`. Exit `0` is the
   only release approval; exit `1` means pending or failed review.

For `agentic-release-gate`, use this complete high-assurance workflow:

1. Commit the bounded candidate so evidence can bind an immutable commit/tree.
2. Persist isolated clean-checkout and rollback verification for that same
   commit before any collecting Gate pass:

```bash
npm run skill:verify-clean -- --output "quality-reports/$REVIEW_ROUND_DIR/evidence/clean-candidate.json"
npm run skill:verify-rollback -- --base <base-ref> --output "quality-reports/$REVIEW_ROUND_DIR/evidence/rollback-verification.json"
```

Rollback verification never downloads a package manager. If the rollback base
uses pnpm, the trusted host must pre-provision pnpm `10.33.0` in Corepack's
cache (or set `COREPACK_HOME` to an equivalent read-only cache); verification
fails closed when that pinned toolchain is unavailable.

3. Run the runner with explicit round/base. It creates `phase-N-plan.md`,
   reviewer prompts, `runner-metadata.json`, and initial prompt evidence; its
   Gate pass binds `metadata.json` to the already persisted clean evidence.
   Exit `1` is expected while packets are pending:

```bash
npm run review -- --profile agentic-release-gate --round "$REVIEW_ROUND" --base <base-ref>
```

4. The host writes `generated-goal.md`, `changes.md`, `diff-summary.md`,
   `risk.md`, and `handoff.md`. Their contracts are in
   `skills/release-quality-review/SKILL.md` and
   `skills/release-quality-review/rubrics/delivery-packet.schema.yaml`.
   Validate the Goal, then run a collecting Gate pass; the Gate writes
   `goal-instruction-validation.md`, refreshes `metadata.json` and
   `evidence/automated-checks.json`, and remains exit `1` while reviews are
   pending:

```bash
node skills/release-quality-review/scripts/goal-instruction-gate.mjs \
  --file "quality-reports/$REVIEW_ROUND_DIR/generated-goal.md"
npm run skill:gate -- --profile agentic-release-gate --round "$REVIEW_ROUND" --base <base-ref>
```

5. Launch every resident, triggered conditional, and adversarial reviewer.
   Each follows its canonical definition in
   `skills/release-quality-review/reviewers/` and writes `result.yaml`,
   `score.md`, `blockers.md`, and `improvement-list.md` under the same round.
   Start `result.yaml` from
   `skills/release-quality-review/templates/result.yaml`. Every reviewer must
   declare the exact candidate commit/tree, score at least `90`; any P0/P1
   blocker or redline fails the release, and modified work must use a fresh
   round and be reviewed again.
6. Validate packets, then run final arbitration against persisted evidence:

```bash
node skills/release-quality-review/scripts/evidence-validator.mjs --round "$REVIEW_ROUND_DIR" --base <base-ref>
npm run skill:gate -- --profile agentic-release-gate --round "$REVIEW_ROUND" --base <base-ref> --no-collect
```

Approval exists only when both commands exit `0`. The authoritative approval
report is `quality-reports/$REVIEW_ROUND_DIR/final-report.md`; it is never a shared
cross-round file.

Troubleshooting:

- Drift failure: run `npm run skill:sync`, inspect the diff, then rerun
  `npm run skill:check-drift`.
- Exit `4`: correct invalid CLI/profile/path input.
- Exit `5`: reviewer launch failed or timed out; verify the local Codex/Claude
  CLI, then rerun the same round. Valid packets resume; malformed or incomplete
  packets are invalidated and relaunched automatically.
- Exit `1`: inspect `summary.md`. `reviewer packets pending` is expected before
  reviewers finish; scores below 90, P0/P1 blockers, or failed evidence require
  a fix and a fresh round.
- Missing packet files: every reviewer directory needs `result.yaml`,
  `score.md`, `blockers.md`, and `improvement-list.md`.
- Round identity conflict: do not reuse a round after the candidate changes;
  choose a new positive round number.
- Persisted-evidence mismatch: rerun `skill:verify-clean` first, then rerun the
  collecting Gate command so `metadata.json` binds the same clean evidence.

`skills.lock.yaml` records canonical and adapter SHA-256 hashes. CI runs the
drift check, tests, syntax validation, and review-gate dry-run.
