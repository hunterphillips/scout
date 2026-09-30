# Scout

Scout is a proof of concept. When Hunter lands on a website, it shows a few links from
that site that fit what he is working on. Phase 1 is the plumbing: a Chrome
extension senses the focused tab, a native host relays that to a local core process,
and a Mac app shows the core's status. Phase 2 is catalog discovery: the core can turn
a site into a cached list of candidate links, exposed through a dev CLI. Phase 3 is
the personal-context service: a local MCP server that, per request, runs a fresh
headless `claude` on Hunter's subscription to pick a few candidates against his recent
activity and any sources he has enabled. The running app does not use the catalog or
the service yet; that is Phase 4.

Pieces: a native Mac companion (`native/Scout`), a Chrome sensor
(`packages/browser-extension` plus `packages/native-host`), shared code
(`packages/contracts`, `packages/scout-core`), and an independent personal-context MCP
service (`packages/personal-context-mcp`; it must never import `@scout/*`, and Scout is
only one of its clients).

## Commands

Run from this directory (Node 22.12+, npm):

    npm ci
    npm run build
    npm run typecheck
    npm test            # workspace tests, spikes, and setup-script tests
    npm run test:e2e    # real native host against the real core (needs npm run build)
    npm run test:all    # build, then both of the above

Catalog dev CLI (after `npm run build`; opt-in, these two make network requests):

    node packages/scout-core/dist/cli.js catalog https://docs.stripe.com [--refresh] [--json]
    node packages/scout-core/dist/cli.js verify https://docs.stripe.com/payments/subscriptions.md

`catalog` caches under `~/.scout/cache/catalog` for 24 h; `--refresh` revalidates.
`verify` takes up to 10 URLs from one origin. `rank` is still a stub and exits 2 until
Phase 4 wires the rank client in. Both commands log to `~/.scout/logs/diagnostics.jsonl`
(counts and codes only). Set `SCOUT_HOME` to keep a test run out of `~/.scout`.

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
`run/server.json`. On start it runs the billing preflight against its own launch
profile and refuses to rank unless the verdict is `subscription`. `pcm rank` accepts a
candidate array or the catalog CLI's `--json` output and makes one real model call.
`SCOUT_LIVE=1 npm run test:live -w personal-context-mcp` is the opt-in smoke test (one
model call, throwaway home); `npm test` never runs it.

Native app:

    cd native/Scout && swift build && swift test

## Install for a manual check

1. `npm run build`
2. `npm run setup` — generates an extension key, writes `~/.scout/config.json`
   (node path, repo path, extension ID, destination sites), the native-host wrapper
   in `~/.scout/bin`, and Chrome's native-messaging manifest. Everything it writes is
   listed in `~/.scout/installed.json`. Add `--dry-run` to see the paths first.
3. In Chrome, open `chrome://extensions`, turn on Developer mode, and load
   `packages/browser-extension/dist` unpacked.
4. Start the app: `cd native/Scout && swift run ScoutApp` (from a shell without
   `SCOUT_HOME` set; the app reads only `~/.scout`).
5. Click the Scout Sensor icon and press **Grant sites**.

What you should see: the popup says "connected"; the app panel says "Idle" and, while
a docs.stripe.com or www.peakdesign.com tab is in front, shows that hostname on a
second line. Switching tabs or apps clears it. A GitHub issue page raises the popup's
"acked" count. Quitting the app makes the popup say "core unavailable" or "connecting"
for about four and a half minutes, then "disconnected"; relaunching inside that window
reconnects on its own, and after it a tab switch or **Reconnect** does.

`npm run doctor` checks the install. `npm run uninstall` removes only the files
`installed.json` lists, after showing them; it keeps the key unless you pass
`--include-key`, and never touches `~/.scout/logs`.

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
