export const DEFAULT_VERIFICATION_COMMANDS = Object.freeze({
  test: 'npm test',
  typecheck: 'npm run typecheck',
  build: 'npm run build',
  lint: 'npm run lint',
  audit: 'npm audit --audit-level=high',
  coverage: 'npm run coverage',
  e2e: 'npm run test:e2e',
});

export const VERIFICATION_COMMAND_NAMES = Object.freeze(Object.keys(DEFAULT_VERIFICATION_COMMANDS));

export function resolveVerificationCommands(config = {}) {
  const configured = config.verification || {};
  const unknown = Object.keys(configured).filter(name => !VERIFICATION_COMMAND_NAMES.includes(name));
  if (unknown.length > 0) {
    throw new Error(`unknown verification config keys: ${unknown.join(', ')}`);
  }
  return Object.freeze({
    ...DEFAULT_VERIFICATION_COMMANDS,
    ...Object.fromEntries(VERIFICATION_COMMAND_NAMES
      .filter(name => typeof configured[name] === 'string')
      .map(name => [name, configured[name]])),
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
