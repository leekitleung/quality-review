# Testing Guide

## Layout

| Path | Scope |
|---|---|
| `skills/release-quality-review/__tests__/*.test.mjs` | gate, evidence, sandbox, and script-contract tests |
| `skills/deep-optimization-lab/__tests__/cli.test.mjs` | optimization lab CLI |

All suites run on the Node built-in test runner — no test framework
dependency:

```bash
npm test              # every suite (unit + integration + e2e-tagged)
npm run test:e2e      # only tests matching /E2E/ in gate-e2e.test.mjs
npm run coverage      # suite with line/branch/function coverage report
```

Run one file directly while debugging:

```bash
node --test skills/release-quality-review/__tests__/evidence-security.test.mjs
```

## Coverage requirement

`npm run coverage` measures `skills/release-quality-review/**/*.mjs` and
`scripts/*.mjs`, excluding `__tests__`, with thresholds 75% lines /
60% branches / 75% functions. The suite holds **100% across all three**;
treat any drop as a regression. Note that only modules *imported by a test*
appear in the report — a new lib module with no importing test silently
evades the gate, so every new module ships with a test that loads it.

## Conventions

- Tests import production code from `lib/` and `scripts/modules/` — no
  simplified reimplementations of the logic under test.
- Each file defines tiny local helpers (`assertEqual`, `assertTrue`,
  `assertRejects`) instead of pulling an assertion library.
- Security tests assert both the success path and the fail-closed path
  (e.g. sandbox unavailable, canary invalid, path escape).
- Error-message contracts are pinned by tests; if you change a message,
  update the test in the same commit.

## Platform behavior

Four suites (`gate-e2e`, `gate-policy`, `reviewer-selection`,
`runner-lifecycle`) build POSIX git-wrapper fixtures and exit early on
Windows via a `process.platform === 'win32'` guard at the top of the file.
On Windows native the guarded files contribute no subtests and the remaining
suites pass (`0 fail`, one macOS-specific sandbox test skips); WSL2 and macOS
run everything. See `docs/WINDOWS-SETUP.md` before assuming a Windows
failure is a product bug.

## Adding a test

1. Pick the closest existing file (sandbox/evidence → `evidence-security`,
   gate policy → `gate-policy`, CLI lifecycle → `runner-lifecycle`) or start
   a new `*.test.mjs`; the glob in `package.json` picks it up automatically.
2. Import the production module you are testing.
3. Cover the happy path, the rejected-input path, and — for security code —
   the fail-closed path.
4. `npm test` and `npm run coverage` must both stay green before commit.

## Known fixture notes

- Evidence fixtures build a synthetic ROLLBACK_COMMANDS transcript; the
  outputs array must stay aligned with `CLEAN_CANDIDATE_COMMANDS` /
  `ROLLBACK_COMMANDS` in `lib/verification-script-policy.mjs` — a length
  mismatch is a fixture bug, not a gate bug.
- Secret-scanner fixtures use deliberately fake credentials; keep them
  obviously synthetic so the scanner's real patterns keep matching.
