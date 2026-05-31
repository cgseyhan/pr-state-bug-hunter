import fs from 'fs';
import path from 'path';
import core from '@actions/core';

const DEFAULT_CONFIG = {
  commentMode: "compact", // compact, detailed, summary-only
  severityThreshold: "LOW", // LOW, MEDIUM, HIGH
  minConfidence: "low",
  rules: {
    EFFECT_DIRECT_ASYNC: "on",
    EFFECT_UNCLEANED_SUBSCRIPTION: "on",
    REACT_DIRECT_STATE_MUTATION: "on",
    SVELTE_UNCLEANED_SUBSCRIBE: "on",
    VUE_UNCLEANED_ONMOUNTED: "on",
    UNFRAMED_STREAM_DATA: "on",
    EFFECT_UNGUARDED_ASYNC: "on",
    STALE_ASYNC_STATE_UPDATE: "on",
    UNBOUNDED_LOOP_ASYNCHRONY: "on"
  },
  autoFix: {
    enabled: false,
    mode: "suggestion", // suggestion, commit
    allowForks: false,
    allowedUsers: []
  },
  privacy: {
    redactSecrets: true,
    sendOnlyDiffContext: true
  },
  saas: {
    enabled: false,
    apiBaseUrl: "",
    tokenEnv: "BUG_HUNTER_TOKEN"
  }
};

/**
 * Deep merge two objects.
 */
function mergeDeep(target, source) {
  if (!target) return source;
  if (!source) return target;
  
  const output = Object.assign({}, target);
  Object.keys(source).forEach(key => {
    if (isObject(source[key])) {
      if (!(key in target)) {
        Object.assign(output, { [key]: source[key] });
      } else {
        output[key] = mergeDeep(target[key], source[key]);
      }
    } else {
      Object.assign(output, { [key]: source[key] });
    }
  });
  return output;
}

function isObject(item) {
  return (item && typeof item === 'object' && !Array.isArray(item));
}

/**
 * Loads the user-facing configuration, applying defaults and environment overrides.
 */
export function loadConfig(workspaceRoot = process.cwd()) {
  let userConfig = {};

  const jsonPath = path.join(workspaceRoot, 'bug-hunter.config.json');
  const jsPath = path.join(workspaceRoot, 'bug-hunter.config.js');

  try {
    if (fs.existsSync(jsonPath)) {
      userConfig = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    } else if (fs.existsSync(jsPath)) {
      // Dynamic import for JS config could be used here. For simplicity, we assume JSON mostly.
      core.warning("bug-hunter.config.js detected but currently only .json is fully supported. Please use bug-hunter.config.json.");
    }
  } catch (err) {
    throw new Error(`Failed to load bug-hunter config: ${err.message}`);
  }

  // Merge user config over default config
  const mergedConfig = mergeDeep(DEFAULT_CONFIG, userConfig);

  // Apply environment/input overrides
  if (process.env.INPUT_SEVERITY_THRESHOLD || process.env['INPUT_SEVERITY-THRESHOLD']) {
    mergedConfig.severityThreshold = process.env.INPUT_SEVERITY_THRESHOLD || process.env['INPUT_SEVERITY-THRESHOLD'];
  }
  if (process.env.BUG_HUNTER_API_URL) {
    mergedConfig.saas.enabled = true;
    mergedConfig.saas.apiBaseUrl = process.env.BUG_HUNTER_API_URL;
  }

  // Validate critical fields
  const validSeverities = ['LOW', 'MEDIUM', 'HIGH'];
  if (!validSeverities.includes(mergedConfig.severityThreshold.toUpperCase())) {
    throw new Error(`Invalid severityThreshold: ${mergedConfig.severityThreshold}. Must be LOW, MEDIUM, or HIGH.`);
  }
  
  return mergedConfig;
}
