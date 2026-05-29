import fs from 'fs';
import crypto from 'crypto';
import path from 'path';

const CACHE_FILE = '.bug-hunter-cache.json';

/**
 * Calculates a unique SHA-256 signature for a static analysis warning.
 * @param {string} filePath - Path of the audited file.
 * @param {number} line - Target line number.
 * @param {string} ruleId - The triggered rule ID.
 * @param {string} codeSnippetContext - The context code surrounding the warning.
 * @returns {string} SHA-256 hex string.
 */
export function calculateWarningHash(filePath, line, ruleId, codeSnippetContext) {
  const payload = `${filePath}:${line}:${ruleId}:${codeSnippetContext.trim()}`;
  return crypto.createHash('sha256').update(payload).digest('hex');
}

/**
 * Reads the local cache file, returning a parsed JSON object.
 * @returns {Record<string, any>} Cached findings.
 */
function readCache() {
  try {
    if (fs.existsSync(CACHE_FILE)) {
      const data = fs.readFileSync(CACHE_FILE, 'utf8');
      return JSON.parse(data);
    }
  } catch (err) {
    console.warn(`[Cache Warning]: Could not read cache file: ${err.message}`);
  }
  return {};
}

/**
 * Persists the cache findings to the local cache file.
 * @param {Record<string, any>} cache - The cache object to save.
 */
function writeCache(cache) {
  try {
    fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2), 'utf8');
  } catch (err) {
    console.warn(`[Cache Warning]: Could not write cache file: ${err.message}`);
  }
}

/**
 * Retrieves a cached finding by its warning hash signature.
 * @param {string} hash - SHA-256 signature.
 * @returns {any|null} The cached AI finding or null.
 */
export function getCachedFinding(hash) {
  const cache = readCache();
  return cache[hash] || null;
}

/**
 * Saves an audited finding under its warning hash signature.
 * @param {string} hash - SHA-256 signature.
 * @param {any} finding - Finding metadata (explanation, proposedFix, severity, etc.)
 */
export function setCachedFinding(hash, finding) {
  const cache = readCache();
  cache[hash] = {
    ...finding,
    cachedAt: new Date().toISOString()
  };
  writeCache(cache);
}
