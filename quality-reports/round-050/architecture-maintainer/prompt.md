
# architecture-maintainer Review

请执行 architecture-maintainer 的评审。

## 评审维度
请读取完整定义: /Users/namkit/Documents/1.Projects/quality-review/skills/release-quality-review/reviewers/architecture-maintainer.md

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

**必须行为：**
- ✅ 引用**现有文件**中的代码行号（不是你刚写的）
- ✅ 引用**已有测试**的输出结果
- ✅ 引用**历史报告**或**其他 Reviewer 的发现**
- ✅ 提供具体的错误信息、堆栈跟踪或命令输出

## 输出要求
在 /Users/namkit/Documents/1.Projects/quality-review/quality-reports/round-{N}/architecture-maintainer/ 目录下创建:
- result.yaml - 机器可读结果
- score.md - 评分详情
- blockers.md - P0/P1 必须修复的问题
- improvement-list.md - P2/P3 改进建议

result.yaml 必须声明 reviewer: architecture-maintainer、profile: quick、round: 50、candidate_commit: 42d993215a08c8522facd76ca88960a5c196f80a、candidate_tree: c1e9e5c8bf88dcc2abcef24b162ce576e2b763d4。
实际输出目录必须是 /Users/namkit/Documents/1.Projects/quality-review/quality-reports/round-050/architecture-maintainer/。

## 评分标准
- >= 90: 优秀，可以发布
- 80-89: 良好，建议改进
- 70-79: 及格，必须改进
- < 70: 不及格，需要重构

## 红线规则
如果发现任何红线，必须在 blockers.md 中明确标注为 P0。
