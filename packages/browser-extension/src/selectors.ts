// The only place GitHub page selectors and capture limits live.
//
// Verified against public GitHub issue pages on 2026-09-24 (stripe/stripe-node
// #2490, #2468, #2327, #1556) by the Phase 0 spike, and live-verified through
// the packaged spike extension on 2026-09-28. Keep every selector here.

export interface Selector {
  readonly id: string;
  readonly css: string;
}

export const SELECTORS: {
  readonly title: readonly Selector[];
  readonly body: readonly Selector[];
  readonly identity: readonly Selector[];
} = Object.freeze({
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

export interface Limits {
  /** Title cap, in code points. */
  titleChars: number;
  /** Body cap, in UTF-8 bytes. */
  bodyBytes: number;
  /** Title and body must be unchanged this long before they are sent. */
  settleMs: number;
  /** Give up on an issue page after this long. */
  maxWaitMs: number;
  /** Settle loop tick. */
  tickMs: number;
  /** Fallback URL check for SPA navigation. */
  pollMs: number;
}

export const LIMITS: Readonly<Limits> = Object.freeze({
  titleChars: 300,
  bodyBytes: 8 * 1024,
  settleMs: 500,
  maxWaitMs: 5000,
  tickMs: 100,
  pollMs: 1000,
});
