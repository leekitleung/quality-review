import path from 'node:path';
import { userInfo } from 'node:os';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  chmodSync, closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync,
  realpathSync, renameSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { lstat, open, readFile, realpath, rename, rm, stat } from 'node:fs/promises';

export function isPathWithin(root, candidate) {
  const rootPath = path.resolve(root);
  const candPath = path.resolve(candidate);
  const relative = path.relative(rootPath, candPath);
  // Path is valid if it's within root (relative doesn't start with ..)
  // Handle both Unix (/) and Windows (\) separators
  const normalizedRelative = relative.replace(/\\/g, '/');
  return relative === '' || (!normalizedRelative.startsWith('..') && relative !== '..');
}

export function isRealDirectory(dir) {
  try {
    const stat = lstatSync(dir);
    return stat.isDirectory() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
}

export function resolveWithinRoot(root, relative, label = 'path') {
  if (typeof relative !== 'string' || !relative || path.isAbsolute(relative)) {
    throw new Error(`${label} must be a non-empty repository-relative path`);
  }
  const resolved = path.resolve(root, relative);
  if (!isPathWithin(root, resolved)) {
    throw new Error(`${label} escapes the repository: ${relative}`);
  }
  return resolved;
}

export function resolveReportDirectory(projectRoot, source = process.env) {
  return resolveWithinRoot(
    projectRoot,
    source?.RELEASE_QUALITY_REPORT_DIR || 'quality-reports',
    'RELEASE_QUALITY_REPORT_DIR',
  );
}

export function shouldIncludeCanonicalFile(name) {
  return name !== '.DS_Store';
}

const SUBPROCESS_ENV_ALLOWLIST = new Set([
  'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LANGUAGE',
  'LC_ALL', 'LC_CTYPE', 'TERM', 'COLORTERM', 'TERM_PROGRAM', 'TZ', 'CI', 'NO_COLOR',
  'FORCE_COLOR', 'CODEX_HOME', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'SYSTEMROOT', 'WINDIR',
  'CLAUDE_CONFIG_DIR',
  'COMSPEC', 'PATHEXT', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'NODE_TEST_CONTEXT',
  'NODE_V8_COVERAGE',
  'RELEASE_QUALITY_OUTER_SANDBOX_ATTESTED', 'RELEASE_QUALITY_OUTER_SANDBOX_READ_CANARY',
  'RELEASE_QUALITY_OUTER_SANDBOX_WRITE_CANARY',
]);

export function createSubprocessEnv(source = process.env) {
  const result = {};
  for (const [key, value] of Object.entries(source || {})) {
    if (typeof value === 'string' && SUBPROCESS_ENV_ALLOWLIST.has(key.toUpperCase())) result[key] = value;
  }
  return result;
}

export function createCandidateSubprocessEnv(source = process.env, isolatedHome) {
  if (typeof isolatedHome !== 'string' || !isolatedHome) throw new Error('isolated home is required');
  const result = createSubprocessEnv(source);
  for (const key of [
    'HOME', 'CODEX_HOME', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA',
  ]) delete result[key];
  result.HOME = isolatedHome;
  result.TMPDIR = isolatedHome;
  result.TMP = isolatedHome;
  result.TEMP = isolatedHome;
  if (process.platform === 'win32') result.USERPROFILE = isolatedHome;
  return result;
}

export function outerSandboxAttestationFromEnv(source = process.env) {
  if (source?.RELEASE_QUALITY_OUTER_SANDBOX_ATTESTED !== '1') return null;
  const readCanary = source.RELEASE_QUALITY_OUTER_SANDBOX_READ_CANARY;
  const writeCanary = source.RELEASE_QUALITY_OUTER_SANDBOX_WRITE_CANARY;
  if (!path.isAbsolute(readCanary || '') || !path.isAbsolute(writeCanary || '')) return null;
  return Object.freeze({ attested: true, readCanary, writeCanary });
}

export function wrapCandidateCommand(command, args, {
  allowedRoots = [], readOnlyRoots = [], writeRoots = [], hostHome = null, allowNetwork = false,
  outerSandboxAttestation = null, requireExactWriteIsolation = false,
} = {}) {
  if (process.platform !== 'darwin') throw new Error(`candidate filesystem sandbox is unavailable on ${process.platform}`);
  const probe = spawnSync('/usr/bin/sandbox-exec', [
    '-p', '(version 1) (allow default)', '/usr/bin/true',
  ], { encoding: 'utf8' });
  if (probe.status !== 0 && /sandbox_apply:\s*Operation not permitted/i.test(`${probe.stdout || ''}${probe.stderr || ''}`)) {
    const readCanary = outerSandboxAttestation?.readCanary;
    const writeCanary = outerSandboxAttestation?.writeCanary;
    const declaredRoots = [...allowedRoots, ...readOnlyRoots, ...writeRoots].map(root => path.resolve(root));
    const canariesAreValid = outerSandboxAttestation?.attested === true &&
      path.isAbsolute(readCanary || '') && path.isAbsolute(writeCanary || '') && existsSync(readCanary) &&
      !existsSync(writeCanary) &&
      declaredRoots.every(root => !isPathWithin(root, readCanary) && !isPathWithin(root, writeCanary));
    if (!canariesAreValid) throw new Error('candidate filesystem sandbox unavailable; nested execution fails closed');
    if (requireExactWriteIsolation) {
      throw new Error('reviewer filesystem sandbox unavailable; exact write isolation is required');
    }
    const capability = spawnSync(process.execPath, ['-e', `
      const fs = require('node:fs');
      let denied = 0;
      try { fs.readFileSync(${JSON.stringify(readCanary)}); } catch { denied++; }
      try { fs.writeFileSync(${JSON.stringify(writeCanary)}, 'forged'); } catch { denied++; }
      process.exit(denied === 2 ? 0 : 1);
    `], { encoding: 'utf8' });
    if (capability.status !== 0 || existsSync(writeCanary)) {
      rmSync(writeCanary, { force: true });
      throw new Error('outer sandbox capability check failed closed');
    }
    return { command, args };
  }
  if (probe.status !== 0) throw new Error('candidate filesystem sandbox probe failed closed');
  hostHome ||= userInfo().homedir;
  const writable = [...allowedRoots, ...writeRoots];
  if (readOnlyRoots.length === 0 && writable.length === 0) throw new Error('candidate sandbox roots are required');
  const canonicalize = root => existsSync(root) ? realpathSync(path.resolve(root)) : path.resolve(root);
  const readable = [...new Set([...readOnlyRoots, ...writable].map(canonicalize))];
  const roots = [...new Set(writable.map(canonicalize))];
  const runtimeRoot = path.dirname(path.dirname(realpathSync(process.execPath)));
  const quote = value => JSON.stringify(value);
  const readRoots = [
    '/', '/usr', '/System', '/Library', '/bin', '/sbin', '/opt/homebrew', '/private/etc',
    '/private/var/db', '/private/var/run', '/private/var/select', '/dev', runtimeRoot, ...readable,
  ];
  const profile = [
    '(version 1)',
    '(deny default)',
    '(allow process*)',
    '(allow signal (target same-sandbox))',
    '(allow sysctl*)',
    ...(allowNetwork ? ['(allow network*)'] : []),
    '(allow dynamic-code-generation)',
    '(allow file-read-metadata)',
    `(allow file-read* (literal "/") ${readRoots.slice(1).map(root => `(subpath ${quote(root)})`).join(' ')})`,
    `(allow file-write* ${[...roots, '/dev'].map(root => `(subpath ${quote(root)})`).join(' ')})`,
  ].join(' ');
  if (readable.some(root => root === realpathSync(hostHome))) throw new Error('host home cannot be a candidate sandbox root');
  return { command: '/usr/bin/sandbox-exec', args: ['-p', profile, command, ...args] };
}

export function ensureContainedDirectorySync(root, directory, mode = null) {
  const rootPath = path.resolve(root);
  const target = path.resolve(directory);
  if (!isPathWithin(rootPath, target)) throw new Error(`directory escapes repository: ${directory}`);
  const rootReal = realpathSync(rootPath);
  const relative = path.relative(rootPath, target);
  let current = rootPath;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    if (existsSync(current)) {
      const entry = lstatSync(current);
      if (entry.isSymbolicLink()) {
        throw new Error(`output directory component must not be a symbolic link: ${current}`);
      } else if (!entry.isDirectory()) {
        throw new Error(`output directory component is not a real directory: ${current}`);
      }
    } else {
      mkdirSync(current, { mode: 0o700 });
      chmodSync(current, 0o700);
    }
  }
  const targetReal = realpathSync(target);
  if (!isPathWithin(rootReal, targetReal)) throw new Error(`directory resolves outside repository: ${directory}`);
  if (mode !== null) chmodSync(targetReal, mode);
  return targetReal;
}

