# Deep Optimization Lab

A systematic skill optimization and project quality improvement system. After passing the `release-quality-review` gate, this skill runs controlled experiments to continuously improve quality along multiple dimensions.

## Core Philosophy

**"Improve with evidence, revert without hesitation."**

Unlike `release-quality-review` which gates pass/fail, `deep-optimization-lab` runs iterative experiments:
- Collect baseline metrics
- Run single-variable experiments
- Measure improvement with independent evaluation
- Keep effective changes, revert ineffective ones
- Log all decisions for traceability

## Key Principles (from darwin-skill, adapted)

```
1. BASELINE FIRST: Never experiment without a baseline
2. SINGLE VARIABLE: Change only one thing per experiment
3. TEST PROMPTS: Every experiment needs evaluation prompts
4. INDEPENDENT JUDGE: Never self-evaluate in the same context
5. REVERT ON NOISE: If no improvement, revert immediately
6. HUMAN CHECKPOINT: Major decisions need human confirmation
7. DRY_RUN WARNING: Flag when dry_run ratio is too high
8. NO SILENT SKIPS: Log all exceptions, don't hide failures
```

## Quality Assurance Principles

This skill implements the five core quality principles:

### 1. Goal Mode Constraint
Experiments describe the **final state** (target metrics), not the steps to get there.
```
❌ Bad: "Add error handling to the function"
✅ Good: "Error rate < 1%, all errors logged with context"
```

### 2. Execution Gate
All experiments must produce **real evidence** before claiming success:
- Actual test output
- Build success/failure
- File changes committed
- Metrics measured, not estimated

### 3. Adversarial Review
Independent evaluation prevents self-certification:
- Baseline evaluator ≠ Experiment evaluator
- Reviewer cannot reference code they wrote
- Must cite external evidence (existing files, prior reports)

### 4. Persistent Handoff
Every phase writes its state to disk for human review:
```
experiment-logs/
├── baseline.yaml          # Starting metrics
├── experiment-001/
│   ├── hypothesis.md      # What to test
│   ├── change.patch       # What changed
│   ├── evaluation.md      # Independent assessment
│   └── decision.yaml      # KEEP or REVERT with evidence
└── decision-log.yaml      # Full decision history
```

### 5. Right-Size Throttle
Experiment complexity matches change scope:
| Change Size | Files | Lines | Experiment Type |
|-------------|-------|-------|-----------------|
| Micro | 1-2 | <100 | Quick hypothesis test |
| Small | 3-5 | <500 | Standard single-variable |
| Medium | 6-20 | <2000 | Full experiment with control |
| Large | 21-50 | <5000 | Multi-round with validation |
| XLarge | 50+ | 5000+ | Full process with human checkpoint |

## When to Use

Use `deep-optimization-lab` after:
- ✅ `release-quality-review` gate passed (all reviewers >= 90)
- ✅ Code changes are complete and tested
- ✅ You want to systematically improve quality beyond "passing"

Do NOT use when:
- ❌ Gate hasn't passed yet (fix issues first)
- ❌ Time is limited (experiments take multiple rounds)
- ❌ Changes are trivial (use simple improvement)

## Two Optimization Targets

### A. `skill-quality` (optimize SKILL.md itself)
Used when developing Claude/Codex skills. Ensures skill definitions are effective.

### B. `project-quality` (optimize project completeness)
Used after completing features. Improves:
- Product flow
- Architecture
- Terminal/CLI experience
- Extension UX
- Local bridge reliability
- Security posture
- Test coverage
- Documentation
- Release process

## Experiment Workflow

```
┌─────────────────────────────────────────────────────────────┐
│  1. BASELINE                                               │
│     - Run baseline-collector.mjs                           │
│     - Capture current scores, metrics, behavior             │
│     - Store in experiment-logs/baseline.yaml               │
└─────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────┐
│  2. HYPOTHESIS                                             │
│     - Identify ONE dimension to improve                     │
│     - Write hypothesis: "If I change X, then Y will improve"│
│     - Define test prompt to measure Y                      │
└─────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────┐
│  3. EXPERIMENT                                             │
│     - Make single change                                    │
│     - Run test prompt with change                          │
│     - Compare to baseline                                  │
│     - Score improvement (independent evaluation)          │
└─────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────┐
│  4. DECISION                                               │
│     - Improvement >= 10%: KEEP                              │
│     - Improvement < 10%: REVERT                            │
│     - Improvement negative: REVERT + log as anti-pattern   │
│     - Log decision to decision-log.yaml                    │
└─────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────┐
│  5. ITERATE                                                │
│     - Next experiment: next dimension                       │
│     - Or human checkpoint for major changes                │
└─────────────────────────────────────────────────────────────┘
```

## Usage

### Claude Code
```
Please run deep-optimization-lab with profile: project-quality
```

### Command Line
```bash
# Run baseline collection
node skills/deep-optimization-lab/scripts/baseline-collector.mjs --profile project-quality

# Run a single experiment
node skills/deep-optimization-lab/scripts/experiment-runner.mjs --hypothesis "improve-cli-help-text" --profile project-quality

# View decision log
node skills/deep-optimization-lab/scripts/decision-log.mjs --show
```

### Integration with release-quality-review
```bash
# After release gate passes:
node skills/release-quality-review/scripts/review-gate.mjs --round 3 --profile release-gate
# If PASS:
node skills/deep-optimization-lab/scripts/baseline-collector.mjs --profile project-quality
# Then iterate experiments...
```

## Anti-Patterns (Redlines)

These block experiment completion:
```
❌ Same agent modifies and judges in same context
❌ Skipping baseline collection
❌ Running multiple variables in one experiment
❌ Using git reset --hard as default revert
❌ Dry run ratio > 30% without flag
❌ Silent exception swallowing
❌ Self-declaring "improvement" without evidence
❌ Adding redundant code just to raise scores
```

## Output

Experiments are logged to `experiment-logs/`:
- `baseline.yaml` - Starting metrics
- `experiment-001/` - First experiment
  - `hypothesis.md`
  - `change.patch`
  - `evaluation.md`
  - `decision.yaml` (KEEP or REVERT)
- `experiment-002/`
- ...
- `decision-log.yaml` - All decisions with timestamps
- `anti-patterns.md` - Things that didn't work

## Profiles

### `skill-quality`
Optimize SKILL.md and skill definitions.
- Test prompt effectiveness
- Instruction clarity
- Example quality
- Workflow completeness

### `project-quality`
Optimize overall project quality.
- Code organization
- CLI/terminal UX
- Extension usability
- Test coverage
- Documentation completeness
- Security posture

## Success Criteria

An experiment is successful if:
1. Baseline collected before change
2. Single variable changed
3. Independent evaluation run
4. Decision logged with evidence
5. Change kept or reverted based on evidence

Not successful if:
- Score improved but no evidence
- Multiple variables changed
- Exception silently skipped
- Dry run ratio > 30%
