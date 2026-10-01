import { existsSync, lstatSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readTokenFile } from "@scout/scout-mcp/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AGENT_TOKEN_FILE, createAgentAuth, writeInteractiveTokenFile } from "./auth.js";

describe("agent auth", () => {
  it("accepts only the interactive token, and refuses every job token while none is issued", () => {
    const auth = createAgentAuth({ interactiveToken: "secret-a" });
    expect(auth.verify("secret-a")).toMatchObject({ role: "interactive" });
    expect(auth.verify("secret-b")).toBeNull();
    expect(auth.verify("")).toBeNull();
  });

  it("an issued job token authenticates as a job until revoked, directly or through a pinned resource", () => {
    const auth = createAgentAuth({ interactiveToken: "secret-a" });
    const t1 = auth.issueJobToken({ jobId: "j1", resourceIds: ["res_a"] });
    const t2 = auth.issueJobToken({ jobId: "j2", resourceIds: ["res_b"] });
    const p1 = auth.verify(t1)!;
    const p2 = auth.verify(t2)!;
    expect(p1.role).toBe("job");
    expect(p1.tokenId).not.toBe(p2.tokenId);
    expect(p1.tokenId).not.toContain(t1);

    auth.revokeJobTokensPinning("res_a");
    expect(auth.verify(t1)).toBeNull();
    expect(auth.isCurrent(p1)).toBe(false);
    expect(auth.isCurrent(p2)).toBe(true);
    auth.revokeJobToken("j2");
    expect(auth.isCurrent(p2)).toBe(false);
  });
});

describe("interactive token file", () => {
  let runDir: string;
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "scout-token-"));
    runDir = join(root, "run");
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("is written 0600 in a 0700 run dir, readable by the adapter, and rotated on every start", () => {
    const first = writeInteractiveTokenFile(runDir);
    expect(first.path).toBe(join(runDir, AGENT_TOKEN_FILE));
    expect(lstatSync(runDir).mode & 0o777).toBe(0o700);
    expect(lstatSync(first.path).mode & 0o777).toBe(0o600);
    expect(readTokenFile(first.path)).toBe(first.token);
    expect(first.token).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const second = writeInteractiveTokenFile(runDir);
    expect(second.token).not.toBe(first.token);
    expect(readTokenFile(second.path)).toBe(second.token);
    // The old core's cleanup leaves the newer token alone; the newer one removes its own.
    first.remove();
    expect(readFileSync(second.path, "utf8").trim()).toBe(second.token);
    second.remove();
    expect(existsSync(second.path)).toBe(false);
  });

  it("removes only the file it wrote", () => {
    const file = writeInteractiveTokenFile(runDir);
    // Replaced while the original still exists, so the replacement cannot reuse its inode.
    writeFileSync(join(runDir, "other"), "someone else's\n", { mode: 0o600 });
    renameSync(join(runDir, "other"), file.path);
    file.remove();
    expect(readFileSync(file.path, "utf8")).toBe("someone else's\n");
  });
});
