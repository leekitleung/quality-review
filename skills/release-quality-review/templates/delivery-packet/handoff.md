# Handoff

交接说明 - 记录未完成项、后续跟进和回滚方案。

## 交付链追溯 (Delivery Traceability)

Claim 到 Diff 的映射：

```yaml
claims_to_diff_map:
  - claim: "支持多执行器协作"
    diff_files:
      - "packages/multi-executor/index.ts"
      - "packages/multi-executor/types.ts"
    evidence_ref: "evidence.md#commands-executed"
  - claim: "添加执行超时机制"
    diff_files:
      - "packages/executor-core/timeout.ts"
    evidence_ref: "evidence.md#test-timeout"
```

## 未完成项 (Incomplete Items)

```yaml
incomplete_items:
  - item: "性能监控 Dashboard"
    reason: "不在原始 scope 中"
    deferred_to: "task-002"
    tracked_in: "issue-789"
  - item: "E2E 测试补全"
    reason: "需要 UI 组件就位后才能测试"
    deferred_to: "2026-07-15"
    tracked_in: "issue-456"
```

## 后续跟进 (Follow-up Required)

```yaml
follow_up_required:
  - item: "添加更多边界测试"
    owner: "@developer"
    deadline: "2026-07-15"
    verification: "pnpm test 100% pass"
    blocking: true  # 阻塞发布
```

## 回滚方案 (Rollback Plan)

```yaml
rollback_plan:
  verified: true
  estimated_time: "5 分钟"
  scope: "只影响 packages/multi-executor"
  steps:
    - command: "git checkout HEAD~1 -- packages/multi-executor"
      description: "回滚 multi-executor 目录到上一个稳定版本"
    - command: "pnpm install && pnpm build"
      description: "重新构建验证"
    - command: "pnpm test"
      description: "运行测试验证回滚成功"
  verification:
    - "所有测试通过"
    - "原有功能正常"
```

## 回滚验证

```yaml
rollback_verified: true
rollback_date: "2026-07-08"
rollback_tester: "@reviewer"
```

---

## 模板

```markdown
# Handoff

## 交付链追溯

```yaml
claims_to_diff_map: []
```

## 未完成项

```yaml
incomplete_items: []
```

## 后续跟进

```yaml
follow_up_required: []
```

## 回滚方案

```yaml
rollback_plan:
  verified: false
  estimated_time: ""
  scope: ""
  steps: []
  verification: []
```

## 回滚验证

```yaml
rollback_verified: false
```
