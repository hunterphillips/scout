// Opt-in live check: `npm run test:live -w personal-context-mcp` (sets SCOUT_LIVE=1).
// Runs the REAL claude through the service once, on Hunter's subscription.
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globalSetup: ["./test/global-setup.mjs"],
    include: ["test/live.test.ts"],
    testTimeout: 90_000,
    hookTimeout: 90_000,
  },
});
