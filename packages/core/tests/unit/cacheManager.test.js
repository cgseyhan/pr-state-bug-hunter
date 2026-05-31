/**
 * @vitest-environment node
 *
 * Unit tests for: src/analyzer/cacheManager.js
 * Covers: generateFingerprint, generateFindingId, getCachedFinding, setCachedFinding
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import crypto from 'crypto';

// ─── Mock the file system so tests never touch disk ──────────────────────────
vi.mock('fs', () => {
  const store = {};
  return {
    default: {
      existsSync: (p) => p in store,
      readFileSync: (p) => store[p],
      writeFileSync: (p, data) => { store[p] = data; },
    },
    existsSync: (p) => p in store,
    readFileSync: (p) => store[p],
    writeFileSync: (p, data) => { store[p] = data; },
    _store: store,
  };
});

// Import AFTER mocking
const { generateFingerprint, generateFindingId, getCachedFinding, setCachedFinding } =
  await import('../../src/analyzer/cacheManager.js');

describe('generateFingerprint', () => {
  it('produces a 64-char hex SHA-256 string', () => {
    const hash = generateFingerprint('owner/repo', 'src/foo.js', 'EFFECT_ASYNC', 'const x = 1;', 'VariableDeclaration');
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('is deterministic for identical inputs', () => {
    const h1 = generateFingerprint('owner/repo', 'src/foo.js', 'RULE', 'code', 'CallExpression');
    const h2 = generateFingerprint('owner/repo', 'src/foo.js', 'RULE', 'code', 'CallExpression');
    expect(h1).toBe(h2);
  });

  it('is sensitive to filePath changes', () => {
    const h1 = generateFingerprint('owner/repo', 'src/a.js', 'R', 'c');
    const h2 = generateFingerprint('owner/repo', 'src/b.js', 'R', 'c');
    expect(h1).not.toBe(h2);
  });

  it('is NOT sensitive to line number changes natively', () => {
    // Because we don't pass line number anymore. If code is same, hash is same.
    const h1 = generateFingerprint('owner/repo', 'src/a.js', 'R', 'c');
    const h2 = generateFingerprint('owner/repo', 'src/a.js', 'R', 'c');
    expect(h1).toBe(h2);
  });

  it('is sensitive to ruleId changes', () => {
    const h1 = generateFingerprint('owner/repo', 'src/a.js', 'RULE_A', 'c');
    const h2 = generateFingerprint('owner/repo', 'src/a.js', 'RULE_B', 'c');
    expect(h1).not.toBe(h2);
  });

  it('trims codeSnippet before hashing', () => {
    const h1 = generateFingerprint('owner/repo', 'src/a.js', 'R', '  code  ');
    const h2 = generateFingerprint('owner/repo', 'src/a.js', 'R', 'code');
    expect(h1).toBe(h2);
  });
});

describe('generateFindingId', () => {
  it('returns a 12 character prefix of the fingerprint', () => {
    const hash = generateFingerprint('owner/repo', 'src/foo.js', 'EFFECT_ASYNC', 'const x = 1;');
    const id = generateFindingId(hash);
    expect(id).toHaveLength(12);
    expect(hash.startsWith(id)).toBe(true);
  });
});

describe('getCachedFinding / setCachedFinding', () => {
  it('returns null for an unknown hash', () => {
    const result = getCachedFinding('nonexistent-hash-abc123');
    expect(result).toBeNull();
  });

  it('round-trips a finding correctly', () => {
    const hash = generateFingerprint('repo', 'src/comp.jsx', 'EFFECT_DIRECT_ASYNC', 'useEffect(async () => {});');
    const finding = {
      isRealBug: true,
      severity: 'HIGH',
      explanation: 'Direct async useEffect is a React anti-pattern.',
      proposedFix: 'useEffect(() => { const run = async () => {}; run(); }, []);',
      proposedTest: '```js\ntest("blocks direct async", () => {});\n```',
    };
    setCachedFinding(hash, finding);
    const cached = getCachedFinding(hash);
    expect(cached.isRealBug).toBe(true);
    expect(cached.severity).toBe('HIGH');
    expect(cached.explanation).toBe(finding.explanation);
    expect(cached.proposedFix).toBe(finding.proposedFix);
    expect(cached.proposedTest).toBe(finding.proposedTest);
    expect(cached.cachedAt).toBeDefined();
  });

  it('overwrites an existing entry on re-set', () => {
    const hash = 'fixed-test-hash-overwrite';
    setCachedFinding(hash, { isRealBug: true, severity: 'LOW', explanation: 'v1' });
    setCachedFinding(hash, { isRealBug: false, severity: 'MEDIUM', explanation: 'v2' });
    const result = getCachedFinding(hash);
    expect(result.explanation).toBe('v2');
    expect(result.isRealBug).toBe(false);
  });

  it('persists proposedTest field', () => {
    const hash = 'hash-with-proposed-test';
    setCachedFinding(hash, { isRealBug: true, proposedTest: '```js\ntest();\n```' });
    const cached = getCachedFinding(hash);
    expect(cached.proposedTest).toBe('```js\ntest();\n```');
  });
});
