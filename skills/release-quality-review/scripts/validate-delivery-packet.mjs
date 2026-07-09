#!/usr/bin/env node
/**
 * Delivery Packet Validator
 *
 * Validates the structure and completeness of a Delivery Packet.
 *
 * Key principle:
 * - This script does NOT fix missing evidence
 * - This script does NOT repair incomplete packets
 * - This script only validates and reports
 *
 * Usage:
 *   node validate-delivery-packet.mjs --packet <path>
 *   node validate-delivery-packet.mjs --packet .agent-deliveries/task-001
 *   node validate-delivery-packet.mjs --packet <path> --mode strict
 */

import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = process.cwd();

// ANSI colors
const c = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
};

const log = {
  info: (msg) => console.log(`${c.blue}ℹ${c.reset} ${msg}`),
  pass: (msg) => console.log(`${c.green}✓${c.reset} ${msg}`),
  fail: (msg) => console.log(`${c.red}✗${c.reset} ${msg}`),
  warn: (msg) => console.log(`${c.yellow}⚠${c.reset} ${msg}`),
  title: (msg) => console.log(`\n${c.bright}${c.cyan}═══ ${msg} ═══${c.reset}\n`),
  section: (msg) => console.log(`\n${c.bright}${msg}${c.reset}`),
};

// Parse arguments
const args = process.argv.slice(2);
let packetPath = null;
let mode = 'assisted';
let verbose = false;

for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === '--packet' && args[i + 1]) {
    packetPath = args[++i];
  } else if (arg === '--mode' && args[i + 1]) {
    mode = args[++i];
  } else if (arg === '--verbose' || arg === '-v') {
    verbose = true;
  } else if (arg === '--help' || arg === '-h') {
    printHelp();
    process.exit(0);
  }
}

function printHelp() {
  console.log(`
${c.bright}Delivery Packet Validator${c.reset}

Usage:
  node validate-delivery-packet.mjs --packet <path> [--mode strict|assisted|legacy]

Options:
  --packet <path>    Path to delivery packet directory (required)
  --mode <mode>     Validation mode: strict, assisted, legacy (default: assisted)
  --verbose, -v     Show detailed output
  --help, -h        Show this help

Modes:
  strict      Release gate mode. Missing packet = FAIL
  assisted    Development mode. Missing packet = INCOMPLETE, forensic allowed
  legacy      Fallback mode. No packet required, max verdict = CONDITIONAL_PASS

Exit Codes:
  0 = VALID
  1 = INVALID (has immediate fails)
  2 = INCOMPLETE (missing files or fields)
  3 = CONDITIONAL_PASS (legacy mode, no packet)
`);
}

// Required files
const REQUIRED_FILES = [
  'metadata.json',
  'goal.md',
  'scope.md',
  'changes.md',
  'diff-summary.md',
  'evidence.md',
  'risk.md',
  'blockers.md',
];

// Optional files
const OPTIONAL_FILES = [
  'handoff.md',
];

// Required fields in metadata.json
const REQUIRED_METADATA_FIELDS = [
  'task_id',
  'executor',
  'profile',
  'created_at',
  'packet_mode',
];

// Required evidence structure
const REQUIRED_EVIDENCE_FIELDS = [
  'commands_executed',
];

// Evidence command required subfields
const REQUIRED_COMMAND_FIELDS = [
  'command',
  'exit_code',
  'output_summary',
];

/**
 * Main validation function
 */
