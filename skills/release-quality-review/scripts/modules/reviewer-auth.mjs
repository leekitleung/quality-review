import { existsSync } from 'node:fs';
import { join } from 'node:path';

import {
  ensureContainedDirectorySync, readContainedFileSync, writeContainedFileSync,
} from '../../lib/security-utils.mjs';

export function reviewerAuthRoots(agent, toolEnv) {
  const home = toolEnv.HOME;
  const candidates = agent === 'codex'
    ? [toolEnv.CODEX_HOME, home && join(home, '.codex')]
    : [toolEnv.CLAUDE_CONFIG_DIR, home && join(home, '.claude')];
  return [...new Set(candidates.filter(path => path && existsSync(path) && path !== home))];
}

export function prepareCodexHome(toolEnv, reviewerSandboxDir) {
  const authMode = toolEnv.RELEASE_QUALITY_CODEX_AUTH_MODE || 'file';
  if (!['file', 'none'].includes(authMode)) {
    throw new Error(`Unsupported Codex reviewer auth mode: ${authMode}`);
  }
  const codexHome = join(reviewerSandboxDir, '.codex');
  ensureContainedDirectorySync(reviewerSandboxDir, codexHome);
  if (authMode === 'none') return codexHome;

  const authRoot = reviewerAuthRoots('codex', toolEnv)[0];
  if (!authRoot || !existsSync(join(authRoot, 'auth.json'))) {
    throw new Error('Codex auth.json is unavailable for isolated reviewer execution');
  }
  const auth = readContainedFileSync(authRoot, join(authRoot, 'auth.json'), 'utf8');
  writeContainedFileSync(codexHome, join(codexHome, 'auth.json'), auth);
  return codexHome;
}
