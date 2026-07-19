#!/usr/bin/env node
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
let days = 30;
let json = false;
let invalid = false;
for (let index = 0; index < args.length; index++) {
  if (args[index] === '--json') json = true;
  else if (args[index] === '--days' && args[index + 1]) days = Number(args[++index]);
  else invalid = true;
}
if (invalid || !Number.isFinite(days) || days < 1) {
  console.error('Usage: npm run reports:retention-check -- [--days N] [--json]');
  process.exit(4);
}

const reportRoot = join(process.cwd(), 'quality-reports');
const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
const expired = existsSync(reportRoot)
  ? readdirSync(reportRoot, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && /^round-\d+$/.test(entry.name))
    .map(entry => ({ name: entry.name, modified_at: statSync(join(reportRoot, entry.name)).mtime.toISOString() }))
    .filter(entry => Date.parse(entry.modified_at) < cutoff)
  : [];

if (json) console.log(JSON.stringify({ retention_days: days, expired }, null, 2));
else if (expired.length === 0) console.log(`PASS no report rounds exceed ${days} days`);
else {
  console.log(`FAIL ${expired.length} report round(s) exceed ${days} days:`);
  for (const entry of expired) console.log(`  ${entry.name} ${entry.modified_at}`);
  console.log('Review the listed rounds, then remove them through your approved retention workflow.');
}
process.exit(expired.length === 0 ? 0 : 1);
