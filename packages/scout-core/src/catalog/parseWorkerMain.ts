// Worker-thread entrypoint for parseWorker.ts: calls the pure catalog parsers on the text it
// is sent and posts the parsed value back. It fetches nothing and keeps nothing between
// messages.

import { parentPort } from "node:worker_threads";
import { parseLlmsTxt } from "./llmsTxt.js";
import { parseSitemap } from "./sitemap.js";

type Request = { id: number; kind: "sitemap"; text: string; origin: string } | { id: number; kind: "llms"; text: string; origin: string; baseUrl: string };

parentPort?.on("message", (req: Request) => {
  try {
    const result = req.kind === "sitemap" ? parseSitemap(req.text, req.origin) : parseLlmsTxt(req.text, req.origin, req.baseUrl);
    parentPort?.postMessage({ id: req.id, ok: true, result });
  } catch {
    parentPort?.postMessage({ id: req.id, ok: false });
  }
});
