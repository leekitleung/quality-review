#!/usr/bin/env node
/**
 * Baseline Collector
 *
 * Collects baseline metrics before running optimization experiments.
 * This establishes the "before" state to measure improvement against.
 *
 * Supports dual orchestrator ecosystems:
 * - Claude: Opus 4.8 orchestrator, Claude Code executor
 * - Codex: sol (GPT-5.6) orchestrator, Codex CLI executor
 *
 * Usage:
 *   node baseline-collector.mjs --profile project-quality [--output ./experiment-logs]
 *   ORCHESTRATOR=codex node baseline-collector.mjs --profile codex-sol-orchestrated
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

// Use process.cwd() as the reliable project root
const PROJECT_ROOT = process.cwd();

// ============================================================
// Orchestrator Environment Detection
// ============================================================

/**
 * Detect which orchestrator ecosystem we're running in.
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
  if (process.env.ORCHESTRATOR_MODEL) {
    return process.env.ORCHESTRATOR_MODEL;
  }

  const models = {
    claude: 'opus-4-8',
    codex: 'sol',  // GPT-5.6 flagship model
  };

  return models[orchestrator] || models.claude;
}

// Detect environment
const ORCHESTRATOR = detectOrchestrator();
const ORCHESTRATOR_MODEL = getOrchestratorModel(ORCHESTRATOR);

console.log('=== Dual Orchestrator Environment ===');
console.log(`Orchestrator: ${ORCHESTRATOR}`);
console.log(`Model: ${ORCHESTRATOR_MODEL}`);
console.log('');

// Parse arguments
const args = process.argv.slice(2);
let profile = 'project-quality';
let outputDir = 'experiment-logs';

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--profile' && args[i + 1]) {
    profile = args[i + 1];
    i++;
  } else if (args[i] === '--output' && args[i + 1]) {
    outputDir = args[i + 1];
    i++;
  }
}

// Shared metrics/sources for project-quality base profile
const PROJECT_QUALITY_METRICS = [
  'test-coverage',
  'lint-errors',
  'type-errors',
  'documentation-coverage',
  'cli-usability',
  'security-posture',
  'architecture-score',
];
const PROJECT_QUALITY_SOURCES = ['"apps/*/src/**/*.ts"', '"packages/*/src/**/*.ts"', '"*.md"'];

// Profiles define what metrics to collect
const PROFILES = {
  'skill-quality': {
    metrics: ['instruction-clarity', 'example-coverage', 'workflow-completeness', 'scope-accuracy'],
    sources: ['"skills/*/SKILL.md"'],
  },
  'project-quality': {
    metrics: PROJECT_QUALITY_METRICS,
    sources: PROJECT_QUALITY_SOURCES,
  },
  'codex-sol-orchestrated': {
    orchestrator: 'codex',
    orchestratorModel: 'sol',
    metrics: PROJECT_QUALITY_METRICS,
    sources: PROJECT_QUALITY_SOURCES,
  },
  'claude-opus-orchestrated': {
    orchestrator: 'claude',
    orchestratorModel: 'opus-4-8',
    metrics: PROJECT_QUALITY_METRICS,
    sources: PROJECT_QUALITY_SOURCES,
  },
};

const config = PROFILES[profile] || PROFILES['project-quality'];

/**
 * Collect baseline metrics for a given profile
 */
