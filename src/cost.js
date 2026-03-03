'use strict';

/**
 * src/cost.js — cost attribution logic
 * Reads all JSONL files, builds session/project/tool/day aggregates with cost estimates.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { listJsonlAll, estimateTokens } = require('./parse');

const PRICING = {
  sonnet: { input: 3, output: 15, cacheReadFactor: 0.1, cacheCreateFactor: 1.25 },
  opus:   { input: 15, output: 75, cacheReadFactor: 0.1, cacheCreateFactor: 1.25 },
};

const pickTier = m => (String(m || '').toLowerCase().includes('opus') ? 'opus' : 'sonnet');

function estimateCost(model, u) {
  const p = PRICING[pickTier(model)];
  const input = +u.input_tokens || 0, output = +u.output_tokens || 0;
  const cr = +u.cache_read_input_tokens || 0, cc = +u.cache_creation_input_tokens || 0;
  return (input/1e6)*p.input + (output/1e6)*p.output + (cr/1e6)*(p.input*p.cacheReadFactor) + (cc/1e6)*(p.input*p.cacheCreateFactor);
}

const empty = () => ({ turns: 0, input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, totalCost: 0 });
function addUsage(a, u, cost) {
  a.turns++;
  a.input_tokens += +u.input_tokens || 0;
  a.output_tokens += +u.output_tokens || 0;
  a.cache_read_input_tokens += +u.cache_read_input_tokens || 0;
  a.cache_creation_input_tokens += +u.cache_creation_input_tokens || 0;
  a.totalCost += cost;
}

const projectLabel = cwd => { if (!cwd) return '(unknown)'; const p = cwd.split('/').filter(Boolean); return p.slice(-2).join('/'); };
const dayKey = ts => ts ? new Date(ts).toISOString().slice(0, 10) : null;

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

function load(days) {
  const files = listJsonlAll();
  const since = days > 0 ? Date.now() - days * 86400000 : 0;
  const totals = empty(), bySession = new Map(), byProject = new Map(), byToolV2 = new Map(), byDay = new Map();
  let parseErrors = 0, linesRead = 0;

  for (const f of files) {
    let txt = ''; try { txt = fs.readFileSync(f, 'utf8'); } catch { continue; }
    const lines = txt.split('\n').filter(Boolean);
    linesRead += lines.length;

    for (const line of lines) {
      let r; try { r = JSON.parse(line); } catch { parseErrors++; continue; }
      if (!r || r.type !== 'assistant' || !r.message || !r.message.usage) continue;
      const t = r.timestamp ? new Date(r.timestamp).getTime() : 0;
      if (since && (!t || t < since)) continue;
      const u = r.message.usage, cost = estimateCost(r.message.model, u);
      addUsage(totals, u, cost);
      const sid = r.sessionId || 'unknown';
      const s = bySession.get(sid) || { sessionId: sid, project: projectLabel(r.cwd), cwd: r.cwd || '(unknown)', firstTs: r.timestamp, lastTs: r.timestamp, tools: {}, toolsByResult: {}, ...empty() };
      addUsage(s, u, cost);
      if (r.timestamp && (!s.firstTs || r.timestamp < s.firstTs)) s.firstTs = r.timestamp;
      if (r.timestamp && (!s.lastTs || r.timestamp > s.lastTs)) s.lastTs = r.timestamp;
      for (const block of (r.message.content || [])) {
        if (block && block.type === 'tool_use') s.tools[block.name || 'Unknown'] = (s.tools[block.name || 'Unknown'] || 0) + 1;
      }
      bySession.set(sid, s);
      const pk = projectLabel(r.cwd);
      const p = byProject.get(pk) || { project: pk, ...empty() }; addUsage(p, u, cost); byProject.set(pk, p);
      const dk = dayKey(r.timestamp);
      if (dk) { const d = byDay.get(dk) || { day: dk, ...empty(), toolTokens: {} }; addUsage(d, u, cost); byDay.set(dk, d); }
    }

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

module.exports = { load, estimateCost, pickTier, PRICING };
