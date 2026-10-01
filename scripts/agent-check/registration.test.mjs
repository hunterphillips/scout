// removeOwnedRegistration against a scripted stub `claude`: each `mcp get` call answers
// from a list, so a test can make any one of them fail.

import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { mcpGet, registryNames, removeOwnedRegistration, removeOwnedSkill, userAllowRuleCounts, writeProofSkill } from "./registration.mjs";

const dirs = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const NAME = "scout-proof-aaaaaaaaaa";
const expected = { command: "/usr/bin/node", args: ["/x/main.js", "--socket", "/x/a.sock"] };
const FOUND = `${NAME}:\n  Scope: User config (available in all your projects)\n  Status: ok\n  Type: stdio\n  Command: /usr/bin/node\n  Args: /x/main.js --socket /x/a.sock\n`;

/** A stub whose n-th `mcp get` does gets[n] ("found" | "noticed" | "absent" | "exit2" | "kill" | "garbage"); remove exits `removeExit`. */
function stub(gets, removeExit = 0) {
  const d = mkdtempSync(join(tmpdir(), "reg-"));
  dirs.push(d);
  writeFileSync(join(d, "found"), FOUND);
  writeFileSync(join(d, "n"), "0");
  const script = `#!/bin/sh
D='${d}'
if [ "$2" = "remove" ]; then echo "$2" >> "$D/log"; exit ${removeExit}; fi
n=$(cat "$D/n"); echo $((n+1)) > "$D/n"
set -- ${gets.join(" ")}
shift $n
case "$1" in
  found) cat "$D/found"; exit 0;;
  noticed) echo 'A new version of Claude Code is available.'; echo; cat "$D/found"; exit 0;;
  absent) echo 'No MCP server named "${NAME}". Run \`claude mcp add\` to add one.' >&2; exit 1;;
  exit2) echo 'No MCP server named "${NAME}".' >&2; exit 2;;
  kill) kill -9 $$;;
  *) echo 'something else'; exit 0;;
esac
`;
  const path = join(d, "claude");
  writeFileSync(path, script);
  chmodSync(path, 0o755);
  return { path, opts: { env: { PATH: "/usr/bin:/bin" }, cwd: d }, removes: () => { try { return readFileSync(join(d, "log"), "utf8").split("\n").filter(Boolean).length; } catch { return 0; } } };
}

describe("mcpGet", () => {
  it("is absent only on exit 1 with the not-found message", () => {
    expect(mcpGet(stub(["absent"]).path, NAME, stub(["absent"]).opts).exists).toBe(false);
    const s = stub(["exit2"]);
    expect(mcpGet(s.path, NAME, s.opts)).toEqual({ exists: "unknown", exit: { status: 2, signal: null, timedOut: false } });
    const k = stub(["kill"]);
    expect(mcpGet(k.path, NAME, k.opts)).toEqual({ exists: "unknown", exit: { status: null, signal: "SIGKILL", timedOut: false } });
    const g = stub(["garbage"]);
    expect(mcpGet(g.path, NAME, g.opts).exists).toBe("unknown");
    const f = stub(["found"]);
    expect(mcpGet(f.path, NAME, f.opts)).toMatchObject({ exists: true, command: "/usr/bin/node" });
  });

  it("finds the `<name>:` line after a notice and reads the fields that follow it", () => {
    const n = stub(["noticed"]);
    expect(mcpGet(n.path, NAME, n.opts)).toEqual({ exists: true, scope: "User config (available in all your projects)", health: "ok", type: "stdio", command: "/usr/bin/node", args: "/x/main.js --socket /x/a.sock" });
  });
});

