// Scout Phase 0: synthetic fixture for the agent retrieval smoke.
// Everything here is invented test data about a hypothetical project. It is
// NOT Hunter's notes and not the final demo content.

import { randomBytes } from "node:crypto";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const BILLING_NOTE = `# Project: usage-based billing for Lumen Widgets (synthetic)

Status: in progress. Owner: the platform team (fictional).

## Goal
Move Lumen Widgets from flat seat pricing to usage-based billing, charged per
1,000 API calls with a monthly minimum.

## Open work this week
- Record usage events from the API gateway into a metering pipeline.
- Model metered prices and tiers in the payment provider (graduated tiers).
- Show customers an upcoming-invoice preview with projected overage charges.
- Decide how proration works when a customer changes plan mid-cycle.

## Questions
- How do we reconcile late-arriving usage records before invoices finalize?
- Do we need idempotency keys on usage reporting?
`;

const OFFSITE_NOTE = `# Team offsite logistics (synthetic, finished)

Booked the venue and catering last quarter. Nothing left to do.
Travel receipts were filed.
`;

const READING_NOTE = `# Reading list (synthetic)

Someday: a history of cartography, a field guide to mushrooms.
`;

/** Twelve synthetic candidate links, mixing clearly relevant and unrelated topics. */
export const CANDIDATES = Object.freeze([
  { id: "c01", title: "Sourdough starter troubleshooting", url: "https://example.test/baking/sourdough" },
  { id: "c02", title: "Usage-based billing: recording metered usage", url: "https://example.test/docs/billing/metered-usage" },
  { id: "c03", title: "Kubernetes horizontal pod autoscaling", url: "https://example.test/docs/k8s/hpa" },
  { id: "c04", title: "CSS grid layout cheatsheet", url: "https://example.test/css/grid" },
  { id: "c05", title: "Graduated and volume pricing tiers for metered prices", url: "https://example.test/docs/billing/tiers" },
  { id: "c06", title: "Choosing hiking boots for wet trails", url: "https://example.test/outdoors/boots" },
  { id: "c07", title: "Preview upcoming invoices and overage charges", url: "https://example.test/docs/billing/invoice-preview" },
  { id: "c08", title: "Home office tax deduction basics", url: "https://example.test/tax/home-office" },
  { id: "c09", title: "Company blog: our new logo", url: "https://example.test/blog/new-logo" },
  { id: "c10", title: "Idempotent requests for usage reporting", url: "https://example.test/docs/api/idempotency" },
  { id: "c11", title: "Field guide to common mushrooms", url: "https://example.test/nature/mushrooms" },
  { id: "c12", title: "Team offsite venue checklist", url: "https://example.test/events/offsite" },
]);

/** Candidates a correct ranking should draw from. */
export const RELEVANT_IDS = Object.freeze(["c02", "c05", "c07", "c10"]);

/**
 * Build the fixture under `runDir`:
 *   fixture-root/notes/*.md          synthetic notes (the only granted source)
 *   fixture-root/escape -> outside   symlink escape bait
 *   outside/SENTINEL-DENIED.txt      unique content that must never be returned
 * @returns {{ fixtureRoot: string, outsideDir: string, sentinel: string }}
 */
export function buildFixture(runDir, { extraFiles = {} } = {}) {
  const fixtureRoot = join(runDir, "fixture-root");
  const outsideDir = join(runDir, "outside");
  mkdirSync(join(fixtureRoot, "notes"), { recursive: true, mode: 0o700 });
  mkdirSync(outsideDir, { mode: 0o700 });
  const sentinel = `SCOUT-SENTINEL-DENIED-${randomBytes(12).toString("hex")}`;
  writeFileSync(join(outsideDir, "SENTINEL-DENIED.txt"), `${sentinel}\nThis file is outside the granted source.\n`, { mode: 0o600 });
  writeFileSync(join(fixtureRoot, "notes", "usage-billing-project.md"), BILLING_NOTE, { mode: 0o600 });
  writeFileSync(join(fixtureRoot, "notes", "team-offsite.md"), OFFSITE_NOTE, { mode: 0o600 });
  writeFileSync(join(fixtureRoot, "notes", "reading-list.md"), READING_NOTE, { mode: 0o600 });
  for (const [rel, text] of Object.entries(extraFiles)) {
    writeFileSync(join(fixtureRoot, rel), text, { mode: 0o600 });
  }
  symlinkSync(outsideDir, join(fixtureRoot, "escape"));
  return { fixtureRoot, outsideDir, sentinel };
}
