/**
 * @vitest-environment node
 *
 * Unit tests for: src/github/octokitClient.js
 * Covers:
 *   - checkUserWritePermission: all permission levels + 404 fallback
 *   - postInlineReviewComments: proposedTest rendering, graceful fallback on error
 *   - postPrSummaryComment: proposedTest section, severity emojis
 *
 * All GitHub API calls are mocked — no real network requests.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mock @actions/core (used in octokitClient for core.warning) ─────────────
vi.mock('@actions/core', () => {
  const summaryMock = { addRaw: vi.fn().mockReturnThis(), write: vi.fn().mockResolvedValue() };
  return {
    default: { warning: vi.fn(), info: vi.fn(), error: vi.fn(), setFailed: vi.fn(), summary: summaryMock },
    warning: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    setFailed: vi.fn(),
    summary: summaryMock,
  };
});

// ─── Octokit mock factory ─────────────────────────────────────────────────────
function makeOctokit({
  permission = 'write',
  getCollaboratorError = null,
  createReviewCommentError = null,
  createCommentError = null,
  getContentError = null,
  createOrUpdateError = null,
} = {}) {
  return {
    rest: {
      repos: {
        getCollaboratorPermissionLevel: getCollaboratorError
          ? vi.fn().mockRejectedValue(getCollaboratorError)
          : vi.fn().mockResolvedValue({ data: { permission } }),
        getContent: getContentError
          ? vi.fn().mockRejectedValue(getContentError)
          : vi.fn().mockResolvedValue({ data: { sha: 'dummy-sha' } }),
        createOrUpdateFileContents: createOrUpdateError
          ? vi.fn().mockRejectedValue(createOrUpdateError)
          : vi.fn().mockResolvedValue({ data: { commit: { sha: 'new-commit' } } }),
      },
      pulls: {
        createReviewComment: createReviewCommentError
          ? vi.fn().mockRejectedValue(createReviewCommentError)
          : vi.fn().mockResolvedValue({ data: { id: 1 } }),
      },
      issues: {
        createComment: createCommentError
          ? vi.fn().mockRejectedValue(createCommentError)
          : vi.fn().mockResolvedValue({ data: { id: 99 } }),
        listComments: vi.fn().mockResolvedValue({ data: [] }),
        updateComment: vi.fn().mockResolvedValue({ data: { id: 99 } })
      },
    },
  };
}

function makeContext(owner = 'test-owner', repo = 'test-repo', number = 42) {
  return { issue: { owner, repo, number } };
}

// ─── Import module under test ─────────────────────────────────────────────────
const { checkUserWritePermission, postInlineReviewComments, postPrSummaryComment, commitFixToPrBranch, postJobSummary } =
  await import('../../src/github/octokitClient.js');

// ═════════════════════════════════════════════════════════════════════════════
// checkUserWritePermission
// ═════════════════════════════════════════════════════════════════════════════
describe('checkUserWritePermission', () => {
  it('returns true for "write" permission', async () => {
    const octokit = makeOctokit({ permission: 'write' });
    expect(await checkUserWritePermission(octokit, makeContext(), 'alice')).toBe(true);
  });

  it('returns true for "admin" permission', async () => {
    const octokit = makeOctokit({ permission: 'admin' });
    expect(await checkUserWritePermission(octokit, makeContext(), 'bob')).toBe(true);
  });

  it('returns false for "read" permission', async () => {
    const octokit = makeOctokit({ permission: 'read' });
    expect(await checkUserWritePermission(octokit, makeContext(), 'eve')).toBe(false);
  });

  it('returns false for "none" permission', async () => {
    const octokit = makeOctokit({ permission: 'none' });
    expect(await checkUserWritePermission(octokit, makeContext(), 'anon')).toBe(false);
  });

  it('returns false when the API throws a 404 (non-collaborator)', async () => {
    const err = Object.assign(new Error('Not a collaborator'), { status: 404 });
    const octokit = makeOctokit({ getCollaboratorError: err });
    expect(await checkUserWritePermission(octokit, makeContext(), 'stranger')).toBe(false);
  });

  it('calls the API with correct owner/repo/username', async () => {
    const octokit = makeOctokit({ permission: 'write' });
    await checkUserWritePermission(octokit, makeContext('my-org', 'my-repo'), 'devUser');
    expect(octokit.rest.repos.getCollaboratorPermissionLevel).toHaveBeenCalledWith({
      owner: 'my-org',
      repo: 'my-repo',
      username: 'devUser',
    });
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// postInlineReviewComments — proposedTest rendering
// ═════════════════════════════════════════════════════════════════════════════
describe('postInlineReviewComments – proposedTest rendering', () => {
  const baseIssue = {
    filePath: 'src/comp.jsx',
    line: 9,
    ruleId: 'EFFECT_DIRECT_ASYNC',
    severity: 'HIGH',
    explanation: 'Direct async useEffect is an anti-pattern.',
    proposedFix: 'useEffect(() => { run(); }, [])',
  };

  it('calls createReviewComment for each issue', async () => {
    const octokit = makeOctokit();
    const issues = [{ ...baseIssue, proposedTest: null }];
    await postInlineReviewComments(octokit, makeContext(), 7, issues, 'abc123');
    expect(octokit.rest.pulls.createReviewComment).toHaveBeenCalledTimes(1);
  });

  it('includes proposedTest in comment body when provided', async () => {
    const octokit = makeOctokit();
    const issues = [{
      ...baseIssue,
      proposedTest: '```js\ntest("blocks async", () => {});\n```',
    }];
    await postInlineReviewComments(octokit, makeContext(), 7, issues, 'abc123');
    const body = octokit.rest.pulls.createReviewComment.mock.calls[0][0].body;
    expect(body).toContain('Suggested Unit Test');
  });

  it('does NOT include test section when proposedTest is null', async () => {
    const octokit = makeOctokit();
    const issues = [{ ...baseIssue, proposedTest: null }];
    await postInlineReviewComments(octokit, makeContext(), 7, issues, 'abc123');
    const body = octokit.rest.pulls.createReviewComment.mock.calls[0][0].body;
    expect(body).not.toContain('Suggested Unit Test');
  });

  it('falls back gracefully when review comment fails', async () => {
    const err = new Error('Diff hunk mismatch');
    const octokit = makeOctokit({ createReviewCommentError: err });
    const issues = [{ ...baseIssue, proposedTest: null }];
    await expect(
      postInlineReviewComments(octokit, makeContext(), 7, issues, 'abc123')
    ).resolves.not.toThrow();
  });

  it('handles empty issues array without calling the API', async () => {
    const octokit = makeOctokit();
    await postInlineReviewComments(octokit, makeContext(), 7, [], 'abc123');
    expect(octokit.rest.pulls.createReviewComment).not.toHaveBeenCalled();
  });

  it('includes the /fix suggestion in the comment body', async () => {
    const octokit = makeOctokit();
    const issues = [{ ...baseIssue, proposedTest: null }];
    await postInlineReviewComments(octokit, makeContext(), 7, issues, 'abc123');
    const body = octokit.rest.pulls.createReviewComment.mock.calls[0][0].body;
    expect(body).toContain('/bug-hunter fix');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// postPrSummaryComment
// Real signature: (octokit, context, filesScannedCount, astWarningsCount, verifiedIssues)
// ═════════════════════════════════════════════════════════════════════════════
describe('postPrSummaryComment', () => {
  const makeIssue = (overrides = {}) => ({
    filePath: 'src/comp.jsx',
    line: 9,
    ruleId: 'EFFECT_DIRECT_ASYNC',
    severity: 'HIGH',
    explanation: 'Explanation here.',
    proposedFix: 'Fix here',
    proposedTest: null,
    ...overrides,
  });

  it('posts a summary comment to the PR', async () => {
    const octokit = makeOctokit();
    const verifiedIssues = [makeIssue()];
    await postPrSummaryComment(octokit, makeContext(), 3, 5, verifiedIssues);
    expect(octokit.rest.issues.createComment).toHaveBeenCalledTimes(1);
  });

  it('includes 🔴 emoji for HIGH severity issues', async () => {
    const octokit = makeOctokit();
    const verifiedIssues = [makeIssue({ severity: 'HIGH' })];
    await postPrSummaryComment(octokit, makeContext(), 1, 1, verifiedIssues);
    const body = octokit.rest.issues.createComment.mock.calls[0][0].body;
    expect(body).toContain('🔴');
  });

  it('includes 🟡 emoji for MEDIUM severity issues', async () => {
    const octokit = makeOctokit();
    const verifiedIssues = [makeIssue({ severity: 'MEDIUM' })];
    await postPrSummaryComment(octokit, makeContext(), 1, 1, verifiedIssues);
    const body = octokit.rest.issues.createComment.mock.calls[0][0].body;
    expect(body).toContain('🟡');
  });

  it('includes 🟢 emoji for LOW severity issues', async () => {
    const octokit = makeOctokit();
    const verifiedIssues = [makeIssue({ severity: 'LOW' })];
    await postPrSummaryComment(octokit, makeContext(), 1, 1, verifiedIssues);
    const body = octokit.rest.issues.createComment.mock.calls[0][0].body;
    expect(body).toContain('🟢');
  });

  it('includes proposedTest collapsible block when provided', async () => {
    const octokit = makeOctokit();
    const proposedTest = '```js\ntest("should guard async", () => { expect(true).toBe(true); });\n```';
    const verifiedIssues = [makeIssue({ proposedTest })];
    await postPrSummaryComment(octokit, makeContext(), 1, 1, verifiedIssues);
    const body = octokit.rest.issues.createComment.mock.calls[0][0].body;
    expect(body).toContain('Suggested Unit Test');
  });

  it('does NOT include unit test section when proposedTest is null', async () => {
    const octokit = makeOctokit();
    const verifiedIssues = [makeIssue({ proposedTest: null })];
    await postPrSummaryComment(octokit, makeContext(), 1, 1, verifiedIssues);
    const body = octokit.rest.issues.createComment.mock.calls[0][0].body;
    expect(body).not.toContain('Suggested Unit Test');
  });

  it('shows ✅ Ready to Merge when no verified issues', async () => {
    const octokit = makeOctokit();
    await postPrSummaryComment(octokit, makeContext(), 3, 0, []);
    const body = octokit.rest.issues.createComment.mock.calls[0][0].body;
    expect(body).toContain('Ready to Merge');
  });

  it('shows ⚠️ Review Required when there are verified issues', async () => {
    const octokit = makeOctokit();
    await postPrSummaryComment(octokit, makeContext(), 3, 2, [makeIssue()]);
    const body = octokit.rest.issues.createComment.mock.calls[0][0].body;
    expect(body).toContain('Review Required');
  });

  it('includes scan metrics in the dashboard table', async () => {
    const octokit = makeOctokit();
    await postPrSummaryComment(octokit, makeContext(), 7, 12, [makeIssue()]);
    const body = octokit.rest.issues.createComment.mock.calls[0][0].body;
    expect(body).toContain('12'); // astWarningsCount
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// commitFixToPrBranch
// ═════════════════════════════════════════════════════════════════════════════
describe('commitFixToPrBranch', () => {
  it('successfully commits a fix to the PR branch', async () => {
    const octokit = makeOctokit();
    await commitFixToPrBranch(octokit, makeContext(), 'feature-branch', 'src/app.js', 'new code', 10);
    expect(octokit.rest.repos.getContent).toHaveBeenCalledWith({
      owner: 'test-owner',
      repo: 'test-repo',
      path: 'src/app.js',
      ref: 'feature-branch'
    });
    expect(octokit.rest.repos.createOrUpdateFileContents).toHaveBeenCalled();
    const callArgs = octokit.rest.repos.createOrUpdateFileContents.mock.calls[0][0];
    expect(callArgs.sha).toBe('dummy-sha');
    expect(callArgs.content).toBe(Buffer.from('new code').toString('base64'));
  });

  it('proceeds even if getContent throws (e.g. new file)', async () => {
    const octokit = makeOctokit({ getContentError: new Error('Not found') });
    await commitFixToPrBranch(octokit, makeContext(), 'feature-branch', 'src/new.js', 'code', 10);
    expect(octokit.rest.repos.createOrUpdateFileContents).toHaveBeenCalled();
    const callArgs = octokit.rest.repos.createOrUpdateFileContents.mock.calls[0][0];
    expect(callArgs.sha).toBeUndefined();
  });

  it('throws an error if createOrUpdateFileContents fails', async () => {
    const octokit = makeOctokit({ createOrUpdateError: new Error('API down') });
    await expect(commitFixToPrBranch(octokit, makeContext(), 'feature-branch', 'src/app.js', 'new code', 10))
      .rejects.toThrow('API down');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// postJobSummary
// ═════════════════════════════════════════════════════════════════════════════
import core from '@actions/core';
describe('postJobSummary', () => {
  beforeEach(() => {
    core.summary.addRaw.mockClear();
    core.summary.write.mockClear();
  });

  it('writes a job summary successfully with issues', async () => {
    const issues = [
      { filePath: 'a.js', line: 1, ruleId: 'R1', severity: 'HIGH' },
      { filePath: 'b.js', line: 2, ruleId: 'R2', severity: 'LOW' }
    ];
    await postJobSummary(10, 5, issues);
    
    expect(core.summary.addRaw).toHaveBeenCalled();
    const summaryHtml = core.summary.addRaw.mock.calls[0][0];
    expect(summaryHtml).toContain('10');
    expect(summaryHtml).toContain('5');
    expect(summaryHtml).toContain('🔴 HIGH');
    expect(summaryHtml).toContain('🟢 LOW');
    expect(summaryHtml).toContain('Review Required');
    expect(core.summary.write).toHaveBeenCalled();
  });

  it('writes a job summary indicating no issues', async () => {
    await postJobSummary(5, 0, []);
    
    expect(core.summary.addRaw).toHaveBeenCalled();
    const summaryHtml = core.summary.addRaw.mock.calls[0][0];
    expect(summaryHtml).toContain('Safe');
    expect(summaryHtml).toContain('Clean Bill of Health!');
  });
});
