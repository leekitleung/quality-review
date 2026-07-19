#!/usr/bin/env node
import {
  appendFileSync, chmodSync, existsSync, lstatSync, readdirSync, realpathSync, rmSync, statSync,
} from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
let days = 30;
let json = false;
let invalid = false;
let shouldDelete = false;
let confirmation = null;
for (let index = 0; index < args.length; index++) {
  if (args[index] === '--json') json = true;
  else if (args[index] === '--delete') shouldDelete = true;
  else if (args[index] === '--confirm' && args[index + 1]) confirmation = args[++index];
  else if (args[index] === '--days' && args[index + 1]) days = Number(args[++index]);
  else invalid = true;
}
if (invalid || (!shouldDelete && confirmation !== null) || !Number.isFinite(days) || days < 1 ||
    (shouldDelete && confirmation !== 'DELETE-EXPIRED-ROUNDS')) {
  console.error('Usage: npm run reports:retention-check -- [--days N] [--json] [--delete --confirm DELETE-EXPIRED-ROUNDS]');
  process.exit(4);
}

const reportRoot = join(process.cwd(), 'quality-reports');
const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
const expired = existsSync(reportRoot)
  ? readdirSync(reportRoot, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && /^round-\d+$/.test(entry.name))
    .map(entry => ({
      name: entry.name,
      path: join(reportRoot, entry.name),
      modified_at: statSync(join(reportRoot, entry.name)).mtime.toISOString(),
    }))
    .filter(entry => Date.parse(entry.modified_at) < cutoff)
  : [];

if (shouldDelete && expired.length > 0) {
  const rootReal = realpathSync(reportRoot);
  for (const entry of expired) {
    const info = lstatSync(entry.path);
    const entryReal = realpathSync(entry.path);
    if (!info.isDirectory() || info.isSymbolicLink() || !entryReal.startsWith(`${rootReal}/round-`)) {
      throw new Error(`refusing unsafe retention target: ${entry.name}`);
    }
    rmSync(entryReal, { recursive: true });
  }
  chmodSync(reportRoot, 0o700);
  appendFileSync(join(reportRoot, 'retention-audit.jsonl'), `${JSON.stringify({
    deleted_at: new Date().toISOString(), retention_days: days,
    deleted_rounds: expired.map(entry => entry.name),
  })}\n`, { mode: 0o600 });
  console.log(`DELETED ${expired.length} expired report round(s); audit appended to quality-reports/retention-audit.jsonl`);
  process.exit(0);
}
const publicExpired = expired.map(({ path: _path, ...entry }) => entry);
if (json) console.log(JSON.stringify({ retention_days: days, expired: publicExpired }, null, 2));
else if (expired.length === 0) console.log(`PASS no report rounds exceed ${days} days`);
else {
  console.log(`FAIL ${expired.length} report round(s) exceed ${days} days:`);
  for (const entry of publicExpired) console.log(`  ${entry.name} ${entry.modified_at}`);
  console.log('Review the listed rounds, then remove them through your approved retention workflow.');
}
process.exit(expired.length === 0 ? 0 : 1);
