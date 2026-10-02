// Side panel page entry (module). The logic is panel-app.ts and panel/*.ts.
import { createPanelApp } from "./panel-app.js";

void createPanelApp({ ch: chrome, doc: document, root: document.getElementById("root")! }).start();
