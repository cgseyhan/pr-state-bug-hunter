import { Octokit } from '@octokit/rest';
import { getPrChanges } from '@bug-hunter/core/src/analyzer/diffParser.js';
import { analyzeCodeAST, escalateWarnings } from '@bug-hunter/core/src/analyzer/astParser.js';
import { huntStateBugsWithGemini } from '@bug-hunter/core/src/agents/bugHunterAgent.js';
import { postInlineReviewComments, postPrSummaryComment } from '@bug-hunter/core/src/github/octokitClient.js';

export async function processPullRequest(webhookPayload) {
  const { pull_request, repository, installation } = webhookPayload;
  
  const owner = repository.owner.login;
  const repo = repository.name;
  const pullNumber = pull_request.number;
  const commitSha = pull_request.head.sha;

  console.log(`[Service] Starting analysis for ${owner}/${repo}#${pullNumber}`);

  // In a real GitHub App, you would generate an installation token using the App Private Key and installation.id
  // For now, we fall back to a personal access token for testing the integration
  const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });

  // Mock GitHub Actions context object to satisfy core functions
  const context = {
    issue: { owner, repo, number: pullNumber },
    repo: { owner, repo },
    payload: webhookPayload,
    sha: commitSha
  };

  try {
    const changes = await getPrChanges(octokit, context);
    if (changes.length === 0) {
      console.log(`[Service] No analyzable code files modified in PR #${pullNumber}.`);
      return;
    }

    const astWarnings = [];
    let filesScannedCount = 0;

    for (const change of changes) {
      // In a SaaS environment, we don't have the files locally on disk!
      // We must fetch the file content from GitHub API
      try {
        const { data: fileData } = await octokit.rest.repos.getContent({
          owner,
          repo,
          path: change.path,
          ref: commitSha
        });
        
        const fileContent = Buffer.from(fileData.content, 'base64').toString('utf8');
        filesScannedCount++;

        const fileWarnings = analyzeCodeAST(fileContent, change.path);
        const relevantWarnings = fileWarnings.filter(warning => 
          change.changedLines.includes(warning.line)
        );

        relevantWarnings.forEach(w => {
          astWarnings.push({ ...w, path: change.path });
        });
      } catch (err) {
        console.warn(`[Service] Could not fetch/analyze content for ${change.path}:`, err.message);
      }
    }

    const escalatedWarnings = escalateWarnings(astWarnings, '.');

    const geminiApiKey = process.env.GEMINI_API_KEY;
    const verifiedBugs = await huntStateBugsWithGemini(
      geminiApiKey,
      changes,
      escalatedWarnings,
      process.env.GEMINI_MODEL || 'gemini-1.5-flash',
      {}
    );

    // Filtering out false positives is handled inside huntStateBugsWithGemini already, 
    // but you could apply user-specific severity thresholds here from a database.
    const severityThreshold = 'LOW'; 
    const filteredBugs = verifiedBugs; // Filter if needed

    if (filteredBugs.length > 0) {
      await postInlineReviewComments(octokit, context, commitSha, filteredBugs);
    }
    
    await postPrSummaryComment(octokit, context, filesScannedCount, astWarnings.length, filteredBugs);

    console.log(`[Service] Completed analysis for PR #${pullNumber}. Bugs found: ${filteredBugs.length}`);
  } catch (error) {
    console.error(`[Service] Error processing PR #${pullNumber}:`, error);
  }
}
