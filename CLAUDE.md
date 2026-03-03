# CLAUDE.md

## Project
Zero-dependency Node.js CLI for Claude Code session cost analytics and efficiency analysis. Primary use: adding features, fixing output formatting, improving the analysis heuristics. Solo project.

## Validation Loop
Before any task is complete:
```bash
node index.js
node index.js --reflect --project "$PWD"
node index.js --tools
```
All three must produce readable output without errors. There's no test suite — visual verification is the check.

## File Structure & Conventions
```
index.js          — CLI entrypoint, argument parsing, all --sessions/--tools/--projects/--timeline views
src/parse.js      — JSONL parsing, session data extraction
src/cost.js       — Token cost calculation, pricing tables, data aggregation
src/analyze.js    — --reflect analysis: retry loop detection, friction turns, CLAUDE.md suggestions
```

New analysis features → `src/analyze.js`. New CLI flags → `index.js` (parseArgs + main). Cost model changes → `src/cost.js`. Parser changes → `src/parse.js`.

No build step. No transpilation. Commonjs only — no `import`/`export`. No external dependencies — keep it that way.

## Agentic Behavior
Stop and report if:
- Changing the pricing model in `cost.js` — pricing tables need to be verified against Anthropic's current page
- Adding a new flag that changes default behavior for existing users
- Touching `src/parse.js` in a way that could cause previously-working JSONL files to fail

After finishing: report what changed and which `node index.js` commands verify it. A short summary is expected — not silence.

Maximum 2 attempts at any parsing fix before reporting. JSONL format is poorly documented and edge cases are frequent.

## Off-Limits
- Do not add external npm dependencies. The zero-dependency property is intentional.
- Do not run `npm publish` without explicit instruction.
- Do not modify the pricing tables in `src/cost.js` without citing the source URL.

## Efficiency
- When verifying CLI output across multiple flags, batch into a single Bash call with a loop rather than separate invocations.
- Create task items in bulk when possible — avoid sequential TaskCreate calls that each inject context.

## Gotchas
- Claude Code JSONL format has no official spec. The parser in `src/parse.js` was reverse-engineered. Edge cases (tool results with nested arrays, multi-part content blocks) trip it up — test with real session files.
- `estimateTokens()` in `src/parse.js` is an approximation (word count heuristic, not a real tokenizer). Don't treat its output as accurate — it's for relative comparisons only.
- Session files live at `~/.claude/projects/<encoded-path>/*.jsonl`. The directory name is the project path with `/` replaced by `-`. `findAllJsonl()` in `src/parse.js` handles this, but if a project path changes, old sessions won't be found under the new path.
- `--reflect` and the main analytics views (`--tools`, `--sessions`) are independent pipelines. They share `src/parse.js` helpers but aggregate data separately. A bug in one won't affect the other.
