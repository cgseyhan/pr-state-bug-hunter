export default {
  id: 'REACT_DIRECT_STATE_MUTATION',
  version: '1.0.0',
  description: 'Direct state mutation hazard.',
  severity: 'HIGH',
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
                AssignmentExpression(subPath) {
                  const { left } = subPath.node;
                  if (
                    left.type === 'MemberExpression' &&
                    left.object.type === 'Identifier' &&
                    left.object.name === stateVarName
                  ) {
                    context.report({
                      line: subPath.node.loc?.start.line || node.loc?.start.line,
                      message: `Direct state mutation hazard. Mutating state variable "${stateVarName}" directly ("${stateVarName}.${left.property.name || 'property'} = ...") instead of using the setter "${setterName}" will not trigger a re-render and violates React unidirectional data flow patterns.`
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
                      context.report({
                        line: subPath.node.loc?.start.line || node.loc?.start.line,
                        message: `Direct state mutation hazard. Calling mutating array method "${method}" directly on state variable "${stateVarName}" instead of using the setter "${setterName}" bypasses React's state tracking. Create a shallow copy first and update via the setter.`
                      });
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
