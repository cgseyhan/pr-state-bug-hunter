import { GoogleGenerativeAI, SchemaType } from '@google/generative-ai';
import fs from 'fs/promises';
import path from 'path';
import * as parser from '@babel/parser';
import _traverse from '@babel/traverse';
import { generateFingerprint, generateFindingId, getCachedFinding, setCachedFinding } from '../analyzer/cacheManager.js';

const traverse = _traverse.default || _traverse;

const issueSchemaJson = {
  type: "array",
  items: {
    type: "object",
    properties: {
      line: { type: "number" },
      ruleId: { type: "string" },
      isRealBug: { type: "boolean" },
      severity: { type: "string" },
      explanation: { type: "string" },
      proposedFix: { type: "string" },
      proposedTest: { type: "string" }
    },
    required: ["line", "ruleId", "isRealBug", "severity", "explanation", "proposedFix"],
    additionalProperties: false
  }
};

const issueSchemaGemini = {
  type: SchemaType.ARRAY,
  items: {
    type: SchemaType.OBJECT,
    properties: {
      line: { type: SchemaType.NUMBER },
      ruleId: { type: SchemaType.STRING },
      isRealBug: { type: SchemaType.BOOLEAN },
      severity: { type: SchemaType.STRING },
      explanation: { type: SchemaType.STRING },
      proposedFix: { type: SchemaType.STRING },
      proposedTest: { type: SchemaType.STRING }
    },
    required: ["line", "ruleId", "isRealBug", "severity", "explanation", "proposedFix"]
  }
};

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
 * Uses AST parsing to extract the entire enclosing function for semantic context when possible.
 * @param {string} code - The full source code.
 * @param {number} targetLine - The line number to center the context around.
 * @param {number} contextWindow - Number of lines to include before and after if AST fails.
 * @returns {string} Fenced code block with context.
 */
function getLineContext(code, targetLine, contextWindow = 15) {
  let startLine = Math.max(0, targetLine - 1 - contextWindow);
  let endLine = targetLine + contextWindow;

  try {
    const ast = parser.parse(code, {
      sourceType: 'module',
      plugins: ['jsx', 'typescript', 'flow'],
      allowImportExportEverywhere: true,
      allowReturnOutsideFunction: true
    });

    let bestMatch = null;
    traverse(ast, {
      enter(path) {
        if (
          path.isFunction() ||
          path.isClassMethod() ||
          path.isObjectMethod()
        ) {
          const loc = path.node.loc;
          if (loc && loc.start.line <= targetLine && loc.end.line >= targetLine) {
            if (!bestMatch || (loc.end.line - loc.start.line < bestMatch.end.line - bestMatch.start.line)) {
              bestMatch = loc;
            }
          }
        }
      }
    });

    if (bestMatch) {
      startLine = Math.max(0, bestMatch.start.line - 1 - 2); // 2 lines buffer
      endLine = bestMatch.end.line + 2;
    }
  } catch (err) {
    // Fallback to strictly window based context if parsing fails (e.g., raw Svelte/Vue)
  }

  const lines = code.split('\n');
  const totalLines = lines.length;
  endLine = Math.min(totalLines, endLine);

  const contextLines = [];
  for (let i = startLine; i < endLine; i++) {
    const lineNum = i + 1;
    const isTarget = lineNum === targetLine;
    const prefix = isTarget ? '>> ' : '   ';
    contextLines.push(`${prefix}${lineNum}: ${lines[i]}`);
  }

  return contextLines.join('\n');
}

/**
 * Clean text if LLM wrapped it in markdown code blocks.
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
 * Robustly extracts an array from a JSON parsed response.
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
    
    // For OpenAI's structured outputs via json_schema
    const isGptModel = modelName.includes('gpt-4o');
    const responseFormat = isGptModel ? {
      type: "json_schema",
      json_schema: {
        name: "bug_report_array",
        strict: true,
        schema: {
          type: "object",
          properties: {
            issues: issueSchemaJson
          },
          required: ["issues"],
          additionalProperties: false
        }
      }
    } : { type: 'json_object' };

    // If using json_schema, we expect the LLM to return { "issues": [...] }
    const response = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: modelName,
        response_format: responseFormat,
        messages: [
          {
            role: 'system',
            content: 'You are an elite software architect and security auditor. You must respond strictly in JSON format.'
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
 * Pre-filter (Cheap/Fast Model) to determine if a code snippet is suspicious.
 * This saves 80% API costs by ignoring clean code.
 */
