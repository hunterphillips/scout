# Scout

**October 1:** Scout pivoted to a website agent. The core now discovers what a site
publishes for agents (`llms.txt`, `AGENTS.md`, skills), the Mac window offers each
resource for preview and approval, approved resources are exported as read-only skills
and served to the user's own Claude Code over a local socket, and an optional setup
step registers that connection. The plan is
[2026-10-01-scout-website-agent-implementation.md](../thoughts/shared/plans/2026-10-01-scout-website-agent-implementation.md);
Phases 1 and 2 are built and live-checked. Background recommendations through the
user's agent are Phase 3 and are not wired in yet.

## Current build

Scout is a proof of concept. When Hunter lands on a website he has allowed, Scout waits
three seconds, reads what the site publishes for agents, and offers it in a small Mac
window. He previews the exact text and approves or declines it. Approved resources
live in `~/.scout/capabilities` and are readable by his Claude Code sessions through
the `scout` MCP connection; nothing he declines or revokes is ever served. Site text is
data to Scout, never instructions. No model runs during discovery, preview, or approval.

Pieces: a Mac window (`native/Scout`), a Chrome sensor (`packages/browser-extension`
plus `packages/native-host`), the core (`packages/scout-core`: permissions, discovery,
the capability store, the window channel, and the agent socket), the stdio MCP adapter
Claude Code talks to (`packages/scout-mcp`), shared schemas (`packages/contracts`), and
the pre-pivot personal-context service (`packages/personal-context-mcp`; untouched
until Phase 4, must never import `@scout/*`).

## Commands

Run from this directory (Node 22.12+, npm):

    npm ci
    npm run build
    npm run typecheck
    npm test            # workspace tests, spikes, and setup-script tests
    npm run test:e2e    # real native host against the real core (needs npm run build)
    npm run test:all    # build, then both of the above

Core dev CLI (after `npm run build`; `catalog`, `discover`, `verify`, and `capability
ingest` make network requests, nothing runs a model):

    node packages/scout-core/dist/cli.js catalog https://docs.stripe.com [--refresh] [--json]
    node packages/scout-core/dist/cli.js discover https://www.backblaze.com [--refresh] [--json]
    node packages/scout-core/dist/cli.js verify https://docs.stripe.com/payments/subscriptions.md
    node packages/scout-core/dist/cli.js capability list|ingest|approve|decline|revoke|policy ...
    node packages/scout-core/dist/cli.js agent inspect|enable|disable|refresh|status ...

`catalog` caches under `~/.scout/cache/catalog` for 24 h; `--refresh` revalidates.
`discover` fetches a site's `llms.txt`, `AGENTS.md`, and skills index. `capability`
drives the same store the window uses (the running core holds `store.lock`, so stop it
first). `agent` sets up optional retrieval tools for Phase 3 jobs; every backend launch
needs `--allow-start`. `rank` exits 2 until Phase 3. All of it logs to
`~/.scout/logs/diagnostics.jsonl` (counts and codes only). Set `SCOUT_HOME` to keep a
test run out of `~/.scout`.

Personal-context service (after `npm run build`):

    node packages/personal-context-mcp/dist/server.js          # 127.0.0.1:47821, PCM_PORT overrides
    node packages/personal-context-mcp/dist/cli.js status      # pcm status
    node packages/personal-context-mcp/dist/cli.js sources     # what could be read, and what is enabled
    node packages/personal-context-mcp/dist/cli.js sources enable <id> [--project <name>]
    node packages/personal-context-mcp/dist/cli.js reload      # SIGHUP: apply a source change
    node packages/personal-context-mcp/dist/cli.js rank --origin https://docs.stripe.com --candidates catalog.json

