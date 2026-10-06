# Contributing to Scout

## Platforms

Scout runs on macOS. Most of the Node code also builds and tests on Linux.

| Command | Where | What it runs |
| --- | --- | --- |
| `npm test` | macOS | Workspace tests, script tests, and the Swift tests |
| `npm run test:node` | macOS or Linux | Workspace and script tests minus the `*.mac.test.*` files |
| `npm run test:mac` | macOS | The `*.mac.test.*` files plus the Swift tests |
| `npm run test:e2e` | macOS | The real native host against the real core (after a build) |

CI runs the full suite on macOS.

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
`SCOUT_CLAUDE_BIN`. Setup refuses these overrides against the real `~/.scout`.

## The fake agent CLI

Tests never call a real model. Job tests point `SCOUT_CLAUDE_BIN` at the fake CLI in
`packages/scout-core/src/agents/claudeCode/testing/fake-claude.mjs`.

A real model call spends the maintainer's quota. Don't make one, and don't add a test that
makes one, unless the maintainer has approved that specific run.

## Adding an agent adapter

Claude Code is the first adapter. Scout core outside the adapter folder and the
integration folder must not assume any particular agent. A second adapter needs three
changes:

1. A new folder under `packages/scout-core/src/agents/<name>/` that implements
   `AgentJobAdapter` from `agents/adapter.ts` (`id`, `profileFingerprint`, `readiness`,
   `refreshReadiness`, `run`, `abortAll`).
2. A case in `createJobAdapter` in `agents/registry.ts`. The switch on `profile.adapter`
   is exhaustive, so the compiler flags a missing case.
3. A member in the `AgentProfileSchema` discriminated union in `agents/profile.ts`.

If the agent needs install-time wiring (an MCP registration or exported skills), add it
under `packages/scout-core/src/integrations/<name>/`.

## Landing changes

Copy-only changes (docs, UI text) go straight to `main`. Code changes go through a pull
request and must pass CI.
