function verificationKind(name) {
  if (/^test(?::|$)/i.test(name)) return 'test';
  if (/coverage/i.test(name)) return 'coverage';
  if (/^(?:typecheck|lint|build)(?::|$)/i.test(name)) return 'code';
  return 'generic';
}

function verificationCapabilities(command) {
  const trimmed = String(command || '').trim();
  const words = trimmed.split(/\s+/);
  const executable = words[0]?.toLowerCase();
  const capabilities = new Set();

  if (/^node(?:\.exe)?$/.test(executable)) {
    const args = words.slice(1);
    if (args[0] === 'scripts/sync-skills.mjs' && args[1] === 'check') capabilities.add('generic');
    if (args[0] === 'skills/release-quality-review/scripts/review-gate.mjs' && args.includes('--dry-run')) {
      capabilities.add('generic');
    }

    const entryOptions = [];
    for (const arg of args) {
      if (arg === '--' || !arg.startsWith('-')) break;
      entryOptions.push(arg);
    }
    if (entryOptions.some(arg => /^(?:-e|-p)(?:.|$)|^--(?:eval|print)(?:=|$)/.test(arg))) return new Set();

    const hasTestRunner = entryOptions.some(arg => arg === '--test' || arg.startsWith('--test='));
    const hasCoverage = entryOptions.some(arg =>
      arg === '--experimental-test-coverage' || arg.startsWith('--test-coverage-'));
    if (hasTestRunner) capabilities.add('test');
    if (hasTestRunner && hasCoverage) {
      capabilities.add('coverage');
    }
    if (args[0] === '--check') capabilities.add('code');
    return capabilities;
  }

  if (/^(?:jest|vitest|playwright|cypress|mocha|ava|pytest)$/.test(executable)) {
    capabilities.add('test');
    if (words.some(word => /^--coverage(?:=|$)|^--cov(?:=|$)/.test(word))) capabilities.add('coverage');
  } else if (/^(?:nyc|c8)$/.test(executable)) {
    capabilities.add('test');
    capabilities.add('coverage');
  } else if (/^(?:tsc|eslint|ruff|mypy)$/.test(executable)) {
    capabilities.add('code');
  } else if (/^(?:go|cargo|swift|deno|bun|dotnet)$/.test(executable) &&
      /^(?:test|check|build|lint|vet|clippy)$/.test(words[1] || '')) {
    const action = words[1];
    capabilities.add(action === 'test' ? 'test' : 'code');
    if (action === 'test' && words.some(word => /^-cover|^--coverage/.test(word))) capabilities.add('coverage');
  } else if (/^(?:make|cmake|ninja|mvn|gradle|xcodebuild)$/.test(executable)) {
    capabilities.add('code');
  }
  return capabilities;
}

function scriptNameFromCommand(command) {
  const match = String(command || '').trim().match(/^(?:npm|pnpm|yarn)\s+(?:run\s+)?([A-Za-z0-9:._-]+)(?:\s|$)/);
  return match?.[1] || null;
}

function hasMeaningfulScript(name, scripts, requiredKind = verificationKind(name), visiting = new Set()) {
  if (!name || visiting.has(name) || typeof scripts?.[name] !== 'string') return false;
  const nextVisiting = new Set(visiting).add(name);
  // Only `&&` preserves verifier failure. Fallbacks, pipelines, sequential
  // commands, backgrounding and newlines can replace a failed exit status.
  const withoutSafeAnd = scripts[name].replaceAll('&&', '');
  if (/[|;&\r\n]/.test(withoutSafeAnd)) return false;
  const segments = scripts[name].split(/\s*&&\s*/).filter(Boolean);
  return segments.some(segment => {
    const trimmed = segment.trim();
    const nested = scriptNameFromCommand(trimmed);
    if (nested) return hasMeaningfulScript(nested, scripts, requiredKind, nextVisiting);
    const capabilities = verificationCapabilities(trimmed);
    return requiredKind === 'generic' ? capabilities.size > 0 : capabilities.has(requiredKind);
  });
}

export function findTrivialVerificationScripts(scripts, commands) {
  const issues = [];
  for (const command of commands) {
    const name = scriptNameFromCommand(command);
    if (name && !hasMeaningfulScript(name, scripts)) issues.push({ command, script: name });
  }
  return issues;
}

