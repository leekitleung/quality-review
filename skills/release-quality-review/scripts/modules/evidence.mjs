import { createHash } from 'node:crypto';
import { dirname, extname, join, resolve } from 'path';
import { existsSync, readFileSync, statSync } from 'fs';
import { readFile } from 'fs/promises';
import { execSync, execFileSync } from 'child_process';
import { log } from './constants.mjs';
import { ensureContainedDirectorySync, readContainedFileSync, writeContainedFile, writeContainedFileSync, containsSensitiveText, redactSensitiveText } from '../../lib/security-utils.mjs';
import { findTrivialVerificationScripts } from '../../lib/review-utils.mjs';
import { createCandidateRuntime } from '../../lib/candidate-runtime.mjs';

/**
 * Collect evidence for the current review round
 * @param {object} config - Config object
 * @param {string} projectRoot - Project root directory
 * @param {string} diffBase - Git reference for diff
 * @param {string} resolvedDiffBase - Resolved diff base
 * @param {string} skillDir - Skill directory
 * @returns {object} Collected evidence
 */
export function collectEvidence(config, projectRoot, diffBase, resolvedDiffBase, skillDir) {
  log.info('Collecting evidence...');

  const evidence = {
    timestamp: new Date().toISOString(),
    git: {},
    files: {},
    automatedChecks: {},
  };

  // Git info
  try {
    evidence.git = {
      branch: execSync('git branch --show-current 2>/dev/null || echo ""', { encoding: 'utf-8' }).trim(),
      commit: execSync('git rev-parse HEAD 2>/dev/null || echo ""', { encoding: 'utf-8' }).trim().substring(0, 8),
      status: execSync('git status --short 2>/dev/null || echo ""', { encoding: 'utf-8' }).trim(),
      diff: execFileSync('git', ['diff', '--stat', resolvedDiffBase], { encoding: 'utf-8' }).trim(),
    };
  } catch (e) {
    log.warn('Could not collect git evidence');
  }

  if (evidence.git.status !== '') {
    throw new Error('source checkout must be clean before evidence collection');
  }

  // Package info
  try {
    const packageJson = join(projectRoot, 'package.json');
    if (existsSync(packageJson)) {
      const pkg = JSON.parse(readFileSync(packageJson, 'utf-8'));
      evidence.files.package = {
        name: pkg.name,
        version: pkg.version,
        scripts: Object.keys(pkg.scripts || {}),
      };
    }
  } catch (e) {
    // Ignore
  }

  // Automated checks with config - create candidate runtime inline
  const { prepareCheckout, readIdentity } = createCandidateRuntime(projectRoot, 'gate');
  const candidateRoot = prepareCheckout();
  readIdentity(candidateRoot); // Validate checkout identity
  evidence.automatedChecks = runAutomatedChecks(config, projectRoot, candidateRoot);

  return evidence;
}

/**
 * Validate evidence completeness
 * @param {object} evidence - Evidence object
 * @param {string} projectRoot - Project root
 * @returns {boolean} Whether evidence is complete
 */
export function validateEvidenceCompleteness(evidence, projectRoot) {
  if (!evidence) return false;

  // Check required fields
  if (!evidence.timestamp) return false;
  if (!evidence.git?.commit) return false;

  // Check automated checks structure
  const ac = evidence.automatedChecks;
  if (!ac) return false;

  // Required gate commands must have valid structure
  const requiredGates = ['testGate', 'typecheckGate', 'buildGate', 'lintGate', 'auditGate'];
  for (const gate of requiredGates) {
    const gateResult = ac[gate];
    if (!gateResult) return false;
    if (!['pass', 'fail'].includes(gateResult.status)) return false;
    if (typeof gateResult.exit_code !== 'number') return false;
    if (!gateResult.started_at || !gateResult.finished_at) return false;
    if (gateResult.status === 'pass' && gateResult.exit_code !== 0) return false;
  }

  // Check secrets and circular deps
  if (!['pass', 'warn'].includes(ac.secrets?.status)) return false;
  if (!['pass', 'fail', 'warn'].includes(ac.circularDeps?.status)) return false;

  return true;
}

