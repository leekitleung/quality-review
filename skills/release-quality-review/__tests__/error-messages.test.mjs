/**
 * Error Message Utility Tests
 *
 * Coverage:
 * - formatGateError standard [Component] action failed: reason. Try: suggestion. format
 * - Optional suggestion omission (both the null and the omitted branches)
 * - gateError Error instance construction
 *
 * The format is part of the evidence contract: error messages are persisted
 * into round evidence, so these tests pin the exact rendering.
 */

import test from 'node:test';
import { formatGateError, gateError } from '../lib/error-messages.mjs';

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${expected}, got ${actual}`);
  }
}

function assertTrue(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

test('formatGateError renders component, action, reason, and suggestion', () => {
  assertEqual(
    formatGateError('Sandbox', 'probe', 'sandbox-exec probe failed unexpectedly', 'verify that macOS seatbelt is available'),
    '[Sandbox] probe failed: sandbox-exec probe failed unexpectedly. Try: verify that macOS seatbelt is available',
    'formatted error with suggestion',
  );
});

test('formatGateError omits the Try suffix when suggestion is null', () => {
  assertEqual(
    formatGateError('Repository', 'context resolution', 'project root is outside its repository', null),
    '[Repository] context resolution failed: project root is outside its repository',
    'formatted error with null suggestion',
  );
});

test('formatGateError omits the Try suffix when suggestion is omitted', () => {
  assertEqual(
    formatGateError('Evidence', 'validation', 'automated-checks.json is missing'),
    '[Evidence] validation failed: automated-checks.json is missing',
    'formatted error with omitted suggestion',
  );
});

test('gateError returns an Error carrying the formatted message', () => {
  const error = gateError('Gate', 'arbitration', 'no reviewer packet passed', 'inspect round evidence');
  assertTrue(error instanceof Error, 'gateError must return an Error instance');
  assertEqual(
    error.message,
    '[Gate] arbitration failed: no reviewer packet passed. Try: inspect round evidence',
    'gateError message format',
  );
});
