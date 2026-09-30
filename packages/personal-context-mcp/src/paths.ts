// Path helpers shared by config.ts and launchProfile.ts.

import { sep } from "node:path";

/**
 * Whether `child` is `parent` or lies below it. Both must already be absolute and
 * normalized (resolved, or realpath'd for physical containment). Purely lexical.
 */
export function isInside(child: string, parent: string): boolean {
  return child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep);
}
