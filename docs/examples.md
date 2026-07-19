# Review Examples and FAQ

Run `npm run doctor -- --agent codex` first. It checks Node.js, Git, workspace access,
the selected Agent CLI, and authentication, then prints the recommended next command.

## 1. Small local change

```bash
npm run review -- --profile quick --round 101 --base HEAD~1 --agent codex
```

Use this for fast development feedback. Exit `0` approves the exact candidate commit/tree.

## 2. Normal release

```bash
npm run review -- --profile release-gate --round 102 \
  --base origin/main --agent codex --parallel
```

This collects test, typecheck, build, lint, audit, coverage, and E2E evidence, launches
the resident and diff-triggered reviewers, and performs final arbitration.

## 3. High-assurance agentic release

Follow the artifact preparation steps in the README, then run:

```bash
npm run review -- --profile agentic-release-gate --round 103 \
  --base origin/main --agent codex --parallel
```

Agentic mode adds adversarial reviewers plus clean-candidate, rollback, Goal, risk, and
handoff evidence. It is intended for xlarge or high-risk changes.

## FAQ

**Which terms matter for the first quick review?** A candidate is the exact commit/tree
being checked. A reviewer packet is one reviewer's four result files. The Gate approves
only when every required check passes.

**What can wait until release work?** Conditional and adversarial reviewer selection,
evidence binding, and arbitration details matter when operating release or agentic profiles.

**Can I reuse a round after changing code?** No. Commit the new candidate and choose a fresh
positive round number so evidence and reviewer packets cannot cross candidate identities.

**How do I audit report retention?** Run `npm run reports:retention-check -- --days 30`.
The check is non-destructive and exits nonzero when old rounds need review. After approval,
delete exactly those expired round directories with
`npm run reports:retention-check -- --days 30 --delete --confirm DELETE-EXPIRED-ROUNDS`;
the command validates every target and appends a local deletion audit record.
