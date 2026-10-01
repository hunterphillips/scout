// Test-only: runs verify:agent in its own process with the test world's seams and the real
// signal wiring (`signals: process`, as the entrypoint does), so a test can send it a real
// SIGINT/SIGTERM. argv[2] is JSON: { args, env, deps } (deps must be plain data).

import { runAgentCheck } from "./run.mjs";

const { args, env, deps } = JSON.parse(process.argv[2]);
const code = await runAgentCheck(args, { env, deps, signals: process });
process.exit(code);
