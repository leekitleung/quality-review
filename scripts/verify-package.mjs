#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const projectRoot = process.cwd();
const workDir = mkdtempSync(join(tmpdir(), 'quality-review-package-'));
const npmCli = process.env.npm_execpath || join(
  process.platform === 'win32' ? process.env.ProgramW6432 || process.env.ProgramFiles || 'C:\\Program Files' : '/usr',
  process.platform === 'win32' ? 'nodejs' : 'local',
  'node_modules', 'npm', 'bin', 'npm-cli.js',
);
const npmCommand = process.platform === 'win32' ? process.execPath : 'npm';
const npmArgs = args => process.platform === 'win32' ? [npmCli, ...args] : args;
try {
  const packOutput = execFileSync(npmCommand, npmArgs(['pack', '--json', '--pack-destination', workDir]), {
    cwd: projectRoot, encoding: 'utf8', timeout: 60000,
  });
  const pack = JSON.parse(packOutput)[0];
  if (!pack?.filename || !Number.isInteger(pack.entryCount) || pack.entryCount < 1) {
    throw new Error('npm pack did not return a valid artifact manifest');
  }
  const forbidden = (pack.files || []).map(file => file.path).filter(path =>
    /(^|\/)(?:quality-reports|node_modules|\.git)(?:\/|$)|(^|\/)\.env(?:\.|$)/.test(path)
  );
  if (forbidden.length > 0) throw new Error(`artifact contains forbidden paths: ${forbidden.join(', ')}`);
  const tarball = join(workDir, pack.filename);
  const consumer = join(workDir, 'consumer');
  execFileSync(npmCommand, npmArgs(['install', '--ignore-scripts', '--no-audit', '--no-fund', '--prefix', consumer, tarball]), {
    cwd: projectRoot, encoding: 'utf8', timeout: 60000,
  });
  const installedRoot = join(consumer, 'node_modules', 'quality-review-skills');
  const installedManifest = JSON.parse(readFileSync(join(installedRoot, 'package.json'), 'utf8'));
  if (installedManifest.version !== pack.version ||
      !existsSync(join(installedRoot, 'skills', 'release-quality-review', 'SKILL.md'))) {
    throw new Error('installed artifact is missing canonical release-quality-review files');
  }
  console.log(`package artifact verified: ${pack.filename} (${pack.entryCount} files)`);
} finally {
  rmSync(workDir, { recursive: true, force: true });
}
