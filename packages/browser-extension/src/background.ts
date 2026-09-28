// Service-worker entry (module). Listeners are registered synchronously in
// start() -> install(), as MV3 requires.
// First import: turns off zod's eval probe before any schema is used.
import "./zod-jitless.js";
import { createBackground } from "./background-core.js";

void createBackground(chrome).start();