/**
 * Evidence command runner
 * @param {string} cmd - Command to run
 * @param {string} cwd - Working directory
 * @returns {object} Evidence record
 */
export function runEvidenceCommand(cmd, cwd) {
  const started = new Date();
  try {
    const output = execSync(cmd, { cwd, encoding: 'utf-8', timeout: 30000 });
    const finished = new Date();
    const outputBytes = Buffer.byteLength(output, 'utf8');
    return {
      command: cmd,
      status: 'pass',
      exit_code: 0,
      output,
      output_bytes: outputBytes,
      truncated: false,
      started_at: started.toISOString(),
      finished_at: finished.toISOString(),
    };
  } catch (e) {
    const finished = new Date();
    const output = e.stdout + (e.stderr || '');
    const outputBytes = Buffer.byteLength(output, 'utf8');
    return {
      command: cmd,
      status: 'fail',
      exit_code: e.status || -1,
      output,
      output_bytes: outputBytes,
      truncated: e.stdout ? Buffer.byteLength(e.stdout, 'utf8') > 100000 : false,
      started_at: started.toISOString(),
      finished_at: finished.toISOString(),
    };
  }
}

/**
 * Redact sensitive text from evidence
 * @param {string} value - Text to redact
 * @returns {string} Redacted text
 */
export function redactEvidence(value) {
  return redactSensitiveText(value);
}

/**
 * Validate command evidence structure
 * @param {object} record - Command record
 * @param {string} expectedCommand - Expected command
 * @returns {boolean} Whether evidence is valid
 */
export function validCommandEvidence(record, expectedCommand) {
  const started = Date.parse(record?.started_at);
  const finished = Date.parse(record?.finished_at);
  const retainedBytes = Buffer.byteLength(record?.output || '', 'utf8');
  return record && record.command === expectedCommand &&
    typeof record.started_at === 'string' && typeof record.finished_at === 'string' &&
    Number.isFinite(started) && Number.isFinite(finished) && finished >= started &&
    Number.isInteger(record.exit_code) && ['pass', 'fail'].includes(record.status) &&
    (record.status === 'pass') === (record.exit_code === 0) &&
    typeof record.output === 'string' && Number.isInteger(record.output_bytes) &&
    record.output_bytes >= retainedBytes && typeof record.truncated === 'boolean' &&
    (record.truncated || record.output_bytes === retainedBytes);
}

/**
 * Validate candidate checkout evidence
 * @param {object} record - Checkout record
 * @param {string} expectedCommit - Expected commit
 * @param {string} expectedTree - Expected tree
 * @returns {boolean} Whether evidence is valid
 */
export function validCandidateCheckoutEvidence(record, expectedCommit, expectedTree) {
  return record?.status === 'pass' && record.source_commit === expectedCommit && record.source_tree === expectedTree &&
    record.initial?.commit === expectedCommit && record.initial?.tree === expectedTree && record.initial?.status === '' &&
    record.final?.commit === expectedCommit && record.final?.tree === expectedTree && record.final?.status === '';
}

/**
 * Scan for circular dependencies in scripts/skills
 * @param {string} projectRoot - Project root directory
 * @returns {string[]} List of circular dependency paths
 */
