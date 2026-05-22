import fs from 'fs';
import path from 'path';
import * as parser from '@babel/parser';
import _traverse from '@babel/traverse';
const traverse = _traverse.default || _traverse;

/**
 * Preprocesses Svelte/Vue files to extract script tag contents for parsing.
 */
function preprocessVueSvelte(code) {
  let processed = '';
  let inScript = false;
  const lines = code.split('\n');
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/<script\b[^>]*>/i.test(line)) {
      inScript = true;
      processed += '\n';
    } else if (/<\/script>/i.test(line)) {
      inScript = false;
      processed += '\n';
    } else {
      if (inScript) {
        processed += line + '\n';
      } else {
        processed += '\n';
      }
    }
  }
  return processed;
}

/**
 * Checks if a file path or its content represents a high-risk domain.
 */
export function isHighRiskFile(filePath, code = '') {
  const highRiskRegex = /checkout|payment|billing|auth|login|card|wallet/i;
  if (highRiskRegex.test(path.basename(filePath))) {
    return true;
  }
  if (code && highRiskRegex.test(code)) {
    return true;
  }
  return false;
}

/**
 * Parses a file and extracts all local import/require declarations.
 */
export function extractImports(code, filePath) {
  const imports = [];
  const plugins = ['jsx'];
  if (/\.tsx?$/i.test(filePath)) {
    plugins.push('typescript');
  } else {
    plugins.push('flow');
  }

  let codeToParse = code;
  if (/\.(svelte|vue)$/i.test(filePath)) {
    codeToParse = preprocessVueSvelte(code);
  }

  try {
    const ast = parser.parse(codeToParse, {
      sourceType: 'module',
      plugins,
      allowImportExportEverywhere: true,
      allowReturnOutsideFunction: true
    });

    traverse(ast, {
      ImportDeclaration({ node }) {
        if (node.source && node.source.value) {
          imports.push(node.source.value);
        }
      },
      CallExpression({ node }) {
        // Handle require('...') or import('...')
        const isRequire = node.callee.type === 'Identifier' && node.callee.name === 'require';
        const isDynamicImport = node.callee.type === 'Import';
        if ((isRequire || isDynamicImport) && node.arguments.length > 0) {
          const arg = node.arguments[0];
          if (arg.type === 'StringLiteral') {
            imports.push(arg.value);
          }
        }
      }
    });
  } catch (err) {
    // Suppress parsing errors for dependency extraction
  }

  return imports;
}

/**
 * Recursively scans a directory for analyzable files.
 */
export function scanDirectory(dir, fileList = []) {
  if (!fs.existsSync(dir)) return fileList;
  const files = fs.readdirSync(dir);
  for (const file of files) {
    const filePath = path.join(dir, file);
    const stat = fs.statSync(filePath);
    if (stat.isDirectory()) {
      if (file !== 'node_modules' && file !== '.git' && file !== 'dist') {
        scanDirectory(filePath, fileList);
      }
    } else {
      const ext = path.extname(file).toLowerCase();
      if (['.js', '.jsx', '.ts', '.tsx', '.svelte', '.vue'].includes(ext)) {
        fileList.push(filePath);
      }
    }
  }
  return fileList;
}

/**
 * Builds the complete Dependency Graph of the workspace.
 * Map structure: file -> Set of files importing it (incoming edges for quick upwards traversal)
 */
export function buildDependencyGraph(workspaceDir) {
  const graph = new Map(); // targetFile -> Set of files that import it
  const highRiskFiles = new Set();
  const allFiles = scanDirectory(workspaceDir);

  const resolveImportPath = (sourceFile, importStr) => {
    if (!importStr.startsWith('.')) return null; // Ignore external npm packages
    const dir = path.dirname(sourceFile);
    let resolved = path.resolve(dir, importStr);
    
    const extensions = ['', '.js', '.jsx', '.ts', '.tsx', '.svelte', '.vue'];
    for (const ext of extensions) {
      const candidate = resolved + ext;
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
        return candidate;
      }
      
      // Handle folder imports (e.g. ./components/Button -> ./components/Button/index.js)
      const indexCandidate = path.join(resolved, 'index' + ext);
      if (fs.existsSync(indexCandidate) && fs.statSync(indexCandidate).isFile()) {
        return indexCandidate;
      }
    }
    return null;
  };

  for (const file of allFiles) {
    const absoluteFile = path.resolve(file);
    let code = '';
    try {
      code = fs.readFileSync(absoluteFile, 'utf8');
    } catch (e) {
      continue;
    }

    if (isHighRiskFile(absoluteFile, code)) {
      highRiskFiles.add(absoluteFile);
    }

    const imports = extractImports(code, absoluteFile);
    for (const imp of imports) {
      const resolved = resolveImportPath(absoluteFile, imp);
      if (resolved) {
        if (!graph.has(resolved)) {
          graph.set(resolved, new Set());
        }
        graph.get(resolved).add(absoluteFile);
      }
    }
  }

  return { graph, highRiskFiles };
}

/**
 * Performs a BFS/DFS traversal to find if a file is transitively imported by any high-risk file.
 * Returns the path (array of files) from source to the high-risk file, or null.
 */
export function findPathToHighRisk(sourceFile, graph, highRiskFiles, visited = new Set()) {
  const normalizedSource = path.resolve(sourceFile);
  if (highRiskFiles.has(normalizedSource)) {
    return [normalizedSource];
  }

  visited.add(normalizedSource);
  const importers = graph.get(normalizedSource);
  if (!importers) return null;

  for (const importer of importers) {
    if (visited.has(importer)) continue;
    
    const route = findPathToHighRisk(importer, graph, highRiskFiles, visited);
    if (route) {
      return [normalizedSource, ...route];
    }
  }

  return null;
}
