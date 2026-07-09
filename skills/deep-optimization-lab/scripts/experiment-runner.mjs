#!/usr/bin/env node
/**
 * Experiment Runner
 *
 * Runs single-variable optimization experiments.
 * Each experiment: hypothesis → change → evaluate → decide (keep/revert)
 *
 * Supports dual orchestrator ecosystems:
 * - Claude: Opus 4.8 orchestrator, Claude Code executor
 * - Codex: sol (GPT-5.6) orchestrator, Codex CLI executor
 *
 * Usage:
 *   node experiment-runner.mjs --hypothesis improve-cli-help-text --profile project-quality
 *   ORCHESTRATOR=codex node experiment-runner.mjs --hypothesis improve-cli-help-text
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, cpSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';
import { load as yamlLoad, dump as yamlDump } from 'js-yaml';
const toYaml = yamlDump;

// Scripts are designed to run from project root via: node skills/.../script.mjs
// Use process.cwd() as the reliable project root
const PROJECT_ROOT = process.cwd();
const EXPERIMENT_LOGS = join(PROJECT_ROOT, 'experiment-logs');

// ============================================================
// Orchestrator Environment Detection
// ============================================================

/**
 * Detect which orchestrator ecosystem we're running in.
 * Priority: explicit env var > detection from git remote > Claude default
 */
function detectOrchestrator() {
  // 1. Explicit override
  if (process.env.ORCHESTRATOR) {
    return process.env.ORCHESTRATOR.toLowerCase();
  }

  // 2. Auto-detect from git remote
  try {
    const remote = execSync('git remote get-url origin 2>/dev/null || echo ""', { encoding: 'utf-8' }).trim();
    if (remote.includes('github') || remote.includes('gitlab')) {
      // Default to Claude ecosystem
      return 'claude';
    }
  } catch {}

  // 3. Check for Codex-specific files/commands
  try {
    execSync('codex --version 2>/dev/null', { stdio: 'pipe' });
    return 'codex';
  } catch {}

  // 4. Default to Claude
  return 'claude';
}

/**
 * Get the orchestrator model for the current ecosystem.
 */
function getOrchestratorModel(orchestrator) {
  // Explicit override takes precedence
  if (process.env.ORCHESTRATOR_MODEL) {
    return process.env.ORCHESTRATOR_MODEL;
  }

  const models = {
    claude: 'opus-4-8',
    codex: 'sol',  // GPT-5.6 flagship model
  };

  return models[orchestrator] || models.claude;
}

/**
 * Get the executor ID for the current ecosystem.
 * NOTE: Currently informational only - scripts don't route execution through executors.
 */
function getExecutorId(orchestrator) {
  // Explicit override takes precedence
  if (process.env.EXECUTOR_ID) {
    return process.env.EXECUTOR_ID;
  }

  const executors = {
    claude: 'claude-code',
    codex: 'codex-cli',
  };

  return executors[orchestrator] || executors.claude;
}

// Detect environment
const ORCHESTRATOR = detectOrchestrator();
const ORCHESTRATOR_MODEL = getOrchestratorModel(ORCHESTRATOR);
const EXECUTOR_ID = getExecutorId(ORCHESTRATOR);

console.log('=== Dual Orchestrator Environment ===');
console.log(`Orchestrator: ${ORCHESTRATOR}`);
console.log(`Model: ${ORCHESTRATOR_MODEL}`);
console.log(`Executor: ${EXECUTOR_ID}`);
console.log('');

// Parse arguments
const args = process.argv.slice(2);
let hypothesis = null;
let profile = 'project-quality';
let dryRun = false;

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--hypothesis' && args[i + 1]) {
    hypothesis = args[i + 1];
    i++;
  } else if (args[i] === '--profile' && args[i + 1]) {
    profile = args[i + 1];
    i++;
  } else if (args[i] === '--dry-run') {
    dryRun = true;
  }
}

if (!hypothesis) {
  console.error('Error: --hypothesis <name> is required');
  console.error('Usage: node experiment-runner.mjs --hypothesis improve-cli-help-text [--profile project-quality] [--dry-run]');
  process.exit(1);
}

