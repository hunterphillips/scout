// Library surface. The Chrome entrypoint is dist/host.js; importing this module never runs it.
export {
  CORE_WRITE_HIGH_WATER_BYTES,
  type CoreSocket,
  createHost,
  EXIT_CORE_UNAVAILABLE,
  EXIT_FLUSH_TIMEOUT_MS,
  EXIT_OK,
  EXIT_REFUSED,
  expectedOrigin,
  type Host,
  type HostDeps,
  type HostDrops,
  type HostTimers,
  RETRY_INTERVAL_MS,
  RETRY_WINDOW_MS,
} from "./relay.js";
export {
  checkRuntimeDir,
  coreSocketPath,
  readExtensionId,
  type RuntimeCheck,
  type RuntimeRefusal,
  scoutHome,
} from "./config.js";
