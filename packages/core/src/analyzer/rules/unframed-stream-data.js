export default {
  id: 'UNFRAMED_STREAM_DATA',
  version: '1.0.0',
  description: 'Unframed TCP/Stream data buffering issues',
  severity: 'HIGH',
  create(context) {
    return {
      CallExpression(path) {
        const { node } = path;
        const { callee } = node;

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
                  const arg = subPath.node.arguments[0];
                  if (arg && (arg.type === 'Identifier' || (arg.type === 'CallExpression' && arg.callee.property?.name === 'toString'))) {
                    usesJsonParseDirectly = true;
                  }
                }
              },
              AssignmentExpression(subPath) {
                const { operator } = subPath.node;
                if (operator === '+=' || operator === '=') {
                  accumulationsFound = true;
                }
              }
            });

            if (usesJsonParseDirectly && !accumulationsFound) {
              context.report({
                line: node.loc?.start.line,
                message: 'Potential message framing / packet fragmentation bug. Reading raw stream "data" events and parsing JSON directly without buffering or length-framing can result in crash/corruption when packets split or merge.'
              });
            }
          }
        }
      }
    };
  }
};
