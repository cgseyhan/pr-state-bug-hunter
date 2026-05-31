import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { loadConfig } from '../../src/config/configLoader.js';
import fs from 'fs';

vi.mock('fs');
vi.mock('@actions/core', () => ({
  default: {
    warning: vi.fn(),
  }
}));

describe('configLoader', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetAllMocks();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('loads default config when no file exists', () => {
    fs.existsSync.mockReturnValue(false);
    const config = loadConfig('/mock/workspace');
    
    expect(config.commentMode).toBe('compact');
    expect(config.severityThreshold).toBe('LOW');
    expect(config.saas.enabled).toBe(false);
  });

  it('merges user config from JSON file', () => {
    fs.existsSync.mockImplementation((path) => path.endsWith('.json'));
    fs.readFileSync.mockReturnValue(JSON.stringify({
      commentMode: "detailed",
      severityThreshold: "HIGH",
      rules: {
        EFFECT_DIRECT_ASYNC: "off"
      }
    }));

    const config = loadConfig('/mock/workspace');
    
    expect(config.commentMode).toBe('detailed');
    expect(config.severityThreshold).toBe('HIGH');
    expect(config.rules.EFFECT_DIRECT_ASYNC).toBe('off');
    // Ensure deep merge keeps defaults for missing fields
    expect(config.rules.REACT_DIRECT_STATE_MUTATION).toBe('on');
    expect(config.saas.enabled).toBe(false);
  });

  it('overrides config with environment variables', () => {
    fs.existsSync.mockReturnValue(false);
    process.env.INPUT_SEVERITY_THRESHOLD = 'MEDIUM';
    process.env.BUG_HUNTER_API_URL = 'https://api.bughunter.dev';

    const config = loadConfig('/mock/workspace');
    
    expect(config.severityThreshold).toBe('MEDIUM');
    expect(config.saas.enabled).toBe(true);
    expect(config.saas.apiBaseUrl).toBe('https://api.bughunter.dev');
  });

  it('throws error for invalid severity threshold', () => {
    fs.existsSync.mockReturnValue(false);
    process.env.INPUT_SEVERITY_THRESHOLD = 'SUPER_HIGH';

    expect(() => loadConfig('/mock/workspace')).toThrow(/Invalid severityThreshold/);
  });
});