export function readContainedFileSync(root, file, encoding = 'utf8') {
  const rootReal = realpathSync(root);
  const resolved = path.resolve(file);
  if (!isPathWithin(root, resolved)) throw new Error(`input escapes report root: ${file}`);
  const entry = lstatSync(resolved);
  if (entry.isSymbolicLink() || !entry.isFile()) throw new Error(`input is not a regular file: ${file}`);
  const fileReal = realpathSync(resolved);
  if (!isPathWithin(rootReal, fileReal)) throw new Error(`input resolves outside report root: ${file}`);
  return readFileSync(fileReal, encoding);
}

export async function readContainedFile(root, file, encoding = 'utf8') {
  const rootReal = await realpath(root);
  const resolved = path.resolve(file);
  if (!isPathWithin(root, resolved)) throw new Error(`input escapes report root: ${file}`);
  const entry = await lstat(resolved);
  if (entry.isSymbolicLink() || !entry.isFile()) throw new Error(`input is not a regular file: ${file}`);
  const fileReal = await realpath(resolved);
  if (!isPathWithin(rootReal, fileReal)) throw new Error(`input resolves outside report root: ${file}`);
  return readFile(fileReal, encoding);
}

export function writeContainedFileSync(root, file, content) {
  const rootReal = realpathSync(root);
  const parentReal = ensureContainedDirectorySync(root, path.dirname(file));
  if (!isPathWithin(rootReal, parentReal)) throw new Error(`output parent resolves outside report root: ${file}`);
  const parentIdentity = statSync(parentReal);
  const destination = path.join(parentReal, path.basename(file));
  if (existsSync(destination)) {
    const entry = lstatSync(destination);
    if (entry.isSymbolicLink() || !entry.isFile()) throw new Error(`output is not a regular file: ${file}`);
  }
  const temporary = path.join(parentReal, `.${path.basename(file)}.${process.pid}.${randomUUID()}.tmp`);
  let descriptor;
  try {
    descriptor = openSync(temporary, 'wx', 0o600);
    writeFileSync(descriptor, content);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    const currentParentReal = realpathSync(path.dirname(file));
    const currentIdentity = statSync(currentParentReal);
    if (currentParentReal !== parentReal || currentIdentity.dev !== parentIdentity.dev ||
        currentIdentity.ino !== parentIdentity.ino || !isPathWithin(rootReal, currentParentReal)) {
      throw new Error(`output parent changed during write: ${file}`);
    }
    renameSync(temporary, destination);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    rmSync(temporary, { force: true });
  }
}

