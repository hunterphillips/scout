import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { EXTENSION_ID_RE, extensionIdFromManifestKey, extensionIdFromPem, generateKeyPem, idFromBytes, manifestKey } from "./extension-key.mjs";
import { findOnPath, isExecutableFile, resolveClaude } from "./executables.mjs";
import { shDoubleQuote, wrapperScript, fileMarker } from "./files.mjs";
import { upsertEntry } from "./installed.mjs";

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
});
