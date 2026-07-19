import { colors, log } from './constants.mjs';

/**
 * Parse CLI arguments for review-gate
 * @param {string[]} args - Command line arguments
 * @returns {object} Parsed options
 */
export function parseCliArgs(args) {
  const options = {
    profile: 'release-gate',
    singleReviewer: null,
    checkRedlinesOnly: false,
    roundNumber: null,
    collectEvidence: true,
    dryRun: false,
    excludeReviewers: [],
    detectScale: false,
    userSpecifiedProfile: false,
    validateEvidence: true,
    checkGoalMode: false,
    diffBase: 'HEAD~1',
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--profile' && args[i + 1]) {
      options.profile = args[i + 1];
      options.userSpecifiedProfile = true;
      i++;
    } else if (arg === '--reviewer' && args[i + 1]) {
      options.singleReviewer = args[i + 1];
      i++;
    } else if (arg === '--check-redlines') {
      options.checkRedlinesOnly = true;
    } else if (arg === '--check-goal-mode') {
      options.checkGoalMode = true;
    } else if (arg === '--round' && args[i + 1]) {
      const roundArg = args[++i];
      if (!/^\d+$/.test(roundArg) && !/^round-\d+$/i.test(roundArg)) {
        log.error('Invalid --round: expected a positive integer or round-NNN');
        process.exit(4);
      }
      const match = roundArg.match(/^round-(\d+)$/i);
      const parsed = match ? parseInt(match[1], 10) : parseInt(roundArg, 10);
      if (!Number.isInteger(parsed) || parsed < 1) {
        log.error('Invalid --round: expected a positive integer');
        process.exit(4);
      }
      options.roundNumber = parsed;
    } else if (arg === '--no-collect') {
      options.collectEvidence = false;
    } else if (arg === '--collect-evidence') {
      options.collectEvidence = true;
    } else if (arg === '--dry-run') {
      options.dryRun = true;
    } else if (arg === '--exclude-reviewer' && args[i + 1]) {
      options.excludeReviewers.push(args[i + 1]);
      i++;
    } else if (arg === '--detect-scale') {
      options.detectScale = true;
    } else if (arg === '--validate-evidence') {
      options.validateEvidence = true;
    } else if (arg === '--no-validate-evidence') {
      options.validateEvidence = false;
    } else if (arg === '--base' && args[i + 1]) {
      options.diffBase = args[i + 1];
      i++;
    } else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    } else {
      log.error(`Unknown or incomplete option: ${arg}`);
      process.exit(4);
    }
  }

  options.excludeReviewers = Object.freeze([...options.excludeReviewers]);
  return Object.freeze(options);
}

export function printHelp() {
  console.log(`
${colors.bright}Review Gate - Deterministic Quality Gate${colors.reset}

Usage:
  node review-gate.mjs [options]

Options:
  --profile <name>       Profile: quick, default, release-gate, full, agentic-release-gate
  --reviewer <name>     Run only this reviewer
  --round <N>           Round number (auto-detected if not specified)
  --check-redlines      Only check for redlines (P0/P1 blockers)
  --check-goal-mode     Enable goal mode constraint (describe final state, not steps)
  --no-collect          Skip automatic evidence collection
  --collect-evidence    Force evidence collection (default)
  --exclude-reviewer N  Exclude reviewer N from this run
  --detect-scale         Detect change scale and suggest profile
  --validate-evidence   Enable evidence source validation (default: true)
  --no-validate-evidence Skip evidence source validation (对抗性审查)
  --base <ref>          Git diff base for change detection (default: HEAD~1, use "origin/main" for branch comparison)
  --dry-run             Validate configuration without running
  --version             Print package version
  --help, -h            Show this help

Profiles:
  quick         Minimal resident reviewers (product-flow, architecture-maintainer)
  default       Standard PR review (product-flow, destructive-qa, terminal-veteran)
  release-gate  Full release gate (all residents + terminal-veteran)
  full          Complete review (all 8 reviewers)
  agentic-release-gate  Full independent and adversarial release arbitration

Exit Codes:
  0 = All gates passed
  1 = Gates failed
  2 = Unexpected runtime error
  4 = Configuration or invalid CLI input

Examples:
  npm run skill:gate -- --profile release-gate
  npm run skill:gate -- --detect-scale
  npm run skill:gate -- --round 2 --profile default
  npm run skill:gate -- --reviewer destructive-qa --round 2
  `);
}
