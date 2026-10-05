import { execFileSync } from 'child_process';
import { colors } from './constants.mjs';
import { TIMEOUTS } from '../../lib/config-constants.mjs';

/**
 * Detect the scale of changes based on git diff stats
 * @param {string} projectRoot - Project root directory
 * @param {string} diffBase - Git reference to compare against
 * @returns {{ scale: string, files: number, additions: number, deletions: number, total: number, suggestedProfile: string, reason: string, requiresAgentic: boolean }}
 */
export function detectChangeScale(projectRoot, diffBase) {
  try {
    const diff = execFileSync('git', ['diff', '--numstat', diffBase], {
      encoding: 'utf-8',
      cwd: projectRoot,
      timeout: TIMEOUTS.GIT_OPERATION,
    });

    let totalFiles = 0;
    let totalAdditions = 0;
    let totalDeletions = 0;

    for (const line of diff.split('\n')) {
      const match = line.match(/^(\d+|-)\s+(\d+|-)\s+(.+)$/);
      if (match) {
        totalFiles++;
        totalAdditions += parseInt(match[1]) || 0;
        totalDeletions += parseInt(match[2]) || 0;
      }
    }

    const untracked = execFileSync('git', ['ls-files', '--others', '--exclude-standard'], {
      encoding: 'utf-8',
      cwd: projectRoot,
      timeout: TIMEOUTS.GIT_OPERATION,
    }).trim().split('\n').filter(Boolean);
    totalFiles += untracked.length;

    const totalChanges = totalAdditions + totalDeletions;

    let scale = 'micro';
    let reason = '';

    if (totalFiles >= 50 || totalChanges >= 2000) {
      scale = 'xlarge';
      reason = 'Very large change (50+ files or 2000+ lines)';
    } else if (totalFiles >= 21 || totalChanges >= 500) {
      scale = 'large';
      reason = 'Large change (21-50 files or 500-2000 lines)';
    } else if (totalFiles >= 6 || totalChanges >= 100) {
      scale = 'medium';
      reason = 'Medium change (6-20 files or 100-500 lines)';
    } else if (totalFiles >= 3 || totalChanges >= 50) {
      scale = 'small';
      reason = 'Small change (3-5 files or 50-100 lines)';
    } else {
      scale = 'micro';
      reason = 'Micro change (1-2 files and <50 lines)';
    }

    const profileMap = {
      micro: 'quick',
      small: 'quick',
      medium: 'default',
      large: 'release-gate',
      xlarge: 'agentic-release-gate',
    };

    return {
      scale,
      files: totalFiles,
      additions: totalAdditions,
      deletions: totalDeletions,
      total: totalChanges,
      suggestedProfile: profileMap[scale],
      reason,
      requiresAgentic: scale === 'xlarge',
    };
  } catch (e) {
    return {
      scale: 'unknown',
      files: 0,
      additions: 0,
      deletions: 0,
      total: 0,
      suggestedProfile: 'release-gate',
      reason: 'Could not detect changes, using default',
      requiresAgentic: false,
    };
  }
}

/**
 * Print scale detection results
 * @param {object} scaleInfo - Scale detection results
 * @param {boolean} userSpecifiedProfile - Whether user explicitly set profile
 * @param {string} currentProfile - Current profile name
 */
export function printScaleDetection(scaleInfo, userSpecifiedProfile, currentProfile) {
  console.log('');
  console.log(`${colors.bright}${colors.cyan}═══════════════════════════════════════════════════${colors.reset}`);
  console.log(`${colors.bright}${colors.cyan}    Release Quality Gate - Change Scale Detection${colors.reset}`);
  console.log(`${colors.bright}${colors.cyan}═══════════════════════════════════════════════════${colors.reset}`);
  console.log('');

  console.log(`${colors.blue}ℹ${colors.reset} Detected Changes:`);
  console.log(`   Files: ${scaleInfo.files}`);
  console.log(`   Additions: ${scaleInfo.additions > 0 ? '+' : ''}${scaleInfo.additions}`);
  console.log(`   Deletions: ${scaleInfo.deletions > 0 ? '-' : ''}${scaleInfo.deletions}`);
  console.log(`   Total: ${scaleInfo.total} lines`);
  console.log('');

  console.log(`${colors.blue}ℹ${colors.reset} Scale: ${colors.bright}${scaleInfo.scale}${colors.reset}`);
  console.log(`   ${scaleInfo.reason}`);
  console.log('');

  console.log(`${colors.blue}ℹ${colors.reset} Suggested Profile: ${colors.bright}${scaleInfo.suggestedProfile}${colors.reset}`);
  if (scaleInfo.requiresAgentic) {
    console.log(`   ${colors.yellow}⚠${colors.reset} XLarge change: agentic-review is recommended`);
  }
  console.log('');

  if (userSpecifiedProfile) {
    console.log(`${colors.blue}ℹ${colors.reset} User Override: Using --profile ${currentProfile}`);
  } else {
    console.log(`${colors.blue}ℹ${colors.reset} Override with: ${colors.cyan}--profile <name>${colors.reset}`);
  }
  console.log('');
}
