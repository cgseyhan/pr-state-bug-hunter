import core from '@actions/core';

/**
 * Checks if a GitHub user has write or admin access to the repository.
 * Used as a security guard before executing /fix slash commands.
 * @param {Object} octokit - The Octokit client.
 * @param {Object} context - The GitHub Action context.
 * @param {string} username - The GitHub username to check.
 * @returns {Promise<boolean>} True if the user has write or admin permission.
 */
export async function checkUserWritePermission(octokit, context, username) {
  const { owner, repo } = context.issue;
  try {
    const { data } = await octokit.rest.repos.getCollaboratorPermissionLevel({
      owner,
      repo,
      username
    });
    const level = data.permission;
    const hasAccess = level === 'admin' || level === 'write';
    if (!hasAccess) {
      console.warn(`[Security Guard] User "${username}" attempted /fix but only has "${level}" permission. Blocking.`);
    }
    return hasAccess;
  } catch (err) {
    // If not a collaborator at all, the API throws a 404
    console.warn(`[Security Guard] Could not verify permission for "${username}": ${err.message}. Blocking command.`);
    return false;
  }
}

/**
 * Creates inline PR review comments for verified issues.
 * If an inline comment fails due to diff hunk alignment, it falls back gracefully without breaking execution.
 * @param {Object} octokit - The Octokit client.
 * @param {Object} context - The GitHub Action context.
 * @param {string} commitSha - The target commit SHA.
 * @param {Array} issues - Array of verified issues.
 * @param {Object} config - The workspace configuration.
 */
export async function postInlineReviewComments(octokit, context, commitSha, issues, config) {
  const { owner, repo, number: pull_number } = context.issue;

  if (config?.commentMode === 'summary-only') {
    console.log(`Skipping inline review comments because commentMode is 'summary-only'.`);
    return;
  }

  console.log(`Posting ${issues.length} inline review comments on PR #${pull_number}...`);

  for (const issue of issues) {
    let commentBody = '';
    
    if (config?.commentMode === 'compact') {
      commentBody = `**PR State Bug Hunter** 🛡️\n\n**Warning:** \`${issue.ruleId}\` (${issue.severity})\n**Reason:** ${issue.explanation}\n\n*Command: \`/bug-hunter fix ${issue.id}\`*`;
    } else {
      const testBlock = issue.proposedTest
        ? `\n<details>\n<summary>🧪 <b>Suggested Unit Test (Reproduce &amp; Guard this bug)</b></summary>\n\n${issue.proposedTest}\n</details>`
        : '';

      commentBody = `
### 🤖 PR State Bug Hunter Warning 🛡️

**Bug Type:** \`${issue.ruleId}\`
**Severity:** ${issue.severity === 'HIGH' ? '🔴 HIGH' : issue.severity === 'MEDIUM' ? '🟡 MEDIUM' : '🟢 LOW'}

**Analysis:**
${issue.explanation}

${issue.proposedFix ? `**Proposed Fix:**\n${issue.proposedFix}` : ''}${testBlock}

_Review conducted by PR State Bug Hunter AI. Comment \`/bug-hunter fix ${issue.id}\` to auto-apply the patch._
`;
    }

    try {
      await octokit.rest.pulls.createReviewComment({
        owner,
        repo,
        pull_number,
        body: commentBody,
        commit_id: commitSha,
        path: issue.filePath,
        line: issue.line,
        side: 'RIGHT'
      });
      console.log(`Successfully posted inline comment on ${issue.filePath}:${issue.line}`);
    } catch (err) {
      core.warning(`Could not post inline review comment on ${issue.filePath}:${issue.line}: ${err.message}. Inline comment added to summary report instead.`);
    }
  }
}

/**
 * Generates and posts a gorgeous markdown summary comment at the top of the PR.
 * Updates an existing comment if it finds the hidden marker.
 * @param {Object} octokit - The Octokit client.
 * @param {Object} context - The GitHub Action context.
 * @param {number} filesScannedCount - Number of files scanned.
 * @param {number} astWarningsCount - Number of AST warnings found.
 * @param {Array} verifiedIssues - Array of AI verified issues.
 * @param {Object} config - The workspace configuration.
 */