export async function writeContainedFile(root, file, content) {
  ensureContainedDirectorySync(root, path.dirname(file));
  const rootReal = await realpath(root);
  const parentReal = await realpath(path.dirname(file));
  if (!isPathWithin(rootReal, parentReal)) throw new Error(`output parent resolves outside repository: ${file}`);
  const parentIdentity = await stat(parentReal);
  const destination = path.join(parentReal, path.basename(file));
  const temporary = path.join(parentReal, `.${path.basename(file)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    const handle = await open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(content);
      await handle.sync();
    } finally {
      await handle.close();
    }
    const currentParentReal = await realpath(path.dirname(file));
    const currentIdentity = await stat(currentParentReal);
    if (currentParentReal !== parentReal || currentIdentity.dev !== parentIdentity.dev ||
        currentIdentity.ino !== parentIdentity.ino || !isPathWithin(rootReal, currentParentReal)) {
      throw new Error(`output parent changed during write: ${file}`);
    }
    await rename(temporary, destination);
  } finally {
    await rm(temporary, { force: true });
  }
}

export function containsSensitiveText(value) {
  const text = String(value || '').replace(/\[REDACTED[^\]]*\]/g, '');
  return [
    /-----BEGIN [^-]+ PRIVATE KEY-----/i,
    /https?:\/\/[^\s/@:]+:[^\s/@]+@/i,
    /\b(?:bearer|basic)\s+[A-Za-z0-9._~+/-]{12,}/i,
    /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/,
    /\bgithub_pat_[A-Za-z0-9_]{20,}\b/,
    /\bglpat-[A-Za-z0-9_-]{20,}\b/,
    /\bnpm_[A-Za-z0-9]{20,}\b/,
    /\bxox(?:a|b|p|r|s)-[A-Za-z0-9-]{10,}\b/,
    /\bAIza[0-9A-Za-z_-]{30,}\b/,
    /\b(?:sk|rk)_(?:live|test)_[0-9A-Za-z]{16,}\b/,
    /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/,
    /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/,
    /\b[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{8,}\b/,
    /(?:token|secret|password|api[_-]?key|private[_-]?key|access[_-]?key|credential)\s*[:=]\s*(?:["'][^"'\r\n]{8,}["']|[^\s"'`]{8,})/i,
  ].some(pattern => pattern.test(text));
}

