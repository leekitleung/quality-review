#!/usr/bin/env node
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import {
  createCandidateSubprocessEnv, createSubprocessEnv, redactSensitiveText, resolveWithinRoot, writeContainedFile,
  wrapCandidateCommand,
} from '../skills/release-quality-review/lib/security-utils.mjs';
import {
  findTrivialVerificationScripts, hasConcreteVerificationOutput,
} from '../skills/release-quality-review/lib/review-utils.mjs';

const root = process.cwd();
const subprocessEnv = createSubprocessEnv();
const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== '--output' || !args[1] || args[1].startsWith('-')) {
  console.error('Usage: verify-clean-candidate.mjs --output quality-reports/round-NNN/evidence/clean-candidate.json');
  process.exit(4);
}
let outputPath;
try {
  outputPath = resolveWithinRoot(root, args[1], 'evidence output');
} catch {
  console.error('Invalid evidence output path: it must stay inside the repository.');
  console.error('Usage: verify-clean-candidate.mjs --output quality-reports/round-NNN/evidence/clean-candidate.json');
  process.exit(4);
}
if (!/quality-reports[/\\]round-\d+[/\\]evidence[/\\]clean-candidate\.json$/.test(outputPath)) {
  console.error('Clean-candidate evidence must be written under quality-reports/round-NNN/evidence/');
  process.exit(4);
}

function run(id, command, args, cwd, env = subprocessEnv, displayCommand = null, sandboxOptions = null) {
  const startedAt = new Date().toISOString();
  const executable = sandboxOptions ? wrapCandidateCommand(command, args, sandboxOptions) : { command, args };
  const result = spawnSync(executable.command, executable.args, {
    cwd, encoding: 'utf8', timeout: 180000, maxBuffer: 8 * 1024 * 1024, env,
  });
  const raw = `${result.stdout || ''}${result.stderr || ''}`;
  const redacted = redactSensitiveText(raw);
  return {
    id,
    command: displayCommand || [command, ...args].join(' '),
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    exit_code: result.status ?? 1,
    status: result.status === 0 ? 'pass' : 'fail',
    output: redacted.slice(-8000),
    output_bytes: Buffer.byteLength(redacted),
    truncated: Buffer.byteLength(redacted) > Buffer.byteLength(redacted.slice(-8000)),
  };
}

const sourceStatus = run('source-status', 'git', ['status', '--porcelain', '--untracked-files=all'], root);
if (sourceStatus.exit_code !== 0 || sourceStatus.output.trim()) {
  console.error('Source candidate must be committed and clean before isolated verification');
  process.exit(1);
}

