import { renderReviewerEvidenceBlocks } from '../../lib/reviewer-evidence-contract.mjs';

export function generateReviewerPrompt({
  reviewerName, reviewerContent, currentRound, candidateIdentity,
  reviewBackend, reviewModel, reviewReasoningEffort, profile,
  skillDir, reportDir, automatedChecks,
}) {
  if (!reviewerContent) return null;
  const { commit: candidateCommit, tree: candidateTree } = candidateIdentity;
  const evidenceBlocks = renderReviewerEvidenceBlocks(automatedChecks);
  return `
# ${reviewerName} Review

请执行 ${reviewerName} 的评审。

## 评审维度
请读取完整定义: ${skillDir}/reviewers/${reviewerName}.md

## 你的任务
1. 读取相关代码文件
2. 检查每个评审维度
3. 给出具体评分 (0-100)
4. 列出发现的 blocker (P0/P1 必须修复, P2/P3 建议改进)
5. 列出改进建议

## ⚠️ 对抗性审查规则（必须遵守）

**禁止行为：**
- ❌ 不要引用你自己刚刚修改的代码作为"证据"
- ❌ 不要在没有实际运行的情况下声称"功能正常"
- ❌ 不要使用模糊描述如"代码看起来正确"
- ❌ 不要运行 review-runner、review-gate、npm test、npm run build 或其他共享测试/门禁命令
- ❌ 不要修改源码、本轮共享 metadata/evidence，或其他 Reviewer 的目录

**必须行为：**
- ✅ 引用**现有文件**中的代码行号（不是你刚写的）
- ✅ 引用**已有测试**的输出结果
- ✅ 共享命令证据只能逐字复制下方由 Gate 从本轮 automated-checks.json 派生的块
- ✅ score.md 必须至少包含一个完整的 Command/Exit code/Output 三行块
- ❌ 修改命令、exit code、数字或 Output 文本会使 packet fail closed
- ✅ 每个 blockers/redlines 条目必须在 blockers.md 中有独立标题，标题原样包含该条目的完整文本或唯一标识符
- ✅ 每个 blocker/redline 标题下必须写 \`Affected files: path/to/file.ext\`，且至少一个同节 \`file:line\` 引用必须指向所声明文件；共享命令块不能替代 finding-specific 静态证据
- ✅ file:line 引用必须使用文件的实际物理行号，不得把 JSON 内嵌输出的行偏移当作文件行号
- ✅ 引用**历史报告**或**其他 Reviewer 的发现**
- ✅ 提供具体的错误信息、堆栈跟踪或命令输出

## 本轮 Gate-owned 共享命令证据

\`\`\`text
${evidenceBlocks}
\`\`\`

## 输出要求
本轮 reviewer 执行身份为 ${reviewBackend}/${reviewModel}，reasoning effort 为 ${reviewReasoningEffort || 'backend default'}。
在 ${reportDir}/round-{N}/${reviewerName}/ 目录下创建:
- result.yaml - 机器可读结果
- score.md - 评分详情
- blockers.md - P0/P1 必须修复的问题
- improvement-list.md - P2/P3 改进建议

你只允许写入上面列出的四个 packet 文件。result.yaml 只允许包含下列 11 个顶层字段，顺序和名称必须完全一致；不得添加 summary、dimensions、evidence 或任何其他顶层字段。score 必须是整数，status 必须是小写 pass 或 fail。status 只表示你自己的 reviewer verdict，不表示整轮 Gate 或其他 reviewer 的结果。仅当 score >= 90 且 blockers/redlines 都为空时 status 才能是 pass；其他情况必须是 fail：
\`\`\`yaml
reviewer: ${reviewerName}
profile: ${profile}
round: ${currentRound}
candidate_commit: ${candidateCommit}
candidate_tree: ${candidateTree}
score: <0-100 integer>
status: <pass|fail>
review_backend: ${reviewBackend}
review_model: ${reviewModel}
blockers: []
redlines: []
\`\`\`
实际输出目录必须是 ${reportDir}/round-${String(currentRound).padStart(3, '0')}/${reviewerName}/。

## 评分标准
- >= 90: 优秀，可以发布
- 80-89: 良好，建议改进
- 70-79: 及格，必须改进
- < 70: 不及格，需要重构

## 红线规则
如果发现任何红线，必须在 blockers.md 中明确标注为 P0。
`;
}
