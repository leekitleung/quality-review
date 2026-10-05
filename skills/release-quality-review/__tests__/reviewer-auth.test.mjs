import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { prepareCodexHome, prepareZcodeHome, reviewerAuthRoots } from '../scripts/modules/reviewer-auth.mjs';
import { resolveReviewerRuntimePolicy } from '../scripts/modules/reviewer-runtime-policy.mjs';

test('Codex reviewer auth adapter copies file credentials by default', () => {
  const root = mkdtempSync(join(tmpdir(), 'reviewer-auth-'));
  try {
    const source = join(root, 'source');
    const sandbox = join(root, 'sandbox');
    mkdirSync(source);
    mkdirSync(sandbox);
    writeFileSync(join(source, 'auth.json'), '{"fixture":true}');

    const home = prepareCodexHome({ CODEX_HOME: source }, sandbox);
    assert.equal(readFileSync(join(home, 'auth.json'), 'utf8'), '{"fixture":true}');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Codex reviewer auth adapter requires an explicit no-auth mode for fixtures', () => {
  const root = mkdtempSync(join(tmpdir(), 'reviewer-auth-none-'));
  try {
    const home = prepareCodexHome({}, root, 'none');
    assert.equal(existsSync(join(home, 'auth.json')), false);
    assert.equal(resolveReviewerRuntimePolicy('codex', {
      RELEASE_QUALITY_CODEX_AUTH_MODE: 'none', RELEASE_QUALITY_REVIEWER_FIXTURE_EXECUTOR: '1',
    }).requireExactWriteIsolation, false);
    assert.equal(resolveReviewerRuntimePolicy('codex', {
      RELEASE_QUALITY_CODEX_AUTH_MODE: 'none',
    }).requireExactWriteIsolation, true);
    assert.throws(
      () => resolveReviewerRuntimePolicy('codex', { RELEASE_QUALITY_CODEX_AUTH_MODE: 'implicit' }),
      /Unsupported Codex reviewer auth mode/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('ZCode reviewer auth adapter copies v2 credentials into the sandbox home', () => {
  const root = mkdtempSync(join(tmpdir(), 'reviewer-auth-zcode-'));
  try {
    const source = join(root, 'host-zcode');
    const sandbox = join(root, 'sandbox');
    mkdirSync(join(source, 'v2'), { recursive: true });
    mkdirSync(sandbox);
    writeFileSync(join(source, 'v2', 'credentials.json'), '{"oauth:zai":"fixture"}');

    const home = prepareZcodeHome({ ZCODE_CONFIG_DIR: source }, sandbox);
    assert.equal(readFileSync(join(home, 'v2', 'credentials.json'), 'utf8'), '{"oauth:zai":"fixture"}');
    assert.deepEqual(reviewerAuthRoots('zcode', { ZCODE_CONFIG_DIR: source }), [source]);
    assert.equal(reviewerAuthRoots('zcode', { HOME: join(root, 'absent') }).length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('ZCode reviewer auth adapter fails closed without credentials', () => {
  const root = mkdtempSync(join(tmpdir(), 'reviewer-auth-zcode-missing-'));
  try {
    const sandbox = join(root, 'sandbox');
    mkdirSync(sandbox);
    assert.throws(() => prepareZcodeHome({}, sandbox), /ZCode credentials are unavailable/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
