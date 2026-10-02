// The legacy rank client's send hook (rankClient.ts, kept until pivot Phase 4 retires it).
// Accepted page text now goes to the activity store (activity/store.ts), not a forwarder.

import type { PageTextObservation } from "@scout/contracts";

/**
 * Sends one observation to the personal-context service's `observe_activity`. Resolves
 * when the service acknowledges it; rejects when the send fails.
 */
export type ActivitySend = (obs: PageTextObservation) => Promise<void>;
