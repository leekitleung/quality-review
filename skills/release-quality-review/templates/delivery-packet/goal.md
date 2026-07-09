# Goal

原始任务目标。

## 原始 Goal 文本

> 在此粘贴原始的 goal 指令...

## 验收标准 (Acceptance Criteria)

```yaml
acceptance_criteria:
  - criterion: ""
    verifiable: true|false
    evidence_required:
      - ""
```

### 示例

```yaml
acceptance_criteria:
  - criterion: "pnpm test 必须全部通过"
    verifiable: true
    evidence_required:
      - "test 命令输出"
      - "退出码 = 0"

  - criterion: "构建产物大小 < 500KB"
    verifiable: true
    evidence_required:
      - "build 输出"

  - criterion: "用户体验流畅"
    verifiable: false
    evidence_required:
      - "手工验证步骤"
```

## 完成判定

```yaml
completion_verdict: PASS|FAIL|PARTIAL

# 如果 PARTIAL，必须填写以下字段：
# partial_reason: ""
# completed_items:
#   - ""
# incomplete_items:
#   - ""
```

## 禁止项检查

检查 goal.md 是否包含禁止内容：

- [ ] 不包含 "第一步"、"然后"、"接下来" 等流程词
- [ ] 不包含 "我"、"我们要" 等主语
- [ ] 不包含无法量化的描述词
- [ ] 目标状态可验证

---

## 模板

```markdown
# Goal

## 原始 Goal 文本

> 在此粘贴原始的 goal 指令...

## 验收标准

```yaml
acceptance_criteria:
  - criterion: ""
    verifiable: true|false
    evidence_required:
      - ""
```

## 完成判定

```yaml
completion_verdict: PASS|FAIL|PARTIAL
```

## 禁止项检查

- [ ] 不包含流程词
- [ ] 不包含主观主语
- [ ] 目标可验证
```
