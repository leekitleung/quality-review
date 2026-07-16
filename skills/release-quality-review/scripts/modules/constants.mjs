const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const color = value => useColor ? value : '';

// ANSI colors for terminal output
export const colors = {
  reset: color('\x1b[0m'),
  bright: color('\x1b[1m'),
  dim: color('\x1b[2m'),
  red: color('\x1b[31m'),
  green: color('\x1b[32m'),
  yellow: color('\x1b[33m'),
  blue: color('\x1b[34m'),
  magenta: color('\x1b[35m'),
  cyan: color('\x1b[36m'),
};

export const log = {
  info: (msg) => console.log(`${colors.blue}ℹ${colors.reset} ${msg}`),
  success: (msg) => console.log(`${colors.green}✓${colors.reset} ${msg}`),
  warn: (msg) => console.log(`${colors.yellow}⚠${colors.reset} ${msg}`),
  error: (msg) => console.log(`${colors.red}✗${colors.reset} ${msg}`),
  title: (msg) => console.log(`\n${colors.bright}${colors.cyan}═══ ${msg} ═══${colors.reset}\n`),
};
