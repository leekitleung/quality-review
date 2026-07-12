import path from 'node:path';
import { userInfo } from 'node:os';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync,
  realpathSync, renameSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { open, realpath, rename, rm, stat } from 'node:fs/promises';

export function isPathWithin(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
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

export function shouldIncludeCanonicalFile(name) {
  return name !== '.DS_Store';
}

const SUBPROCESS_ENV_ALLOWLIST = new Set([
  'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LANGUAGE',
  'LC_ALL', 'LC_CTYPE', 'TERM', 'COLORTERM', 'TERM_PROGRAM', 'TZ', 'CI', 'NO_COLOR',
  'FORCE_COLOR', 'CODEX_HOME', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'SYSTEMROOT', 'WINDIR',
  'COMSPEC', 'PATHEXT', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'NODE_TEST_CONTEXT',
  'NODE_V8_COVERAGE',
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
  if (process.platform === 'win32') result.USERPROFILE = isolatedHome;
  return result;
}

export function wrapCandidateCommand(command, args, { allowedRoots, hostHome = userInfo().homedir } = {}) {
  if (process.platform !== 'darwin') throw new Error(`candidate filesystem sandbox is unavailable on ${process.platform}`);
  if (!Array.isArray(allowedRoots) || allowedRoots.length === 0) throw new Error('candidate sandbox roots are required');
  const roots = [...new Set(allowedRoots.map(root => realpathSync(path.resolve(root))))];
  const runtimeRoot = path.dirname(path.dirname(realpathSync(process.execPath)));
  const quote = value => JSON.stringify(value);
  const readRoots = [
    '/', '/usr', '/System', '/Library', '/bin', '/sbin', '/opt/homebrew', '/private', '/dev', runtimeRoot, ...roots,
  ];
  const profile = [
    '(version 1)',
    '(deny default)',
    '(allow process*)',
    '(allow signal (target same-sandbox))',
    '(allow sysctl*)',
    '(allow mach*)',
    '(allow network*)',
    '(allow dynamic-code-generation)',
    '(allow file-read-metadata)',
    `(allow file-read* (literal "/") ${readRoots.slice(1).map(root => `(subpath ${quote(root)})`).join(' ')})`,
    `(allow file-write* ${[...roots, '/private/tmp', '/private/var/folders', '/dev'].map(root => `(subpath ${quote(root)})`).join(' ')})`,
  ].join(' ');
  if (roots.some(root => root === realpathSync(hostHome))) throw new Error('host home cannot be a candidate sandbox root');
  const probe = spawnSync('/usr/bin/sandbox-exec', [
    '-p', '(version 1) (allow default)', '/usr/bin/true',
  ], { encoding: 'utf8' });
  if (probe.status === 0) return { command: '/usr/bin/sandbox-exec', args: ['-p', profile, command, ...args] };
  if (/sandbox_apply:\s*Operation not permitted/i.test(`${probe.stdout || ''}${probe.stderr || ''}`)) {
    return { command, args };
  }
  throw new Error('candidate filesystem sandbox probe failed closed');
}

export function ensureContainedDirectorySync(root, directory) {
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
      if (entry.isSymbolicLink() || !entry.isDirectory()) {
        throw new Error(`output directory component is not a real directory: ${current}`);
      }
    } else {
      mkdirSync(current);
    }
  }
  const targetReal = realpathSync(target);
  if (!isPathWithin(rootReal, targetReal)) throw new Error(`directory resolves outside repository: ${directory}`);
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
  const text = String(value || '');
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
