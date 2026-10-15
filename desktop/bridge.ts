import { runClaudeStatusLine } from "../relay/claude-statusline.ts";

void runClaudeStatusLine().catch(() => {
  // Claude Code's status line is optional and must never break the session.
  process.exitCode = 1;
});
