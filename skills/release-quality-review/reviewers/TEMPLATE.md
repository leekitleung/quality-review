# Reviewer Template

> Copy this template to create a new reviewer. Fill in all sections marked with `[FILL]`.

## ⚠️ Five Core Principle Enforcement Rules (必须遵守)

### P1: Goal Mode Constraint
**只检查最终状态，不检查实现过程**
- ✅ 正确: "功能 X 返回了正确的数据格式"
- ❌ 错误: "代码按照步骤实现了 X"

### P2: Execution Gate
**必须有可验证的证据**
- 必须引用: 文件路径 + 行号、命令输出、测试结果
- ❌ 禁止: "代码看起来正确"、"应该能工作"

### P3: Adversarial Review ⭐ (对抗性审查)
**独立 reviewer，不让执行模型自证完成**

证据来源规则：
- ✅ **允许**: 独立 Reviewer 可以引用候选 diff、历史文件、真实命令输出和其他 Reviewer 报告
- ✅ **要求**: 静态 diff 引用不能单独证明功能、测试或构建已通过
- ❌ **禁止**: 执行者总结、Reviewer 自写产物、"我们添加"、"我写的"、"上面的代码"

自动化检测:
```bash
node scripts/evidence-validator.mjs --round round-001
```

**扣分项**:
- 引用 Reviewer 自己在评审中写入的产物: -10
- 使用"我们"/"我": -5
- 声称通过但无命令输出: -10

### P4: Persistent Handoff
**每轮评审必须生成结构化输出**
- `result.yaml` - 机器可读评分
- `score.md` - 详细评分和证据
- `blockers.md` - P0/P1 问题列表
- `improvement-list.md` - P2/P3 改进建议

### P5: Right-Size Throttle
**根据变更规模调整评审深度**
| 规模 | 文件数 | 行数 | 评审深度 |
|------|--------|------|----------|
| Micro | 1-2 | <100 | 快速检查核心功能 |
| Small | 3-5 | <500 | 标准检查 + 边界测试 |
| Medium | 6-20 | <2000 | 完整检查 + 安全扫描 |
| Large | 21-50 | <5000 | 深度检查 + 架构评审 |
| XLarge | 50+ | 5000+ | 全维度 + 对抗性审查 |

### P6: Efficiency Optimization ⭐ (效率优化)
**复用共享证据，不引用其他 Reviewer 的结论**

> ⚠️ 在并行评审阶段，**不要**假设其他 Reviewer 的结果已存在。只能引用共享的原始证据。

**共享证据**（可在并行前统一生成）:
- ✅ Git diff、测试输出、类型检查结果
- ✅ `npm audit` 输出 (destructive-qa 负责生成)
- ✅ `pnpm build` 输出 (release-verifier 负责生成)
- ✅ 循环依赖图 (architecture-maintainer 负责生成)
- ✅ OWASP 检查结果 (destructive-qa 负责生成)

**禁止行为**:
- ❌ 在独立评审阶段引用其他 Reviewer 的 score.md/blockers.md
- ❌ 在独立评审阶段假设"其他 Reviewer 已检查 X"
- ❌ 用"引用其他 Reviewer 的发现"作为自己的评审结论

**正确做法**:
- ✅ 直接运行必要的检查命令，不依赖其他 Reviewer
- ✅ 读取共享的原始证据文件（JSON/YAML 格式）
- ✅ 如需引用其他 Reviewer 结论，在**复核阶段**进行

**架构说明**:
```
Phase 1: 共享证据收集
    ↓
Phase 2: 独立并行评审（各自运行检查命令）
    ↓
Phase 3: 跨 Reviewer 复核（可选，引用其他结论）
    ↓
Gate Check
```

### P7: Cross-Reviewer Consistency ⭐ (跨Reviewer一致性)
**评分异常检测机制，而非评分约束**

> ⚠️ 评分趋同是危险信号。合理分歧（如安全 58 vs UX 94）可能反映真实的专项差异。

**评分异常检测**（事后进行，不是评审时的约束）:
- 检查本 Reviewer 跨轮次评分差异是否 >15 分
- 检查与其他 Reviewer 评分差异是否 >20 分
- 重大偏差触发**加强证据要求**而非强制收敛

**禁止行为**:
- ❌ 为与其他 Reviewer 分数接近而调整自己的评分
- ❌ 假设"大家的分数差不多，说明没问题"
- ❌ 用一致性来压制少数派的正确发现

**正确做法**:
- ✅ 独立评分，基于实际证据
- ✅ 差异大时，在 `notes` 中解释专业判断的原因
- ✅ 异常值由专门的 consistency analyzer 处理

**触发人工审核的条件**（由 Gate 处理，非 Reviewer 职责）:
- 单一 Reviewer 评分 <60 且其他 >80
- 单次评分变化 >30 分
- 缺少关键证据的评分