async function runPreFilter(apiKey, codeSnippet, isLocalAI, isOpenAI, localBaseUrl, geminiModel) {
  const prompt = `
You are a rapid pre-filter code scanner.
Analyze this code snippet and determine if there is ANY chance of a bug, vulnerability, or logic error.
If the code is perfectly clean, return false. If there is even a slight chance of an issue, return true.

Code:
${codeSnippet}

Respond strictly in JSON format: { "isSuspicious": true } or { "isSuspicious": false }
`;

  try {
    let text = '';
    if (isLocalAI || isOpenAI) {
      const apiBase = localBaseUrl || 'https://api.openai.com/v1';
      const key = apiKey || 'local-key';
      // Force the cheap model for pre-filtering
      const fastModel = isOpenAI ? 'gpt-4o-mini' : 'llama3';
      
      const response = await fetch(`${apiBase.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
        body: JSON.stringify({
          model: fastModel,
          response_format: { type: 'json_object' },
          messages: [{ role: 'system', content: 'Respond with JSON.' }, { role: 'user', content: prompt }],
          temperature: 0.0
        })
      });
      const data = await response.json();
      text = data.choices[0]?.message?.content || '{"isSuspicious": true}';
    } else {
      // Gemini Fast Model
      const result = await geminiModel.generateContent(prompt);
      text = result.response.text();
    }
    
    text = cleanJsonResponse(text);
    const json = JSON.parse(text);
    return json.isSuspicious !== false; // default to true if parsing fails
  } catch (err) {
    console.error(`[Pre-Filter Error] Falling back to deep analysis. Error: ${err.message}`);
    return true; // Default to suspicious to be safe
  }
}

/**
 * Invokes either Gemini or OpenAI model dynamically to analyze code snippets.
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
        responseMimeType: 'application/json',
        responseSchema: issueSchemaGemini
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

        // In bugHunterAgent, repoFullName is not explicitly available unless passed down.
        // I will use 'local' for now, or just extract from github actions later if needed.
        const fingerprint = generateFingerprint('repo', filePath, warning.ruleId, codeSnippet);
        const findingId = generateFindingId(fingerprint);
        const cached = getCachedFinding(fingerprint);

        if (cached) {
          console.log(`[Cache Hit] Reusing cached semantic audit for ${filePath}:${warning.line} (${warning.ruleId})`);
          if (cached.isRealBug) {
            verifiedIssues.push({
              id: findingId,
              fingerprint,
              filePath,
              lineStart: warning.line,
              lineEnd: warning.line,
              line: warning.line, // keep for backwards compatibility internally
              ruleId: warning.ruleId,
              ruleVersion: cached.ruleVersion || warning.ruleVersion || '1.0.0',
              severity: cached.severity || warning.severity || 'MEDIUM',
              confidence: cached.confidence || 'high',
              explanation: cached.explanation,
              evidence: codeSnippet,
              proposedFix: cached.proposedFix,
              suggestedTest: cached.suggestedTest || cached.proposedTest,
              source: 'hybrid',
              status: 'new',
              createdAt: cached.createdAt || new Date().toISOString()
            });
          }
        } else {
          warningContexts.push({
            line: warning.line,
            ruleId: warning.ruleId,
            ruleVersion: warning.ruleVersion,
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

      console.log(`AI Agent is running Pre-Filter on ${warningContexts.length} warnings for ${filePath}...`);
      
      // RUN PRE-FILTER
      const filteredContexts = [];
      for (const ctx of warningContexts) {
        const isSuspicious = await runPreFilter(apiKey, ctx.codeSnippet, isLocalAI, isOpenAI, localBaseUrl, geminiModel);
        if (isSuspicious) {
          filteredContexts.push(ctx);
        } else {
          console.log(`[Pre-Filter] Skipped clean code at line ${ctx.line} (Saved API Cost)`);
          
          // Cache the clean result so we don't pre-filter it again
          const fingerprint = generateFingerprint('repo', filePath, ctx.ruleId, ctx.codeSnippet);
          setCachedFinding(fingerprint, { isRealBug: false, explanation: "Filtered out by pre-filter" });
        }
      }

      if (filteredContexts.length === 0) {
         console.log(`[Pre-Filter Complete] All warnings for ${filePath} were false alarms.`);
         continue;
      }

      console.log(`AI Agent is analyzing ${filteredContexts.length} suspicious AST warnings for file: ${filePath}...`);

      const prompt = `
You are an elite software architect and security auditor specializing in modern web runtimes, asynchronous state flows, React lifecycle synchronization, and message-boundary network stream transport.

You are reviewing a pull request. Below are suspicious code patterns detected by our AST scanner in the file \`${filePath}\`.

For each static analysis warning, perform a deep semantic review to verify if it constitutes a real, logical bug or race condition.

### AST Warnings and Code Context:
${JSON.stringify(filteredContexts, null, 2)}

### Task Instructions:
1. Review each warning in the list.
2. Determine if it is a "real bug" (\`isRealBug: true\`) or a false positive (\`isRealBug: false\`).
3. For verified bugs, provide a clear, professional, and empathetic explanation explaining exactly *how* the race condition, stale state, memory leak, or buffering error occurs.
4. Provide a high-quality \`proposedFix\` formatted as a complete drop-in replacement code block (only the corrected lines/block, not the entire file) that should replace the entire \`codeSnippet\` context block.
5. Provide a \`proposedTest\` field containing a minimal unit test (Jest/Vitest syntax) that reproduces the bug and verifies the fix. Wrap it in a fenced markdown code block.

Return your response strictly as a JSON array of objects with this structure (no conversational text outside the array):
[
  {
    "line": 42,
    "ruleId": "EFFECT_UNGUARDED_ASYNC",
    "isRealBug": true,
    "severity": "HIGH",
    "explanation": "Why this is a bug, the async workflow failure mode, and its impact.",
    "proposedFix": "Code block that drops in to replace the entire codeSnippet context block",
    "proposedTest": "\`\`\`js\ntest('describes the bug scenario', () => { /* minimal reproduction */ });\n\`\`\`"
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
            const key = `${item.line}:${item.ruleId}`;
            const snippet = contextSnippetMap.get(key) || '';
            const fingerprint = generateFingerprint('repo', filePath, item.ruleId, snippet);
            const findingId = generateFindingId(fingerprint);

            const originalWarning = fileWarnings.find(w => w.line === item.line && w.ruleId === item.ruleId);
            const ruleVersion = originalWarning?.ruleVersion || '1.0.0';

            // Cache the result for future runs
            setCachedFinding(fingerprint, {
              isRealBug: item.isRealBug,
              severity: item.severity || 'MEDIUM',
              ruleVersion,
              explanation: item.explanation,
              proposedFix: item.proposedFix,
              suggestedTest: item.proposedTest || null,
              confidence: item.confidence || 'high',
              createdAt: new Date().toISOString()
            });

            if (item.isRealBug) {
              verifiedIssues.push({
                id: findingId,
                fingerprint,
                filePath,
                lineStart: item.line,
                lineEnd: item.line,
                line: item.line,
                ruleId: item.ruleId,
                ruleVersion,
                severity: item.severity || 'MEDIUM',
                confidence: item.confidence || 'high',
                explanation: item.explanation,
                evidence: snippet,
                proposedFix: item.proposedFix,
                suggestedTest: item.proposedTest || null,
                source: 'hybrid',
                status: 'new',
                createdAt: new Date().toISOString()
              });
            }
          }
        }
      } catch (err) {
        console.error(`AI analysis failed for file ${filePath}: ${err.message}`);
      }
    } else {
      // Rule 6: General deep scan of diff for logical concurrency bugs if no AST warning hit
      const fingerprint = generateFingerprint('repo', filePath, 'GENERAL_DIFF_SCAN', change.patch);
      const cached = getCachedFinding(fingerprint);

      if (cached) {
        console.log(`[Cache Hit] Reusing cached general diff scan results for ${filePath}`);
        if (Array.isArray(cached)) {
          for (const item of cached) {
            if (item.isRealBug) {
              const itemFingerprint = generateFingerprint('repo', filePath, item.ruleId || 'GENERAL_ASYNC_BUG', change.patch);
              verifiedIssues.push({
                id: generateFindingId(itemFingerprint),
                fingerprint: itemFingerprint,
                filePath,
                lineStart: item.line,
                lineEnd: item.line,
                line: item.line,
                ruleId: item.ruleId || 'GENERAL_ASYNC_BUG',
                severity: item.severity || 'MEDIUM',
                confidence: 'medium',
                explanation: item.explanation,
                evidence: change.patch,
                proposedFix: item.proposedFix,
                suggestedTest: item.proposedTest,
                source: 'ai',
                status: 'new',
                createdAt: new Date().toISOString()
              });
            }
          }
        }
        continue;
      }

      console.log(`AI Agent is running Pre-Filter for general diff audit on ${filePath}...`);
      const isSuspicious = await runPreFilter(apiKey, change.patch, isLocalAI, isOpenAI, localBaseUrl, geminiModel);
      
      if (!isSuspicious) {
        console.log(`[Pre-Filter] Skipped clean diff for ${filePath} (Saved API Cost)`);
        setCachedFinding(fingerprint, []);
        continue;
      }

      console.log(`AI Agent is performing deep general diff audit for file: ${filePath}...`);
      
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
For each bug, also include a \`proposedTest\` field: a minimal Jest/Vitest unit test (in a fenced markdown code block) that reproduces the bug and validates the fix.

Return your response strictly as a JSON array of objects with this structure (no conversational text outside the array):
[
  {
    "line": 15,
    "ruleId": "LOGICAL_CONCURRENCY_BUG",
    "isRealBug": true,
    "severity": "MEDIUM",
    "explanation": "Description of why there is a race condition or state conflict.",
    "proposedFix": "Corrected code block or diff",
    "proposedTest": "\`\`\`js\ntest('reproduces the bug', () => { /* ... */ });\n\`\`\`"
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
        setCachedFinding(fingerprint, issuesArray);

        if (Array.isArray(issuesArray)) {
          for (const item of issuesArray) {
            if (item.isRealBug) {
              const itemFingerprint = generateFingerprint('repo', filePath, item.ruleId || 'GENERAL_ASYNC_BUG', change.patch);
              verifiedIssues.push({
                id: generateFindingId(itemFingerprint),
                fingerprint: itemFingerprint,
                filePath,
                lineStart: item.line,
                lineEnd: item.line,
                line: item.line,
                ruleId: item.ruleId || 'GENERAL_ASYNC_BUG',
                severity: item.severity || 'MEDIUM',
                confidence: 'medium',
                explanation: item.explanation,
                evidence: change.patch,
                proposedFix: item.proposedFix,
                suggestedTest: item.proposedTest || null,
                source: 'ai',
                status: 'new',
                createdAt: new Date().toISOString()
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

/**
 * Phase 2 — Auto-Healing: Asks the AI model to correct a patch that caused a syntax error.
 * Used by the /fix retry loop when the proposed fix fails syntax verification.
 *
 * @param {string} apiKey - Gemini or OpenAI API key.
 * @param {string} brokenPatch - The patch string that introduced a syntax error.
 * @param {string} syntaxError - The syntax error message from the validator.
 * @param {string} modelName - The AI model name to use.
 * @param {Object} localOptions - Optional local AI configuration {apiBaseUrl, modelName}.
 * @returns {Promise<string|null>} The corrected patch string, or null if it failed.
 */
export async function generateCorrectionPatch(apiKey, brokenPatch, syntaxError, modelName = 'gemini-1.5-flash', localOptions = {}) {
  const localBaseUrl = localOptions.apiBaseUrl || process.env.LOCAL_AI_BASE_URL;
  const localModel = localOptions.modelName || process.env.LOCAL_MODEL_NAME;
  const isLocalAI = !!localBaseUrl;
  const isOpenAI = apiKey ? apiKey.startsWith('sk-') : false;

  let actualModel = modelName;
  if (isLocalAI) {
    actualModel = localModel || modelName || 'llama3';
  } else if (isOpenAI) {
    actualModel = modelName === 'gemini-1.5-flash' ? 'gpt-4o-mini' : modelName;
  }

  const prompt = `
You are an expert software engineer. A code patch was generated that introduces a syntax error.

### Broken Patch:
\`\`\`
${brokenPatch}
\`\`\`

### Syntax Error Detected:
\`\`\`
${syntaxError}
\`\`\`

### Task:
Fix the patch so it is syntactically valid JavaScript/TypeScript.
Return ONLY the corrected code block — no explanations, no markdown fences, no additional text.
The output must be the corrected replacement code only.
`;

  try {
    let text = '';
    if (isLocalAI || isOpenAI) {
      const apiBase = localBaseUrl || 'https://api.openai.com/v1';
      const key = apiKey || 'local-key';
      // For correction, we want plain text output, not JSON, so we use a generic fetch
      const base = apiBase.endsWith('/') ? apiBase.slice(0, -1) : apiBase;
      const response = await fetch(`${base}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
        body: JSON.stringify({
          model: actualModel,
          messages: [{ role: 'user', content: prompt }],
          temperature: 0.05
        })
      });
      const data = await response.json();
      text = data.choices[0]?.message?.content || '';
    } else {
      const genAI = new GoogleGenerativeAI(apiKey);
      const model = genAI.getGenerativeModel({ model: actualModel });
      const result = await model.generateContent(prompt);
      text = result.response.text();
    }

    // Strip accidental markdown fences from the response
    text = cleanJsonResponse(text);
    return text.trim() || null;
  } catch (err) {
    console.error(`[Auto-Heal] generateCorrectionPatch failed: ${err.message}`);
    return null;
  }
}
