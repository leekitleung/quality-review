#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SKILL_ROOT = join(__dirname, '..');

const errors = [];

function checkExitCodeSemantics() {
  const gatePath = join(SKILL_ROOT, 'scripts', 'review-gate.mjs');
  const gateSource = readFileSync(gatePath, 'utf8');

  const exitCodeMap = {
    '0': 'exit(0) - gate passed',
    '1': 'exit(1) - gate failed (expected)',
    '2': 'exit(2) - unexpected error',
  };

  let foundExit0 = false;
  let foundExit1 = false;
  let foundExit2 = false;

  // Check for direct exit codes
  const exitMatches = gateSource.matchAll(/process\.exit\((\d+)\)/g);
  for (const match of exitMatches) {
    const code = match[1];
    if (code === '0') foundExit0 = true;
    if (code === '1') foundExit1 = true;
    if (code === '2') foundExit2 = true;
  }

  // Check for ternary-based exit (e.g., process.exit(passed ? 0 : 1))
  if (gateSource.includes('process.exit(passed ? 0 : 1)') ||
      gateSource.includes('process.exit(failed ? 1 : 0)')) {
    foundExit0 = true;
    foundExit1 = true;
  }

  const catchMatches = gateSource.matchAll(/\.catch\([^)]+\)\s*;?\s*$/gm);
  let hasProperCatch = false;
  for (const _ of catchMatches) {
    hasProperCatch = true;
  }

  if (!foundExit0) {
    errors.push('No exit(0) found - gate should exit 0 on success');
  }
  if (!foundExit1) {
    errors.push('No exit(1) found - gate should exit 1 on failure');
  }
  if (!foundExit2) {
    errors.push('No exit(2) found - gate should exit 2 on unexpected errors');
  }

  if (gateSource.includes('throw') && !gateSource.includes('.catch(')) {
    errors.push('Gate may throw errors without proper catch handling');
  }

  if (gateSource.includes('process.exit(1)') && gateSource.includes('process.exit(2)')) {
    const throwIdx = gateSource.indexOf('throw error');
    const catchIdx = gateSource.indexOf('.catch(');
    if (throwIdx > 0 && catchIdx > 0 && throwIdx < catchIdx) {
      errors.push('Gate throws errors that may propagate to top-level catch, causing exit(2) instead of exit(1)');
    }
  }
}

function report() {
  console.log('=== Exit Code Verification Results ===\n');

  if (errors.length === 0) {
    console.log('PASS: Exit code semantics are correct');
    console.log('  exit(0) = gate passed');
    console.log('  exit(1) = gate failed');
    console.log('  exit(2) = unexpected error');
    process.exit(0);
  }

  console.log('ERRORS:');
  errors.forEach(e => console.log(`  - ${e}`));
  console.log();
  process.exit(1);
}

checkExitCodeSemantics();
report();
