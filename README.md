# Scout

Scout is a browser companion for your own AI agent. When you are on a website you have
allowed, Scout reads what the site publishes for AI agents (`llms.txt`, `AGENTS.md`, agent
skills) and shows the exact text in a Chrome side panel. You approve or decline it.
Approved resources live in `~/.scout/capabilities`, and your agent reads them through the
`scout` MCP connection. Scout never serves anything you declined or revoked.

On sites where you switch on suggestions, Scout runs a short background job through your
agent and shows up to three links on that site that fit what you were just reading: the
pages you read on sites you allowed. Read an issue on your tracker, then open the docs,
and Scout suggests the docs pages for that issue. Scout reads a page once it has been on
screen for 2.5 seconds, never while you are typing into it, and keeps the text in memory
only, for at most 15 minutes. Site text is data to Scout, never instructions. No model runs
during discovery, preview, or approval.

## Pieces

- `packages/browser-extension`: the Chrome extension, with the sensor and the side panel (Scout's only user interface).
- `packages/native-host`: Chrome's native-messaging host, a relay to the core.
- `packages/scout-core`: the core, which holds permissions, discovery, the capability store, recommendation jobs, the panel channel, and the agent socket.
- `packages/scout-mcp`: the stdio MCP adapter your agent loads.
- `packages/contracts`: the zod schemas every piece shares.
- `native/Scout`: the Mac menu-bar app that launches and supervises the core.

How the pieces connect: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Commands

Run from this directory (Node 22.12+, npm):

    npm ci
    npm run build
    npm run typecheck
    npm test             # test:node, then test:mac (macOS)
    npm run test:node    # macOS or Linux: workspace and script tests minus the *.mac.test.* files
    npm run test:mac     # macOS: the *.mac.test.* files plus the Swift tests
    npm run test:e2e     # macOS: real native host against the real core (needs npm run build)
    npm run test:swift   # the Mac app's tests
    npm run test:all     # macOS: build, then npm test and test:e2e

A test that needs macOS tools (`codesign`, `plutil`, `launchctl`) goes in a
`*.mac.test.*` file. CI runs `test:node` on Ubuntu, and the full suite plus the Chrome
side-panel e2e test on macOS.

Locally the side-panel e2e test drives the real panel in Chrome for Testing and is
opt-in: `SCOUT_E2E_CHROME=1 SCOUT_E2E_BROWSERS=<dir with a Chrome for Testing install>`.

Core dev CLI (after `npm run build`; `catalog`, `discover`, `verify`, and `capability
ingest` make network requests; nothing runs a model):

    node packages/scout-core/dist/cli.js catalog https://docs.stripe.com [--refresh] [--json]
    node packages/scout-core/dist/cli.js discover https://www.backblaze.com [--refresh] [--json]
    node packages/scout-core/dist/cli.js verify https://docs.stripe.com/payments/subscriptions.md
    node packages/scout-core/dist/cli.js capability list|ingest|approve|decline|revoke|policy|unexport-all ...
    node packages/scout-core/dist/cli.js agent inspect|enable|disable|refresh|status ...

`catalog` caches under `~/.scout/cache/catalog` for 24 h; `--refresh` revalidates.
`capability` drives the same store the panel uses. The running core holds `store.lock`, so
quit Scout first. `agent` sets up optional retrieval tools for recommendation jobs, and
every backend launch needs `--allow-start`. Everything logs to
`~/.scout/logs/diagnostics.jsonl` (counts and codes only). Set `SCOUT_HOME` to keep a test
run out of `~/.scout`.

## Install

1. `npm run build`
2. `npm run setup` writes `~/.scout/config.json`, the native-host wrapper in
   `~/.scout/bin`, Chrome's native-messaging manifest, and the job profile
   (`agent-profile.json`, which names the agent binary and model the jobs use). Jobs run
   through Claude Code, Codex or Pi: `--agent claude-code`, `--agent codex` or
   `--agent pi` picks one; without the flag, setup uses the first of `claude`, `codex`
   and `pi` it finds. Everything it writes is listed in `~/.scout/installed.json`. `--dry-run`
   shows the paths first. `--agent-integration` also registers the `scout` MCP connection
   with that agent (`claude mcp add` at user scope, `codex mcp add` or `pi mcp add`) and installs the
   `scout-integration` skill where the agent reads skills. Setup refuses if a foreign
   `scout` registration exists.
3. In Chrome, open `chrome://extensions`, turn on Developer mode, and load
   `packages/browser-extension/dist` unpacked. Reload it there after every
   `npm run build`.
4. `npm run bundle-app -- --install` builds `Scout.app` and copies it to
   `~/Applications`. Open it from there; it appears in the menu bar only. To start it at
   login, run `npm run setup -- --login-launch`. After a code change, `npm run reload`
   rebuilds and restarts it (`-- --no-build` only restarts).
5. Click the Scout toolbar button to open the side panel. In **Sites**, press **Allow**
   next to a site or type a host. Scout asks Chrome for that one site only. Clicking the
   button again closes the panel.

To get suggestions on a site, open **Page** while you're on it and turn on **Suggest on
<host>** in the tray at the bottom. The switch applies at once, including on the page in
front of you. Each settled visit to that site then runs one short job through your agent.
Every site starts with it off.

## What you'll see

The panel's bottom nav has four destinations: **Page**, **Sites**, **Activity**,
**Settings**. On an unknown site, **Page** asks you to click the Scout icon; after that it
offers **Allow Scout on <host>**, or the suggestions switch if Scout is already allowed.
After 2.5 seconds on an allowed site that publishes agent files, a pill says the site
has files for your agent. **Review** streams the exact text, and **Approve** enables only
once the whole text has arrived and its hash checks out. **Not now** declines. Approved
files are listed below, each with **Revoke**.

On a site with suggestions on, **Page** shows up to three links after the job finishes.
While the job runs, three dots pulse where the links will go. When there are no links, or
something is wrong, a short line says so. A link opens in a new tab only when you click it; Scout runs no
job for the page it opened, and when you return to a page within 15 minutes its links come
back without a new job. **Activity**
lists problems first, then your agent's reads. **Settings** has Pause, the **Agent** row
(every installed agent Scout finds, **Claude Code**, **Codex** or **Pi**; picking one applies at
once, with no restart), the switch that lets your agent see the current site and the
pages you read on allowed sites, and Diagnostics. Allowing a site in Sites includes reading
its pages; there is no separate switch. With the panel closed, the toolbar badge counts new links (blue) or files to review (amber), and
the icon turns grey while Scout is paused. Pause works from the panel or the menu bar.
Quitting the app makes the panel say the core is unavailable, and relaunching reconnects
on its own.

## Threat model

Scout trusts processes running as the same user. The core's sockets (`core.sock` and
`agent.sock`, mode 0600 in a 0700 run directory), the agent token issued at each start,
and the agent profile defend against other users on the machine and against site content.

