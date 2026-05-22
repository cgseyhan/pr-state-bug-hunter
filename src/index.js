import core from '@actions/core';
import github from '@actions/github';
import dotenv from 'dotenv';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { getPrChanges } from './analyzer/diffParser.js';
import { analyzeCodeAST, verifySyntax, escalateWarnings } from './analyzer/astParser.js';
import { huntStateBugsWithGemini } from './agents/bugHunterAgent.js';
import { 
  postInlineReviewComments, 
  postPrSummaryComment, 
  commitFixToPrBranch,
  postJobSummary
} from './github/octokitClient.js';

// Load local .env files if present (highly convenient for local tests/development)
if (fs.existsSync('.env')) {
  dotenv.config();
}

const TELEMETRY_FILE = '.bug-hunter-telemetry.json';

/**
 * Logs telemetry events locally for feedback loop and audit refinement.
 * @param {Record<string, any>} eventData - Telemetry metrics payload.
 */
export function logTelemetry(eventData) {
  let currentData = [];
  try {
    if (fs.existsSync(TELEMETRY_FILE)) {
      currentData = JSON.parse(fs.readFileSync(TELEMETRY_FILE, 'utf8'));
    }
  } catch (err) {
    console.warn(`[Telemetry Warning]: Could not read telemetry: ${err.message}`);
  }
  
  currentData.push({
    timestamp: new Date().toISOString(),
    ...eventData
  });

  try {
    fs.writeFileSync(TELEMETRY_FILE, JSON.stringify(currentData, null, 2), 'utf8');
  } catch (err) {
    console.warn(`[Telemetry Warning]: Could not write telemetry: ${err.message}`);
  }
}

/**
 * Extracts line-centered context from source code to assist matching.
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
 * Filter issues by user-configured severity threshold.
 */
function filterIssuesBySeverity(issues, threshold) {
  const severityLevels = { 'LOW': 1, 'MEDIUM': 2, 'HIGH': 3 };
  const minLevel = severityLevels[threshold.toUpperCase()] || 1;

  return issues.filter(issue => {
    const issueLevel = severityLevels[issue.severity?.toUpperCase()] || 1;
    return issueLevel >= minLevel;
  });
}

