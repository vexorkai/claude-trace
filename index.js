#!/usr/bin/env node
'use strict';

const os = require('os');
const path = require('path');

const COLORS = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m', cyan: '\x1b[36m', green: '\x1b[32m', yellow: '\x1b[33m', red: '\x1b[31m'
};
const color = (c, s) => `${COLORS[c] || ''}${s}${COLORS.reset}`;
const bold = s => color('bold', s);
const fmtNum = n => Number(n || 0).toLocaleString();
const fmtUsd = n => `$${(n || 0).toFixed(3)}`;
const shortId = id => (id || '').slice(0, 8);

function parseArgs(argv) {
  const args = new Set(argv);
  const val = (f, d) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
  return {
    help: args.has('--help') || args.has('-h'),
    sessions: args.has('--sessions'),
    tools: args.has('--tools'),
    reads: args.has('--reads'),
    projects: args.has('--projects'),
    timeline: args.has('--timeline'),
    reflect: args.has('--reflect'),
    top: parseInt(val('--top', '5'), 10) || 5,
    days: parseInt(val('--days', '0'), 10) || 0,
    session: val('--session', null),
    project: val('--project', null),
    recent: parseInt(val('--recent', '1'), 10) || 1,
  };
}

function usage() {
  console.log(`
${bold('claude-trace')} — Claude Code token cost attribution

claude-trace tells you what your Claude Code sessions cost and whether they were worth it.

${bold('Usage:')}
  claude-trace                   Summary view
  claude-trace --sessions        Sessions breakdown
  claude-trace --tools           Tool cost attribution
  claude-trace --reads           File-level read cost breakdown
  claude-trace --projects        Project breakdown
  claude-trace --timeline        14-day timeline with tool breakdown
  claude-trace --session <id>    Drill into a specific session turn-by-turn
  claude-trace --reflect         Analyze most recent session for efficiency
  claude-trace --reflect --project <path>   Analyze specific project's last session
  claude-trace --reflect --session <id>     Analyze specific session
  claude-trace --reflect --recent <N>       Analyze N most recent sessions

${bold('Options:')}
  --top N                        Show top N rows (default 5)
  --days N                       Look back N days (default all)
  --help                         Show this help

ccusage shows how much. claude-trace shows why.
`);
}

function topToolByResult(m) {
  const e = Object.entries(m || {}).sort((a, b) => b[1] - a[1]);
  return e[0] ? e[0][0] : '-';
}

function printSummary(d, topN) {
  const t = d.totals;
  const today = new Date().toISOString().slice(0,10), y = new Date(Date.now()-86400000).toISOString().slice(0,10);
  let weekTokens = 0;
  for (const [k,v] of d.byDay) if (Date.now() - new Date(k).getTime() <= 7*86400000) weekTokens += v.input_tokens+v.output_tokens+v.cache_read_input_tokens+v.cache_creation_input_tokens;
  const ta = d.byDay.get(today) || {input_tokens:0,output_tokens:0,cache_read_input_tokens:0,cache_creation_input_tokens:0,totalCost:0};
  const ya = d.byDay.get(y) || {input_tokens:0,output_tokens:0,cache_read_input_tokens:0,cache_creation_input_tokens:0,totalCost:0};

  console.log(`\n${bold('claude-trace')}`);
  console.log(color('dim', 'claude-trace tells you what your Claude Code sessions cost and whether they were worth it.\n'));
  console.log(`${color('cyan','Total tokens:')} ${bold(fmtNum(t.input_tokens+t.output_tokens+t.cache_read_input_tokens+t.cache_creation_input_tokens))}`);
  console.log(`  cache read: ${fmtNum(t.cache_read_input_tokens)}  cache create: ${fmtNum(t.cache_creation_input_tokens)}`);
  console.log(`${color('green','Estimated total cost:')} ${bold(fmtUsd(t.totalCost))}`);

  const tt = ta.input_tokens+ta.output_tokens+ta.cache_read_input_tokens+ta.cache_creation_input_tokens;
  const yt = ya.input_tokens+ya.output_tokens+ya.cache_read_input_tokens+ya.cache_creation_input_tokens;
  console.log(`\n${bold('Activity')}`);
  console.log(`  Today:     ${fmtNum(tt)} tokens (${fmtUsd(ta.totalCost)})`);
  console.log(`  Yesterday: ${fmtNum(yt)} tokens (${fmtUsd(ya.totalCost)})`);
  console.log(`  7 days:    ${fmtNum(weekTokens)} tokens`);

  const toolRows = Array.from(d.byTool.values()).sort((a,b)=>b.attributedCost-a.attributedCost);
  if (toolRows.length > 0) {
    const top = toolRows[0];
    const topCall = [...toolRows].sort((a,b)=>b.calls-a.calls)[0];
    console.log(`\n${bold('Most expensive habits')}`);
    console.log(`  Cost driver: ${color('yellow', top.name)} — ${fmtUsd(top.attributedCost)} (${top.pctOfTotal.toFixed(0)}% of all cost)`);
    if (topCall && topCall.name !== top.name) console.log(`  Most called: ${topCall.name} — ${fmtNum(topCall.calls)} calls`);
    const hidden = toolRows.find(t => t.name !== top.name && t.avgCostPerCall > top.avgCostPerCall);
    if (hidden) console.log(`  Hidden cost: ${hidden.name} — ${fmtUsd(hidden.avgCostPerCall)}/call avg`);
  }

  const rows = Array.from(d.bySession.values()).sort((a,b)=>b.totalCost-a.totalCost).slice(0, topN);
  console.log(`\n${bold(`Top ${topN} sessions`)}`);
  for (const s of rows) {
    const tok = s.input_tokens+s.output_tokens+s.cache_read_input_tokens+s.cache_creation_input_tokens;
    const driver = topToolByResult(s.toolsByResult);
    console.log(`  ${shortId(s.sessionId)}  ${fmtUsd(s.totalCost)}  ${fmtNum(tok).padStart(10)} tok  ${color('yellow', driver.padEnd(16))}  ${color('dim', s.project)}`);
  }
  console.log(color('dim', '\n  Run --session <id> to drill into any session\n  Run --reflect --project <path> for efficiency analysis'));
}

function printSessions(d, topN) {
  const rows = Array.from(d.bySession.values()).sort((a,b)=>b.totalCost-a.totalCost).slice(0, topN);
  console.log(`\n${bold(`Sessions (top ${topN} by cost)`)}`);
  console.log(color('dim','session    date        cost      tokens       cost driver        project'));
  for (const s of rows) {
    const date = (s.lastTs || '').slice(0,10);
    const tok = s.input_tokens+s.output_tokens+s.cache_read_input_tokens+s.cache_creation_input_tokens;
    const driver = topToolByResult(s.toolsByResult);
    console.log(`${shortId(s.sessionId).padEnd(10)} ${date.padEnd(10)} ${fmtUsd(s.totalCost).padEnd(9)} ${fmtNum(tok).padEnd(12)} ${driver.padEnd(18)} ${s.project}`);
  }
}

function printTools(d, topN) {
  const rows = Array.from(d.byTool.values()).sort((a,b)=>b.attributedCost-a.attributedCost).slice(0, topN);
  console.log(`\n${bold('Tools by attributed cost')}`);
  console.log(color('dim','tool                 calls    cost       avg/call   % of total'));
  for (const t of rows) {
    const bar = '▓'.repeat(Math.max(1, Math.round(t.pctOfTotal / 4)));
    console.log(`${t.name.padEnd(20)} ${String(t.calls).padEnd(8)} ${fmtUsd(t.attributedCost).padEnd(10)} ${fmtUsd(t.avgCostPerCall).padEnd(10)} ${t.pctOfTotal.toFixed(0).padStart(3)}%  ${color('cyan', bar)}`);
  }
  console.log(color('dim','\n* Attribution: tool_result content size → tokens injected → proportional cost'));
}

function commonPrefix(paths) {
  if (paths.length === 0) return '';
  const parts = paths[0].split('/');
  let prefix = '';
  for (let i = 0; i < parts.length - 1; i++) {
    const candidate = parts.slice(0, i + 1).join('/') + '/';
    if (paths.every(p => p.startsWith(candidate))) prefix = candidate;
    else break;
  }
  return prefix;
}

function printReads(d, topN) {
  const rows = Array.from(d.byFile.values()).sort((a, b) => b.attributedCost - a.attributedCost).slice(0, topN);
  if (rows.length === 0) { console.log(color('yellow', '\nNo Read invocations with file paths found.')); return; }
  const prefix = commonPrefix(rows.map(r => r.filePath));
  const strip = fp => prefix ? fp.slice(prefix.length) : fp;
  console.log(`\n${bold('Files by read cost')}`);
  console.log(color('dim', 'file                                       reads     cost       sessions'));
  for (const r of rows) {
    const name = strip(r.filePath);
    const display = name.length > 40 ? '...' + name.slice(name.length - 37) : name;
    console.log(`${display.padEnd(42)} ${String(r.reads).padStart(5)}  ${fmtUsd(r.attributedCost).padEnd(10)} ${String(r.sessions.size).padStart(4)}`);
  }
  const totalReadCost = Array.from(d.byFile.values()).reduce((s, r) => s + r.attributedCost, 0);
  const totalCost = d.totals.totalCost || 1;
  console.log(`\n${color('dim', `Total read cost: ${fmtUsd(totalReadCost)} (${Math.round(totalReadCost / totalCost * 100)}% of all spend)`)}`);
  const topFile = rows[0];
  if (topFile && topFile.reads >= 3) {
    console.log(color('yellow', `\n  → Consider adding frequently-read files to CLAUDE.md context`));
    console.log(color('yellow', `  → Large files read often suggest splitting or using Grep instead`));
  }
}

function printProjects(d, topN) {
  const rows = Array.from(d.byProject.values()).sort((a,b)=>b.totalCost-a.totalCost).slice(0, topN);
  console.log(`\n${bold(`Projects (top ${topN} by cost)`)}`);
  console.log(color('dim','project                         cost      input      output     cache-r     cache-c'));
  for (const p of rows) {
    console.log(`${p.project.padEnd(30)} ${fmtUsd(p.totalCost).padEnd(9)} ${fmtNum(p.input_tokens).padEnd(10)} ${fmtNum(p.output_tokens).padEnd(10)} ${fmtNum(p.cache_read_input_tokens).padEnd(11)} ${fmtNum(p.cache_creation_input_tokens)}`);
  }
}

function printTimeline(d) {
  const rows = Array.from(d.byDay.values()).sort((a,b)=>a.day.localeCompare(b.day)).slice(-14);
  const max = Math.max(1, ...rows.map(r=>r.input_tokens+r.output_tokens+r.cache_read_input_tokens+r.cache_creation_input_tokens));
  console.log(`\n${bold('Timeline (last 14 days)')}`);
  for (const r of rows) {
    const tok = r.input_tokens+r.output_tokens+r.cache_read_input_tokens+r.cache_creation_input_tokens;
    const bar = '█'.repeat(Math.round((tok/max)*28));
    const totalToolToks = Object.values(r.toolTokens||{}).reduce((s,v)=>s+v,0)||1;
    const topTools = Object.entries(r.toolTokens||{}).sort((a,b)=>b[1]-a[1]).slice(0,3)
      .map(([n,t]) => `${n}:${Math.round(t/totalToolToks*100)}%`).join(' ');
    console.log(`${r.day}  ${bar.padEnd(28)}  ${fmtNum(tok).padStart(9)}  ${fmtUsd(r.totalCost)}`);
    if (topTools) console.log(`${' '.repeat(11)}${color('dim', topTools)}`);
  }
}

function printSession(d, partialId) {
  const { listJsonlAll } = require('./src/parse');
  const { estimateTokens } = require('./src/parse');
  const files = listJsonlAll();
  const fs = require('fs');
  let targetFile = null, targetSid = null;

  for (const f of files) {
    let txt = ''; try { txt = fs.readFileSync(f, 'utf8'); } catch { continue; }
    for (const line of txt.split('\n')) {
      let r; try { r = JSON.parse(line); } catch { continue; }
      if (r && r.sessionId && r.sessionId.startsWith(partialId)) { targetFile = f; targetSid = r.sessionId; break; }
    }
    if (targetFile) break;
  }

  if (!targetFile) { console.log(color('red', `Session ${partialId} not found`)); return; }

  let txt = ''; try { txt = require('fs').readFileSync(targetFile, 'utf8'); } catch { return; }
  const lines = txt.split('\n').filter(Boolean);

  // Simple inline tool result parsing for this view
  const invocations = [];
  const pendingTools = new Map();
  let turnIdx = 0;
  for (const line of lines) {
    let r; try { r = JSON.parse(line); } catch { continue; }
    if (r && r.type === 'assistant' && r.message && r.message.content) {
      for (const block of r.message.content) {
        if (block && block.type === 'tool_use' && block.id && block.name) pendingTools.set(block.id, { name: block.name, turnIdx, input: block.input || {} });
      }
      turnIdx++;
    }
    if (r && r.type === 'user' && r.message && r.message.content) {
      for (const block of r.message.content) {
        if (block && block.type === 'tool_result' && block.tool_use_id) {
          const tool = pendingTools.get(block.tool_use_id);
          if (tool) {
            invocations.push({ turnIndex: tool.turnIdx, toolName: tool.name, resultTokens: estimateTokens(block.content), isError: block.is_error || false, input: tool.input });
            pendingTools.delete(block.tool_use_id);
          }
        }
      }
    }
  }

  const sd = d.bySession.get(targetSid);
  if (!sd) { console.log(color('red', 'Session data not found')); return; }

  const sessionCost = sd.totalCost;
  const totalRT = invocations.reduce((s, i) => s + i.resultTokens, 0) || 1;
  const attributed = invocations.map(inv => ({ ...inv, attributedCost: (inv.resultTokens / totalRT) * sessionCost })).sort((a,b)=>b.attributedCost-a.attributedCost);

  console.log(`\n${bold(`Session ${shortId(targetSid)}`)} — ${fmtUsd(sessionCost)} total — ${(sd.lastTs||'').slice(0,10)}`);
  console.log(`${color('dim', sd.project)}\n`);
  console.log(bold('Top tool invocations by cost:'));
  console.log(color('dim', 'turn  tool                 result-tok  attributed-cost'));
  for (const inv of attributed.slice(0, 20)) {
    const pct = (inv.attributedCost / sessionCost * 100).toFixed(0);
    const flag = inv.attributedCost > sessionCost * 0.15 ? color('yellow', ' ← EXPENSIVE') : '';
    const errFlag = inv.isError ? color('red', ' [ERR]') : '';
    console.log(`${String(inv.turnIndex+1).padStart(4)}  ${inv.toolName.padEnd(20)} ${fmtNum(inv.resultTokens).padStart(10)}  ${fmtUsd(inv.attributedCost).padEnd(10)} ${pct}%${flag}${errFlag}`);
  }
  if (attributed.length > 20) console.log(color('dim', `  ... and ${attributed.length-20} more`));

  const byTool = new Map();
  for (const inv of attributed) {
    const t = byTool.get(inv.toolName) || { name: inv.toolName, calls: 0, cost: 0 };
    t.calls++; t.cost += inv.attributedCost; byTool.set(inv.toolName, t);
  }
  console.log(`\n${bold('By tool:')}`);
  for (const t of Array.from(byTool.values()).sort((a,b)=>b.cost-a.cost)) {
    const pct = (t.cost / sessionCost * 100).toFixed(0);
    console.log(`  ${t.name.padEnd(20)} ${String(t.calls).padEnd(6)} calls  ${fmtUsd(t.cost)}  ${pct}%`);
  }
}

function main() {
  const a = parseArgs(process.argv.slice(2));
  if (a.help) return usage();

  if (a.reflect) {
    const { runReflect } = require('./src/analyze');
    return runReflect({ projectCwd: a.project, sessionId: a.session, recent: a.recent });
  }

  const { load } = require('./src/cost');
  const d = load(a.days);
  if (!d.files) { console.log(color('red','No session files found at ~/.claude/projects')); process.exit(1); }

  if (a.session) printSession(d, a.session);
  else if (a.sessions) printSessions(d, a.top);
  else if (a.tools) printTools(d, a.top);
  else if (a.reads) printReads(d, a.top);
  else if (a.projects) printProjects(d, a.top);
  else if (a.timeline) printTimeline(d);
  else printSummary(d, a.top);

  console.log(`\n${color('dim',`Scanned ${fmtNum(d.files)} files, ${fmtNum(d.linesRead)} lines, ${fmtNum(d.parseErrors)} parse errors`)}`);
}

main();
