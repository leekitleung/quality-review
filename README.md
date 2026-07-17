# Quality Review Skills

Repository-owned Agent Skills with deterministic distribution and release gates.

Requires Node.js 22+ and a Git checkout because candidate identity and rollback
checks depend on Git metadata. Clone the repository, then run `npm install`;
there are no runtime dependencies.

Reviews require one supported Agent CLI. Install and authenticate either Codex
or Claude before the quickstart, then verify the selected backend:

```bash
# Codex backend
codex --version
codex login status

# Or Claude backend
claude --version
claude auth status
```

The review command automatically launches reviewer processes; it is not a
collection-only command. Every actual review requires `--agent`. Claude also
requires an explicit compatible `--model`. Codex accepts an explicit model or,
when the model is omitted, selects from the fresh Codex Radar public summary.
`quick`/`default` prefer lightweight (`low`/`medium`) combinations above IQ
100, then any combination above IQ 100; release, full, and agentic profiles use
the global highest-IQ combination. When every candidate is at or below 100,
all profiles use the highest score. If Radar cannot be used, the command exits 4 so the host Agent can
choose and rerun with `--model`; it never silently applies a fixed fallback.

## First successful review

```bash
git clone <repository-url> quality-review
cd quality-review
node --version                 # v22 or newer
git rev-parse --is-inside-work-tree
npm install
npm start                      # prints runner help; it does not start a service

export REVIEW_ROUND=100
npm run review -- --profile quick --round "$REVIEW_ROUND" \
  --agent codex
# The runner launches every quick-profile reviewer and arbitrates the round.
# Exit 0 is approval; exit 1 means the completed review failed its score/Gate.
```

Choose `quick` for a small development check, `release-gate` for a normal
release, and `agentic-release-gate` for the 8-to-12-reviewer adversarial evidence
workflow. Agentic reviews always run the four resident and four adversarial
reviewers; UI, documentation, CLI, and data-security reviewers run only when
their declared diff triggers match.
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

The Node runner collects evidence, writes prompts, and starts independent
reviewer processes through the selected Codex or Claude CLI. Each process must
write four files under `quality-reports/round-NNN/<reviewer>/`; the runner never
synthesizes reviewer scores. Sequential mode starts them one at a time;
`--parallel` starts them concurrently and fails if any reviewer does not produce
all four files.

The first launch locks each round to its selected backend, model, reasoning
effort, and selection evidence in `review-backend.json`. A resume with no model
reuses that lock without consulting Radar again; explicit backend, model, or
effort drift fails closed. Parallel mode has no project-level
concurrency cap or start delay
unless `RELEASE_QUALITY_REVIEWER_START_DELAY_MS` is explicitly set.

Trust boundary: the host/orchestrator, pinned Gate code, independent reviewers,
and report root are trusted; candidate subprocesses and their output are
untrusted. Stored SHA-256 values detect drift between collection and
arbitration, but are not signatures. A party that can rewrite Gate code,
evidence, and adjacent metadata has crossed the local trust boundary; protect
against that actor with externally signed CI artifacts or a protected remote
runner.

When macOS rejects nested `sandbox-exec`, candidate verification fails closed.
An environment variable cannot substitute for an enforced filesystem boundary.
Run collection from a normal macOS host shell or CI runner that can create the
outer sandbox. Running the review command from inside another workspace sandbox
may be unsupported; the CLI reports the underlying sandbox capability error and
must not describe a clean checkout as dirty. Exit that outer sandbox and resume
the same round with the same backend; an omitted model reuses the locked model
and reasoning effort.

Review evidence is local release metadata, not an account or analytics store.
It may contain repository paths, Git identities, and redacted command output.
The release operator owns retention and should delete `quality-reports/round-*`
after the applicable audit or release-retention window. Export only the bound
round directory, use encrypted artifact storage when evidence leaves the host,
and delete exported copies through that storage provider. GDPR/CCPA obligations
apply only when repository paths or command output contain personal data; avoid
putting personal data in source paths or verifier output. Local report files use
restrictive permissions but are not content-encrypted, so the host should use
full-disk encryption for at-rest protection.

Host workflow:

Choose an unused round first; never reuse a tracked or previously generated
round directory:

```bash
export REVIEW_ROUND=100
export REVIEW_ROUND_DIR="round-$(printf '%03d' "$REVIEW_ROUND")"
test ! -e "quality-reports/$REVIEW_ROUND_DIR"
```

Run the release gate with automatic Codex model selection:

```bash
npm run review -- --profile release-gate --round "$REVIEW_ROUND" \
  --agent codex
```

Use `--model <name> --reasoning-effort <effort>` to override Codex auto-selection.
Use `--agent claude --model <claude-model>` when selecting Claude. For an
authorized or manually captured source, pass a repository-relative
`--radar-snapshot <file>`. Online Radar integration records the required
attribution, `数据来自 Codex 雷达 codexradar.com`, in the round lock. The runner
does not grant data-usage rights; operators must obtain any authorization that
Codex Radar requires for derivative integrations before enabling online use.
The runner collects evidence, automatically launches one
independent process per reviewer, validates their four-file packets, and
arbitrates the round. Exit `0` is the only approval; exit `1` means the completed
review failed its score or Gate, and exit `5` means an Agent process failed.

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

3. Before any reviewer launches, the host writes `generated-goal.md`,
   `changes.md`, `diff-summary.md`, `risk.md`, and `handoff.md`. Their contracts are in
   `skills/release-quality-review/SKILL.md` and
   `skills/release-quality-review/rubrics/delivery-packet.schema.yaml`.
   Validate the Goal:

```bash
node skills/release-quality-review/scripts/goal-instruction-gate.mjs \
  --file "quality-reports/$REVIEW_ROUND_DIR/generated-goal.md"
```

4. Run the runner with backend, round, and base. It binds evidence,
   launches every required reviewer using only that backend, validates their
   packets, and arbitrates the round. `--parallel` starts them without a project
   concurrency cap:

```bash
npm run review -- --profile agentic-release-gate --round "$REVIEW_ROUND" \
  --base <base-ref> --agent codex --parallel
```

5. Validate packets, then rerun final arbitration against persisted evidence:

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
- Exit `1`: inspect `summary.md`; scores below 90, P0/P1 blockers, or failed
  evidence require a fix and a fresh round.
- Missing packet files: every reviewer directory needs `result.yaml`,
  `score.md`, `blockers.md`, and `improvement-list.md`.
- Round identity conflict: do not reuse a round after the candidate changes;
  choose a new positive round number.
- Persisted-evidence mismatch: rerun `skill:verify-clean` first, then rerun the
  collecting Gate command so `metadata.json` binds the same clean evidence.
- `outer sandbox capability check failed closed`: run from a normal macOS host
  shell or supported CI runner, not from inside another workspace sandbox; then
  resume the same round with its locked backend and model.

`skills.lock.yaml` records canonical and adapter SHA-256 hashes. CI runs the
drift check, tests, syntax validation, and review-gate dry-run.
