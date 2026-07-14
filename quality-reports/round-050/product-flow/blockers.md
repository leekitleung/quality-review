# Blockers - Product Flow

## No P0 blockers

No P0 product-flow redline was reproduced.

## P1

### PF-P1-01 — review-gate.mjs 超大文件

- **Location**: `skills/release-quality-review/scripts/review-gate.mjs`
- **Issue**: 单一文件约 2010 行，超出架构规范 1000 行上限
- **Impact**: 代码审查困难，单点故障风险高
- **Fix**: 拆分为多个模块
- **Effort**: High, **Benefit**: High

## P2

### PF-P2-01 — 缺少用户引导文档

- **Location**: `docs/`
- **Issue**: docs/ 目录为空，新用户无上手指南
- **Impact**: 新团队成员上手成本高
- **Fix**: 创建 `docs/run-book.md`
- **Effort**: Low, **Benefit**: High

### PF-P2-02 — 状态类型分散

- **Location**: `skills/release-quality-review/`
- **Issue**: 状态类型定义在多个文件中，手动映射
- **Fix**: 抽象为统一状态协议
- **Effort**: Medium

No waiver is recommended.
