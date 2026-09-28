# Scout

Phase 0 only. Nothing here is functional yet.

This directory is a standalone workspace for Scout: a native Mac companion
(`native/Scout`), a Chrome sensor (`packages/browser-extension` plus
`packages/native-host`), shared code (`packages/contracts`,
`packages/scout-core`), and an independent personal-context MCP agent
(`packages/personal-context-mcp`, which must never import `@scout/*`).

## Commands

Run from this directory (Node 22.12+, npm):

    npm ci
    npm run build
    npm run typecheck
    npm test

Native scaffold:

    cd native/Scout && swift build && swift test

## Billing preflight

    node scripts/spikes/auth-preflight.mjs

Checks, without any model call, whether a `claude` child process started with
this environment would bill a claude.ai subscription. It prints a JSON report
of presence flags and key names only, never values. Exit 0 means
`subscription`; any other exit means `ambiguous` and no inference may run.

## Direct-profile billing preflight

    npm run preflight:direct -- --scratch-root <absolute dir outside the workspace>

Same checks, run against the personal-context service's own launch profile
(`scripts/spikes/launch-profile.mjs`) instead of the inherited environment.
The profile starts `claude` from a fresh private directory under the scratch
root, with an allowlisted environment that drops gateway, API-key, provider,
model and nested-session variables. It changes no settings and no parent
environment; user and managed settings still apply and can still block. The
report adds the profile id, forwarded and dropped key names, and how the
directory was classified. The directory is removed afterwards. Exit codes
match the inherited preflight.
