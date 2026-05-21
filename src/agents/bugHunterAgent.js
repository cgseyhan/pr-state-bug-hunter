import { GoogleGenerativeAI } from '@google/generative-ai';
import fs from 'fs/promises';
import path from 'path';
import { calculateWarningHash, getCachedFinding, setCachedFinding } from '../analyzer/cacheManager.js';

/**
 * Reads a file from the workspace or falls back to patch context.
 * @param {string} filePath - Path of the file.
 * @returns {Promise<string|null>} File contents or null if not found.
 */
async function getFileContent(filePath) {
  try {
    // Attempt to read from checked-out workspace
    const content = await fs.readFile(filePath, 'utf8');
    return content;
  } catch (err) {
    console.log(`[Warning]: Could not read local file ${filePath}: ${err.message}`);
    return null;
  }
}

/**
 * Extracts a code block surrounding the target line number for LLM context.
 * @param {string} code - The full source code.
 * @param {number} targetLine - The line number to center the context around.
 * @param {number} contextWindow - Number of lines to include before and after.
 * @returns {string} Fenced code block with context.
 */
function getLineContext(code, targetLine, contextWindow = 15) {
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
 * Clean text if LLM wrapped it in markdown code blocks.
 * Only strips outer backticks if they truly wrap the entire response,
 * protecting any nested markdown code blocks (e.g. proposedFix diffs).
 */
function cleanJsonResponse(text) {
  let cleaned = text.trim();
  
  if (cleaned.startsWith('```')) {
    const firstNewline = cleaned.indexOf('\n');
    const lastBackticks = cleaned.lastIndexOf('```');
    
    // Ensure the last backticks are at the very end of the trimmed string
    if (lastBackticks > firstNewline && lastBackticks >= cleaned.length - 4) {
      cleaned = cleaned.substring(firstNewline + 1, lastBackticks).trim();
    }
  }
  
  return cleaned;
}

/**
 * Robustly extracts an array from a JSON parsed response,
 * handling both direct arrays and arrays wrapped in a JSON object.
 */
function extractIssuesArray(jsonResponse) {
  if (Array.isArray(jsonResponse)) {
    return jsonResponse;
  }
  if (jsonResponse && typeof jsonResponse === 'object') {
    if (Array.isArray(jsonResponse.issues)) return jsonResponse.issues;
    if (Array.isArray(jsonResponse.bugs)) return jsonResponse.bugs;
    if (Array.isArray(jsonResponse.response)) return jsonResponse.response;
    if (Array.isArray(jsonResponse.warnings)) return jsonResponse.warnings;
    
    // Fallback: search for any array field
    for (const key of Object.keys(jsonResponse)) {
      if (Array.isArray(jsonResponse[key])) {
        return jsonResponse[key];
      }
    }
  }
  return null;
}

/**
 * Call OpenAI API or OpenAI-compatible Local AI API using native fetch.
 */
async function callOpenAI(apiKey, prompt, modelName = 'gpt-4o-mini', apiBaseUrl = 'https://api.openai.com/v1') {
  try {
    const base = apiBaseUrl.endsWith('/') ? apiBaseUrl.slice(0, -1) : apiBaseUrl;
    const response = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: modelName,
        response_format: { type: 'json_object' },
        messages: [
          {
            role: 'system',
            content: 'You are an elite software architect and security auditor specializing in code auditing. You must respond strictly in JSON format.'
          },
          {
            role: 'user',
            content: prompt
          }
        ],
        temperature: 0.1
      })
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`AI API returned status ${response.status}: ${errText}`);
    }

    const data = await response.json();
    return data.choices[0]?.message?.content || '[]';
  } catch (err) {
    console.error(`AI invocation failed: ${err.message}`);
    throw err;
  }
}

/**
 * Invokes either Gemini or OpenAI model dynamically to analyze code snippets and diffs for asynchronous state bugs and race conditions.
 * @param {string} apiKey - API Key (Gemini or OpenAI starting with 'sk-').
 * @param {Array<{path: string, patch: string, changedLines: number[]}>} changes - File changes.
 * @param {Array<{line: number, ruleId: string, message: string, severity: string, path: string}>} astWarnings - AST warnings.
 * @param {string} modelName - Model name to use (defaults to gemini-1.5-flash or gpt-4o-mini depending on key).
 * @returns {Promise<Array<{filePath: string, line: number, ruleId: string, isRealBug: boolean, severity: string, explanation: string, proposedFix: string}>>}
 */
