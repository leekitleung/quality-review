#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFile, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { isPathWithin, resolveWithinRoot, shouldIncludeCanonicalFile, writeContainedFile } from '../skills/release-quality-review/lib/security-utils.mjs';

const root = process.cwd();
const registryPath = path.join(root, 'skill-registry.yaml');
const lockPath = path.join(root, 'skills.lock.yaml');
const mode = process.argv[2] || 'check';

async function readJson(file) {
  return JSON.parse(await readFile(file, 'utf8'));
}

async function filesUnder(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name === '__tests__' || !shouldIncludeCanonicalFile(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...await filesUnder(full));
    else files.push(full);
  }
  return files;
}

async function digest(files) {
  const hash = createHash('sha256');
  for (const file of files.sort()) {
    hash.update(path.relative(root, file));
    hash.update('\0');
    hash.update(await readFile(file));
    hash.update('\0');
  }
  return hash.digest('hex');
}

function validateFrontmatter(content, file) {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) throw new Error(`${file}: missing YAML frontmatter`);
  const keys = [...match[1].matchAll(/^([a-z][a-z0-9-]*):/gm)].map(item => item[1]);
  const unexpected = keys.filter(key => !['name', 'description'].includes(key));
  if (!keys.includes('name') || !keys.includes('description') || unexpected.length) {
    throw new Error(`${file}: frontmatter must contain only name and description`);
  }
}

function wrapper(name, canonical) {
  return `---\nname: ${name}\ndescription: Adapter for the canonical ${name} skill in this repository. Use when the canonical skill's review gate is requested.\n---\n\nRead and follow \`${canonical}/SKILL.md\`. Treat that directory as the only canonical source.\n`;
}

function agent(name, canonical) {
  return `---\nname: ${name}\ndescription: Independent ${name} reviewer for the release quality gate.\n---\n\nRead and follow \`${canonical}/reviewers/${name}.md\`. Return only the canonical result template required by the skill.\n`;
}

async function expectedState(config) {
  const canonical = config.canonical;
  const canonicalDir = resolveWithinRoot(root, canonical, 'canonical skill path');
  const rootReal = await realpath(root);
  const canonicalReal = await realpath(canonicalDir);
  if (!isPathWithin(rootReal, canonicalReal)) throw new Error('canonical skill path resolves outside the repository');
  if (!Array.isArray(config.reviewers) || config.reviewers.length === 0) throw new Error('registry must define at least one reviewer');
  for (const reviewer of config.reviewers) {
    if (!/^[a-z0-9-]+$/.test(reviewer)) throw new Error(`invalid reviewer name: ${reviewer}`);
  }
  const required = [path.join(canonicalDir, 'SKILL.md'), path.join(canonicalDir, 'agents/openai.yaml')];
  for (const reviewer of config.reviewers) required.push(path.join(canonicalDir, `reviewers/${reviewer}.md`));
  await Promise.all(required.map(file => readFile(file)));
  validateFrontmatter(await readFile(path.join(canonicalDir, 'SKILL.md'), 'utf8'), `${canonical}/SKILL.md`);

  const generated = new Map([
    [config.claude_skill, wrapper('release-quality-review', canonical)],
    [config.codex_skill, wrapper('release-quality-review', canonical)]
  ]);
  for (const reviewer of config.reviewers) {
    generated.set(path.posix.join(config.claude_agents, `${reviewer}.md`), agent(reviewer, canonical));
  }
  for (const relative of generated.keys()) resolveWithinRoot(root, relative, 'adapter path');
  return {
    generated,
    lock: {
      schema_version: 1,
      skills: {
        'release-quality-review': {
          canonical_sha256: await digest(await filesUnder(canonicalDir)),
          adapters_sha256: createHash('sha256').update([...generated].map(([p, v]) => `${p}\0${v}\0`).join('')).digest('hex')
        }
      }
    }
  };
}

async function main() {
  if (!['sync', 'check', 'diff'].includes(mode)) throw new Error('Usage: sync-skills.mjs <sync|check|diff>');
  const registry = await readJson(registryPath);
  const config = registry.skills['release-quality-review'];
  const { generated, lock } = await expectedState(config);

  if (mode === 'sync') {
    const rootReal = await realpath(root);
    for (const [relative, content] of generated) {
      const file = resolveWithinRoot(root, relative, 'adapter path');
      await writeContainedFile(rootReal, file, content);
    }
    await writeContainedFile(rootReal, lockPath, `${JSON.stringify(lock, null, 2)}\n`);
    console.log(`Synced ${generated.size} adapters and skills.lock.yaml`);
    return;
  }

  const drift = [];
  for (const [relative, expected] of generated) {
    try {
      if (await readFile(resolveWithinRoot(root, relative, 'adapter path'), 'utf8') !== expected) drift.push(relative);
    } catch {
      drift.push(relative);
    }
  }
  try {
    if (JSON.stringify(await readJson(lockPath)) !== JSON.stringify(lock)) drift.push('skills.lock.yaml');
  } catch {
    drift.push('skills.lock.yaml');
  }
  if (drift.length) {
    console.error(`Skill drift detected:\n${drift.map(file => `- ${file}`).join('\n')}`);
    process.exit(1);
  }
  console.log(`Skill distribution is in sync (${generated.size} adapters)`);
}

main().catch(error => {
  console.error(error.message);
  process.exit(1);
});
