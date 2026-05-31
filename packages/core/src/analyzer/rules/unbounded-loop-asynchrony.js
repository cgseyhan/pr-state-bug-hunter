export default {
  id: 'UNBOUNDED_LOOP_ASYNCHRONY',
  version: '1.0.0',
  description: 'Unbounded async loop execution.',
  severity: 'MEDIUM',
  create(context) {
    return {
      CallExpression(path) {
        const { node } = path;
        const { callee } = node;

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
            context.report({
              line: callback.loc?.start.line || node.loc?.start.line,
              message: `Unbounded async loop execution. Calling async/await directly inside "${callee.property.name}" does not await executions sequentially or limit concurrency, which can cause network congestion or state races. Use "for...of" for sequential execution or "Promise.all" / a concurrency pooler for parallel tracking.`
            });
          }
        }
      }
    };
  }
};
