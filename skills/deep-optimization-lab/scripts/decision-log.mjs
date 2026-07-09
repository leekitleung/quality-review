#!/usr/bin/env node
/**
 * Decision Log
 *
 * Views and manages the experiment decision log.
 *
 * Supports dual orchestrator ecosystems:
 * - Claude: Opus 4.8 orchestrator
 * - Codex: sol (GPT-5.6) orchestrator
 *
 * Usage:
 *   node decision-log.mjs --show                    # Show all decisions
 *   node decision-log.mjs --add --experiment 001 --decision keep --evidence "Score improved by 15%"
 *   node decision-log.mjs --export                   # Export to CSV
 *   ORCHESTRATOR=codex node decision-log.mjs --show  # Show Codex experiments
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

// Use process.cwd() as the reliable project root
const PROJECT_ROOT = process.cwd();
const EXPERIMENT_LOGS = join(PROJECT_ROOT, 'experiment-logs');
const DECISION_LOG = join(EXPERIMENT_LOGS, 'decision-log.yaml');

// ============================================================
// Orchestrator Environment Detection
// ============================================================

function detectOrchestrator() {
  if (process.env.ORCHESTRATOR) {
    return process.env.ORCHESTRATOR.toLowerCase();
  }
  try {
    const remote = execSync('git remote get-url origin 2>/dev/null || echo ""', { encoding: 'utf-8' }).trim();
    if (remote.includes('github') || remote.includes('gitlab')) {
      return 'claude';
    }
  } catch {}
  return 'claude';
}

function getOrchestratorModel(orchestrator) {
  if (process.env.ORCHESTRATOR_MODEL) {
    return process.env.ORCHESTRATOR_MODEL;
  }
  const models = {
    claude: 'opus-4-8',
    codex: 'sol',
  };
  return models[orchestrator] || models.claude;
}

const ORCHESTRATOR = detectOrchestrator();
const ORCHESTRATOR_MODEL = getOrchestratorModel(ORCHESTRATOR);

// Parse arguments
const args = process.argv.slice(2);
let show = false;
let add = false;
let exportCsv = false;
let experiment = null;
let decision = null;
let evidence = null;

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--show') show = true;
  else if (args[i] === '--add') add = true;
  else if (args[i] === '--export') exportCsv = true;
  else if (args[i] === '--experiment' && args[i + 1]) experiment = args[++i];
  else if (args[i] === '--decision' && args[i + 1]) decision = args[++i];
  else if (args[i] === '--evidence' && args[i + 1]) evidence = args[++i];
}

/**
 * Load or create decision log
 */
function loadDecisionLog() {
  if (existsSync(DECISION_LOG)) {
    try {
      return YAML.parse(readFileSync(DECISION_LOG, 'utf-8'));
    } catch {
      return { decisions: [], antiPatterns: [] };
    }
  }
  return { decisions: [], antiPatterns: [], metadata: { created: new Date().toISOString() } };
}

/**
 * Save decision log
 */
function saveDecisionLog(log) {
  writeFileSync(DECISION_LOG, toYaml(log));
}

/**
 * Show decision log
 */
function showDecisions() {
  const log = loadDecisionLog();

  console.log('=== Experiment Decision Log ===');
  console.log('');
  console.log(`Orchestrator: ${ORCHESTRATOR} (${ORCHESTRATOR_MODEL})`);
  console.log('');

  if (log.decisions.length === 0) {
    console.log('No decisions recorded yet.');
    console.log('');
    console.log('Run experiments first:');
    console.log('  node skills/deep-optimization-lab/scripts/experiment-runner.mjs --hypothesis improve-cli-help-text');
    console.log('  ORCHESTRATOR=codex node experiment-runner.mjs --hypothesis improve-cli-help-text');
    return;
  }

  // Summary table
  console.log('Summary:');
  console.log('  Total experiments:', log.decisions.length);
  console.log('  Kept:', log.decisions.filter(d => d.decision === 'KEEP').length);
  console.log('  Reverted:', log.decisions.filter(d => d.decision === 'REVERT').length);

  // Group by orchestrator (legacy entries without orchestrator field are counted separately)
  const claudeDecisions = log.decisions.filter(d => d.orchestrator === 'claude');
  const codexDecisions = log.decisions.filter(d => d.orchestrator === 'codex');
  const legacyDecisions = log.decisions.filter(d => !d.orchestrator);
  if (claudeDecisions.length > 0) {
    console.log('  Claude (Opus):', claudeDecisions.length);
  }
  if (codexDecisions.length > 0) {
    console.log('  Codex (sol):', codexDecisions.length);
  }
  if (legacyDecisions.length > 0) {
    console.log('  Legacy (pre-orchestrator):', legacyDecisions.length);
  }
  console.log('');

  // Decisions table
  console.log('Decisions:');
  console.log('-'.repeat(100));
  console.log('| #    | Hypothesis           | Dimension           | Decision | Improvement |');
  console.log('-'.repeat(100));

  for (const d of log.decisions) {
    const num = String(d.experiment).padStart(3, '0');
    const hyp = (d.hypothesis || '').substring(0, 20).padEnd(20);
    const dim = (d.dimension || '').substring(0, 20).padEnd(20);
    const dec = d.decision.padEnd(8);
    const imp = d.improvement !== undefined ? `${d.improvement}%` : 'N/A';
    console.log(`| ${num} | ${hyp} | ${dim} | ${dec} | ${imp.padStart(10)} |`);
  }

  console.log('-'.repeat(100));
  console.log('');

  // Anti-patterns
  if (log.antiPatterns && log.antiPatterns.length > 0) {
    console.log('Anti-Patterns (things that did NOT work):');
    console.log('');
    for (const ap of log.antiPatterns) {
      console.log(`  - [${ap.timestamp}] ${ap.pattern}: ${ap.note}`);
    }
    console.log('');
  }

  // Dry run warning
  const dryRuns = log.decisions.filter(d => d.status === 'dry_run');
  if (dryRuns.length > 0) {
    const ratio = Math.round(dryRuns.length / log.decisions.length * 100);
    if (ratio > 30) {
      console.log('⚠️  WARNING: Dry run ratio is', ratio + '% (>30%). Results may not be reliable.');
      console.log('');
    }
  }
}

