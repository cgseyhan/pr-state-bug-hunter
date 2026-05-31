export default {
  id: 'VUE_UNCLEANED_ONMOUNTED',
  version: '1.0.0',
  description: 'Vue Composition API onMounted listener/interval leak.',
  severity: 'HIGH',
  create(context) {
    if (!context.isVue) return {};

    const vueMountedListeners = [];
    const vueUnmountedCalls = [];

    return {
      CallExpression(path) {
        const { node } = path;
        const { callee } = node;

        if (callee.type === 'Identifier' && callee.name === 'onMounted') {
          if (node.arguments.length > 0) {
            const callback = node.arguments[0];
            if (callback.type === 'ArrowFunctionExpression' || callback.type === 'FunctionExpression') {
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

        if (callee.type === 'Identifier' && (callee.name === 'onUnmounted' || callee.name === 'onBeforeUnmount')) {
          if (node.arguments.length > 0) {
            const callback = node.arguments[0];
            if (callback.type === 'ArrowFunctionExpression' || callback.type === 'FunctionExpression') {
              vueUnmountedCalls.push(callback.body);
            }
          }
        }
      },

      onProgramExit() {
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
            context.report({
              line: listener.line,
              message: msg
            });
          }
        }
      }
    };
  }
};