const temporary = await mkdtemp(path.join(os.tmpdir(), 'release-quality-review-'));
const candidate = path.join(temporary, 'candidate');
const isolatedHome = await mkdtemp(path.join(temporary, 'home-'));
const candidateEnv = createCandidateSubprocessEnv(process.env, isolatedHome);
const records = [];
try {
  const sandboxOptions = { readOnlyRoots: [root], writeRoots: [temporary] };
  const clone = run('clone', 'git', ['clone', '--quiet', '--no-local', root, candidate], temporary, candidateEnv,
    'git clone --quiet --no-local <source> <candidate>', sandboxOptions);
  records.push(clone);
  if (clone.exit_code === 0) {
    const startedAt = new Date().toISOString();
    let scriptIssues = [];
    try {
      const manifest = JSON.parse(await readFile(path.join(candidate, 'package.json'), 'utf8'));
      scriptIssues = findTrivialVerificationScripts(manifest.scripts, [
        'npm test', 'npm run coverage', 'npm run skill:check-drift', 'npm run lint',
        'npm run build', 'npm run skill:check', 'npm run skill:verify',
      ]);
    } catch {
      scriptIssues = [{ command: 'package.json', script: 'unreadable' }];
    }
    const scriptOutput = scriptIssues.length === 0
      ? 'verified 7 non-trivial verification scripts'
      : `trivial or missing verification scripts: ${scriptIssues.map(issue => issue.script).join(', ')}`;
    records.push({
      id: 'script-integrity', command: 'verify package verification scripts',
      started_at: startedAt, finished_at: new Date().toISOString(),
      exit_code: scriptIssues.length === 0 ? 0 : 1, status: scriptIssues.length === 0 ? 'pass' : 'fail',
      output: scriptOutput, output_bytes: Buffer.byteLength(scriptOutput), truncated: false,
    });
    if (scriptIssues.length === 0) {
      const auditRoot = path.join(isolatedHome, 'trusted-audit');
      await mkdir(auditRoot, { recursive: true });
      for (const file of ['package.json', 'package-lock.json', 'npm-shrinkwrap.json']) {
        try { await copyFile(path.join(candidate, file), path.join(auditRoot, file)); } catch (error) {
          if (error.code !== 'ENOENT') throw error;
        }
      }
      const userConfig = path.join(isolatedHome, 'trusted-user.npmrc');
      const globalConfig = path.join(isolatedHome, 'trusted-global.npmrc');
      await writeFile(userConfig, '');
      await writeFile(globalConfig, '');
      for (const [id, command, args] of [
        ['install', 'npm', ['ci', '--ignore-scripts']],
        ['test', 'npm', ['test']],
        ['coverage', 'npm', ['run', 'coverage']],
        ['drift', 'npm', ['run', 'skill:check-drift']],
        ['lint', 'npm', ['run', 'lint']],
        ['build', 'npm', ['run', 'build']],
        ['audit', 'npm', [
          'audit', '--audit-level=high', '--registry=https://registry.npmjs.org/',
          `--userconfig=${userConfig}`, `--globalconfig=${globalConfig}`,
        ]],
        ['skill-check', 'npm', ['run', 'skill:check']],
        ['skill-verify', 'npm', ['run', 'skill:verify']],
        ['final-status', 'git', ['status', '--porcelain', '--untracked-files=all']],
      ]) records.push(run(
        id, command, args, id === 'audit' ? auditRoot : candidate, candidateEnv,
        id === 'audit' ? 'npm audit --audit-level=high' : null,
        id === 'audit'
          ? { readOnlyRoots: [auditRoot], writeRoots: [isolatedHome], allowNetwork: true }
          : sandboxOptions
      ));
    }
  }
  const commit = run('candidate-commit', 'git', ['rev-parse', 'HEAD'], root);
  const tree = run('candidate-tree', 'git', ['rev-parse', 'HEAD^{tree}'], root);
  const isolatedCommit = run('isolated-commit', 'git', ['rev-parse', 'HEAD'], candidate, candidateEnv, null, sandboxOptions);
  const isolatedTree = run('isolated-tree', 'git', ['rev-parse', 'HEAD^{tree}'], candidate, candidateEnv, null, sandboxOptions);
  const finalSourceStatus = run('final-source-status', 'git', ['status', '--porcelain', '--untracked-files=all'], root);
  const passed = records.length === 12 && records.every(record => record.exit_code === 0) &&
    hasConcreteVerificationOutput('test', records.find(record => record.id === 'test')?.output) &&
    hasConcreteVerificationOutput('coverage', records.find(record => record.id === 'coverage')?.output) &&
    records.at(-1).output.trim() === '' && isolatedCommit.exit_code === 0 && isolatedTree.exit_code === 0 &&
    isolatedCommit.output.trim() === commit.output.trim() && isolatedTree.output.trim() === tree.output.trim() &&
    finalSourceStatus.exit_code === 0 && finalSourceStatus.output.trim() === '';
  const report = {
    schema_version: 1,
    candidate_commit: commit.output.trim(),
    candidate_tree: tree.output.trim(),
    isolated_commit: isolatedCommit.output.trim(),
    isolated_tree: isolatedTree.output.trim(),
    source_status: sourceStatus.output,
    final_source_status: finalSourceStatus.output,
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
