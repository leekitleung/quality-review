# Contributing

## Non-negotiables

1. **Tests + coverage stay green.** `npm test` and `npm run coverage`
   (100% lines/branches/functions) must pass before every commit. See
   [TESTING.md](TESTING.md) for suite layout and conventions.
2. **Fail closed.** Every new execution path must have a defined behavior
   when its preconditions are missing — throwing is the default, not a bug.
   No "best effort" unsandboxed modes, no default-allow allowlists.
3. **Canonical first.** `skills/release-quality-review/` is the only hand
   -edited source. Adapters (`.claude/`, `.agents/`) and `skills.lock.yaml`
   are generated: run `npm run skill:sync` after canonical changes and commit
   the refreshed lock in the same change.
4. **Constants are contracts.** Values in `lib/config-constants.mjs`
   (timeouts, buffers, permissions, scan limits) are reasoned about by the
   gate policy and persisted evidence. Change one only together with the
   tests that observe it. See [CONFIGURATION.md](CONFIGURATION.md).

## Security code standards

Security-relevant modules (`security-utils.mjs`, `candidate-runtime.mjs`,
`verification-script-policy.mjs`, the gate scripts) carry documentation that
states the *invariant*, not the mechanics:

- **Why, not what.** A comment must explain a constraint the code cannot
  show: which attacker it stops, why fail-closed is correct here, why the
  order of operations matters (TOCTOU windows, redaction order), or what
  downstream contract depends on it. If deleting the comment loses no
  information, delete the comment.
- **Error messages follow the standard format**
  `[Component] action failed: reason. Try: suggestion.` via
  `lib/error-messages.mjs`. Messages are persisted into round evidence and
  must stay redaction-safe (`redactSensitiveText` must leave nothing the
  `containsSensitiveText` detector matches).
- **English for user-facing strings.** Functional detection patterns (e.g.
  Chinese claim detection in `evidence-utils.mjs`) are exempt — they match
  reviewer output and are covered by tests.
- **New attack case → new test.** Tightening a check requires the adversarial
  fixture that justifies it (`__tests__/evidence-security.test.mjs`,
  `sandbox-profile.test.mjs`).

## Git conventions

- Small, atomic commits: `fix:` / `feat:` / `refactor:` / `test:` / `docs:`
  / `chore:` prefixes.
- Never mix a behavior change with a lock refresh or a comment pass.
- The gate requires a clean worktree: commit everything before running a
  review round.

## Documentation index

| Document | Purpose |
|---|---|
| [README.md](../README.md) | Overview, install, workflows |
| [docs/examples.md](examples.md) | Copy-paste round workflows and FAQ |
| [docs/TESTING.md](TESTING.md) | Running and writing tests |
| [docs/CONFIGURATION.md](CONFIGURATION.md) | Constants and environment overrides |
| [docs/WINDOWS-SETUP.md](WINDOWS-SETUP.md) | Platform support matrix |