// Hypothesis templates for common optimizations
const HYPOTHESIS_TEMPLATES = {
  'improve-cli-help-text': {
    dimension: 'cli-usability',
    description: 'Improve CLI help text and error messages for better developer experience',
    change: 'Review and enhance help text in package.json scripts and CLI tools',
    testPrompt: 'Evaluate CLI usability: Are help messages clear? Do error messages explain what went wrong?',
  },
  'increase-test-coverage': {
    dimension: 'test-coverage',
    description: 'Add more unit tests to improve coverage',
    change: 'Add tests for untested code paths, especially error handling',
    testPrompt: 'Measure test coverage and identify uncovered critical paths',
  },
  'reduce-lint-errors': {
    dimension: 'lint-errors',
    description: 'Fix linting errors to improve code quality',
    change: 'Run lint and fix reported issues',
    testPrompt: 'Run linter and count remaining errors',
  },
  'improve-documentation': {
    dimension: 'documentation-coverage',
    description: 'Add documentation for undocumented features',
    change: 'Review undocumented functions and add documentation',
    testPrompt: 'Check documentation coverage - are all public APIs documented?',
  },
  'strengthen-security': {
    dimension: 'security-posture',
    description: 'Improve security measures and add security documentation',
    change: 'Add security headers, improve input validation, add security policy',
    testPrompt: 'Run security checks - are there obvious vulnerabilities?',
  },
  'improve-architecture': {
    dimension: 'architecture-score',
    description: 'Refactor code structure for better maintainability',
    change: 'Review file organization and refactor for better separation of concerns',
    testPrompt: 'Evaluate architecture: Is code properly organized? Are concerns separated?',
  },
  'improve-skill-instructions': {
    dimension: 'instruction-clarity',
    description: 'Improve SKILL.md instruction clarity',
    change: 'Review and enhance skill instructions with better examples and clearer phases',
    testPrompt: 'Evaluate skill instructions: Are they clear? Do they have good examples?',
  },
  'custom': null, // User-defined
};

// Check for baseline
const baselineFile = join(EXPERIMENT_LOGS, 'baseline.yaml');
if (!existsSync(baselineFile)) {
  console.warn('⚠️  No baseline found. Run baseline-collector.mjs first.');
  console.warn('   Creating baseline now...');
  execSync(`node skills/deep-optimization-lab/scripts/baseline-collector.mjs --profile ${profile}`, { stdio: 'inherit', cwd: PROJECT_ROOT });
}

// Load baseline
let baseline;
try {
  baseline = yamlLoad(readFileSync(baselineFile, 'utf-8'));
} catch {
  console.error('Error: Could not load baseline.yaml');
  process.exit(1);
}

// Get hypothesis config
const hypothesisConfig = HYPOTHESIS_TEMPLATES[hypothesis] || {
  dimension: 'custom',
  description: hypothesis,
  change: 'User-defined change',
  testPrompt: 'Evaluate the change for improvement',
};

// Find next experiment number
let experimentNum = 1;
if (existsSync(EXPERIMENT_LOGS)) {
  const dirs = readdirSync(EXPERIMENT_LOGS).filter(d => d.startsWith('experiment-'));
  if (dirs.length > 0) {
    experimentNum = Math.max(...dirs.map(d => parseInt(d.split('-')[1]))) + 1;
  }
}

const experimentDir = join(EXPERIMENT_LOGS, `experiment-${String(experimentNum).padStart(3, '0')}`);
mkdirSync(experimentDir, { recursive: true });

console.log('=== Experiment Runner ===');
console.log(`Experiment: #${experimentNum}`);
console.log(`Hypothesis: ${hypothesis}`);
console.log(`Profile: ${profile}`);
console.log(`Dry Run: ${dryRun}`);
console.log('');
console.log(`Orchestrator: ${ORCHESTRATOR} (${ORCHESTRATOR_MODEL})`);
console.log(`Executor: ${EXECUTOR_ID}`);
console.log('');