async function collectBaseline() {
  console.log('=== Baseline Collector ===');
  console.log(`Profile: ${profile}`);
  console.log(`Output: ${outputDir}`);
  console.log(`Orchestrator: ${ORCHESTRATOR} (${ORCHESTRATOR_MODEL})`);
  console.log('');

  const timestamp = new Date().toISOString();
  const baseline = {
    profile,
    orchestrator: ORCHESTRATOR,
    orchestratorModel: ORCHESTRATOR_MODEL,
    timestamp,
    metrics: {},
    sources: config.sources,
  };

  // Test coverage
  if (config.metrics.includes('test-coverage')) {
    baseline.metrics.testCoverage = await measureTestCoverage();
  }

  // Lint errors
  if (config.metrics.includes('lint-errors')) {
    baseline.metrics.lintErrors = await measureLintErrors();
  }

  // Type errors
  if (config.metrics.includes('type-errors')) {
    baseline.metrics.typeErrors = await measureTypeErrors();
  }

  // Documentation coverage
  if (config.metrics.includes('documentation-coverage')) {
    baseline.metrics.documentationCoverage = await measureDocumentationCoverage();
  }

  // CLI usability (check if --help works)
  if (config.metrics.includes('cli-usability')) {
    baseline.metrics.cliUsability = await measureCliUsability();
  }

  // Security posture (basic checks)
  if (config.metrics.includes('security-posture')) {
    baseline.metrics.securityPosture = await measureSecurityPosture();
  }

  // Architecture score (file organization)
  if (config.metrics.includes('architecture-score')) {
    baseline.metrics.architectureScore = await measureArchitectureScore();
  }

  // Skill-specific metrics
  if (config.metrics.includes('instruction-clarity')) {
    baseline.metrics.instructionClarity = await measureInstructionClarity();
  }

  if (config.metrics.includes('example-coverage')) {
    baseline.metrics.exampleCoverage = await measureExampleCoverage();
  }

  if (config.metrics.includes('workflow-completeness')) {
    baseline.metrics.workflowCompleteness = await measureWorkflowCompleteness();
  }

  if (config.metrics.includes('scope-accuracy')) {
    baseline.metrics.scopeAccuracy = await measureScopeAccuracy();
  }

  // Save baseline
  const baselineFile = join(outputDir, 'baseline.yaml');
  const baselineYaml = toYaml(baseline);
  writeFileSync(baselineFile, baselineYaml);

  console.log('');
  console.log('=== Baseline Metrics ===');
  for (const [key, value] of Object.entries(baseline.metrics)) {
    console.log(`  ${key}: ${JSON.stringify(value)}`);
  }
  console.log('');
  console.log(`Baseline saved to: ${baselineFile}`);
  console.log('');
  console.log('Next step: Run experiment-runner.mjs to start optimization experiments.');

  return baseline;
}

/**
 * Measure test coverage (simplified)
 */
async function measureTestCoverage() {
  try {
    // Run tests with coverage
    const result = execSync('npm test -- --coverage 2>&1 || true', { encoding: 'utf-8', timeout: 60000 });

    // Parse coverage from output (simplified)
    const coverageMatch = result.match(/All files[^}]+?\s+([\d.]+)%/);
    if (coverageMatch) {
      return { value: parseFloat(coverageMatch[1]), unit: '%' };
    }

    // Count test files
    const testCount = execSync('find . -name "*.test.ts" | wc -l', { encoding: 'utf-8', shell: 'bash' }).trim();
    return { value: parseInt(testCount), unit: 'files', note: 'test file count' };
  } catch {
    return { value: 0, unit: 'unknown', note: 'could not measure' };
  }
}

/**
 * Measure lint errors
 */
async function measureLintErrors() {
  try {
    const result = execSync('npm run lint 2>&1 || true', { encoding: 'utf-8', timeout: 30000 });

    // Count error lines
    const errorLines = result.split('\n').filter(line => line.includes('error'));
    return { value: errorLines.length, unit: 'errors' };
  } catch {
    return { value: -1, unit: 'unknown', note: 'lint command failed' };
  }
}

/**
 * Measure type errors
 */
async function measureTypeErrors() {
  try {
    const result = execSync('npm run typecheck 2>&1 || true', { encoding: 'utf-8', timeout: 30000 });

    // Check for error count
    const errorMatch = result.match(/Found (\d+) error/);
    if (errorMatch) {
      return { value: parseInt(errorMatch[1]), unit: 'errors' };
    }

    // Check if clean
    if (result.includes('Found 0 error')) {
      return { value: 0, unit: 'errors' };
    }

    return { value: -1, unit: 'unknown', note: 'could not parse' };
  } catch {
    return { value: -1, unit: 'unknown', note: 'typecheck command failed' };
  }
}

/**
 * Measure documentation coverage
 */
