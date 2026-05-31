/**
 * Analyzes the body of a useEffect hook callback for rules 1 & 2.
 * Includes robust multi-level Taint/Dataflow Analysis to trace local variables
 * and helper function invocations recursively.
 */
export function analyzeEffectCallbackBody(callbackNode, effectNode) {
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

  return {
    hasSubscription,
    subscriptionName,
    hasCleanupReturn,
    hasAsyncOrFetch,
    asyncMethodName,
    registeredListeners,
    removedListeners,
    hasGuard: (hasFlagVar && cleanupSetsFlag) || (hasAbortController && cleanupAborts)
  };
}
