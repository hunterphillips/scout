import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // The agent-job tests spawn scout-mcp's dist/main.js and compare against
    // personal-context-mcp's dist: build those (and contracts) once first.
    globalSetup: ["./test/global-setup.mjs"],
  },
});
