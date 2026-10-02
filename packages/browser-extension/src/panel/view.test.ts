import { JSDOM } from "jsdom";
import { describe, expect, it, vi } from "vitest";
import type { StatusSnapshot } from "../messages.js";
import { PanelModel } from "./model.js";
import { capabilities, F, offer, originSetting, results, state, tracker } from "./test-frames.js";
import { type PanelHandlers, renderPanel, statusRows, type ViewState } from "./view.js";

const STATUS: StatusSnapshot = {
  link: "connected",
  paused: false,
  granted: ["https://docs.example.com/*"],
  githubCapture: false,
  broadGrantIgnored: false,
  policy: { revision: 2, captureEnabled: true, paused: false },
  counters: { focus: 1, forwarded: 0, dropped: 0, acked: 0, denied: 0 },
};

function handlers(): PanelHandlers {
  const h = {} as Record<string, unknown>;
  for (const k of ["select", "open", "allow", "remove", "allowTyped", "showPreview", "restartPreview", "closePreview", "approve", "decline", "revoke", "autoAcquire", "cancelSheet", "grant", "pause", "githubCapture", "reconnect", "refresh", "retry", "dismiss"])
    h[k] = vi.fn();
  return h as unknown as PanelHandlers;
}

function view(model: PanelModel) {
  const dom = new JSDOM(`<!doctype html><body><p id="header-line"></p><div id="root"></div></body>`);
  const doc = dom.window.document;
  const root = doc.getElementById("root")!;
  const on = handlers();
  const v: ViewState = { model, status: STATUS, site: { kind: "ok", origin: F.origin, pattern: `${F.origin}/*`, host: "docs.example.com", tabId: 13, index: 3 }, ui: { ackSheet: null, siteInput: "", siteInputError: null } };
  const render = () => renderPanel(doc, root, v, on);
  render();
  return { doc, root, on, v, render };
}

function running(): PanelModel {
  const m = new PanelModel(tracker("t"));
  m.applyLink("connected");
  m.apply(capabilities({ offers: [offer()], origins: [originSetting()] }));
  m.apply(state("idle", { epoch: 1, detail: "docs.example.com", permitted: true }));
  return m;
}

describe("panel view", () => {
  it("sections in order, Results first and current; the nav comes before the section in Tab order", () => {
    const { root } = view(running());
    const nav = [...root.querySelectorAll("nav button")].map((b) => b.textContent);
    expect(nav).toEqual(["Results", "Sites", "This site", "Settings", "Activity", "Problems"]);
    expect(root.querySelector('[aria-current="page"]')!.textContent).toBe("Results");
    expect(root.firstElementChild!.tagName).toBe("NAV");
    expect(root.querySelector("[tabindex]:not([tabindex='0'])")).toBeNull(); // no positive tabindex anywhere
  });

  it("site text is text: a title or reason with markup is never parsed", () => {
    const m = running();
    m.apply(results(1, { status: "ok", items: [{ candidateId: "c1", title: "<img src=x onerror=alert(1)>", reason: "<b>bold</b>", hostname: "docs.example.com" }] }));
    const { root } = view(m);
    expect(root.querySelector("img")).toBeNull();
    expect(root.querySelector("b")).toBeNull();
    expect(root.textContent).toContain("<img src=x onerror=alert(1)>");
    expect(root.querySelector('[data-key="open-c1"]')!.getAttribute("aria-label")).toBe("Open <img src=x onerror=alert(1)> on docs.example.com");
  });

  it("a re-render keeps the focused control focused and the preview's scroll position", () => {
    const m = running();
    m.apply(results(1, { status: "ok", items: [{ candidateId: "c1", title: "A", reason: "r", hostname: "docs.example.com" }] }));
    const { doc, root, render } = view(m);
    (root.querySelector('[data-key="open-c1"]') as HTMLElement).focus();
    m.apply(F.frame("frame.audit.json"));
    render();
    expect(doc.activeElement?.getAttribute("data-key")).toBe("open-c1");

    m.showPreview({ resourceId: F.rid, version: F.v1 });
    render();
    const pre = root.querySelector<HTMLElement>("pre.preview-text")!;
    pre.scrollTop = 120;
    render();
    expect(root.querySelector<HTMLElement>("pre.preview-text")!.scrollTop).toBe(120);
  });

  it("the header line is updated in place, so its live region is not re-created", () => {
    const m = running();
    const { doc, render } = view(m);
    const header = doc.getElementById("header-line")!;
    expect(header.textContent).toBe("Idle · docs.example.com · 1 offer");
    m.apply(state("working", { epoch: 1, jobId: "job-1" }));
    render();
    expect(doc.getElementById("header-line")).toBe(header);
    expect(header.textContent).toBe("Working · Looking for links…");
  });

  it("Approve is disabled with its reason until the shown preview is complete", () => {
    const m = running();
    m.showPreview({ resourceId: F.rid, version: F.v1 });
    const { root } = view(m);
    const approve = root.querySelector<HTMLButtonElement>('[data-key^="approve-"]')!;
    expect(approve.disabled).toBe(true);
    expect(root.querySelector(`#${approve.getAttribute("aria-describedby")}`)!.textContent).toBe("Preview is still loading.");
  });

  it("status rows: metadata only", () => {
    expect(statusRows(STATUS)).toEqual([
      ["Status", "connected"],
      ["Allowed sites", "docs.example.com"],
      ["Issue text", "off"],
      ["Sent", "focus 1 · issues 0 · acked 0 · dropped 0 · denied 0"],
    ]);
  });

  it("every results state renders its own sentence", () => {
    const m = running();
    const seen = new Set<string>();
    const { root, render } = view(m);
    const grab = () => seen.add(root.querySelector("#results-explanation")!.textContent!);
    grab();
    m.apply(state("working", { epoch: 1, jobId: "job-1" }));
    render();
    grab();
    for (const name of F.names("frame.results.")) {
      const f = F.frame(name);
      if (f.type !== "results") continue;
      m.apply(capabilities({ instance: f.coreInstanceId, offers: [offer()], origins: [originSetting()] }));
      m.apply(state("idle", { epoch: f.visitEpoch, detail: "docs.example.com", permitted: true }));
      m.apply(f);
      render();
      grab();
    }
    m.apply(state("paused"));
    render();
    grab();
    m.apply(state("disconnected"));
    render();
    grab();
    expect(seen.size).toBe(10);
  });

  it("Sites marks the sites with recommendations on, including one Chrome does not grant", () => {
    const m = running();
    m.apply({ type: "grant", agentBrowserContext: false, destinations: ["https://docs.example.com", "https://docs.stripe.com"] });
    m.select("sites");
    const { root } = view(m);
    const row = (host: string) => [...root.querySelectorAll("ul.sites li")].find((li) => li.querySelector(".site-host")!.textContent === host)!;
    expect(row("docs.example.com").querySelector(".site-state")!.textContent).toBe("Allowed · Recommendations on");
    expect(row("docs.stripe.com").querySelector(".site-state")!.textContent).toBe("Not allowed · Recommendations on");
    expect(row("docs.stripe.com").querySelector('[data-key="allow-docs.stripe.com"]')).not.toBeNull();
    expect(root.textContent).toContain("To turn recommendations on for a site, add it to destinations in Scout's config.json.");
    expect(root.textContent).not.toContain("Recommendations run only");
  });
});