async function measureDocumentationCoverage() {
  try {
    // Count README and doc files
    const readmeCount = execSync('find . -maxdepth 3 -name "README.md" -o -name "CHANGELOG.md" | wc -l', { encoding: 'utf-8', shell: 'bash' }).trim();
    const docsCount = execSync('find docs -name "*.md" 2>/dev/null | wc -l', { encoding: 'utf-8', shell: 'bash' }).trim();

    // Count code files that should have docs
    const srcCount = execSync('find apps packages -name "*.ts" -not -path "*/node_modules/*" | wc -l', { encoding: 'utf-8', shell: 'bash' }).trim();

    return {
      value: parseInt(readmeCount) + parseInt(docsCount),
      unit: 'files',
      detail: { readme: parseInt(readmeCount), docs: parseInt(docsCount), src: parseInt(srcCount) },
    };
  } catch {
    return { value: 0, unit: 'unknown' };
  }
}

/**
 * Measure CLI usability
 */
async function measureCliUsability() {
  try {
    // Test if --help works
    let helpWorks = false;
    try {
      execSync('npm run --help 2>&1', { encoding: 'utf-8', timeout: 5000 });
      helpWorks = true;
    } catch {}

    // Check for package.json scripts
    const pkg = JSON.parse(readFileSync('package.json', 'utf-8'));
    const scriptCount = Object.keys(pkg.scripts || {}).length;

    return {
      value: scriptCount,
      unit: 'scripts',
      helpWorks,
      detail: { scripts: Object.keys(pkg.scripts || {}) },
    };
  } catch {
    return { value: 0, unit: 'unknown' };
  }
}

/**
 * Measure security posture (basic checks)
 */
async function measureSecurityPosture() {
  try {
    // Check for sensitive file patterns
    const hasEnvExample = existsSync('.env.example');
    const hasEnvGitignored = execSync('cat .gitignore 2>/dev/null | grep -c "\\.env" || echo 0', { encoding: 'utf-8', shell: 'bash' }).trim();
    const hasSecurityHeaders = existsSync('docs/security-policy.md');

    // Check package.json for security-related scripts
    const pkg = JSON.parse(readFileSync('package.json', 'utf-8'));
    const hasAudit = pkg.scripts?.audit !== undefined;

    return {
      value: (hasEnvExample ? 1 : 0) + (parseInt(hasEnvGitignored) > 0 ? 1 : 0) + (hasSecurityHeaders ? 1 : 0) + (hasAudit ? 1 : 0),
      unit: 'checks',
      detail: { envExample: hasEnvExample, envGitignored: parseInt(hasEnvGitignored) > 0, securityDoc: hasSecurityHeaders, auditScript: hasAudit },
    };
  } catch {
    return { value: 0, unit: 'unknown' };
  }
}

/**
 * Measure architecture score (file organization)
 */
async function measureArchitectureScore() {
  try {
    // Count files in proper directories
    const appsCount = execSync('find apps -type f -name "*.ts" | wc -l', { encoding: 'utf-8', shell: 'bash' }).trim();
    const packagesCount = execSync('find packages -type f -name "*.ts" | wc -l', { encoding: 'utf-8', shell: 'bash' }).trim();
    const testsCount = execSync('find tests -type f -name "*.ts" | wc -l', { encoding: 'utf-8', shell: 'bash' }).trim();
    const docsCount = execSync('find docs -type f -name "*.md" | wc -l', { encoding: 'utf-8', shell: 'bash' }).trim();

    const total = parseInt(appsCount) + parseInt(packagesCount) + parseInt(testsCount) + parseInt(docsCount);
    const separationScore = total > 0 ? Math.round((parseInt(testsCount) + parseInt(docsCount)) / total * 100) : 0;

    return {
      value: separationScore,
      unit: '%',
      detail: { apps: parseInt(appsCount), packages: parseInt(packagesCount), tests: parseInt(testsCount), docs: parseInt(docsCount) },
    };
  } catch {
    return { value: 0, unit: 'unknown' };
  }
}

/**
 * Measure instruction clarity for skills
 */
