const TEST_OUTPUT_PATTERN = /(?:#\s*|\b)(?:tests|pass|skipped)\s+\d+|\b\d+\s+(?:passed|skipped|ok)\b|(?<!not )\bok\s+\d+\b/i;
const CODE_CHECK_OUTPUT_PATTERN = /node\s+--check\b|alias of typecheck\b|package artifact verified:/i;
const COVERAGE_OUTPUT_PATTERN = /\ball files\s*\||(?:#\s*|\b)(?:tests|pass)\s+\d+/i;
const AUDIT_OUTPUT_PATTERN = /found\s+0\s+vulnerabilities/i;
const FAILURE_PATTERN = /(?:#\s*fail|\bfailed?)\s*[:=]?\s*[1-9]\d*\b|\b[1-9]\d*\s+failed\b/i;

export const SHARED_VERIFICATION_COMMANDS = new Set([
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

const GATE_ORDER = [
  'testGate', 'typecheckGate', 'buildGate', 'lintGate',
  'auditGate', 'coverageGate', 'e2eGate',
];

export function hasPassingCommandOutput(command, summary) {
  let outputPattern = CODE_CHECK_OUTPUT_PATTERN;
  if (/\b(?:test|test:e2e|test:integration)\b/.test(command)) outputPattern = TEST_OUTPUT_PATTERN;
  else if (/\bcoverage\b/.test(command)) outputPattern = COVERAGE_OUTPUT_PATTERN;
  else if (/\baudit\b/.test(command)) outputPattern = AUDIT_OUTPUT_PATTERN;

  return outputPattern.test(summary) &&
    !/\bnot\s+ok\b/i.test(summary) &&
    !FAILURE_PATTERN.test(summary);
}

export function parseReviewerEvidenceBlocks(content) {
  const records = [];
  for (const match of String(content || '').matchAll(
    /^Command:\s*([^\r\n]+)\r?\nExit code:\s*(-?\d+)\r?\nOutput:\s*([^\r\n]+)$/gmi,
  )) {
    records.push({
      command: match[1].trim(),
      exitCode: Number.parseInt(match[2], 10),
      output: match[3].trim(),
      context: match[0],
    });
  }
  return records;
}

function finalCount(output, label) {
  const matches = [...String(output || '').matchAll(new RegExp(`(?:#\\s*)?${label}\\s+(\\d+)`, 'gi'))];
  return matches.length > 0 ? Number.parseInt(matches.at(-1)[1], 10) : null;
}

function canonicalSummary(record) {
  const { command, output } = record;
  if (/\b(?:test|test:e2e|test:integration)\b/.test(command)) {
    const tests = finalCount(output, 'tests');
    const pass = finalCount(output, 'pass');
    const fail = finalCount(output, 'fail');
    if (![tests, pass, fail].every(Number.isInteger) || fail !== 0) return null;
    return `# tests ${tests}; # pass ${pass}; # fail ${fail}`;
  }
  if (/\bcoverage\b/.test(command)) {
    const line = String(output || '').split('\n').find(value => /\ball files\s*\|/i.test(value));
    return line ? line.trim().replace(/^#\s*/, '').replace(/\s*\|\s*/g, ' | ').trim() : null;
  }
  if (/\baudit\b/.test(command)) {
    return /found\s+0\s+vulnerabilities/i.test(output) ? 'found 0 vulnerabilities' : null;
  }
  const artifact = String(output || '').split('\n').find(line => /package artifact verified:/i.test(line));
  if (artifact) return artifact.trim();
  if (/node\s+--check\b/i.test(output)) return 'node --check';
  return /alias of typecheck/i.test(output) ? 'alias of typecheck' : null;
}

export function canonicalReviewerEvidence(automatedChecks) {
  const records = [];
  for (const gate of GATE_ORDER) {
    const record = automatedChecks?.[gate];
    if (!record || record.status !== 'pass' || record.exit_code !== 0 ||
        !SHARED_VERIFICATION_COMMANDS.has(record.command)) continue;
    const output = canonicalSummary(record);
    if (output === null || !hasPassingCommandOutput(record.command, output)) continue;
    records.push({ command: record.command, exitCode: 0, output });
  }
  return records;
}

export function renderReviewerEvidenceBlocks(automatedChecks) {
  return canonicalReviewerEvidence(automatedChecks)
    .map(record => `Command: ${record.command}\nExit code: ${record.exitCode}\nOutput: ${record.output}`)
    .join('\n\n');
}

export function validateReviewerEvidenceBlocks(content, automatedChecks) {
  const records = parseReviewerEvidenceBlocks(content);
  if (records.length === 0) return { valid: false, records: 0, reason: 'missing round-owned command evidence' };
  const expected = new Set(canonicalReviewerEvidence(automatedChecks)
    .map(record => JSON.stringify([record.command, record.exitCode, record.output])));
  const mismatch = records.find(record =>
    !expected.has(JSON.stringify([record.command, record.exitCode, record.output]))
  );
  if (mismatch) {
    return { valid: false, records: records.length, reason: `command evidence does not match round: ${mismatch.command}` };
  }
  return { valid: true, records: records.length };
}
