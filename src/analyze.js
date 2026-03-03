'use strict';

/**
 * src/analyze.js — session efficiency analysis
 * Detects retry loops, friction turns, error rates, and generates CLAUDE.md suggestions.
 * Merged from session-lens, extended with cost data integration.
 */

const path = require('path');
const { parseSessions, findAllJsonl } = require('./parse');
const { estimateCost, PRICING } = require('./cost');

const COLORS = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
  cyan: '\x1b[36m', green: '\x1b[32m', yellow: '\x1b[33m', red: '\x1b[31m',
};
const color = (c, s) => `${COLORS[c] || ''}${s}${COLORS.reset}`;
const bold = s => color('bold', s);
const fmtUsd = n => `$${(n || 0).toFixed(4)}`;

/**
 * Detect retry loops: same tool called 3+ times consecutively.
 */
function detectRetryLoops(session) {
  const toolSeq = session.turns
    .filter(t => t.role === 'assistant')
    .flatMap(t => t.toolsCalled.map(tc => tc.name));

  const loops = [];
  let i = 0;
  while (i < toolSeq.length) {
    let j = i + 1;
    while (j < toolSeq.length && toolSeq[j] === toolSeq[i]) j++;
    const runLen = j - i;
    if (runLen >= 3) {
      loops.push({ tool: toolSeq[i], count: runLen, startIndex: i });
    }
    i = j;
  }
  return loops;
}

/**
 * Detect friction turns: corrections, retries, clarifications.
 */
function detectFrictionTurns(session) {
  const friction = [];
  const humanTurns = session.turns.filter(t => t.role === 'user');

  for (let i = 0; i < humanTurns.length; i++) {
    const t = humanTurns[i];
    const text = (t.text || '').toLowerCase();
    const frictionPhrases = ['no,', 'wait,', 'actually', 'that\'s wrong', 'incorrect', 'not what', 'try again', 'wrong file', 'wrong path', 'revert', 'undo', 'go back', 'stop,', 'hold on'];
    for (const phrase of frictionPhrases) {
      if (text.includes(phrase)) {
        friction.push({ turnIndex: i, text: t.text.slice(0, 120), reason: `correction/redirect (contains "${phrase}")` });
        break;
      }
    }
  }
  return friction;
}

/**
 * Estimate cost of retry loops using session's total cost and tool invocation proportions.
 */
function estimateLoopCost(session, loops, sessionCost) {
  if (!loops.length || !sessionCost) return 0;
  const totalInvocations = session.toolInvocations ? session.toolInvocations.length : 0;
  if (!totalInvocations) return 0;
  const loopInvocationCount = loops.reduce((s, l) => s + l.count, 0);
  return (loopInvocationCount / totalInvocations) * sessionCost;
}

/**
 * Calculate session cost from token data.
 */
function calcSessionCost(session) {
  const tok = session.totalTokens;
  if (!tok) return 0;
  const model = session.model || '';
  return estimateCost(model, {
    input_tokens: tok.input,
    output_tokens: tok.output,
    cache_read_input_tokens: tok.cacheRead,
    cache_creation_input_tokens: tok.cacheCreation,
  });
}

/**
 * Generate CLAUDE.md suggestions from session analysis.
 */
