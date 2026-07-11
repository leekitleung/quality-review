#!/usr/bin/env node
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { redactSensitiveText, resolveWithinRoot, writeContainedFile } from '../skills/release-quality-review/lib/security-utils.mjs';

const root = process.cwd();
const outputIndex = process.argv.indexOf('--output');
if (outputIndex < 0 || !process.argv[outputIndex + 1]) {
  console.error('Usage: verify-clean-candidate.mjs --output quality-reports/round-NNN/evidence/clean-candidate.json');
  process.exit(4);
}
const outputPath = resolveWithinRoot(root, process.argv[outputIndex + 1], 'evidence output');
if (!/quality-reports[/\\]round-\d+[/\\]evidence[/\\]clean-candidate\.json$/.test(outputPath)) {
  console.error('Clean-candidate evidence must be written under quality-reports/round-NNN/evidence/');
  process.exit(4);
}

function run(command, args, cwd) {
  const startedAt = new Date().toISOString();
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', timeout: 180000, maxBuffer: 8 * 1024 * 1024 });
  const raw = `${result.stdout || ''}${result.stderr || ''}`;
  const redacted = redactSensitiveText(raw);
  return {
    command: [command, ...args].join(' '),
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    exit_code: result.status ?? 1,
    output: redacted.slice(-8000),
    output_bytes: Buffer.byteLength(redacted),
    truncated: Buffer.byteLength(redacted) > Buffer.byteLength(redacted.slice(-8000)),
  };
}

const sourceStatus = run('git', ['status', '--porcelain', '--untracked-files=all'], root);
if (sourceStatus.exit_code !== 0 || sourceStatus.output.trim()) {
  console.error('Source candidate must be committed and clean before isolated verification');
  process.exit(1);
}

const temporary = await mkdtemp(path.join(os.tmpdir(), 'release-quality-review-'));
const candidate = path.join(temporary, 'candidate');
const records = [];
try {
  const clone = run('git', ['clone', '--quiet', '--no-local', root, candidate], temporary);
  records.push(clone);
  if (clone.exit_code === 0) {
    for (const [command, args] of [
      ['npm', ['ci', '--ignore-scripts']],
      ['npm', ['test']],
      ['npm', ['run', 'skill:check-drift']],
      ['npm', ['run', 'lint']],
      ['npm', ['run', 'build']],
      ['npm', ['audit', '--audit-level=high']],
      ['npm', ['run', 'skill:check']],
      ['npm', ['run', 'skill:verify']],
      ['git', ['status', '--porcelain', '--untracked-files=all']],
    ]) records.push(run(command, args, candidate));
  }
  const commit = run('git', ['rev-parse', 'HEAD'], root);
  const tree = run('git', ['rev-parse', 'HEAD^{tree}'], root);
  const passed = records.length === 10 && records.every(record => record.exit_code === 0) &&
    records.at(-1).output.trim() === '';
  const report = {
    schema_version: 1,
    candidate_commit: commit.output.trim(),
    candidate_tree: tree.output.trim(),
    source_status: sourceStatus.output,
    isolated_checkout: true,
    status: passed ? 'pass' : 'fail',
    exit_code: passed ? 0 : 1,
    commands: records,
  };
  await writeContainedFile(root, outputPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`Clean candidate verification ${report.status}: ${outputPath}`);
  process.exitCode = report.exit_code;
} finally {
  await rm(temporary, { recursive: true, force: true });
}
