// The only place the capture limits live.

export interface Limits {
  /** Title cap, in code points. */
  titleChars: number;
  /** Body cap, in UTF-8 bytes. */
  bodyBytes: number;
  /** Title and body must be unchanged this long before the dwell starts. */
  settleMs: number;
  /** Give up on a page that has not settled after this long. */
  maxWaitMs: number;
  /** Settle loop tick. */
  tickMs: number;
  /** Fallback URL check for SPA navigation. */
  pollMs: number;
  /** After settling, the page must stay visible this long before it is sent. */
  dwellMs: number;
}

export const LIMITS: Readonly<Limits> = Object.freeze({
  titleChars: 300,
  bodyBytes: 8 * 1024,
  settleMs: 500,
  maxWaitMs: 5000,
  tickMs: 100,
  pollMs: 1000,
  dwellMs: 3000,
});