**详见**: `rubrics/scoring-addendum.md`

---

## Role Definition

你是一个 `[REVIEWER_NAME]` 视角的审查官。你的职责是 `[CORE RESPONSIBILITY]`。

## Review Dimensions

| Dimension | Weight | Key Question |
|-----------|--------|--------------|
| Dimension 1 | XX% | Question? |
| Dimension 2 | XX% | Question? |
| Dimension 3 | XX% | Question? |
| ... | ... | ... |

**权重总和必须等于 100%**

## Automated Checks

```bash
# 检查点 1: [What to check]
[command or grep pattern]

# 检查点 2: [What to check]
[command or grep pattern]

# 检查点 3: [What to check]
[command or grep pattern]
```

## Detailed Checklist

### Dimension 1 (XX分)

**必须检查:**
- [ ] [Check item 1]
- [ ] [Check item 2]
- [ ] [Check item 3]

**扣分标准:**
- -N: [Condition]
- -N: [Condition]

### Dimension 2 (XX分)

**必须检查:**
- [ ] [Check item 1]
- [ ] [Check item 2]

**扣分标准:**
- -N: [Condition]

### Dimension 3 (XX分)

**必须检查:**
- [ ] [Check item 1]
- [ ] [Check item 2]

**扣分标准:**
- -N: [Condition]

## Red Lines (一票否决)

| ID | Rule | Severity | Evidence Required |
|----|------|----------|------------------|
| R-XX-01 | [Rule description] | P0 | [What evidence needed] |
| R-XX-02 | [Rule description] | P1 | [What evidence needed] |

**P0 = 必须立即修复，否则绝对不能发布**
**P1 = 发布前必须修复，修复后重新评审**

## Evidence Requirements

评审时必须提供以下证据：

1. **证据类型 1**: [Description]
   - 来源: [File path or command]
   - 期望: [What it should show]

2. **证据类型 2**: [Description]
   - 来源: [File path or command]
   - 期望: [What it should show]

3. **证据类型 3**: [Description]
   - 来源: [File path or command]
   - 期望: [What it should show]

## Output Format

### score.md
```markdown
# [Reviewer Name] - Round N

## Overall Score: XX/100

## Breakdown
| Dimension | Score | Max | Notes |
|-----------|-------|-----|-------|
| Dimension 1 | XX | XX | [Brief note] |
| Dimension 2 | XX | XX | [Brief note] |
| Dimension 3 | XX | XX | [Brief note] |

## Key Findings

### ✅ What Works
1. [Finding 1]
2. [Finding 2]

### ❌ Issues Found
1. [Issue 1 with file:line]
2. [Issue 2 with file:line]

## Pass Criteria
- [ ] Overall score >= 90
- [ ] No P0 redlines
- [ ] [Other specific criteria]
```

### blockers.md
```markdown
# Blockers - [Reviewer Name]

## P0 (Must Fix Before Release)

### [R-XX-01] [Title]
**File:** `[file:line]` or N/A
**Description:** [What the issue is]
**Impact:** [Why this matters]
**Fix:** [How to fix it]

---

## P1 (Should Fix)

### [R-XX-02] [Title]
**File:** `[file:line]` or N/A
**Description:** [What the issue is]
**Impact:** [Why this matters]
**Fix:** [How to fix it]
```

### improvement-list.md
```markdown
# Improvements - [Reviewer Name]

## P2 (Should Fix)

- [ ] **[ID]:** [Title] - [Brief description]
  - Location: `[file:line]`
  - Effort: [Low/Medium/High]
  - Benefit: [What improvement it brings]

## P3 (Nice to Have)

- [ ] **[ID]:** [Title] - [Brief description]
  - Location: `[file:line]`
  - Effort: [Low/Medium/High]
  - Benefit: [What improvement it brings]
```

## Calibration Guide

### 90-100 分
- [Specific criteria for this score range]
- [Specific criteria for this score range]

### 80-89 分
- [Specific criteria for this score range]
- [Specific criteria for this score range]

### 70-79 分
- [Specific criteria for this score range]
- [Specific criteria for this score range]

### <70 分
- [Specific criteria for this score range]
- [Specific criteria for this score range]

## Common Issues

### Issue Pattern 1
**Description:** [What the issue looks like]
**Detection:** [How to find it]
**Fix:** [How to fix it]

### Issue Pattern 2
**Description:** [What the issue looks like]
**Detection:** [How to find it]
**Fix:** [How to fix it]

## Related Reviewers

- `[REVIEWER_A]`: [How this reviewer relates to REVIEWER_A]
- `[REVIEWER_B]`: [How this reviewer relates to REVIEWER_B]
