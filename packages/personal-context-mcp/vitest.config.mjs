import { defineConfig, configDefaults } from "vitest/config";

export default defineConfig({
  test: {
    // Build dist/ once before any test file runs: several files spawn dist/sourceTools.js,
    // and a per-file build could rewrite it while another file's child is loading it.
    globalSetup: ["./test/global-setup.mjs"],
    // The live check runs the real claude; only `npm run test:live` (vitest.live.config.mjs) picks it up.
    exclude: [...configDefaults.exclude, "test/live.test.ts"],
  },
});
