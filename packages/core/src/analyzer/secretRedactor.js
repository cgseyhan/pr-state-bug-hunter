/**
 * Redacts common secrets (tokens, keys) from source code before sending to backend or AI.
 * This is a privacy and security control.
 * @param {string} code - The source code to redact.
 * @returns {string} The redacted source code.
 */
export function redactSecrets(code) {
  if (!code) return code;

  let redacted = code;

  // GitHub tokens (e.g. ghp_xxxxxxxx, github_pat_xxxxxx)
  redacted = redacted.replace(/(?:ghp|gho|ghu|ghs|ghr|github_pat)_[a-zA-Z0-9_]{36,255}/g, '[REDACTED_GITHUB_TOKEN]');

  // Generic UUIDs assigned to API keys
  redacted = redacted.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '[REDACTED_UUID_KEY]');

  // AWS Access Keys
  redacted = redacted.replace(/(?<![A-Z0-9])[A-Z0-9]{20}(?![A-Z0-9])/g, '[REDACTED_AWS_KEY]');

  // JWT Tokens (heuristic)
  redacted = redacted.replace(/eyJ[a-zA-Z0-9_=]+\.eyJ[a-zA-Z0-9_=]+\.?[a-zA-Z0-9_\-\+=]*/g, '[REDACTED_JWT_TOKEN]');

  // Generic assignments like `password = "secret"` or `api_key = "..."`
  redacted = redacted.replace(/(password|secret|api[_\-]?key|token|credential)\s*[:=]\s*["']([^"']+)["']/gi, (match, p1) => {
    return `${p1} = "[REDACTED_SECRET]"`;
  });

  return redacted;
}
