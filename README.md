# PR State Bug Hunter

**An Enterprise-Grade, AI-Powered Static & Semantic Analysis Engine for GitHub Actions.**

PR State Bug Hunter safeguards your codebase by automatically detecting asynchronous state leaks, React hook lifecycle bugs, memory leaks, and Node.js streaming hazards during the Pull Request process.

It combines hyper-fast Babel AST static analysis with deep semantic AI verification (Google Gemini or OpenAI) to eliminate false positives and provide immediate, actionable feedback right inside your GitHub PRs.

## 🚀 Features

* **Hybrid Analysis Engine**: Fast static AST sweeps + deep AI semantic verification.
* **Auto-Fix Healing**: Capable of generating syntactically valid drop-in patches for state bugs and automatically committing them or suggesting them via PR comments.
* **Taint-Based Escalation**: Cross-file dependency graph tracking automatically escalates severities if untrusted imports taint critical modules.
* **SaaS Thin Client**: Can operate in local Action mode or forward payloads to the official Bug Hunter SaaS backend for centralized configuration, reporting, and zero-setup LLM billing.
* **Privacy Controls**: Built-in secret redactor strips out GitHub tokens, JWTs, and AWS keys before any code leaves your server.
* **Configurable UX**: Choose between `compact`, `detailed`, or `summary-only` comment modes.

## 📦 Setup & Usage

Create a workflow file `.github/workflows/bug-hunter.yml`:

```yaml
name: "PR Bug Hunter Audit"

on:
  pull_request:
    types: [opened, synchronize, reopened]
  issue_comment:
    types: [created]

jobs:
  analyze:
    runs-on: ubuntu-latest
    permissions:
      contents: write
      pull-requests: write
      issues: write
    steps:
      - name: Checkout Code
        uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - name: Run PR State Bug Hunter
        uses: cgseyhan/pr-state-bug-hunter@main
        with:
          github_token: ${{ secrets.GITHUB_TOKEN }}
          gemini_api_key: ${{ secrets.GEMINI_API_KEY }}
          # OR openai_api_key: ${{ secrets.OPENAI_API_KEY }}
          severity_threshold: 'LOW'
```

## ⚙️ Configuration (`bug-hunter.config.json`)

Create a `bug-hunter.config.json` in your repository root to customize rules, comment modes, and Auto-Fix behavior.

```json
{
  "commentMode": "compact",
  "severityThreshold": "LOW",
  "autoFix": {
    "enabled": true,
    "mode": "suggestion",
    "allowForks": false
  },
  "privacy": {
    "redactSecrets": true,
    "sendOnlyDiffContext": true
  },
  "saas": {
    "enabled": false,
    "apiBaseUrl": "https://api.bughunter.dev"
  }
}
```

## 🤖 Interactive `/fix` Slash Command

When Bug Hunter detects an issue, it assigns a unique ID (e.g., `bug-1234`). You can reply to the PR comment:

```
/bug-hunter fix bug-1234
```

The system will verify your repository permissions, generate a secure patch, verify its safety and syntax, and auto-commit the resolution directly to your branch.

## 🏗️ Architecture

PR State Bug Hunter is designed with a monolithic-monorepo approach:
* `packages/core`: The analysis engine, AST plugins, and Octokit logic.
* `apps/api`: (Coming Soon) The Fastify/PostgreSQL backend for organizations adopting the SaaS model.

## 📄 License

MIT License.
