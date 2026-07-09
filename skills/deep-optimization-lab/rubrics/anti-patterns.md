# Optimization Anti-Patterns

Things that don't work in skill optimization and project quality improvement.

## Anti-Patterns (Blocking)

These patterns block experiment completion:

```
❌ Same agent modifies and judges in same context
   → Use independent evaluator agent or script-based checks
   
❌ Skipping baseline collection
   → Baseline is required before any experiment
   
❌ Running multiple variables in one experiment
   → Single variable per experiment for attribution clarity
   
❌ Using git reset --hard as default revert
   → Use backup directories and manual review
   
❌ Dry run ratio > 30% without flag
   → Flag when dry_run > 30% as unreliable
   
❌ Silent exception swallowing
   → Log all exceptions, fail visibly
   
❌ Self-declaring "improvement" without evidence
   → Require independent evaluation or script measurement
   
❌ Adding redundant code just to raise scores
   → Score improvement must be meaningful, not artificial
```

## Dry Run Anti-Patterns

```
❌ Running experiment as dry_run but claiming conclusive results
❌ Using dry_run to avoid committing to changes
❌ Dry run ratio > 50% (not actually experimenting)
```

## Evaluation Anti-Patterns

```
❌ Evaluating in same context that made the change
❌ Using LLM-as-judge without human verification for critical decisions
❌ Not having test prompts for evaluation
❌ Comparing to wrong baseline (baseline from different project state)
```

## Change Anti-Patterns

```
❌ Changing SKILL.md without updating examples
❌ Adding complexity without measurable benefit
❌ Optimizing for metrics that don't matter to users
❌ Making changes that break backward compatibility without migration
```

## Scoring Anti-Patterns

```
❌ Aiming for score = 100 (impossible in real projects)
❌ Adding redundant comments/documentation just to raise score
❌ Gaming rubric criteria instead of improving actual quality
❌ Ignoring negative feedback to protect score
```

## Recovery Anti-Patterns

```
❌ Reverting without understanding why change failed
❌ Keeping broken changes hoping they'll "work themselves out"
❌ Not logging anti-patterns for future reference
❌ Re-running failed experiment without modifying hypothesis
```
