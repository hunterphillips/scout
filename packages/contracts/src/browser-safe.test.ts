import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { describe, expect, it } from "vitest";

// The root entry ships to the Chrome extension, so it must not reach any Node
// built-in or the Node-only `Buffer` global. Bundling from source keeps this
// independent of `dist/`.
describe("root entry", () => {
  it("bundles for the browser without Node built-ins or Buffer", async () => {
    const result = await build({
      entryPoints: [fileURLToPath(new URL("./index.ts", import.meta.url))],
      bundle: true,
      write: false,
      platform: "browser",
      format: "esm",
      logLevel: "silent",
    });
    expect(result.errors).toEqual([]);
    const text = result.outputFiles[0]?.text ?? "";
    expect(text).not.toMatch(/["']node:/);
    expect(text).not.toMatch(/\bBuffer\b/);
  });
});
