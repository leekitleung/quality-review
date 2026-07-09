# Quality Review Summary - Round 1

**Profile:** release-gate
**Generated:** 2026-07-09T10:08:55.535Z
**Git:** "" @ ""
## Automated Gate Checks

| Check | Status | Details |
|-------|--------|--------|
| pnpm test | ✅ pass | Tests passed |
| pnpm typecheck | ❌ fail | Command failed: pnpm typecheck 2>&1 |
| File sizes | ✅ 0 oversized | OK |
| Circular deps | ✅ | None found |
| Secrets scan | ✅ | Clean |

---

## Scores

| Reviewer | Score | Status | Blockers |
|----------|-------|--------|----------|
| product-flow | - | ⏳ PENDING | - |
| architecture-maintainer | - | ⏳ PENDING | - |
| release-verifier | - | ⏳ PENDING | - |
| destructive-qa | - | ⏳ PENDING | - |

**Total:** 0/4 passed, 0 blockers

---

## ❌ QUALITY GATE FAILED

This release has not passed quality gates. Fix the issues below and re-run review.

**To continue:**
```bash
node skills/release-quality-review/scripts/review-runner.mjs --profile release-gate --round 2
```

