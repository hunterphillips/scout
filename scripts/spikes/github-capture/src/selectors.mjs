// Scout Phase 0 GitHub capture spike: the ONLY place page selectors and
// capture limits live. Shared by the content script and the background.

// Verified against public GitHub issue pages on 2026-09-24 (stripe/stripe-node
// #2490, #2468, #2327, #1556). Keep every selector here.
export const SELECTORS = Object.freeze({
  title: Object.freeze([
    Object.freeze({ id: "title:issue-header/issue-title", css: '[data-testid="issue-header"] [data-testid="issue-title"]' }),
  ]),
  body: Object.freeze([
    Object.freeze({
      id: "body:issue-body/issue-body-viewer/markdown-body",
      css: '[data-testid="issue-body"] [data-testid="issue-body-viewer"] [data-testid="markdown-body"]',
    }),
  ]),
  identity: Object.freeze([
    Object.freeze({ id: "identity:issue-body/issue-body-header-link", css: '[data-testid="issue-body"] [data-testid="issue-body-header-link"]' }),
  ]),
});

export const LIMITS = Object.freeze({
  titleChars: 300,
  bodyBytes: 8 * 1024,
  settleMs: 500,
  maxWaitMs: 5000,
  tickMs: 100,
  pollMs: 1000,
});

export const SELECTOR_IDS = Object.freeze(
  new Set([...SELECTORS.title, ...SELECTORS.body, ...SELECTORS.identity].map((s) => s.id)),
);
