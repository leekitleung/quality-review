#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import {
  createCandidateSubprocessEnv, createSubprocessEnv, redactSensitiveText, resolveWithinRoot,
  outerSandboxAttestationFromEnv, writeContainedFile, wrapCandidateCommand,
} from '../lib/security-utils.mjs';
import { resolveRepositoryContext } from '../lib/candidate-runtime.mjs';

const root = process.cwd();
const { repositoryRoot, projectRelative } = resolveRepositoryContext(root);
const subprocessEnv = createSubprocessEnv();
function parseArgs(args) {
  let baseRef = null;
  let outputArg = null;
  for (let index = 0; index < args.length; index++) {
    if (args[index] === '--help' || args[index] === '-h') {
      console.log('Usage: verify-rollback.mjs --base <ref> --output quality-reports/round-NNN/evidence/rollback-verification.json');
      process.exit(0);
    } else if (args[index] === '--base' && args[index + 1]) baseRef = args[++index];
    else if (args[index] === '--output' && args[index + 1]) outputArg = args[++index];
    else {
      console.error(`Unknown or incomplete option: ${args[index]}`);
      console.error('Use --help for usage.');
      process.exit(4);
    }
  }
  return Object.freeze({ baseRef, outputArg });
}
const { baseRef, outputArg } = parseArgs(process.argv.slice(2));
if (!baseRef || !outputArg || !/^[A-Za-z0-9._/@-]+$/.test(baseRef)) {
  console.error('Usage: verify-rollback.mjs --base <ref> --output quality-reports/round-NNN/evidence/rollback-verification.json');
  process.exit(4);
}
function resolveOutputPath(value) {
  try {
    return resolveWithinRoot(root, value, 'rollback evidence output');
  } catch {
    console.error('Invalid rollback evidence output path: it must stay inside the repository.');
    console.error('Usage: verify-rollback.mjs --base <ref> --output quality-reports/round-NNN/evidence/rollback-verification.json');
    process.exit(4);
  }
}
const outputPath = resolveOutputPath(outputArg);
if (!/quality-reports[/\\]round-\d+[/\\]evidence[/\\]rollback-verification\.json$/.test(outputPath)) {
  console.error('Rollback evidence must be written under quality-reports/round-NNN/evidence/');
  process.exit(4);
}

function run(id, command, commandArgs, cwd, env = subprocessEnv, displayCommand = null, sandboxOptions = null) {
  const startedAt = new Date().toISOString();
  const executable = sandboxOptions ? wrapCandidateCommand(command, commandArgs, sandboxOptions) : { command, args: commandArgs };
  const result = spawnSync(executable.command, executable.args, {
    cwd, encoding: 'utf8', timeout: 180000, maxBuffer: 8 * 1024 * 1024, env,
  });
  const raw = `${result.stdout || ''}${result.stderr || ''}`;
  const redacted = redactSensitiveText(raw);
  const output = redacted.slice(-8000);
  return {
    id,
    command: displayCommand || [command, ...commandArgs].join(' '),
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    exit_code: result.status ?? 1,
    status: result.status === 0 ? 'pass' : 'fail',
    output,
    output_bytes: Buffer.byteLength(redacted),
    truncated: Buffer.byteLength(redacted) > Buffer.byteLength(output),
  };
}

function gitValue(args, cwd = root) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 10000, env: subprocessEnv });
  if (result.status !== 0) throw new Error(String(result.stderr || 'git command failed').trim());
  return result.stdout.trim();
}

const candidateCommit = gitValue(['rev-parse', 'HEAD']);
const candidateTree = gitValue(['rev-parse', 'HEAD^{tree}']);
function resolveBaseIdentity(ref) {
  try {
    return {
      commit: gitValue(['rev-parse', `${ref}^{commit}`]),
      tree: gitValue(['rev-parse', `${ref}^{tree}`]),
    };
  } catch {
    console.error(`Invalid --base ref: ${ref}`);
    console.error('Usage: verify-rollback.mjs --base <ref> --output quality-reports/round-NNN/evidence/rollback-verification.json');
    process.exit(4);
  }
}
const { commit: baseCommit, tree: baseTree } = resolveBaseIdentity(baseRef);
const sourceStatus = run('source-status', 'git', ['status', '--porcelain', '--untracked-files=all'], root);
if (sourceStatus.exit_code !== 0 || sourceStatus.output.trim()) {
  console.error('Source candidate must be committed and clean before rollback verification');
  process.exit(1);
}

