import * as parser from '@babel/parser';
import _traverse from '@babel/traverse';
import path from 'path';
import fs from 'fs';
import { buildDependencyGraph, findPathToHighRisk } from './dependencyGraph.js';
const traverse = _traverse.default || _traverse;

/**
 * Preprocesses Svelte/Vue files to extract script tag contents
 * while replacing all other contents with newlines to preserve exact line numbering.
 * @param {string} code - Original file contents.
 * @returns {string} Preprocessed JS/TS script content.
 */
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

/**
 * Parses JS/TS/JSX/TSX code into an AST and analyzes it for asynchronous, lifecycle, and state-related bug patterns.
 * @param {string} code - The source code to analyze.
 * @param {string} filePath - The path of the file being analyzed.
 * @returns {Array<{line: number, ruleId: string, message: string, severity: 'LOW'|'MEDIUM'|'HIGH'}>} Array of structural warnings.
 */
export function analyzeCodeAST(code, filePath, config = null) {
  if (!config) {
    try {
      if (fs.existsSync('bug-hunter.config.json')) {
        config = JSON.parse(fs.readFileSync('bug-hunter.config.json', 'utf8'));
      }
    } catch (e) {
      // Ignore
    }
  }
  if (!config) {
    config = {};
  }

  const warnings = [];
  const originalPush = warnings.push;
  warnings.push = function(warning) {
    if (config && config.rules && config.rules[warning.ruleId] === 'off') {
      return;
    }
    originalPush.call(warnings, warning);
  };

  // Determine file extension plugins
  const plugins = ['jsx'];
  if (/\.tsx?$/i.test(filePath)) {
    plugins.push('typescript');
  } else {
    plugins.push('flow'); // Fallback to support generic JS syntax
  }

  // Preprocess Svelte/Vue files to preserve line numbers
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

  // Tracking structures for Svelte manual subscriptions
  const svelteSubs = {}; // name -> { line, unsubscribed: boolean }
  const svelteOnDestroyCalls = []; // callbacks or bodies inside onDestroy

  // Tracking structures for Vue Composition API
  const vueMountedListeners = []; // Array of { line, type, target, eventName, handler }
  const vueUnmountedCalls = []; // callbacks/bodies inside onUnmounted or onBeforeUnmount

  // Walk AST to find state bugs and race conditions
  traverse(ast, {
    // 1. React useEffect lifecycle and async reviews
    CallExpression(path) {
      const { node } = path;
      const { callee } = node;

      // Check for useEffect or useLayoutEffect hooks
      const isEffect = (
        (callee.type === 'Identifier' && (callee.name === 'useEffect' || callee.name === 'useLayoutEffect')) ||
        (callee.type === 'MemberExpression' && callee.property.type === 'Identifier' &&
         (callee.property.name === 'useEffect' || callee.property.name === 'useLayoutEffect'))
      );

      if (isEffect && node.arguments.length > 0) {
        const effectCallback = node.arguments[0];

        // --- RULE 3: Direct async callback in useEffect ---
        if (effectCallback.async) {
          warnings.push({
            line: effectCallback.loc?.start.line || node.loc?.start.line,
            ruleId: 'EFFECT_DIRECT_ASYNC',
            message: 'Directly declaring the useEffect callback as "async" is a React anti-pattern. useEffect must return cleanups synchronously. Declare an async function inside and invoke it.',
            severity: 'HIGH'
          });
        }

        // Parse internal contents of useEffect callback
        if (
          effectCallback.type === 'ArrowFunctionExpression' ||
          effectCallback.type === 'FunctionExpression'
        ) {
          analyzeEffectCallbackBody(effectCallback, node, warnings);
        }
      }

      // --- RULE 5: Unframed TCP/Stream data buffering issues ---
      const isSocketOnData = (
        callee.type === 'MemberExpression' &&
        callee.property.type === 'Identifier' &&
        (callee.property.name === 'on' || callee.property.name === 'addListener') &&
        node.arguments.length >= 2 &&
        node.arguments[0].type === 'StringLiteral' &&
        node.arguments[0].value === 'data'
      );

      if (isSocketOnData) {
        const dataCallback = node.arguments[1];
        if (
          dataCallback.type === 'ArrowFunctionExpression' ||
          dataCallback.type === 'FunctionExpression'
        ) {
          // Check body for JSON.parse or directly processing without buffer accumulation
          let usesJsonParseDirectly = false;
          let accumulationsFound = false;

          path.traverse({
            CallExpression(subPath) {
              const subCallee = subPath.node.callee;
              if (
                subCallee.type === 'MemberExpression' &&
                subCallee.object.type === 'Identifier' &&
                subCallee.object.name === 'JSON' &&
                subCallee.property.name === 'parse'
              ) {
                // If it parses the event chunk directly
                const arg = subPath.node.arguments[0];
                if (arg && (arg.type === 'Identifier' || (arg.type === 'CallExpression' && arg.callee.property?.name === 'toString'))) {
                  usesJsonParseDirectly = true;
                }
              }
            },
            AssignmentExpression(subPath) {
              // Look for buffer accumulation like buffer += chunk or buffer = Buffer.concat(...)
              const { operator } = subPath.node;
              if (operator === '+=' || operator === '=') {
                accumulationsFound = true;
              }
            }
          });

          if (usesJsonParseDirectly && !accumulationsFound) {
            warnings.push({
              line: node.loc?.start.line,
              ruleId: 'UNFRAMED_STREAM_DATA',
              message: 'Potential message framing / packet fragmentation bug. Reading raw stream "data" events and parsing JSON directly without buffering or length-framing can result in crash/corruption when packets split or merge.',
              severity: 'HIGH'
            });
          }
        }
      }

      // --- Svelte manual subscription direct calls (unassigned) ---
      if (isSvelte) {
        const isSubscribeCall = (
          (callee.type === 'MemberExpression' && callee.property.name === 'subscribe') ||
          (callee.type === 'Identifier' && callee.name === 'subscribe')
        );

        if (isSubscribeCall) {
          let isAssigned = false;
          let parent = path.parentPath;
          while (parent) {
            if (parent.node.type === 'VariableDeclarator') {
              isAssigned = true;
              break;
            }
            if (parent.node.type === 'ExpressionStatement') {
              break;
            }
            parent = parent.parentPath;
          }

          if (!isAssigned) {
            warnings.push({
              line: node.loc?.start.line,
              ruleId: 'SVELTE_UNCLEANED_SUBSCRIBE',
              message: 'Svelte manual store subscription executed without storing the unsubscribe reference. This makes it impossible to clean up, causing memory leaks.',
              severity: 'HIGH'
            });
          }
        }

        // Track onDestroy calls
        if (callee.type === 'Identifier' && callee.name === 'onDestroy') {
          if (node.arguments.length > 0) {
            const arg = node.arguments[0];
            if (arg.type === 'Identifier') {
              svelteOnDestroyCalls.push({ type: 'identifier', name: arg.name });
            } else if (arg.type === 'ArrowFunctionExpression' || arg.type === 'FunctionExpression') {
              svelteOnDestroyCalls.push({ type: 'function', body: arg.body });
            }
          }
        }
      }

      // --- Vue Composition API onMounted tracking ---
      if (isVue) {
        if (callee.type === 'Identifier' && callee.name === 'onMounted') {
          if (node.arguments.length > 0) {
            const callback = node.arguments[0];
            if (callback.type === 'ArrowFunctionExpression' || callback.type === 'FunctionExpression') {
              // Analyze the onMounted setup for listeners
              const checkMountedBody = (subNode) => {
                if (!subNode) return;

                if (
                  subNode.type === 'CallExpression' &&
                  subNode.callee.type === 'MemberExpression' &&
                  subNode.callee.property.name === 'addEventListener'
                ) {
                  const target = subNode.callee.object.name || 'window';
                  const eventName = subNode.arguments[0]?.value || 'event';
                  const handler = subNode.arguments[1]?.name || 'handler';
                  vueMountedListeners.push({
                    line: subNode.loc?.start.line || node.loc?.start.line,
                    type: 'event',
                    target,
                    eventName,
                    handler,
                    node: subNode
                  });
                }

                if (
                  subNode.type === 'CallExpression' &&
                  subNode.callee.name === 'setInterval'
                ) {
                  vueMountedListeners.push({
                    line: subNode.loc?.start.line || node.loc?.start.line,
                    type: 'interval',
                    node: subNode
                  });
                }

                for (const key in subNode) {
                  if (subNode[key] && typeof subNode[key] === 'object') {
                    if (Array.isArray(subNode[key])) {
                      subNode[key].forEach(checkMountedBody);
                    } else if (subNode[key].type) {
                      checkMountedBody(subNode[key]);
                    }
                  }
                }
              };
              checkMountedBody(callback.body);
            }
          }
        }

        // Track Vue unmounted hooks
        if (callee.type === 'Identifier' && (callee.name === 'onUnmounted' || callee.name === 'onBeforeUnmount')) {
          if (node.arguments.length > 0) {
            const callback = node.arguments[0];
            if (callback.type === 'ArrowFunctionExpression' || callback.type === 'FunctionExpression') {
              vueUnmountedCalls.push(callback.body);
            }
          }
        }
      }

      // --- RULE: Unbounded async loop execution ---
      const isLoopMethod = (
        callee.type === 'MemberExpression' &&
        callee.property.type === 'Identifier' &&
        ['forEach', 'map', 'filter', 'every', 'some'].includes(callee.property.name)
      );
      if (isLoopMethod && node.arguments.length > 0) {
        const callback = node.arguments[0];
        if (
          callback &&
          (callback.type === 'ArrowFunctionExpression' || callback.type === 'FunctionExpression') &&
          callback.async
        ) {
          warnings.push({
            line: callback.loc?.start.line || node.loc?.start.line,
            ruleId: 'UNBOUNDED_LOOP_ASYNCHRONY',
            message: `Unbounded async loop execution. Calling async/await directly inside "${callee.property.name}" does not await executions sequentially or limit concurrency, which can cause network congestion or state races. Use "for...of" for sequential execution or "Promise.all" / a concurrency pooler for parallel tracking.`,
            severity: 'MEDIUM'
          });
        }
      }
    },

    // 2. State hooks and stale closures in async handlers, and Svelte variable assignments
    VariableDeclarator(path) {
      const { node } = path;

      // Track Svelte manual subscription references
      if (isSvelte) {
        if (
          node.init?.type === 'CallExpression' &&
          ((node.init.callee.type === 'MemberExpression' && node.init.callee.property.name === 'subscribe') ||
           (node.init.callee.type === 'Identifier' && node.init.callee.name === 'subscribe'))
        ) {
          if (node.id.type === 'Identifier') {
            svelteSubs[node.id.name] = {
              line: node.loc?.start.line || node.init.loc?.start.line,
              unsubscribed: false
            };
          }
        }
      }

      // Track React state hooks to identify setters: const [data, setData] = useState(...)
      if (
        node.id.type === 'ArrayPattern' &&
        node.id.elements.length >= 2 &&
        node.init?.type === 'CallExpression' &&
        (node.init.callee.name === 'useState' || node.init.callee.property?.name === 'useState')
      ) {
        const stateVarNode = node.id.elements[0];
        const setterNode = node.id.elements[1];

        if (stateVarNode?.type === 'Identifier' && setterNode?.type === 'Identifier') {
          const stateVarName = stateVarNode.name;
          const setterName = setterNode.name;

          // Search the parent block or component for async setters using stale state values
          const componentScope = path.getFunctionParent();
          if (componentScope) {
            componentScope.traverse({
              AssignmentExpression(subPath) {
                const { left } = subPath.node;
                if (
                  left.type === 'MemberExpression' &&
                  left.object.type === 'Identifier' &&
                  left.object.name === stateVarName
                ) {
                  warnings.push({
                    line: subPath.node.loc?.start.line || node.loc?.start.line,
                    ruleId: 'REACT_DIRECT_STATE_MUTATION',
                    message: `Direct state mutation hazard. Mutating state variable "${stateVarName}" directly ("${stateVarName}.${left.property.name || 'property'} = ...") instead of using the setter "${setterName}" will not trigger a re-render and violates React unidirectional data flow patterns.`,
                    severity: 'HIGH'
                  });
                }
              },
              CallExpression(subPath) {
                const { callee } = subPath.node;
                if (
                  callee.type === 'MemberExpression' &&
                  callee.object.type === 'Identifier' &&
                  callee.object.name === stateVarName
                ) {
                  const method = callee.property.name;
                  const mutatingMethods = ['push', 'pop', 'shift', 'unshift', 'splice', 'reverse', 'sort'];
                  if (mutatingMethods.includes(method)) {
                    warnings.push({
                      line: subPath.node.loc?.start.line || node.loc?.start.line,
                      ruleId: 'REACT_DIRECT_STATE_MUTATION',
                      message: `Direct state mutation hazard. Calling mutating array method "${method}" directly on state variable "${stateVarName}" instead of using the setter "${setterName}" bypasses React's state tracking. Create a shallow copy first and update via the setter.`,
                      severity: 'HIGH'
                    });
                  }
                }

                // Look for setters called inside async/await or .then blocks
                // Look for setters called inside async/await or .then blocks
                if (subPath.node.callee.name === setterName) {
                  // Verify if setter is nested in an async flow or callback
                  let isInsideAsyncOrTimer = false;
                  let parent = subPath.parentPath;
                  
                  while (parent && parent !== componentScope) {
                    if (
                      (parent.isFunction() && (parent.node.async || parent.parentPath?.isCallExpression() && (
                        parent.parentPath.node.callee.name === 'setTimeout' ||
                        parent.parentPath.node.callee.name === 'setInterval'
                      ))) ||
                      parent.isAwaitExpression()
                    ) {
                      isInsideAsyncOrTimer = true;
                      break;
                    }
                    parent = parent.parentPath;
                  }

                  if (isInsideAsyncOrTimer) {
                    // Check if the argument is a stale state variable read directly
                    const arg = subPath.node.arguments[0];
                    if (arg && arg.type !== 'ArrowFunctionExpression' && arg.type !== 'FunctionExpression') {
                      let readsStateVar = false;
                      // Traverse the argument to see if it reads stateVarName
                      subPath.traverse({
                        Identifier(idPath) {
                          if (idPath.node.name === stateVarName && idPath.parent.type !== 'MemberExpression') {
                            readsStateVar = true;
                          }
                        }
                      });

                      if (readsStateVar) {
                        warnings.push({
                          line: subPath.node.loc?.start.line || node.loc?.start.line,
                          ruleId: 'STALE_ASYNC_STATE_UPDATE',
                          message: `Stale state closure hazard. React state setter "${setterName}" reads state variable "${stateVarName}" directly inside an asynchronous flow. If state changes before this completes, updates will be overwritten. Use the functional updater form instead: \`${setterName}(prev => ...)\`.`,
                          severity: 'MEDIUM'
                        });
                      }
                    }
                  }
                }
              }
            });
          }
        }
      }
    }
  });

  // Verify Svelte subscriptions unsubscriptions
  if (isSvelte) {
    for (const [subName, subInfo] of Object.entries(svelteSubs)) {
      let cleaned = false;
      for (const call of svelteOnDestroyCalls) {
        if (call.type === 'identifier' && call.name === subName) {
          cleaned = true;
          break;
        } else if (call.type === 'function') {
          let callsUnsub = false;
          const checkUnsubCall = (subNode) => {
            if (!subNode) return;
            if (subNode.type === 'CallExpression' && subNode.callee.name === subName) {
              callsUnsub = true;
            }
            for (const key in subNode) {
              if (subNode[key] && typeof subNode[key] === 'object') {
                if (Array.isArray(subNode[key])) {
                  subNode[key].forEach(checkUnsubCall);
                } else if (subNode[key].type) {
                  checkUnsubCall(subNode[key]);
                }
              }
            }
          };
          checkUnsubCall(call.body);
          if (callsUnsub) {
            cleaned = true;
            break;
          }
        }
      }

      if (!cleaned) {
        warnings.push({
          line: subInfo.line,
          ruleId: 'SVELTE_UNCLEANED_SUBSCRIBE',
          message: `Svelte manual store subscription "${subName}" is never cleaned up. Memory leak hazard. Call the unsubscribe function in Svelte's onDestroy lifecycle hook.`,
          severity: 'HIGH'
        });
      }
    }
  }

  // Verify Vue mounted listeners cleanups
  if (isVue) {
    for (const listener of vueMountedListeners) {
      let cleaned = false;

      for (const unmountBody of vueUnmountedCalls) {
        const checkCleanup = (subNode) => {
          if (!subNode) return;

          if (listener.type === 'event') {
            if (
              subNode.type === 'CallExpression' &&
              subNode.callee.type === 'MemberExpression' &&
              subNode.callee.property.name === 'removeEventListener'
            ) {
              const target = subNode.callee.object.name || 'window';
              const eventName = subNode.arguments[0]?.value || 'event';
              if (target === listener.target && eventName === listener.eventName) {
                cleaned = true;
              }
            }
          } else if (listener.type === 'interval') {
            if (
              subNode.type === 'CallExpression' &&
              subNode.callee.name === 'clearInterval'
            ) {
              cleaned = true;
            }
          }

          for (const key in subNode) {
            if (subNode[key] && typeof subNode[key] === 'object') {
              if (Array.isArray(subNode[key])) {
                subNode[key].forEach(checkCleanup);
              } else if (subNode[key].type) {
                checkCleanup(subNode[key]);
              }
            }
          }
        };
        checkCleanup(unmountBody);
        if (cleaned) break;
      }

      if (!cleaned) {
        const msg = listener.type === 'event'
          ? `Vue Composition API onMounted listener leak. The event listener for "${listener.eventName}" on "${listener.target}" is registered inside onMounted but is not cleaned up in onUnmounted/onBeforeUnmount.`
          : `Vue Composition API onMounted interval leak. setInterval is created inside onMounted but clearInterval is never called in onUnmounted/onBeforeUnmount.`;
        warnings.push({
          line: listener.line,
          ruleId: 'VUE_UNCLEANED_ONMOUNTED',
          message: msg,
          severity: 'HIGH'
        });
      }
    }
  }

  return warnings;
}