// Save hypothesis
writeFileSync(join(experimentDir, 'hypothesis.md'), `# Hypothesis: ${hypothesis}

## Dimension
${hypothesisConfig.dimension}

## Description
${hypothesisConfig.description}

## Change to Make
${hypothesisConfig.change}

## Test Prompt
${hypothesisConfig.testPrompt}

## Baseline Metrics
${JSON.stringify(baseline.metrics, null, 2)}
`);

console.log('📝 Hypothesis saved.');

// Create change record (will be populated after the change)
const changeRecord = {
  experiment: experimentNum,
  hypothesis,
  dimension: hypothesisConfig.dimension,
  timestamp: new Date().toISOString(),
  baseline: baseline.metrics,
  dryRun,
  status: 'pending',
};

// If dry run, just output what would be changed
if (dryRun) {
  console.log('');
  console.log('🔍 DRY RUN MODE');
  console.log('');
  console.log('Would change:');
  console.log(`  - Dimension: ${hypothesisConfig.dimension}`);
  console.log(`  - Description: ${hypothesisConfig.description}`);
  console.log('');
  console.log('Would evaluate with:');
  console.log(`  - Test prompt: ${hypothesisConfig.testPrompt}`);
  console.log('');
  console.log('Would compare to baseline:');
  for (const [key, value] of Object.entries(baseline.metrics)) {
    console.log(`  - ${key}: ${JSON.stringify(value)}`);
  }

  changeRecord.status = 'dry_run';
  writeFileSync(join(experimentDir, 'change.patch'), `# DRY RUN - No changes made\n\nHypothesis: ${hypothesis}\nDimension: ${hypothesisConfig.dimension}`);
  writeFileSync(join(experimentDir, 'decision.yaml'), toYaml(changeRecord));
  process.exit(0);
}

// Run the experiment
console.log('');
console.log('⚠️  EXPERIMENT MODE');
console.log('');
console.log('This script will:');
console.log('1. Create a backup of current state');
console.log('2. Prompt you to make changes');
console.log('3. Evaluate the change');
console.log('4. Decide to keep or revert');
console.log('');

// Create backup
const backupDir = join(experimentDir, 'backup');
mkdirSync(backupDir, { recursive: true });

console.log('📦 Creating backup...');
// Backup relevant files based on dimension
if (hypothesisConfig.dimension.includes('skill')) {
  execSync(`cp -r skills ${backupDir}/skills 2>/dev/null || true`, { shell: 'bash' });
} else if (hypothesisConfig.dimension.includes('test')) {
  execSync(`cp -r tests ${backupDir}/tests 2>/dev/null || true`, { shell: 'bash' });
} else if (hypothesisConfig.dimension.includes('doc')) {
  execSync(`cp -r docs ${backupDir}/docs 2>/dev/null || true`, { shell: 'bash' });
} else {
  // Backup everything for safety
  execSync(`cp -r apps package.json apps scripts docs tests ${backupDir}/ 2>/dev/null || true`, { shell: 'bash' });
}

console.log('Backup created at:', backupDir);
console.log('');

// Prompt for change
console.log('========================================');
console.log('🎯 NOW MAKE YOUR CHANGE');
console.log('========================================');
console.log('');
console.log(`Dimension: ${hypothesisConfig.dimension}`);
console.log(`Description: ${hypothesisConfig.description}`);
console.log('');
console.log('After making your change, run this command to evaluate:');
console.log('');
console.log(`  node skills/deep-optimization-lab/scripts/evaluate-change.mjs --experiment ${experimentNum} --profile ${profile}`);
console.log('');
console.log('Or run the full experiment loop with:');
console.log('');
console.log(`  node skills/deep-optimization-lab/scripts/experiment-loop.mjs --experiment ${experimentNum} --profile ${profile}`);
console.log('');

// Save experiment state
writeFileSync(join(experimentDir, 'experiment-state.json'), JSON.stringify({
  experiment: experimentNum,
  hypothesis,
  hypothesisConfig,
  baseline,
  backupDir,
  orchestrator: ORCHESTRATOR,
  orchestratorModel: ORCHESTRATOR_MODEL,
  executor: EXECUTOR_ID,
  createdAt: new Date().toISOString(),
}, null, 2));

console.log('Experiment setup complete. Make your changes and evaluate.');
