import path from 'node:path';

const COMMAND_PATTERN = /\b(?:pnpm|npm|yarn)\s+(?:run\s+)?[a-zA-Z0-9:._-]+(?:\s+--[^\s`),;]+)*/g;
const EXIT_ZERO_PATTERN = /\b(?:exit(?:ed|_code)?|return(?:ed)?|status)\s*(?:code)?\s*[:=]?\s*`?0\b/i;
const OUTPUT_SUMMARY_PATTERN = /(?:#\s*|\b)(?:tests|pass|fail|skipped)\s+\d+|\b\d+\s+(?:passed|failed|skipped)\b|found\s+0\s+vulnerabilities|in sync\s*\(\d+\s+adapters\)|node\s+--check\b|alias of typecheck\b|operation not permitted/i;
const SHARED_VERIFICATION_COMMANDS = new Set([
  'npm test',
  'npm run typecheck',
  'npm run build',
  'npm run lint',
  'npm run coverage',
  'npm run test:e2e',
  'npm audit --audit-level=high',
  'pnpm test',
  'pnpm run typecheck',
  'pnpm typecheck',
  'pnpm build',
  'pnpm lint',
  'pnpm test:integration',
  'yarn test',
  'yarn build',
  'yarn lint',
]);

const FILE_LINE_PATTERN = /`?((?:\/|\.\.?\/)?[A-Za-z0-9_.][A-Za-z0-9_./\\-]*\.(?:ts|tsx|js|jsx|mjs|md|json|ya?ml)):(\d+)`?/g;

export function extractFileLineReferences(content) {
  const refs = [];
  for (const match of String(content || '').matchAll(FILE_LINE_PATTERN)) {
    refs.push({ file: match[1], line: Number.parseInt(match[2], 10), full: match[0] });
  }
  return refs;
}

export function resolveFileReference(projectRoot, file) {
  const resolved = path.resolve(projectRoot, file);
  const relative = path.relative(path.resolve(projectRoot), resolved).replace(/\\/g, '/');
  return relative === '' || (!relative.startsWith('../') && relative !== '..') ? resolved : null;
}

export function extractCommandEvidence(content) {
  const records = [];
  for (const match of content.matchAll(COMMAND_PATTERN)) {
    const start = Math.max(0, match.index - 120);
    const end = Math.min(content.length, match.index + match[0].length + 500);
    const context = content.slice(start, end);
    if (SHARED_VERIFICATION_COMMANDS.has(match[0]) && EXIT_ZERO_PATTERN.test(context) && OUTPUT_SUMMARY_PATTERN.test(context)) {
      records.push({ command: match[0], context });
    }
  }
  for (const match of String(content || '').matchAll(/\bcommand:\s*["']?([^"'\n]+?)["']?\s*[\r\n]+[\s\S]{0,240}?exit_code:\s*0\s*[\r\n]+[\s\S]{0,240}?(?:output_summary|output):\s*["']?([^"'\n]+)["']?/gi)) {
    const command = match[1].trim();
    if (SHARED_VERIFICATION_COMMANDS.has(command) && OUTPUT_SUMMARY_PATTERN.test(match[2])) {
      records.push({ command, context: match[0] });
    }
  }
  return [...new Map(records.map(record => [record.command, record])).values()];
}

export function extractTestOutputs(content) {
  return content.match(/(?:#\s*|\b)(?:tests|pass|fail|skipped)\s+\d+|\b\d+\s+(?:passed|failed|skipped)\b/g) || [];
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

function findingKeys(finding) {
  const text = String(finding || '').replace(/^['"]|['"]$/g, '');
  const identifiers = text.match(/\b[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)+\b/g) || [];
  if (identifiers.length > 0) return [...new Set(identifiers)];
  const description = text.replace(/^P[01]\s*[:：-]?\s*/i, '').trim();
  return description.length >= 12 ? [description.slice(0, 48)] : [];
}

function markdownSections(content) {
  const sections = [];
  let current = null;
  for (const line of String(content || '').split('\n')) {
    if (/^#{2,6}\s+/.test(line)) {
      if (current) sections.push(current);
      current = line;
    } else if (current) {
      current += `\n${line}`;
    }
  }
  if (current) sections.push(current);
  return sections;
}

export function checkFindingEvidenceBindings(findings, blockersContent) {
  const violations = [];
  const sections = markdownSections(blockersContent);
  for (const finding of findings || []) {
    const keys = findingKeys(finding);
    const section = sections.find(candidate => keys.some(key => candidate.includes(key)));
    if (!section) {
      violations.push({
        type: 'missing_finding_section',
        desc: `未找到与 finding 绑定的 blockers.md 章节: ${String(finding).slice(0, 120)}`,
      });
      continue;
    }
    const evidenceCount = extractFileLineReferences(section).length +
      extractCommandEvidence(section).length + extractTestOutputs(section).length;
    if (evidenceCount === 0) {
      violations.push({
        type: 'unbound_finding_evidence',
        desc: `finding 章节没有 file:line、结构化命令或测试证据: ${String(finding).slice(0, 120)}`,
      });
    }
  }
  return violations;
}