function validate() {
  log.title('DELIVERY PACKET VALIDATOR');
  log.info(`Mode: ${mode}`);
  log.info(`Packet path: ${packetPath || '(not specified)'}`);
  console.log('');

  // Check if packet path provided
  if (!packetPath) {
    log.warn('No packet path specified. Checking current directory...');
    packetPath = '.agent-deliveries';
  }

  // Resolve absolute path
  const absolutePath = join(PROJECT_ROOT, packetPath);

  // Check if packet exists
  if (!existsSync(absolutePath)) {
    log.fail(`Packet directory not found: ${absolutePath}`);
    if (mode === 'strict') {
      log.fail('STRICT MODE: Missing packet = FAIL');
      return { status: 'INVALID', errors: ['Packet directory not found'], mode };
    } else if (mode === 'legacy') {
      log.warn('LEGACY MODE: No packet required');
      return { status: 'CONDITIONAL_PASS', warnings: ['No packet provided'], mode };
    } else {
      log.warn('ASSISTED MODE: Missing packet = INCOMPLETE');
      return { status: 'INCOMPLETE', warnings: ['Packet directory not found'], mode };
    }
  }

  // Check if it's a directory
  const stats = statSync(absolutePath);
  if (!stats.isDirectory()) {
    log.fail(`Packet path is not a directory: ${absolutePath}`);
    return { status: 'INVALID', errors: ['Path is not a directory'], mode };
  }

  log.info(`Validating: ${absolutePath}\n`);

  const result = {
    status: 'VALID',
    errors: [],
    warnings: [],
    missingFiles: [],
    missingFields: [],
    forensicFindings: [],
  };

  // Phase 1: Check required files exist
  log.section('Phase 1: File Structure Check');
  const missingFiles = checkRequiredFiles(absolutePath);
  result.missingFiles = missingFiles;

  if (missingFiles.length > 0) {
    for (const file of missingFiles) {
      log.fail(`Missing required file: ${file}`);
    }

    if (mode === 'strict') {
      result.status = 'INVALID';
      result.errors.push(...missingFiles.map(f => `Missing file: ${f}`));
      printResult(result);
      return result;
    } else if (mode === 'legacy') {
      result.status = 'CONDITIONAL_PASS';
      result.warnings.push(...missingFiles.map(f => `Missing file: ${f}`));
    } else {
      result.status = 'INCOMPLETE';
      result.warnings.push(...missingFiles.map(f => `Missing file: ${f}`));
    }
  } else {
    log.pass('All required files present');
  }

  // Phase 2: Validate metadata.json
  log.section('Phase 2: Metadata Validation');
  const metadataResult = validateMetadata(absolutePath);
  if (metadataResult.errors.length > 0) {
    result.errors.push(...metadataResult.errors);
  }
  if (metadataResult.warnings.length > 0) {
    result.warnings.push(...metadataResult.warnings);
  }

  // Phase 3: Validate evidence structure
  log.section('Phase 3: Evidence Validation');
  const evidenceResult = validateEvidence(absolutePath);
  if (evidenceResult.errors.length > 0) {
    result.errors.push(...evidenceResult.errors);
  }
  if (evidenceResult.warnings.length > 0) {
    result.warnings.push(...evidenceResult.warnings);
  }

  // Phase 4: Validate blockers structure
  log.section('Phase 4: Blockers Validation');
  const blockersResult = validateBlockers(absolutePath);
  if (blockersResult.errors.length > 0) {
    result.errors.push(...blockersResult.errors);
  }
  if (blockersResult.warnings.length > 0) {
    result.warnings.push(...blockersResult.warnings);
  }

  // Phase 5: Forensic analysis (if enabled)
  if (mode !== 'strict' || verbose) {
    log.section('Phase 5: Forensic Analysis');
    const forensicResult = runForensicAnalysis(absolutePath);
    result.forensicFindings = forensicResult.findings;
    if (forensicResult.findings.length > 0 && verbose) {
      for (const finding of forensicResult.findings) {
        log.warn(`[Forensic] ${finding.type}: ${finding.message}`);
      }
    }
  }

  // Determine final status
  if (result.errors.length > 0) {
    result.status = 'INVALID';
  } else if (result.missingFiles.length > 0 && mode === 'assisted') {
    result.status = 'INCOMPLETE';
  }

  printResult(result);
  return result;
}

/**
 * Check if required files exist
 */
function checkRequiredFiles(packetDir) {
  const missing = [];

  for (const file of REQUIRED_FILES) {
    const filePath = join(packetDir, file);
    if (!existsSync(filePath)) {
      missing.push(file);
    }
  }

  return missing;
}

/**
 * Validate metadata.json
 */
