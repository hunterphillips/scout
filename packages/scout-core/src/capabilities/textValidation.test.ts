import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { validateText } from "./textValidation.js";

const enc = (s: string) => new TextEncoder().encode(s);

describe("validateText", () => {
  it("accepts UTF-8 Markdown and hashes the raw bytes, keeping a BOM", () => {
    const bytes = enc("﻿# Site\n\n- [Docs](/docs): the docs\n");
    const result = validateText(bytes, "text/plain", "llms_txt");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
    expect(result.byteLength).toBe(bytes.byteLength);
    expect(enc(result.text)).toEqual(bytes);
  });

  it("refuses bodies over the kind's cap as too_large", () => {
    expect(validateText(enc("a".repeat(64 * 1024 + 1)), undefined, "skill")).toEqual({ ok: false, reason: "too_large" });
    expect(validateText(enc("a".repeat(128 * 1024)), undefined, "llms_txt").ok).toBe(true);
    expect(validateText(enc("a".repeat(128 * 1024 + 1)), undefined, "agents_md")).toEqual({ ok: false, reason: "too_large" });
  });

  it("refuses NUL bytes and invalid UTF-8", () => {
    expect(validateText(enc("# ok\u0000more"), "text/markdown", "agents_md")).toEqual({ ok: false, reason: "nul_byte" });
    expect(validateText(new Uint8Array([0x23, 0x20, 0xc3, 0x28, 0x0a]), "text/markdown", "agents_md")).toEqual({ ok: false, reason: "invalid_utf8" });
  });

  it("refuses binary-looking text and empty bodies", () => {
    const binaryish = `x${"\u0001\u0002\u0003".repeat(10)}${"y".repeat(100)}`;
    expect(validateText(enc(binaryish), "text/plain", "llms_txt")).toEqual({ ok: false, reason: "binary" });
    expect(validateText(enc(" \n\t"), "text/plain", "llms_txt")).toEqual({ ok: false, reason: "empty" });
  });

  it("refuses an HTML app-fallback page even when served as text/markdown", () => {
    for (const page of ["<!DOCTYPE html><html><body>app</body></html>", "\n  <html lang=en>", "<div id=root></div><script src=/app.js></script>", "# Title\n<script>boot()</script>"]) {
      expect(validateText(enc(page), "text/markdown", "llms_txt")).toEqual({ ok: false, reason: "html" });
    }
    expect(validateText(enc("# Plain\n"), "text/html; charset=utf-8", "agents_md")).toEqual({ ok: false, reason: "html" });
    expect(validateText(enc("<!doctype html><p>x"), "application/json", "skills_index")).toEqual({ ok: false, reason: "html" });
  });

  describe("skills", () => {
    it("accepts a SKILL.md with simple frontmatter, or none", () => {
      expect(validateText(enc("---\nname: pay\ndescription: Take payments\n---\n# Pay\nSteps.\n"), undefined, "skill").ok).toBe(true);
      expect(validateText(enc("# Pay\nSteps.\n"), undefined, "skill").ok).toBe(true);
    });

    it("refuses executable frontmatter keys rather than stripping them", () => {
      for (const key of ["hooks", "allowed-tools", "allowed_tools", "allowedTools", "tools", "model", "Model", "mcp-servers", "mcp_servers", "mcpServers", "mcpservers", "allowedtools"]) {
        expect(validateText(enc(`---\nname: x\n${key}: Bash\n---\nbody\n`), undefined, "skill")).toEqual({ ok: false, reason: "frontmatter_executable" });
      }
    });

    it("refuses nested or unterminated frontmatter and a missing body", () => {
      expect(validateText(enc("---\nname: x\nmetadata:\n  a: b\n---\nbody\n"), undefined, "skill")).toEqual({ ok: false, reason: "frontmatter_invalid" });
      expect(validateText(enc("---\nname: x\ndescription: >\n---\nbody\n"), undefined, "skill")).toEqual({ ok: false, reason: "frontmatter_invalid" });
      expect(validateText(enc("---\nname: x\nbody without a closing fence\n"), undefined, "skill")).toEqual({ ok: false, reason: "frontmatter_invalid" });
      expect(validateText(enc("---\nname: x\n---\n\n"), undefined, "skill")).toEqual({ ok: false, reason: "empty" });
    });
  });
});
