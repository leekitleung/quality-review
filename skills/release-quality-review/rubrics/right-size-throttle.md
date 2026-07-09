# Right-size Throttle - 变更规模适配

> 根据变更规模自动调整评审流程复杂度。小改动不搞仪式，大改动强制流程。

## 变更规模分类

| 规模 | 文件数 | 代码行数 | Profile | 门禁要求 | 预计时间 |
|------|--------|----------|---------|----------|----------|
| **Micro** | 1-2 | <50 | quick | build + typecheck | ~2 分钟 |
| **Small** | 3-5 | 50-100 | quick | build + typecheck + test | ~5 分钟 |
| **Medium** | 6-20 | 100-500 | default | full review | ~15 分钟 |
| **Large** | 21-50 | 500-2000 | release-gate | full + redlines | ~30 分钟 |
| **XLarge** | 50+ | 2000+ | full + agentic | full + adversarial | ~60 分钟 |

## 规模检测规则

### 检测方法

```bash
# 获取变更统计
git diff --stat

# 示例输出:
#  apps/local-server/src/goal/goal-loop-runner.ts | 15 ++---
#  apps/local-server/src/goal/goal-store.ts         |  8 ++++
#  2 files changed, 23 insertions(+), 0 deletions(-)
```

### 检测逻辑 (伪代码)

```javascript
function detectChangeScale() {
  const diff = execSync('git diff --stat --numstat', { encoding: 'utf-8' });
  
  let totalFiles = 0;
  let totalAdditions = 0;
  let totalDeletions = 0;
  
  for (const line of diff.split('\n')) {
    const match = line.match(/^(\d+|-)\s+(\d+|-)\s+(.+)$/);
    if (match) {
      totalFiles++;
      totalAdditions += parseInt(match[1]) || 0;
      totalDeletions += parseInt(match[2]) || 0;
    }
  }
  
  const totalChanges = totalAdditions + totalDeletions;
  
  // XLarge: 50+ 文件 或 2000+ 行
  if (totalFiles >= 50 || totalChanges >= 2000) return 'xlarge';
  // Large: 21-50 文件 或 500-2000 行
  if (totalFiles >= 21 || totalChanges >= 500) return 'large';
  // Medium: 6-20 文件 或 100-500 行
  if (totalFiles >= 6 || totalChanges >= 100) return 'medium';
  // Small: 3-5 文件 或 50-100 行
  if (totalFiles >= 3 || totalChanges >= 50) return 'small';
  // Micro: 1-2 文件 且 <50 行
  return 'micro';
}
```

### Profile 映射

```javascript
const PROFILE_MAP = {
  micro: 'quick',
  small: 'quick',
  medium: 'default',
  large: 'release-gate',
  xlarge: 'full',
};

const AGENTIC_MAP = {
  large: false,    // 不强制 agentic review
  xlarge: true,    // 必须有 agentic review
};
```

## 自动检测与建议

### 检测输出示例

```bash
$ node review-gate.mjs --detect-scale

═══════════════════════════════════════════════════
    Release Quality Gate - Change Scale Detection
═══════════════════════════════════════════════════

Detected Changes:
  Files: 3
  Additions: 45
  Deletions: 12
  Total: 57 lines

Scale: small (<= 5 files, < 100 lines)

Suggested Profile: quick
  Reason: Small change detected

Override with: --profile <name>
```

### 不同规模的行为差异

#### Micro (<50 行, 1-2 文件)

```
✅ 可以跳过:
  - 完整 reviewer 评审
  - 自动化证据收集
  - 多轮迭代

⚠️ 必须执行:
  - pnpm build
  - pnpm typecheck
  - git diff 检查

✅ 通过条件:
  - 构建成功
  - 类型检查通过
```

#### Small (<100 行, 3-5 文件)

