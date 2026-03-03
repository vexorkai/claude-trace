#!/usr/bin/env node
'use strict';

/**
 * src/parse.js — unified JSONL parser for Claude Code session logs
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

function truncate(str, max = 500) {
  if (!str) return '';
  str = String(str);
  return str.length > max ? str.slice(0, max) + '…' : str;
}

function extractText(content) {
  if (!content) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.filter(b => b.type === 'text').map(b => b.text || '').join(' ');
  }
  return '';
}

function extractToolsCalled(content) {
  if (!Array.isArray(content)) return [];
  return content
    .filter(b => b.type === 'tool_use')
    .map(b => ({ name: b.name || '', id: b.id || '', inputSummary: truncate(JSON.stringify(b.input || {}), 200) }));
}

function extractToolResults(content) {
  if (!Array.isArray(content)) return [];
  return content
    .filter(b => b.type === 'tool_result')
    .map(b => {
      const output = Array.isArray(b.content)
        ? b.content.map(c => c.text || '').join(' ')
        : String(b.content || '');
      return {
        toolUseId: b.tool_use_id || '',
        success: !b.is_error,
        outputSummary: truncate(output, 300),
        rawLength: output.length,
      };
    });
}

function estimateTokens(content) {
  if (!content) return 0;
  if (typeof content === 'string') return Math.ceil(content.length / 4);
  if (Array.isArray(content)) return content.reduce((s, c) => s + estimateTokens(c && (c.text || c.content || '')), 0);
  if (typeof content === 'object') return estimateTokens(content.text || content.content || JSON.stringify(content));
  return 0;
}

function isHumanTurn(content) {
  if (typeof content === 'string') return content.trim().length > 0;
  if (!Array.isArray(content)) return false;
  return content.some(b => b.type === 'text');
}

function parseFile(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  const lines = raw.split('\n').filter(l => l.trim());

  const turns = [];
  const allToolResults = [];
  const toolInvocations = [];
  const pendingTools = new Map();

  let sessionId = null;
  let cwd = null;
  let startTime = null;
  let endTime = null;
  let model = null;
  const totalTokens = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };
  let turnIndex = 0;

  for (const line of lines) {
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }

    if (!sessionId && entry.sessionId) sessionId = entry.sessionId;
    if (!cwd && entry.cwd) cwd = entry.cwd;

    const ts = entry.timestamp;
    if (ts) {
      if (!startTime || ts < startTime) startTime = ts;
      if (!endTime || ts > endTime) endTime = ts;
    }

    if (entry.type !== 'user' && entry.type !== 'assistant') continue;
    const msg = entry.message;
    if (!msg) continue;

    const role = msg.role || entry.type;
    const content = msg.content;

    if (role === 'assistant') {
      if (msg.model && !model) model = msg.model;

      if (Array.isArray(content)) {
        for (const block of content) {
          if (block && block.type === 'tool_use' && block.id && block.name) {
            pendingTools.set(block.id, { name: block.name, turnIndex, input: block.input || {} });
          }
        }
      }

      let tokens = null;
      if (msg.usage) {
        const u = msg.usage;
        tokens = {
          input: u.input_tokens || 0,
          output: u.output_tokens || 0,
          cacheRead: u.cache_read_input_tokens || 0,
          cacheCreation: u.cache_creation_input_tokens || 0,
        };
        totalTokens.input += tokens.input;
        totalTokens.output += tokens.output;
        totalTokens.cacheRead += tokens.cacheRead;
        totalTokens.cacheCreation += tokens.cacheCreation;
      }

      turns.push({ uuid: entry.uuid || null, parentUuid: entry.parentUuid || null, timestamp: ts || null, role, text: truncate(extractText(content)), toolsCalled: extractToolsCalled(content), toolResults: [], tokens, turnIndex });
      turnIndex++;
    }

    if (role === 'user') {
      const results = extractToolResults(content);
      for (const r of results) {
        allToolResults.push(r);
        const tool = pendingTools.get(r.toolUseId);
        if (tool) {
          toolInvocations.push({ toolName: tool.name, turnIndex: tool.turnIndex, resultTokens: Math.ceil(r.rawLength / 4), isError: !r.success, input: tool.input });
          pendingTools.delete(r.toolUseId);
        }
      }
      if (!isHumanTurn(content)) continue;
      turns.push({ uuid: entry.uuid || null, parentUuid: entry.parentUuid || null, timestamp: ts || null, role, text: truncate(extractText(content)), toolsCalled: [], toolResults: results, tokens: null, turnIndex: null });
    }
  }

  return { sessionId, filePath, cwd, model, turns, allToolResults, toolInvocations, totalTokens, startTime, endTime };
}

function parseSessions(filePaths) {
  return filePaths.map(fp => {
    try {
      return parseFile(fp);
    } catch (err) {
      return { sessionId: null, filePath: fp, cwd: null, model: null, turns: [], allToolResults: [], toolInvocations: [], totalTokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 }, startTime: null, endTime: null, error: err.message };
    }
  });
}

function findAllJsonl(projectCwd) {
  const root = path.join(os.homedir(), '.claude', 'projects');
  const results = [];
  if (!fs.existsSync(root)) return results;

  const projectKey = projectCwd ? projectCwd.replace(/[^a-zA-Z0-9]/g, '-') : null;
  const dirs = projectKey ? [projectKey] : fs.readdirSync(root);

  for (const proj of dirs) {
    const projPath = path.join(root, proj);
    let stat;
    try { stat = fs.statSync(projPath); } catch { continue; }
    if (!stat.isDirectory()) continue;
    for (const f of fs.readdirSync(projPath)) {
      if (f.endsWith('.jsonl')) {
        const fp = path.join(projPath, f);
        try { results.push({ fp, mtime: fs.statSync(fp).mtimeMs }); } catch { /* skip */ }
      }
    }
  }
  return results.sort((a, b) => b.mtime - a.mtime);
}

function listJsonlAll() {
  const root = path.join(os.homedir(), '.claude', 'projects');
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
  walk(root);
  return out;
}

module.exports = { parseFile, parseSessions, findAllJsonl, listJsonlAll, estimateTokens };
