import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import test from 'node:test';

import { validateReviewModelIdentity } from '../lib/model-selector.mjs';

const __dirname = new URL('.', import.meta.url).pathname;
const PROJECT_ROOT = join(__dirname, '..', '..', '..');
const RUNNER = join(PROJECT_ROOT, 'skills', 'release-quality-review', 'scripts', 'review-runner.mjs');

test('zcode review identity accepts only the GLM model family', () => {
  assertEqualIdentity({ backend: 'zcode', model: 'glm-5.3-flash' }, true);
  assertEqualIdentity({ backend: 'zcode', model: 'GLM-5.3' }, true);
  assertEqualIdentity({ backend: 'zcode', model: 'glm' }, true);
  assertEqualIdentity({ backend: 'zcode', model: 'claude-sonnet-4-5' }, false);
  assertEqualIdentity({ backend: 'zcode', model: 'gpt-5.4' }, false);
  assertEqualIdentity({ backend: 'zcode', model: 'glmware' }, false);
  // GLM stays invalid for the claude backend. codex + non-Claude models was
  // already accepted before zcode existed (family strictness lives in the
  // Radar candidate filter) and is left unchanged here.
  assertEqualIdentity({ backend: 'claude', model: 'glm-5.3-flash' }, false);
  assertEqualIdentity({ backend: 'codex', model: 'glm-5.3-flash' }, true);
});

test('zcode review identity rejects Codex reasoning effort', () => {
  assertEqualIdentity({ backend: 'zcode', model: 'glm-5.3-flash', reasoningEffort: 'high' }, false);
  assertEqualIdentity({ backend: 'zcode', model: 'glm-5.3-flash', reasoningEffort: null }, true);
});

test('zcode backend is rejected from the backend list before model checks', () => {
  const result = validateReviewModelIdentity({ backend: 'cursor', model: 'glm-5.3-flash' });
  assert.equal(result.valid, false);
  assert.equal(result.error, 'invalid review backend');
});

test('review runner dry-run accepts a zcode identity and enforces explicit models', () => {
  const dryRun = spawnSync(process.execPath, [RUNNER, '--profile', 'quick', '--agent', 'zcode',
    '--model', 'glm-5.3-flash', '--dry-run'], { cwd: PROJECT_ROOT, encoding: 'utf8' });
  assert.equal(dryRun.status, 0, `${dryRun.stdout}${dryRun.stderr}`);

  const missingModel = spawnSync(process.execPath, [RUNNER, '--profile', 'quick', '--agent', 'zcode',
    '--dry-run'], { cwd: PROJECT_ROOT, encoding: 'utf8' });
  assert.equal(missingModel.status, 4);
  assert.match(`${missingModel.stderr}`, /zcode reviews require explicit --model/);

  const wrongFamily = spawnSync(process.execPath, [RUNNER, '--profile', 'quick', '--agent', 'zcode',
    '--model', 'claude-sonnet-4-5', '--dry-run'], { cwd: PROJECT_ROOT, encoding: 'utf8' });
  assert.equal(wrongFamily.status, 4);
  assert.match(`${wrongFamily.stderr}`, /not valid for zcode backend/);
});

function assertEqualIdentity(identity, valid) {
  const result = validateReviewModelIdentity(identity);
  assert.equal(result.valid, valid, `${JSON.stringify(identity)}: ${result.error}`);
}
