import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // The agent-job tests spawn scout-mcp's dist/main.js and scout-core's own dist
    // entrypoints: build those (and contracts) once first.
    globalSetup: ["./test/global-setup.mjs"],
  },
});
