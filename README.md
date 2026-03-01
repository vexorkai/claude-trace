# claude-trace

Token analytics for Claude Code sessions.

`claude-trace` reads local Claude Code logs (`~/.claude/projects/**/*.jsonl`) and shows where your context + spend is going: sessions, tools, projects, and timeline.

## Why

Claude Code stores rich usage metadata per assistant turn:

- `message.usage.input_tokens`
- `message.usage.output_tokens`
- `message.usage.cache_read_input_tokens`
- `message.usage.cache_creation_input_tokens`
- `message.content[]` tool calls (`type: "tool_use"`)

Most people never inspect this directly. `claude-trace` turns it into readable analytics.

## Install

```bash
npm i -g claude-trace
# or run locally
node index.js
```

## Usage

```bash
claude-trace              # summary
claude-trace --sessions   # sessions breakdown
claude-trace --tools      # tool breakdown
claude-trace --projects   # project breakdown
claude-trace --timeline   # daily chart

claude-trace --top 10     # top N rows
claude-trace --days 30    # only last N days
claude-trace --help
```

## Cost model

Current built-in estimate:

- Sonnet: input $3/MTok, output $15/MTok
- Opus: input $15/MTok, output $75/MTok
- Cache read: 0.1x input price
- Cache creation: 1.25x input price

Model tier is inferred from model name (`opus` vs non-opus => sonnet default).

## Notes

- Tool attribution is approximate: if multiple tool calls occur in one assistant turn, that turn's input tokens are split equally across those tool calls.
- Malformed JSON lines are skipped safely.
- Recursively scans all `.jsonl` under `~/.claude/projects`, including subagent logs.

## License

MIT
