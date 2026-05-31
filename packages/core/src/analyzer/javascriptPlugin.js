import * as parser from '@babel/parser';
import _traverse from '@babel/traverse';
import { loadConfig } from '../config/configLoader.js';
import { registerPlugin } from './languageRegistry.js';

import ruleEffectDirectAsync from './rules/effect-direct-async.js';
import ruleEffectUncleanedSubscription from './rules/effect-uncleaned-subscription.js';
import ruleEffectMissingAsyncGuard from './rules/effect-missing-async-guard.js';
import ruleUnframedStreamData from './rules/unframed-stream-data.js';
import ruleSvelteUncleanedSubscribe from './rules/svelte-uncleaned-subscribe.js';
import ruleVueUncleanedOnmounted from './rules/vue-uncleaned-onmounted.js';
import ruleUnboundedLoopAsynchrony from './rules/unbounded-loop-asynchrony.js';
import ruleReactDirectStateMutation from './rules/react-direct-state-mutation.js';
import ruleStaleAsyncStateUpdate from './rules/stale-async-state-update.js';

const traverse = _traverse.default || _traverse;

const rules = [
  ruleEffectDirectAsync,
  ruleEffectUncleanedSubscription,
  ruleEffectMissingAsyncGuard,
  ruleUnframedStreamData,
  ruleSvelteUncleanedSubscribe,
  ruleVueUncleanedOnmounted,
  ruleUnboundedLoopAsynchrony,
  ruleReactDirectStateMutation,
  ruleStaleAsyncStateUpdate
];

function preprocessVueSvelte(code) {
  let processed = '';
  let inScript = false;
  const lines = code.split('\n');
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/<script\b[^>]*>/i.test(line)) {
      inScript = true;
      processed += '\n'; // Keep line alignment
    } else if (/<\/script>/i.test(line)) {
      inScript = false;
      processed += '\n'; // Keep line alignment
    } else {
      if (inScript) {
        processed += line + '\n';
      } else {
        processed += '\n'; // Replace template/styles with newlines
      }
    }
  }
  return processed;
}

export const javascriptPlugin = {
  name: 'JavaScript/TypeScript',
  extensions: ['.js', '.jsx', '.ts', '.tsx', '.svelte', '.vue'],
  analyze(code, filePath, config = null) {
    if (!config) {
      try {
        config = loadConfig();
      } catch (e) {
        config = {};
      }
    }

    const plugins = ['jsx'];
    if (/\.tsx?$/i.test(filePath)) {
      plugins.push('typescript');
    } else {
      plugins.push('flow');
    }

    let codeToParse = code;
    const isSvelte = /\.svelte$/i.test(filePath);
    const isVue = /\.vue$/i.test(filePath);
    if (isSvelte || isVue) {
      codeToParse = preprocessVueSvelte(code);
    }

    let ast;
    try {
      ast = parser.parse(codeToParse, {
        sourceType: 'module',
        plugins,
        allowImportExportEverywhere: true,
        allowReturnOutsideFunction: true
      });
    } catch (err) {
      console.log(`[AST Parsing skipped for ${filePath}]: ${err.message}`);
      return [];
    }

    const warnings = [];
    const visitorMap = {};
    const activeRuleInstances = [];

    // Initialize rules
    for (const rule of rules) {
      if (config && config.rules && config.rules[rule.id] === 'off') {
        continue;
      }

      const context = {
        isSvelte,
        isVue,
        filePath,
        report: (info) => {
          const configuredSeverity = config?.rules?.[rule.id] || info.severity || rule.severity;
          if (configuredSeverity === 'off') return;

          warnings.push({
            line: info.line,
            ruleId: rule.id,
            message: info.message,
            severity: configuredSeverity,
            ruleVersion: rule.version
          });
        }
      };

      const visitor = rule.create(context);
      activeRuleInstances.push(visitor);

      for (const [nodeType, handler] of Object.entries(visitor)) {
        if (nodeType === 'onProgramExit') continue;
        
        if (!visitorMap[nodeType]) {
          visitorMap[nodeType] = [];
        }
        visitorMap[nodeType].push(handler);
      }
    }

    const mergedVisitor = {};
    for (const [nodeType, handlers] of Object.entries(visitorMap)) {
      mergedVisitor[nodeType] = function(path) {
        for (const handler of handlers) {
          handler(path);
        }
      };
    }

    traverse(ast, mergedVisitor);

    for (const instance of activeRuleInstances) {
      if (instance.onProgramExit) {
        instance.onProgramExit();
      }
    }

    return warnings;
  },
  
  verifySyntax(code, filePath) {
    const plugins = ['jsx'];
    if (/\.tsx?$/i.test(filePath)) {
      plugins.push('typescript');
    } else {
      plugins.push('flow');
    }

    let codeToParse = code;
    const isSvelte = /\.svelte$/i.test(filePath);
    const isVue = /\.vue$/i.test(filePath);
    if (isSvelte || isVue) {
      codeToParse = preprocessVueSvelte(code);
    }

    try {
      parser.parse(codeToParse, {
        sourceType: 'module',
        plugins,
        allowImportExportEverywhere: true,
        allowReturnOutsideFunction: true
      });
      return { valid: true };
    } catch (err) {
      return { valid: false, error: err.message };
    }
  }
};

// Register itself automatically
registerPlugin(javascriptPlugin);
