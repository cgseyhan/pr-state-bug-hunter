export default {
  id: 'EFFECT_DIRECT_ASYNC',
  version: '1.0.0',
  description: 'Directly declaring the useEffect callback as "async" is a React anti-pattern. useEffect must return cleanups synchronously.',
  severity: 'HIGH',
  create(context) {
    return {
      CallExpression(path) {
        const { node } = path;
        const { callee } = node;

        const isEffect = (
          (callee.type === 'Identifier' && (callee.name === 'useEffect' || callee.name === 'useLayoutEffect')) ||
          (callee.type === 'MemberExpression' && callee.property.type === 'Identifier' &&
           (callee.property.name === 'useEffect' || callee.property.name === 'useLayoutEffect'))
        );

        if (isEffect && node.arguments.length > 0) {
          const effectCallback = node.arguments[0];

          if (effectCallback.async) {
            context.report({
              line: effectCallback.loc?.start.line || node.loc?.start.line,
              message: 'Directly declaring the useEffect callback as "async" is a React anti-pattern. useEffect must return cleanups synchronously. Declare an async function inside and invoke it.'
            });
          }
        }
      }
    };
  }
};
