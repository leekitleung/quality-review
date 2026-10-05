import path from 'node:path';
import { userInfo } from 'node:os';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  chmodSync, closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync,
  realpathSync, renameSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { lstat, open, readFile, realpath, rename, rm, stat } from 'node:fs/promises';

import { buildCandidateSandboxProfile } from './sandbox-profile.mjs';
import { FILE_PERMISSIONS } from './config-constants.mjs';
import { gateError } from './error-messages.mjs';

// Filesystem boundary primitives for the gate. Everything the candidate or a
// reviewer may touch passes through one of these helpers: path containment
// checks, subprocess environment filtering, sandbox command wrapping, and
// report-root-confined reads/writes. The invariants documented here are
// security contracts - the adversarial tests in __tests__/evidence-security
// and sandbox-profile pin them, so tighten a check only with a new attack
// case, never to make a failing fixture pass.

/**
 * True when `candidate` resolves inside `root` (or equals it).
 *
 * SECURITY: the comparison runs on `path.relative` output, not string
 * prefixes, so `..` segments and drive-relative paths cannot slip through.
 * Separators are normalized to '/' because Windows `path.relative` mixes
 * them and a naive prefix check would accept `root\..\escape`.
 * @param {string} root - Containing directory (either separator style).
 * @param {string} candidate - Path to test; need not exist.
 * @returns {boolean}
 */
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

/**
 * Resolve a repository-relative path, refusing absolute input and escapes.
 * Absolute input is rejected outright (not re-rooted) so a crafted
 * RELEASE_QUALITY_REPORT_DIR cannot point at an arbitrary directory.
 * @param {string} root - Repository root.
 * @param {string} relative - Non-empty, non-absolute relative path.
 * @param {string} [label] - Name used in error messages.
 * @returns {string} Absolute resolved path.
 * @throws {Error} When the input is empty, absolute, or escapes `root`.
 */
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

/**
 * Locate the round-report root, confined to the project. The env override is
 * treated as untrusted input: it must stay inside the repository.
 * @param {string} projectRoot
 * @param {object} [source] - Environment to read (defaults to process.env).
 * @returns {string} Absolute report directory path.
 * @throws {Error} When RELEASE_QUALITY_REPORT_DIR escapes the repository.
 */
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
  'CLAUDE_CONFIG_DIR', 'PLAYWRIGHT_BROWSERS_PATH', 'NPM_CONFIG_CACHE',
  'COMSPEC', 'PATHEXT', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'NODE_TEST_CONTEXT',
  'NODE_V8_COVERAGE',
  'RELEASE_QUALITY_OUTER_SANDBOX_ATTESTED', 'RELEASE_QUALITY_OUTER_SANDBOX_READ_CANARY',
  'RELEASE_QUALITY_OUTER_SANDBOX_WRITE_CANARY',
  'RELEASE_QUALITY_CODEX_AUTH_MODE',
  'RELEASE_QUALITY_REVIEWER_FIXTURE_EXECUTOR',
]);

/**
 * Filter an environment down to an explicit allowlist for subprocesses.
 *
 * SECURITY: deny-by-default. The host shell routinely carries credentials
 * (API keys, proxy URLs, cloud tokens) that must not reach candidate code.
 * Keys are matched uppercased because Windows env vars are case-insensitive.
 * Extend the allowlist only for variables a tool demonstrably needs - an
 * over-broad allowlist is a credential leak, not a convenience.
 * @param {object} [source]
 * @returns {object} Fresh env object containing only allowlisted entries.
 */
export function createSubprocessEnv(source = process.env) {
  const result = {};
  for (const [key, value] of Object.entries(source || {})) {
    if (typeof value === 'string' && SUBPROCESS_ENV_ALLOWLIST.has(key.toUpperCase())) result[key] = value;
  }
  return result;
}

/**
 * Build a candidate environment with a private, disposable HOME/TMP.
 *
 * SECURITY: untrusted code must not see - or be able to poison - the host
 * user's config, caches, or credentials (CODEX_HOME, XDG_*, APPDATA are
 * deleted, not passed through). Everything writable defaults into
 * `isolatedHome`, which `createCandidateRuntime` removes on exit.
 * @param {object} [source]
 * @param {string} isolatedHome - Pre-created empty directory.
 * @returns {object} Env object.
 * @throws {Error} When `isolatedHome` is missing.
 */
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

/**
 * Read an outer-sandbox attestation from the environment.
 *
 * The attestation asserts: "this process already runs inside an enforced
 * sandbox; here are canary paths proving it". It is an untrusted claim until
 * useVerifiedOuterSandbox re-probes the canaries at spawn time.
 * @param {object} [source]
 * @returns {{ attested: true, readCanary: string, writeCanary: string } | null}
 *   Frozen attestation, or null when unattested or canary paths are absent.
 */
