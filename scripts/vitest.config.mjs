import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // agent-check tests import the built scout-core / scout-mcp packages and spawn their
    // dist entrypoints: build them (and what they import) once first.
    globalSetup: ["../packages/scout-core/test/global-setup.mjs"],
  },
});
