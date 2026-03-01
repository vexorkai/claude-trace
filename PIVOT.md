# claude-trace v0.2 — Pivot Spec: Tool-Level Cost Attribution

**Decision: PIVOT CONFIRMED**

Tagline: *ccusage shows how much. claude-trace shows why.*

---

## The Problem

Right now claude-trace has a `--tools` flag but it only tracks *call counts* and *approximate input tokens split equally across tool calls in a turn*. That's a rough heuristic — it doesn't tell you which specific tool invocations were expensive, or why a session cost $3.

The real question developers ask after seeing a big number is: **where did it go?**

---

## What claude-monitor already owns

- Real-time cost display
- Per-session spend during a session
- Live token count

Don't compete there. Go upstream: *retrospective attribution*.

---

## v0.2 Feature Spec

### Feature 1: Per-Tool Cost Attribution (--tools, upgraded)

Instead of splitting input tokens equally across all tool calls in a turn, model each tool invocation as an *event* with attributed cost based on its result size injected back into context.

**Display:**
```
Tools by attributed cost

tool                 calls    cost      avg/call   % of total
Bash                   42    $1.23     $0.029        41%
Read                   18    $0.87     $0.048        29%
WebSearch               6    $0.44     $0.073        15%
Edit                   22    $0.31     $0.014        10%
Write                   5    $0.15     $0.030         5%
```

**Implementation approach:** Parse `tool_use` and `tool_result` blocks from JSONL. Each `tool_result` contains content that fed back as input context. The size of that content ≈ the tokens that tool injected. Attribute those tokens (and their cost) back to the originating tool name.

### Feature 2: Session Cost Timeline with Tool Breakdown (--timeline, upgraded)

Instead of just day-level token bars, show which tools drove cost on which days:

```
2026-02-28  ████████████████████████████  42k tokens  $1.82
            Bash: 52%  Read: 28%  WebSearch: 20%

2026-03-01  ████████████████  18k tokens  $0.91
            Read: 61%  Edit: 39%
```

### Feature 3: Tool Cost Breakdown per Session (--session <id>)

New command: drill into a specific session and see exactly which tool calls burned what.

```
claude-trace --session abc12345

Session abc12345 — $2.14 total — 2026-03-01

Turn breakdown:
  Turn  1   $0.08   [Bash: ls -la]                → 3k tokens
  Turn  2   $0.31   [Read: src/analyze.js]         → 12k tokens
  Turn  3   $0.02   [Edit: package.json]            → 0.8k tokens
  Turn  4   $0.44   [WebSearch: claude code docs]   → 17k tokens
  Turn  5   $1.29   [Read: large-file.js]  <- EXPENSIVE  → 48k tokens

Expensive turns: Turn 5 drove 60% of session cost
```

### Feature 4: Cross-Session Tool Leaderboard (upgraded default summary)

Add to the summary view: "Your most expensive habit"

```
Across 847 turns this month:
  Most expensive tool: Read ($18.40 / 38% of all cost)
  Most called tool:    Bash (312 calls)
  Hidden cost leader:  WebSearch ($8.20 at $0.68/call avg)
```

---

## What NOT to build

- Real-time monitoring (claude-monitor owns this)
- Budget alerts (separate concern, maybe later)
- Cost projections (too speculative without real data)

---

## Implementation Plan

### Data layer changes

Current: splits input tokens equally across all tools in a turn.
New: parse `tool_result` content blocks, estimate token size, attribute back to tool.

```js
// For each assistant message with tool_use blocks:
//   find the corresponding user message tool_result blocks
//   measure content size -> estimate tokens
//   attribute to tool name

// Per invocation data:
{ tool: 'Read', resultContentSize: 8192, resultTokens: 312, turnIndex: 5, sessionId: 'xxx', attributedCost: 0.001 }

// Per tool aggregate:
{ name: 'Read', calls: 18, resultTokens: 32000, attributedCost: 0.87, avgCostPerCall: 0.048, pctOfTotal: 29 }
```

### CLI changes
- `--tools` → upgraded with result-based cost attribution and % of total
- `--session <id>` → new command, turn-level drill-down
- `--timeline` → upgraded with per-day tool breakdown
- Default summary → add "most expensive habit" callout

### Version target: v0.2.0
### Estimated effort: 1 focused session

---

## Why this is the right pivot

Current state: claude-trace is a prettier ccusage. Not enough reason to exist.

After pivot: it answers a question nobody else answers — *why did that session cost $3?* — with enough specificity to change behavior. A developer who sees "Read is burning 38% of your budget" might reconsider feeding Claude 10k-line files when targeted reads would do. That's actionable. That's worth using.

---

*Written: 2026-03-01*
