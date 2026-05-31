import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { isHighRiskFile, buildDependencyGraph } from '../../src/analyzer/dependencyGraph.js';
import fs from 'fs';
import path from 'path';
import os from 'os';

describe('Dependency Graph Enhancements', () => {
  describe('isHighRiskFile with Overrides', () => {
    it('detects high risk via built-in heuristics', () => {
      expect(isHighRiskFile('src/billing.js')).toBe(true);
      expect(isHighRiskFile('src/login/auth.ts')).toBe(true);
      expect(isHighRiskFile('src/utils.js')).toBe(false);
    });

    it('detects high risk via content heuristics', () => {
      expect(isHighRiskFile('src/utils.js', 'const api_key = "123";')).toBe(true);
    });

    it('detects high risk via explicit pattern overrides', () => {
      const overrides = [
        'src/core/critical\\.js',
        'src/legacy/.*'
      ];
      
      expect(isHighRiskFile('src/core/critical.js', '', overrides, '')).toBe(true);
      expect(isHighRiskFile('src/legacy/oldCode.js', '', overrides, '')).toBe(true);
      expect(isHighRiskFile('src/core/other.js', '', overrides, '')).toBe(false);
    });
  });

  describe('buildDependencyGraph with dependency-graph-overrides.json', () => {
    let tmpDir;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bug-hunter-dep-test-'));
      // Create some dummy files
      fs.writeFileSync(path.join(tmpDir, 'safe.js'), 'console.log("safe");');
      fs.writeFileSync(path.join(tmpDir, 'overridden-critical.js'), 'console.log("critical");');
    });

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('loads overrides and flags matched files as high risk', () => {
      const overridesConfig = {
        highRiskPaths: ['overridden-critical\\.js']
      };
      
      fs.writeFileSync(path.join(tmpDir, 'dependency-graph-overrides.json'), JSON.stringify(overridesConfig));

      const { highRiskFiles } = buildDependencyGraph(tmpDir);
      
      const criticalPath = path.join(tmpDir, 'overridden-critical.js');
      const safePath = path.join(tmpDir, 'safe.js');

      expect(highRiskFiles.has(criticalPath)).toBe(true);
      expect(highRiskFiles.has(safePath)).toBe(false);
    });
  });
});