function validateMetadata(packetDir) {
  const result = { errors: [], warnings: [] };
  const metadataPath = join(packetDir, 'metadata.json');

  if (!existsSync(metadataPath)) {
    result.errors.push('metadata.json not found');
    return result;
  }

  try {
    const content = readFileSync(metadataPath, 'utf-8');
    const metadata = JSON.parse(content);

    // Check required fields
    for (const field of REQUIRED_METADATA_FIELDS) {
      if (!metadata[field]) {
        // Empty required field is a warning in assisted mode, error in strict mode
        if (mode === 'strict') {
          result.errors.push(`metadata.json missing required field: ${field}`);
        } else {
          result.warnings.push(`metadata.json missing required field: ${field}`);
        }
      }
    }

    // Validate packet_mode
    if (metadata.packet_mode && !['strict', 'assisted', 'legacy'].includes(metadata.packet_mode)) {
      result.warnings.push(`metadata.json packet_mode should be strict|assisted|legacy, got: ${metadata.packet_mode}`);
    }

    // Validate timestamps
    if (metadata.created_at) {
      const created = new Date(metadata.created_at);
      if (isNaN(created.getTime())) {
        result.warnings.push('metadata.json created_at is not a valid ISO8601 timestamp');
      }
    }

    if (metadata.updated_at) {
      const updated = new Date(metadata.updated_at);
      if (isNaN(updated.getTime())) {
        result.warnings.push('metadata.json updated_at is not a valid ISO8601 timestamp');
      }
    }

    if (result.errors.length === 0) {
      log.pass('metadata.json is valid');
    }

  } catch (e) {
    if (e instanceof SyntaxError) {
      result.errors.push('metadata.json is not valid JSON');
    } else {
      result.errors.push(`Failed to read metadata.json: ${e.message}`);
    }
  }

  return result;
}

/**
 * Validate evidence.md structure
 */
function validateEvidence(packetDir) {
  const result = { errors: [], warnings: [] };
  const evidencePath = join(packetDir, 'evidence.md');

  if (!existsSync(evidencePath)) {
    result.errors.push('evidence.md not found');
    return result;
  }

  try {
    const content = readFileSync(evidencePath, 'utf-8');

    // Check for commands_executed section
    if (!content.includes('commands_executed') && !content.includes('Commands Executed')) {
      result.warnings.push('evidence.md missing commands_executed section');
    }

    // Check for test_results section
    if (!content.includes('test_results') && !content.includes('Test Results')) {
      result.warnings.push('evidence.md missing test_results section');
    }

    // Check for build_results section
    if (!content.includes('build_results') && !content.includes('Build Results')) {
      result.warnings.push('evidence.md missing build_results section');
    }

    // Check for known_gaps section
    if (!content.includes('known_gaps') && !content.includes('Known Gaps')) {
      result.warnings.push('evidence.md missing known_gaps section (optional but recommended)');
    }

    // Check for command output indicators
    const hasCommandOutput = content.includes('exit_code') || content.includes('Exit Code') ||
                           content.includes('output_summary') || content.includes('Output Summary');
    if (!hasCommandOutput) {
      result.warnings.push('evidence.md commands may be missing exit_code or output_summary');
    }

    // Basic content check
    if (content.length < 200) {
      result.warnings.push('evidence.md content seems too short, may be placeholder');
    }

    if (result.errors.length === 0 && result.warnings.length === 0) {
      log.pass('evidence.md structure is valid');
    }

  } catch (e) {
    result.errors.push(`Failed to read evidence.md: ${e.message}`);
  }

  return result;
}

/**
 * Validate blockers.md structure
 */