/**
 * Analyzes the body of a useEffect hook callback for rules 1 & 2.
 * Includes robust multi-level Taint/Dataflow Analysis to trace local variables
 * and helper function invocations recursively.
 */
function analyzeEffectCallbackBody(callbackNode, effectNode, warnings) {
  let hasSubscription = false;
  let subscriptionName = '';
  let hasCleanupReturn = false;
  let hasAsyncOrFetch = false;
  let asyncMethodName = '';

  let cleanupSetsFlag = false;
  let cleanupAborts = false;
  let hasFlagVar = false;
  let flagVarName = '';
  let hasAbortController = false;
  let abortControllerName = '';

  const registeredListeners = [];
  const removedListeners = [];

  // Local function registry for dataflow tracking (name -> node body)
  const localFunctions = {};

  const bodyPath = callbackNode.body;

  // Traverse useEffect body to register declarations and examine triggers
  function traverseBody(node) {
    if (!node) return;

    // 1. Taint tracking: Register function declarations & local arrow variables
    if (node.type === 'VariableDeclaration') {
      for (const decl of node.declarations) {
        if (decl.id.type === 'Identifier' && decl.init) {
          if (decl.init.type === 'ArrowFunctionExpression' || decl.init.type === 'FunctionExpression') {
            localFunctions[decl.id.name] = decl.init.body;
          } else if (decl.init.type === 'NewExpression' && decl.init.callee.name === 'AbortController') {
            hasAbortController = true;
            abortControllerName = decl.id.name;
          } else if (decl.init.type === 'BooleanLiteral' && decl.init.value === true) {
            hasFlagVar = true;
            flagVarName = decl.id.name;
          }
        }
      }
    }

    if (node.type === 'FunctionDeclaration' && node.id?.type === 'Identifier') {
      localFunctions[node.id.name] = node.body;
    }

    // 2. Detect subscription events
    if (node.type === 'CallExpression') {
      const { callee } = node;
      const isFetch = (
        (callee.type === 'Identifier' && (callee.name === 'fetch' || callee.name === 'axios')) ||
        (callee.type === 'MemberExpression' && callee.object.name === 'axios')
      );
      if (isFetch) {
        hasAsyncOrFetch = true;
        asyncMethodName = callee.name || 'axios';
      }

      const isSub = (
        (callee.type === 'MemberExpression' && callee.property.name === 'addEventListener') ||
        (callee.type === 'Identifier' && (callee.name === 'setInterval' || callee.name === 'setTimeout' || callee.name === 'subscribe')) ||
        (callee.type === 'MemberExpression' && (callee.property.name === 'on' || callee.property.name === 'subscribe'))
      );
      if (isSub) {
        hasSubscription = true;
        subscriptionName = callee.name || callee.property?.name || 'subscription';
      }

      // Track addEventListener
      if (
        callee.type === 'MemberExpression' &&
        callee.property.name === 'addEventListener'
      ) {
        const target = callee.object.name || 'window';
        const eventName = node.arguments[0]?.value || 'event';
        const handler = node.arguments[1]?.name || (node.arguments[1]?.type === 'Identifier' ? node.arguments[1].name : null);
        registeredListeners.push({ target, eventName, handler, line: node.loc?.start.line, type: 'event' });
      }

      // Track setInterval / setTimeout
      if (callee.type === 'Identifier' && (callee.name === 'setInterval' || callee.name === 'setTimeout')) {
        registeredListeners.push({ target: 'timer', eventName: callee.name, handler: null, line: node.loc?.start.line, type: 'timer' });
      }
    }

    if (node.type === 'NewExpression' && node.callee.name === 'WebSocket') {
      hasSubscription = true;
      subscriptionName = 'WebSocket';
    }

    if (node.type === 'AwaitExpression') {
      hasAsyncOrFetch = true;
      asyncMethodName = 'await';
    }

    // 3. Taint tracking: Process ReturnStatement
    if (node.type === 'ReturnStatement' && node.argument) {
      const retArg = node.argument;
      if (
        retArg.type === 'ArrowFunctionExpression' ||
        retArg.type === 'FunctionExpression' ||
        retArg.type === 'Identifier'
      ) {
        hasCleanupReturn = true;

        if (retArg.type === 'ArrowFunctionExpression' || retArg.type === 'FunctionExpression') {
          checkCleanupBody(retArg.body);
        } else if (retArg.type === 'Identifier') {
          const body = localFunctions[retArg.name];
          if (body) {
            checkCleanupBody(body);
          }
        }
      }
    }

    // Recurse children
    for (const key in node) {
      if (node[key] && typeof node[key] === 'object') {
        if (Array.isArray(node[key])) {
          node[key].forEach(traverseBody);
        } else if (node[key].type) {
          traverseBody(node[key]);
        }
      }
    }
  }

  // Recursively inspect a cleanup function body for event removal or state flag updating
  function checkCleanupBody(node) {
    if (!node) return;

    if (node.type === 'AssignmentExpression') {
      if (
        node.left.type === 'Identifier' &&
        node.left.name === flagVarName &&
        node.right.type === 'BooleanLiteral' &&
        node.right.value === false
      ) {
        cleanupSetsFlag = true;
      }
    }

    if (node.type === 'CallExpression') {
      const { callee } = node;
      if (
        callee.type === 'MemberExpression' &&
        callee.object.name === abortControllerName &&
        callee.property.name === 'abort'
      ) {
        cleanupAborts = true;
      }

      // Track removeEventListener
      if (
        callee.type === 'MemberExpression' &&
        callee.property.name === 'removeEventListener'
      ) {
        const target = callee.object.name || 'window';
        const eventName = node.arguments[0]?.value || 'event';
        const handler = node.arguments[1]?.name || (node.arguments[1]?.type === 'Identifier' ? node.arguments[1].name : null);
        removedListeners.push({ target, eventName, handler, type: 'event' });
      }

      // Track clearInterval / clearTimeout
      if (callee.type === 'Identifier' && (callee.name === 'clearInterval' || callee.name === 'clearTimeout')) {
        const expectedTimer = callee.name === 'clearInterval' ? 'setInterval' : 'setTimeout';
        removedListeners.push({ target: 'timer', eventName: expectedTimer, handler: null, type: 'timer' });
      }

      // Taint analysis recursive trace: check if it calls a registered helper function
      if (callee.type === 'Identifier') {
        const nestedBody = localFunctions[callee.name];
        if (nestedBody) {
          checkCleanupBody(nestedBody);
        }
      }
    }

    // Recurse children
    for (const key in node) {
      if (node[key] && typeof node[key] === 'object') {
        if (Array.isArray(node[key])) {
          node[key].forEach(checkCleanupBody);
        } else if (node[key].type) {
          checkCleanupBody(node[key]);
        }
      }
    }
  }

  traverseBody(bodyPath);

  // --- RULE 1: Uncleaned Subscriptions ---
  if (hasSubscription && !hasCleanupReturn) {
    warnings.push({
      line: effectNode.loc?.start.line,
      ruleId: 'EFFECT_UNCLEANED_SUBSCRIPTION',
      message: `Active subscription/listener ("${subscriptionName}") established inside useEffect without returning a cleanup function. This will lead to severe memory leaks and unexpected state updates after the component unmounts.`,
      severity: 'HIGH'
    });
  }

  // Detailed Event/Timer Cleanup matching check
  if (registeredListeners.length > 0 && hasCleanupReturn) {
    for (const listener of registeredListeners) {
      const hasMatchingCleanup = removedListeners.some(r => 
        r.type === listener.type &&
        r.target === listener.target &&
        r.eventName === listener.eventName &&
        (!listener.handler || !r.handler || r.handler === listener.handler)
      );
      
      if (!hasMatchingCleanup) {
        warnings.push({
          line: listener.line || effectNode.loc?.start.line,
          ruleId: 'EFFECT_UNCLEANED_SUBSCRIPTION',
          message: listener.type === 'event'
            ? `Event listener for "${listener.eventName}" on "${listener.target}" added inside useEffect is not cleaned up inside the returned cleanup function, or cleanup event/handler reference is mismatched.`
            : `Active timer created via "${listener.eventName}" inside useEffect is not cleared inside the returned cleanup function. Call clearInterval/clearTimeout to prevent memory leaks.`,
          severity: 'HIGH'
        });
      }
    }
  }

  // --- RULE 2: Missing Async Race Condition Guard ---
  if (hasAsyncOrFetch) {
    const hasGuard = (hasFlagVar && cleanupSetsFlag) || (hasAbortController && cleanupAborts);
    if (!hasGuard) {
      warnings.push({
        line: effectNode.loc?.start.line,
        ruleId: 'EFFECT_UNGUARDED_ASYNC',
        message: `Asynchronous action ("${asyncMethodName}") executed inside useEffect without a race condition guard. If the component unmounts or dependencies change before the request resolves, a state update will occur on an unmounted component. Return a cleanup function that aborts the request or uses a mounting flag.`,
        severity: 'MEDIUM'
      });
    }
  }
}

/**
 * Verifies if the JS/TS/JSX/TSX (or Svelte/Vue script) contains valid syntax.
 * @param {string} code - The source code to verify.
 * @param {string} filePath - The file path.
 * @returns {{valid: boolean, error?: string}} Analysis result.
 */
export function verifySyntax(code, filePath) {
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

