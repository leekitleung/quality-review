import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import {
  hasConcreteVerificationOutput,
  validateCleanCandidateEvidence,
  validateRollbackEvidence,
} from '../../lib/review-utils.mjs';
import { INSTALL_GATE_COMMAND, requiredCommandGateKeys } from '../../lib/automated-gate-policy.mjs';
import { readContainedFileSync } from '../../lib/security-utils.mjs';
import { TIMEOUTS } from '../../lib/config-constants.mjs';
import { validCandidateCheckoutEvidence, validCommandEvidence } from './evidence.mjs';
import { resolveVerificationCommands } from './verification-policy.mjs';

function sha256(content) {
  return createHash('sha256').update(content).digest('hex');
}

export function loadPersistedGateEvidence({ roundDir, projectRoot, profile, config }) {
  const metadataPath = join(roundDir, 'metadata.json');
  const automatedPath = join(roundDir, 'evidence', 'automated-checks.json');
  if (!existsSync(metadataPath) || !existsSync(automatedPath)) return null;

  const metadata = JSON.parse(readContainedFileSync(roundDir, metadataPath, 'utf8'));
  const automatedContent = readContainedFileSync(roundDir, automatedPath, 'utf8');
  const automatedChecks = JSON.parse(automatedContent);
  const currentCommit = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: projectRoot, encoding: 'utf8', timeout: TIMEOUTS.GIT_OPERATION,
  }).trim();
  const currentTree = execFileSync('git', ['rev-parse', 'HEAD^{tree}'], {
    cwd: projectRoot, encoding: 'utf8', timeout: TIMEOUTS.GIT_OPERATION,
  }).trim();
  const currentStatus = execFileSync('git', ['status', '--short'], {
    cwd: projectRoot, encoding: 'utf8', timeout: TIMEOUTS.GIT_OPERATION,
  }).trim();
  if (currentStatus !== '' || metadata.candidate_commit !== currentCommit ||
      metadata.candidate_tree !== currentTree || metadata.automated_checks_sha256 !== sha256(automatedContent)) {
    throw new Error('persisted evidence does not match the current commit and working-tree status');
  }

  if (profile === 'agentic-release-gate') {
    validateAgenticEvidence(roundDir, metadata);
  }
  validateAutomatedEvidence(config, profile, automatedChecks, metadata);

  return {
    timestamp: metadata.collected_at,
    git: metadata.git,
    files: metadata.files,
    scale: metadata.scale,
    automatedChecks,
  };
}

function validateAgenticEvidence(roundDir, metadata) {
  const cleanContent = readContainedFileSync(roundDir, join(roundDir, 'evidence', 'clean-candidate.json'), 'utf8');
  const rollbackContent = readContainedFileSync(roundDir, join(roundDir, 'evidence', 'rollback-verification.json'), 'utf8');
  const clean = JSON.parse(cleanContent);
  const rollback = JSON.parse(rollbackContent);
  if (metadata.clean_candidate_sha256 !== sha256(cleanContent) ||
      !validateCleanCandidateEvidence(clean, metadata.candidate_commit, metadata.candidate_tree)) {
    throw new Error('invalid clean-candidate verification evidence');
  }
  if (metadata.rollback_verification_sha256 !== sha256(rollbackContent) ||
      !validateRollbackEvidence(
        rollback, metadata.candidate_commit, metadata.candidate_tree, metadata.base_commit, metadata.base_tree,
      )) {
    throw new Error('invalid rollback verification evidence');
  }
}

export function validateAutomatedEvidence(config, profile, automatedChecks, metadata) {
  const verification = resolveVerificationCommands(config);
  const commandsByGate = {
    installGate: INSTALL_GATE_COMMAND,
    testGate: verification.test,
    typecheckGate: verification.typecheck,
    buildGate: verification.build,
    lintGate: verification.lint,
    auditGate: verification.audit,
    coverageGate: verification.coverage,
    e2eGate: verification.e2e,
  };

  for (const name of requiredCommandGateKeys(profile)) {
    const expectedCommand = commandsByGate[name];
    if (!validCommandEvidence(automatedChecks[name], expectedCommand) ||
        (name === 'testGate' && !hasConcreteVerificationOutput('test', automatedChecks[name]?.output)) ||
        (name === 'coverageGate' && !hasConcreteVerificationOutput('coverage', automatedChecks[name]?.output))) {
      throw new Error(`invalid ${name} command evidence`);
    }
  }
  if ((profile === 'agentic-release-gate' && !automatedChecks.candidateCheckout) ||
      (automatedChecks.candidateCheckout && !validCandidateCheckoutEvidence(
        automatedChecks.candidateCheckout, metadata.candidate_commit, metadata.candidate_tree,
      ))) {
    throw new Error('invalid automated verification checkout evidence');
  }
}
