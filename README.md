# Quality Review Skills

Repository-owned Agent Skills with deterministic distribution and release gates.

Requires Node.js 22+. Install repository metadata with `npm install`; there are
no runtime dependencies.

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

# Aggregate reports and execute the release gate
npm run skill:gate -- --profile release-gate
```

The Node runner collects evidence and writes reviewer prompts. Independent
reviewers must be started by the Codex or Claude host and must write the four
required files under `quality-reports/round-NNN/<reviewer>/`; the runner never
synthesizes reviewer scores. Re-run `skill:gate` to aggregate their results.
Passing `--parallel` to the runner launches independent ephemeral Codex CLI
reviewers concurrently and fails if any reviewer does not produce all four files.

Host workflow:

1. Run `npm run review -- --profile release-gate --round 1` to collect evidence
   and create prompts.
2. In Codex/Claude, launch one independent Agent per listed reviewer. Claude
   adapters are in `.claude/agents/`; canonical definitions are in
   `skills/release-quality-review/reviewers/`.
3. Require each Agent to write `result.yaml`, `score.md`, `blockers.md`, and
   `improvement-list.md` in its round directory.
4. Run `npm run skill:gate -- --profile release-gate --round 1`. Exit `0` is the
   only release approval; exit `1` means pending or failed review.

For `agentic-release-gate`, commit the bounded candidate and persist isolated
clean-checkout verification before final arbitration:

```bash
npm run skill:verify-clean -- --output quality-reports/round-001/evidence/clean-candidate.json
```

Troubleshooting:

- Drift failure: run `npm run skill:sync`, inspect the diff, then rerun
  `npm run skill:check-drift`.
- Exit `4`: correct invalid CLI/profile/path input.
- Exit `5`: the local Codex CLI required for parallel reviewer launch is unavailable.

`skills.lock.yaml` records canonical and adapter SHA-256 hashes. CI runs the
drift check, tests, syntax validation, and review-gate dry-run.