function generateSuggestions(analysis) {
  const suggestions = [];

  for (const loop of analysis.retryLoops) {
    if (loop.tool === 'Read' || loop.tool === 'Bash') {
      suggestions.push(`Add to CLAUDE.md: "Read all relevant files upfront before starting changes — avoid repeated reads of the same files."`);
    } else if (loop.tool === 'Bash') {
      suggestions.push(`Add to CLAUDE.md: "Batch Bash commands where possible. Avoid running the same check repeatedly in a loop."`);
    } else {
      suggestions.push(`Add to CLAUDE.md: "Avoid repeating ${loop.tool} in tight loops — plan the sequence before executing."`);
    }
  }

  if (analysis.errorRate > 0.2) {
    suggestions.push(`Add to CLAUDE.md: "High tool error rate (${Math.round(analysis.errorRate * 100)}%) detected. Include file paths, command syntax, and expected output format in prompts."`);
  }

  if (analysis.frictionTurns.length >= 2) {
    suggestions.push(`Add to CLAUDE.md: "Multiple correction turns detected. Write more specific initial prompts — include scope, constraints, and exact file paths upfront."`);
  }

  const toolCounts = {};
  for (const t of (analysis.session.toolInvocations || [])) {
    toolCounts[t.toolName] = (toolCounts[t.toolName] || 0) + 1;
  }
  const dominantTool = Object.entries(toolCounts).sort((a, b) => b[1] - a[1])[0];
  if (dominantTool && dominantTool[1] > 20 && dominantTool[0] === 'Read') {
    suggestions.push(`Add to CLAUDE.md: "Use Glob/Grep to locate files before Read — avoid reading files speculatively."`);
  }

  // Suggest specific frequently-read files for CLAUDE.md context
  const fileReads = {};
  for (const inv of (analysis.session.toolInvocations || [])) {
    if (inv.toolName === 'Read' && inv.input && inv.input.file_path) {
      fileReads[inv.input.file_path] = (fileReads[inv.input.file_path] || 0) + 1;
    }
  }
  const repeatedFiles = Object.entries(fileReads).filter(([, count]) => count >= 3).sort((a, b) => b[1] - a[1]);
  if (repeatedFiles.length > 0) {
    const names = repeatedFiles.slice(0, 3).map(([fp]) => fp.split('/').pop()).join(', ');
    suggestions.push(`Add to CLAUDE.md: "Key files to read upfront: ${names} — these were each read 3+ times this session."`);
  }

  return [...new Set(suggestions)];
}

/**
 * Print a full reflect report for one session, combining cost + efficiency.
 */
