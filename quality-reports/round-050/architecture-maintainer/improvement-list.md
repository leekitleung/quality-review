# Improvements - Architecture Reviewer

## P2 (Should Fix)

- **[ID: ARCH-P2-01]** — 拆分 review-gate.mjs 超大文件
  - Location: `skills/release-quality-review/scripts/review-gate.mjs`
  - Effort: High
  - Benefit: 提高可维护性，降低单点故障风险
  - 建议: 拆分为多个模块

- **[ID: ARCH-P2-02]** — 统一状态类型协议
  - Location: `skills/release-quality-review/scripts/state-tracker.mjs`, `state-protocol.mjs`
  - Effort: Medium
  - Benefit: 消除重复代码，提高类型安全

## P3 (Nice to Have)

- **[ID: ARCH-P3-01]** — 添加架构决策记录 (ADR)
  - Location: `docs/adr/`
  - Effort: Low
  - Benefit: 记录关键设计决策，便于新成员理解

- **[ID: ARCH-P3-02]** — 增加性能基准测试
  - Location: `scripts/benchmarks/`
  - Effort: Low
  - Benefit: 监控 reviewer 执行时间趋势
