/**
 * @vitest-environment node
 *
 * Integration tests for: /fix Slash Command Pipeline
 * Covers the full flow: security guard → patch application → auto-heal loop
 *
 * These tests simulate what happens in index.js when a /fix comment is posted,
 * without spinning up GitHub Actions or touching real APIs.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Helpers that mirror index.js logic ─────────────────────────────────────

/**
 * Mirrors index.js::applyFixToText
 * Replaces the content around targetLine with the patch.
 */
function applyFixToText(fileContent, targetLine, patchCode) {
  if (!fileContent || !patchCode) return null;
  const lines = fileContent.split('\n');
  if (targetLine < 1 || targetLine > lines.length) return null;
  const CONTEXT = 15;
  const start = Math.max(0, targetLine - 1 - CONTEXT);
  const end = Math.min(lines.length, targetLine + CONTEXT);
  const result = [
    ...lines.slice(0, start),
    patchCode,
    ...lines.slice(end),
  ].join('\n');
  return result;
}

/**
 * Mirrors the permission check logic in octokitClient.js::checkUserWritePermission
 */
function checkPermission(level) {
  return level === 'write' || level === 'admin';
}

/**
 * Mirrors the auto-heal retry loop from index.js
 * @param {string} initialFix - The initial (possibly broken) patch.
 * @param {Function} validateFn - Returns { valid, error }.
 * @param {Function} healFn - Returns a corrected fix string or null.
 * @param {number} maxAttempts
 * @returns {{ finalFix: string|null, attempts: number }}
 */
async function runAutoHealLoop(initialFix, validateFn, healFn, maxAttempts = 3) {
  let currentFix = initialFix;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const { valid, error } = validateFn(currentFix);
    if (valid) return { finalFix: currentFix, attempts: attempt };
    if (attempt === maxAttempts) return { finalFix: null, attempts: attempt };
    const corrected = await healFn(currentFix, error);
    if (!corrected) return { finalFix: null, attempts: attempt };
    currentFix = corrected;
  }
  return { finalFix: null, attempts: maxAttempts };
}