/**
 * Add a decision
 */
function addDecision() {
  if (!experiment || !decision) {
    console.error('Error: --experiment and --decision are required for --add');
    console.error('Usage: node decision-log.mjs --add --experiment 001 --decision keep --evidence "Score improved by 15%"');
    process.exit(1);
  }

  if (!['KEEP', 'REVERT'].includes(decision)) {
    console.error('Error: --decision must be KEEP or REVERT');
    process.exit(1);
  }

  const log = loadDecisionLog();

  // Load experiment data
  const expFile = join(EXPERIMENT_LOGS, `experiment-${String(experiment).padStart(3, '0')}`, 'experiment-state.json');
  let expData = { hypothesis: 'unknown', dimension: 'unknown' };
  if (existsSync(expFile)) {
    try {
      expData = JSON.parse(readFileSync(expFile, 'utf-8'));
    } catch {}
  }

  const newDecision = {
    experiment: parseInt(experiment),
    hypothesis: expData.hypothesis,
    dimension: expData.dimension,
    orchestrator: ORCHESTRATOR,
    orchestratorModel: ORCHESTRATOR_MODEL,
    decision,
    evidence: evidence || 'No evidence provided',
    timestamp: new Date().toISOString(),
  };

  log.decisions.push(newDecision);
  saveDecisionLog(log);

  console.log('✅ Decision recorded:');
  console.log(`  Experiment: #${experiment}`);
  console.log(`  Hypothesis: ${newDecision.hypothesis}`);
  console.log(`  Decision: ${decision}`);
  console.log(`  Evidence: ${evidence || 'None'}`);

  // If reverted, add to anti-patterns
  if (decision === 'REVERT' && evidence) {
    log.antiPatterns = log.antiPatterns || [];
    log.antiPatterns.push({
      pattern: newDecision.hypothesis,
      timestamp: newDecision.timestamp,
      note: evidence,
    });
    saveDecisionLog(log);
    console.log('');
    console.log('📝 Added to anti-patterns log.');
  }
}

/**
 * Export to CSV
 */
function exportToCsv() {
  const log = loadDecisionLog();

  if (log.decisions.length === 0) {
    console.error('No decisions to export.');
    process.exit(1);
  }

  const csv = [
    'experiment,hypothesis,dimension,decision,improvement,evidence,timestamp',
    ...log.decisions.map(d =>
      `${d.experiment},"${d.hypothesis}","${d.dimension}",${d.decision},${d.improvement || 'N/A'},"${d.evidence || ''}",${d.timestamp}`
    ),
  ].join('\n');

  const csvFile = join(EXPERIMENT_LOGS, 'decisions.csv');
  writeFileSync(csvFile, csv);
  console.log('✅ Exported to:', csvFile);
}

// Simple YAML parser/stringifier
const YAML = {
  parse(str) {
    const lines = str.split('\n');
    const result = {};
    let currentKey = null;
    let currentArray = null;
    const stack = [{ obj: result, indent: -1 }];

    for (const line of lines) {
      if (line.trim() === '' || line.trim().startsWith('#')) continue;

      const indent = line.search(/\S/);
      const trimmed = line.trim();

      if (trimmed.endsWith(':')) {
        const key = trimmed.slice(0, -1);
        result[key] = {};
        currentKey = key;
        stack.push({ obj: result[key], indent });
      } else if (trimmed.startsWith('- ')) {
        const value = trimmed.slice(2);
        if (!Array.isArray(result[currentKey])) {
          result[currentKey] = [];
        }
        result[currentKey].push(value);
      } else if (trimmed.includes(':')) {
        const [k, ...vParts] = trimmed.split(':');
        const v = vParts.join(':').trim();
        result[k.trim()] = v.replace(/^["']|["']$/g, '');
      }
    }

    return result;
  },

  stringify(obj) {
    return toYaml(obj);
  },
};

function toYaml(obj, indent = 0) {
  const spaces = '  '.repeat(indent);
  let result = '';

  for (const [key, value] of Object.entries(obj)) {
    if (value === null || value === undefined) {
      result += `${spaces}${key}: null\n`;
    } else if (typeof value === 'object' && !Array.isArray(value)) {
      result += `${spaces}${key}:\n${toYaml(value, indent + 1)}`;
    } else if (Array.isArray(value)) {
      result += `${spaces}${key}:\n`;
      for (const item of value) {
        result += `${spaces}  - ${item}\n`;
      }
    } else {
      result += `${spaces}${key}: ${JSON.stringify(value)}\n`;
    }
  }

  return result;
}

// Main
if (show) {
  showDecisions();
} else if (add) {
  addDecision();
} else if (exportCsv) {
  exportToCsv();
} else {
  console.log('Decision Log Tool');
  console.log('');
  console.log('Usage:');
  console.log('  node decision-log.mjs --show                    Show all decisions');
  console.log('  node decision-log.mjs --add --experiment 001 --decision keep --evidence "..."');
  console.log('  node decision-log.mjs --export                 Export to CSV');
}
