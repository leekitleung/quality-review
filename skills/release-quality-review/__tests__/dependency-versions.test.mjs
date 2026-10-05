/**
 * Dependency Version Verification Tests
 *
 * Run with: npm test
 *
 * Tests import production code from scripts/verify-dependencies.mjs with an
 * injected runner, so no test spawns a real subprocess.
 *
 * Coverage:
 * - parseVersionOutput extraction (including unparseable and empty output)
 * - compareVersions ordering, equality, and short component lists
 * - checkDependency for required and optional tools across all outcomes
 * - verifyDependencies aggregate mapping over the frozen dependency list
 */

import test from 'node:test';
import {
  checkDependency, compareVersions, OPTIONAL_DEPENDENCIES, parseVersionOutput,
  REQUIRED_DEPENDENCIES, verifyDependencies,
} from '../../../scripts/verify-dependencies.mjs';

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${expected}, got ${actual}`);
  }
}

function assertTrue(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

test('parseVersionOutput extracts the first triple from tool output', () => {
  assertEqual(parseVersionOutput('git version 2.47.1.windows.1'), '2.47.1', 'git-style output');
  assertEqual(parseVersionOutput('v22.19.0\n'), '22.19.0', 'node-style output');
  assertEqual(parseVersionOutput('codex-cli 0.42.0 (preview)'), '0.42.0', 'cli-style output');
});

test('parseVersionOutput returns null for unparseable or empty output', () => {
  assertEqual(parseVersionOutput('no version here'), null, 'unparseable output');
  assertEqual(parseVersionOutput(''), null, 'empty output');
  assertEqual(parseVersionOutput(undefined), null, 'undefined output');
});

test('compareVersions orders semver triples', () => {
  assertEqual(compareVersions('22.19.0', '22.19.0'), 0, 'equal versions');
  assertEqual(compareVersions('22.19.0', '22.18.9'), 1, 'newer patch');
  assertEqual(compareVersions('21.9.9', '22.0.0'), -1, 'older major');
  assertEqual(compareVersions('2.30', '2.30.0'), 0, 'missing components count as zero');
  assertEqual(compareVersions('2.31', '2.30.5'), 1, 'missing components compare numerically');
});

function fakeRunner(outputs) {
  return (command, versionArgs) => {
    const key = `${command} ${versionArgs.join(' ')}`;
    if (!(key in outputs)) throw new Error(`spawn ${command} ENOENT`);
    const value = outputs[key];
    if (value instanceof Error) throw value;
    return value;
  };
}

test('checkDependency reports compatible required tools', () => {
  const result = checkDependency(
    { command: 'git', minimum: '2.30.0', versionArgs: ['--version'] },
    fakeRunner({ 'git --version': 'git version 2.47.1.windows.1' }),
  );
  assertTrue(result.found, 'tool must be found');
  assertEqual(result.version, '2.47.1', 'parsed version');
  assertEqual(result.compatible, true, 'newer than minimum');
});

test('checkDependency reports incompatible required tools with the floor', () => {
  const result = checkDependency(
    { command: 'git', minimum: '2.30.0', versionArgs: ['--version'] },
    fakeRunner({ 'git --version': 'git version 2.24.0' }),
  );
  assertEqual(result.compatible, false, 'older than minimum');
  assertEqual(result.minimum, '2.30.0', 'floor is preserved');
});

test('checkDependency treats missing required tools as incompatible', () => {
  const result = checkDependency(
    { command: 'git', minimum: '2.30.0', versionArgs: ['--version'] },
    () => { throw new Error('spawn git ENOENT'); },
  );
  assertEqual(result.found, false, 'tool missing');
  assertEqual(result.compatible, false, 'required tools must fail when missing');
  assertTrue(result.error.includes('ENOENT'), 'spawn error is preserved');
});

test('checkDependency treats unparseable required output as incompatible', () => {
  const result = checkDependency(
    { command: 'git', minimum: '2.30.0', versionArgs: ['--version'] },
    fakeRunner({ 'git --version': 'broken' }),
  );
  assertEqual(result.compatible, false, 'unparseable required output fails');
  assertTrue(result.error.includes('unparseable'), 'unparseable diagnostic is set');
});

test('checkDependency keeps optional tools compatible when missing or unparseable', () => {
  const missing = checkDependency(
    { command: 'codex', minimum: null, versionArgs: ['--version'] },
    () => { throw new Error('spawn codex ENOENT'); },
  );
  assertEqual(missing.compatible, true, 'missing optional tool stays compatible');
  const unparseable = checkDependency(
    { command: 'claude', minimum: null, versionArgs: ['--version'] },
    fakeRunner({ 'claude --version': 'broken' }),
  );
  assertEqual(unparseable.compatible, true, 'unparseable optional tool stays compatible');
  const present = checkDependency(
    { command: 'claude', minimum: null, versionArgs: ['--version'] },
    fakeRunner({ 'claude --version': 'claude 0.10.2' }),
  );
  assertEqual(present.compatible, true, 'present optional tool is compatible');
  assertEqual(present.version, '0.10.2', 'optional version is parsed');
});

test('verifyDependencies maps the frozen dependency list through checkDependency', () => {
  const results = verifyDependencies(fakeRunner({
    'node -v': 'v22.19.0',
    'git --version': 'git version 2.47.1',
    'codex --version': 'codex-cli 1.2.3',
  }));
  assertEqual(results.length, REQUIRED_DEPENDENCIES.length + OPTIONAL_DEPENDENCIES.length, 'all tools checked');
  assertTrue(results[0].compatible && results[1].compatible, 'required tools compatible');
  assertTrue(results[2].found, 'codex found');
  assertTrue(!results[3].found && results[3].compatible, 'missing claude stays compatible');
});