async function measureInstructionClarity() {
  try {
    const skillFiles = execSync('find skills -name "SKILL.md" 2>/dev/null', { encoding: 'utf-8', shell: 'bash' }).trim().split('\n').filter(Boolean);

    let totalScore = 0;
    let scored = 0;

    for (const file of skillFiles) {
      try {
        const content = readFileSync(file, 'utf-8');

        // Basic checks for instruction quality
        const hasPhases = content.includes('## Phase') || content.includes('## Workflow') || content.includes('## Process');
        const hasExamples = content.includes('```') || content.includes('Example');
        const hasUsage = content.includes('Usage') || content.includes('usage:');
        const hasAntiPatterns = content.includes('Anti-Pattern') || content.includes('Redline') || content.includes('must not');

        const score = (hasPhases ? 20 : 0) + (hasExamples ? 20 : 0) + (hasUsage ? 20 : 0) + (hasAntiPatterns ? 40 : 0);
        totalScore += score;
        scored++;
      } catch {}
    }

    return {
      value: scored > 0 ? Math.round(totalScore / scored) : 0,
      unit: '/100',
      detail: { skillsAnalyzed: scored },
    };
  } catch {
    return { value: 0, unit: 'unknown' };
  }
}

/**
 * Measure example coverage in skills
 */
async function measureExampleCoverage() {
  try {
    const skillFiles = execSync('find skills -name "SKILL.md" 2>/dev/null', { encoding: 'utf-8', shell: 'bash' }).trim().split('\n').filter(Boolean);

    let withExamples = 0;
    for (const file of skillFiles) {
      try {
        const content = readFileSync(file, 'utf-8');
        if (content.includes('```') || content.includes('example')) {
          withExamples++;
        }
      } catch {}
    }

    return {
      value: skillFiles.length > 0 ? Math.round(withExamples / skillFiles.length * 100) : 0,
      unit: '%',
      detail: { withExamples, total: skillFiles.length },
    };
  } catch {
    return { value: 0, unit: 'unknown' };
  }
}

/**
 * Measure workflow completeness
 */
async function measureWorkflowCompleteness() {
  try {
    const skillFiles = execSync('find skills -name "SKILL.md" 2>/dev/null', { encoding: 'utf-8', shell: 'bash' }).trim().split('\n').filter(Boolean);

    let complete = 0;
    for (const file of skillFiles) {
      try {
        const content = readFileSync(file, 'utf-8');

        // Check for required sections
        const hasTrigger = content.includes('When') || content.includes('Trigger') || content.includes('Usage');
        const hasProcess = content.includes('## Process') || content.includes('## Workflow') || content.includes('## Phases');
        const hasOutput = content.includes('## Output') || content.includes('## Result') || content.includes('Output:');
        const hasExtensibility = content.includes('Extensibility') || content.includes('Extend') || content.includes('Customize');

        if (hasTrigger && hasProcess && hasOutput) {
          complete++;
        }
      } catch {}
    }

    return {
      value: skillFiles.length > 0 ? Math.round(complete / skillFiles.length * 100) : 0,
      unit: '%',
      detail: { completeWorkflows: complete, total: skillFiles.length },
    };
  } catch {
    return { value: 0, unit: 'unknown' };
  }
}

/**
 * Measure scope accuracy
 */
async function measureScopeAccuracy() {
  try {
    const skillFiles = execSync('find skills -name "SKILL.md" 2>/dev/null', { encoding: 'utf-8', shell: 'bash' }).trim().split('\n').filter(Boolean);

    let accurate = 0;
    for (const file of skillFiles) {
      try {
        const content = readFileSync(file, 'utf-8');

        // Check if skill scope is clear
        const hasScope = content.includes('Scope') || content.includes('## When') || content.includes('## When to Use');
        const hasLimitations = content.includes('not') || content.includes('Do NOT') || content.includes('Limitation') || content.includes('Anti-pattern');

        if (hasScope && hasLimitations) {
          accurate++;
        }
      } catch {}
    }

    return {
      value: skillFiles.length > 0 ? Math.round(accurate / skillFiles.length * 100) : 0,
      unit: '%',
      detail: { accurateScopes: accurate, total: skillFiles.length },
    };
  } catch {
    return { value: 0, unit: 'unknown' };
  }
}

/**
 * Convert object to YAML string (simplified)
 */
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

// Run
collectBaseline().catch(err => {
  console.error('Baseline collection failed:', err);
  process.exit(1);
});
