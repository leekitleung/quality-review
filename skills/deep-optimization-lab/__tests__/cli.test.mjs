import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import test from 'node:test';

const PROJECT_ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const RUNNER = join(PROJECT_ROOT, 'skills/deep-optimization-lab/scripts/experiment-runner.mjs');

function createWorkspace(t) {
  const workspace = mkdtempSync(join(tmpdir(), 'deep-optimization-lab-'));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  const logs = join(workspace, 'experiment-logs');
  mkdirSync(logs);
  writeFileSync(join(logs, 'baseline.yaml'), JSON.stringify({ metrics: { testCoverage: 80 } }));
  return workspace;
}

test('experiment runner completes a documented dry run without external YAML dependencies', t => {
  const workspace = createWorkspace(t);
  const result = spawnSync(process.execPath, [
    RUNNER, '--hypothesis', 'improve-cli-help-text', '--profile', 'project-quality', '--dry-run',
  ], { cwd: workspace, encoding: 'utf8' });

  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  assert.match(result.stdout, /DRY RUN MODE/);
});

test('experiment runner rejects a shell-shaped profile without executing it', t => {
  const workspace = createWorkspace(t);
  const marker = join(workspace, 'profile-injection-marker');
  const maliciousProfile = `project-quality;touch ${marker}`;
  const result = spawnSync(process.execPath, [
    RUNNER, '--hypothesis', 'improve-cli-help-text', '--profile', maliciousProfile, '--dry-run',
  ], { cwd: workspace, encoding: 'utf8' });

  assert.equal(result.status, 4, `${result.stdout}${result.stderr}`);
  assert.match(result.stderr, /Invalid --profile/);
  assert.equal(existsSync(marker), false);
});
