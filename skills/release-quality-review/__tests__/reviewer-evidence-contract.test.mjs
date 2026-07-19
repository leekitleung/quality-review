import assert from 'node:assert/strict';
import test from 'node:test';

import {
  canonicalReviewerEvidence,
  renderReviewerEvidenceBlocks,
  validateReviewerEvidenceBlocks,
} from '../lib/reviewer-evidence-contract.mjs';

function record(command, output) {
  return { command, status: 'pass', exit_code: 0, output };
}

const automatedChecks = {
  testGate: record('npm test', 'TAP version 13\n# tests 159\n# pass 159\n# fail 0\n'),
  buildGate: record('npm run build', '> npm run typecheck\n> node --check scripts/review-gate.mjs\n'),
  auditGate: record('npm audit --audit-level=high', 'found 0 vulnerabilities\n'),
  coverageGate: record('npm run coverage', '# all files | 83.21 | 64.69 | 81.65 |\n'),
};

test('derives canonical reviewer summaries from round-owned command records', () => {
  assert.deepEqual(canonicalReviewerEvidence(automatedChecks), [
    { command: 'npm test', exitCode: 0, output: '# tests 159; # pass 159; # fail 0' },
    { command: 'npm run build', exitCode: 0, output: 'node --check' },
    { command: 'npm audit --audit-level=high', exitCode: 0, output: 'found 0 vulnerabilities' },
    { command: 'npm run coverage', exitCode: 0, output: 'all files | 83.21 | 64.69 | 81.65 |' },
  ]);
});

test('renders the only reviewer packet command evidence accepted for the round', () => {
  const rendered = renderReviewerEvidenceBlocks(automatedChecks);
  assert.match(rendered, /Command: npm test\nExit code: 0\nOutput: # tests 159; # pass 159; # fail 0/);
  assert.match(rendered, /Command: npm run build\nExit code: 0\nOutput: node --check/);
});

test('rejects invented counts and cross-command output against round evidence', () => {
  const valid = 'Command: npm test\nExit code: 0\nOutput: # tests 159; # pass 159; # fail 0';
  assert.deepEqual(validateReviewerEvidenceBlocks(valid, automatedChecks), { valid: true, records: 1 });

  const invented = 'Command: npm test\nExit code: 0\nOutput: # tests 1; # pass 1; # fail 0';
  assert.equal(validateReviewerEvidenceBlocks(invented, automatedChecks).valid, false);

  const crossCommand = 'Command: npm test\nExit code: 0\nOutput: found 0 vulnerabilities';
  assert.equal(validateReviewerEvidenceBlocks(crossCommand, automatedChecks).valid, false);
});
