import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import { analyzeCodeAST } from './src/analyzer/astParser.js';
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

  const reactPath = 'src/test-cases/buggyComponent.jsx';
  const sveltePath = 'src/test-cases/buggySvelte.svelte';
  const vuePath = 'src/test-cases/buggyVue.vue';

  const apiKey = process.env.GEMINI_API_KEY || process.env.OPENAI_API_KEY;

  if (fixLine) {
    console.log(`\n🛠️  Executing Simulated Auto-Fix for line ${fixLine} in ${reactPath}...`);
    if (!fs.existsSync(reactPath)) {
      console.error(`Error: Test case file not found at ${reactPath}`);
      return;
    }

    if (!apiKey) {
      console.error("❌ Error: GEMINI_API_KEY or OPENAI_API_KEY is required to generate AI fixes.");
      return;
    }

    const code = fs.readFileSync(reactPath, 'utf8');
    const warnings = analyzeCodeAST(code, reactPath);
    const mappedWarnings = warnings.map(w => ({ ...w, path: reactPath }));

    const fileLinesCount = code.split('\n').length;
    const changedLines = Array.from({ length: fileLinesCount }, (_, i) => i + 1);
    const mockChanges = [{
      path: reactPath,
      patch: `+++ ${reactPath}\n@@ -1,${fileLinesCount} +1,${fileLinesCount} @@\n` + code.split('\n').map(l => `+${l}`).join('\n'),
      changedLines
    }];

    console.log("Contacting AI Agent to retrieve drop-in proposed fixes...");
    const verifiedBugs = await huntStateBugsWithGemini(apiKey, mockChanges, mappedWarnings, 'gemini-1.5-flash');

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
  const reactWarnings = analyzeCodeAST(reactCode, reactPath);

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
  if (apiKey) {
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
    const run1Bugs = await huntStateBugsWithGemini(apiKey, mockChanges, mappedReactWarnings, 'gemini-1.5-flash');
    const t1 = Date.now();
    const run1Duration = t1 - t0;
    console.log(`  📊 Run 1 completed in ${run1Duration}ms. Found ${run1Bugs.length} verified bugs.`);

    // --- RUN 2: Executing from Cache (Cache Hit) ---
    console.log("\n  ⚡ Executing Run 2 immediately (Incremental Cache Hit test)...");
    const t2 = Date.now();
    const run2Bugs = await huntStateBugsWithGemini(apiKey, mockChanges, mappedReactWarnings, 'gemini-1.5-flash');
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
    console.log("\n[TEST 3] Skipping AI review & Caching tests (Define GEMINI_API_KEY/OPENAI_API_KEY inside .env to test).");
  }

  console.log("\n==================================================");
  console.log("📊 FINAL VERIFICATION REPORT");
  console.log("==================================================");
  console.log(`React/Taint Sweeps:  ${reactPassed ? '✅ PASS' : '❌ FAIL'}`);
  console.log(`Svelte store Sweeps: ${sveltePassed ? '✅ PASS' : '❌ FAIL'}`);
  console.log(`Vue listener Sweeps: ${vuePassed ? '✅ PASS' : '❌ FAIL'}`);
  if (apiKey) {
    console.log(`AI Semantic Cache:  ${cachePassed ? '✅ PASS' : '❌ FAIL'}`);
  }
  console.log("==================================================");
}

runLocalSuite();