```
✅ 可以跳过:
  - 完整 reviewer 评审
  - adversarial review

⚠️ 必须执行:
  - pnpm build
  - pnpm typecheck
  - pnpm test

✅ 通过条件:
  - 构建成功
  - 类型检查通过
  - 测试通过
```

#### Medium (5-20 文件, 100-500 行)

```
⚠️ 建议执行:
  - default profile (product-flow, destructive-qa, terminal-veteran)
  - 自动化证据收集

✅ 通过条件:
  - 所有 reviewer >= 85
  - 无 P0 redlines
```

#### Large (20+ 文件, 500+ 行)

```
⚠️ 必须执行:
  - release-gate profile (全部常驻 + terminal-veteran)
  - 自动化证据收集
  - 完整 reviewer 评审

✅ 通过条件:
  - 所有 reviewer >= 90
  - 无 P0 redlines
```

#### XLarge (50+ 文件, 2000+ 行)

```
⚠️ 必须执行:
  - full profile (全部 8 个 reviewer)
  - agentic-release-gate profile (伪完成检测)
  - 人工介入点

✅ 通过条件:
  - 所有 reviewer >= 85
  - 无 P0 redlines
  - 人工确认
```

## 命令行接口

### 自动检测 (默认行为)

```bash
# 自动检测规模并建议 profile
node review-gate.mjs

# 输出示例:
# ℹ Detected small change, suggesting 'quick'
# ℹ Use --profile to override
```

### 覆盖检测

```bash
# 强制使用特定 profile
node review-gate.mjs --profile release-gate

# 即使是小改动，也运行完整评审
```

### 强制检测

```bash
# 仅显示检测结果，不运行评审
node review-gate.mjs --detect-scale

# 强制使用检测到的 profile (忽略用户指定)
node review-gate.mjs --force-detected-profile
```

## 决策指南

### 何时升级流程

| 信号 | 应该升级吗？ |
|------|-------------|
| 单个文件但改动涉及核心逻辑 | ✅ 是 (使用 medium) |
| 多文件但都是无关紧要的 | ❌ 否 (保持 quick) |
| 涉及安全/认证逻辑 | ✅ 是 (至少 default) |
| 涉及数据迁移 | ✅ 是 (使用 release-gate) |
| 新增 API 端点 | ✅ 是 (使用 release-gate) |
| 修改 UI 但不影响功能 | ❌ 否 (保持 quick) |

### 何时降级流程

| 信号 | 可以降级吗？ |
|------|-------------|
| 纯文档更新 | ✅ 是 (使用 quick) |
| 纯配置变更 | ✅ 是 (使用 quick) |
| 测试用例补充 | ✅ 是 (使用 quick) |
| Bug 修复但已验证 | ✅ 是 (使用 default) |

### 特殊情况

| 情况 | 建议 Profile | 理由 |
|------|-------------|------|
| 热修复 (hotfix) | quick | 快速响应，但必须有测试 |
| Release 候选 | release-gate | 必须完整评审 |
| 新功能首次提交 | default 或 release-gate | 取决于范围 |
| 代码重构 | release-gate | 回归风险高 |
| 依赖更新 | quick | 风险可控 |

## 实施检查清单

在 `review-gate.mjs` 中实施时，确保：

- [ ] `detectChangeScale()` 函数正确解析 `git diff --stat`
- [ ] `--detect-scale` flag 输出规模检测结果
- [ ] 启动时显示建议的 profile
- [ ] 规模信息写入 `metadata.json`
- [ ] 不同规模有差异化的日志输出
- [ ] 文档中记录覆盖方法 (`--profile`)

## 与其他原则的关系

| 原则 | 如何配合 |
|------|----------|
| **Goal 模式** | 规模决定执行者的决策空间 |
| **执行门禁** | 门槛证据 (build/test/typecheck) 是所有规模的基础 |
| **对抗性审查** | XLarge 规模强制启用 |
| **持久化交接** | 每个规模的评审结果都持久化 |