export async function huntStateBugsWithGemini(apiKey, changes, astWarnings, modelName = 'gemini-1.5-flash', localOptions = {}) {
  const localBaseUrl = localOptions.apiBaseUrl || process.env.LOCAL_AI_BASE_URL;
  const localModel = localOptions.modelName || process.env.LOCAL_MODEL_NAME;
  const isLocalAI = !!localBaseUrl;

  if (!apiKey && !isLocalAI) {
    console.log("No API Key or Local AI Base URL provided. Skipping AI analysis step.");
    return [];
  }

  const isOpenAI = apiKey ? apiKey.startsWith('sk-') : false;
  
  let actualModel = modelName;
  if (isLocalAI) {
    actualModel = localModel || modelName || 'llama3';
  } else if (isOpenAI) {
    actualModel = modelName === 'gemini-1.5-flash' ? 'gpt-4o-mini' : modelName;
  }

  console.log(`AI Agent utilizing provider: ${isLocalAI ? 'Local AI' : (isOpenAI ? 'OpenAI' : 'Google Gemini')} (${actualModel})`);

  let genAI = null;
  let geminiModel = null;

  if (!isLocalAI && !isOpenAI) {
    genAI = new GoogleGenerativeAI(apiKey);
    geminiModel = genAI.getGenerativeModel({
      model: actualModel,
      generationConfig: {
        responseMimeType: 'application/json'
      }
    });
  }

  const verifiedIssues = [];

  // Group AST warnings by file path
  const warningsByFile = {};
  for (const warning of astWarnings) {
    if (!warningsByFile[warning.path]) {
      warningsByFile[warning.path] = [];
    }
    warningsByFile[warning.path].push(warning);
  }

  // Iterate through changed files
  for (const change of changes) {
    const filePath = change.path;
    const fileWarnings = warningsByFile[filePath] || [];

    // Attempt to load full file content
    const fileContent = await getFileContent(filePath);

    if (fileWarnings.length > 0) {
      // Prepare context blocks for each AST warning in the file, checking cache first
      const warningContexts = [];
      const contextSnippetMap = new Map();

      for (const warning of fileWarnings) {
        let codeSnippet = '';
        if (fileContent) {
          codeSnippet = getLineContext(fileContent, warning.line);
        } else {
          // Fallback to git patch if file cannot be read from workspace
          codeSnippet = `Diff Patch:\n${change.patch}`;
        }

        const hash = calculateWarningHash(filePath, warning.line, warning.ruleId, codeSnippet);
        const cached = getCachedFinding(hash);

        if (cached) {
          console.log(`[Cache Hit] Reusing cached semantic audit for ${filePath}:${warning.line} (${warning.ruleId})`);
          if (cached.isRealBug) {
            verifiedIssues.push({
              filePath,
              line: warning.line,
              ruleId: warning.ruleId,
              severity: cached.severity || warning.severity || 'MEDIUM',
              explanation: cached.explanation,
              proposedFix: cached.proposedFix
            });
          }
        } else {
          warningContexts.push({
            line: warning.line,
            ruleId: warning.ruleId,
            staticMessage: warning.message,
            staticSeverity: warning.warningSeverity || warning.severity || 'MEDIUM',
            codeSnippet
          });
          contextSnippetMap.set(`${warning.line}:${warning.ruleId}`, codeSnippet);
        }
      }

      if (warningContexts.length === 0) {
        console.log(`[Cache Complete] All warnings for ${filePath} resolved from cache!`);
        continue;
      }

      console.log(`AI Agent is analyzing ${warningContexts.length} uncached AST warnings for file: ${filePath}...`);

      const prompt = `
You are an elite software architect and security auditor specializing in modern web runtimes, asynchronous state flows, React lifecycle synchronization, and message-boundary network stream transport.

You are reviewing a pull request. Below are suspicious code patterns detected by our AST scanner in the file \`${filePath}\`.

For each static analysis warning, perform a deep semantic review to verify if it constitutes a real, logical bug or race condition.

### AST Warnings and Code Context:
${JSON.stringify(warningContexts, null, 2)}

### Task Instructions:
1. Review each warning in the list.
2. Determine if it is a "real bug" (\`isRealBug: true\`) or a false positive (\`isRealBug: false\`).
3. For verified bugs, provide a clear, professional, and empathetic explanation explaining exactly *how* the race condition, stale state, memory leak, or buffering error occurs.
4. Provide a high-quality \`proposedFix\` formatted as a complete drop-in replacement code block (only the corrected lines/block, not the entire file) that should replace the entire \`codeSnippet\` context block.

Return your response strictly as a JSON array of objects with this structure (no conversational text outside the array):
[
  {
    "line": 42,
    "ruleId": "EFFECT_UNGUARDED_ASYNC",
    "isRealBug": true,
    "severity": "HIGH",
    "explanation": "Why this is a bug, the async workflow failure mode, and its impact.",
    "proposedFix": "Code block that drops in to replace the entire codeSnippet context block"
  }
]
`;

      try {
        let text = '';
        if (isLocalAI || isOpenAI) {
          const apiBase = localBaseUrl || 'https://api.openai.com/v1';
          const key = apiKey || 'local-key';
          text = await callOpenAI(key, prompt, actualModel, apiBase);
        } else {
          const response = await geminiModel.generateContent(prompt);
          text = response.response.text();
        }

        text = cleanJsonResponse(text);

        const jsonResponse = JSON.parse(text.trim());
        const issuesArray = extractIssuesArray(jsonResponse);

        if (Array.isArray(issuesArray)) {
          for (const item of issuesArray) {
            // Find corresponding code snippet to compute warning hash
            const key = `${item.line}:${item.ruleId}`;
            const snippet = contextSnippetMap.get(key) || '';
            const hash = calculateWarningHash(filePath, item.line, item.ruleId, snippet);

            // Cache the result for future runs
            setCachedFinding(hash, {
              isRealBug: item.isRealBug,
              severity: item.severity || 'MEDIUM',
              explanation: item.explanation,
              proposedFix: item.proposedFix
            });

            if (item.isRealBug) {
              verifiedIssues.push({
                filePath,
                line: item.line,
                ruleId: item.ruleId,
                severity: item.severity || 'MEDIUM',
                explanation: item.explanation,
                proposedFix: item.proposedFix
              });
            }
          }
        }
      } catch (err) {
        console.error(`AI analysis failed for file ${filePath}: ${err.message}`);
      }
    } else {
      // Rule 6: General deep scan of diff for logical concurrency bugs if no AST warning hit
      const hash = calculateWarningHash(filePath, 0, 'GENERAL_DIFF_SCAN', change.patch);
      const cached = getCachedFinding(hash);

      if (cached) {
        console.log(`[Cache Hit] Reusing cached general diff scan results for ${filePath}`);
        if (Array.isArray(cached)) {
          for (const item of cached) {
            if (item.isRealBug) {
              verifiedIssues.push({
                filePath,
                line: item.line,
                ruleId: item.ruleId || 'GENERAL_ASYNC_BUG',
                severity: item.severity || 'MEDIUM',
                explanation: item.explanation,
                proposedFix: item.proposedFix
              });
            }
          }
        }
        continue;
      }

      console.log(`AI Agent is performing general diff audit for file: ${filePath}...`);
      
      const prompt = `
You are an elite software architect and security auditor.
Analyze the following pull request diff for file \`${filePath}\` specifically searching for asynchronous state bugs, race conditions, memory leaks, unhandled promises, or missing locks in event handlers.

### Git Diff:
\`\`\`diff
${change.patch}
\`\`\`

### Task Instructions:
Identify any critical logical concurrency or state-flow bugs introduced in this diff. If none exist, return an empty array.
If bugs are found, return a JSON array containing the details.

Return your response strictly as a JSON array of objects with this structure (no conversational text outside the array):
[
  {
    "line": 15,
    "ruleId": "LOGICAL_CONCURRENCY_BUG",
    "isRealBug": true,
    "severity": "MEDIUM",
    "explanation": "Description of why there is a race condition or state conflict.",
    "proposedFix": "Corrected code block or diff"
  }
]
`;

      try {
        let text = '';
        if (isLocalAI || isOpenAI) {
          const apiBase = localBaseUrl || 'https://api.openai.com/v1';
          const key = apiKey || 'local-key';
          text = await callOpenAI(key, prompt, actualModel, apiBase);
        } else {
          const response = await geminiModel.generateContent(prompt);
          text = response.response.text();
        }

        text = cleanJsonResponse(text);

        const jsonResponse = JSON.parse(text.trim());
        const issuesArray = extractIssuesArray(jsonResponse) || [];

        // Save finding array to cache
        setCachedFinding(hash, issuesArray);

        if (Array.isArray(issuesArray)) {
          for (const item of issuesArray) {
            if (item.isRealBug) {
              verifiedIssues.push({
                filePath,
                line: item.line,
                ruleId: item.ruleId || 'GENERAL_ASYNC_BUG',
                severity: item.severity || 'MEDIUM',
                explanation: item.explanation,
                proposedFix: item.proposedFix
              });
            }
          }
        }
      } catch (err) {
        console.error(`General AI analysis failed for ${filePath}: ${err.message}`);
      }
    }
  }

  console.log(`AI Agent verified ${verifiedIssues.length} real logical/state bugs in the PR.`);
  return verifiedIssues;
}