export function outerSandboxAttestationFromEnv(source = process.env) {
  if (source?.RELEASE_QUALITY_OUTER_SANDBOX_ATTESTED !== '1') return null;
  const readCanary = source.RELEASE_QUALITY_OUTER_SANDBOX_READ_CANARY;
  const writeCanary = source.RELEASE_QUALITY_OUTER_SANDBOX_WRITE_CANARY;
  if (!path.isAbsolute(readCanary || '') || !path.isAbsolute(writeCanary || '')) return null;
  return Object.freeze({ attested: true, readCanary, writeCanary });
}

/**
 * Run a command bare, trusting only a *verified* outer sandbox.
 *
 * SECURITY: the attestation canaries must exist (read path readable, write
 * path absent), live outside every declared sandbox root (so candidate code
 * cannot forge or delete them), and the live probe must re-confirm denial in
 * a fresh child process. The probe exists because the attestation alone is
 * just an env var: if the outer sandbox was disabled after launch, the write
 * canary becomes writable and this function fails closed. Exact write
 * isolation (reviewers) is never satisfied by attestation - reviewer packets
 * must be shielded from each other by a real profile.
 * @param {string} command
 * @param {string[]} args
 * @param {object} sandbox - allowedRoots/readOnlyRoots/writeRoots,
 *   outerSandboxAttestation, requireExactWriteIsolation.
 * @returns {{ command: string, args: string[] }} Unwrapped command (already
 *   inside the verified outer boundary).
 * @throws {Error} Fail-closed on any canary or probe inconsistency.
 */
function useVerifiedOuterSandbox(command, args, {
  allowedRoots, readOnlyRoots, writeRoots, outerSandboxAttestation, requireExactWriteIsolation,
}) {
  const readCanary = outerSandboxAttestation?.readCanary;
  const writeCanary = outerSandboxAttestation?.writeCanary;
  const declaredRoots = [...allowedRoots, ...readOnlyRoots, ...writeRoots].map(root => path.resolve(root));
  const canariesAreValid = outerSandboxAttestation?.attested === true &&
    path.isAbsolute(readCanary || '') && path.isAbsolute(writeCanary || '') && existsSync(readCanary) &&
    !existsSync(writeCanary) &&
    declaredRoots.every(root => !isPathWithin(root, readCanary) && !isPathWithin(root, writeCanary));
  if (!canariesAreValid) throw gateError('Sandbox', 'nested candidate execution',
    'outer sandbox attestation canaries are missing or invalid',
    'run the candidate from a sandboxed host (macOS or an attested container)');
  if (requireExactWriteIsolation) {
    throw gateError('Sandbox', 'reviewer execution',
      'exact write isolation is unavailable on this host',
      'run reviewers under macOS sandbox-exec or provide outer-sandbox attestation');
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
    throw gateError('Sandbox', 'capability check',
      'outer sandbox failed the read/write canary probe',
      'verify the attestation environment before running the gate');
  }
  return { command, args };
}

/**
 * Wrap a candidate/reviewer command for filesystem-isolated execution.
 *
 * Platform decision tree, all failing closed:
 * - macOS: run under /usr/bin/sandbox-exec with a generated profile; a
 *   probe first confirms seatbelt is actually enforceable.
 * - Linux inside a container (/.dockerenv) WITH verified attestation:
 *   run bare, the container is the boundary (see useVerifiedOuterSandbox).
 * - Everything else, including Windows: throw. There is deliberately no
 *   unsandboxed mode - an env var cannot substitute for an enforced
 *   filesystem boundary.
 *
 * SECURITY: read roots are intentionally broad (the toolchain and system
 * libraries must be readable); writes are the hard boundary and are confined
 * to writeRoots plus /dev. `hostHome` is rejected as a sandbox root: a
 * writable HOME would let candidate code rewrite host credentials.
 * @param {string} command - Executable to wrap.
 * @param {string[]} args - Arguments passed through unchanged.
 * @param {object} [options] - allowedRoots, readOnlyRoots, writeRoots,
 *   hostHome, allowNetwork, outerSandboxAttestation, requireExactWriteIsolation.
 * @returns {{ command: string, args: string[] }} Wrapped invocation.
 * @throws {Error} When no enforced boundary is available or roots are unsafe.
 */
