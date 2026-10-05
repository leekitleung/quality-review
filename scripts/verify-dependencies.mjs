#!/usr/bin/env node
// Dependency version verification for the quality-review toolchain.
//
// Version floors follow package.json `engines` (node >= 22) and the oldest
// git release with the flags the evidence pipeline relies on (`--no-local`,
// `--no-hardlinks`, `HEAD^{tree}`; git 2.30, 2020). Codex/Claude CLIs are
// reported but carry no floor: the runner fails closed on unauthenticated or
// missing CLIs at launch, so inventing floors here would only create false
// failures in environments that intentionally pin older previews.

import { execFileSync } from 'node:child_process';
import { TIMEOUTS } from '../skills/release-quality-review/lib/config-constants.mjs';

export const REQUIRED_DEPENDENCIES = Object.freeze([
  Object.freeze({ command: 'node', minimum: '22.0.0', versionArgs: ['-v'] }),
  Object.freeze({ command: 'git', minimum: '2.30.0', versionArgs: ['--version'] }),
]);

export const OPTIONAL_DEPENDENCIES = Object.freeze([
  Object.freeze({ command: 'codex', minimum: null, versionArgs: ['--version'] }),
  Object.freeze({ command: 'claude', minimum: null, versionArgs: ['--version'] }),
]);

const defaultRunner = (command, versionArgs) =>
  execFileSync(command, versionArgs, { encoding: 'utf8', timeout: TIMEOUTS.VERSION_CHECK });

export function parseVersionOutput(output) {
  const match = String(output || '').match(/(\d+)\.(\d+)\.(\d+)/);
  return match ? `${match[1]}.${match[2]}.${match[3]}` : null;
}

export function compareVersions(left, right) {
  const a = String(left).split('.').map(Number);
  const b = String(right).split('.').map(Number);
  for (let index = 0; index < 3; index++) {
    if ((a[index] || 0) > (b[index] || 0)) return 1;
    if ((a[index] || 0) < (b[index] || 0)) return -1;
  }
  return 0;
}

export function checkDependency(dependency, runner = defaultRunner) {
  const { command, minimum } = dependency;
  let output;
  try {
    output = runner(command, dependency.versionArgs);
  } catch (error) {
    return { command, minimum, found: false, compatible: minimum === null, error: error.message };
  }
  const version = parseVersionOutput(output);
  if (version === null) {
    return { command, minimum, found: false, compatible: minimum === null, error: `unparseable version output: ${String(output).trim()}` };
  }
  const compatible = minimum === null || compareVersions(version, minimum) >= 0;
  return { command, minimum, found: true, version, compatible };
}

export function verifyDependencies(runner = defaultRunner) {
  return [...REQUIRED_DEPENDENCIES, ...OPTIONAL_DEPENDENCIES].map(
    dependency => checkDependency(dependency, runner),
  );
}
