import { describe, it, expect, vi } from 'vitest';
import javascriptPlugin from '../../src/analyzer/plugins/javascriptPlugin.js';
import * as astParser from '../../src/analyzer/astParser.js';

vi.mock('../../src/analyzer/astParser.js', () => ({
  analyzeCodeAST: vi.fn().mockReturnValue([{ ruleId: 'MOCK_RULE' }])
}));

describe('javascriptPlugin', () => {
  it('has the correct name and extensions', () => {
    expect(javascriptPlugin.name).toBe('JavaScript/TypeScript');
    expect(javascriptPlugin.extensions).toContain('.js');
    expect(javascriptPlugin.extensions).toContain('.tsx');
    expect(javascriptPlugin.extensions).toContain('.vue');
    expect(javascriptPlugin.extensions).toContain('.svelte');
  });

  it('delegates analysis to analyzeCodeAST', () => {
    const result = javascriptPlugin.analyze('const x = 1;', 'src/test.js', { custom: true });
    expect(astParser.analyzeCodeAST).toHaveBeenCalledWith('const x = 1;', 'src/test.js', { custom: true });
    expect(result).toEqual([{ ruleId: 'MOCK_RULE' }]);
  });
});
