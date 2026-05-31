/**
 * Language Plugin Registry
 *
 * Provides a central registry for language-specific analyzers.
 * Each plugin registers itself with a set of file extensions it handles.
 * The AST parser delegates analysis to the appropriate plugin.
 *
 * @module languageRegistry
 */

const registry = new Map();

/**
 * Registers a language plugin.
 * @param {Object} plugin - The plugin descriptor.
 * @param {string} plugin.name - A human-readable name (e.g. "JavaScript/TypeScript").
 * @param {string[]} plugin.extensions - File extensions this plugin handles (e.g. ['.js', '.jsx', '.ts', '.tsx']).
 * @param {Function} plugin.analyze - Function(code: string, filePath: string) => Warning[].
 *   Each Warning: { line: number, ruleId: string, message: string, severity: string, warningSeverity: string }.
 */
export function registerLanguagePlugin(plugin) {
  if (!plugin || !plugin.name || !Array.isArray(plugin.extensions) || typeof plugin.analyze !== 'function') {
    throw new Error(`[LanguageRegistry] Invalid plugin: ${JSON.stringify(plugin)}. Must have name, extensions[], and analyze().`);
  }
  for (const ext of plugin.extensions) {
    if (registry.has(ext)) {
      console.warn(`[LanguageRegistry] Extension "${ext}" was already registered by "${registry.get(ext).name}". Overwriting with "${plugin.name}".`);
    }
    registry.set(ext, plugin);
    console.log(`[LanguageRegistry] Registered plugin "${plugin.name}" for extension "${ext}".`);
  }
}

export const registerPlugin = registerLanguagePlugin;

/**
 * Retrieves the plugin for a given file path.
 * @param {string} filePath - The file path (used to extract extension).
 * @returns {Object|null} The registered plugin or null if none matches.
 */
export function getPluginForFile(filePath) {
  if (!filePath) return null;
  const ext = filePath.slice(filePath.lastIndexOf('.')).toLowerCase();
  return registry.get(ext) || null;
}

/**
 * Lists all registered plugins.
 * @returns {Array<{name: string, extensions: string[]}>}
 */
export function listRegisteredPlugins() {
  const seen = new Set();
  const result = [];
  for (const plugin of registry.values()) {
    if (!seen.has(plugin.name)) {
      seen.add(plugin.name);
      result.push({ name: plugin.name, extensions: plugin.extensions });
    }
  }
  return result;
}
