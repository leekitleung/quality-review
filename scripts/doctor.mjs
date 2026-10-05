#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { TIMEOUTS } from '../skills/release-quality-review/lib/config-constants.mjs';

const args = process.argv.slice(2);
const agentIndex = args.indexOf('--agent');
const agent = agentIndex >= 0 ? args[agentIndex + 1] : null;
if ((agentIndex >= 0 && !agent) || args.some((arg, index) => arg.startsWith('-') && index !== agentIndex) ||
    (agent && !['codex', 'claude'].includes(agent))) {
  console.error('Usage: npm run doctor -- [--agent codex|claude]');
  process.exit(4);
}

const checks = [];
const record = (name, passed, detail) => checks.push({ name, passed, detail });
record('Node.js 22+', Number(process.versions.node.split('.')[0]) >= 22, process.version);
const git = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], { encoding: 'utf8' });
record('Git checkout', git.status === 0 && git.stdout.trim() === 'true', git.stderr.trim() || git.stdout.trim());
try {
  accessSync(process.cwd(), constants.R_OK | constants.W_OK);
  record('Workspace access', true, process.cwd());
} catch (error) {
  record('Workspace access', false, error.message);
}

const selected = agent || ['codex', 'claude'].find(command =>
  spawnSync(command, ['--version'], { encoding: 'utf8' }).status === 0
);
if (!selected) {
  record('Agent CLI', false, 'install and authenticate Codex or Claude');
} else {
  const version = spawnSync(selected, ['--version'], { encoding: 'utf8' });
  record(`${selected} CLI`, version.status === 0, version.stdout.trim() || version.stderr.trim());
  const authArgs = selected === 'codex' ? ['login', 'status'] : ['auth', 'status'];
  const auth = spawnSync(selected, authArgs, { encoding: 'utf8', timeout: TIMEOUTS.GIT_OPERATION });
  record(`${selected} authentication`, auth.status === 0, auth.stdout.trim() || auth.stderr.trim());
}

for (const check of checks) {
  console.log(`${check.passed ? 'PASS' : 'FAIL'} ${check.name}: ${check.detail}`);
}
if (checks.every(check => check.passed)) {
  console.log(`Next: npm run review -- --profile quick --round <unused-positive-round> --base HEAD~1 --agent ${selected}`);
  process.exit(0);
}
process.exit(1);