export async function postPrSummaryComment(octokit, context, filesScannedCount, astWarningsCount, verifiedIssues, config) {
  const { owner, repo, number: pull_number } = context.issue;

  console.log(`Posting comprehensive PR Summary Comment...`);

  const MARKER = '<!-- pr-state-bug-hunter-summary -->';
  let summaryBody = `${MARKER}\n## 🛡️ PR State Bug Hunter Report 🚀\n\n`;

  if (config?.commentMode === 'compact') {
    summaryBody += `* **Files Scanned**: ${filesScannedCount}\n* **Warnings Detected**: ${astWarningsCount}\n* **AI-Verified Bugs**: ${verifiedIssues.length}\n\n---\n`;
  } else {
    summaryBody += `An AI-powered static & semantic review has been completed for this pull request. We scanned code structures for asynchronous state leaks, React hook race conditions, memory leaks, and communication protocol hazards.

### 📊 Scan Summary Dashboard
| Metric | Result |
| :--- | :--- |
| 📂 **Files Scanned** | \`${filesScannedCount}\` |
| 🔍 **AST Warning Spots Found** | \`${astWarningsCount}\` |
| 🤖 **AI-Verified Logical Bugs** | \`${verifiedIssues.length}\` |
| 🛡️ **Action Status** | ${verifiedIssues.length > 0 ? '⚠️ Review Required' : '✅ Ready to Merge'} |

<details>
<summary>📈 <b>View Concurrency Security Flow Chart</b></summary>
<br/>

\`\`\`mermaid
graph TD
    A[PR Code Changes] -->|Babel AST Scanner| B("Detected structurally weak spots: ${astWarningsCount}")
    B -->|Incremental Cryptographic Cache| C{Cache Hit?}
    C -->|Yes: <5ms| D[Instant Resolution]
    C -->|No: API Query| E[Gemini / OpenAI Agent Audit]
    E -->|Semantic Analysis| F("Verified Bugs: ${verifiedIssues.length}")
    D --> F
    F -->|PR Dashboard / inline comments| G[Action Output Finished]
\`\`\`

</details>

---

`;
  }

  if (verifiedIssues.length === 0) {
    summaryBody += `### ✅ No State Bugs or Race Conditions Detected!
Our static analysis and AI models audited your changes and found no issues relating to React hook lifecycle leaks, stale state asynchronous updates, stream framing, or event listener cleanup. Excellent work! 🌟
`;
  } else {
    summaryBody += `### 🔴 Issues Requiring Attention
Below is the breakdown of the **${verifiedIssues.length}** issues detected.

`;

    // Group issues by file
    const issuesByFile = {};
    for (const issue of verifiedIssues) {
      if (!issuesByFile[issue.filePath]) {
        issuesByFile[issue.filePath] = [];
      }
      issuesByFile[issue.filePath].push(issue);
    }

    for (const [filePath, fileIssues] of Object.entries(issuesByFile)) {
      summaryBody += `#### 📄 File: \`${filePath}\`\n\n`;

      if (config?.commentMode !== 'compact') {
        summaryBody += `<details open>\n<summary><b>Click to toggle details for this file (${fileIssues.length} issues)</b></summary>\n<br/>\n\n`;
      }

      for (const issue of fileIssues) {
        if (config?.commentMode === 'compact') {
          summaryBody += `- **Line ${issue.line}** [\`${issue.ruleId}\`] - ${issue.explanation} (Fix ID: \`${issue.id}\`)\n`;
        } else {
          const testSection = issue.proposedTest
            ? `\n<details>\n<summary>🧪 <b>Suggested Unit Test</b></summary>\n\n${issue.proposedTest}\n</details>\n`
            : '';

          summaryBody += `
##### ⚠️ [ID: \`${issue.id}\`] Line ${issue.line}: \`${issue.ruleId}\` (${issue.severity === 'HIGH' ? '🔴 HIGH' : issue.severity === 'MEDIUM' ? '🟡 MEDIUM' : '🟢 LOW'})

* **Explanation:** 
  ${issue.explanation}

${issue.proposedFix ? `* **Proposed Fix:**\n${issue.proposedFix}` : ''}${testSection}

---
`;
        }
      }

      if (config?.commentMode !== 'compact') {
        summaryBody += `</details>\n\n`;
      }
    }
  }

  summaryBody += `
---
_Report generated by PR State Bug Hunter._
`;

  try {
    // Look for existing comment to update
    const { data: comments } = await octokit.rest.issues.listComments({
      owner,
      repo,
      issue_number: pull_number
    });

    const existingComment = comments.find(c => c.body.includes(MARKER));

    if (existingComment) {
      await octokit.rest.issues.updateComment({
        owner,
        repo,
        comment_id: existingComment.id,
        body: summaryBody
      });
      console.log("Successfully updated the existing PR summary comment!");
    } else {
      await octokit.rest.issues.createComment({
        owner,
        repo,
        issue_number: pull_number,
        body: summaryBody
      });
      console.log("Successfully posted a new PR summary comment!");
    }
  } catch (err) {
    core.setFailed(`Failed to post summary comment on PR: ${err.message}`);
  }
}

/**
 * Smartly commits proposed AI fixes directly to the PR branch via Octokit createOrUpdateFileContents.
 * @param {Object} octokit - The Octokit client.
 * @param {Object} context - The GitHub Action context.
 * @param {string} branchName - Target PR branch name.
 * @param {string} filePath - Path of the file to fix.
 * @param {string} updatedContent - The fully patched file contents.
 * @param {number|string} lineNum - The line number fixed, or 'all'.
 */
