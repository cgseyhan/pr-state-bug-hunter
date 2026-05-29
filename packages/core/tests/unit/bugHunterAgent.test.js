/**
 * @vitest-environment node
 *
 * Unit tests for: src/agents/bugHunterAgent.js
 * Covers:
 *   - huntStateBugsWithGemini: no-key early-exit, cache hits, response parsing,
 *     proposedTest field forwarding, OpenAI path via fetch
 *   - generateCorrectionPatch: happy path, AI failure fallback, markdown fence stripping
 *
 * All AI API calls are intercepted — no real network requests.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mock cacheManager ──────────────────────────────────────────────────────
const cacheStore = new Map();

vi.mock('../../src/analyzer/cacheManager.js', () => ({
  calculateWarningHash: vi.fn((...args) => args.join('|')),
  getCachedFinding: vi.fn((hash) => cacheStore.get(hash) ?? null),
  setCachedFinding: vi.fn((hash, finding) => cacheStore.set(hash, finding)),
}));

// ─── Mock fs/promises ───────────────────────────────────────────────────────
vi.mock('fs/promises', () => ({
  default: { readFile: vi.fn().mockRejectedValue(new Error('no file')) },
  readFile: vi.fn().mockRejectedValue(new Error('no file')),
}));

// ─── Mock @google/generative-ai with a proper constructor ───────────────────
const mockGenerateContent = vi.fn();

vi.mock('@google/generative-ai', () => {
  class MockGoogleGenerativeAI {
    constructor() {}
    getGenerativeModel() {
      return { generateContent: mockGenerateContent };
    }
  }
  return { 
    GoogleGenerativeAI: MockGoogleGenerativeAI,
    SchemaType: { ARRAY: 'ARRAY', OBJECT: 'OBJECT', NUMBER: 'NUMBER', STRING: 'STRING', BOOLEAN: 'BOOLEAN' }
  };
});

const { huntStateBugsWithGemini, generateCorrectionPatch } =
  await import('../../src/agents/bugHunterAgent.js');

const { calculateWarningHash, getCachedFinding, setCachedFinding } =
  await import('../../src/analyzer/cacheManager.js');

beforeEach(() => {
  cacheStore.clear();
  vi.clearAllMocks();
  getCachedFinding.mockImplementation((hash) => cacheStore.get(hash) ?? null);
  setCachedFinding.mockImplementation((hash, finding) => cacheStore.set(hash, finding));
  calculateWarningHash.mockImplementation((...args) => args.join('|'));
  mockGenerateContent.mockResolvedValue({
    response: {
      text: () =>
        JSON.stringify([
          {
            line: 9,
            ruleId: 'EFFECT_DIRECT_ASYNC',
            isRealBug: true,
            severity: 'HIGH',
            explanation: 'Mocked Gemini explanation.',
            proposedFix: '// fixed code',
            proposedTest: '```js\ntest("mocked", () => {});\n```',
          },
        ]),
    },
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// huntStateBugsWithGemini — early exit
// ═════════════════════════════════════════════════════════════════════════════
describe('huntStateBugsWithGemini – early exit', () => {
  it('returns [] immediately when no apiKey and no localAI', async () => {
    const result = await huntStateBugsWithGemini(null, [], [], 'gemini-1.5-flash', {});
    expect(result).toEqual([]);
  });

  it('returns [] when changes array is empty', async () => {
    const result = await huntStateBugsWithGemini('AIza-fake', [], [], 'gemini-1.5-flash', {});
    expect(result).toEqual([]);
  });

  it('returns [] when apiKey is empty string and no localAI', async () => {
    const result = await huntStateBugsWithGemini('', [], [], 'gemini-1.5-flash', {});
    expect(result).toEqual([]);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// huntStateBugsWithGemini — cache hit path
// ═════════════════════════════════════════════════════════════════════════════
describe('huntStateBugsWithGemini – cache hits', () => {
  it('uses cached real-bug finding without calling AI', async () => {
    const fakeHash = 'src/comp.jsx|9|EFFECT_DIRECT_ASYNC|snippet';
    const cachedFinding = {
      isRealBug: true,
      severity: 'HIGH',
      explanation: 'Cached explanation.',
      proposedFix: '// cached fix',
      proposedTest: '```js\ntest("cached", () => {});\n```',
    };
    cacheStore.set(fakeHash, cachedFinding);

    const changes = [{ path: 'src/comp.jsx', patch: '+ some diff', changedLines: [9] }];
    const warnings = [
      { path: 'src/comp.jsx', line: 9, ruleId: 'EFFECT_DIRECT_ASYNC', message: 'm', severity: 'HIGH' },
    ];

    calculateWarningHash.mockReturnValue(fakeHash);

    const result = await huntStateBugsWithGemini('AIza-fake', changes, warnings);
    expect(result).toHaveLength(1);
    expect(result[0].explanation).toBe('Cached explanation.');
    // proposedTest is forwarded from cache when the field exists in the stored finding
    expect('proposedTest' in cachedFinding).toBe(true);
    // AI should NOT have been called since all entries are cached
    expect(mockGenerateContent).not.toHaveBeenCalled();
  });

  it('does NOT push a cached false-positive into results', async () => {
    const fakeHash = 'src/comp.jsx|99|FALSE_POS|snippet';
    cacheStore.set(fakeHash, {
      isRealBug: false,
      severity: 'LOW',
      explanation: 'Not a bug.',
      proposedFix: null,
    });
    calculateWarningHash.mockReturnValue(fakeHash);

    const changes = [{ path: 'src/comp.jsx', patch: '+ code', changedLines: [99] }];
    const warnings = [
      { path: 'src/comp.jsx', line: 99, ruleId: 'FALSE_POS', message: 'm', severity: 'LOW' },
    ];

    const result = await huntStateBugsWithGemini('AIza-fake', changes, warnings);
    expect(result).toHaveLength(0);
    expect(mockGenerateContent).not.toHaveBeenCalled();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// huntStateBugsWithGemini — Gemini AI path
// ═════════════════════════════════════════════════════════════════════════════
describe('huntStateBugsWithGemini – Gemini AI path', () => {
  it('calls Gemini and returns verified issues', async () => {
    const changes = [{ path: 'src/new.jsx', patch: '+ useEffect(async ()=>{},[])', changedLines: [9] }];
    const warnings = [
      { path: 'src/new.jsx', line: 9, ruleId: 'EFFECT_DIRECT_ASYNC', message: 'm', severity: 'HIGH' },
    ];

    const result = await huntStateBugsWithGemini('AIza-fake', changes, warnings);
    expect(mockGenerateContent).toHaveBeenCalled();
    expect(result.length).toBeGreaterThan(0);
    expect(result[0].ruleId).toBe('EFFECT_DIRECT_ASYNC');
  });

  it('forwards proposedTest from AI response into the result', async () => {
    const changes = [{ path: 'src/test-prop.jsx', patch: '+ code', changedLines: [9] }];
    const warnings = [
      { path: 'src/test-prop.jsx', line: 9, ruleId: 'EFFECT_DIRECT_ASYNC', message: 'm', severity: 'HIGH' },
    ];

    const result = await huntStateBugsWithGemini('AIza-fake', changes, warnings);
    expect(result.length).toBeGreaterThan(0);
    expect(result[0].proposedTest).toBe('```js\ntest("mocked", () => {});\n```');
  });

  it('caches the proposedTest field alongside other fields', async () => {
    const changes = [{ path: 'src/cache-write.jsx', patch: '+ code', changedLines: [9] }];
    const warnings = [
      { path: 'src/cache-write.jsx', line: 9, ruleId: 'EFFECT_DIRECT_ASYNC', message: 'm', severity: 'HIGH' },
    ];

    await huntStateBugsWithGemini('AIza-fake', changes, warnings);
    expect(setCachedFinding).toHaveBeenCalled();
    const lastFinding = setCachedFinding.mock.calls[0][1];
    expect(lastFinding).toHaveProperty('proposedTest');
  });

  it('handles malformed JSON from AI gracefully (returns empty)', async () => {
    // pre-filter call fails
    mockGenerateContent.mockResolvedValueOnce({
      response: { text: () => 'not valid json !!!' },
    });
    // deep analysis call also fails
    mockGenerateContent.mockResolvedValueOnce({
      response: { text: () => 'not valid json !!!' },
    });

    const changes = [{ path: 'src/bad.jsx', patch: '+ code', changedLines: [5] }];
    const warnings = [
      { path: 'src/bad.jsx', line: 5, ruleId: 'SOME_RULE', message: 'm', severity: 'MEDIUM' },
    ];

    const result = await huntStateBugsWithGemini('AIza-fake', changes, warnings);
    expect(result).toEqual([]);
  });

  it('performs general diff scan when no AST warnings are present', async () => {
    // pre-filter says not clean
    mockGenerateContent.mockResolvedValueOnce({
      response: { text: () => JSON.stringify({ clean: false }) }
    });
    // deep analysis returns the general diff bug
    mockGenerateContent.mockResolvedValueOnce({
      response: {
        text: () => JSON.stringify([{
          isRealBug: true,
          line: 12,
          ruleId: 'GENERAL_ASYNC_BUG',
          severity: 'HIGH',
          explanation: 'Found leak in diff',
          proposedFix: 'Fix leak'
        }])
      }
    });

    const prChanges = [{ path: 'src/clean.jsx', changedLines: [12], patch: '@@ -1 +1 @@\n+clean' }];
    const astWarnings = []; // NO AST WARNINGS
    
    const results = await huntStateBugsWithGemini('AIza-fake', prChanges, astWarnings);
    expect(results).toHaveLength(1);
    expect(results[0].ruleId).toBe('GENERAL_ASYNC_BUG');
    expect(results[0].explanation).toBe('Found leak in diff');
  });

  it('uses cached general diff scan results', async () => {
    const prChanges = [{ path: 'src/cached-clean.jsx', changedLines: [15], patch: '@@ -1 +1 @@\n+cached' }];
    const astWarnings = [];
    
    const hash = calculateWarningHash('src/cached-clean.jsx', 0, 'GENERAL_DIFF_SCAN', prChanges[0].patch);
    setCachedFinding(hash, [{
      isRealBug: true,
      line: 15,
      ruleId: 'GENERAL_ASYNC_BUG',
      severity: 'LOW',
      explanation: 'Cached leak',
      proposedFix: 'Cached fix'
    }]);

    const results = await huntStateBugsWithGemini('AIza-fake', prChanges, astWarnings);
    expect(results).toHaveLength(1);
    expect(results[0].explanation).toBe('Cached leak');
    expect(mockGenerateContent).not.toHaveBeenCalled();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// huntStateBugsWithGemini — OpenAI path
// ═════════════════════════════════════════════════════════════════════════════
describe('huntStateBugsWithGemini – OpenAI path', () => {
  it('calls fetch for sk- keys and returns results', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{
          message: {
            content: JSON.stringify([{
              line: 5,
              ruleId: 'UNFRAMED_STREAM_DATA',
              isRealBug: true,
              severity: 'MEDIUM',
              explanation: 'OpenAI explanation.',
              proposedFix: '// fix',
              proposedTest: null,
            }]),
          },
        }],
      }),
    });
    global.fetch = mockFetch;

    const changes = [{ path: 'src/server.js', patch: '+ socket.on("data", ...)', changedLines: [5] }];
    const warnings = [
      { path: 'src/server.js', line: 5, ruleId: 'UNFRAMED_STREAM_DATA', message: 'm', severity: 'MEDIUM' },
    ];

    const result = await huntStateBugsWithGemini('sk-openai-fake-key', changes, warnings, 'gpt-4o-mini');
    expect(mockFetch).toHaveBeenCalled();
    expect(result.length).toBeGreaterThan(0);
    expect(result[0].ruleId).toBe('UNFRAMED_STREAM_DATA');

    delete global.fetch;
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// generateCorrectionPatch
// ═════════════════════════════════════════════════════════════════════════════
describe('generateCorrectionPatch', () => {
  it('returns a corrected patch string from Gemini', async () => {
    mockGenerateContent.mockResolvedValueOnce({
      response: { text: () => 'const x = (a, b) => a + b;' },
    });

    const result = await generateCorrectionPatch(
      'AIza-fake',
      'const x = (a, b => { a + b',
      'SyntaxError: Unexpected token',
      'gemini-1.5-flash',
      {}
    );
    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
  });

  it('strips wrapping markdown code fences from AI response', async () => {
    mockGenerateContent.mockResolvedValueOnce({
      response: { text: () => '```js\nconst x = 1;\n```' },
    });

    const result = await generateCorrectionPatch(
      'AIza-fake', 'broken code', 'SyntaxError', 'gemini-1.5-flash', {}
    );
    expect(result).not.toMatch(/^```/);
    expect(result).toContain('const x = 1;');
  });

  it('returns null when AI throws', async () => {
    mockGenerateContent.mockRejectedValueOnce(new Error('Quota exceeded'));

    const result = await generateCorrectionPatch(
      'AIza-fake', 'broken', 'SyntaxError', 'gemini-1.5-flash', {}
    );
    expect(result).toBeNull();
  });

  it('uses fetch for sk- OpenAI keys', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: 'const corrected = true;' } }],
      }),
    });
    global.fetch = mockFetch;

    const result = await generateCorrectionPatch(
      'sk-fake-key', 'broken code', 'SyntaxError', 'gpt-4o-mini', {}
    );
    expect(mockFetch).toHaveBeenCalled();
    expect(typeof result).toBe('string');

    delete global.fetch;
  });

  it('returns null for whitespace-only AI response', async () => {
    mockGenerateContent.mockResolvedValueOnce({
      response: { text: () => '   \n  ' },
    });

    const result = await generateCorrectionPatch(
      'AIza-fake', 'broken', 'error', 'gemini-1.5-flash', {}
    );
    expect(result).toBeNull();
  });
});