function validateBlockers(packetDir) {
  const result = { errors: [], warnings: [] };
  const blockersPath = join(packetDir, 'blockers.md');

  if (!existsSync(blockersPath)) {
    result.errors.push('blockers.md not found');
    return result;
  }

  try {
    const content = readFileSync(blockersPath, 'utf-8');

    // Check for P0 blockers section
    const hasP0Section = content.includes('p0_blockers') || content.includes('P0') ||
                        content.includes('p0_') || content.match(/##.*P0/i);
    if (!hasP0Section) {
      result.warnings.push('blockers.md missing P0 blockers section');
    }

    // Check for P1 blockers section
    const hasP1Section = content.includes('p1_blockers') || content.includes('P1') ||
                        content.includes('p1_') || content.match(/##.*P1/i);
    if (!hasP1Section) {
      result.warnings.push('blockers.md missing P1 blockers section');
    }

    // Check for status indicators
    const hasStatus = content.includes('status') || content.includes('Status') ||
                     content.includes('OPEN') || content.includes('RESOLVED');
    if (!hasStatus) {
      result.warnings.push('blockers.md missing status indicators');
    }

    // Check if P0 is closed if present
    if (content.match(/P0.*OPEN|open.*P0/i)) {
      if (mode === 'strict') {
        result.errors.push('P0 blocker is OPEN - immediate fail in strict mode');
      } else {
        result.warnings.push('P0 blocker is OPEN');
      }
    }

    if (result.errors.length === 0) {
      log.pass('blockers.md structure is valid');
    }

  } catch (e) {
    result.errors.push(`Failed to read blockers.md: ${e.message}`);
  }

  return result;
}

/**
 * Run forensic analysis to find contradictions
 * Note: This is for finding contradictions, NOT for fixing missing evidence
 */
function runForensicAnalysis(packetDir) {
  const findings = [];

  // Check git status for actual changes
  try {
    const gitStatus = require('child_process').execSync(
      'git status --short 2>/dev/null || echo ""',
      { encoding: 'utf-8', cwd: PROJECT_ROOT, timeout: 5000 }
    ).trim();

    if (!gitStatus) {
      findings.push({
        type: 'CLEAN_WORKING_TREE',
        message: 'Working tree is clean, no uncommitted changes found',
        severity: 'INFO',
      });
    } else {
      findings.push({
        type: 'UNCOMMITTED_CHANGES',
        message: 'Working tree has uncommitted changes',
        severity: 'INFO',
      });
    }
  } catch (e) {
    findings.push({
      type: 'GIT_NOT_AVAILABLE',
      message: 'Git not available for forensic analysis',
      severity: 'WARNING',
    });
  }

  // Check if diff-summary matches actual diff
  const diffSummaryPath = join(packetDir, 'diff-summary.md');
  if (existsSync(diffSummaryPath)) {
    const diffSummary = readFileSync(diffSummaryPath, 'utf-8');

    // Check if diff-summary claims breaking changes
    if (diffSummary.match(/breaking_changes:\s*true|breaking:\s*true/i)) {
      findings.push({
        type: 'BREAKING_CHANGES_CLAIMED',
        message: 'diff-summary.md claims breaking changes - verify if intentional',
        severity: 'WARNING',
      });
    }
  }

  // Check evidence timestamps
  const evidencePath = join(packetDir, 'evidence.md');
  if (existsSync(evidencePath)) {
    const evidence = readFileSync(evidencePath, 'utf-8');

    // Check for timestamp presence
    if (!evidence.match(/\d{4}-\d{2}-\d{2}|\d{2}:\d{2}:\d{2}/)) {
      findings.push({
        type: 'NO_TIMESTAMPS_IN_EVIDENCE',
        message: 'evidence.md does not contain timestamps',
        severity: 'WARNING',
      });
    }
  }

  return { findings };
}

/**
 * Print validation result
 */
function printResult(result) {
  console.log('');
  log.title('VALIDATION RESULT');

  const statusColors = {
    'VALID': c.green,
    'INVALID': c.red,
    'INCOMPLETE': c.yellow,
    'CONDITIONAL_PASS': c.cyan,
  };

  const statusColor = statusColors[result.status] || c.reset;
  console.log(`${c.bright}Status: ${statusColor}${result.status}${c.reset}\n`);

  if (result.errors.length > 0) {
    log.section('Errors (Blocking)');
    for (const error of result.errors) {
      log.fail(error);
    }
  }

  if (result.warnings.length > 0) {
    log.section('Warnings');
    for (const warning of result.warnings) {
      log.warn(warning);
    }
  }

  if (result.missingFiles.length > 0) {
    log.section('Missing Files');
    for (const file of result.missingFiles) {
      log.fail(file);
    }
  }

  if (result.forensicFindings.length > 0 && verbose) {
    log.section('Forensic Findings');
    for (const finding of result.forensicFindings) {
      console.log(`  ${finding.type}: ${finding.message}`);
    }
  }

  // Print next steps
  console.log('');
  if (result.status === 'VALID') {
    log.pass('Packet is ready for review');
    console.log(`  Proceed with: node review-gate.mjs --profile release-gate --packet "${packetPath}"`);
  } else if (result.status === 'INCOMPLETE') {
    log.warn('Packet is incomplete but acceptable in assisted mode');
    console.log(`  Executor should complete the packet before release-gate`);
  } else if (result.status === 'CONDITIONAL_PASS') {
    log.warn('Legacy mode - packet not required');
    console.log(`  Max verdict available: CONDITIONAL_PASS`);
    console.log(`  Recommendation: Provide a complete Delivery Packet`);
  } else {
    log.fail('Packet validation failed');
    console.log(`  Fix the errors above before proceeding`);
  }
}

/**
 * Exit code mapping
 */
function getExitCode(status) {
  switch (status) {
    case 'VALID': return 0;
    case 'INVALID': return 1;
    case 'INCOMPLETE': return 2;
    case 'CONDITIONAL_PASS': return 3;
    default: return 1;
  }
}

// Run validation
const result = validate();
process.exit(getExitCode(result.status));
