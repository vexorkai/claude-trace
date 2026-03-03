# claude-trace

claude-trace tells you what your Claude Code sessions cost and whether they were worth it.

Most people using Claude Code have no idea where their context budget is going. `claude-trace` tells you. Spoiler: it's almost always `Read`. And it tells you if those reads were in a retry loop that burned twice the budget they needed to.

## Install

```bash
npm install -g @vexor/claude-trace
```

Or run without installing:

```bash
npx @vexor/claude-trace --tools
```

## Claude Code Skill

The `/reflect` command runs inside Claude Code and requires the CLI to be installed first.

```bash
# 1. Install the CLI
npm install -g @vexor/claude-trace

# 2. Install the skill
mkdir -p ~/.claude/skills/claude-trace
curl -o ~/.claude/skills/claude-trace/SKILL.md \
  https://raw.githubusercontent.com/vexorkai/claude-trace/main/skills/claude-trace/SKILL.md
```

Then in any Claude Code session:

```
/reflect
```

Claude runs `claude-trace --reflect` on the current project and reasons about the output — surfacing insights and offering CLAUDE.md additions.

## Usage

```
claude-trace                   # overall summary
claude-trace --tools           # cost by tool (the useful one)
claude-trace --sessions        # cost by session
claude-trace --projects        # cost by project
claude-trace --timeline        # daily spend chart
claude-trace --session <id>    # drill into a specific session turn-by-turn
claude-trace --reflect         # analyze most recent session for efficiency
claude-trace --reflect --project <path>    # analyze specific project's last session
claude-trace --reflect --session <id>      # analyze specific session
claude-trace --reflect --recent <N>        # analyze N most recent sessions
claude-trace --top 20          # show more rows
claude-trace --days 7          # last 7 days only
```

## Example output

### `--tools`

```
Tools by attributed cost
tool                 calls    cost       avg/call   % of total
Read                 1142     $436.894   $0.383      56%  ▓▓▓▓▓▓▓▓▓▓▓▓▓▓
Bash                 1482     $132.756   $0.090      17%  ▓▓▓▓
Task                 64       $123.095   $1.923      16%  ▓▓▓▓
Write                321      $22.887    $0.071       3%  ▓
```

**Read burns 56% of token budgets.** Not writing code. Not running tests. Reading files. Every time Claude reads a large file, the full content gets injected into context as a tool result — and those tokens cost money at input rates.

### `--reflect`

```
── reflect: session 9e81cea0 ──
  Project: /Users/you/projects/my-app
  Duration: 32 min  |  Cost: $4.6265
  Turns: 2 human prompts, 39 assistant responses

Tool breakdown:
  Bash                 11x   65%  $2.9934   ▓▓▓▓▓▓▓▓▓▓▓▓▓
  Read                  5x   33%  $1.5361   ▓▓▓▓▓▓▓

  ⚠ Bash dominated at 65% of context injection.

Retry loops detected:
  → Bash called 6x in a row — estimated wasted $1.07
  → Read called 3x in a row — estimated wasted $0.53

CLAUDE.md suggestions:
  → Add to CLAUDE.md: "Read all relevant files upfront before starting changes."
  → Add to CLAUDE.md: "Batch Bash commands where possible."
```

`--reflect` combines cost data with efficiency analysis. It tells you not just what the session cost, but which patterns wasted money and what you can do to prevent it next time.

### `--timeline`

```
Timeline (last 14 days)
2026-02-16  ████████████████████          85,840,641  $185.234
           Read:71% Bash:18% Grep:5%
2026-02-17  ████████████████████████████  118,319,600  $227.066
           Read:65% Bash:18% Task:9%
```

### `--sessions`

```
Sessions (top 5 by cost)
session    date        cost      tokens       cost driver        project
1fa7c9d7   2026-02-16 $92.603   40,773,397   Read               Github/amazon-cli
77026d0b   2026-02-17 $48.618   27,103,965   Read               Github/amazon-cli
```

## How attribution works

Claude Code logs all assistant turns to `~/.claude/projects/**/*.jsonl`. Each turn includes:

- `message.usage.*` — input/output/cache token counts
- `message.content[]` — tool calls with names and results

`claude-trace` reads these logs and attributes each turn's input token cost proportionally to the tool results present in that context window. If a turn contains 3 Read results and 1 Bash result, and Read results account for 80% of the injected bytes, Read gets 80% of that turn's cost.

This is an approximation, but a good one. The actual cost driver is context size, and tool result size is the best available proxy for what's bloating context.

## How `--reflect` works

For efficiency analysis, `claude-trace` parses the turn sequence and detects:

- **Retry loops**: same tool called 3+ times consecutively (often means something isn't working)
- **Friction turns**: human corrections, redirects, "no wait" moments
- **Tool error rate**: how often tool calls fail
- **Context dominance**: which tool is injecting the most tokens

It then estimates the cost of detected patterns and generates specific CLAUDE.md suggestions to prevent them in future sessions.

## How this differs from ccusage and claude-monitor

**[ccusage](https://github.com/ryoppippi/ccusage)** — focused on total spend tracking and billing. Great for "how much have I spent this month." Doesn't break down by tool or explain *why* you spent it.

**claude-monitor** — session-level monitoring, alerts when you're approaching limits. Real-time, not historical. Doesn't do attribution.

**claude-trace** — attribution-first. The question it answers is "where exactly is my budget going, and which tools are responsible — and was it worth it?" Not billing tracking, not limit alerts — root cause analysis for context spend.

Use ccusage if you want billing dashboards. Use claude-trace if you want to understand your usage patterns and optimize them.

## Cost model

Built-in estimates:

| Model  | Input       | Output       | Cache read  | Cache create |
|--------|-------------|--------------|-------------|--------------|
| Sonnet | $3/MTok     | $15/MTok     | $0.30/MTok  | $3.75/MTok   |
| Opus   | $15/MTok    | $75/MTok     | $1.50/MTok  | $18.75/MTok  |

Model is inferred from model name in logs (`opus` → Opus, otherwise → Sonnet).

## Architecture

```
index.js          — thin CLI entry point
src/parse.js      — unified JSONL parser (turn structure + tool invocations)
src/cost.js       — cost attribution (tool result proportional attribution)
src/analyze.js    — efficiency analysis (retry loops, friction, suggestions)
```

## Notes

- Malformed JSONL lines are skipped silently
- Recursively scans all `.jsonl` under `~/.claude/projects/`, including subagent logs
- Works offline — reads only local files

## License

MIT
