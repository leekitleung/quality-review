# Changes

本次变更说明。

## 一句话变更总结

> 一句话描述本次变更...

## 详细变更说明

```yaml
detailed_changes:
  - area: "核心功能"
    before: "之前的状态..."
    after: "变更后的状态..."
    rationale: "为什么这样改..."

  - area: "API 变更"
    before: "之前..."
    after: "之后..."
    rationale: "..."
```

## 声称具备的能力

本次交付声称具备的能力：

```yaml
claimed_capabilities:
  - capability: "支持多执行器协作"
    supported_by: "packages/multi-executor/index.ts"
```

---

## 禁止项检查

- [ ] 不包含大量解释但缺少实际变更说明
- [ ] 不把既有能力归到本次交付
- [ ] claim 有对应的 diff 文件支撑

---

## 模板

```markdown
# Changes

## 一句话变更总结

>

## 详细变更说明

```yaml
detailed_changes: []
```

## 声称具备的能力

```yaml
claimed_capabilities: []
```

## 禁止项检查

- [ ] 无过度解释
- [ ] claim 有 diff 支撑
```
