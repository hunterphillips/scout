// Scout Chrome native-messaging host: the process entrypoint.
//
// Chrome runs this (through the ~/.scout/bin/scout-native-host wrapper) as
//   node dist/host.js chrome-extension://<id>/ [--parent-window=...]
// with stdin/stdout as the native-messaging channel. It reads config from
// SCOUT_HOME (default ~/.scout) and hands everything to createHost. Logs go to
// stderr. Import the package root, not this file, for the library surface.

import { realpathSync } from "node:fs";
import { connect as netConnect } from "node:net";
import { fileURLToPath } from "node:url";
import { checkRuntimeDir, coreSocketPath, readExtensionId, scoutHome } from "./config.js";
import { createHost } from "./relay.js";

export function main(): void {
  const home = scoutHome();
  const host = createHost({
    callerOrigin: process.argv[2],
    extensionId: readExtensionId(home),
    socketPath: coreSocketPath(home),
    checkRuntime: (path) => checkRuntimeDir(path),
    connect: (path) => netConnect({ path }),
    stdin: process.stdin,
    stdout: process.stdout,
    timers: {
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: (h) => clearTimeout(h as NodeJS.Timeout),
    },
    exit: (code) => process.exit(code),
    log: (line) => process.stderr.write(`${line}\n`),
  });
  for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"] as const) process.on(sig, () => host.stop(`signal:${sig}`));
}

function isEntrypoint(): boolean {
  try {
    const argv1 = process.argv[1];
    return !!argv1 && realpathSync(argv1) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntrypoint()) main();