function printReflect(session, sessionCost) {
  const cost = sessionCost || calcSessionCost(session);
  const dur = session.startTime && session.endTime
    ? Math.round((new Date(session.endTime) - new Date(session.startTime)) / 60000) + ' min'
    : '?min';

  const retryLoops = detectRetryLoops(session);
  const frictionTurns = detectFrictionTurns(session);
  const allResults = session.allToolResults || [];
  const errors = allResults.filter(r => !r.success).length;
  const errorRate = allResults.length > 0 ? errors / allResults.length : 0;

  const analysis = { session, retryLoops, frictionTurns, errorRate };
  const suggestions = generateSuggestions(analysis);

  // Tool breakdown
  const toolCounts = {};
  const toolTokens = {};
  for (const inv of (session.toolInvocations || [])) {
    toolCounts[inv.toolName] = (toolCounts[inv.toolName] || 0) + 1;
    toolTokens[inv.toolName] = (toolTokens[inv.toolName] || 0) + inv.resultTokens;
  }
  const totalResultTokens = Object.values(toolTokens).reduce((s, v) => s + v, 0) || 1;
  const toolRows = Object.entries(toolCounts).sort((a, b) => (toolTokens[b[0]] || 0) - (toolTokens[a[0]] || 0));

  const sid = session.sessionId ? session.sessionId.slice(0, 8) : path.basename(session.filePath);
  const sessionDate = session.startTime
    ? new Date(session.startTime).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })
    : null;
  console.log(`\n${bold('── reflect: session ' + sid + ' ──')}`);
  console.log(`  Project: ${color('dim', session.cwd || '(unknown)')}`);
  if (sessionDate) console.log(`  Session: ${color('dim', sessionDate)}`);
  console.log(`  Duration: ${dur}  |  Cost: ${color('green', bold(fmtUsd(cost)))}`);
  console.log(`  Turns: ${session.turns.filter(t => t.role === 'user').length} human prompts, ${session.turns.filter(t => t.role === 'assistant').length} assistant responses`);

  // Tool breakdown with cost attribution
  if (toolRows.length > 0) {
    console.log(`\n${bold('Tool breakdown:')}`);
    for (const [name, calls] of toolRows.slice(0, 8)) {
      const tok = toolTokens[name] || 0;
      const pct = Math.round((tok / totalResultTokens) * 100);
      const attr = (tok / totalResultTokens) * cost;
      const bar = '▓'.repeat(Math.max(1, Math.round(pct / 5)));
      console.log(`  ${name.padEnd(18)} ${String(calls).padStart(4)}x  ${pct.toString().padStart(3)}%  ${fmtUsd(attr).padEnd(9)} ${color('cyan', bar)}`);
    }
    const topTool = toolRows[0];
    const topPct = Math.round(((toolTokens[topTool[0]] || 0) / totalResultTokens) * 100);
    if (topPct > 50) {
      console.log(color('yellow', `\n  ⚠ ${topTool[0]} dominated at ${topPct}% of context injection.`));
    }

    // Per-file breakdown when Read is significant (>30% of tokens)
    const readPct = Math.round(((toolTokens['Read'] || 0) / totalResultTokens) * 100);
    if (readPct > 30) {
      const fileReads = {};
      for (const inv of (session.toolInvocations || [])) {
        if (inv.toolName === 'Read' && inv.input && inv.input.file_path) {
          const fp = inv.input.file_path;
          const entry = fileReads[fp] || { reads: 0, tokens: 0 };
          entry.reads++; entry.tokens += inv.resultTokens;
          fileReads[fp] = entry;
        }
      }
      const fileRows = Object.entries(fileReads).sort((a, b) => b[1].tokens - a[1].tokens).slice(0, 5);
      if (fileRows.length > 0) {
        console.log(`\n${bold('Top read files:')}`);
        for (const [fp, data] of fileRows) {
          const name = fp.split('/').slice(-2).join('/');
          const fileCost = (data.tokens / totalResultTokens) * cost;
          console.log(`  ${name.padEnd(36)} ${String(data.reads).padStart(3)}x  ${fmtUsd(fileCost)}`);
        }
      }
    }
  }

  // Retry loops
  if (retryLoops.length > 0) {
    console.log(`\n${bold('Retry loops detected:')}`);
    for (const loop of retryLoops) {
      const loopCost = estimateLoopCost(session, [loop], cost);
      console.log(`  ${color('red', '→')} ${loop.tool} called ${loop.count}x in a row — estimated wasted ${color('red', fmtUsd(loopCost))} ${color('dim', '(proportional to invocation share × session cost)')}`);
    }
  } else {
    console.log(`\n  ${color('green', '✓')} No retry loops detected.`);
  }

  // Friction turns
  if (frictionTurns.length > 0) {
    console.log(`\n${bold('Friction turns:')}`);
    for (const ft of frictionTurns) {
      console.log(`  ${color('yellow', '→')} Turn ${ft.turnIndex + 1}: ${ft.reason}`);
      console.log(`    "${ft.text.replace(/\n/g, ' ')}"`);
    }
  }

  // Tool errors
  if (allResults.length > 0) {
    const errPct = Math.round(errorRate * 100);
    const errColor = errorRate > 0.2 ? 'red' : errorRate > 0.1 ? 'yellow' : 'green';
    console.log(`\n  Tool errors: ${color(errColor, `${errors}/${allResults.length} (${errPct}%)`)}`);
    if (errors > 0) {
      const errSamples = allResults.filter(r => !r.success).slice(0, 2);
      for (const e of errSamples) {
        const errText = (e.outputSummary || '(no output)').replace(/\n/g, ' ').slice(0, 400);
        console.log(`    ${color('dim', errText)}`);
      }
    }
  }

  // Suggestions
  if (suggestions.length > 0) {
    console.log(`\n${bold('CLAUDE.md suggestions:')}`);
    for (const s of suggestions) {
      console.log(`  ${color('cyan', '→')} ${s}`);
    }
  } else {
    console.log(`\n  ${color('green', '✓')} No specific CLAUDE.md suggestions — session looks clean.`);
  }

  console.log('');
}

