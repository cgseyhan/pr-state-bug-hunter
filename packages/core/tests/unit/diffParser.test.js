import { describe, it, expect, vi } from 'vitest';
import { parseDiffPatch, getPrChanges } from '../../src/analyzer/diffParser.js';
import core from '@actions/core';

vi.mock('@actions/core', () => ({
  default: {
    warning: vi.fn(),
  }
}));

describe('diffParser', () => {
  describe('parseDiffPatch', () => {
    it('returns empty array when patch is null or undefined', () => {
      expect(parseDiffPatch(null)).toEqual([]);
      expect(parseDiffPatch(undefined)).toEqual([]);
      expect(parseDiffPatch('')).toEqual([]);
    });

    it('parses unified diff patch correctly', () => {
      const patch = `@@ -1,3 +1,4 @@
 line1
-line2
+newline2
+newline3
 line3`;
      const changedLines = parseDiffPatch(patch);
      expect(changedLines).toEqual([2, 3]);
    });

    it('ignores deleted lines', () => {
      const patch = `@@ -10,3 +10,2 @@
 line10
-line11
 line12`;
      const changedLines = parseDiffPatch(patch);
      expect(changedLines).toEqual([]);
    });

    it('handles context lines (unchanged lines) correctly', () => {
      const patch = `@@ -1,3 +1,4 @@
 line1
 line2
+newline3
 line3`;
      const changedLines = parseDiffPatch(patch);
      expect(changedLines).toEqual([3]);
    });
  });

  describe('getPrChanges', () => {
    it('returns parsed changes for analyzable files', async () => {
      const mockOctokit = {
        paginate: vi.fn().mockResolvedValue([
          { filename: 'src/app.js', status: 'modified', patch: '@@ -1,1 +1,2 @@\n+added' },
          { filename: 'README.md', status: 'modified', patch: '@@ -1,1 +1,2 @@\n+added' },
          { filename: 'src/deleted.ts', status: 'removed', patch: '@@ -1,1 +0,0 @@\n-deleted' },
          { filename: 'image.png', status: 'added', patch: null },
          { filename: 'component.vue', status: 'modified', patch: '@@ -1,1 +1,2 @@\n+added' },
          { filename: 'store.svelte', status: 'modified', patch: '@@ -1,1 +1,2 @@\n+added' },
          { filename: 'data.json', status: 'modified', patch: '@@ -1,1 +1,2 @@\n+added' }
        ]),
        rest: {
          pulls: {
            listFiles: vi.fn()
          }
        }
      };

      const context = { issue: { owner: 'test', repo: 'testrepo', number: 1 } };
      const changes = await getPrChanges(mockOctokit, context);

      expect(changes).toHaveLength(3);
      expect(changes[0].path).toBe('src/app.js');
      expect(changes[0].changedLines).toEqual([1]);
      expect(changes[1].path).toBe('component.vue');
      expect(changes[2].path).toBe('store.svelte');
    });

    it('catches and logs errors, returning empty array', async () => {
      const mockOctokit = {
        paginate: vi.fn().mockRejectedValue(new Error('API failure')),
        rest: {
          pulls: {
            listFiles: vi.fn()
          }
        }
      };

      const context = { issue: { owner: 'test', repo: 'testrepo', number: 1 } };
      const changes = await getPrChanges(mockOctokit, context);

      expect(changes).toEqual([]);
      expect(core.warning).toHaveBeenCalledWith('Error fetching files from GitHub API: API failure. Falling back to empty file list.');
    });
  });
});
