# Agent-driven manual check

`check.mjs` runs a throwaway Scout in Chrome for Testing on real sites. It never touches
`~/.scout`, the installed app or a real Chrome profile, and its agent is the fake Claude CLI.
The script's header documents every command and what `up` sets up.

    npm run build
    node scripts/manual-check/check.mjs up
    node scripts/manual-check/check.mjs grant developers.cloudflare.com
    node scripts/manual-check/check.mjs goto https://developers.cloudflare.com/workers/ --wait 6
    node scripts/manual-check/check.mjs activity
    node scripts/manual-check/check.mjs down

`up` prints the throwaway `SCOUT_HOME`, the extension ID and the CDP port. Later commands
find them on their own. `goto --wait` prints the core's visit and capture events for that
page; a capture shows as `activity_accepted` about 3.5 s after the page loads. `activity`
prints what the user's agent would read from `recent_activity`: each page's URL, title, byte
count and text. `status` prints the panel's Diagnostics, including the "Sent to Scout"
counters. `down` stops Chrome and the core, deletes the home, and says whether any process
is left. The diagnostics log is `<SCOUT_HOME>/logs/diagnostics.jsonl`.

`tabs`, `front`, `click`, `back`, `panel` and `shot` drive the browser between those steps.

Chrome for Testing comes from Playwright's cache (`~/Library/Caches/ms-playwright`), or from
`--chrome <path>` or `SCOUT_CHROME`. It runs headless: a headed window that is not the focused
macOS window blocks every page read. Every launch passes `--use-mock-keychain` and
`--password-store=basic`, so macOS never asks for the "Chromium Safe Storage" keychain item.

`grant` answers Chrome's site prompt ahead of time, then clicks Allow in the panel. The real
prompt in stable Chrome needs a check by hand. The panel runs as `panel.html` in a tab,
because CDP cannot open the real side panel; `test/side-panel.test.mjs` covers the panel
itself.