export function scanCircularDependencies(projectRoot) {
  const tracked = execFileSync('git', ['ls-files', 'skills', 'scripts'], {
    cwd: projectRoot,
    encoding: 'utf8',
    timeout: 30000,
  }).trim().split('\n').filter(file => /\.(?:js|mjs|ts)$/.test(file));
  const files = new Set(tracked.map(file => resolve(projectRoot, file)));
  const graph = new Map();
  for (const file of files) {
    const content = readFileSync(file, 'utf8');
    const dependencies = [];
    const importPattern = /(?:import|export)\s+(?:[^'\";]+?\s+from\s+)?['"](\.[^'\"]+)['"]|import\(\s*['"](\.[^'\"]+)['"]\s*\)/g;
    for (const match of content.matchAll(importPattern)) {
      const specifier = match[1] || match[2];
      const base = resolve(dirname(file), specifier);
      const candidates = extname(base)
        ? [base]
        : [base, `${base}.js`, `${base}.mjs`, `${base}.ts`, join(base, 'index.js'), join(base, 'index.mjs'), join(base, 'index.ts')];
      const dependency = candidates.find(candidate => files.has(candidate));
      if (dependency) dependencies.push(dependency);
    }
    graph.set(file, dependencies);
  }

  const visiting = new Set();
  const visited = new Set();
  const cycles = [];
  function visit(file, trail) {
    if (visiting.has(file)) {
      const start = trail.indexOf(file);
      cycles.push([...trail.slice(start), file].map(item => item.slice(projectRoot.length + 1)).join(' --> '));
      return;
    }
    if (visited.has(file)) return;
    visiting.add(file);
    for (const dependency of graph.get(file) || []) visit(dependency, [...trail, file]);
    visiting.delete(file);
    visited.add(file);
  }
  for (const file of files) visit(file, []);
  return [...new Set(cycles)];
}

/**
 * Run automated gate checks
 * @param {object} config - Config object
 * @param {string} projectRoot - Project root directory
 * @param {string} candidateRoot - Candidate checkout root
 * @returns {object} Automated check results
 */
export function runAutomatedChecks(config, projectRoot, candidateRoot) {
  const checks = {
    oversizedFiles: { status: 'pass', issues: [] },
    circularDeps: { status: 'pass', issues: [] },
    secrets: { status: 'pass', issues: [] },
    testGate: null,
    typecheckGate: null,
    buildGate: null,
    lintGate: null,
    auditGate: null,
    coverageGate: null,
    candidateCheckout: null,
  };

  const testCmd = config?.verification?.test || 'pnpm test';
  const typecheckCmd = config?.verification?.typecheck || 'pnpm typecheck';
  const buildCmd = config?.verification?.build || 'pnpm build';
  const lintCmd = config?.verification?.lint || 'pnpm lint';
  const auditCmd = config?.verification?.audit || 'npm audit --audit-level=high';
  const coverageCmd = config?.verification?.coverage || 'npm run coverage';
  const manifest = JSON.parse(readFileSync(join(candidateRoot, 'package.json'), 'utf8'));
  const scriptIssues = findTrivialVerificationScripts(manifest.scripts, [
    testCmd, typecheckCmd, buildCmd, lintCmd, coverageCmd,
  ]);
  if (scriptIssues.length > 0) {
    throw new Error(`trivial or missing verification scripts: ${scriptIssues.map(issue => issue.script).join(', ')}`);
  }

  // Check 1: Oversized files (>2000 lines)
  log.info('Checking for oversized files...');
  try {
    const output = execSync(
      'find skills scripts .claude .agents -type f \\( -name "*.ts" -o -name "*.js" -o -name "*.mjs" \\) -exec wc -l {} + 2>/dev/null | sort -rn | head -20',
      { encoding: 'utf-8', cwd: projectRoot, timeout: 30000 }
    );
    const lines = output.trim().split('\n');
    for (const line of lines) {
      const match = line.trim().match(/^\s*(\d+)\s+(.+)$/);
      if (match) {
        const [count, path] = [parseInt(match[1], 10), match[2]];
        if (path !== 'total' && count > 2000) {
          checks.oversizedFiles.issues.push({ path, lines: count });
          checks.oversizedFiles.status = 'warn';
        }
      }
    }
  } catch (e) {
    log.warn('Could not check file sizes');
  }

  // Check 2: Circular dependencies
  log.info('Checking for circular dependencies...');
  try {
    const cycles = scanCircularDependencies(projectRoot);
    if (cycles.length > 0) {
      checks.circularDeps.status = 'fail';
      checks.circularDeps.issues = cycles;
    }
  } catch (e) {
    checks.circularDeps.status = 'fail';
    checks.circularDeps.issues = [`circular dependency scan failed: ${e.message}`];
  }

  // Check 3: Secrets in source
  log.info('Checking for secrets in source...');
  try {
    const tracked = execFileSync('git', ['ls-files'], { encoding: 'utf-8', cwd: projectRoot }).trim().split('\n');
    const untracked = execFileSync('git', ['ls-files', '--others', '--exclude-standard'], { encoding: 'utf-8', cwd: projectRoot }).trim().split('\n');
    const candidates = [...new Set([...tracked, ...untracked])].filter(file =>
      file && !/(^|\/)(__tests__|fixtures|node_modules|quality-reports)(\/|$)/.test(file)
    );
    for (const file of candidates) {
      const absolute = join(projectRoot, file);
      if (!existsSync(absolute) || statSync(absolute).isDirectory()) continue;
      const content = readFileSync(absolute, 'utf8');
      if (containsSensitiveText(content)) checks.secrets.issues.push(`${file}:[REDACTED]`);
      if (checks.secrets.issues.length >= 10) break;
    }
    if (checks.secrets.issues.length > 0) {
      checks.secrets.status = 'fail';
    }
  } catch (e) {
    checks.secrets.status = 'fail';
    checks.secrets.issues = ['source scan failed closed'];
  }

  // Gate commands
  log.info(`Running test gate: ${testCmd}`);
  checks.testGate = runEvidenceCommand(testCmd, candidateRoot);

  log.info(`Running typecheck gate: ${typecheckCmd}`);
  checks.typecheckGate = runEvidenceCommand(typecheckCmd, candidateRoot);

  log.info(`Running build gate: ${buildCmd}`);
  checks.buildGate = runEvidenceCommand(buildCmd, candidateRoot);

  log.info(`Running lint gate: ${lintCmd}`);
  checks.lintGate = runEvidenceCommand(lintCmd, candidateRoot);

  log.info(`Running audit gate: ${auditCmd}`);
  checks.auditGate = runEvidenceCommand(auditCmd, candidateRoot);

  return checks;
}

/**
 * Persist evidence to round directory
 * @param {string} projectRoot - Project root directory
 * @param {string} roundDir - Round directory
 * @param {object} evidence - Evidence object
 * @param {string} profileName - Profile name
 * @param {number} roundNumber - Round number
 * @param {object} reviewers - List of reviewers
 * @param {string} resolvedDiffBase - Resolved diff base
 * @returns {Promise<void>}
 */
export async function persistEvidence(projectRoot, roundDir, evidence, profileName, roundNumber, reviewers, resolvedDiffBase) {
  const evidenceDir = join(roundDir, 'evidence');
  ensureContainedDirectorySync(projectRoot, evidenceDir);
  const automatedContent = `${JSON.stringify(evidence.automatedChecks, null, 2)}\n`;
  const cleanCandidatePath = join(evidenceDir, 'clean-candidate.json');
  const cleanCandidateContent = existsSync(cleanCandidatePath)
    ? readContainedFileSync(roundDir, cleanCandidatePath, 'utf8')
    : null;
  const rollbackPath = join(evidenceDir, 'rollback-verification.json');
  const rollbackContent = existsSync(rollbackPath)
    ? readContainedFileSync(roundDir, rollbackPath, 'utf8')
    : null;
  const candidateCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: projectRoot, encoding: 'utf8' }).trim();
  const candidateTree = execFileSync('git', ['rev-parse', 'HEAD^{tree}'], { cwd: projectRoot, encoding: 'utf8' }).trim();
  const baseCommit = execFileSync('git', ['rev-parse', `${resolvedDiffBase}^{commit}`], { cwd: projectRoot, encoding: 'utf8' }).trim();
  const baseTree = execFileSync('git', ['rev-parse', `${resolvedDiffBase}^{tree}`], { cwd: projectRoot, encoding: 'utf8' }).trim();

  const metadata = {
    profile: profileName,
    round: roundNumber,
    reviewers,
    collected_at: evidence.timestamp,
    git: evidence.git,
    files: evidence.files,
    candidate_commit: candidateCommit,
    candidate_tree: candidateTree,
    base_commit: baseCommit,
    base_tree: baseTree,
    automated_checks_sha256: createHash('sha256').update(automatedContent).digest('hex'),
    clean_candidate_sha256: cleanCandidateContent === null
      ? null
      : createHash('sha256').update(cleanCandidateContent).digest('hex'),
    rollback_verification_sha256: rollbackContent === null
      ? null
      : createHash('sha256').update(rollbackContent).digest('hex'),
  };

  await writeContainedFile(projectRoot, join(evidenceDir, 'automated-checks.json'), automatedContent);
  await writeContainedFile(projectRoot, join(roundDir, 'metadata.json'), `${JSON.stringify(metadata, null, 2)}\n`);
}

