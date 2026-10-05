# ZCode Reviewer Backend Design

**Date**: 2026-10-05
**Status**: Approved (user-selected "implement now" with documented runtime caveat)
**Scope**: Add `zcode` as the third reviewer backend beside `claude` and `codex`.

## Motivation

The gate's formal approval path (P4.1) requires a real review round from an
authenticated independent agent CLI. On the current macOS host both existing
backends are blocked: `codex` is installed but not logged in, and `claude`
routes through an OpenRouter account without credits. A Z.AI-authenticated
ZCode CLI (0.16.9) is installed, so the gate gains a third backend.

**Runtime caveat (measured, not assumed)**: zcode CLI 0.16.9 headless mode
(`-p`) fails with "Select a model before continuing" — the top-level parser
has no `--model` flag, no environment override exists, and
`defaultModelSelection` written to `~/.zcode/v2/provider_config.json` is not
read by the headless runtime (two provider/model id formats tried). The
backend therefore ships correct-by-construction and fails closed at CLI
parse time until a ZCode CLI build accepts `--model` in headless mode. The
gate's dry-run/validation paths are fully testable today with injected
runners; only the live round waits on the CLI.

## Contract

| Aspect | Decision |
|---|---|
| Backend id | `zcode` |
| Command | `zcode --model <model> -p <prompt>` |
| Model | Required explicitly (like claude); GLM family: `/^glm(?:[-_.].*)?$/i` (`glm-5.3-flash` valid, `claude-*` and `gpt-*` rejected) |
| Reasoning effort | Not applicable (codex-only concept; zcode rejects it, mirroring claude) |
| Auth | File-based, mirroring codex: `reviewerAuthRoots('zcode')` = `ZCODE_CONFIG_DIR` env or `~/.zcode`; the reviewer sandbox home gets `v2/credentials.json` copied in (the credential set may need extension when the CLI runs headless) |
| Sandbox | Unchanged — reviewer runs under the standard seatbelt profile, HOME = reviewer sandbox dir, writes confined to that dir; `requireExactWriteIsolation` stays true (no fixture-execution path for zcode) |
| Round continuity | Round metadata accepts `backend: 'zcode'` alongside claude/codex |
| Doctor | `--agent zcode` accepted; CLI discovery checks PATH then the macOS app bundle (`/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs` run via node); auth is an honest file-presence check (no `auth status` subcommand exists) |

## Files touched

1. `lib/model-selector.mjs` — backend list + GLM model family validation.
2. `scripts/review-runner.mjs` — agent validation, explicit-model rule for
   zcode, `getAgentInvocation` zcode branch, round backend continuity.
3. `scripts/modules/reviewer-auth.mjs` — zcode auth roots + `prepareZcodeHome`.
4. `scripts/modules/reviewer-runtime.mjs` — wire zcode auth into the sandbox.
5. `scripts/doctor.mjs` — zcode discovery, version, file-based auth check.
6. `__tests__/reviewer-auth.test.mjs` + `__tests__/unit.test.mjs` + runner
   dry-run contract tests.
7. Docs: README, `docs/CONFIGURATION.md`, `docs/TESTING.md`, completion report.

## Non-goals

- No fixture-execution mode for zcode (e2e keeps the codex fixture executor).
- No app-server (JSON-RPC) integration — larger surface, revisit if headless
  `-p` never gains model selection.
- No `SUBPROCESS_ENV_ALLOWLIST` additions: the zcode reviewer needs nothing
  beyond the existing candidate env (HOME/TMPDIR isolation already applies).
