import path from 'node:path';

export function isPathWithin(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

export function resolveWithinRoot(root, relative, label = 'path') {
  if (typeof relative !== 'string' || !relative || path.isAbsolute(relative)) {
    throw new Error(`${label} must be a non-empty repository-relative path`);
  }
  const resolved = path.resolve(root, relative);
  if (!isPathWithin(root, resolved)) {
    throw new Error(`${label} escapes the repository: ${relative}`);
  }
  return resolved;
}

export function shouldIncludeCanonicalFile(name) {
  return name !== '.DS_Store';
}

export function containsSensitiveText(value) {
  const text = String(value || '');
  return [
    /-----BEGIN [^-]+ PRIVATE KEY-----/i,
    /https?:\/\/[^\s/@:]+:[^\s/@]+@/i,
    /\b(?:bearer|basic)\s+[A-Za-z0-9._~+/-]{12,}/i,
    /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/,
    /\bgithub_pat_[A-Za-z0-9_]{20,}\b/,
    /\bglpat-[A-Za-z0-9_-]{20,}\b/,
    /\bnpm_[A-Za-z0-9]{20,}\b/,
    /\bxox(?:a|b|p|r|s)-[A-Za-z0-9-]{10,}\b/,
    /\bAIza[0-9A-Za-z_-]{30,}\b/,
    /\b(?:sk|rk)_(?:live|test)_[0-9A-Za-z]{16,}\b/,
    /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/,
    /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/,
    /\b[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{8,}\b/,
    /(?:token|secret|password|api[_-]?key|private[_-]?key|access[_-]?key|credential)\s*[:=]\s*["'][^"'\r\n]{8,}["']/i,
  ].some(pattern => pattern.test(text));
}

export function redactSensitiveText(value) {
  return String(value || '')
    .replace(/-----BEGIN [^-]+ PRIVATE KEY-----[\s\S]*?-----END [^-]+ PRIVATE KEY-----/gi, '[REDACTED PEM]')
    .replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi, '$1[REDACTED]@')
    .replace(/\b(?:bearer|basic)\s+[^\s,;]+/gi, '[REDACTED AUTH]')
    .replace(/((?:cookie|set-cookie)\s*[:=]\s*)[^\r\n]+/gi, '$1[REDACTED]')
    .replace(/(["']?(?:token|secret|password|api[_-]?key|private[_-]?key|access[_-]?key|credential)["']?\s*[:=]\s*["'])[^"'\r\n]+(["'])/gi, '$1[REDACTED]$2')
    .replace(/((?:token|secret|password|api[_-]?key|private[_-]?key|access[_-]?key|credential)\s*[:=]\s*)[^\s,;]+/gi, '$1[REDACTED]')
    .replace(/\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g, '[REDACTED GITHUB TOKEN]')
    .replace(/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, '[REDACTED GITHUB TOKEN]')
    .replace(/\bglpat-[A-Za-z0-9_-]{20,}\b/g, '[REDACTED GITLAB TOKEN]')
    .replace(/\bnpm_[A-Za-z0-9]{20,}\b/g, '[REDACTED NPM TOKEN]')
    .replace(/\bxox(?:a|b|p|r|s)-[A-Za-z0-9-]{10,}\b/g, '[REDACTED SLACK TOKEN]')
    .replace(/\bAIza[0-9A-Za-z_-]{30,}\b/g, '[REDACTED GOOGLE API KEY]')
    .replace(/\b(?:sk|rk)_(?:live|test)_[0-9A-Za-z]{16,}\b/g, '[REDACTED STRIPE KEY]')
    .replace(/\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/g, '[REDACTED API TOKEN]')
    .replace(/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, '[REDACTED AWS KEY]')
    .replace(/\b[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{8,}\b/g, '[REDACTED JWT]');
}
