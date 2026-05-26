/**
 * JavaScript/TypeScript Language Plugin
 *
 * Registers JS/TS/JSX/TSX/Vue/Svelte extensions with the language registry
 * and delegates analysis to the existing analyzeCodeAST core engine.
 *
 * Adding a new language later is as simple as creating a new plugin file
 * and calling registerLanguagePlugin() — no changes to astParser.js needed.
 *
 * @module plugins/javascriptPlugin
 */
import { registerLanguagePlugin } from '../languageRegistry.js';
import { analyzeCodeAST } from '../astParser.js';

const javascriptPlugin = {
  name: 'JavaScript/TypeScript',
  extensions: ['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.vue', '.svelte'],
  /**
   * Analyzes a JS/TS/JSX/TSX/Vue/Svelte file for async state bugs.
   * @param {string} code - File source code.
   * @param {string} filePath - Absolute or relative path of the file.
   * @param {Object} [config] - Optional rule config from bug-hunter.config.json.
   * @returns {Array<{line: number, ruleId: string, message: string, severity: string}>}
   */
  analyze(code, filePath, config = null) {
    return analyzeCodeAST(code, filePath, config);
  }
};

registerLanguagePlugin(javascriptPlugin);

export default javascriptPlugin;
