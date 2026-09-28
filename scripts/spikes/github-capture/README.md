# GitHub capture and native bridge spikes (Phase 0, throwaway)

Two spikes. Neither is Scout's production code.

- `github-capture/`: a throwaway MV3 extension. It reads the title and main
  body of the GitHub issue in the active tab and sends them to the native bridge.
- `../bridge/`: a Chrome native-messaging host shim and a stub echo server. The
  two talk over a private Unix socket.

Captured text passes through memory only. It is never shown in the popup,
stored, or logged. The popup shows states, lengths, selector ids and timings.

## Commands (run from `scout/`)

    npm run test:spikes                      # all hermetic tests, no browser, no network
    npm run spike:bridge:echo-test           # bridge end to end via a real child host + Unix socket
    npm run spike:capture:prepare -- --out <absolute dir> [--isolated-profile <absolute dir>]
    npm run spike:bridge:server -- --runtime-dir <runtime dir printed by prepare>

`prepare` writes only under `--out`:

- `extension/`: the unpacked extension. Its manifest has a generated public
  `key`, so the extension id stays stable across re-runs.
- `native-host/`: the wrapper script, the host manifest (absolute paths, one
  exact `allowed_origins` entry), and `install-real-chrome.sh` /
  `uninstall-real-chrome.sh`. Nothing runs those two scripts for you.
- `runtime/`: the 0700 socket directory.

With `--isolated-profile <dir>`, prepare also copies the host manifest into
`<dir>/NativeMessagingHosts/`. A browser started with `--user-data-dir=<dir>`
finds the host there, so nothing touches the real Chrome profile.

## What each check covers

| Check | How | Browser? |
|---|---|---|
| Route, focus and permission gates run before any text read. SPA races, UTF-8 caps, form drafts, no page writes. Pause, revoke, tab switch or window blur stop further reads (the background sends `cancel`; the page also cancels on blur) | `content.test.mjs`, `background.test.mjs` (jsdom + fake `chrome`) | No |
| Framing, 64 KiB cap, origin check, 100 acks, reconnect, cleanup | `bridge/*.test.mjs`, `echo-test.mjs` | No |
| Selectors on live public GitHub | read-only probe in public tabs | Yes, no extension |
| Native hello through a real Chrome origin; echo server killed, then recovered | packaged extension in an isolated Chrome for Testing profile | Yes, headless |
| Capture through the packaged extension on real issues | manual, see below | Yes, needs a click |

## Manual gate (needs one person)

Chrome only grants GitHub access after a click and a permission prompt, so the
full capture check needs Hunter. Use a throwaway profile, not the real one:

1. `npm run spike:capture:prepare -- --out <dir> --isolated-profile <profile dir>`
2. Start the echo server with the printed `--runtime-dir`.
3. Launch Chrome for Testing (Playwright's cached build) with
   `--user-data-dir=<profile dir> --disable-extensions-except=<dir>/extension --load-extension=<dir>/extension`.
   Branded Google Chrome 137+ ignores `--load-extension`.
4. Open `chrome-extension://<id>/popup.html`. Check that Bridge shows
   `connected`, then click **Grant GitHub** and accept the prompt.
5. In a normal tab, go from `github.com/stripe/stripe-node` to Issues, open an
   issue, then follow a link to a second issue. Don't reload. Each issue should
   show a forwarded, acked capture with title and body lengths.
6. Go back to the issue list. No new capture should appear.
7. Kill the echo server. Bridge should show disconnected. Restart it. Bridge
   should reconnect, and the open issue should be captured again without a
   reload.

To use the real Chrome instead: load `extension/` from `chrome://extensions`
(Developer mode, then Load unpacked). Then run
`native-host/install-real-chrome.sh`. It copies one manifest into
`~/Library/Application Support/Google/Chrome/NativeMessagingHosts/`.
`uninstall-real-chrome.sh` removes it again.