The installed app runs from this checkout. Re-run setup after moving the checkout or
changing Node.

## Doctor and uninstall

`npm run doctor` checks the install in eight sections and exits non-zero only on a
failure. `npm run uninstall` lists what it will remove, asks, then removes only files that
still match what setup recorded: first the skill wrappers Scout exported, then the
manifest, config, profile, LaunchAgent, and the installed app. It refuses while Scout is
running. It keeps the extension key unless you pass `--include-key` and never touches
`~/.scout/logs`. `npm run uninstall -- --agent-integration` removes only the MCP
registration and the skill, for whichever agent they were installed with.

Codex jobs run with a private Codex home under `~/.scout/run/codex-home`, so none of
your Codex config, rules, history or sessions reach a job. Its only link to your own
Codex setup is `auth.json`, a symlink to `~/.codex/auth.json`, so your ChatGPT login is
used and a token refresh lands in your file. Doctor checks the link; uninstall removes
the private home (the link only, never the file it points to).

Pi jobs run with a private Pi agent directory per job. It links to your `auth.json` and
`models.json` and copies only your model selection from `settings.json`, so a job uses
the provider and model your Pi would pick, and none of your extensions, skills, prompts
or sessions. Jobs get no API keys from your environment, so log in with `pi` (`/login`)
or put the key in `auth.json`.

## Chrome for Testing

To check against Chrome for Testing instead of stable Chrome, set `CHROME_NMH_DIR` to the
test profile's `NativeMessagingHosts/` when running setup, and add
`"chromeBundleId": "com.google.chrome.for.testing"` to `~/.scout/config.json`.
