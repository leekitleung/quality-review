#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { accessSync, constants, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { TIMEOUTS } from '../skills/release-quality-review/lib/config-constants.mjs';
import { checkDependency, REQUIRED_DEPENDENCIES } from './verify-dependencies.mjs';

const AGENTS = ['codex', 'claude', 'zcode'];
const ZCODE_APP_BUNDLE = '/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs';

const args = process.argv.slice(2);
const agentIndex = args.indexOf('--agent');
const agent = agentIndex >= 0 ? args[agentIndex + 1] : null;
if ((agentIndex >= 0 && !agent) || args.some((arg, index) => arg.startsWith('-') && index !== agentIndex) ||
    (agent && !AGENTS.includes(agent))) {
  console.error(`Usage: npm run doctor -- [--agent ${AGENTS.join('|')}]`);
  process.exit(4);
}

const checks = [];
const record = (name, passed, detail) => checks.push({ name, passed, detail });
for (const dependency of REQUIRED_DEPENDENCIES) {
  const result = checkDependency(dependency);
  record(`${dependency.command} >= ${dependency.minimum}`, result.compatible,
    result.version || result.error || 'not found');
}
const git = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], { encoding: 'utf8' });
record('Git checkout', git.status === 0 && git.stdout.trim() === 'true', git.stderr.trim() || git.stdout.trim());
try {
  accessSync(process.cwd(), constants.R_OK | constants.W_OK);
  record('Workspace access', true, process.cwd());
} catch (error) {
  record('Workspace access', false, error.message);
}

// zcode may not be on PATH; the desktop app ships the CLI inside its bundle,
// so fall back to running it through node before declaring it missing.
function zcodeCommand() {
  if (spawnSync('zcode', ['--version'], { encoding: 'utf8' }).status === 0) {
    return { command: 'zcode', prefix: [] };
  }
  if (existsSync(ZCODE_APP_BUNDLE)) {
    return { command: process.execPath, prefix: [ZCODE_APP_BUNDLE] };
  }
  return null;
}

const selected = agent ||
  (spawnSync('codex', ['--version'], { encoding: 'utf8' }).status === 0 ? 'codex' : null) ||
  (spawnSync('claude', ['--version'], { encoding: 'utf8' }).status === 0 ? 'claude' : null) ||
  (zcodeCommand() ? 'zcode' : null);
if (!selected) {
  record('Agent CLI', false, 'install and authenticate Codex, Claude, or ZCode');
} else {
  const invocation = selected === 'zcode'
    ? zcodeCommand()
    : { command: selected, prefix: [] };
  const version = spawnSync(invocation.command, [...invocation.prefix, '--version'], { encoding: 'utf8' });
  record(`${selected} CLI`, version.status === 0, version.stdout.trim() || version.stderr.trim());
  if (selected === 'zcode') {
    // The zcode CLI has no auth-status subcommand, so authentication is an
    // honest file-presence check over the same root reviewer execution uses.
    const credentials = join(homedir(), '.zcode', 'v2', 'credentials.json');
    record('zcode authentication', existsSync(credentials),
      existsSync(credentials) ? 'credentials file found (file-based check)' : `${credentials} not found; run: zcode login`);
  } else {
    const authArgs = selected === 'codex' ? ['login', 'status'] : ['auth', 'status'];
    const auth = spawnSync(selected, authArgs, { encoding: 'utf8', timeout: TIMEOUTS.GIT_OPERATION });
    record(`${selected} authentication`, auth.status === 0, auth.stdout.trim() || auth.stderr.trim());
  }
}

for (const check of checks) {
  console.log(`${check.passed ? 'PASS' : 'FAIL'} ${check.name}: ${check.detail}`);
}
if (checks.every(check => check.passed)) {
  const agentFlag = selected === 'zcode' ? ' --model <glm-model>' : '';
  console.log(`Next: npm run review -- --profile quick --round <unused-positive-round> --base HEAD~1 --agent ${selected}${agentFlag}`);
  process.exit(0);
}
process.exit(1);
