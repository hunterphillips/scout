import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Build dist/ once before any test file runs: several files spawn dist/sourceTools.js,
    // and a per-file build could rewrite it while another file's child is loading it.
    globalSetup: ["./test/global-setup.mjs"],
  },
});
