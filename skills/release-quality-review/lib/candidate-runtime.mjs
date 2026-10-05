import { execFileSync as nodeExecFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import {
  createCandidateSubprocessEnv, ensureContainedDirectorySync, isPathWithin, wrapCandidateCommand,
} from './security-utils.mjs';
import { TIMEOUTS } from './config-constants.mjs';
import { gateError } from './error-messages.mjs';

/**
 * Resolve the Git repository that contains `projectRoot`.
 *
 * The gate may be invoked from a subdirectory of a worktree (a package
 * inside a monorepo); evidence collection and the verify scripts clone the
 * *repository* and then descend into `projectRelative`, so candidate identity
 * always refers to the same tree regardless of the invocation directory.
 * @param {string} projectRoot - Directory the gate was launched from.
 * @param {Function} [gitExecFile] - Injectable for tests.
 * @returns {{ repositoryRoot: string, projectRelative: string }} Frozen.
 * @throws {Error} When the path is not contained by its repository.
 */
export function resolveRepositoryContext(projectRoot, gitExecFile = nodeExecFileSync) {
  // SECURITY: both sides are canonicalized before comparison. Git reports the
  // physical toplevel (macOS resolves /var -> /private/var, plus user-level
  // symlinks), while the caller may sit under a logical path; comparing the
  // raw strings would wrongly reject a legitimate nested project root.
  const projectPath = realpathSync(resolve(projectRoot));
  const repositoryRoot = realpathSync(resolve(gitExecFile('git', ['rev-parse', '--show-toplevel'], {
    cwd: projectPath, encoding: 'utf8', timeout: TIMEOUTS.GIT_OPERATION,
  }).trim()));
  const projectRelative = relative(repositoryRoot, projectPath);
  if (!isPathWithin(repositoryRoot, projectPath) || isAbsolute(projectRelative)) {
    throw gateError('Repository', 'context resolution',
      'project root must be contained by its Git repository',
      'run the gate from inside the repository checkout');
  }
  return Object.freeze({ repositoryRoot, projectRelative });
}

/**
 * Confirm the isolated checkout still matches the reviewed commit/tree and
 * that the source worktree was clean when evidence collection started.
 * @param {{ commit: string, tree: string, status: string }} source
 * @param {{ commit: string, tree: string, status: string }} initial
 * @param {{ commit: string, tree: string, status: string }} final
 * @returns {{ status: 'pass', source_commit: string, source_tree: string, initial: object, final: object }}
 * @throws {Error} On any identity drift or dirty source status.
 */
export function validateCandidateCheckoutIdentity(source, initial, final) {
  if (source.status !== '' || initial.status !== '' || final.status !== '' ||
      initial.commit !== source.commit || initial.tree !== source.tree ||
      final.commit !== source.commit || final.tree !== source.tree) {
    throw new Error('automated verification checkout identity changed or source checkout is dirty');
  }
  return { status: 'pass', source_commit: source.commit, source_tree: source.tree, initial, final };
}

/**
 * Create an isolated execution context for candidate verification.
 *
 * Every command the candidate runs goes through execFileSync here, which
 * wraps it via wrapCandidateCommand (sandbox) and injects the candidate env
 * (private HOME, attestation canaries). `projectRoot` may be a subdirectory;
 * checkouts clone the containing repository and return the nested project
 * path so evidence collection sees the expected working tree.
 * @param {string} projectRoot - Project directory inside its repository.
 * @param {string} label - Used to name the temp dirs (traceability).
 * @param {object|null} [outerSandboxAttestation] - Verified outer boundary.
 * @returns {{ env, isolatedHome, execSync, execFileSync, prepareCheckout,
 *   readIdentity, validateCheckout }}
 */
export function createCandidateRuntime(projectRoot, label, outerSandboxAttestation = null) {
  const { repositoryRoot, projectRelative } = resolveRepositoryContext(projectRoot);
  const isolatedHome = mkdtempSync(join(tmpdir(), `release-quality-review-${label}-home-`));
  const attestationRoot = outerSandboxAttestation ? null :
    mkdtempSync(join(tmpdir(), `release-quality-review-${label}-attestation-`));
  const sandboxAttestation = outerSandboxAttestation || Object.freeze({
    attested: true,
    readCanary: join(attestationRoot, 'read-canary'),
    writeCanary: join(attestationRoot, 'write-canary'),
  });
  if (attestationRoot) writeFileSync(sandboxAttestation.readCanary, 'trusted');
  let checkoutParent = null;
  const env = createCandidateSubprocessEnv(process.env, isolatedHome);
  env.RELEASE_QUALITY_OUTER_SANDBOX_ATTESTED = '1';
  env.RELEASE_QUALITY_OUTER_SANDBOX_READ_CANARY = sandboxAttestation.readCanary;
  env.RELEASE_QUALITY_OUTER_SANDBOX_WRITE_CANARY = sandboxAttestation.writeCanary;

  process.on('exit', () => {
    rmSync(isolatedHome, { recursive: true, force: true });
    if (attestationRoot) rmSync(attestationRoot, { recursive: true, force: true });
    if (checkoutParent) rmSync(checkoutParent, { recursive: true, force: true });
  });

  function execSync(command, options = {}) {
    return execFileSync('/bin/sh', ['-c', command], options);
  }

  function execFileSync(file, args, options = {}) {
    const {
      sandboxReadOnlyRoots = [], sandboxWriteRoots = [isolatedHome], sandboxAllowNetwork = false, ...execOptions
    } = options;
    const wrapped = wrapCandidateCommand(file, args, {
      readOnlyRoots: sandboxReadOnlyRoots, writeRoots: sandboxWriteRoots,
      allowNetwork: sandboxAllowNetwork, outerSandboxAttestation: sandboxAttestation,
    });
    return nodeExecFileSync(wrapped.command, wrapped.args, { ...execOptions, env });
  }

  function readIdentity(root) {
    const options = { cwd: root, encoding: 'utf8', timeout: TIMEOUTS.GIT_OPERATION, sandboxReadOnlyRoots: [root] };
    return {
      commit: execFileSync('git', ['rev-parse', 'HEAD'], options).trim(),
      tree: execFileSync('git', ['rev-parse', 'HEAD^{tree}'], options).trim(),
      status: execFileSync('git', ['status', '--short'], options).trim(),
    };
  }

  function prepareCheckout() {
    checkoutParent ||= mkdtempSync(join(tmpdir(), `release-quality-review-${label}-checkout-`));
    const repositoryCheckout = join(checkoutParent, 'candidate-checkout');
    const projectCheckout = join(repositoryCheckout, projectRelative);
    if (!existsSync(repositoryCheckout)) {
      execFileSync('git', ['clone', '--quiet', '--no-hardlinks', repositoryRoot, repositoryCheckout], {
        cwd: repositoryRoot, encoding: 'utf8', timeout: TIMEOUTS.GIT_CLONE,
        sandboxReadOnlyRoots: [repositoryRoot],
        sandboxWriteRoots: [isolatedHome, checkoutParent],
      });
      ensureContainedDirectorySync(projectCheckout, join(projectCheckout, 'quality-reports'));
    }
    return projectCheckout;
  }

  function validateCheckout(root, initial) {
    const source = readIdentity(projectRoot);
    const final = readIdentity(root);
    return validateCandidateCheckoutIdentity(source, initial, final);
  }

  return { env, isolatedHome, execSync, execFileSync, prepareCheckout, readIdentity, validateCheckout };
}
