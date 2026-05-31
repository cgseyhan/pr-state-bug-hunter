import core from '@actions/core';
import github from '@actions/github';
import dotenv from 'dotenv';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { getPrChanges } from './analyzer/diffParser.js';
import { analyzeCodeAST, verifySyntax, escalateWarnings } from './analyzer/astParser.js';
import { huntStateBugsWithGemini, generateCorrectionPatch } from './agents/bugHunterAgent.js';
import { 
  postInlineReviewComments, 
  postPrSummaryComment, 
  commitFixToPrBranch,
  postJobSummary,
  checkUserWritePermission
} from './github/octokitClient.js';
import { loadConfig } from './config/configLoader.js';
import { analyzeWithSaaS } from './analyzer/saasClient.js';

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

import { applyAndVerifyFix } from './agents/autoFixer.js';

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
    const autoComment = (core.getInput('auto-comment') || process.env.AUTO_COMMENT || 'true') === 'true';
    const geminiModel = core.getInput('gemini-model') || process.env.GEMINI_MODEL || 'gemini-1.5-flash';
    const localAiBaseUrl = core.getInput('local-ai-base-url') || process.env.LOCAL_AI_BASE_URL;
    const localModelName = core.getInput('local-model-name') || process.env.LOCAL_MODEL_NAME;

    if (!githubToken) {
      core.setFailed("Missing GITHUB_TOKEN. Please set the token input or environment variable.");
      return;
    }

    // Load configuration
    const config = loadConfig();
    const severityThreshold = config.severityThreshold;

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

      if (commentBody.startsWith('/bug-hunter fix') || commentBody.startsWith('/fix')) {
        console.log(`📣 [Slash Command] Received fix request: "${commentBody}"`);

        // ── PHASE 1: SECURITY GUARD ─────────────────────────────────────────
        const commenterLogin = github.context.payload.comment?.user?.login;
        if (!commenterLogin) {
          console.warn('[Security Guard] Could not determine commenter identity. Blocking /fix command.');
          return;
        }
        const hasPermission = await checkUserWritePermission(octokit, github.context, commenterLogin);
        if (!hasPermission) {
          const { owner, repo, number: pullNumber } = github.context.issue;
          await octokit.rest.issues.createComment({
            owner,
            repo,
            issue_number: pullNumber,
            body: `🚫 **PR State Bug Hunter Security Guard**\n\n@${commenterLogin}, you need **write** or **admin** access to this repository to use the \`/fix\` command. Please contact a maintainer. 🛡️`
          });
          logTelemetry({ action: 'slash_fix_blocked', commenter: commenterLogin, reason: 'insufficient_permissions' });
          return;
        }
        console.log(`[Security Guard] ✅ User "${commenterLogin}" has write access. Proceeding with /fix.`);
        // ────────────────────────────────────────────────────────────────────

        const parts = commentBody.split(/\s+/);
        // /bug-hunter fix <id>  => parts[2]
        // /fix <id>             => parts[1]
        const idArg = commentBody.startsWith('/bug-hunter fix') ? parts[2] : parts[1];

        const { owner, repo, number: pullNumber } = github.context.issue;
        const { data: pr } = await octokit.rest.pulls.get({
          owner,
          repo,
          pull_number: pullNumber
        });
        const branchName = pr.head.ref;
        const isFork = pr.head.repo.id !== pr.base.repo.id;

        // Stage 4: Safer Auto-Fix checks
        if (config.autoFix?.enabled === false) {
          await octokit.rest.issues.createComment({
            owner, repo, issue_number: pullNumber,
            body: `🚫 **Auto-Fix is disabled** in \`bug-hunter.config.json\`.`
          });
          return;
        }

        if (isFork && !config.autoFix?.allowForks) {
           await octokit.rest.issues.createComment({
            owner, repo, issue_number: pullNumber,
            body: `🚫 **Auto-Fix across forks is disabled** for security reasons (\`allowForks: false\`).`
          });
          return;
        }

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
            
            const fileWarnings = analyzeCodeAST(fileContent, change.path, config);
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
          const matchesId = idArg === 'all' || !idArg || bug.id === idArg || String(bug.line) === String(idArg);
          if (matchesId && bug.proposedFix) {
            console.log(`Applying fix for finding ${bug.id} in ${bug.filePath}...`);

            const { data: fileData } = await octokit.rest.repos.getContent({
              owner,
              repo,
              path: bug.filePath,
              ref: branchName
            });
            const currentContent = Buffer.from(fileData.content, 'base64').toString('utf8');

            // ── PHASE 2: AUTO-HEALING RETRY LOOP ────────────────────────────
            let fixResult = applyAndVerifyFix(currentContent, bug.line, bug.proposedFix, bug.filePath);
            let updatedContent = fixResult.success ? fixResult.updatedContent : null;
            let currentFix = bug.proposedFix;
            const MAX_HEAL_ATTEMPTS = 3;

            for (let attempt = 1; attempt <= MAX_HEAL_ATTEMPTS; attempt++) {
              if (fixResult.success) {
                console.log(`[Auto-Heal] ✅ Attempt ${attempt}: Patch is safe and syntactically valid.`);
                break;
              }

              if (attempt === MAX_HEAL_ATTEMPTS) {
                console.warn(`[Auto-Heal] ❌ All ${MAX_HEAL_ATTEMPTS} healing attempts exhausted. Reason: ${fixResult.reason}`);
                await octokit.rest.issues.createComment({
                  owner,
                  repo,
                  issue_number: pullNumber,
                  body: `🤖 **PR State Bug Hunter Auto-Fix Blocked After ${MAX_HEAL_ATTEMPTS} Repair Attempts!** ❌\n\nThe proposed fix for **line ${bug.line}** in \`${bug.filePath}\` could not be safely applied.\n\nFinal error:\n\`\`\`\n${fixResult.reason}\n\`\`\`\n\nPlease apply the fix manually. 🛡️`
                });
                updatedContent = null;
                break;
              }

              console.log(`[Auto-Heal] 🔄 Safety/Syntax error detected on attempt ${attempt}. Asking AI to correct the patch... Error: ${fixResult.reason}`);
              const correctedFix = await generateCorrectionPatch(
                geminiApiKey,
                currentFix,
                fixResult.reason,
                geminiModel,
                { apiBaseUrl: localAiBaseUrl, modelName: localModelName }
              );

              if (!correctedFix) break;
              currentFix = correctedFix;
              fixResult = applyAndVerifyFix(currentContent, bug.line, correctedFix, bug.filePath);
              updatedContent = fixResult.success ? fixResult.updatedContent : null;
            }
            // ────────────────────────────────────────────────────────────────

            if (updatedContent) {
              if (config.autoFix?.mode === 'suggestion') {
                // Dry Run / Suggestion mode: just create a comment with the patch
                await octokit.rest.issues.createComment({
                  owner, repo, issue_number: pullNumber,
                  body: `🤖 **PR State Bug Hunter Auto-Fix Suggestion** (Dry Run)\n\nI have prepared a verified patch for \`${bug.filePath}\` on line ${bug.line}. Since \`autoFix.mode\` is set to \`suggestion\`, I am not committing it directly.\n\n<details><summary><b>View Verified Patch</b></summary>\n\n\`\`\`diff\n${currentFix}\n\`\`\`\n</details>`
                });
                fixesApplied++;
              } else {
                // Commit mode
                await commitFixToPrBranch(octokit, github.context, branchName, bug.filePath, updatedContent, bug.line);
                fixesApplied++;

                await octokit.rest.issues.createComment({
                  owner, repo, issue_number: pullNumber,
                  body: `🤖 **PR State Bug Hunter Auto-Fix Applied!**\nSuccessfully committed the proposed fix for the bug on **line ${bug.line}** in \`${bug.filePath}\` to the branch \`${branchName}\`. 🛡️`
                });
              }
            }
          }
        }

        logTelemetry({
          action: 'slash_fix',
          idArg,
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

    let astWarnings = [];
    let filesScannedCount = 0;
    let verifiedBugs = [];

    // ── PHASE 3: SAAS MODE (STAGE 6) ──────────────────────────────────
    let usedSaaS = false;
    if (config.saas?.enabled && config.saas?.apiBaseUrl) {
      console.log(`[SaaS Mode] SaaS is enabled. Calling backend API: ${config.saas.apiBaseUrl}...`);
      try {
        const saasData = await analyzeWithSaaS(config, github.context, changes);
        verifiedBugs = saasData.findings || [];
        filesScannedCount = saasData.usage?.filesScanned || changes.length;
        astWarnings = { length: saasData.usage?.astWarnings || 0 }; // stub
        usedSaaS = true;
        console.log(`[SaaS Mode] Successfully retrieved ${verifiedBugs.length} findings from backend.`);
      } catch (err) {
        console.warn(`[SaaS Fallback] SaaS backend unreachable or failed. Falling back to local AST engine. Error: ${err.message}`);
      }
    }

    // ── PHASE 4: LOCAL AST ENGINE FALLBACK ────────────────────────────
    if (!usedSaaS) {
      console.log("Step 2: Performing static AST vulnerability sweeps...");
      astWarnings = [];

      for (const change of changes) {
        try {
          let fileContent = '';
          if (fs.existsSync(change.path)) {
            fileContent = fs.readFileSync(change.path, 'utf8');
          }

          if (fileContent) {
            filesScannedCount++;
            const fileWarnings = analyzeCodeAST(fileContent, change.path, config);
            
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
        await postInlineReviewComments(octokit, github.context, commitSha, filteredBugs, config);
      }
      await postPrSummaryComment(octokit, github.context, filesScannedCount, astWarnings.length, filteredBugs, config);
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
