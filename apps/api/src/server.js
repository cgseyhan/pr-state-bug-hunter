import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
// We will import the bugHunterAgent and Octokit functions from @bug-hunter/core later
import { processPullRequest } from './services/bugHunterService.js';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;

// Middlewares
app.use(cors());
app.use(express.json());

// Basic health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'Bug Hunter API' });
});

// GitHub App Webhook Endpoint
app.post('/api/webhooks/github', async (req, res) => {
  const event = req.headers['x-github-event'];
  const payload = req.body;

  console.log(`[Webhook] Received GitHub event: ${event}`);

  try {
    if (event === 'pull_request') {
      const { action, pull_request, repository } = payload;
      
      // We only care when a PR is opened or synchronized (new commits)
      if (['opened', 'synchronize', 'reopened'].includes(action)) {
        console.log(`[Webhook] Scheduling analysis for PR #${pull_request.number} on ${repository.full_name}`);
        // Process asynchronously without blocking the webhook response
        processPullRequest(payload).catch(err => console.error(err));
      }
    } else if (event === 'issue_comment') {
      const { action, issue, comment, repository } = payload;
      
      // Listen for /fix comments on PRs
      if (action === 'created' && issue.pull_request && comment.body.trim().startsWith('/fix')) {
        console.log(`[Webhook] Slash command /fix detected on PR #${issue.number}`);
        // TODO: Enqueue slash command job
      }
    }

    res.status(202).json({ message: 'Webhook received and processing scheduled' });
  } catch (error) {
    console.error('[Webhook] Error processing payload:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 PR State Bug Hunter API running on http://localhost:${PORT}`);
});