const temporary = await mkdtemp(path.join(os.tmpdir(), 'release-quality-rollback-'));
const inheritedAttestation = outerSandboxAttestationFromEnv();
const attestationRoot = inheritedAttestation ? null : await mkdtemp(path.join(os.tmpdir(), 'release-quality-attestation-'));
const rollbackRepository = path.join(temporary, 'rollback');
const rollbackRoot = path.join(rollbackRepository, projectRelative);
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
const corepackHome = process.env.COREPACK_HOME || path.join(os.homedir(), '.cache', 'node', 'corepack');
candidateEnv.COREPACK_HOME = corepackHome;
candidateEnv.COREPACK_ENABLE_NETWORK = '0';
candidateEnv.COREPACK_DEFAULT_TO_LATEST = '0';
const cloneSandboxOptions = {
  readOnlyRoots: [repositoryRoot, ...(existsSync(corepackHome) ? [corepackHome] : [])],
  writeRoots: [temporary], outerSandboxAttestation,
};
const sandboxOptions = {
  readOnlyRoots: [rollbackRepository, ...(existsSync(corepackHome) ? [corepackHome] : [])],
  writeRoots: [temporary], outerSandboxAttestation,
};
const records = [sourceStatus];
try {
  const clone = run('clone', 'git', ['clone', '--quiet', '--no-local', repositoryRoot, rollbackRepository], temporary, candidateEnv,
    'git clone --quiet --no-local <source> <rollback>', cloneSandboxOptions);
  records.push(clone);
  if (clone.exit_code === 0) {
    records.push(run('isolated-commit', 'git', ['rev-parse', 'HEAD'], rollbackRoot, candidateEnv, null, sandboxOptions));
    records.push(run('isolated-tree', 'git', ['rev-parse', 'HEAD^{tree}'], rollbackRoot, candidateEnv, null, sandboxOptions));
    const commits = gitValue(['rev-list', `${baseCommit}..HEAD`], rollbackRoot).split('\n').filter(Boolean);
    records.push(run('revert', 'git', ['revert', '--no-commit', ...commits], rollbackRoot, candidateEnv,
      'git revert --no-commit <base>..HEAD', sandboxOptions));
    records.push(run('rollback-tree', 'git', ['write-tree'], rollbackRoot, candidateEnv, null, sandboxOptions));
    const rollbackConfig = readFileSync(path.join(rollbackRoot, 'skills/release-quality-review/review-config.yaml'), 'utf8');
    const usesPnpm = /\bpnpm\b/.test(rollbackConfig);
    const packageManager = usesPnpm
      ? run('package-manager', 'pnpm', ['--version'], rollbackRoot, candidateEnv,
        'verify pre-provisioned rollback package manager', sandboxOptions)
      : run('package-manager', 'npm', ['--version'], rollbackRoot, candidateEnv,
        'verify pre-provisioned rollback package manager', sandboxOptions);
    if (usesPnpm && packageManager.output.trim() !== '10.33.0') {
      packageManager.status = 'fail';
      packageManager.exit_code = 1;
      packageManager.output = 'required pre-provisioned pnpm version 10.33.0 is unavailable';
      packageManager.output_bytes = Buffer.byteLength(packageManager.output);
      packageManager.truncated = false;
    }
    records.push(packageManager);
    records.push(run('rollback-commit', 'git', [
      '-c', 'user.name=Release Quality Review',
      '-c', 'user.email=release-quality-review@example.invalid',
      'commit', '--quiet', '--no-gpg-sign', '-m', 'test: materialize rollback snapshot',
    ], rollbackRoot, candidateEnv, 'git commit <rollback snapshot>', sandboxOptions));
    records.push(run('test', 'npm', ['test'], rollbackRoot, candidateEnv, null, sandboxOptions));
  }
  const finalSourceStatus = run('final-source-status', 'git', ['status', '--porcelain', '--untracked-files=all'], root);
  records.push(finalSourceStatus);
  const isolatedCommit = records.find(record => record.id === 'isolated-commit')?.output.trim() || '';
  const isolatedTree = records.find(record => record.id === 'isolated-tree')?.output.trim() || '';
  const rollbackTree = records.find(record => record.id === 'rollback-tree')?.output.trim() || '';
  const passed = records.length === 10 && records.every(record => record.exit_code === 0) &&
    isolatedCommit === candidateCommit && isolatedTree === candidateTree && rollbackTree === baseTree &&
    records.find(record => record.id === 'test')?.output.trim() && finalSourceStatus.output.trim() === '';
  const report = {
    schema_version: 1,
    candidate_commit: candidateCommit,
    candidate_tree: candidateTree,
    base_ref: baseRef,
    base_commit: baseCommit,
    base_tree: baseTree,
    isolated_commit: isolatedCommit,
    isolated_tree: isolatedTree,
    rollback_tree: rollbackTree,
    source_status: sourceStatus.output,
    final_source_status: finalSourceStatus.output,
    isolated_checkout: true,
    status: passed ? 'pass' : 'fail',
    exit_code: passed ? 0 : 1,
    commands: records,
  };
  await writeContainedFile(root, outputPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`Rollback verification ${report.status}: ${outputPath}`);
  process.exitCode = report.exit_code;
} finally {
  await rm(temporary, { recursive: true, force: true });
  if (attestationRoot) await rm(attestationRoot, { recursive: true, force: true });
}
