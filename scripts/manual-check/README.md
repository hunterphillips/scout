# Agent-driven manual check

How to check Scout in a browser without touching real Chrome or the real `~/.scout`. Stable
Google Chrome ignores `--load-extension`, so the check uses Playwright's cached Chrome for
Testing build and a throwaway profile whose own `NativeMessagingHosts/` holds the bridge
manifest. Build in a worktree or clone: the installed app runs from its checkout's `dist/`.

    export SCOUT_HOME=$(mktemp -d)   # under $TMPDIR: macOS caps socket paths at 104 bytes
    PROFILE=$SCOUT_HOME/profile; mkdir -p "$PROFILE/NativeMessagingHosts"
    npm run build

Fill the throwaway home as `test/side-panel.test.mjs` does: the extension built with a fresh
key into `$SCOUT_HOME/ext` (`SCOUT_EXT_DIST`), `config.json`, an `agent-profile.json` naming
the fake CLI, the host wrapper, and `$PROFILE/NativeMessagingHosts/dev.scout.bridge.json`.
Point every CONTRIBUTING override into `$SCOUT_HOME`, and give the core a throwaway `HOME`
and a `PATH` where the real `claude`, `codex` and `pi` cannot be found. Don't run setup, and
don't start the Mac app, which reads only `~/.scout`. Start the core as the app does and tell
it Chrome is frontmost; closing its stdin (`exec 3>&-`) shuts it down:

    mkfifo "$SCOUT_HOME/core.in"
    node packages/scout-core/dist/main.js --stdio <"$SCOUT_HOME/core.in" >"$SCOUT_HOME/core.out" 2>"$SCOUT_HOME/core.err" &
    exec 3>"$SCOUT_HOME/core.in"
    echo "{\"type\":\"frontmost\",\"bundleId\":\"com.google.Chrome\",\"at\":$(date +%s000)}" >&3
    CFT="$HOME/Library/Caches/ms-playwright/chromium-<rev>/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"
    "$CFT" --user-data-dir="$PROFILE" --disable-extensions-except="$SCOUT_HOME/ext" \
      --load-extension="$SCOUT_HOME/ext" --remote-debugging-port=9333 --no-first-run about:blank &

Grant a site as the side-panel e2e test does: `chrome.developerPrivate.addHostPermission`
from a `chrome://extensions` page, then the panel's Allow. Chrome's prompt never appears this
way, so the prompt path in stable Chrome needs a check by hand.

Then drive the browser with `node scripts/manual-check/drive.mjs <cmd>` (needs
`playwright-core`, a root devDependency): `panel <extId>`, `allow <extId> <host>`, `text <extId>`,
`goto <url>`, `front <urlSubstring>`, `click <urlSubstring> <selector>`, `back <urlSubstring>`,
`tabs`, `shot <file>`. Watch `$SCOUT_HOME/logs/diagnostics.jsonl` for `visit_change` and
`activity_accepted`. Finish by closing the browser, ending the core's stdin and deleting
`$SCOUT_HOME`.

`panel` opens the side panel's page (`panel.html`) in an ordinary tab, because CDP cannot open
the real side panel. The panel itself is covered by `test/side-panel.test.mjs`; this script
only drives the browser around it.
