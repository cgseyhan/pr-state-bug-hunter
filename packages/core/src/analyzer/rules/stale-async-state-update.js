export default {
  id: 'STALE_ASYNC_STATE_UPDATE',
  version: '1.0.0',
  description: 'Stale async state update.',
  severity: 'MEDIUM',
  create(context) {
    return {
      VariableDeclarator(path) {
        const { node } = path;

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

            const componentScope = path.getFunctionParent();
            if (componentScope) {
              componentScope.traverse({
                CallExpression(subPath) {
                  if (subPath.node.callee.name === setterName) {
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
                      const arg = subPath.node.arguments[0];
                      if (arg && arg.type !== 'ArrowFunctionExpression' && arg.type !== 'FunctionExpression') {
                        let readsStateVar = false;
                        subPath.traverse({
                          Identifier(idPath) {
                            if (idPath.node.name === stateVarName && idPath.parent.type !== 'MemberExpression') {
                              readsStateVar = true;
                            }
                          }
                        });

                        if (readsStateVar) {
                          context.report({
                            line: subPath.node.loc?.start.line || node.loc?.start.line,
                            message: `Stale state closure hazard. React state setter "${setterName}" reads state variable "${stateVarName}" directly inside an asynchronous flow. If state changes before this completes, updates will be overwritten. Use the functional updater form instead: \`${setterName}(prev => ...)\`.`
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
    };
  }
};
