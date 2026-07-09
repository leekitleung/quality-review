# Blockers

问题追踪。

## P0 Blockers (必须修复)

```yaml
p0_blockers:
  - id: "P0-001"
    description: ""
    status: OPEN|RESOLVED
    resolution: ""  # 如果已解决
    evidence: ""    # 解决证据
```

## P1 Blockers (本轮修复)

```yaml
p1_blockers:
  - id: "P1-001"
    description: ""
    status: OPEN|RESOLVED
    resolution: ""
    deadline: ""
```

## P2 Blockers (下个 milestone)

```yaml
p2_blockers:
  - id: "P2-001"
    description: ""
    status: OPEN|DEFERRED
    tracked_in: ""
```

## 状态汇总

```yaml
all_p0_closed: true|false
all_p1_closed: true|false
blocking_release: true|false
```

---

## 模板

```markdown
# Blockers

## P0 Blockers (必须修复)

```yaml
p0_blockers: []
```

## P1 Blockers (本轮修复)

```yaml
p1_blockers: []
```

## P2 Blockers (下个 milestone)

```yaml
p2_blockers: []
```

## 状态汇总

```yaml
all_p0_closed: false
all_p1_closed: false
blocking_release: true
```