export async function commitFixToPrBranch(octokit, context, branchName, filePath, updatedContent, lineNum) {
  const { owner, repo } = context.issue;

  console.log(`Committing auto-fix changes back to branch "${branchName}" for file "${filePath}"...`);

  try {
    // 1. Fetch file meta-information to obtain its current blob SHA
    let fileSha;
    try {
      const { data } = await octokit.rest.repos.getContent({
        owner,
        repo,
        path: filePath,
        ref: branchName
      });
      fileSha = data.sha;
    } catch (err) {
      console.log(`[Octokit Warning]: File might be newly created or missing: ${err.message}`);
    }

    // 2. Commit the patched content
    await octokit.rest.repos.createOrUpdateFileContents({
      owner,
      repo,
      path: filePath,
      message: `🤖 [PR Bug Hunter] Auto-fix state/async bug on line ${lineNum}`,
      content: Buffer.from(updatedContent).toString('base64'),
      sha: fileSha,
      branch: branchName
    });

    console.log(`✅ [Octokit] Successfully committed fix to ${filePath} on branch ${branchName}!`);
  } catch (error) {
    console.error(`❌ [Octokit Error] Could not commit fix to branch ${branchName}: ${error.message}`);
    throw error;
  }
}

/**
 * Generates and posts a gorgeous markdown summary panel to the GitHub Action Run Step Summary.
 * @param {number} filesScannedCount - Number of files scanned.
 * @param {number} astWarningsCount - Number of AST warnings found.
 * @param {Array} verifiedIssues - Array of AI-verified issues.
 */
export async function postJobSummary(filesScannedCount, astWarningsCount, verifiedIssues) {
  console.log("Generating GitHub Step Summary Dashboard...");

  const bugSeverityHigh = verifiedIssues.filter(i => i.severity?.toUpperCase() === 'HIGH').length;
  const bugSeverityMed = verifiedIssues.filter(i => i.severity?.toUpperCase() === 'MEDIUM').length;
  const bugSeverityLow = verifiedIssues.filter(i => i.severity?.toUpperCase() === 'LOW').length;

  const totalBugs = verifiedIssues.length;
  const isHealthy = totalBugs === 0;

  let summaryHtml = `## 🛡️ PR State Bug Hunter - Executive Summary 🚀

A hybrid static AST & semantic AI code audit has been completed successfully!

### 📊 Scan Performance & Security Metrics
| Metric | Value | Status |
| :--- | :--- | :--- |
| 📂 **Files Scanned** | \`${filesScannedCount}\` | Scan Completed |
| 🔍 **AST Vulnerabilities** | \`${astWarningsCount}\` | Evaluated |
| 🤖 **AI-Verified Bugs** | \`${totalBugs}\` | ${isHealthy ? '✅ Safe' : '❌ Review Required'} |
| 🔴 **High Severity** | \`${bugSeverityHigh}\` | ${bugSeverityHigh > 0 ? '⚠️ Critical' : '✅ Clear'} |
| 🟡 **Medium Severity** | \`${bugSeverityMed}\` | ${bugSeverityMed > 0 ? '⚠️ Moderate' : '✅ Clear'} |
| 🟢 **Low Severity** | \`${bugSeverityLow}\` | ${bugSeverityLow > 0 ? 'ℹ️ Minor' : '✅ Clear'} |

---

### 📈 Concurrency Security Flow Analysis

\`\`\`mermaid
graph TD
    A[PR Code Changes] -->|Babel AST Scanner| B("Detected structurally weak spots: ${astWarningsCount}")
    B -->|Incremental Cryptographic Cache| C{Cache Hit?}
    C -->|Yes: <5ms| D[Instant Resolution]
    C -->|No: API Query| E[Gemini / OpenAI Agent Audit]
    E -->|Semantic Analysis| F("Verified Bugs: ${totalBugs}")
    D --> F
    F -->|PR Dashboard / inline comments| G[Action Output Finished]
\`\`\`

---

### 📁 Breakdown by Vulnerability Rule ID
`;

  if (totalBugs === 0) {
    summaryHtml += `\n### ✅ Clean Bill of Health!
No asynchronous state leaks, stale React closures, uncleaned timers/event listeners, or stream transport hazards were found. Your codebase is safe! 🌟\n`;
  } else {
    summaryHtml += `\n| Finding ID | Rule ID | File | Line | Severity |
| :--- | :--- | :--- | :--- | :--- |
`;
    for (const bug of verifiedIssues) {
      const sevEmoji = bug.severity?.toUpperCase() === 'HIGH' ? '🔴 HIGH' : bug.severity?.toUpperCase() === 'MEDIUM' ? '🟡 MEDIUM' : '🟢 LOW';
      summaryHtml += `| \`${bug.id}\` | \`${bug.ruleId}\` | \`${bug.filePath}\` | \`${bug.line}\` | ${sevEmoji} |\n`;
    }
  }

  summaryHtml += `
---
_For automated repairs, comment \`/bug-hunter fix <finding-id>\` directly on the pull request review thread. 🛠️_
`;

  try {
    await core.summary
      .addRaw(summaryHtml)
      .write();
    console.log("Successfully published the Step Summary Dashboard!");
  } catch (err) {
    console.warn(`[Summary Warning] Could not write step summary: ${err.message}`);
  }
}


