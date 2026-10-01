// The setup CLI's binding checks: each way a binding file can be unusable yields its own
// status, values never appear in a check, and the backend environment does not depend on
// this process's environment.

import { chmodSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkEnvBindings, resolveBackendEnv } from "./environmentBindings.js";
import { BINDING_FILE_MAX_BYTES } from "./toolProfile.js";

const SECRET = "SENTINEL-ENVBIND-7f1e";
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function dir(): string {
  const d = realpathSync(mkdtempSync(join(tmpdir(), "scout-envb-")));
  dirs.push(d);
  return d;
}
function file(d: string, name: string, content: string, mode = 0o600): string {
  const p = join(d, name);
  writeFileSync(p, content);
  chmodSync(p, mode);
  return p;
}

describe("checkEnvBindings", () => {
  it("reports a distinct status for each unusable binding, and never a value", () => {
    const d = dir();
    const good = file(d, "good.json", JSON.stringify({ a: { token: SECRET }, n: 7 }));
    const open = file(d, "open.json", JSON.stringify({ token: SECRET }), 0o644);
    const big = file(d, "big.json", JSON.stringify({ token: "x".repeat(BINDING_FILE_MAX_BYTES) }));
    const notJson = file(d, "bad.json", `{"token": "${SECRET}"`);
    const checks = checkEnvBindings({
      OK_TOKEN: { file: good, pointer: "/a/token" },
      OPEN_TOKEN: { file: open, pointer: "/token" },
      BIG_TOKEN: { file: big, pointer: "/token" },
      JSON_TOKEN: { file: notJson, pointer: "/token" },
      PTR_TOKEN: { file: good, pointer: "/a/nope" },
      NUM_TOKEN: { file: good, pointer: "/n" },
      GONE_TOKEN: { file: join(d, "gone.json"), pointer: "/token" },
    });
    const by = Object.fromEntries(checks.map((c) => [c.name, c.status]));
    expect(by).toEqual({
      OK_TOKEN: "ok",
      OPEN_TOKEN: "file_not_private",
      BIG_TOKEN: "file_too_large",
      JSON_TOKEN: "file_not_json",
      PTR_TOKEN: "pointer_not_found",
      NUM_TOKEN: "value_not_string",
      GONE_TOKEN: "file_missing",
    });
    expect(JSON.stringify(checks)).not.toContain(SECRET);
  });

  it("a file owned by another user is not private", () => {
    const d = dir();
    const f = file(d, "c.json", JSON.stringify({ token: SECRET }));
    const [c] = checkEnvBindings({ T_TOKEN: { file: f, pointer: "/token" } }, { getuid: () => (process.getuid?.() ?? 0) + 1 });
    expect(c?.status).toBe("file_not_private");
  });
});

describe("resolveBackendEnv", () => {
  it("is exactly literalEnv plus the bindings, whatever this process's environment holds", () => {
    const d = dir();
    const f = file(d, "c.json", JSON.stringify({ token: SECRET }));
    const source = { env: { API_TOKEN: { file: f, pointer: "/token" } }, literalEnv: { LANG: "C" } };
    const withEnv = resolveBackendEnv(source);
    const saved = { ...process.env };
    let without;
    try {
      for (const k of Object.keys(process.env)) delete process.env[k];
      without = resolveBackendEnv(source);
    } finally {
      Object.assign(process.env, saved);
    }
    expect(withEnv).toEqual({ ok: true, env: { LANG: "C", API_TOKEN: SECRET } });
    expect(without).toEqual(withEnv);
  });

  it("reports every failing binding and returns no values", () => {
    const d = dir();
    const f = file(d, "c.json", JSON.stringify({ token: SECRET }));
    const r = resolveBackendEnv({ env: { A_TOKEN: { file: f, pointer: "/token" }, B_TOKEN: { file: f, pointer: "/missing" } } });
    expect(r).toEqual({ ok: false, failures: [{ name: "B_TOKEN", file: f, pointer: "/missing", status: "pointer_not_found" }] });
    expect(JSON.stringify(r)).not.toContain(SECRET);
  });
});
