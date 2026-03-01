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
const fmtUsd = n => `$${(n || 0).toFixed(2)}`;
const shortId = id => (id || '').slice(0, 8);

function parseArgs(argv) {
  const args = new Set(argv);
  const val = (f, d) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
  return {
    help: args.has('--help') || args.has('-h'),
    sessions: args.has('--sessions'), tools: args.has('--tools'), projects: args.has('--projects'), timeline: args.has('--timeline'),
    top: parseInt(val('--top', '5'), 10) || 5,
    days: parseInt(val('--days', '0'), 10) || 0,
  };
}

function usage() {
  console.log(`\n${bold('claude-trace')} — Claude Code token usage analytics\n\nUsage:\n  claude-trace              Summary view\n  claude-trace --sessions   Sessions breakdown\n  claude-trace --tools      Tool usage breakdown\n  claude-trace --projects   Project breakdown\n  claude-trace --timeline   14-day usage chart\n\nOptions:\n  --top N                   Show top N rows (default 5)\n  --days N                  Look back N days (default all)\n  --help                    Show this help\n`);
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
  const inputCost = (input / 1e6) * p.input;
  const outputCost = (output / 1e6) * p.output;
  const cacheReadCost = (cr / 1e6) * (p.input * p.cacheReadFactor);
  const cacheCreateCost = (cc / 1e6) * (p.input * p.cacheCreateFactor);
  return { inputCost, outputCost, cacheReadCost, cacheCreateCost, total: inputCost + outputCost + cacheReadCost + cacheCreateCost };
}

const empty = () => ({ turns: 0, input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, totalCost: 0 });
function add(a, u, c) { a.turns++; a.input_tokens += +u.input_tokens || 0; a.output_tokens += +u.output_tokens || 0; a.cache_read_input_tokens += +u.cache_read_input_tokens || 0; a.cache_creation_input_tokens += +u.cache_creation_input_tokens || 0; a.totalCost += c.total; }

const projectLabel = cwd => { if (!cwd) return '(unknown)'; const p = cwd.split('/').filter(Boolean); return p.slice(-2).join('/'); };
const dayKey = ts => ts ? new Date(ts).toISOString().slice(0, 10) : null;

function load(days) {
  const root = path.join(os.homedir(), '.claude', 'projects');
  const files = listJsonl(root);
  const since = days > 0 ? Date.now() - days * 86400000 : 0;

  const totals = empty(), bySession = new Map(), byProject = new Map(), byTool = new Map(), byDay = new Map();
  let parseErrors = 0, linesRead = 0;

  for (const f of files) {
    let txt = '';
    try { txt = fs.readFileSync(f, 'utf8'); } catch { continue; }
    for (const line of txt.split('\n').filter(Boolean)) {
      linesRead++;
      let r; try { r = JSON.parse(line); } catch { parseErrors++; continue; }
      if (!r || r.type !== 'assistant' || !r.message?.usage) continue;
      const t = r.timestamp ? new Date(r.timestamp).getTime() : 0;
      if (since && (!t || t < since)) continue;

      const u = r.message.usage, c = estimateCost(r.message.model, u);
      add(totals, u, c);

      const sid = r.sessionId || 'unknown';
      const s = bySession.get(sid) || { sessionId: sid, project: projectLabel(r.cwd), cwd: r.cwd || '(unknown)', firstTs: r.timestamp, lastTs: r.timestamp, tools: {}, ...empty() };
      add(s, u, c);
      if (r.timestamp && (!s.firstTs || r.timestamp < s.firstTs)) s.firstTs = r.timestamp;
      if (r.timestamp && (!s.lastTs || r.timestamp > s.lastTs)) s.lastTs = r.timestamp;

      const toolUses = (r.message.content || []).filter(x => x?.type === 'tool_use');
      if (toolUses.length) {
        const perCall = (+u.input_tokens || 0) / toolUses.length;
        for (const tu of toolUses) {
          const n = tu.name || 'Unknown';
          s.tools[n] = (s.tools[n] || 0) + 1;
          const trow = byTool.get(n) || { name: n, calls: 0, approxInputTokens: 0 };
          trow.calls++; trow.approxInputTokens += perCall; byTool.set(n, trow);
        }
      }
      bySession.set(sid, s);

      const pk = projectLabel(r.cwd);
      const p = byProject.get(pk) || { project: pk, ...empty() };
      add(p, u, c); byProject.set(pk, p);

      const dk = dayKey(r.timestamp);
      if (dk) { const d = byDay.get(dk) || { day: dk, ...empty() }; add(d, u, c); byDay.set(dk, d); }
    }
  }
  return { files: files.length, linesRead, parseErrors, totals, bySession, byProject, byTool, byDay };
}

const topTool = m => { const e = Object.entries(m || {}).sort((a,b)=>b[1]-a[1]); return e[0] ? `${e[0][0]} (${e[0][1]})` : '-'; };

