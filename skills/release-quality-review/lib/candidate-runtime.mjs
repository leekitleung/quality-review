import { execFileSync as nodeExecFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createCandidateSubprocessEnv, ensureContainedDirectorySync, wrapCandidateCommand,
} from './security-utils.mjs';

export function createCandidateRuntime(projectRoot, label) {
  const isolatedHome = mkdtempSync(join(tmpdir(), `release-quality-review-${label}-home-`));
  let checkoutParent = null;
  const env = createCandidateSubprocessEnv(process.env, isolatedHome);
  const outerWriteCanary = join(projectRoot, `.release-quality-outer-sandbox-write-canary-${process.pid}-${label}`);
  env.RELEASE_QUALITY_OUTER_SANDBOX_ATTESTED = '1';
  env.RELEASE_QUALITY_OUTER_SANDBOX_READ_CANARY = join(projectRoot, 'package.json');
  env.RELEASE_QUALITY_OUTER_SANDBOX_WRITE_CANARY = outerWriteCanary;

  process.on('exit', () => {
    rmSync(outerWriteCanary, { force: true });
    rmSync(isolatedHome, { recursive: true, force: true });
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
      allowNetwork: sandboxAllowNetwork,
    });
    return nodeExecFileSync(wrapped.command, wrapped.args, { ...execOptions, env });
  }

  function readIdentity(root) {
    const options = { cwd: root, encoding: 'utf8', timeout: 10000, sandboxReadOnlyRoots: [root] };
    return {
      commit: execFileSync('git', ['rev-parse', 'HEAD'], options).trim(),
      tree: execFileSync('git', ['rev-parse', 'HEAD^{tree}'], options).trim(),
      status: execFileSync('git', ['status', '--short'], options).trim(),
    };
  }

  function prepareCheckout() {
    checkoutParent ||= mkdtempSync(join(tmpdir(), `release-quality-review-${label}-checkout-`));
    const checkout = join(checkoutParent, 'candidate-checkout');
    if (!existsSync(checkout)) {
      execFileSync('git', ['clone', '--quiet', '--no-hardlinks', projectRoot, checkout], {
        cwd: projectRoot, encoding: 'utf8', timeout: 30000,
        sandboxReadOnlyRoots: [projectRoot],
        sandboxWriteRoots: [isolatedHome, checkoutParent],
      });
      ensureContainedDirectorySync(checkout, join(checkout, 'quality-reports'));
    }
    return checkout;
  }

  function validateCheckout(root, initial) {
    const source = readIdentity(projectRoot);
    const final = readIdentity(root);
    if (source.status !== '' || initial.status !== '' || final.status !== '' ||
        initial.commit !== source.commit || initial.tree !== source.tree ||
        final.commit !== source.commit || final.tree !== source.tree) {
      throw new Error('automated verification checkout identity changed or source checkout is dirty');
    }
    return { status: 'pass', source_commit: source.commit, source_tree: source.tree, initial, final };
  }

  return { env, isolatedHome, execSync, execFileSync, prepareCheckout, readIdentity, validateCheckout };
}
