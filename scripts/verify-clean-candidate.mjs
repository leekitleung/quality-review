#!/usr/bin/env node
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import {
  createCandidateSubprocessEnv, createSubprocessEnv, redactSensitiveText, resolveWithinRoot, writeContainedFile,
  outerSandboxAttestationFromEnv, wrapCandidateCommand,
} from '../skills/release-quality-review/lib/security-utils.mjs';
import { MAX_BUFFER, TIMEOUTS } from '../skills/release-quality-review/lib/config-constants.mjs';
import {
  CLEAN_CANDIDATE_COMMANDS, findTrivialVerificationScripts, hasConcreteVerificationOutput,
} from '../skills/release-quality-review/lib/review-utils.mjs';
import { resolveRepositoryContext } from '../skills/release-quality-review/lib/candidate-runtime.mjs';

const root = process.cwd();
const { repositoryRoot, projectRelative } = resolveRepositoryContext(root);
const subprocessEnv = createSubprocessEnv();
const args = process.argv.slice(2);
if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) {
  console.log('Usage: verify-clean-candidate.mjs --output quality-reports/round-NNN/evidence/clean-candidate.json');
  process.exit(0);
}
if (args.length !== 2 || args[0] !== '--output' || !args[1] || args[1].startsWith('-')) {
  console.error('Usage: verify-clean-candidate.mjs --output quality-reports/round-NNN/evidence/clean-candidate.json');
  console.error('Use --help for usage.');
  process.exit(4);
}
function resolveOutputPath(outputArg) {
  try {
    return resolveWithinRoot(root, outputArg, 'evidence output');
  } catch {
    console.error('Invalid evidence output path: it must stay inside the repository.');
    console.error('Usage: verify-clean-candidate.mjs --output quality-reports/round-NNN/evidence/clean-candidate.json');
    process.exit(4);
  }
}
const outputPath = resolveOutputPath(args[1]);
if (!/quality-reports[/\\]round-\d+[/\\]evidence[/\\]clean-candidate\.json$/.test(outputPath)) {
  console.error('Clean-candidate evidence must be written under quality-reports/round-NNN/evidence/');
  process.exit(4);
}

