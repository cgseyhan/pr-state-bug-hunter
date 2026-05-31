import core from '@actions/core';

/**
 * Parses a unified diff patch and returns the line numbers of added or modified lines in the new file.
 * @param {string} patch - The unified diff patch string.
 * @returns {number[]} Array of line numbers in the new file that were added/modified.
 */
export function parseDiffPatch(patch) {
  if (!patch) return [];

  const changedLines = [];
  const lines = patch.split('\n');
  let currentNewLineNum = 0;

  for (const line of lines) {
    if (line.startsWith('@@')) {
      // Parse hunk header: @@ -start,count +start,count @@
      const match = line.match(/^@@\s+-\d+,?\d*\s+\+(\d+),?\d*\s+@@/);
      if (match) {
        currentNewLineNum = parseInt(match[1], 10);
      }
    } else if (line.startsWith('+') && !line.startsWith('+++')) {
      // Added or modified line in new file
      changedLines.push(currentNewLineNum);
      currentNewLineNum++;
    } else if (line.startsWith('-') && !line.startsWith('---')) {
      // Deleted line (only exists in old file, skip incrementing new file counter)
      continue;
    } else {
      // Context line (unchanged, exists in both files)
      currentNewLineNum++;
    }
  }

  return changedLines;
}

/**
 * Fetches the list of changed files and parses their modified line numbers using Octokit.
 * @param {Object} octokit - The Octokit client.
 * @param {Object} context - The GitHub Action context.
 * @returns {Promise<Array<{path: string, status: string, changedLines: number[], patch: string}>>}
 */
export async function getPrChanges(octokit, context) {
  const { owner, repo, number: pull_number } = context.issue;

  console.log(`Fetching files for PR #${pull_number} on ${owner}/${repo}...`);

  try {
    const files = await octokit.paginate(octokit.rest.pulls.listFiles, {
      owner,
      repo,
      pull_number,
      per_page: 100
    });

    const parsedChanges = [];

    for (const file of files) {
      // Only scan code files that can be AST-parsed or analyzed for race conditions/protocols
      const isAnalyzable = /\.(js|jsx|ts|tsx|mjs|cjs|vue|svelte)$/i.test(file.filename);
      if (!isAnalyzable) continue;

      // Skip deleted files, as they no longer exist for AST or bug hunter analysis
      if (file.status === 'removed') continue;

      const changedLines = parseDiffPatch(file.patch);

      parsedChanges.push({
        path: file.filename,
        status: file.status,
        changedLines,
        patch: file.patch || ''
      });
    }

    console.log(`Successfully mapped ${parsedChanges.length} modified/added code files in PR.`);
    return parsedChanges;
  } catch (error) {
    core.warning(`Error fetching files from GitHub API: ${error.message}. Falling back to empty file list.`);
    return [];
  }
}
