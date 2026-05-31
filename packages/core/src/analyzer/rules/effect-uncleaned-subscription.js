import { analyzeEffectCallbackBody } from './utils/reactEffectAnalyzer.js';

export default {
  id: 'EFFECT_UNCLEANED_SUBSCRIPTION',
  version: '1.0.0',
  description: 'Active subscription/listener established inside useEffect without returning a cleanup function.',
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

          if (
            effectCallback.type === 'ArrowFunctionExpression' ||
            effectCallback.type === 'FunctionExpression'
          ) {
            const analysis = analyzeEffectCallbackBody(effectCallback, node);

            if (analysis.hasSubscription && !analysis.hasCleanupReturn) {
              context.report({
                line: node.loc?.start.line,
                message: `Active subscription/listener ("${analysis.subscriptionName}") established inside useEffect without returning a cleanup function. This will lead to severe memory leaks and unexpected state updates after the component unmounts.`
              });
            }

            if (analysis.registeredListeners.length > 0 && analysis.hasCleanupReturn) {
              for (const listener of analysis.registeredListeners) {
                const hasMatchingCleanup = analysis.removedListeners.some(r => 
                  r.type === listener.type &&
                  r.target === listener.target &&
                  r.eventName === listener.eventName &&
                  (!listener.handler || !r.handler || r.handler === listener.handler)
                );
                
                if (!hasMatchingCleanup) {
                  context.report({
                    line: listener.line || node.loc?.start.line,
                    message: listener.type === 'event'
                      ? `Event listener for "${listener.eventName}" on "${listener.target}" added inside useEffect is not cleaned up inside the returned cleanup function, or cleanup event/handler reference is mismatched.`
                      : `Active timer created via "${listener.eventName}" inside useEffect is not cleared inside the returned cleanup function. Call clearInterval/clearTimeout to prevent memory leaks.`
                  });
                }
              }
            }
          }
        }
      }
    };
  }
};