export function redactSensitiveText(value) {
  return String(value || '')
    .replace(/-----BEGIN [^-]+ PRIVATE KEY-----[\s\S]*?-----END [^-]+ PRIVATE KEY-----/gi, '[REDACTED PEM]')
    .replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi, '$1[REDACTED]@')
    .replace(/\b(?:bearer|basic)\s+[^\s,;]+/gi, '[REDACTED AUTH]')
    .replace(/((?:cookie|set-cookie)\s*[:=]\s*)[^\r\n]+/gi, '$1[REDACTED]')
    .replace(/(["']?(?:token|secret|password|api[_-]?key|private[_-]?key|access[_-]?key|credential)["']?\s*[:=]\s*["'])[^"'\r\n]+(["'])/gi, '$1[REDACTED]$2')
    .replace(/((?:token|secret|password|api[_-]?key|private[_-]?key|access[_-]?key|credential)\s*[:=]\s*)[^\s,;]+/gi, '$1[REDACTED]')
    .replace(/\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g, '[REDACTED GITHUB TOKEN]')
    .replace(/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, '[REDACTED GITHUB TOKEN]')
    .replace(/\bglpat-[A-Za-z0-9_-]{20,}\b/g, '[REDACTED GITLAB TOKEN]')
    .replace(/\bnpm_[A-Za-z0-9]{20,}\b/g, '[REDACTED NPM TOKEN]')
    .replace(/\bxox(?:a|b|p|r|s)-[A-Za-z0-9-]{10,}\b/g, '[REDACTED SLACK TOKEN]')
    .replace(/\bAIza[0-9A-Za-z_-]{30,}\b/g, '[REDACTED GOOGLE API KEY]')
    .replace(/\b(?:sk|rk)_(?:live|test)_[0-9A-Za-z]{16,}\b/g, '[REDACTED STRIPE KEY]')
    .replace(/\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/g, '[REDACTED API TOKEN]')
    .replace(/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, '[REDACTED AWS KEY]')
    .replace(/\b[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{8,}\b/g, '[REDACTED JWT]');
}
