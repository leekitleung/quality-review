import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { buildCandidateSandboxProfile } from '../lib/sandbox-profile.mjs';

describe('candidate sandbox profile', () => {
  test('permits only required macOS system service lookups for network access', () => {
    const profile = buildCandidateSandboxProfile({
      readRoots: ['/project', '/'], writeRoots: ['/output', '/dev'], allowNetwork: true,
    });

    assert.match(profile, /\(allow network\*\)/);
    assert.match(profile, /\(global-name "com\.apple\.trustd\.agent"\)/);
    assert.match(profile, /\(global-name "com\.apple\.SystemConfiguration\.configd"\)/);
    assert.doesNotMatch(profile, /\(allow mach-lookup\)/);
    assert.match(profile, /\(literal "\/"\).*\(subpath "\/project"\)/);
    assert.doesNotMatch(profile, /\(subpath "\/"\)/);
  });

  test('omits network and system-service permissions when network access is disabled', () => {
    const profile = buildCandidateSandboxProfile({
      readRoots: ['/', '/project'], writeRoots: ['/output', '/dev'], allowNetwork: false,
    });

    assert.doesNotMatch(profile, /allow network/);
    assert.doesNotMatch(profile, /mach-lookup/);
    assert.doesNotMatch(profile, /ipc-posix-shm/);
  });
});
