# Agent-driven manual check (Phase 1)

How the 2026-09-28 check was run without touching real Chrome. Stable Google Chrome
ignores `--load-extension`, so the check uses Playwright's cached Chrome for Testing
build and a throwaway profile whose own `NativeMessagingHosts/` holds the bridge manifest.

    PROFILE=<scratch dir>/profile; mkdir -p "$PROFILE/NativeMessagingHosts"
    npm run build
    CHROME_NMH_DIR="$PROFILE/NativeMessagingHosts" node scripts/setup.mjs
    # add "chromeBundleId": "com.google.chrome.for.testing" to ~/.scout/config.json
    CFT="$HOME/Library/Caches/ms-playwright/chromium-<rev>/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"
    "$CFT" --user-data-dir="$PROFILE" --disable-extensions-except=packages/browser-extension/dist \
      --load-extension=packages/browser-extension/dist --remote-debugging-port=9333 --no-first-run about:blank &
    (cd native/Scout && swift build && env -u SCOUT_HOME .build/debug/ScoutApp &)

Then drive the browser with `node scripts/manual-check/drive.mjs <cmd>` (needs
`playwright-core`, a root devDependency): `panel <extId>`, `grant <extId>`, `text <extId>`,
`goto <url>`, `front <urlSubstring>`, `click <urlSubstring> <selector>`, `back <urlSubstring>`,
`tabs`, `shot <file>`. Bring Chrome for Testing to the front of macOS with
`osascript -e 'tell application id "com.google.chrome.for.testing" to activate'`; the
core only counts a visit when that app is frontmost. Watch
`~/.scout/logs/diagnostics.jsonl` for `visit_change` and `activity_forwarded`, and
`screencapture -x` to see the panel. Finish with `npm run doctor` and
`CHROME_NMH_DIR=... npm run uninstall -- --yes`, then quit the app and the browser.

Under `--load-extension`, Grant sites granted all three hosts with no prompt, so the
prompt path in stable Chrome is still unexercised.

Since P4.1 the popup is gone: `panel` opens the side panel's page (`panel.html`) in an
ordinary tab, because CDP cannot open the real side panel. The panel itself is covered by
`test/side-panel.test.mjs`; this script only drives the browser around it.
