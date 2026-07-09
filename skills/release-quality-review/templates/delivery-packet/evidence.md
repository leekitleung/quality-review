# Evidence

证据包。

## 执行的命令

```yaml
commands_executed:
  - command: "pnpm build"
    working_dir: "."
    exit_code: 0
    output_summary: "Build completed successfully"
    timestamp: "2026-07-08T10:30:00Z"
    evidence_file: ""  # 可选：输出文件路径

  - command: "pnpm test"
    working_dir: "."
    exit_code: 0
    output_summary: "12 tests passed, 0 failed"
    timestamp: "2026-07-08T10:35:00Z"
```

## 测试结果

```yaml
test_results:
  - suite: "unit"
    passed: 48
    failed: 0
    skipped: 2
    command: "pnpm test"
    exit_code: 0

  - suite: "integration"
    passed: 12
    failed: 0
    skipped: 0
    command: "pnpm test:integration"
    exit_code: 0
```

## 构建结果

```yaml
build_results:
  - target: "main"
    status: SUCCESS
    command: "pnpm build"
    exit_code: 0
```

## Lint 结果

```yaml
lint_results:
  - tool: "eslint"
    errors: 0
    warnings: 2
    command: "pnpm lint"
```

## 手工验证

```yaml
manual_verification:
  - step: "登录流程"
    expected: "登录成功后跳转首页"
    actual: "登录成功后跳转首页"
    passed: true
    evidence: "evidence/screenshot-login.png"
```

## 已知缺口

```yaml
known_gaps:
  - area: "错误处理"
    reason: "网络错误场景未覆盖"
    impact: "低 - 已有通用错误处理"
    tracked_in: "issue-456"
```

---

## 禁止项检查

- [ ] 命令必须包含完整命令文本
- [ ] 必须包含 exit_code
- [ ] 必须包含 output_summary
- [ ] 不能只写"可通过测试验证"

---

## 模板

```markdown
# Evidence

## 执行的命令

```yaml
commands_executed: []
```

## 测试结果

```yaml
test_results: []
```

## 构建结果

```yaml
build_results: []
```

## Lint 结果

```yaml
lint_results: []
```

## 手工验证

```yaml
manual_verification: []
```

## 已知缺口

```yaml
known_gaps: []
```

## 禁止项检查

- [ ] 命令包含 exit_code
- [ ] 命令包含 output_summary
- [ ] 无占位证据
```