describe("removeOwnedRegistration", () => {
  it("removes and verifies", () => {
    const s = stub(["found", "absent"]);
    expect(removeOwnedRegistration(s.path, NAME, expected, s.opts)).toEqual({ state: "removed" });
    expect(s.removes()).toBe(1);
  });

  it("leaves the entry alone when the first get cannot tell", () => {
    const s = stub(["kill"]);
    expect(removeOwnedRegistration(s.path, NAME, expected, s.opts)).toEqual({ state: "unknown_state", exit: { status: null, signal: "SIGKILL", timedOut: false } });
    expect(s.removes()).toBe(0);
  });

  it("reports removal_unverified when the get after remove cannot tell", () => {
    const s = stub(["found", "exit2"]);
    expect(removeOwnedRegistration(s.path, NAME, expected, s.opts)).toEqual({ state: "removal_unverified", exit: { status: 2, signal: null, timedOut: false } });
  });

  it("reports remove_failed when remove fails or the entry is still there", () => {
    const failed = stub(["found"], 1);
    expect(removeOwnedRegistration(failed.path, NAME, expected, failed.opts)).toEqual({ state: "remove_failed", exit: { status: 1, signal: null, timedOut: false } });
    const still = stub(["found", "found"]);
    expect(removeOwnedRegistration(still.path, NAME, expected, still.opts)).toEqual({ state: "remove_failed" });
  });
});

function tmp() {
  const d = mkdtempSync(join(tmpdir(), "reg-"));
  dirs.push(d);
  return d;
}

describe("removeOwnedSkill", () => {
  it("removes exactly our skill; absent when gone", () => {
    const root = tmp();
    const { dir, hash } = writeProofSkill(root, NAME, "hello");
    expect(removeOwnedSkill(dir, hash)).toBe("removed");
    expect(existsSync(dir)).toBe(false);
    expect(removeOwnedSkill(dir, hash)).toBe("absent");
  });

  it("leaves a symlinked dir or SKILL.md alone, and an edited or extra file", () => {
    const root = tmp();
    const { dir, hash } = writeProofSkill(root, NAME, "hello");
    const link = join(root, "linked");
    symlinkSync(dir, link);
    expect(removeOwnedSkill(link, hash)).toBe("left_symlink");
    const other = join(root, "scout-proof-bbbbbbbbbb");
    mkdirSync(other);
    symlinkSync(join(dir, "SKILL.md"), join(other, "SKILL.md"));
    expect(removeOwnedSkill(other, hash)).toBe("left_symlink");
    writeFileSync(join(dir, "extra"), "");
    expect(removeOwnedSkill(dir, hash)).toBe("left_modified");
    rmSync(join(dir, "extra"));
    writeFileSync(join(dir, "SKILL.md"), "edited");
    expect(removeOwnedSkill(dir, hash)).toBe("left_modified");
    expect(existsSync(join(dir, "SKILL.md"))).toBe(true);
  });

  it.skipIf(process.getuid?.() === 0)("returns error_EACCES for an unreadable dir instead of throwing", () => {
    const root = tmp();
    const { dir, hash } = writeProofSkill(root, NAME, "hello");
    chmodSync(dir, 0o000);
    try {
      expect(removeOwnedSkill(dir, hash)).toBe("error_EACCES");
    } finally {
      chmodSync(dir, 0o700);
    }
  });
});

describe("registry names and allow-rule counts", () => {
  it("reads the user config named by CLAUDE_CONFIG_DIR, else HOME; key names only", () => {
    const home = tmp();
    const cfg = tmp();
    writeFileSync(join(home, ".claude.json"), JSON.stringify({ mcpServers: { b: { command: "secret" }, a: {} } }));
    expect(registryNames({ HOME: home })).toEqual(["a", "b"]);
    expect(registryNames({ HOME: home, CLAUDE_CONFIG_DIR: cfg })).toEqual([]);
    writeFileSync(join(cfg, ".claude.json"), "{not json");
    expect(registryNames({ HOME: home, CLAUDE_CONFIG_DIR: cfg })).toBeUndefined();
  });

  it("counts allow rules from the user settings file", () => {
    const home = tmp();
    expect(userAllowRuleCounts({ HOME: home })).toEqual({ count: 0, mcpCount: 0 });
    mkdirSync(join(home, ".claude"));
    writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({ permissions: { allow: ["mcp__a__b", "Read", 3] } }));
    expect(userAllowRuleCounts({ HOME: home })).toEqual({ count: 2, mcpCount: 1 });
    writeFileSync(join(home, ".claude", "settings.json"), "nope");
    expect(userAllowRuleCounts({ HOME: home })).toBeUndefined();
  });
});