/**
 * Mini summary for a session (compact, ~200 tokens).
 */
function miniSummary(s) {
  if (s.error) return `Session ${s.sessionId}: ERROR - ${s.error}`;
  const dur = s.startTime && s.endTime
    ? Math.round((new Date(s.endTime) - new Date(s.startTime)) / 60000) + 'min'
    : '?min';
  const humanTurns = s.turns.filter(t => t.role === 'user').length;
  const assistantTurns = s.turns.filter(t => t.role === 'assistant').length;
  const tok = s.totalTokens;
  const toolCounts = {};
  for (const turn of s.turns) {
    for (const tc of turn.toolsCalled) toolCounts[tc.name] = (toolCounts[tc.name] || 0) + 1;
  }
  const topTools = Object.entries(toolCounts).sort((a,b) => b[1]-a[1]).slice(0, 3).map(([n, c]) => `${n}(${c})`).join(' ');
  const toolSeq = s.turns.filter(t => t.role === 'assistant').flatMap(t => t.toolsCalled.map(tc => tc.name));
  const retries = {};
  for (let i = 0; i < toolSeq.length - 2; i++) {
    if (toolSeq[i] === toolSeq[i+1] && toolSeq[i+1] === toolSeq[i+2]) retries[toolSeq[i]] = (retries[toolSeq[i]] || 0) + 1;
  }
  const retryStr = Object.keys(retries).length > 0 ? `RETRIES:${Object.entries(retries).map(([n,c])=>`${n}x${c+2}`).join(',')}` : '';
  const allResults = s.allToolResults || [];
  const errors = allResults.filter(r => !r.success).length;
  const errStr = allResults.length > 0 ? `ERRORS:${errors}/${allResults.length}` : '';
  const firstHuman = s.turns.find(t => t.role === 'user');
  const goal = firstHuman ? firstHuman.text.slice(0, 100).replace(/\n/g,' ') : '';
  return [`[${s.sessionId || path.basename(s.filePath)}]`, `${dur} ${humanTurns}prompts ${assistantTurns}asst`, `tok:${tok.input}in/${tok.output}out`, topTools ? `tools:${topTools}` : '', retryStr, errStr, goal ? `goal:"${goal}"` : ''].filter(Boolean).join(' | ');
}

/**
 * Run reflect analysis on a project's most recent session (or a specific one).
 */
function runReflect(opts) {
  const { projectCwd, sessionId, recent = 1 } = opts;
  const all = findAllJsonl(projectCwd);

  if (all.length === 0) {
    console.log(color('red', projectCwd
      ? `No sessions found for project: ${projectCwd}`
      : 'No sessions found in ~/.claude/projects'));
    process.exit(1);
  }

  let filePaths;
  if (sessionId) {
    const match = all.find(f => f.fp.includes(sessionId));
    if (!match) { console.log(color('red', `Session not found: ${sessionId}`)); process.exit(1); }
    filePaths = [match.fp];
  } else {
    filePaths = all.slice(0, recent).map(f => f.fp);
  }

  const sessions = parseSessions(filePaths);
  if (!sessions || sessions.length === 0) {
    console.log(color('yellow', 'No session data could be parsed from the matched files.'));
    process.exit(1);
  }
  for (const s of sessions) {
    if (s.error) { console.log(color('red', `Error parsing ${s.filePath}: ${s.error}`)); continue; }
    if (!s.turns || s.turns.length === 0) {
      console.log(color('yellow', `Session ${s.sessionId || s.filePath}: no turns found (empty session?)`));
      continue;
    }
    printReflect(s, null);
  }
}

module.exports = { runReflect, printReflect, calcSessionCost, detectRetryLoops, detectFrictionTurns, miniSummary };
