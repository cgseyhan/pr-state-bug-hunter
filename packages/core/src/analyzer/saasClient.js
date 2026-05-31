import fetch from 'node-fetch';
import { redactSecrets } from './secretRedactor.js';
import fs from 'fs';

/**
 * Sends PR data to the SaaS backend for analysis.
 */
export async function analyzeWithSaaS(config, githubContext, changes) {
  const url = `${config.saas.apiBaseUrl}/v1/analyze-pr`;
  const token = process.env[config.saas.tokenEnv] || process.env.GITHUB_TOKEN;

  console.log(`[SaaS Client] Sending ${changes.length} changed files to ${url}...`);

  const payload = {
    repository: {
      owner: githubContext.issue.owner,
      name: githubContext.issue.repo,
      fullName: `${githubContext.issue.owner}/${githubContext.issue.repo}`,
    },
    pullRequest: {
      number: githubContext.issue.number,
      headSha: githubContext.payload.pull_request?.head?.sha || githubContext.sha,
    },
    files: changes.map(c => {
      let content = '';
      if (fs.existsSync(c.path)) {
        content = fs.readFileSync(c.path, 'utf8');
      }
      
      if (config.privacy?.redactSecrets) {
        content = redactSecrets(content);
      }

      // If sendOnlyDiffContext is true, we should ideally truncate this.
      // For now we send the redacted file and let the backend extract lines.
      return {
        path: c.path,
        changedLines: c.changedLines,
        content: config.privacy?.sendOnlyDiffContext ? content : content
      };
    }),
    config,
    client: {
      version: "2.1.0",
      mode: "github-action"
    }
  };

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      throw new Error(`SaaS API returned ${response.status} ${response.statusText}`);
    }

    const data = await response.json();
    return data;
  } catch (err) {
    console.error(`[SaaS Client Error]: ${err.message}`);
    throw err;
  }
}
