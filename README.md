# Quality Review Skills

Repository-owned Agent Skills with deterministic distribution and release gates.

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

# Execute the release gate
npm run skill:gate -- --profile release-gate
```

`skills.lock.yaml` records canonical and adapter SHA-256 hashes. CI runs the
drift check, tests, syntax validation, and review-gate dry-run.
