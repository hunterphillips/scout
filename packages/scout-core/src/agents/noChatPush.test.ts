// The "no chat-push path" check, the core's side. Scout reaches the user's
// agent in exactly one way: it starts a fresh, non-persistent `claude -p` per job whose prompt
// is a fixed template on stdin. It never joins, resumes or streams into an existing session,
// never opens an IDE/WebSocket channel to a running Claude, and nothing outside the test fakes
// names a flag that would. (scout-mcp/src/noPush.test.ts covers the MCP server: it only answers.)

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildJobArgv } from "./claudeCode/claudeJob.js";

const SRC = fileURLToPath(new URL("..", import.meta.url));

/** Flags that would put Scout's text into an existing or continuing session. */
const SESSION_FLAGS = ["--resume", "-r", "--continue", "-c", "--session-id", "--fork-session", "--input-format", "--replay-user-messages"];

describe("no chat-push path (B8/B9): the core only starts fresh one-shot jobs", () => {
  it("a job's argv is a fresh non-persistent -p run with no flag that joins, resumes or streams into a session", () => {
    const argv = buildJobArgv("claude-sonnet-5-5", "/run/jobs/j1", "mcp__scout__current_site");
    expect(argv).toContain("-p");
    expect(argv).toContain("--no-session-persistence");
    for (const flag of SESSION_FLAGS) expect(argv, flag).not.toContain(flag);
  });

  it("no production source names a session-joining flag or opens an IDE/WebSocket channel to a running Claude", () => {
    const files = readdirSync(SRC, { recursive: true, encoding: "utf8" }).filter(
      (f) => /\.(ts|mjs|js)$/.test(f) && !/\.test\.ts$/.test(f) && !f.includes("testing/") && !f.endsWith(".d.ts"),
    );
    expect(files).toContain(join("agents", "claudeCode", "claudeJob.ts"));
    const quoted = new RegExp(`["'\`](${SESSION_FLAGS.map((f) => f.replace(/-/g, "\\-")).join("|")})["'\`]`);
    const channel = /\bWebSocket\b|from\s+["']ws["']|\.claude\/ide\b|CLAUDE_CODE_SSE_PORT/;
    for (const f of files) {
      const text = readFileSync(join(SRC, f), "utf8");
      expect(quoted.exec(text)?.[0], f).toBeUndefined();
      expect(channel.exec(text)?.[0], f).toBeUndefined();
    }
  });
});