function run(id, command, args, cwd, env = subprocessEnv, displayCommand = null, sandboxOptions = null) {
  const startedAt = new Date().toISOString();
  const executable = sandboxOptions ? wrapCandidateCommand(command, args, sandboxOptions) : { command, args };
  const result = spawnSync(executable.command, executable.args, {
    cwd, encoding: 'utf8', timeout: TIMEOUTS.ROLLBACK_OPERATION, maxBuffer: MAX_BUFFER.ROLLBACK_OUTPUT, env,
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

const sourceManifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const sourceScriptIssues = findTrivialVerificationScripts(sourceManifest.scripts, [
  'npm test', 'npm run coverage', 'npm run typecheck', 'npm run lint',
  'npm run build', 'npm run test:e2e',
]);
if (sourceScriptIssues.length > 0) {
  const commit = run('candidate-commit', 'git', ['rev-parse', 'HEAD'], root);
  const tree = run('candidate-tree', 'git', ['rev-parse', 'HEAD^{tree}'], root);
  const now = new Date().toISOString();
  const output = `trivial or missing verification scripts: ${sourceScriptIssues.map(issue => issue.script).join(', ')}`;
  const report = {
    schema_version: 1,
    candidate_commit: commit.output.trim(),
    candidate_tree: tree.output.trim(),
    isolated_commit: '',
    isolated_tree: '',
    source_status: sourceStatus.output,
    final_source_status: sourceStatus.output,
    isolated_checkout: false,
    status: 'fail',
    exit_code: 1,
    commands: [{
      id: 'script-integrity', command: 'verify package verification scripts',
      started_at: now, finished_at: now, exit_code: 1, status: 'fail', output,
      output_bytes: Buffer.byteLength(output), truncated: false,
    }],
  };
  await writeContainedFile(root, outputPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`Clean candidate verification fail: ${outputPath}`);
  process.exit(1);
}

const temporary = await mkdtemp(path.join(os.tmpdir(), 'release-quality-review-'));
const inheritedAttestation = outerSandboxAttestationFromEnv();
const attestationRoot = inheritedAttestation ? null : await mkdtemp(path.join(os.tmpdir(), 'release-quality-attestation-'));
const candidateRepository = path.join(temporary, 'candidate');
const candidate = path.join(candidateRepository, projectRelative);
const isolatedHome = await mkdtemp(path.join(temporary, 'home-'));
const candidateEnv = createCandidateSubprocessEnv(process.env, isolatedHome);
const outerReadCanary = inheritedAttestation?.readCanary || path.join(attestationRoot, 'read-canary');
const outerWriteCanary = inheritedAttestation?.writeCanary || path.join(attestationRoot, 'write-canary');
if (!inheritedAttestation) await writeFile(outerReadCanary, 'trusted');
const outerSandboxAttestation = inheritedAttestation || Object.freeze({
  attested: true, readCanary: outerReadCanary, writeCanary: outerWriteCanary,
});
candidateEnv.RELEASE_QUALITY_OUTER_SANDBOX_ATTESTED = '1';
candidateEnv.RELEASE_QUALITY_OUTER_SANDBOX_READ_CANARY = outerReadCanary;
candidateEnv.RELEASE_QUALITY_OUTER_SANDBOX_WRITE_CANARY = outerWriteCanary;
const records = [];
try {
  const cloneSandboxOptions = { readOnlyRoots: [repositoryRoot], writeRoots: [temporary], outerSandboxAttestation };
  const clone = run('clone', 'git', ['clone', '--quiet', '--no-local', repositoryRoot, candidateRepository], temporary, candidateEnv,
    'git clone --quiet --no-local <source> <candidate>', cloneSandboxOptions);
  records.push(clone);
  if (clone.exit_code === 0) {
    const sandboxOptions = { readOnlyRoots: [candidateRepository], writeRoots: [temporary], outerSandboxAttestation };
    const startedAt = new Date().toISOString();
    let scriptIssues = [];
    try {
      const manifest = JSON.parse(await readFile(path.join(candidate, 'package.json'), 'utf8'));
      scriptIssues = findTrivialVerificationScripts(manifest.scripts, [
        'npm test', 'npm run coverage', 'npm run typecheck', 'npm run lint',
        'npm run build', 'npm run test:e2e',
      ]);
    } catch {
      scriptIssues = [{ command: 'package.json', script: 'unreadable' }];
    }
    const scriptOutput = scriptIssues.length === 0
      ? 'verified 6 non-trivial verification scripts'
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
        ['typecheck', 'npm', ['run', 'typecheck']],
        ['lint', 'npm', ['run', 'lint']],
        ['build', 'npm', ['run', 'build']],
        ['audit', 'npm', [
          'audit', '--audit-level=high', '--registry=https://registry.npmjs.org/',
          `--userconfig=${userConfig}`, `--globalconfig=${globalConfig}`,
        ]],
        ['e2e', 'npm', ['run', 'test:e2e']],
        ['final-status', 'git', ['status', '--porcelain', '--untracked-files=all']],
      ]) records.push(run(
        id, command, args, id === 'audit' ? auditRoot : candidate, candidateEnv,
        id === 'audit' ? 'npm audit --audit-level=high' : null,
        id === 'audit'
          ? { readOnlyRoots: [auditRoot], writeRoots: [isolatedHome], allowNetwork: true, outerSandboxAttestation }
          : id === 'install'
            ? { ...sandboxOptions, allowNetwork: true }
            : sandboxOptions
      ));
    }
  }
  const sandboxOptions = { readOnlyRoots: [candidateRepository], writeRoots: [temporary], outerSandboxAttestation };
  const commit = run('candidate-commit', 'git', ['rev-parse', 'HEAD'], root);
  const tree = run('candidate-tree', 'git', ['rev-parse', 'HEAD^{tree}'], root);
  const isolatedCommit = run('isolated-commit', 'git', ['rev-parse', 'HEAD'], candidate, candidateEnv, null, sandboxOptions);
  const isolatedTree = run('isolated-tree', 'git', ['rev-parse', 'HEAD^{tree}'], candidate, candidateEnv, null, sandboxOptions);
  const finalSourceStatus = run('final-source-status', 'git', ['status', '--porcelain', '--untracked-files=all'], root);
  const passed = records.length === CLEAN_CANDIDATE_COMMANDS.length && records.every(record => record.exit_code === 0) &&
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
  if (attestationRoot) await rm(attestationRoot, { recursive: true, force: true });
}
