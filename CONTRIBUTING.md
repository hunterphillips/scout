# Contributing to Scout

## Platforms

Scout runs on macOS. Most of the Node code also builds and tests on Linux.

| Command | Where | What it runs |
| --- | --- | --- |
| `npm test` | macOS | Workspace tests, script tests, and the Swift tests |
| `npm run test:node` | macOS or Linux | Workspace and script tests minus the `*.mac.test.*` files |
| `npm run test:mac` | macOS | The `*.mac.test.*` files plus the Swift tests |
| `npm run test:e2e` | macOS | The real native host against the real core (after a build) |

CI runs `test:node` on Ubuntu, and the full suite plus the Chrome side-panel e2e test on
macOS.

## Build and test

Use Node 22.12+ and npm:

    npm ci
    npm run build
    npm run typecheck
    npm test

To run one package's tests:

    npx vitest run --root packages/<name>

Tests that touch install paths need a throwaway `SCOUT_HOME` and every override set:
`CHROME_NMH_DIR`, `LAUNCH_AGENTS_DIR`, `SCOUT_APPLICATIONS_DIR`, `SCOUT_SKILLS_ROOT`,
`SCOUT_CLAUDE_BIN`, `SCOUT_CODEX_BIN`, `SCOUT_CODEX_HOME`, `SCOUT_PI_BIN`,
`SCOUT_PI_AGENT_DIR`. Setup refuses these overrides
against the real `~/.scout`.

## The fake agent CLIs

Tests never call a real model. Job tests point `SCOUT_CLAUDE_BIN` at the fake CLI in
`packages/scout-core/src/agents/claudeCode/testing/fake-claude.mjs` and `SCOUT_CODEX_BIN`
at `packages/scout-core/src/agents/codex/testing/fake-codex.mjs`, which also answers
`codex mcp add|get|remove` against the temp Codex home in `SCOUT_CODEX_HOME`. `SCOUT_PI_BIN`
points at `packages/scout-core/src/agents/pi/testing/fake-pi.mjs`, which answers
`pi mcp add|remove|list` against `SCOUT_PI_AGENT_DIR`.

A real model call spends the maintainer's quota or money. Don't make one, and don't
add a test that makes one, unless the maintainer has approved that specific run.

## Adding an agent adapter

Claude Code, Codex and Pi are the three adapters; `agents/codex/` is the smallest one to
read first, and `agents/pi/` shows an agent without an output-schema flag. Scout core outside the adapter folders and the integration folder must not assume
any particular agent. A new adapter needs:

1. A folder under `packages/scout-core/src/agents/<name>/` that implements
   `AgentJobAdapter` from `agents/adapter.ts` (`id`, `profileFingerprint`, `readiness`,
   `refreshReadiness`, `run`, `abortAll`), plus a `profile.ts` with the union member, a
   label for the Settings row, a default-profile factory and the agent's usual install
   locations.
2. Cases in `agents/registry.ts`: `createJobAdapter`, `createDefaultProfileFor`,
   `adapterLabel` and `profileExecutable`. Every switch on `profile.adapter` is
   exhaustive, so the compiler flags a missing case.
3. The member in the `AgentProfileSchema` discriminated union in `agents/profile.ts`.
4. A scripted fake CLI under `agents/<name>/testing/` and a `SCOUT_<NAME>_BIN` override,
   so no test runs the real one.

If the agent needs install-time wiring (an MCP registration or exported skills), add it
under `scripts/lib/` next to `claude-mcp.mjs`, `codex-mcp.mjs` and `pi-mcp.mjs`, and under
`packages/scout-core/src/integrations/<name>/` for anything the running core does.

## Landing changes

Changes land on `main`; no pull request or CI wait is required. CI runs on every push to
`main`, so fix a red run right away.
