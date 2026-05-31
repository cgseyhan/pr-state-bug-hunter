import { analyzeEffectCallbackBody } from './utils/reactEffectAnalyzer.js';

export default {
  id: 'EFFECT_UNGUARDED_ASYNC',
  version: '1.0.0',
  description: 'Asynchronous operation inside useEffect without a cleanup flag or AbortController.',
  severity: 'MEDIUM',
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

          if (
            effectCallback.type === 'ArrowFunctionExpression' ||
            effectCallback.type === 'FunctionExpression'
          ) {
            const analysis = analyzeEffectCallbackBody(effectCallback, node);

            if (analysis.hasAsyncOrFetch) {
              if (!analysis.hasGuard) {
                context.report({
                  line: node.loc?.start.line,
                  message: `Asynchronous operation ("${analysis.asyncMethodName}") inside useEffect without a cleanup flag or AbortController. This causes React state race conditions if the component unmounts or re-renders before the promise resolves.`,
                  severity: 'MEDIUM'
                });
              }
            }
          }
        }
      }
    };
  }
};