The service keeps its files under `~/.personal-context-mcp` (`PERSONAL_CONTEXT_HOME`
overrides): `config.json` (port, model, sources; every source ships disabled), `token`
(bearer token every client must send), `runs.jsonl` (per-run counts, never content),
`run/server.json`. Runs use `claude-sonnet-5-5` unless `config.json` says otherwise:
`"model": null` inherits the Claude Code default, and any other model name overrides it.
On start it runs the billing preflight against its own launch
profile and refuses to rank unless the verdict is `subscription`. `pcm rank` accepts a
candidate array or the catalog CLI's `--json` output and makes one real model call.
`SCOUT_LIVE=1 npm run test:live -w personal-context-mcp` is the opt-in smoke test (one
model call, throwaway home); `npm test` never runs it.

Native app:

    cd native/Scout && swift build && swift test

## Install for a manual check

1. `npm run build`
2. `npm run setup` — generates an extension key, writes `~/.scout/config.json`
   (node path, repo path, extension ID), the native-host wrapper in `~/.scout/bin`, and
   Chrome's native-messaging manifest. Everything it writes is listed in
   `~/.scout/installed.json`. Add `--dry-run` to see the paths first. Add
   `--agent-integration` to also register the `scout` MCP connection at user scope
   through `claude mcp add` and install the static `scout-integration` skill; setup
   explains what that exposes and refuses if a foreign `scout` registration exists.
3. In Chrome, open `chrome://extensions`, turn on Developer mode, and load
   `packages/browser-extension/dist` unpacked.
4. Start the app: `cd native/Scout && swift run ScoutApp` (from a shell without
   `SCOUT_HOME` set; the app reads only `~/.scout`).
5. On a site you want Scout to see, click the Scout Sensor icon and press **Allow Scout
   on this site**. Scout asks for that one origin only. **Capture GitHub issue text** is a
   separate toggle in the same popup.

What you should see: the popup says "connected" and the window's compact line says
"Idle" with the current host once a tab on an allowed site is in front. After three
seconds on an allowed site that publishes `llms.txt`, the window's badge shows an
offer. Expand the window: **Offers** lists it, **Preview** streams the exact text, and
Approve enables only once the whole text has arrived and its hash checks out.
**Library** shows approved resources with Revoke; **Settings** has Pause, per-site
auto-acquire, and the browser-context grant for the agent connection; **Activity**
lists the agent's reads; **Problems** lists failed commands and export conflicts. The
window never comes forward on its own, and Escape collapses it. Removing a site's
grant from the popup drops its offers. Quitting the app makes the popup say "core
unavailable" or "connecting" for about four and a half minutes, then "disconnected";
relaunching inside that window reconnects on its own.

`npm run doctor` checks the install. `npm run uninstall` removes only the files
`installed.json` lists, after showing them; it keeps the key unless you pass
`--include-key`, never touches `~/.scout/logs`, and never removes the runtime skill
wrappers (revoke in Scout first). `npm run uninstall -- --agent-integration` removes
only the MCP registration and the static skill.

Rebuilding the extension keeps the `key` setup wrote. A fresh clone needs setup again.

To check against Chrome for Testing instead of stable Chrome, set `CHROME_NMH_DIR` to
the test profile's `NativeMessagingHosts/` when running setup, and add
`"chromeBundleId": "com.google.chrome.for.testing"` to `~/.scout/config.json`.

## Phase 0 spikes

The billing preflights and the throwaway capture/bridge spikes live under
`scripts/spikes/`. Results: `../thoughts/shared/research/2026-09-24-scout-phase0-results.md`.

    node scripts/spikes/auth-preflight.mjs
    npm run preflight:direct -- --scratch-root <absolute dir outside the workspace>

The first checks, without any model call, whether a `claude` child started with this
environment would bill a claude.ai subscription; it prints presence flags and key
names only. Exit 0 means `subscription`; anything else means `ambiguous` and no
inference may run. The second runs the same checks against the personal-context
service's own launch profile (`scripts/spikes/launch-profile.mjs`), which starts
`claude` from a fresh private directory with an allowlisted environment.