export function wrapCandidateCommand(command, args, {
  allowedRoots = [], readOnlyRoots = [], writeRoots = [], hostHome = null, allowNetwork = false,
  outerSandboxAttestation = null, requireExactWriteIsolation = false,
} = {}) {
  if (process.platform !== 'darwin') {
    const isDockerContainer = process.platform === 'linux' && existsSync('/.dockerenv');
    if (!isDockerContainer || !outerSandboxAttestation) {
      throw gateError('Sandbox', 'candidate initialization',
        `candidate filesystem sandbox is unavailable on ${process.platform}`,
        'run on macOS, or inside an attested Linux container');
    }
    return useVerifiedOuterSandbox(command, args, {
      allowedRoots, readOnlyRoots, writeRoots, outerSandboxAttestation, requireExactWriteIsolation,
    });
  }
  const probe = spawnSync('/usr/bin/sandbox-exec', [
    '-p', '(version 1) (allow default)', '/usr/bin/true',
  ], { encoding: 'utf8' });
  if (probe.status !== 0 && /sandbox_apply:\s*Operation not permitted/i.test(`${probe.stdout || ''}${probe.stderr || ''}`)) {
    return useVerifiedOuterSandbox(command, args, {
      allowedRoots, readOnlyRoots, writeRoots, outerSandboxAttestation, requireExactWriteIsolation,
    });
  }
  if (probe.status !== 0) throw gateError('Sandbox', 'probe',
      'sandbox-exec probe failed unexpectedly', 'verify that macOS seatbelt is available');
  hostHome ||= userInfo().homedir;
  const writable = [...allowedRoots, ...writeRoots];
  if (readOnlyRoots.length === 0 && writable.length === 0) {
    throw gateError('Sandbox', 'configuration', 'candidate sandbox roots are required',
      'pass at least one read-only or writable root');
  }
  const canonicalize = root => existsSync(root) ? realpathSync(path.resolve(root)) : path.resolve(root);
  const readable = [...new Set([...readOnlyRoots, ...writable].map(canonicalize))];
  const roots = [...new Set(writable.map(canonicalize))];
  const runtimeRoot = path.dirname(path.dirname(realpathSync(process.execPath)));
  const readRoots = [
    '/', '/usr', '/System', '/Library', '/bin', '/sbin', '/opt/homebrew', '/private/etc',
    '/private/var/db', '/private/var/run', '/private/var/select', '/dev', runtimeRoot, ...readable,
  ];
  const profile = buildCandidateSandboxProfile({
    readRoots, writeRoots: [...roots, '/dev'], allowNetwork,
  });
  if (readable.some(root => root === realpathSync(hostHome))) {
    throw gateError('Sandbox', 'configuration', 'host home cannot be a candidate sandbox root',
      'isolate the candidate home via createCandidateSubprocessEnv');
  }
  return { command: '/usr/bin/sandbox-exec', args: ['-p', profile, command, ...args] };
}

/**
 * Create `directory` under `root`, refusing symlinked path components.
 *
 * SECURITY: every pre-existing component is lstat-ed - a symlink planted at
 * any depth would redirect the whole subtree outside the report root. The
 * final realpath is re-checked against the *resolved* root so a racing
 * rename between the lstat loop and realpath still fails closed.
 * @param {string} root
 * @param {string} directory
 * @param {number} [mode] - Optional chmod applied to the final directory.
 * @returns {string} Realpath of the created directory.
 * @throws {Error} On escapes, symlink components, or non-directory paths.
 */
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
      mkdirSync(current, { mode: FILE_PERMISSIONS.REPORT_DIR });
      chmodSync(current, FILE_PERMISSIONS.REPORT_DIR);
    }
  }
  const targetReal = realpathSync(target);
  if (!isPathWithin(rootReal, targetReal)) throw new Error(`directory resolves outside repository: ${directory}`);
  if (mode !== null) chmodSync(targetReal, mode);
  return targetReal;
}

/**
 * Read a file confined to `root`, rejecting symlinks.
 *
 * SECURITY: checks run twice - on the given path and on its realpath - so a
 * symlink swapped in after the first check (TOCTOU) still cannot redirect
 * the read outside the report root.
 * @param {string} root
 * @param {string} file
 * @param {string} [encoding]
 * @returns {string|Buffer} File contents.
 * @throws {Error} When the file escapes the root or is not a regular file.
 */
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

/**
 * Atomically write a file inside the report root: temp file + fsync + rename.
 *
 * SECURITY: the wx flag fails if an attacker pre-planted the temp name
 * (unpredictable pid+UUID suffix), the rename happens only after the parent
 * directory's dev/ino identity is re-verified (a swapped parent would move
 * the write target outside the root), and pre-existing symlinks at the
 * destination are rejected rather than followed.
 * @param {string} root
 * @param {string} file
 * @param {string|Buffer} content
 * @throws {Error} On escapes, symlink destinations, or parent races.
 */
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
    descriptor = openSync(temporary, 'wx', FILE_PERMISSIONS.REPORT_FILE);
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
    const handle = await open(temporary, 'wx', FILE_PERMISSIONS.REPORT_FILE);
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

/**
 * Detect credential-shaped content (token formats, key:value pairs, PEM).
 *
 * SECURITY: detect and redact below are a matched pair - every pattern here
 * must have a redaction counterpart, and the gate refuses evidence that
 * still matches this detector AFTER redaction. The JWT-shaped pattern is
 * deliberately broad (three dot-separated base64 runs); run it only on
 * gate-owned evidence, never on arbitrary user text, to keep false positives
 * tolerable.
 * @param {string|Buffer} value
 * @returns {boolean}
 */
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

/**
 * Replace credential-shaped content with labeled [REDACTED *] markers.
 *
 * Order matters: PEM blocks (multi-line) are stripped before the generic
 * key:value rules so the header line does not defeat the block match.
 * Output is what gets persisted into round evidence, which is why the
 * containsSensitiveText post-check must pass on it.
 * @param {string|Buffer} value
 * @returns {string}
 */
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