async function run() {
  try {
    console.log("==========================================");
    console.log("🚀 PR State Bug Hunter - Initializing Analysis...");
    console.log("==========================================");

    const githubToken = core.getInput('github-token') || process.env.GITHUB_TOKEN;
    const geminiApiKey = core.getInput('gemini-api-key') || process.env.GEMINI_API_KEY;
    const severityThreshold = core.getInput('severity-threshold') || process.env.SEVERITY_THRESHOLD || 'LOW';
    const autoComment = (core.getInput('auto-comment') || process.env.AUTO_COMMENT || 'true') === 'true';
    const geminiModel = core.getInput('gemini-model') || process.env.GEMINI_MODEL || 'gemini-1.5-flash';
    const localAiBaseUrl = core.getInput('local-ai-base-url') || process.env.LOCAL_AI_BASE_URL;
    const localModelName = core.getInput('local-model-name') || process.env.LOCAL_MODEL_NAME;

    if (!githubToken) {
      core.setFailed("Missing GITHUB_TOKEN. Please set the token input or environment variable.");
      return;
    }

    const octokit = github.getOctokit(githubToken);
    const eventName = github.context.eventName;

    // Log telemetry for tracing
    logTelemetry({
      action: 'initialize',
      eventName,
      issueContext: github.context.issue
    });

    // ----------------------------------------------------
    // Slash Command Listener: /fix inside comments
    // ----------------------------------------------------
    if (eventName === 'issue_comment' || eventName === 'pull_request_review_comment') {
      const comment = github.context.payload.comment;
      const commentBody = comment.body.trim();

      if (commentBody.startsWith('/fix')) {
        console.log(`📣 [Slash Command] Received fix request: "${commentBody}"`);
        const parts = commentBody.split(/\s+/);
        const lineArg = parts[1]; // e.g. "9" or "all"

        const { owner, repo, number: pullNumber } = github.context.issue;
        const { data: pr } = await octokit.rest.pulls.get({
          owner,
          repo,
          pull_number: pullNumber
        });
        const branchName = pr.head.ref;

        console.log(`Resolving code and scanning files on branch "${branchName}"...`);
        const changes = await getPrChanges(octokit, github.context);
        const astWarnings = [];

        for (const change of changes) {
          try {
            const { data: fileData } = await octokit.rest.repos.getContent({
              owner,
              repo,
              path: change.path,
              ref: branchName
            });
            const fileContent = Buffer.from(fileData.content, 'base64').toString('utf8');
            
            const fileWarnings = analyzeCodeAST(fileContent, change.path);
            const relevantWarnings = fileWarnings.filter(warning => 
              change.changedLines.includes(warning.line)
            );

            relevantWarnings.forEach(w => {
              astWarnings.push({ ...w, path: change.path });
            });
          } catch (err) {
            console.error(`Could not fetch branch content for ${change.path}: ${err.message}`);
          }
        }

        const verifiedBugs = await huntStateBugsWithGemini(
          geminiApiKey, 
          changes, 
          astWarnings, 
          geminiModel,
          { apiBaseUrl: localAiBaseUrl, modelName: localModelName }
        );

        let fixesApplied = 0;
        for (const bug of verifiedBugs) {
          const matchesLine = lineArg === 'all' || !lineArg || String(bug.line) === String(lineArg);
          if (matchesLine && bug.proposedFix) {
            console.log(`Applying fix for bug on line ${bug.line} of ${bug.filePath}...`);

            const { data: fileData } = await octokit.rest.repos.getContent({
              owner,
              repo,
              path: bug.filePath,
              ref: branchName
            });
            const currentContent = Buffer.from(fileData.content, 'base64').toString('utf8');

            const updatedContent = applyFixToText(currentContent, bug.line, bug.proposedFix);
            if (updatedContent) {
              const syntaxCheck = verifySyntax(updatedContent, bug.filePath);
              if (!syntaxCheck.valid) {
                console.warn(`[Syntax Validation Failed] Auto-fix at ${bug.filePath}:${bug.line} caused a syntax error: ${syntaxCheck.error}`);
                await octokit.rest.issues.createComment({
                  owner,
                  repo,
                  issue_number: pullNumber,
                  body: `🤖 **PR State Bug Hunter Auto-Fix Blocked!** ❌\n\nThe proposed fix for the bug on **line ${bug.line}** in \`${bug.filePath}\` was blocked because it introduces a syntax error:\n\n\`\`\`\n${syntaxCheck.error}\n\`\`\`\n\nPlease check the proposed fix and apply it manually. 🛡️`
                });
                continue;
              }

              await commitFixToPrBranch(octokit, github.context, branchName, bug.filePath, updatedContent, bug.line);
              fixesApplied++;

              await octokit.rest.issues.createComment({
                owner,
                repo,
                issue_number: pullNumber,
                body: `🤖 **PR State Bug Hunter Auto-Fix Applied!**\nSuccessfully committed the proposed fix for the bug on **line ${bug.line}** in \`${bug.filePath}\` to the branch \`${branchName}\`. 🛡️`
              });
            }
          }
        }

        logTelemetry({
          action: 'slash_fix',
          lineArg,
          fixesApplied
        });
        
        console.log(`Slash command completed. Applied ${fixesApplied} fixes.`);
        return;
      }
    }

    // ----------------------------------------------------
    // Standard Pull Request Event Pipeline
    // ----------------------------------------------------
    if (!github.context.issue.number) {
      core.warning("PR State Bug Hunter was executed outside a Pull Request context. Skipping PR comment operations.");
      console.log("To run locally on a specific PR, set GITHUB_EVENT_PATH containing pull request issue context.");
      return;
    }

    const { owner, repo, number: pullNumber } = github.context.issue;
    const commitSha = github.context.payload.pull_request?.head?.sha || github.context.sha;

    console.log(`Context: Repo = ${owner}/${repo}, PR = #${pullNumber}, Head SHA = ${commitSha}`);

    const changes = await getPrChanges(octokit, github.context);
    if (changes.length === 0) {
      console.log("No analyzable code files were modified in this PR. Exiting gracefully.");
      return;
    }

    console.log("Step 2: Performing static AST vulnerability sweeps...");
    const astWarnings = [];
    let filesScannedCount = 0;

    for (const change of changes) {
      try {
        let fileContent = '';
        if (fs.existsSync(change.path)) {
          fileContent = fs.readFileSync(change.path, 'utf8');
        }

        if (fileContent) {
          filesScannedCount++;
          const fileWarnings = analyzeCodeAST(fileContent, change.path);
          
          const relevantWarnings = fileWarnings.filter(warning => 
            change.changedLines.includes(warning.line)
          );

          relevantWarnings.forEach(w => {
            astWarnings.push({
              ...w,
              path: change.path
            });
            console.log(`[AST Warning] [${change.path}:${w.line}] [${w.ruleId}]: ${w.message}`);
          });
        }
      } catch (err) {
        core.warning(`Error running AST analysis on ${change.path}: ${err.message}`);
      }
    }

    console.log(`AST sweep complete. Scanned ${filesScannedCount} files, encountered ${astWarnings.length} structurally weak points in updated lines.`);

    // Perform Taint-Based Severity Escalation
    const escalatedWarnings = escalateWarnings(astWarnings, '.');

    let verifiedBugs = [];
    if (geminiApiKey || localAiBaseUrl) {
      console.log(`Step 3: Initiating AI Agent semantic auditing...`);
      verifiedBugs = await huntStateBugsWithGemini(
        geminiApiKey, 
        changes, 
        escalatedWarnings, 
        geminiModel,
        { apiBaseUrl: localAiBaseUrl, modelName: localModelName }
      );
    } else {
      console.log("Step 3: Neither GEMINI_API_KEY nor LOCAL_AI_BASE_URL provided. Defaulting to raw AST warning reports...");
      verifiedBugs = escalatedWarnings.map(w => ({
        filePath: w.path,
        line: w.line,
        ruleId: w.ruleId,
        severity: w.severity,
        explanation: w.message,
        proposedFix: ''
      }));
    }

    const filteredBugs = filterIssuesBySeverity(verifiedBugs, severityThreshold);
    console.log(`Filtered issues from ${verifiedBugs.length} down to ${filteredBugs.length} based on severity threshold (${severityThreshold}).`);

    logTelemetry({
      action: 'analyze_complete',
      filesScannedCount,
      astWarningsCount: astWarnings.length,
      verifiedBugsCount: verifiedBugs.length,
      filteredBugsCount: filteredBugs.length
    });

    if (autoComment) {
      console.log("Step 5: Publishing findings to GitHub Pull Request...");
      if (filteredBugs.length > 0) {
        await postInlineReviewComments(octokit, github.context, commitSha, filteredBugs);
      }
      await postPrSummaryComment(octokit, github.context, filesScannedCount, astWarnings.length, filteredBugs);
    } else {
      console.log("Step 5: Auto-comment is disabled. Printing findings summary to action log:");
      console.log(JSON.stringify(filteredBugs, null, 2));
    }

    // Always publish job step summary report in GitHub runner UI
    await postJobSummary(filesScannedCount, astWarnings.length, filteredBugs);

    console.log("==========================================");
    console.log("🎉 PR State Bug Hunter completed successfully!");
    console.log("==========================================");
  } catch (error) {
    core.setFailed(`Action failed with unexpected error: ${error.message}`);
  }
}

const isMain = process.argv[1] && (
  fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))
);
if (isMain) {
  run();
}