/**
 * Collect reviewer packet digests for final arbitration
 * @param {string} projectRoot - Project root directory
 * @param {string} roundDir - Round directory
 * @param {string[]} packetReviewers - List of reviewers
 * @returns {object} Digest map
 */
export function collectReviewerPacketDigests(projectRoot, roundDir, packetReviewers) {
  const requiredFiles = ['result.yaml', 'score.md', 'blockers.md', 'improvement-list.md'];
  const digests = {};
  for (const reviewer of packetReviewers) {
    const reviewerDir = join(roundDir, reviewer);
    const paths = requiredFiles.map(file => join(reviewerDir, file));
    if (!paths.every(existsSync)) continue;
    try {
      const hash = createHash('sha256');
      for (let index = 0; index < requiredFiles.length; index++) {
        const content = readContainedFileSync(roundDir, paths[index]);
        hash.update(`${requiredFiles[index]}\0${Buffer.byteLength(content)}\0`);
        hash.update(content);
      }
      digests[reviewer] = hash.digest('hex');
    } catch {
      digests[reviewer] = null;
    }
  }
  return digests;
}

/**
 * Persist final arbitration record
 * @param {string} roundDir - Round directory
 * @param {boolean} passed - Whether gate passed
 * @param {string} reason - Reason for result
 * @param {string[]} packetReviewers - List of reviewers
 * @param {string[]} argv - Process argv
 */
export function persistFinalArbitration(roundDir, passed, reason, packetReviewers, argv) {
  const projectRoot = join(roundDir, '..', '..');
  const evidenceDir = join(roundDir, 'evidence');
  ensureContainedDirectorySync(projectRoot, evidenceDir);
  const record = {
    command: redactSensitiveText(['node', ...argv.slice(1)].join(' ')),
    recorded_at: new Date().toISOString(),
    profile: undefined, // Will be set by caller
    round: undefined, // Will be set by caller
    status: passed ? 'pass' : 'fail',
    exit_code: passed ? 0 : 1,
    reason,
    candidate_commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: projectRoot, encoding: 'utf8' }).trim(),
    candidate_tree: execFileSync('git', ['rev-parse', 'HEAD^{tree}'], { cwd: projectRoot, encoding: 'utf8' }).trim(),
    reviewer_packet_sha256: collectReviewerPacketDigests(projectRoot, roundDir, packetReviewers),
  };
  const content = `${JSON.stringify(record, null, 2)}\n`;
  if (containsSensitiveText(content)) throw new Error('final arbitration contains sensitive text');
  writeContainedFileSync(roundDir, join(evidenceDir, 'final-arbitration.json'), content);
}
