# Codex Skills

Standalone skills package for Codex and Codex.

## Skills

### release-quality-review
Multi-reviewer quality gate with adversarial review.

```bash
# Quick check
node skills/release-quality-review/scripts/review-gate.mjs --profile quick

# Full release gate
node skills/release-quality-review/scripts/review-gate.mjs --profile release-gate
```

### deep-optimization-lab
Systematic optimization with baseline → experiment → keep/revert cycle.

## Installation

Copy `skills/` directory to your project:

```bash
cp -r skills/ /your-project/.Codex/
```

Or symlink for development:

```bash
ln -s /path/to/skills /your-project/.Codex/skills
```
