import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import { execSync } from 'child_process';
import { analyzeCodeAST, escalateWarnings } from './src/analyzer/astParser.js';
import { huntStateBugsWithGemini } from './src/agents/bugHunterAgent.js';
import { applyFixToText, logTelemetry } from './src/index.js';

// Load local .env file if available
if (fs.existsSync('.env')) {
  dotenv.config();
}

/**
 * Extracts line-centered context from source code to assist matching.
 */
function getLineContext(code, targetLine, contextWindow = 15) {
  const lines = code.split('\n');
  const totalLines = lines.length;

  const start = Math.max(0, targetLine - 1 - contextWindow);
  const end = Math.min(totalLines, targetLine + contextWindow);

  const contextLines = [];
  for (let i = start; i < end; i++) {
    const lineNum = i + 1;
    const isTarget = lineNum === targetLine;
    const prefix = isTarget ? '>> ' : '   ';
    contextLines.push(`${prefix}${lineNum}: ${lines[i]}`);
  }

  return contextLines.join('\n');
}

async function runLocalSuite() {
  console.log("==================================================");
  console.log("🧪 PR State Bug Hunter - Advanced Verification Suite");
  console.log("==================================================");

  // Parse command line arguments for simulated CLI Auto-Fix
  const args = process.argv.slice(2);
  const fixIndex = args.indexOf('--fix');
  const fixLine = fixIndex !== -1 ? parseInt(args[fixIndex + 1], 10) : null;

  const preCommitIndex = args.indexOf('--pre-commit');
  const isPreCommit = preCommitIndex !== -1;

  if (isPreCommit) {
    console.log("\n🏎️  PR State Bug Hunter - Executing Git Pre-Commit Hook Analyzer...");

    let stagedFilesRaw = '';
    try {
      stagedFilesRaw = execSync('git diff --cached --name-only', { encoding: 'utf8' }).trim();
    } catch (err) {
      console.error(`❌ Error running git command: ${err.message}`);
      process.exit(1);
    }

    if (!stagedFilesRaw) {
      console.log("✅ No staged changes found in git repository. Hook skipped.");
      process.exit(0);
    }

    const eligibleExtensions = ['.js', '.jsx', '.ts', '.tsx', '.svelte', '.vue'];
    const stagedFiles = stagedFilesRaw.split('\n')
      .map(f => f.trim())
      .filter(f => f && eligibleExtensions.includes(path.extname(f).toLowerCase()))
      .filter(f => fs.existsSync(f));

    if (stagedFiles.length === 0) {
      console.log("✅ No analyzable staged code files found (JS, TS, Svelte, Vue). Hook skipped.");
      process.exit(0);
    }

    console.log(`Analyzing ${stagedFiles.length} staged file(s)...`);
    let totalWarningsCount = 0;
    let highSeverityWarningsCount = 0;

    for (const filePath of stagedFiles) {
      console.log(`\n🔍 Scanning file: ${filePath}`);
      
      // Get changed lines using git diff -U0
      let diffOutput = '';
      try {
        diffOutput = execSync(`git diff --cached -U0 "${filePath}"`, { encoding: 'utf8' });
      } catch (err) {
        console.warn(`[Git Diff Warning]: Could not get diff for ${filePath}: ${err.message}`);
        continue;
      }

      // Parse diff output to identify added/modified lines in the new version
      const changedLines = [];
      const lines = diffOutput.split('\n');
      for (const line of lines) {
        // e.g. @@ -80,2 +81,2 @@ or @@ -42 +42,2 @@ or @@ -12 +12 @@
        const match = line.match(/^@@\s+-\d+(?:,\d+)?\s+\+(\d+)(?:,(\d+))?\s+@@/);
        if (match) {
          const startLine = parseInt(match[1], 10);
          const count = match[2] ? parseInt(match[2], 10) : 1;
          for (let i = 0; i < count; i++) {
            changedLines.push(startLine + i);
          }
        }
      }

      if (changedLines.length === 0) {
        console.log("   No added/modified lines in this file (e.g. only deletion). Skipping AST analysis.");
        continue;
      }

      const fileContent = fs.readFileSync(filePath, 'utf8');
      const fileWarnings = analyzeCodeAST(fileContent, filePath);

      // Add path for escalation checking
      const warningsWithPath = fileWarnings.map(w => ({ ...w, path: filePath }));
      const escalatedFileWarnings = escalateWarnings(warningsWithPath, '.');

      // Filter warnings matching changed lines
      const relevantWarnings = escalatedFileWarnings.filter(w => changedLines.includes(w.line));

      if (relevantWarnings.length === 0) {
        console.log("   ✅ No state/async bugs found in staged changes!");
      } else {
        console.warn(`   ⚠️  Found ${relevantWarnings.length} AST warning(s) in staged changes:`);
        for (const w of relevantWarnings) {
          const sevPrefix = w.severity === 'HIGH' ? '🔴 HIGH' : w.severity === 'MEDIUM' ? '🟡 MEDIUM' : '🟢 LOW';
          console.warn(`      [Line ${w.line}] [${sevPrefix}] [${w.ruleId}]: ${w.message}`);
          totalWarningsCount++;
          if (w.severity === 'HIGH') {
            highSeverityWarningsCount++;
          }
        }
      }
    }

    console.log("\n==================================================");
    console.log("📊 PRE-COMMIT ANALYSIS REPORT SUMMARY");
    console.log("==================================================");
    console.log(`Total Staged Files Scanned: ${stagedFiles.length}`);
    console.log(`Total State Warnings Found: ${totalWarningsCount}`);
    console.log(`High Severity Warnings:     ${highSeverityWarningsCount}`);
    
    if (highSeverityWarningsCount > 0) {
      console.error("\n❌ Commit Rejected! Critical state vulnerabilities or memory leaks detected in your staged changes.");
      console.error("Please address the rule violations highlighted above before committing. 🛡️\n");
      process.exit(1);
    } else if (totalWarningsCount > 0) {
      console.log("\n⚠️ Commit Accepted, but with warnings. Please review the moderate/low issues before pushing. 🛡️\n");
      process.exit(0);
    } else {
      console.log("\n✅ Commit Accepted! Code is clean and structurally safe. Excellent work! 🚀\n");
      process.exit(0);
    }
  }

  const reactPath = 'src/test-cases/buggyComponent.jsx';
  const sveltePath = 'src/test-cases/buggySvelte.svelte';
  const vuePath = 'src/test-cases/buggyVue.vue';

  const apiKey = process.env.GEMINI_API_KEY || process.env.OPENAI_API_KEY;
  const localAiBaseUrl = process.env.LOCAL_AI_BASE_URL;
  const localModelName = process.env.LOCAL_MODEL_NAME;
  const hasAi = !!(apiKey || localAiBaseUrl);

  if (fixLine) {
    console.log(`\n🛠️  Executing Simulated Auto-Fix for line ${fixLine} in ${reactPath}...`);
    if (!fs.existsSync(reactPath)) {
      console.error(`Error: Test case file not found at ${reactPath}`);
      return;
    }

    if (!hasAi) {
      console.error("❌ Error: GEMINI_API_KEY, OPENAI_API_KEY, or LOCAL_AI_BASE_URL is required to generate AI fixes.");
      return;
    }

    const code = fs.readFileSync(reactPath, 'utf8');
    const warnings = analyzeCodeAST(code, reactPath);
    const mappedWarnings = escalateWarnings(warnings.map(w => ({ ...w, path: reactPath })), '.');

    const fileLinesCount = code.split('\n').length;
    const changedLines = Array.from({ length: fileLinesCount }, (_, i) => i + 1);
    const mockChanges = [{
      path: reactPath,
      patch: `+++ ${reactPath}\n@@ -1,${fileLinesCount} +1,${fileLinesCount} @@\n` + code.split('\n').map(l => `+${l}`).join('\n'),
      changedLines
    }];

    console.log("Contacting AI Agent to retrieve drop-in proposed fixes...");
    const verifiedBugs = await huntStateBugsWithGemini(
      apiKey, 
      mockChanges, 
      mappedWarnings, 
      'gemini-1.5-flash',
      { apiBaseUrl: localAiBaseUrl, modelName: localModelName }
    );

    const targetBug = verifiedBugs.find(b => String(b.line) === String(fixLine));
    if (!targetBug) {
      console.error(`❌ No AI-verified bug found on line ${fixLine}.`);
      return;
    }

    if (!targetBug.proposedFix) {
      console.error(`❌ Bug on line ${fixLine} has no proposed fix.`);
      return;
    }

    console.log(`Found bug explanation: "${targetBug.explanation}"`);
    console.log(`Proposed Fix:\n${targetBug.proposedFix}`);

    const updatedContent = applyFixToText(code, fixLine, targetBug.proposedFix);
    if (updatedContent) {
      fs.writeFileSync(reactPath, updatedContent, 'utf8');
      console.log(`\n✅ Successfully applied fix! Check changes in ${reactPath}`);
    } else {
      console.error("\n❌ Could not apply fix. Snippet matching failed.");
    }
    return;
  }

  // ----------------------------------------------------
  // TEST 1: React AST Static Scanning & Taint Tracking
  // ----------------------------------------------------
  console.log("\n[TEST 1] Running Static AST React Sweeps & Taint Tracking...");
  const reactCode = fs.readFileSync(reactPath, 'utf8');
  const reactWarningsRaw = analyzeCodeAST(reactCode, reactPath);
  const reactWarnings = escalateWarnings(reactWarningsRaw.map(w => ({ ...w, path: reactPath })), '.');

  const reactTriggered = reactWarnings.map(w => w.ruleId);
  const reactExpected = [
    'EFFECT_DIRECT_ASYNC',
    'EFFECT_UNCLEANED_SUBSCRIPTION',
    'EFFECT_UNGUARDED_ASYNC',
    'STALE_ASYNC_STATE_UPDATE',
    'UNFRAMED_STREAM_DATA'
  ];

  let reactPassed = true;
  reactExpected.forEach(rule => {
    if (reactTriggered.includes(rule)) {
      console.log(`  ✅ React Rule Triggered: ${rule}`);
    } else {
      console.error(`  ❌ React Rule MISSED: ${rule}`);
      reactPassed = false;
    }
  });

  // Verify taint tracking (TransitiveCleanComponent and CleanComponent at line 80+ should have 0 false positives)
  const falsePositives = reactWarnings.filter(w => w.line >= 80);
  if (falsePositives.length === 0) {
    console.log("  ✅ Taint Analysis Pass: 0 false-positives raised in Clean sections!");
  } else {
    console.error(`  ❌ Taint Analysis Fail: Found ${falsePositives.length} false positives in Clean sections:`);
    falsePositives.forEach(w => console.error(`     Line ${w.line}: ${w.ruleId}`));
    reactPassed = false;
  }

  // ----------------------------------------------------
  // TEST 2: Multi-Framework Svelte & Vue Rule Coverage
  // ----------------------------------------------------
  console.log("\n[TEST 2] Running Multi-Framework Svelte & Vue Sweeps...");
  
  // Svelte Check
  const svelteCode = fs.readFileSync(sveltePath, 'utf8');
  const svelteWarnings = analyzeCodeAST(svelteCode, sveltePath);
  const svelteUncleaned = svelteWarnings.filter(w => w.ruleId === 'SVELTE_UNCLEANED_SUBSCRIBE');
  console.log(`  Svelte manual subscription warnings found: ${svelteUncleaned.length} (Expected: 2)`);
  svelteUncleaned.forEach(w => console.log(`     Line ${w.line}: ${w.message}`));
  const sveltePassed = svelteUncleaned.length === 2;

  // Vue Check
  const vueCode = fs.readFileSync(vuePath, 'utf8');
  const vueWarnings = analyzeCodeAST(vueCode, vuePath);
  const vueUncleaned = vueWarnings.filter(w => w.ruleId === 'VUE_UNCLEANED_ONMOUNTED');
  console.log(`  Vue mounted listener/interval warnings found: ${vueUncleaned.length} (Expected: 2)`);
  vueUncleaned.forEach(w => console.log(`     Line ${w.line}: ${w.message}`));
  const vuePassed = vueUncleaned.length === 2;

  // ----------------------------------------------------
  // TEST 3: Semantic AI Auditing & Granular Hashing Cache Hits
  // ----------------------------------------------------
  let cachePassed = true;
  if (hasAi) {
    console.log("\n[TEST 3] Running Semantic AI Review & Incremental Cache verification...");

    const mappedReactWarnings = reactWarnings.map(w => ({ ...w, path: reactPath }));
    const fileLinesCount = reactCode.split('\n').length;
    const changedLines = Array.from({ length: fileLinesCount }, (_, i) => i + 1);
    const mockChanges = [{
      path: reactPath,
      patch: `+++ ${reactPath}\n@@ -1,${fileLinesCount} +1,${fileLinesCount} @@\n` + reactCode.split('\n').map(l => `+${l}`).join('\n'),
      changedLines
    }];

    // --- RUN 1: Fetching (Cache Miss or Initial Load) ---
    console.log("  🏎️  Executing Run 1 (Cache Miss or Initial Load)...");
    const t0 = Date.now();
    const run1Bugs = await huntStateBugsWithGemini(
      apiKey, 
      mockChanges, 
      mappedReactWarnings, 
      'gemini-1.5-flash',
      { apiBaseUrl: localAiBaseUrl, modelName: localModelName }
    );
    const t1 = Date.now();
    const run1Duration = t1 - t0;
    console.log(`  📊 Run 1 completed in ${run1Duration}ms. Found ${run1Bugs.length} verified bugs.`);

    // --- RUN 2: Executing from Cache (Cache Hit) ---
    console.log("\n  ⚡ Executing Run 2 immediately (Incremental Cache Hit test)...");
    const t2 = Date.now();
    const run2Bugs = await huntStateBugsWithGemini(
      apiKey, 
      mockChanges, 
      mappedReactWarnings, 
      'gemini-1.5-flash',
      { apiBaseUrl: localAiBaseUrl, modelName: localModelName }
    );
    const t3 = Date.now();
    const run2Duration = t3 - t2;
    console.log(`  📊 Run 2 completed in ${run2Duration}ms. Found ${run2Bugs.length} verified bugs.`);

    if (run2Duration < 50) {
      console.log(`  ✅ Cache Hit Pass: Run 2 returned instantaneously in ${run2Duration}ms (<50ms)!`);
    } else {
      console.error(`  ❌ Cache Hit Fail: Run 2 took ${run2Duration}ms (expected <50ms).`);
      cachePassed = false;
    }
  } else {
    console.log("\n[TEST 3] Skipping AI review & Caching tests (Define GEMINI_API_KEY, OPENAI_API_KEY, or LOCAL_AI_BASE_URL inside .env to test).");
  }

  // ----------------------------------------------------
  // TEST 4: Taint-Based Severity Escalation
  // ----------------------------------------------------
  console.log("\n[TEST 4] Running Taint-Based Severity Escalation Checks...");
  const sharedPath = 'src/test-cases/buggySharedComponent.jsx';
  const sharedCode = fs.readFileSync(sharedPath, 'utf8');
  const sharedWarningsRaw = analyzeCodeAST(sharedCode, sharedPath);
  const sharedWarnings = escalateWarnings(sharedWarningsRaw.map(w => ({ ...w, path: sharedPath })), '.');

  let escalationPassed = false;
  const asyncWarning = sharedWarnings.find(w => w.ruleId === 'EFFECT_UNGUARDED_ASYNC');
  if (asyncWarning) {
    if (asyncWarning.severity === 'HIGH' && asyncWarning.message.includes('Escalated: Imported by high-risk component <paymentCheckoutPortal.jsx>')) {
      console.log("  ✅ Escalation Pass: BuggySharedComponent's async warning escalated successfully to HIGH!");
      console.log(`     Message: ${asyncWarning.message}`);
      escalationPassed = true;
    } else {
      console.error(`  ❌ Escalation Fail: Severity is ${asyncWarning.severity} (expected HIGH), message: "${asyncWarning.message}"`);
    }
  } else {
    console.error("  ❌ Escalation Fail: No EFFECT_UNGUARDED_ASYNC warning found in buggySharedComponent.jsx!");
  }

  console.log("\n==================================================");
  console.log("📊 FINAL VERIFICATION REPORT");
  console.log("==================================================");
  console.log(`React/Taint Sweeps:  ${reactPassed ? '✅ PASS' : '❌ FAIL'}`);
  console.log(`Svelte store Sweeps: ${sveltePassed ? '✅ PASS' : '❌ FAIL'}`);
  console.log(`Vue listener Sweeps: ${vuePassed ? '✅ PASS' : '❌ FAIL'}`);
  console.log(`Taint Escalation:    ${escalationPassed ? '✅ PASS' : '❌ FAIL'}`);
  if (hasAi) {
    console.log(`AI Semantic Cache:  ${cachePassed ? '✅ PASS' : '❌ FAIL'}`);
  }
  console.log("==================================================");
}

runLocalSuite();
