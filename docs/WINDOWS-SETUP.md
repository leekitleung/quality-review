# Windows Setup Guide

The release-quality-review skill isolates the **candidate** (the code under
review) and every **reviewer** subprocess behind an enforced filesystem
boundary. That boundary is provided by macOS `sandbox-exec`, or by a Linux
container verified through outer-sandbox attestation canaries. Windows has no
equivalent mechanism in this codebase, so sandboxed execution **fails closed**
there instead of running unsandboxed.

This guide separates what you can do natively on Windows from what requires
WSL2, a container, or macOS.

## Platform support matrix

| Capability | Windows native | WSL2 | macOS | Linux container (attested) |
|---|---|---|---|---|
| Unit tests (`npm test`) | all pass except POSIX fixture suites | full suite | full suite | full suite |
| `npm run typecheck` / `lint` | ✅ | ✅ | ✅ | ✅ |
| `npm run skill:sync` / `skill:check-drift` | ✅ | ✅ | ✅ | ✅ |
| `npm run build` (package verification) | ✅ | ✅ | ✅ | ✅ |
| Candidate evidence collection | ❌ fails closed | ❌ fails closed* | ✅ | ✅ |
| Reviewer execution | ❌ fails closed | ❌ fails closed* | ✅ | ✅ |
| `skill:verify-clean` / `skill:verify-rollback` | ❌ fails closed | ❌ fails closed* | ✅ | ✅ |

\* WSL2 is Linux without `/.dockerenv`, so the container path does not apply
unless the gate itself runs inside a container. Use WSL2 for development and
testing, and run gate collection on macOS or inside an attested container.

## Recommended environments

1. **macOS host or CI runner** — full gate, native `sandbox-exec`.
2. **Linux container with outer-sandbox attestation** — full gate inside
   Docker (the container must provide the attestation canaries described in
   `skills/release-quality-review/lib/security-utils.mjs`).
3. **WSL2** — development, tests, sync, and package verification. Full-coverage
   test runs (122/122) including the POSIX git-wrapper fixtures.
4. **Windows native** — tests (minus POSIX fixtures), typecheck, skill sync,
   and package verification only.

## Running the test suite on Windows

```powershell
npm test
```

Four test files (`gate-e2e`, `gate-policy`, `reviewer-selection`,
`runner-lifecycle`) create git wrapper fixtures that require a POSIX shell and
exit early on Windows:

```
Skipping POSIX fixture tests on Windows - use WSL2
```

This is expected, not a failure. The suite reports `0 fail` with one
macOS-specific sandbox test skipped; the four guarded files contribute no
subtests. Under WSL2 the same command runs every suite in full.

## Why the gate fails closed on Windows

Candidate commands are wrapped by `wrapCandidateCommand`
(`skills/release-quality-review/lib/security-utils.mjs`):

- **macOS** — commands run under `/usr/bin/sandbox-exec` with a generated
  seatbelt profile.
- **Linux** — only when already inside a container (`/.dockerenv` present)
  *and* outer-sandbox attestation canaries are provided and verified. The
  canary probe re-checks, at spawn time, that reads of the read-canary fail
  and writes to the write-canary fail.
- **Everything else, including Windows** — the gate throws:

  ```
  [Sandbox] candidate initialization failed: candidate filesystem sandbox
  is unavailable on win32. Try: run on macOS, or inside an attested Linux
  container
  ```

Proceeding without isolation would let candidate code modify trusted
repository files or leak credentials, so there is deliberately no
"best effort" mode. An environment variable cannot substitute for an enforced
filesystem boundary.

## Known Windows-specific behaviors

- `npm run build` (`scripts/verify-package.mjs`) resolves the npm CLI through
  `npm_execpath` and invokes it via the current Node executable, so package
  verification works without a POSIX shell.
- `scripts/sync-skills.mjs` tolerates CRLF line endings in skill frontmatter;
  check out with `core.autocrlf=input` if you see pure line-ending churn in
  `git diff`.
- Report file permissions (`0o700` directories, `0o600` files) are POSIX
  semantics; NTFS ignores them. Treat the report directory's ACL as the
  effective boundary on Windows.

## Quick start (WSL2)

```bash
# From the repository root inside WSL2
npm install
npm test              # 122/122
npm run typecheck
npm run skill:check-drift
```

For a real review round, either use macOS, or run the gate inside a container
that supplies the outer-sandbox attestation environment.
