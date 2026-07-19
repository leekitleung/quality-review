#!/usr/bin/env node

import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

function collectModules(directory) {
  const modules = [];
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name === '__tests__') continue;
    const target = join(directory, entry.name);
    if (entry.isDirectory()) modules.push(...collectModules(target));
    else if (entry.isFile() && entry.name.endsWith('.mjs')) modules.push(target);
  }
  return modules;
}

const modules = ['scripts', 'skills'].flatMap(collectModules);
for (const module of modules) {
  const result = spawnSync(process.execPath, ['--check', module], { stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

console.log(`syntax checked: ${modules.length} files`);
