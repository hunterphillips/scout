// Host constants shared by the background and the popup (no imports, so the
// popup bundle stays free of zod).
export const HOST_NAME = "dev.scout.bridge";
export const GITHUB_PATTERN = "https://github.com/*";
/** Must match optional_host_permissions in manifest.json. */
export const OPTIONAL_HOSTS: readonly string[] = Object.freeze([GITHUB_PATTERN, "https://docs.stripe.com/*", "https://www.peakdesign.com/*"]);
