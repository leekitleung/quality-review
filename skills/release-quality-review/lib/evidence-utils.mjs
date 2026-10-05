import path from 'node:path';

import {
  hasPassingCommandOutput, parseReviewerEvidenceBlocks, SHARED_VERIFICATION_COMMANDS,
} from './reviewer-evidence-contract.mjs';

export { hasPassingCommandOutput } from './reviewer-evidence-contract.mjs';

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
  const records = parseReviewerEvidenceBlocks(content).filter(record =>
    record.exitCode === 0 && SHARED_VERIFICATION_COMMANDS.has(record.command) &&
    hasPassingCommandOutput(record.command, record.output)
  );
  return [...new Map(records.map(record => [record.command, record])).values()];
}

export function extractTestOutputs(content) {
  return content.match(/(?:#\s*|\b)(?:tests|pass|fail|skipped)\s+\d+|\b\d+\s+(?:passed|failed|skipped)\b/g) || [];
}

export function checkMissingEvidenceOutput(content) {
  const violations = [];
  const commandEvidence = extractCommandEvidence(content);
  const claims = [
    { pattern: /测试通过|tests? passed|test.*success/gi, command: /\btest\b/i, need: 'exit 0 and output summary from npm test' },
    { pattern: /类型检查通过|typecheck.*passed|tsc.*success/gi, command: /\btypecheck\b|\btsc\b/i, need: 'exit 0 and output summary from typecheck' },
    { pattern: /构建成功|build.*success|build.*pass/gi, command: /\bbuild\b/i, need: 'exit 0 and output summary from the build' },
    { pattern: /功能正常|功能正确|工作正常/g, command: null, need: 'exit 0 and output summary from the actual command' },
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
        desc: 'claims success without structured command output',
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
        desc: `no blockers.md section bound to finding: ${String(finding).slice(0, 120)}`,
      });
      continue;
    }
    const references = extractFileLineReferences(section);
    if (references.length === 0) {
      violations.push({
        type: 'unbound_finding_evidence',
        desc: `finding section has no file:line evidence: ${String(finding).slice(0, 120)}`,
      });
      continue;
    }
    const affected = [...section.matchAll(/^\s*(?:Affected(?: files?)?|受影响(?:文件)?)\s*[:：]\s*(.+)$/gmi)]
      .flatMap(match => match[1].match(/[A-Za-z0-9_.][A-Za-z0-9_./-]*\.(?:ts|tsx|js|jsx|mjs|md|json|ya?ml)/g) || [])
      .map(file => file.replace(/^\.\//, ''));
    if (affected.length === 0) {
      violations.push({
        type: 'missing_finding_affected_files',
        desc: `finding section is missing an Affected files field: ${String(finding).slice(0, 120)}`,
      });
      continue;
    }
    const cited = references.map(reference => reference.file.replace(/^\.\//, ''));
    if (!affected.every(file => cited.includes(file))) {
      violations.push({
        type: 'irrelevant_finding_evidence',
        desc: `finding evidence is not bound to its Affected files: ${String(finding).slice(0, 120)}`,
      });
    }
  }
  return violations;
}
