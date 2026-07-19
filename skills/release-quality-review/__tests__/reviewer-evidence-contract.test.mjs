import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  canonicalReviewerEvidence,
  renderReviewerEvidenceBlocks,
  validateReviewerEvidenceBlocks,
} from '../lib/reviewer-evidence-contract.mjs';
import { validateAutomatedEvidence } from '../scripts/modules/persisted-gate-evidence.mjs';
import { validateReviewerPacket } from '../scripts/modules/reviewer-packet.mjs';
import { generateReviewerPrompt } from '../scripts/modules/reviewer-prompt.mjs';

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

test('reserves structured command labels for shared round evidence', () => {
  const prompt = generateReviewerPrompt({
    reviewerName: 'product-flow', reviewerContent: 'review', currentRound: 7,
    candidateIdentity: { commit: 'a'.repeat(40), tree: 'b'.repeat(40) },
    reviewBackend: 'codex', reviewModel: 'gpt-5.4', reviewReasoningEffort: null,
    profile: 'release-gate', skillDir: '/skill', reviewerOutputDir: '/output', automatedChecks,
  });
  assert.match(prompt, /任何本地诊断都不得使用字面标签/);
});

test('rejects invented counts and cross-command output against round evidence', () => {
  const valid = 'Command: npm test\nExit code: 0\nOutput: # tests 159; # pass 159; # fail 0';
  assert.deepEqual(validateReviewerEvidenceBlocks(valid, automatedChecks), { valid: true, records: 1 });

  const invented = 'Command: npm test\nExit code: 0\nOutput: # tests 1; # pass 1; # fail 0';
  assert.equal(validateReviewerEvidenceBlocks(invented, automatedChecks).valid, false);

  const crossCommand = 'Command: npm test\nExit code: 0\nOutput: found 0 vulnerabilities';
  assert.equal(validateReviewerEvidenceBlocks(crossCommand, automatedChecks).valid, false);
});

test('release persisted evidence rejects forged coverage summaries', () => {
  const timedRecord = (command, output) => {
    const value = record(command, output);
    return {
      ...value,
      started_at: '2026-07-19T00:00:00.000Z',
      finished_at: '2026-07-19T00:00:01.000Z',
      output_bytes: Buffer.byteLength(output),
      truncated: false,
    };
  };
  const checks = {
    testGate: timedRecord('npm test', '# tests 1\n# pass 1\n# fail 0'),
    typecheckGate: timedRecord('npm run typecheck', 'node --check'),
    buildGate: timedRecord('npm run build', 'node --check'),
    lintGate: timedRecord('npm run lint', 'node --check'),
    auditGate: timedRecord('npm audit --audit-level=high', 'found 0 vulnerabilities'),
    coverageGate: timedRecord('npm run coverage', 'forged coverage pass'),
    e2eGate: timedRecord('npm run test:e2e', '# tests 1\n# pass 1\n# fail 0'),
  };
  assert.throws(
    () => validateAutomatedEvidence({}, 'release-gate', checks, {}),
    /invalid coverageGate command evidence/,
  );
});

test('failing reviewer packets still require current-round command evidence', async () => {
  const reviewerDir = mkdtempSync(join(tmpdir(), 'reviewer-packet-'));
  const commit = 'a'.repeat(40);
  const tree = 'b'.repeat(40);
  try {
    writeFileSync(join(reviewerDir, 'result.yaml'), [
      'reviewer: product-flow', 'profile: release-gate', 'round: 7',
      `candidate_commit: ${commit}`, `candidate_tree: ${tree}`, 'score: 89', 'status: fail',
      'review_backend: codex', 'review_model: gpt-5.4', 'blockers: []', 'redlines: []',
    ].join('\n'));
    writeFileSync(join(reviewerDir, 'score.md'), '# Score\n\n## Overall Score: 89/100\n');
    writeFileSync(join(reviewerDir, 'blockers.md'), '# Blockers\n\nNone.\n');
    writeFileSync(join(reviewerDir, 'improvement-list.md'), '# Improvements\n');
    const options = {
      reviewerDir, reviewer: 'product-flow', expectedProfile: 'release-gate', expectedRound: 7,
      currentIdentity: { commit, tree }, expectedBackend: 'codex',
      expectedModel: 'gpt-5.4', automatedChecks,
    };
    const missing = await validateReviewerPacket(options);
    assert.equal(missing.valid, false);
    assert.match(missing.reason, /missing round-owned command evidence/);

    writeFileSync(join(reviewerDir, 'score.md'), [
      '# Score', '', '## Overall Score: 89/100', '',
      'Command: npm test', 'Exit code: 0', 'Output: # tests 159; # pass 159; # fail 0',
    ].join('\n'));
    assert.equal((await validateReviewerPacket(options)).valid, true);
  } finally {
    rmSync(reviewerDir, { recursive: true, force: true });
  }
});
