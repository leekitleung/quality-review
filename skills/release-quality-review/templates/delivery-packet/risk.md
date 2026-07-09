# Risk

风险说明。

## 破坏性变更

```yaml
breaking_changes:
  - change: "API 接口签名变更"
    affected_areas:
      - "apps/bridge/src/api.ts"
      - "packages/cli/src/commands.ts"
    mitigation: "提供废弃警告，保持向后兼容"
```

## 回归风险

```yaml
regression_risks:
  - area: "认证流程"
    risk_level: MEDIUM
    test_coverage: "单元测试 100%，集成测试 80%"
```

## 安全考虑

```yaml
security_considerations:
  - consideration: "新增 API 端点需要认证"
    status: ADDRESSED
```

## 兼容性问题

```yaml
compatibility_issues:
  - issue: "Node 18+ required"
    affected_versions:
      - "Node 16"
      - "Node 14"
```

## 回滚方案

```yaml
rollback_plan:
  steps:
    - "git revert <commit>"
    - "pnpm install"
    - "验证回滚成功"
  verification: "运行测试套件，确认通过"
  estimated_time: "5 分钟"
```

---

## 模板

```markdown
# Risk

## 破坏性变更

```yaml
breaking_changes: []
```

## 回归风险

```yaml
regression_risks: []
```

## 安全考虑

```yaml
security_considerations: []
```

## 兼容性问题

```yaml
compatibility_issues: []
```

## 回滚方案

```yaml
rollback_plan:
  steps: []
  verification: ""
  estimated_time: ""
```
