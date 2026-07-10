# Review Orchestrator - Claude Code Adapter

Bridges the `release-quality-review` skill to Claude Code's subagent system.

## Usage

```
/review --profile release-gate
```

Or directly via dialogue:
```
请运行 release-quality-review skill，profile 为 release-gate
```

## Command Mapping

| Command | Script |
|---------|--------|
| `/review --profile quick` | `node skills/release-quality-review/scripts/review-gate.mjs --profile quick` |
| `/review --profile release-gate` | `node skills/release-quality-review/scripts/review-runner.mjs --profile release-gate` |
| `/review --detect-scale` | `node skills/release-quality-review/scripts/review-gate.mjs --detect-scale` |

## Subagent Definitions

Each generated reviewer in `.claude/agents/` is a Claude Code subagent adapter.
`skills/release-quality-review/reviewers/` contains the canonical definitions.
Run `npm run skill:sync` after canonical changes and `npm run skill:check-drift`
before review or release.
