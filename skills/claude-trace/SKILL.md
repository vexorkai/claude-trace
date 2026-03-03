---
name: reflect
description: Analyze the current Claude Code session for efficiency — what it cost, where tokens were wasted, and what to add to CLAUDE.md to prevent it next time.
invocation: explicit
---

Run when the user types `/reflect` or asks to review session efficiency, analyze this session, or find what could have been done better.

## What to do

1. **Run the reflect analyzer:**
   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/index.js" --reflect --project "$PWD" 2>/dev/null || claude-trace --reflect --project "$PWD"
   ```
   Use the Bash tool. It finds the most recent session automatically.

2. **Reason about the output:**
   - Which tools dominated cost (>50% = attention needed)?
   - Are there retry loops (same tool called 3+ times in a row)?
   - What's the tool error rate?
   - Were there correction turns where the human redirected Claude?
   - Was the opening prompt specific enough to avoid back-and-forth?

3. **Output 3–5 specific insights.** Format each as:
   > "Turns X–Y: [what happened]. Cost ~$X. [Why it was friction]. Fix: [one concrete suggestion]."

   Examples:
   - "Bash was called 6 times in a row (~$1.07 wasted). Batch commands into a script instead."
   - "Read was called 3x on the same file after edits. Add: 'read files upfront, not repeatedly' to CLAUDE.md."
   - "4 correction turns in 12 prompts. Opening prompt was underspecified — include file paths and expected output."

4. **Offer CLAUDE.md additions.** For each insight, propose the exact text. Ask: "Want me to append this to your CLAUDE.md?"

## Cross-session analysis

For patterns across recent sessions:
```bash
node "${CLAUDE_PLUGIN_ROOT}/index.js" --reflect --project "$PWD" --recent 5 2>/dev/null || claude-trace --reflect --project "$PWD" --recent 5
```
Look for: recurring retry loops, growing costs over time, consistent error patterns.

## What NOT to do
- Don't summarize session content — only analyze efficiency
- Don't report token counts without context on whether they were well-spent
- Don't suggest additions already present in CLAUDE.md
