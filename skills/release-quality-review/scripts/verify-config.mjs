#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SKILL_ROOT = join(__dirname, '..');
const CONFIG_PATH = join(SKILL_ROOT, 'review-config.yaml');
const PROJECT_ROOT = join(__dirname, '..', '..', '..');

const errors = [];
const warnings = [];

function checkConfigConsistency() {
  const config = readFileSync(CONFIG_PATH, 'utf8');
  const pkg = JSON.parse(readFileSync(join(PROJECT_ROOT, 'package.json'), 'utf8'));

  const expectedPm = pkg.packageManager?.startsWith('pnpm') ? 'pnpm' :
                     pkg.packageManager?.startsWith('npm') ? 'npm' : null;

  if (!expectedPm) {
    warnings.push('Cannot determine expected package manager from packageManager field');
    return;
  }

  const verificationSection = config.match(/^verification:([\s\S]*?)(?=^\w|\n\n|$)/m);
  if (!verificationSection) {
    errors.push('Could not find verification section in config');
    return;
  }

  const verificationText = verificationSection[0];
  const npmCommands = verificationText.match(/npm(?:\s|$)/g) || [];
  const pnpmCommands = verificationText.match(/pnpm(?:\s|$)/g) || [];

  if (npmCommands.length > 0 && expectedPm === 'pnpm') {
    errors.push(`Config uses 'npm' commands but project uses pnpm. Found ${npmCommands.length} npm commands.`);
  }

  if (pnpmCommands.length > 0 && expectedPm === 'npm') {
    errors.push(`Config uses 'pnpm' commands but project uses npm. Found ${pnpmCommands.length} pnpm commands.`);
  }

  const requiredGates = ['test', 'build', 'lint', 'typecheck', 'audit'];
  for (const gate of requiredGates) {
    const gateMatch = verificationText.match(new RegExp(`^\\s*${gate}:\\s*["'](.+?)["']`, 'm'));
    if (!gateMatch) {
      warnings.push(`Missing '${gate}' gate command in config`);
    }
  }
}

function report() {
  console.log('=== Config Verification Results ===\n');

  if (errors.length === 0 && warnings.length === 0) {
    console.log('PASS: Config is consistent');
    process.exit(0);
  }

  if (errors.length > 0) {
    console.log('ERRORS:');
    errors.forEach(e => console.log(`  - ${e}`));
    console.log();
  }

  if (warnings.length > 0) {
    console.log('WARNINGS:');
    warnings.forEach(w => console.log(`  - ${w}`));
    console.log();
  }

  process.exit(errors.length > 0 ? 1 : 0);
}

checkConfigConsistency();
report();
