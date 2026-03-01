# claude-trace

Token analytics for Claude Code sessions — by tool, by project, by day.

Most people using Claude Code have no idea where their context budget is going. `claude-trace` tells you. Spoiler: it's almost always `Read`.

## Install

```bash
npm install -g github:vexorkai/claude-trace
```

Or run without installing:

```bash
npx github:vexorkai/claude-trace --tools
```

## Usage

```
claude-trace              # overall summary
claude-trace --tools      # cost by tool (the useful one)
claude-trace --sessions   # cost by session
claude-trace --projects   # cost by project
claude-trace --timeline   # daily spend chart
claude-trace --top 20     # show more rows
claude-trace --days 7     # last 7 days only
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
Grep                 156      $19.973    $0.128       3%  ▓
Glob                 122      $8.937     $0.073       1%  ▓
WebFetch             53       $7.696     $0.145       1%  ▓
Edit                 351      $6.131     $0.017       1%  ▓
```

**Read burns 56% of token budgets.** Not writing code. Not running tests. Reading files. Every time Claude reads a large file, the full content gets injected into context as a tool result — and those tokens cost money at input rates. If you're wondering why long sessions get expensive fast, this is why.

### `--timeline`

```
Timeline (last 14 days)
2026-02-16  ████████████████████          85,840,641  $185.234
           Read:71% Bash:18% Grep:5%
2026-02-17  ████████████████████████████  118,319,600  $227.066
           Read:65% Bash:18% Task:9%
2026-02-18  ████████                      33,185,212  $64.516
           Read:53% Task:18% Bash:18%
```

### `--sessions`

```
Sessions (top 5 by cost)
session    date        cost      tokens       cost driver        project
1fa7c9d7   2026-02-16 $92.603   40,773,397   Read               Github/amazon-cli
77026d0b   2026-02-17 $48.618   27,103,965   Read               Github/amazon-cli
d18ab852   2026-02-17 $43.256   23,424,104   Read               Github/amazon-cli
```

## How attribution works

Claude Code logs all assistant turns to `~/.claude/projects/**/*.jsonl`. Each turn includes:

- `message.usage.*` — input/output/cache token counts
- `message.content[]` — tool calls with names and results

`claude-trace` reads these logs and attributes each turn's input token cost proportionally to the tool results present in that context window. If a turn contains 3 Read results and 1 Bash result, and Read results account for 80% of the injected bytes, Read gets 80% of that turn's cost.

This is an approximation, but a good one. The actual cost driver is context size, and tool result size is the best available proxy for what's bloating context.

## How this differs from ccusage and claude-monitor

**[ccusage](https://github.com/ryoppippi/ccusage)** — focused on total spend tracking and billing. Great for "how much have I spent this month." Doesn't break down by tool or explain *why* you spent it.

**claude-monitor** — session-level monitoring, alerts when you're approaching limits. Real-time, not historical. Doesn't do attribution.

**claude-trace** — attribution-first. The question it answers is "where exactly is my budget going, and which tools are responsible." Not billing tracking, not limit alerts — root cause analysis for context spend.

Use ccusage if you want billing dashboards. Use claude-trace if you want to understand your usage patterns and optimize them.

## Cost model

Built-in estimates:

| Model  | Input       | Output       | Cache read  | Cache create |
|--------|-------------|--------------|-------------|--------------|
| Sonnet | $3/MTok     | $15/MTok     | $0.30/MTok  | $3.75/MTok   |
| Opus   | $15/MTok    | $75/MTok     | $1.50/MTok  | $18.75/MTok  |

Model is inferred from model name in logs (`opus` → Opus, otherwise → Sonnet).

## Notes

- Malformed JSONL lines are skipped silently
- Recursively scans all `.jsonl` under `~/.claude/projects/`, including subagent logs
- Works offline — reads only local files

## License

MIT
