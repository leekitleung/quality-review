export const DEFAULT_VERIFICATION_COMMANDS = Object.freeze({
  test: 'npm test',
  typecheck: 'npm run typecheck',
  build: 'npm run build',
  lint: 'npm run lint',
  audit: 'npm audit --audit-level=high',
  coverage: 'npm run coverage',
  e2e: 'npm run test:e2e',
});

export function resolveVerificationCommands(config = {}) {
  return Object.freeze({
    ...DEFAULT_VERIFICATION_COMMANDS,
    ...(config.verification || {}),
    audit: DEFAULT_VERIFICATION_COMMANDS.audit,
  });
}

export function validateVerificationCommands(commands) {
  for (const [name, command] of Object.entries(commands || {})) {
    if (name === 'audit' && command === DEFAULT_VERIFICATION_COMMANDS.audit) continue;
    if (typeof command !== 'string' || command.trim() === '' || /[;&|`$()<>\n\r]/.test(command)) {
      throw new Error(`trivial or missing verification scripts: verification command ${name} is not allowed`);
    }
    if (!/^(?:npm|pnpm|yarn)(?:\s+(?:run\s+)?[a-zA-Z0-9:._-]+)(?:\s+--[a-zA-Z0-9=._-]+)*$/.test(command.trim())) {
      throw new Error(`trivial or missing verification scripts: verification command ${name} is not an allowed package-script command`);
    }
  }
  return true;
}
