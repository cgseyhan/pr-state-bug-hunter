export default {
  id: 'SVELTE_UNCLEANED_SUBSCRIBE',
  version: '1.0.0',
  description: 'Svelte manual store subscription executed without storing the unsubscribe reference.',
  severity: 'HIGH',
  create(context) {
    if (!context.isSvelte) return {};

    const svelteSubs = {};
    const svelteOnDestroyCalls = [];

    return {
      CallExpression(path) {
        const { node } = path;
        const { callee } = node;

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
            context.report({
              line: node.loc?.start.line,
              message: 'Svelte manual store subscription executed without storing the unsubscribe reference. This makes it impossible to clean up, causing memory leaks.'
            });
          }
        }

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
      },

      VariableDeclarator(path) {
        const { node } = path;
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
      },

      onProgramExit() {
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
            context.report({
              line: subInfo.line,
              message: `Svelte manual store subscription "${subName}" is never cleaned up. Memory leak hazard. Call the unsubscribe function in Svelte's onDestroy lifecycle hook.`
            });
          }
        }
      }
    };
  }
};
