# Scope

修改范围定义。

## 允许修改的文件/目录

```yaml
allowed_files:
  - path: "apps/bridge/src/"
    reason: "实现核心功能"
  - path: "packages/types/src/"
    reason: "添加类型定义"
```

## 实际修改的文件

```yaml
modified_files:
  - path: "apps/bridge/src/index.ts"
    change_type: MODIFY
    lines_added: 50
    lines_deleted: 10

  - path: "apps/bridge/src/utils.ts"
    change_type: ADD
    lines_added: 30
    lines_deleted: 0
```

## 禁止修改的文件/目录

```yaml
forbidden_files:
  - path: "apps/production/"
    reason: "生产环境代码不可修改"
  - path: "packages/legacy/"
    reason: "遗留代码，保持原样"
```

## 禁止范围偏差说明

如果修改了禁止范围，必须说明原因：

```yaml
forbidden_deviation:
  - file: "apps/production/config.ts"
    reason: "修复生产环境紧急 bug"
    approved_by: ""  # 如果有审批人
```

---

## 模板

```markdown
# Scope

## 允许修改的文件/目录

```yaml
allowed_files:
  - path: ""
    reason: ""
```

## 实际修改的文件

```yaml
modified_files:
  - path: ""
    change_type: ADD|MODIFY|DELETE
    lines_added: 0
    lines_deleted: 0
```

## 禁止修改的文件/目录

```yaml
forbidden_files:
  - path: ""
    reason: ""
```

## 禁止范围偏差说明

```yaml
forbidden_deviation: []
```
