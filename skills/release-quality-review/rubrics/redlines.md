# 红线规则 (Red Lines)

红线是"一票否决"规则。存在任何红线意味着绝对不能发布。

## 严重程度定义

| 级别 | 定义 | 行动 |
|------|------|------|
| **P0** | 必须立即修复 | 阻塞发布，任何情况下不能发布 |
| **P1** | 强烈建议修复 | 可以有条件发布，但需要明确风险说明 |

**重要**: 只有 P0 才是绝对红线。P1 可以通过但需要记录风险。

## 安全红线

以下问题无论分数多高都禁止合并：

| 红线 ID | 说明 | 严重程度 |
|---------|------|----------|
| R-01 | 任意代码执行漏洞 (eval, Function, subprocess with shell) | P0 |
| R-02 | 未授权访问漏洞 (缺少认证/授权检查) | P0 |
| R-03 | 敏感数据明文泄露 (日志/响应/存储) | P0 |
| R-04 | 权限绕过 (IDOR, 水平/垂直权限提升) | P0 |
| R-05 | 已知 CVE 漏洞 (npm audit fail) | P0 |
| R-06 | SQL/NoSQL/命令注入 | P0 |
| R-07 | XSS 存储型漏洞 | P0 |
| R-08 | API key/token/secret 硬编码在代码中 | P0 |
| R-09 | CSRF 漏洞 | P1 |
| R-10 | 弱加密算法 (MD5, SHA1 用于安全目的) | P1 |
| R-11 | 不安全的随机数生成 | P1 |

### 安全红线检测方法

**R-01 任意代码执行**
```
grep -rn "eval(" --include="*.ts" apps packages
grep -rn "new Function(" --include="*.ts" apps packages
grep -rn "exec(" --include="*.ts" apps packages | grep -v "execSync"
```

**R-08 硬编码密钥**
```
grep -rn "api[_-]key\|secret\|password\|token" --include="*.ts" | \
  grep -v "\.d\.ts\|_test\|mock\|example\|fixture"
```

**R-05 CVE 检查**
```bash
npm audit --audit-level=high
pnpm audit --level high
```

## 功能红线

| 红线 ID | 说明 | 严重程度 |
|---------|------|----------|
| F-01 | 主路径完全不可用 | P0 |
| F-02 | 核心功能报错无法使用 | P0 |
| F-03 | 用户无法完成任务闭环 | P0 |
| F-04 | 构建失败 (`pnpm build`) | P0 |
| F-05 | 测试套件有未通过的测试 | P0 |
| F-06 | 类型检查失败 (`pnpm typecheck`) | P0 |
| F-07 | 应用启动后立即崩溃 | P0 |
| F-08 | 主要 API 端点返回 500 | P0 |
| F-09 | 关键数据无法保存/读取 | P0 |
| F-10 | 严重内存泄漏导致 OOM | P0 |

### 功能红线检测方法

```bash
# 构建检查
pnpm build

# 类型检查
pnpm typecheck

# 测试检查
pnpm test

# 启动检查 (如果有)
timeout 10 node apps/local-server/dist/server.js || true
```

## 体验红线

| 红线 ID | 说明 | 严重程度 | 适用范围 |
|---------|------|----------|----------|
| U-01 | README 完全缺失 | P0 | 所有项目 |
| U-02 | 安装后完全无法启动 | P0 | 所有项目 |
| U-03 | 无任何使用说明 | P0 | 所有项目 |
| U-04 | 主路径界面明显粗糙 | P1 | 有 UI 的项目 |
| U-05 | 可点击元素不可辨认 | P1 | 有 UI 的项目 |
| U-06 | 严重响应式布局问题 | P1 | 有 UI 的项目 |

### 体验红线检测方法

```bash
# README 检查
test -f README.md && head -50 README.md | grep -q "Getting Started\|Install" || echo "README 缺失关键部分"

# 启动检查
test -f package.json && grep -q '"start"\|"dev"' package.json || echo "缺少启动命令"
```

## 架构红线

| 红线 ID | 说明 | 严重程度 |
|---------|------|----------|
| A-01 | 循环依赖 (circular imports) | P0 |
| A-02 | 全局可变单例状态 | P1 |
| A-03 | 同步副作用在关键路径 | P1 |
| A-04 | 超过 5000 行的巨型文件 | P1 |
| A-05 | 超过 20 层的嵌套回调 | P1 |
| A-06 | 硬编码的魔法数字 (magic numbers) | P2 |

### 架构红线检测方法

```bash
# 循环依赖检查
npx madge --circular --extensions ts apps packages

# 超大文件检查
find apps packages -name "*.ts" -exec wc -l {} + | sort -rn | awk '$1 > 5000'

# 硬编码路径检查 (可能是反模式)
grep -rn "C:\\\|/home/\|/Users/" --include="*.ts" apps packages
```

## 数据红线

| 红线 ID | 说明 | 严重程度 |
|---------|------|----------|
| D-01 | 用户数据未经确认直接删除 | P0 |
| D-02 | 数据迁移缺少回滚方案 | P1 |
| D-03 | 缺少数据备份机制 (生产环境) | P1 |
| D-04 | 数据验证不完整 | P1 |
| D-05 | 不安全的序列化 (反序列化漏洞) | P0 |

## 发布红线

| 红线 ID | 说明 | 严重程度 |
|---------|------|----------|
| P-01 | CHANGELOG 缺失 | P1 |
| P-02 | 版本号未更新 | P1 |
| P-03 | 发布脚本失败 | P0 |
| P-04 | 发布前需要手动步骤 | P1 |
| P-05 | 发布说明不完整 | P2 |

## P0 vs P1 决策指南

### 问自己这些问题：

1. **会导致用户数据丢失吗？** → P0
2. **会导致安全漏洞吗？** → P0
3. **会导致应用完全不可用吗？** → P0
4. **可以带病发布吗？** → 如果"否"，则是 P0

### 决策示例

| 情况 | 决策 | 理由 |
|------|------|------|
| eval() 在代码中 | P0 | 任意代码执行风险 |
| console.log 泄露 token | P0 | 敏感数据泄露 |
| 缺少单元测试 | P2 | 不会直接导致问题 |
| README 太简单 | P2 | 影响体验但不影响安全 |
| 超大文件 (6000 行) | P1 | 可维护性问题 |
| API 返回错误状态码 | P0 | 功能性问题 |

## 红线检查流程

```
1. 运行 review-gate.mjs --check-redlines
2. 如果发现 P0 红线：
   - 立即停止
   - 生成 blockers.md
   - 输出 "🚫 BLOCKED: P0 红线"
   - 不生成 final-report.md
3. 如果只有 P1 红线：
   - 记录到 blockers.md
   - 输出 "⚠️ P1 红线，需要风险说明"
   - 允许继续，但要求风险说明
4. 阻塞发布流程直到所有 P0 修复
```

## 常见红线误判

以下**不是**红线，但需要记录到 improvement-list.md：

| 误判 | 实际级别 | 理由 |
|------|----------|------|
| 代码风格不一致 | P2-P3 | 除非严重影响可读性 |
| 缺少某些测试 | P2 | 但核心路径有测试 |
| 文档不完整 | P2 | 但有基本使用说明 |
| 小幅性能问题 | P3 | 但不影响功能 |
| 缺少注释 | P3 | 代码自解释更好 |
| 未使用某框架特性 | P3 | 代码简洁更好 |

## 红线例外申请

如果认为某条红线是误判，可以申请例外：

1. 在 blockers.md 中添加 `例外申请` 部分
2. 说明为什么这不是红线
3. 提供风险缓解措施
4. 由人工审核决定
