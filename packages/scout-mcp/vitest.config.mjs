import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // main.test.ts spawns dist/main.js: build it (and the contracts it imports) once first.
    globalSetup: ["./test/global-setup.mjs"],
  },
});
