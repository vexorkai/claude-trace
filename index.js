#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const os = require('os');

const COLORS = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m', cyan: '\x1b[36m', green: '\x1b[32m', yellow: '\x1b[33m', red: '\x1b[31m'
};
const PRICING = {
  sonnet: { input: 3, output: 15, cacheReadFactor: 0.1, cacheCreateFactor: 1.25 },
  opus: { input: 15, output: 75, cacheReadFactor: 0.1, cacheCreateFactor: 1.25 }
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
    sessions: args.has('--sessions'), tools: args.has('--tools'), projects: args.has('--projects'), timeline: args.has('--timeline'),
    top: parseInt(val('--top', '5'), 10) || 5,
    days: parseInt(val('--days', '0'), 10) || 0,
    session: val('--session', null),
  };
}

function usage() {
  console.log(`\n${bold('claude-trace')} — Claude Code token cost attribution\n\nUsage:\n  claude-trace                   Summary view\n  claude-trace --sessions        Sessions breakdown\n  claude-trace --tools           Tool cost attribution (v0.2)\n  claude-trace --projects        Project breakdown\n  claude-trace --timeline        14-day timeline with tool breakdown\n  claude-trace --session <id>    Drill into a specific session turn-by-turn\n\nOptions:\n  --top N                        Show top N rows (default 5)\n  --days N                       Look back N days (default all)\n  --help                         Show this help\n\nccusage shows how much. claude-trace shows why.\n`);
}

function listJsonl(dir) {
  const out = [];
  const walk = d => {
    let entries = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && p.endsWith('.jsonl')) out.push(p);
    }
  };
  walk(dir);
  return out;
}

const pickTier = m => (String(m || '').toLowerCase().includes('opus') ? 'opus' : 'sonnet');

function estimateCost(model, u) {
  const p = PRICING[pickTier(model)];
  const input = +u.input_tokens || 0, output = +u.output_tokens || 0, cr = +u.cache_read_input_tokens || 0, cc = +u.cache_creation_input_tokens || 0;
  return {
    total: (input/1e6)*p.input + (output/1e6)*p.output + (cr/1e6)*(p.input*p.cacheReadFactor) + (cc/1e6)*(p.input*p.cacheCreateFactor)
  };
}

function estimateTokens(content) {
  if (!content) return 0;
  if (typeof content === 'string') return Math.ceil(content.length / 4);
  if (Array.isArray(content)) return content.reduce((s, c) => s + estimateTokens(c && (c.text || c.content || '')), 0);
  if (typeof content === 'object') return estimateTokens(content.text || content.content || JSON.stringify(content));
  return 0;
}

function parseToolResults(lines) {
  const invocations = [];
  const pendingTools = new Map();
  let turnIndex = 0;
  for (const line of lines) {
    let r; try { r = JSON.parse(line); } catch { continue; }
    if (r && r.type === 'assistant' && r.message && r.message.content) {
      for (const block of r.message.content) {
        if (block && block.type === 'tool_use' && block.id && block.name) {
          pendingTools.set(block.id, { name: block.name, turnIndex });
        }
      }
      turnIndex++;
    }
    if (r && r.type === 'user' && r.message && r.message.content) {
      for (const block of r.message.content) {
        if (block && block.type === 'tool_result' && block.tool_use_id) {
          const tool = pendingTools.get(block.tool_use_id);
          if (tool) {
            invocations.push({ turnIndex: tool.turnIndex, toolName: tool.name, resultTokens: estimateTokens(block.content), isError: block.is_error || false });
            pendingTools.delete(block.tool_use_id);
          }
        }
      }
    }
  }
  return invocations;
}

const empty = () => ({ turns: 0, input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, totalCost: 0 });
function add(a, u, c) {
  a.turns++; a.input_tokens += +u.input_tokens||0; a.output_tokens += +u.output_tokens||0;
  a.cache_read_input_tokens += +u.cache_read_input_tokens||0; a.cache_creation_input_tokens += +u.cache_creation_input_tokens||0;
  a.totalCost += c.total;
}

const projectLabel = cwd => { if (!cwd) return '(unknown)'; const p = cwd.split('/').filter(Boolean); return p.slice(-2).join('/'); };
const dayKey = ts => ts ? new Date(ts).toISOString().slice(0, 10) : null;