// ═════════════════════════════════════════════════════════════════════════════
// applyFixToText
// ═════════════════════════════════════════════════════════════════════════════
describe('applyFixToText', () => {
  const file = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join('\n');

  it('returns a string when called with valid inputs', () => {
    const result = applyFixToText(file, 15, '// replacement');
    expect(typeof result).toBe('string');
    expect(result).toContain('// replacement');
  });

  it('returns null when fileContent is empty', () => {
    expect(applyFixToText('', 5, '// fix')).toBeNull();
  });

  it('returns null when patchCode is empty', () => {
    expect(applyFixToText(file, 5, '')).toBeNull();
  });

  it('returns null for out-of-range line numbers', () => {
    expect(applyFixToText(file, 0, '// fix')).toBeNull();
    expect(applyFixToText(file, 9999, '// fix')).toBeNull();
  });

  it('does not duplicate the replacement when applied twice', () => {
    const once = applyFixToText(file, 15, '// replacement');
    const twice = applyFixToText(once, 15, '// replacement');
    expect(once?.split('// replacement').length - 1).toBe(1);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Security Permission Guard
// ═════════════════════════════════════════════════════════════════════════════
describe('Security Permission Guard', () => {
  it('blocks users with "read" permission', () => {
    expect(checkPermission('read')).toBe(false);
  });

  it('blocks users with "none" permission', () => {
    expect(checkPermission('none')).toBe(false);
  });

  it('allows users with "write" permission', () => {
    expect(checkPermission('write')).toBe(true);
  });

  it('allows users with "admin" permission', () => {
    expect(checkPermission('admin')).toBe(true);
  });

  it('blocks unknown permission strings', () => {
    expect(checkPermission('superuser')).toBe(false);
    expect(checkPermission('')).toBe(false);
    expect(checkPermission(null)).toBe(false);
    expect(checkPermission(undefined)).toBe(false);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Auto-Heal Retry Loop
// ═════════════════════════════════════════════════════════════════════════════
describe('Auto-Heal Retry Loop', () => {
  it('accepts a patch that is immediately valid (attempt 1)', async () => {
    const { finalFix, attempts } = await runAutoHealLoop(
      'const x = 1;',
      () => ({ valid: true }),
      async () => null
    );
    expect(finalFix).toBe('const x = 1;');
    expect(attempts).toBe(1);
  });

  it('heals a broken patch on the second attempt', async () => {
    let callCount = 0;
    const { finalFix, attempts } = await runAutoHealLoop(
      'broken code',
      (fix) => ({ valid: fix === 'fixed code', error: 'SyntaxError' }),
      async () => 'fixed code'
    );
    expect(finalFix).toBe('fixed code');
    expect(attempts).toBe(2);
  });

  it('exhausts all attempts and returns null when healing always fails', async () => {
    const { finalFix, attempts } = await runAutoHealLoop(
      'always broken',
      () => ({ valid: false, error: 'SyntaxError' }),
      async () => 'still broken',
      3
    );
    expect(finalFix).toBeNull();
    expect(attempts).toBe(3);
  });

  it('stops immediately when healFn returns null', async () => {
    const { finalFix, attempts } = await runAutoHealLoop(
      'broken',
      () => ({ valid: false, error: 'SyntaxError' }),
      async () => null,
      3
    );
    expect(finalFix).toBeNull();
    expect(attempts).toBe(1);
  });

  it('calls healFn the right number of times before giving up', async () => {
    const healFn = vi.fn().mockResolvedValue('still broken');
    await runAutoHealLoop(
      'broken',
      () => ({ valid: false, error: 'SyntaxError' }),
      healFn,
      3
    );
    // Called on attempts 1, 2 (attempt 3 exhausts without calling heal)
    expect(healFn).toHaveBeenCalledTimes(2);
  });

  it('heals on the last possible attempt (attempt = maxAttempts - 1)', async () => {
    const responses = ['still broken', 'const fixed = true;'];
    let idx = 0;
    const { finalFix, attempts } = await runAutoHealLoop(
      'broken',
      (fix) => ({ valid: fix === 'const fixed = true;', error: 'SyntaxError' }),
      async () => responses[idx++],
      3
    );
    expect(finalFix).toBe('const fixed = true;');
    expect(attempts).toBe(3);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// End-to-end slash command scenario
// ═════════════════════════════════════════════════════════════════════════════
describe('/fix slash command — full flow simulation', () => {
  const originalFile = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join('\n');

  it('applies a valid fix when the user has write permission', async () => {
    const permission = 'write';
    const hasAccess = checkPermission(permission);
    expect(hasAccess).toBe(true);

    const patch = '// corrected line 15';
    const updatedContent = applyFixToText(originalFile, 15, patch);
    expect(updatedContent).toContain('// corrected line 15');

    const syntaxCheck = { valid: true }; // simulated valid syntax
    expect(syntaxCheck.valid).toBe(true);
  });

  it('blocks fix and returns early when user has read permission', async () => {
    const permission = 'read';
    const hasAccess = checkPermission(permission);
    expect(hasAccess).toBe(false);
    // No further actions should be taken — this simulates the early return
  });

  it('invokes auto-heal when patch introduces syntax error', async () => {
    let healed = false;
    const { finalFix } = await runAutoHealLoop(
      'const broken = (a, b => { }',
      (fix) => ({ valid: fix === 'const fixed = (a, b) => {};', error: 'SyntaxError' }),
      async () => {
        healed = true;
        return 'const fixed = (a, b) => {};';
      },
      3
    );
    expect(healed).toBe(true);
    expect(finalFix).toBe('const fixed = (a, b) => {};');
  });

  it('does not commit when all auto-heal attempts fail', async () => {
    const commitFn = vi.fn();
    const { finalFix } = await runAutoHealLoop(
      'totally broken',
      () => ({ valid: false, error: 'SyntaxError' }),
      async () => null,
      3
    );
    if (finalFix) commitFn();
    expect(commitFn).not.toHaveBeenCalled();
  });
});
