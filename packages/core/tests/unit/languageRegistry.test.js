/**
 * @vitest-environment node
 *
 * Unit tests for: src/analyzer/languageRegistry.js
 * Covers: registerLanguagePlugin, getPluginForFile, listRegisteredPlugins
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  registerLanguagePlugin,
  getPluginForFile,
  listRegisteredPlugins,
} from '../../src/analyzer/languageRegistry.js';

// Helper factory for a valid plugin descriptor
function makePlugin(name, extensions) {
  return { name, extensions, analyze: (code, filePath) => [] };
}

describe('registerLanguagePlugin', () => {
  it('throws when plugin is missing name', () => {
    expect(() =>
      registerLanguagePlugin({ extensions: ['.py'], analyze: () => [] })
    ).toThrow();
  });

  it('throws when plugin is missing extensions', () => {
    expect(() =>
      registerLanguagePlugin({ name: 'Test', analyze: () => [] })
    ).toThrow();
  });

  it('throws when plugin is missing analyze function', () => {
    expect(() =>
      registerLanguagePlugin({ name: 'Test', extensions: ['.py'] })
    ).toThrow();
  });

  it('throws when analyze is not a function', () => {
    expect(() =>
      registerLanguagePlugin({ name: 'Test', extensions: ['.py'], analyze: 'not-a-fn' })
    ).toThrow();
  });

  it('registers successfully with valid arguments', () => {
    const plugin = makePlugin('Valid Plugin', ['.valid']);
    expect(() => registerLanguagePlugin(plugin)).not.toThrow();
    expect(getPluginForFile('something.valid')).toBe(plugin);
  });

  it('registers multiple extensions for one plugin', () => {
    const plugin = makePlugin('Multi Plugin', ['.aaa', '.bbb']);
    registerLanguagePlugin(plugin);
    expect(getPluginForFile('file.aaa')).toBe(plugin);
    expect(getPluginForFile('file.bbb')).toBe(plugin);
  });
});

describe('getPluginForFile', () => {
  it('returns null for an unregistered extension', () => {
    expect(getPluginForFile('main.unknownext')).toBeNull();
  });

  it('returns null for empty/undefined path', () => {
    expect(getPluginForFile('')).toBeNull();
    expect(getPluginForFile(null)).toBeNull();
    expect(getPluginForFile(undefined)).toBeNull();
  });

  it('matches extensions case-insensitively', () => {
    const plugin = makePlugin('Case Plugin', ['.casetest']);
    registerLanguagePlugin(plugin);
    // Upper-case extension lookup should also match
    expect(getPluginForFile('file.CASETEST')).toBe(plugin);
  });

  it('extracts extension from nested path correctly', () => {
    const plugin = makePlugin('Nested Plugin', ['.nested']);
    registerLanguagePlugin(plugin);
    expect(getPluginForFile('src/deep/path/file.nested')).toBe(plugin);
  });
});

describe('listRegisteredPlugins', () => {
  it('returns an array', () => {
    expect(Array.isArray(listRegisteredPlugins())).toBe(true);
  });

  it('includes registered plugin names', () => {
    registerLanguagePlugin(makePlugin('Listed Plugin', ['.listed']));
    const names = listRegisteredPlugins().map((p) => p.name);
    expect(names).toContain('Listed Plugin');
  });

  it('does not duplicate plugin entries with multiple extensions', () => {
    registerLanguagePlugin(makePlugin('Dedup Plugin', ['.dedup1', '.dedup2']));
    const listed = listRegisteredPlugins().filter((p) => p.name === 'Dedup Plugin');
    expect(listed.length).toBe(1);
  });

  it('includes extensions array for each plugin', () => {
    registerLanguagePlugin(makePlugin('Extensions Plugin', ['.extcheck']));
    const found = listRegisteredPlugins().find((p) => p.name === 'Extensions Plugin');
    expect(found).toBeDefined();
    expect(Array.isArray(found.extensions)).toBe(true);
    expect(found.extensions).toContain('.extcheck');
  });
});

describe('plugin analyze delegation', () => {
  it('calls the plugin analyze function with correct args', () => {
    let capturedCode, capturedPath;
    const plugin = {
      name: 'Delegation Test',
      extensions: ['.delegtest'],
      analyze: (code, filePath) => {
        capturedCode = code;
        capturedPath = filePath;
        return [{ line: 1, ruleId: 'MOCK', message: 'ok', severity: 'LOW' }];
      },
    };
    registerLanguagePlugin(plugin);
    const p = getPluginForFile('src/my.delegtest');
    const result = p.analyze('const x = 1;', 'src/my.delegtest');
    expect(capturedCode).toBe('const x = 1;');
    expect(capturedPath).toBe('src/my.delegtest');
    expect(result).toHaveLength(1);
    expect(result[0].ruleId).toBe('MOCK');
  });
});