function load(days) {
  const root = path.join(os.homedir(), '.claude', 'projects');
  const files = listJsonl(root);
  const since = days > 0 ? Date.now() - days * 86400000 : 0;
  const totals = empty(), bySession = new Map(), byProject = new Map(), byToolV2 = new Map(), byDay = new Map();
  let parseErrors = 0, linesRead = 0;

  for (const f of files) {
    let txt = ''; try { txt = fs.readFileSync(f, 'utf8'); } catch { continue; }
    const lines = txt.split('\n').filter(Boolean);
    linesRead += lines.length;

    // Pass 1: session stats
    for (const line of lines) {
      let r; try { r = JSON.parse(line); } catch { parseErrors++; continue; }
      if (!r || r.type !== 'assistant' || !r.message || !r.message.usage) continue;
      const t = r.timestamp ? new Date(r.timestamp).getTime() : 0;
      if (since && (!t || t < since)) continue;
      const u = r.message.usage, c = estimateCost(r.message.model, u);
      add(totals, u, c);
      const sid = r.sessionId || 'unknown';
      const s = bySession.get(sid) || { sessionId: sid, project: projectLabel(r.cwd), cwd: r.cwd || '(unknown)', firstTs: r.timestamp, lastTs: r.timestamp, tools: {}, toolsByResult: {}, ...empty() };
      add(s, u, c);
      if (r.timestamp && (!s.firstTs || r.timestamp < s.firstTs)) s.firstTs = r.timestamp;
      if (r.timestamp && (!s.lastTs || r.timestamp > s.lastTs)) s.lastTs = r.timestamp;
      for (const block of (r.message.content || [])) {
        if (block && block.type === 'tool_use') s.tools[block.name || 'Unknown'] = (s.tools[block.name || 'Unknown'] || 0) + 1;
      }
      bySession.set(sid, s);
      const pk = projectLabel(r.cwd);
      const p = byProject.get(pk) || { project: pk, ...empty() }; add(p, u, c); byProject.set(pk, p);
      const dk = dayKey(r.timestamp);
      if (dk) { const d = byDay.get(dk) || { day: dk, ...empty(), toolTokens: {} }; add(d, u, c); byDay.set(dk, d); }
    }

    // Pass 2: tool result attribution
    const sid2 = (() => { for (const l of lines) { let r; try { r = JSON.parse(l); } catch { continue; } if (r && r.sessionId) return r.sessionId; } return null; })();
    const sd = sid2 ? bySession.get(sid2) : null;
    if (sd && sd.totalCost > 0) {
      const invs = parseToolResults(lines);
      const totalRT = invs.reduce((s, i) => s + i.resultTokens, 0) || 1;
      for (const inv of invs) {
        const frac = inv.resultTokens / totalRT;
        const cost = frac * sd.totalCost;
        const row = byToolV2.get(inv.toolName) || { name: inv.toolName, calls: 0, resultTokens: 0, attributedCost: 0 };
        row.calls++; row.resultTokens += inv.resultTokens; row.attributedCost += cost;
        byToolV2.set(inv.toolName, row);
        sd.toolsByResult[inv.toolName] = (sd.toolsByResult[inv.toolName] || 0) + cost;
        const dk3 = dayKey(sd.lastTs);
        if (dk3) { const d = byDay.get(dk3); if (d) { d.toolTokens[inv.toolName] = (d.toolTokens[inv.toolName] || 0) + inv.resultTokens; } }
      }
    }
  }

  const totalAttr = Array.from(byToolV2.values()).reduce((s, t) => s + t.attributedCost, 0) || 1;
  for (const t of byToolV2.values()) {
    t.pctOfTotal = (t.attributedCost / totalAttr) * 100;
    t.avgCostPerCall = t.calls ? t.attributedCost / t.calls : 0;
  }

  return { files: files.length, linesRead, parseErrors, totals, bySession, byProject, byTool: byToolV2, byDay };
}

const topToolByResult = m => { const e = Object.entries(m || {}).sort((a,b)=>b[1]-a[1]); return e[0] ? e[0][0] : '-'; };

function printSummary(d, topN) {
  const t = d.totals;
  const today = new Date().toISOString().slice(0,10), y = new Date(Date.now()-86400000).toISOString().slice(0,10);
  let weekTokens = 0;
  for (const [k,v] of d.byDay) if (Date.now() - new Date(k).getTime() <= 7*86400000) weekTokens += v.input_tokens+v.output_tokens+v.cache_read_input_tokens+v.cache_creation_input_tokens;
  const ta = d.byDay.get(today) || empty(), ya = d.byDay.get(y) || empty();

  console.log(`\n${bold('claude-trace v0.2')}`);
  console.log(color('dim', 'ccusage shows how much. claude-trace shows why.\n'));
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
  console.log(color('dim', '\n  Run --session <id> to drill into any session'));
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
  const root = path.join(os.homedir(), '.claude', 'projects');
  const files = listJsonl(root);
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

  let txt = ''; try { txt = fs.readFileSync(targetFile, 'utf8'); } catch { return; }
  const lines = txt.split('\n').filter(Boolean);
  const invocations = parseToolResults(lines);
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
  const d = load(a.days);
  if (!d.files) { console.log(color('red','No session files found at ~/.claude/projects')); process.exit(1); }

  if (a.session) printSession(d, a.session);
  else if (a.sessions) printSessions(d, a.top);
  else if (a.tools) printTools(d, a.top);
  else if (a.projects) printProjects(d, a.top);
  else if (a.timeline) printTimeline(d);
  else printSummary(d, a.top);

  console.log(`\n${color('dim',`Scanned ${fmtNum(d.files)} files, ${fmtNum(d.linesRead)} lines, ${fmtNum(d.parseErrors)} parse errors`)}`);
}

main();