function printSummary(d, topN) {
  const t = d.totals;
  const today = new Date().toISOString().slice(0,10), y = new Date(Date.now()-86400000).toISOString().slice(0,10);
  let weekTokens = 0;
  for (const [k,v] of d.byDay) if (Date.now() - new Date(k).getTime() <= 7*86400000) weekTokens += v.input_tokens+v.output_tokens+v.cache_read_input_tokens+v.cache_creation_input_tokens;
  const ta = d.byDay.get(today) || empty(), ya = d.byDay.get(y) || empty();

  console.log(`\n${bold('╔════════════════════════════════════════════════════╗')}`);
  console.log(`${bold('║                  claude-trace                      ║')}`);
  console.log(`${bold('╚════════════════════════════════════════════════════╝')}`);

  console.log(`\n${color('cyan','Total tokens:')} ${bold(fmtNum(t.input_tokens+t.output_tokens+t.cache_read_input_tokens+t.cache_creation_input_tokens))}`);
  console.log(`${color('cyan','  input:')} ${fmtNum(t.input_tokens)}  ${color('cyan','output:')} ${fmtNum(t.output_tokens)}`);
  console.log(`${color('cyan','  cache read:')} ${fmtNum(t.cache_read_input_tokens)}  ${color('cyan','cache create:')} ${fmtNum(t.cache_creation_input_tokens)}`);
  console.log(`${color('green','Estimated total cost:')} ${bold(fmtUsd(t.totalCost))}`);

  console.log(`\n${bold('Activity')}`);
  const tt = ta.input_tokens+ta.output_tokens+ta.cache_read_input_tokens+ta.cache_creation_input_tokens;
  const yt = ya.input_tokens+ya.output_tokens+ya.cache_read_input_tokens+ya.cache_creation_input_tokens;
  console.log(`  Today:      ${fmtNum(tt)} tokens (${fmtUsd(ta.totalCost)})`);
  console.log(`  Yesterday:  ${fmtNum(yt)} tokens (${fmtUsd(ya.totalCost)})`);
  console.log(`  Last 7 days:${fmtNum(weekTokens)} tokens`);

  const rows = Array.from(d.bySession.values()).sort((a,b)=>b.totalCost-a.totalCost).slice(0, topN);
  console.log(`\n${bold(`Top ${topN} expensive sessions`)}`);
  for (const s of rows) {
    const tok = s.input_tokens+s.output_tokens+s.cache_read_input_tokens+s.cache_creation_input_tokens;
    console.log(`  ${shortId(s.sessionId)}  ${fmtUsd(s.totalCost)}  ${fmtNum(tok)} tokens  ${color('dim', s.project)}`);
  }
}

function printSessions(d, topN) {
  const rows = Array.from(d.bySession.values()).sort((a,b)=>b.totalCost-a.totalCost).slice(0, topN);
  console.log(`\n${bold(`Sessions (top ${topN} by cost)`)}`);
  console.log(color('dim','session    date        cost      tokens       top tool           project'));
  for (const s of rows) {
    const date = (s.lastTs || '').slice(0,10);
    const tok = s.input_tokens+s.output_tokens+s.cache_read_input_tokens+s.cache_creation_input_tokens;
    console.log(`${shortId(s.sessionId).padEnd(10)} ${date.padEnd(10)} ${fmtUsd(s.totalCost).padEnd(9)} ${fmtNum(tok).padEnd(12)} ${topTool(s.tools).padEnd(18)} ${s.project}`);
  }
}

function printTools(d, topN) {
  const rows = Array.from(d.byTool.values()).sort((a,b)=>b.approxInputTokens-a.approxInputTokens).slice(0, topN);
  console.log(`\n${bold(`Tools (top ${topN} by approx input token impact)`)}`);
  console.log(color('dim','tool                 calls    approx input    avg/call'));
  for (const t of rows) {
    const avg = t.calls ? t.approxInputTokens/t.calls : 0;
    console.log(`${t.name.padEnd(20)} ${String(t.calls).padEnd(8)} ${fmtNum(Math.round(t.approxInputTokens)).padEnd(15)} ${fmtNum(Math.round(avg))}`);
  }
  console.log(color('dim','\n* Approximation: if multiple tools are used in one assistant turn, input tokens are split equally across those calls.'));
}

function printProjects(d, topN) {
  const rows = Array.from(d.byProject.values()).sort((a,b)=>b.totalCost-a.totalCost).slice(0, topN);
  console.log(`\n${bold(`Projects (top ${topN} by cost)`)}`);
  console.log(color('dim','project                         cost      input      output     cache read  cache create'));
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
    const bar = '█'.repeat(Math.round((tok/max)*30));
    console.log(`${r.day}  ${bar.padEnd(30)}  ${fmtNum(tok)}  ${fmtUsd(r.totalCost)}`);
  }
}

function main() {
  const a = parseArgs(process.argv.slice(2));
  if (a.help) return usage();
  const d = load(a.days);
  if (!d.files) { console.log(color('red','No Claude Code session files found at ~/.claude/projects')); process.exit(1); }

  if (a.sessions) printSessions(d, a.top);
  else if (a.tools) printTools(d, a.top);
  else if (a.projects) printProjects(d, a.top);
  else if (a.timeline) printTimeline(d);
  else printSummary(d, a.top);

  console.log(`\n${color('dim',`Scanned ${fmtNum(d.files)} files, ${fmtNum(d.linesRead)} lines, ${fmtNum(d.parseErrors)} parse errors`)}`);
}

main();
