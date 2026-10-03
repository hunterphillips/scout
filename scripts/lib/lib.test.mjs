import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { EXTENSION_ID_RE, extensionIdFromManifestKey, extensionIdFromPem, generateKeyPem, idFromBytes, manifestKey } from "./extension-key.mjs";
import { findOnPath, isExecutableFile, resolveClaude } from "./executables.mjs";
import { shDoubleQuote, wrapperScript, fileMarker } from "./files.mjs";
import { allowedPath, readInstalled, upsertEntry } from "./installed.mjs";
import { layout } from "./paths.mjs";

describe("extension ID", () => {
  it("matches Chrome's id_util vectors", () => {
    // chromium components/crx_file/id_util_unittest.cc: GenerateId("test")
    expect(idFromBytes(Buffer.from("test"))).toBe("jpignaibiiemhngfjkcpokkamffknabf");
  });

  it("is deterministic and agrees between the PEM and the manifest key", () => {
    const pem = generateKeyPem();
    const id = extensionIdFromPem(pem);
    expect(id).toMatch(EXTENSION_ID_RE);
    expect(extensionIdFromPem(pem)).toBe(id);
    expect(extensionIdFromManifestKey(manifestKey(pem))).toBe(id);
    expect(extensionIdFromPem(generateKeyPem())).not.toBe(id);
  });
});

describe("executables", () => {
  it("finds claude on PATH, then fallbacks, else null", () => {
    const dir = mkdtempSync(join(tmpdir(), "scout exe "));
    try {
      const claude = join(dir, "claude");
      writeFileSync(claude, "#!/bin/sh\n");
      chmodSync(claude, 0o644);
      expect(isExecutableFile(claude)).toBe(false);
      expect(findOnPath("claude", dir)).toBeNull();
      chmodSync(claude, 0o755);
      expect(findOnPath("claude", `relative:${dir}`)).toBe(claude);
      expect(resolveClaude({ pathVar: "", fallbacks: [join(dir, "nope"), claude] })).toBe(claude);
      expect(resolveClaude({ pathVar: "", fallbacks: [join(dir, "nope")] })).toBeNull();
      expect(isExecutableFile(dir)).toBe(false);
      expect(isExecutableFile("claude")).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("wrapper", () => {
  it("double-quotes paths with spaces and shell metacharacters", () => {
    expect(shDoubleQuote('/a b/$x"`\\')).toBe('"/a b/\\$x\\"\\`\\\\"');
    expect(() => shDoubleQuote("a\nb")).toThrow();
  });

  it("carries the marker line", () => {
    const dir = mkdtempSync(join(tmpdir(), "scout wrap "));
    try {
      const p = join(dir, "w");
      writeFileSync(p, wrapperScript({ nodePath: "/n n/node", hostJs: "/h/host.js", scoutHome: "/s", marker: "abc" }));
      expect(fileMarker(p, "wrapper")).toBe("abc");
      expect(fileMarker(p, "config")).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("installed record", () => {
  it("upserts without duplicating", () => {
    let r = { version: 1, marker: "m", files: [] };
    r = upsertEntry(r, { path: "/a", kind: "config" });
    r = upsertEntry(r, { path: "/a", kind: "config" });
    r = upsertEntry(r, { path: "/b", kind: "wrapper" });
    expect(r.files.map((f) => f.path)).toEqual(["/a", "/b"]);
    expect(() => upsertEntry(r, { path: "/c", kind: "bogus" })).toThrow();
  });

  it("keeps one mcp-registration and one skill entry even when the path changes", () => {
    let r = { version: 1, marker: "m", files: [] };
    r = upsertEntry(r, { path: "/n /r/packages/scout-mcp/dist/main.js", kind: "mcp-registration" });
    r = upsertEntry(r, { path: "/m /r/packages/scout-mcp/dist/main.js", kind: "mcp-registration" });
    expect(r.files.map((f) => f.path)).toEqual(["/m /r/packages/scout-mcp/dist/main.js"]);
  });

  it("reads records written before the agent integration, and rejects a bad skillsRoot", () => {
    const dir = mkdtempSync(join(tmpdir(), "installed-"));
    try {
      const p = join(dir, "installed.json");
      const old = { version: 1, marker: "m", files: [{ path: "/s/config.json", kind: "config" }] };
      writeFileSync(p, JSON.stringify(old));
      expect(readInstalled(p)).toEqual(old);
      writeFileSync(p, JSON.stringify({ ...old, skillsRoot: "/u/.claude/skills" }));
      expect(readInstalled(p).skillsRoot).toBe("/u/.claude/skills");
      for (const bad of ["", "relative/skills", "/u/../skills", 3]) {
        writeFileSync(p, JSON.stringify({ ...old, skillsRoot: bad }));
        expect(() => readInstalled(p)).toThrow(/skillsRoot/);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("allowedPath", () => {
  const L = layout({ env: { HOME: "/h", SCOUT_HOME: "/s", CHROME_NMH_DIR: "/n" }, scoutRoot: "/r" });
  it("accepts only paths setup writes for each kind", () => {
    expect(allowedPath("key", L.keyPem, L)).toBe(true);
    expect(allowedPath("key", "/etc/extension-key.pem", L)).toBe(false);
    expect(allowedPath("config", L.scoutConfig, L)).toBe(true);
    expect(allowedPath("config", "/etc/config.json", L)).toBe(false);
    expect(allowedPath("wrapper", L.wrapper, L)).toBe(true);
    expect(allowedPath("nmh-manifest", "/elsewhere/dev.scout.bridge.json", L)).toBe(true);
    expect(allowedPath("nmh-manifest", "/elsewhere/other.json", L)).toBe(false);
    expect(allowedPath("config-merged", L.legacyPcConfig, L)).toBe(true);
    expect(allowedPath("config-merged", "/u/.personal-context-mcp/config.json", L)).toBe(true);
    expect(allowedPath("config-merged", "/u/.ssh/config.json", L)).toBe(false);
    expect(allowedPath("extension-manifest-key", "/x/packages/browser-extension/dist/manifest.json", L)).toBe(true);
    expect(allowedPath("extension-manifest-key", "/x/manifest.json", L)).toBe(false);
    expect(allowedPath("config", "/s/../s/config.json", L)).toBe(false);
    expect(allowedPath("bogus", L.scoutConfig, L)).toBe(false);
  });

  it("accepts the integration skill only at <skillsRoot>/scout-integration/SKILL.md, and only a node + scout-mcp registration", () => {
    const record = { skillsRoot: "/u/.claude/skills" };
    expect(allowedPath("skill", "/u/.claude/skills/scout-integration/SKILL.md", L, record)).toBe(true);
    expect(allowedPath("skill", "/u/.claude/skills/other/SKILL.md", L, record)).toBe(false);
    expect(allowedPath("skill", "/u/.claude/skills/scout-integration/SKILL.md", L, {})).toBe(false);
    expect(allowedPath("skill", "/u/.claude/skills/scout-integration/SKILL.md", L)).toBe(false);
    expect(allowedPath("mcp-registration", "/usr/bin/node /r/packages/scout-mcp/dist/main.js", L)).toBe(true);
    expect(allowedPath("mcp-registration", "/bin/sh -c", L)).toBe(false);
    expect(allowedPath("mcp-registration", "/usr/bin/node /r/packages/scout-mcp/dist/main.js --x", L)).toBe(false);
    expect(allowedPath("mcp-registration", "node /r/packages/scout-mcp/dist/main.js", L)).toBe(false);
  });
});