export function hasConcreteVerificationOutput(kind, output) {
  const text = String(output || '');
  if (kind === 'test') {
    const totals = [...text.matchAll(/#\s*tests\s+(\d+)/gi)].map(match => Number(match[1]));
    const failures = [...text.matchAll(/#\s*fail\s+(\d+)/gi)].map(match => Number(match[1]));
    if (totals.length > 0 && failures.length > 0) {
      return totals.some(total => total > 0) && failures.every(failed => failed === 0);
    }
    const passed = text.match(/\b(\d+)\s+passed\b/i);
    return Boolean(passed && Number(passed[1]) > 0 && !/\b[1-9]\d*\s+failed\b/i.test(text));
  }
  if (kind === 'coverage') {
    return /(?:start of coverage report|all files\s+\|\s+\d)/i.test(text);
  }
  return true;
}

export const CLEAN_CANDIDATE_COMMANDS = [
  ['clone', 'git clone --quiet --no-local <source> <candidate>'],
  ['script-integrity', 'verify package verification scripts'],
  ['install', 'npm ci --ignore-scripts'],
  ['test', 'npm test'],
  ['coverage', 'npm run coverage'],
  ['typecheck', 'npm run typecheck'],
  ['lint', 'npm run lint'],
  ['build', 'npm run build'],
  ['audit', 'npm audit --audit-level=high'],
  ['e2e', 'npm run test:e2e'],
  ['final-status', 'git status --porcelain --untracked-files=all'],
];

export function validateCleanCandidateEvidence(clean, candidateCommit, candidateTree) {
  if (!clean || clean.schema_version !== 1 || clean.status !== 'pass' || clean.exit_code !== 0 ||
      clean.isolated_checkout !== true || clean.candidate_commit !== candidateCommit ||
      clean.candidate_tree !== candidateTree || clean.isolated_commit !== candidateCommit ||
      clean.isolated_tree !== candidateTree || clean.source_status !== '' || clean.final_source_status !== '' ||
      !Array.isArray(clean.commands) || clean.commands.length !== CLEAN_CANDIDATE_COMMANDS.length) return false;
  for (let index = 0; index < CLEAN_CANDIDATE_COMMANDS.length; index++) {
    const record = clean.commands[index];
    const [expectedId, expectedCommand] = CLEAN_CANDIDATE_COMMANDS[index];
    const retainedBytes = Buffer.byteLength(record?.output || '');
    const started = Date.parse(record?.started_at);
    const finished = Date.parse(record?.finished_at);
    if (!record || record.id !== expectedId || record.command !== expectedCommand ||
        record.exit_code !== 0 || record.status !== 'pass' ||
        !Number.isFinite(started) || !Number.isFinite(finished) || finished < started ||
        typeof record.output !== 'string' || !Number.isInteger(record.output_bytes) ||
        record.output_bytes < retainedBytes || typeof record.truncated !== 'boolean' ||
        (!record.truncated && record.output_bytes !== retainedBytes)) return false;
  }
  const testRecord = clean.commands.find(record => record.id === 'test');
  const coverageRecord = clean.commands.find(record => record.id === 'coverage');
  return clean.commands.at(-1).output.trim() === '' &&
    hasConcreteVerificationOutput('test', testRecord?.output) &&
    hasConcreteVerificationOutput('coverage', coverageRecord?.output);
}

export const ROLLBACK_COMMANDS = [
  ['source-status', 'git status --porcelain --untracked-files=all'],
  ['clone', 'git clone --quiet --no-local <source> <rollback>'],
  ['isolated-commit', 'git rev-parse HEAD'],
  ['isolated-tree', 'git rev-parse HEAD^{tree}'],
  ['revert', 'git revert --no-commit <base>..HEAD'],
  ['rollback-tree', 'git write-tree'],
  ['package-manager', 'verify pre-provisioned rollback package manager'],
  ['install', 'npm ci --ignore-scripts'],
  ['rollback-commit', 'git commit <rollback snapshot>'],
  ['test', 'npm test'],
  ['final-source-status', 'git status --porcelain --untracked-files=all'],
];

export function validateRollbackEvidence(rollback, candidateCommit, candidateTree, baseCommit, baseTree) {
  if (!rollback || rollback.schema_version !== 1 || rollback.status !== 'pass' || rollback.exit_code !== 0 ||
      rollback.isolated_checkout !== true || rollback.candidate_commit !== candidateCommit ||
      rollback.candidate_tree !== candidateTree || rollback.isolated_commit !== candidateCommit ||
      rollback.isolated_tree !== candidateTree || rollback.base_commit !== baseCommit ||
      rollback.base_tree !== baseTree || rollback.rollback_tree !== baseTree ||
      rollback.source_status !== '' || rollback.final_source_status !== '' ||
      !Array.isArray(rollback.commands) || rollback.commands.length !== ROLLBACK_COMMANDS.length) return false;
  for (let index = 0; index < ROLLBACK_COMMANDS.length; index++) {
    const record = rollback.commands[index];
    const [expectedId, expectedCommand] = ROLLBACK_COMMANDS[index];
    const retainedBytes = Buffer.byteLength(record?.output || '');
    const started = Date.parse(record?.started_at);
    const finished = Date.parse(record?.finished_at);
    if (!record || record.id !== expectedId || record.command !== expectedCommand ||
        record.exit_code !== 0 || record.status !== 'pass' ||
        !Number.isFinite(started) || !Number.isFinite(finished) || finished < started ||
        typeof record.output !== 'string' || !Number.isInteger(record.output_bytes) ||
        record.output_bytes < retainedBytes || typeof record.truncated !== 'boolean' ||
        (!record.truncated && record.output_bytes !== retainedBytes)) return false;
  }
  return rollback.commands[0].output.trim() === '' &&
    rollback.commands[2].output.trim() === candidateCommit &&
    rollback.commands[3].output.trim() === candidateTree &&
    rollback.commands[5].output.trim() === baseTree &&
    rollback.commands[9].output.trim() !== '' &&
    rollback.commands[10].output.trim() === '';
}

