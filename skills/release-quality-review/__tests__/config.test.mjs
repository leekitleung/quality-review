import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { loadConfig } from '../scripts/modules/config.mjs';
import { resolveVerificationCommands } from '../scripts/modules/verification-policy.mjs';

function withConfig(content, callback) {
  const root = mkdtempSync(join(tmpdir(), 'review-config-'));
  try {
    const file = join(root, 'review-config.yaml');
    writeFileSync(file, content);
    callback(file);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('shared config parser rejects unknown verification keys', () => {
  withConfig('verification:\n  test: "npm test"\n  typcheck: "npm run typecheck"\n', file => {
    assert.throws(() => loadConfig(file), /unknown verification config key: typcheck/);
  });
  assert.throws(
    () => resolveVerificationCommands({ verification: { typcheck: 'npm run typecheck' } }),
    /unknown verification config keys: typcheck/,
  );
});

test('shared config parser ignores unrelated nested sections and loads execution policy', () => {
  withConfig([
    'project:', '  name: fixture', 'verification:', '  test: "npm test"',
    'execution:', '  retry_max: 2', 'gate:', '  min_score: 90', '',
  ].join('\n'), file => {
    const config = loadConfig(file);
    assert.equal(config.verification.test, 'npm test');
    assert.equal(config.execution.retry_max, '2');
    assert.equal(config.gate.min_score, '90');
    assert.equal(config.name, undefined);
  });
});
