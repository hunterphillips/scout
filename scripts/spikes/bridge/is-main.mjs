// True when the module at `url` is the process entrypoint (paths may contain spaces).
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

export function isMain(url) {
  try {
    return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(url));
  } catch {
    return false;
  }
}
