const COMMAND_PATTERN = /\b(?:pnpm|npm|yarn)\s+(?:run\s+)?[a-zA-Z0-9:._-]+(?:\s+--[^\s`),;]+)*/g;
const EXIT_ZERO_PATTERN = /\b(?:exit(?:ed|_code)?|return(?:ed)?|status)\s*(?:code)?\s*[:=]?\s*`?0\b/i;
const OUTPUT_SUMMARY_PATTERN = /#\s*(?:tests|pass|fail|skipped)\s+\d+|\b\d+\s+(?:passed|failed|skipped)\b|found\s+0\s+vulnerabilities|in sync\s*\(\d+\s+adapters\)|operation not permitted/i;

export function extractCommandEvidence(content) {
  const records = [];
  for (const match of content.matchAll(COMMAND_PATTERN)) {
    const start = Math.max(0, match.index - 120);
    const end = Math.min(content.length, match.index + match[0].length + 500);
    const context = content.slice(start, end);
    if (EXIT_ZERO_PATTERN.test(context) && OUTPUT_SUMMARY_PATTERN.test(context)) {
      records.push({ command: match[0], context });
    }
  }
  return records;
}

export function extractTestOutputs(content) {
  return content.match(/#\s*(?:tests|pass|fail|skipped)\s+\d+|\b\d+\s+(?:passed|failed|skipped)\b/g) || [];
}

export function checkMissingEvidenceOutput(content) {
  const violations = [];
  const commandEvidence = extractCommandEvidence(content);
  const claims = [
    { pattern: /测试通过|tests? passed|test.*success/gi, command: /\btest\b/i, need: 'npm test 的 exit 0 与输出摘要' },
    { pattern: /类型检查通过|typecheck.*passed|tsc.*success/gi, command: /\btypecheck\b|\btsc\b/i, need: 'typecheck 的 exit 0 与输出摘要' },
    { pattern: /构建成功|build.*success|build.*pass/gi, command: /\bbuild\b/i, need: 'build 的 exit 0 与输出摘要' },
    { pattern: /功能正常|功能正确|工作正常/g, command: null, need: '实际命令的 exit 0 与输出摘要' },
  ];

  for (const claim of claims) {
    claim.pattern.lastIndex = 0;
    if (!claim.pattern.test(content)) continue;
    const hasEvidence = commandEvidence.some(record => !claim.command || claim.command.test(record.command));
    if (!hasEvidence) {
      violations.push({
        type: 'missing_evidence_output',
        claim: claim.pattern.source,
        need: claim.need,
        desc: '声称“通过”但没有结构化命令输出',
      });
    }
  }

  return violations;
}
