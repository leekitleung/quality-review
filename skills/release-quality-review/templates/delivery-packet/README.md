# Delivery Packet Templates

模板目录结构，对应 `.agent-deliveries/<task-id>/` 下的每个文件。

## 文件说明

| 文件 | 用途 | 必需 | Progressive Phase |
|------|------|------|------------------|
| goal.md | 原始目标 | ✅ | Pre-flight |
| scope.md | 修改范围 | ✅ | Pre-flight |
| metadata.json | 元数据 | ✅ | Pre-flight |
| changes.md | 实际变更 | ✅ | Execution |
| diff-summary.md | diff 摘要 | ✅ | Execution |
| evidence.md | 证据包 | ✅ | Execution |
| risk.md | 风险说明 | ✅ | Execution |
| blockers.md | 问题追踪 | ✅ | Execution |
| handoff.md | 交接说明 | ⚠️ | Handoff |

---

## 使用说明

### 1. 复制模板

```bash
# 创建任务交付目录
mkdir -p .agent-deliveries/<task-id>

# 复制所有模板
cp -r templates/delivery-packet/* .agent-deliveries/<task-id>/
```

### 2. 按阶段填充

```
Pre-flight:  只填写 goal.md, scope.md, metadata.json (partial)
Execution:   填写 changes.md, diff-summary.md, evidence.md, risk.md, blockers.md
Handoff:     填写 handoff.md，更新 metadata.json
```

### 3. 验证

```bash
# 验证 packet 完整性
node scripts/validate-delivery-packet.mjs --packet .agent-deliveries/<task-id>

# 运行评审
node scripts/review-gate.mjs --profile release-gate --packet .agent-deliveries/<task-id>
```
