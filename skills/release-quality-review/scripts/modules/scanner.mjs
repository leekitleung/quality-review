import { readdirSync, statSync } from 'fs';
import { join, relative } from 'path';
import { log } from './constants.mjs';
import { containsSensitiveText, readContainedFileSync } from '../../lib/security-utils.mjs';

/**
 * Scan round artifacts for security issues
 * @param {string} roundDir - Round directory
 * @returns {string[]} List of findings
 */
export function scanRoundArtifacts(roundDir) {
  const findings = [];
  const queue = [roundDir];
  let fileCount = 0;
  let totalBytes = 0;

  while (queue.length > 0) {
    const directory = queue.shift();
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const file = join(directory, entry.name);
      const label = relative(roundDir, file);

      if (entry.isSymbolicLink()) {
        findings.push(`${label}: symbolic links are not allowed`);
        continue;
      }
      if (entry.isDirectory()) {
        queue.push(file);
        continue;
      }
      if (!entry.isFile()) {
        findings.push(`${label}: unsupported artifact type`);
        continue;
      }

      fileCount++;
      const size = statSync(file).size;
      totalBytes += size;

      if (fileCount > 500 || totalBytes > 20 * 1024 * 1024 || size > 2 * 1024 * 1024) {
        findings.push(`${label}: artifact scan limit exceeded`);
        continue;
      }

      try {
        if (containsSensitiveText(readContainedFileSync(roundDir, file, 'utf8'))) {
          findings.push(`${label}: sensitive text detected`);
        }
      } catch (error) {
        findings.push(`${label}: artifact scan failed (${error.message})`);
      }
    }
  }

  return findings;
}
