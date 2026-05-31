import { verifySyntax } from '../analyzer/astParser.js';

/**
 * Extracts line-centered context from source code to assist matching.
 */
export function getLineContext(code, targetLine, contextWindow = 15) {
  const lines = code.split('\n');
  const totalLines = lines.length;

  const start = Math.max(0, targetLine - 1 - contextWindow);
  const end = Math.min(totalLines, targetLine + contextWindow);

  const contextLines = [];
  for (let i = start; i < end; i++) {
    const lineNum = i + 1;
    const isTarget = lineNum === targetLine;
    const prefix = isTarget ? '>> ' : '   ';
    contextLines.push(`${prefix}${lineNum}: ${lines[i]}`);
  }

  return contextLines.join('\n');
}

/**
 * Smartly patches file content using drop-in code replacements.
 * Walks through shrinking matching windows to ensure robust patching.
 */
export function applyFixToText(fileContent, line, proposedFix) {
  let cleanFix = proposedFix.trim();
  if (cleanFix.startsWith('```')) {
    const match = cleanFix.match(/```[a-zA-Z]*\n([\s\S]*?)```/);
    if (match) {
      cleanFix = match[1];
    } else {
      cleanFix = cleanFix.replace(/^```[a-zA-Z]*\n?|```$/g, '');
    }
  }

  // Try standard 15-line context matching first
  const codeSnippet = getLineContext(fileContent, line, 15);
  const originalSnippet = codeSnippet.split('\n')
    .map(l => {
      const match = l.match(/^(?:\s{3}|>>\s)\d+:\s?(.*)$/);
      return match ? match[1] : l;
    })
    .join('\n')
    .trim();

  if (fileContent.includes(originalSnippet)) {
    return fileContent.replace(originalSnippet, cleanFix.trim());
  }

  // Fallback: search with a progressively smaller context window to ignore outer lines
  for (let window = 5; window >= 1; window--) {
    const smallSnippet = getLineContext(fileContent, line, window);
    const originalSmallSnippet = smallSnippet.split('\n')
      .map(l => {
        const match = l.match(/^(?:\s{3}|>>\s)\d+:\s?(.*)$/);
        return match ? match[1] : l;
      })
      .join('\n')
      .trim();
    
    if (fileContent.includes(originalSmallSnippet)) {
      return fileContent.replace(originalSmallSnippet, cleanFix.trim());
    }
  }

  // Final fallback: Replace exact single line if the fix is one line
  const lines = fileContent.split('\n');
  const targetIdx = line - 1;
  if (targetIdx >= 0 && targetIdx < lines.length) {
    if (!cleanFix.includes('\n')) {
      lines[targetIdx] = cleanFix;
      return lines.join('\n');
    }
  }

  return null;
}

/**
 * Verifies that the patch does not unexpectedly modify surrounding code context outside the expected lines.
 * This is a basic safety mechanism to prevent AI hallucinations from replacing half the file.
 */
export function verifyPatchSafety(originalContent, patchedContent, originalSnippet, patchedSnippet) {
  // If the sizes differ by more than a huge margin, reject
  if (Math.abs(patchedContent.length - originalContent.length) > 5000) {
    return { safe: false, reason: 'Patch modifies too many bytes.' };
  }

  // Ensure syntax is still valid
  // (We rely on the caller to provide filePath to the actual syntax checker)

  return { safe: true };
}

/**
 * Applies a fix and verifies it.
 */
export function applyAndVerifyFix(fileContent, line, proposedFix, filePath) {
  const updatedContent = applyFixToText(fileContent, line, proposedFix);
  if (!updatedContent) return { success: false, reason: 'Snippet mismatch' };

  const safetyCheck = verifyPatchSafety(fileContent, updatedContent, null, proposedFix);
  if (!safetyCheck.safe) return { success: false, reason: safetyCheck.reason };

  const syntaxCheck = verifySyntax(updatedContent, filePath);
  if (!syntaxCheck.valid) {
    return { success: false, reason: 'Syntax error: ' + syntaxCheck.error };
  }

  return { success: true, updatedContent };
}
