// Service-worker entry (module). Listeners are registered synchronously in
// start() -> install(), as MV3 requires.
import { createBackground } from "./background-core.js";

void createBackground(chrome).start();
