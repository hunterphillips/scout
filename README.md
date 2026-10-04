# Scout

Scout is a proof of concept. When Hunter is on a website he has allowed, Scout reads what
the site publishes for AI agents (`llms.txt`, `AGENTS.md`, agent skills) and offers it in a
side panel in Chrome. He previews the exact text and approves or declines it. Approved
resources live in `~/.scout/capabilities` and are readable by his own Claude Code through
the `scout` MCP connection; nothing declined or revoked is ever served. For sites he lists
as destinations, Scout also runs a short background job through his Claude Code
subscription and shows up to three links on that site that fit what he was just reading
on GitHub. Site text is data to Scout, never instructions. No model runs during
discovery, preview, or approval.

The plan and its phase log:
[2026-10-01-scout-website-agent-implementation.md](../thoughts/shared/plans/2026-10-01-scout-website-agent-implementation.md).
Phases 1–3 passed their live checks. Phase 4 (side panel, menu-bar app, install) is
built; its gate is Hunter using it on his own machine.

## Pieces

- `packages/browser-extension` — the Chrome extension: the sensor and the side panel.
- `packages/native-host` — Chrome's native-messaging host, a relay to the core.
- `packages/scout-core` — the core: permissions, discovery, the capability store, the
  recommendation jobs, the panel channel, and the agent socket.
- `packages/scout-mcp` — the stdio MCP adapter Claude Code talks to.
- `packages/contracts` — the schemas every piece shares.
- `native/Scout` — the Mac menu-bar app that launches and supervises the core.

## Commands

Run from this directory (Node 22.12+, npm):

    npm ci
    npm run build
    npm run typecheck
    npm test             # workspace tests and setup-script tests
    npm run test:e2e     # real native host against the real core (needs npm run build)
    npm run test:pivot   # build, then the agent-contract checks and the e2e tests
    npm run test:swift   # the Mac app's tests
    npm run test:all     # build, then npm test and test:e2e

The side-panel e2e test drives the real panel in Chrome for Testing and is opt-in:
`SCOUT_E2E_CHROME=1 SCOUT_E2E_BROWSERS=<dir with a Chrome for Testing install>`.

Core dev CLI (after `npm run build`; `catalog`, `discover`, `verify`, and `capability
ingest` make network requests, nothing runs a model):

    node packages/scout-core/dist/cli.js catalog https://docs.stripe.com [--refresh] [--json]
    node packages/scout-core/dist/cli.js discover https://www.backblaze.com [--refresh] [--json]
    node packages/scout-core/dist/cli.js verify https://docs.stripe.com/payments/subscriptions.md
    node packages/scout-core/dist/cli.js capability list|ingest|approve|decline|revoke|policy|unexport-all ...
    node packages/scout-core/dist/cli.js agent inspect|enable|disable|refresh|status ...

`catalog` caches under `~/.scout/cache/catalog` for 24 h; `--refresh` revalidates.
`capability` drives the same store the panel uses; the running core holds `store.lock`,
so quit Scout first. `agent` sets up optional retrieval tools for recommendation jobs;
every backend launch needs `--allow-start`. Everything logs to
`~/.scout/logs/diagnostics.jsonl` (counts and codes only). Set `SCOUT_HOME` to keep a
test run out of `~/.scout`.

## Install

1. `npm run build`
2. `npm run setup` writes `~/.scout/config.json`, the native-host wrapper in
   `~/.scout/bin`, Chrome's native-messaging manifest, and the job profile
   (`agent-profile.json`: the `claude` binary and model the jobs use). Everything it
   writes is listed in `~/.scout/installed.json`. `--dry-run` shows the paths first.
   `--agent-integration` also registers the `scout` MCP connection at user scope through
   `claude mcp add` and installs the `scout-integration` skill; setup refuses if a foreign
   `scout` registration exists.
3. In Chrome, open `chrome://extensions`, turn on Developer mode, and load
   `packages/browser-extension/dist` unpacked. Reload it there after every
   `npm run build`.
4. `npm run bundle-app -- --install` builds `Scout.app` and copies it to
   `~/Applications`. Open it from there; it appears in the menu bar only. To start it
   at login: `npm run setup -- --login-launch`.
5. Click the Scout toolbar button. The side panel opens. In **Sites**, press **Allow**
   next to a site (GitHub and Stripe are listed) or type another host. Scout asks Chrome
   for that one site only. Clicking the button again closes the panel.

To get suggestions on a site, open **Page** while you're on it and turn on
**Suggest on <host>** in the tray at the bottom. It applies at once, including on the
page in front of you. Each settled visit to that site then spends one short job on
Hunter's subscription. Every site starts with it off.

What you should see: the panel has four destinations in its bottom nav: **Page**,
**Sites**, **Activity**, **Settings**. On **Page**, the tray asks you to click the Scout
icon to check an unknown site; after that click it names the current host: an **Allow
Scout on <host>** row if Scout isn't allowed there, otherwise the suggestions switch. After three seconds on an allowed site that publishes `llms.txt`, a pill says the
site has files for your agent; **Review** opens a card that streams the exact text, and
Approve enables once the whole text has arrived and its hash checks out (**Not now**
declines; **Next** steps through the files). Below it, what you approved is listed, each
with Revoke. **Settings** has Pause, GitHub issue capture, the switch that lets the agent
read the current site and recent GitHub issues, and Diagnostics. **Activity** lists
problems (failed commands, export conflicts) first, then the agent's reads. On a
destination, **Page** shows up to three suggested links after the job finishes, or says
why there are none; a link opens in a new tab only when clicked. With the panel closed,
the toolbar badge counts new links (blue) or files to review (amber), and the icon turns
grey while Scout is paused. Pause from the panel or the menu bar; both show the same
state. Quitting the app makes the panel say the core is unavailable; relaunching
reconnects on its own.

`npm run doctor` checks the install in eight sections and exits non-zero only on a
failure. `npm run uninstall` lists what it will remove, asks, then removes only files
that still match what setup recorded: the skill wrappers Scout exported first, then the
manifest, config, profile, LaunchAgent, and the installed app. It refuses while Scout
is running. It keeps the extension key unless you pass `--include-key` and never touches
`~/.scout/logs`. `npm run uninstall -- --agent-integration` removes only the MCP
registration and the skill.

To check against Chrome for Testing instead of stable Chrome, set `CHROME_NMH_DIR` to
the test profile's `NativeMessagingHosts/` when running setup, and add
`"chromeBundleId": "com.google.chrome.for.testing"` to `~/.scout/config.json`.
