import { existsSync } from 'node:fs';
import { join } from 'node:path';

import {
  ensureContainedDirectorySync, readContainedFileSync, writeContainedFileSync,
} from '../../lib/security-utils.mjs';

export function reviewerAuthRoots(agent, toolEnv) {
  const home = toolEnv.HOME;
  const candidates = agent === 'codex'
    ? [toolEnv.CODEX_HOME, home && join(home, '.codex')]
    : agent === 'zcode'
      ? [toolEnv.ZCODE_CONFIG_DIR, home && join(home, '.zcode')]
      : [toolEnv.CLAUDE_CONFIG_DIR, home && join(home, '.claude')];
  return [...new Set(candidates.filter(path => path && existsSync(path) && path !== home))];
}

export function prepareCodexHome(toolEnv, reviewerSandboxDir, authMode = 'file') {
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

// ZCode stores its OAuth credentials under ~/.zcode/v2/credentials.json and
// resolves its config from HOME, so the sandbox home needs the credential
// file copied in (same shape as prepareCodexHome). The minimal file set may
// need to grow once the CLI runs headless; keep it to auth material only -
// never mirror provider or account settings into the reviewer sandbox.
export function prepareZcodeHome(toolEnv, reviewerSandboxDir) {
  const zcodeHome = join(reviewerSandboxDir, '.zcode');
  const v2Dir = join(zcodeHome, 'v2');
  ensureContainedDirectorySync(reviewerSandboxDir, zcodeHome);
  ensureContainedDirectorySync(zcodeHome, v2Dir);

  const authRoot = reviewerAuthRoots('zcode', toolEnv)[0];
  if (!authRoot || !existsSync(join(authRoot, 'v2', 'credentials.json'))) {
    throw new Error('ZCode credentials are unavailable for isolated reviewer execution');
  }
  const credentials = readContainedFileSync(authRoot, join(authRoot, 'v2', 'credentials.json'), 'utf8');
  writeContainedFileSync(v2Dir, join(v2Dir, 'credentials.json'), credentials);
  return zcodeHome;
}
