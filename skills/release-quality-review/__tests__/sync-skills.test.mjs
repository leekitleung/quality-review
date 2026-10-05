import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const __dirname = new URL('.', import.meta.url).pathname;
const PROJECT_ROOT = join(__dirname, '..', '..', '..');

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

// The lock hash must be host-independent: a Windows checkout (autocrlf CRLF,
// backslash separators) and a POSIX checkout must agree on drift, or CI on
// one platform fails against a lock generated on another. These tests spawn
// the script against a copied fixture because sync-skills.mjs runs main() on
// import and is only reachable as a CLI.

function makeFixtureRoot(t) {
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'sync-skills-fixture-'));
  t.after(() => rmSync(fixtureRoot, { recursive: true, force: true }));
  const registry = JSON.parse(readFileSync(join(PROJECT_ROOT, 'skill-registry.yaml'), 'utf8'));
  const config = registry.skills['release-quality-review'];
  cpSync(join(PROJECT_ROOT, 'skill-registry.yaml'), join(fixtureRoot, 'skill-registry.yaml'));
  // Keep the repo layout (scripts/ sibling to skills/) because the script
  // imports ../skills/release-quality-review/lib/security-utils.mjs.
  cpSync(join(PROJECT_ROOT, 'scripts', 'sync-skills.mjs'), join(fixtureRoot, 'scripts', 'sync-skills.mjs'));
  cpSync(join(PROJECT_ROOT, config.canonical), join(fixtureRoot, config.canonical), { recursive: true });
  return { fixtureRoot, config };
}

function runSync(root, mode) {
  return spawnSync(process.execPath, [join(root, 'scripts', 'sync-skills.mjs'), mode], {
    cwd: root, encoding: 'utf8',
  });
}

function contaminateWithCrlf(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) contaminateWithCrlf(full);
    else writeFileSync(full, readFileSync(full, 'utf8').replace(/\r\n?/g, '\n').replace(/\n/g, '\r\n'));
  }
}

test('sync-skills drift check tolerates checkout line-ending differences', t => {
  const { fixtureRoot } = makeFixtureRoot(t);

  const synced = runSync(fixtureRoot, 'sync');
  assertEqual(synced.status, 0, `${synced.stdout}${synced.stderr}`);
  assertEqual(runSync(fixtureRoot, 'check').status, 0);

  // A CRLF checkout (Windows autocrlf) of identical content must not drift.
  contaminateWithCrlf(join(fixtureRoot, 'skills', 'release-quality-review'));
  const afterCrlf = runSync(fixtureRoot, 'check');
  assertEqual(afterCrlf.status, 0,
    `CRLF checkout must not report drift: ${afterCrlf.stdout}${afterCrlf.stderr}`);
});

test('sync-skills drift check still detects real canonical changes', t => {
  const { fixtureRoot, config } = makeFixtureRoot(t);

  const synced = runSync(fixtureRoot, 'sync');
  assertEqual(synced.status, 0, `${synced.stdout}${synced.stderr}`);

  const skillPath = join(fixtureRoot, config.canonical, 'SKILL.md');
  writeFileSync(skillPath, `${readFileSync(skillPath, 'utf8')}\ntampered: true\n`);
  const drifted = runSync(fixtureRoot, 'check');
  assertEqual(drifted.status, 1, 'canonical content change must fail the drift check');
  assertTrue(drifted.stderr.includes('Skill drift detected'));
});
