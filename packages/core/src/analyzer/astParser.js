import { buildDependencyGraph, findPathToHighRisk } from './dependencyGraph.js';
import { getPluginForFile } from './languageRegistry.js';
import { loadConfig } from '../config/configLoader.js';
import path from 'path';

// Import to trigger auto-registration
import './javascriptPlugin.js';

/**
 * Routes code analysis to the appropriate language plugin.
 * @param {string} code - The source code to analyze.
 * @param {string} filePath - The path of the file being analyzed.
 * @param {object} config - The configuration object.
 * @returns {Array<{line: number, ruleId: string, message: string, severity: 'LOW'|'MEDIUM'|'HIGH', ruleVersion?: string}>} Array of structural warnings.
 */
export function analyzeCodeAST(code, filePath, config = null) {
  const plugin = getPluginForFile(filePath);
  if (plugin) {
    if (plugin.name !== 'JavaScript/TypeScript') {
      console.log(`[LanguageRegistry] Delegating "${filePath}" to plugin "${plugin.name}".`);
    }
    return plugin.analyze(code, filePath, config);
  }

  console.log(`[LanguageRegistry] No plugin registered for "${filePath}".`);
  return [];
}

/**
 * Verifies if the file contains valid syntax using its language plugin (if supported).
 * For now, this is kept basic as only JS/TS is fully supported for syntax verification.
 * @param {string} code - The source code to verify.
 * @param {string} filePath - The file path.
 * @returns {{valid: boolean, error?: string}} Analysis result.
 */
export function verifySyntax(code, filePath) {
  // If there's a plugin and it has verifySyntax, use it. Otherwise, assume valid.
  // JavaScript plugin doesn't have verifySyntax yet, but we'll add it.
  const plugin = getPluginForFile(filePath);
  if (plugin && typeof plugin.verifySyntax === 'function') {
    return plugin.verifySyntax(code, filePath);
  }
  
  // Fallback if plugin doesn't support verifySyntax (or we can just return true for now)
  return { valid: true };
}

/**
 * Escalates severity of warnings if the buggy component is imported by a high-risk component.
 * @param {Array} warnings - Array of AST warnings.
 * @param {string} workspaceDir - Path to workspace root directory.
 * @returns {Array} Updated warnings with potential escalations.
 */
export function escalateWarnings(warnings, workspaceDir = '.') {
  if (!workspaceDir) return warnings;
  try {
    const { graph, highRiskFiles } = buildDependencyGraph(workspaceDir);
    if (highRiskFiles.size === 0) return warnings;

    return warnings.map(w => {
      const filePath = w.path || w.filePath;
      if (!filePath) return w;

      const route = findPathToHighRisk(filePath, graph, highRiskFiles);
      if (route && route.length > 1) {
        const highRiskFile = route[route.length - 1];
        const importerFile = path.basename(highRiskFile);
        
        // Return escalated warning
        return {
          ...w,
          severity: 'HIGH',
          message: `${w.message} [Escalated: Imported by high-risk component <${importerFile}>]`
        };
      }
      return w;
    });
  } catch (err) {
    console.warn(`[Escalation Warning]: Could not process taint-based severity escalation: ${err.message}`);
    return warnings;
  }
}
