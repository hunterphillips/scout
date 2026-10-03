import { JSDOM } from "jsdom";
import { describe, expect, it, vi } from "vitest";
import type { StatusSnapshot } from "../messages.js";
import { PanelModel } from "./model.js";
import { capabilities, entry, F, offer, originSetting, results, state, tracker } from "./test-frames.js";
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
  for (const k of ["select", "open", "allow", "remove", "allowTyped", "showPreview", "restartPreview", "closePreview", "approve", "decline", "revoke", "autoAcquire", "cancelSheet", "grant", "destination", "pause", "githubCapture", "reconnect", "refresh", "retry", "dismiss"])
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
    for (const link of ["disconnected", "core_unavailable", "upgrade_required", "connecting"] as const) {
      m.applyLink(link);
      render();
      grab();
    }
    expect(seen.size).toBe(14);
  });

  it("Results says Scout can't be reached (or is connecting) while the link isn't up, and goes back to the results state on reconnect", () => {
    const m = running();
    m.apply(results(1, { status: "empty" }));
    const { root, render } = view(m);
    const explanation = () => root.querySelector("#results-explanation")!;
    expect(explanation().className).toBe("state state-empty");
    for (const [link, words, kind] of [
      ["core_unavailable", "Scout isn't running.", "link_down"],
      ["disconnected", "native host isn't reachable", "link_down"],
      ["connecting", "Connecting to Scout…", "connecting"],
    ] as const) {
      m.applyLink(link);
      render();
      expect(explanation().className).toBe(`state state-${kind}`);
      expect(explanation().textContent).toContain(words);
      expect(explanation().textContent).not.toContain("No links for this page yet");
      m.applyLink("connected");
      render();
      expect(explanation().className).toBe("state state-none");
      expect(explanation().textContent).toContain("No links for this page yet");
      m.apply(capabilities({ offers: [offer()], origins: [originSetting()] }));
      m.apply(state("idle", { epoch: 1, detail: "docs.example.com", permitted: true }));
      m.apply(results(1, { status: "empty" }));
      render();
      expect(explanation().className).toBe("state state-empty");
    }
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
    expect(root.textContent).toContain("Turn on suggestions from This site.");
    expect(root.textContent).not.toContain("config.json");
    expect(root.textContent).not.toContain("Recommendations run only");
  });

  // P4.6: the per-site recommendations switch.
  it("This site has a 'Suggest links from this site' switch, off by default, keyed by the full origin; a click sends set_destination", () => {
    const m = running();
    m.apply({ type: "grant", agentBrowserContext: false, destinations: [] });
    m.select("site");
    const { root, on, render } = view(m);
    const box = () => root.querySelector<HTMLInputElement>('[data-key="destination-https://docs.example.com"]')!;
    expect(box()).not.toBeNull();
    expect(box().type).toBe("checkbox");
    expect(box().checked).toBe(false);
    expect(box().disabled).toBe(false);
    expect(root.querySelector('label[for="destination-https://docs.example.com"]')!.textContent).toContain("Suggest links from this site");
    expect(root.textContent).toContain("Each visit runs a short job on your Claude subscription.");
    box().click();
    expect(on.destination).toHaveBeenCalledWith("https://docs.example.com", true);
    // The core's grant frame turns it on.
    m.apply({ type: "grant", agentBrowserContext: false, destinations: ["https://docs.example.com"] });
    render();
    expect(box().checked).toBe(true);
  });

  it("the switch is disabled with 'Allow this site first.' when Chrome doesn't allow the site; one already on can still be turned off", () => {
    const m = running();
    m.apply({ type: "grant", agentBrowserContext: false, destinations: [] });
    m.select("site");
    const { root, v, render } = view(m);
    v.status = { ...STATUS, granted: [] };
    render();
    const box = () => root.querySelector<HTMLInputElement>('[data-key="destination-https://docs.example.com"]')!;
    expect(box().disabled).toBe(true);
    expect(root.textContent).toContain("Allow this site first.");
    m.apply({ type: "grant", agentBrowserContext: false, destinations: ["https://docs.example.com"] });
    render();
    expect(box().checked).toBe(true);
    expect(box().disabled).toBe(false);
    expect(root.textContent).not.toContain("Allow this site first.");
  });

  it("the switch waits for the core while its command is pending, and is disabled without a core", () => {
    const m = running();
    m.apply({ type: "grant", agentBrowserContext: false, destinations: [] });
    m.select("site");
    expect(m.setDestination("https://docs.example.com", true)).not.toBeNull();
    const { root, render } = view(m);
    const box = () => root.querySelector<HTMLInputElement>('[data-key="destination-https://docs.example.com"]')!;
    expect(box().disabled).toBe(true);
    expect(box().checked).toBe(false);
    expect(root.textContent).toContain("Waiting for Scout core…");
    m.applyLink("core_unavailable");
    render();
    expect(box().disabled).toBe(true);
  });

  // P4.4: one delegated listener per event type on the root, and a keyed patch.
  it("a re-render between mousedown and mouseup keeps the pressed button, so the click lands", () => {
    const m = running();
    m.apply(results(1, { status: "ok", items: [{ candidateId: "c1", title: "A", reason: "r", hostname: "docs.example.com" }] }));
    const { doc, root, on, render } = view(m);
    const pressed = root.querySelector<HTMLButtonElement>('[data-key="open-c1"]')!;
    pressed.dispatchEvent(new doc.defaultView!.MouseEvent("mousedown", { bubbles: true }));
    // A frame arrives mid-click and changes the panel around the button.
    m.apply(results(1, { status: "ok", items: [{ candidateId: "c1", title: "A", reason: "r", hostname: "docs.example.com" }, { candidateId: "c2", title: "B", reason: "r2", hostname: "docs.example.com" }] }));
    render();
    expect(root.querySelector('[data-key="open-c2"]')).not.toBeNull();
    expect(root.querySelector('[data-key="open-c1"]')).toBe(pressed);
    pressed.dispatchEvent(new doc.defaultView!.MouseEvent("mouseup", { bubbles: true }));
    pressed.click();
    expect(on.open).toHaveBeenCalledWith("c1");
  });

  it("a render keeps every unchanged element and updates changed text in place", () => {
    const m = running();
    m.apply(results(1, { status: "ok", items: [{ candidateId: "c1", title: "A", reason: "first", hostname: "docs.example.com" }] }));
    const { root, render } = view(m);
    const nav = root.querySelector("nav")!;
    const results0 = root.querySelector("#nav-results, [data-key='nav-results']")!;
    const reason = root.querySelector("p.reason")!;
    m.apply(results(1, { status: "ok", items: [{ candidateId: "c1", title: "A", reason: "second", hostname: "docs.example.com" }] }));
    render();
    expect(root.querySelector("nav")).toBe(nav);
    expect(root.querySelector("[data-key='nav-results']")).toBe(results0);
    expect(root.querySelector("p.reason")).toBe(reason);
    expect(reason.textContent).toBe("second");
  });

  it("no rendered node carries its own listener: clicks dispatch from the root to the latest render's handlers", () => {
    const m = running();
    const first = view(m);
    const next = handlers();
    renderPanel(first.doc, first.root, first.v, next);
    first.root.querySelector<HTMLButtonElement>('[data-key="nav-sites"]')!.click();
    expect(next.select).toHaveBeenCalledWith("sites");
    expect(first.on.select).not.toHaveBeenCalled();
    // A button moved out of the root no longer reaches any handler.
    const b = first.root.querySelector<HTMLButtonElement>('[data-key="nav-settings"]')!;
    first.doc.body.append(b);
    b.click();
    expect(next.select).toHaveBeenCalledTimes(1);
  });

  it("a checkbox the user flipped shows the model's value again after a render; the typed site and its caret are kept", () => {
    const m = running();
    m.select("site");
    const { doc, root, on, render, v } = view(m);
    const box = root.querySelector<HTMLInputElement>("#auto-acquire")!;
    expect(box.disabled).toBe(false);
    const before = box.checked;
    box.click();
    expect(on.autoAcquire).toHaveBeenCalledWith(F.origin, !before, false);
    render();
    expect(root.querySelector("#auto-acquire")).toBe(box);
    expect(box.checked).toBe(before);

    m.select("sites");
    render();
    const input = root.querySelector<HTMLInputElement>("#site-input")!;
    input.focus();
    input.value = "docs.stri";
    input.dispatchEvent(new doc.defaultView!.Event("input", { bubbles: true }));
    expect(v.ui.siteInput).toBe("docs.stri");
    input.setSelectionRange(4, 4);
    render();
    expect(root.querySelector("#site-input")).toBe(input);
    expect(doc.activeElement).toBe(input);
    expect(input.value).toBe("docs.stri");
    expect(input.selectionStart).toBe(4);
    root.querySelector("form")!.dispatchEvent(new doc.defaultView!.Event("submit", { bubbles: true, cancelable: true }));
    expect(on.allowTyped).toHaveBeenCalledWith("docs.stri");
  });

  it("data-keys (also the click dispatch keys) never collide: an offer and its library re-approve, resources sharing a prefix", () => {
    const twin = `res_${F.rid.slice(4, 16)}${"f".repeat(52)}`;
    const m = new PanelModel(tracker("t"));
    m.applyLink("connected");
    m.apply(
      capabilities({
        offers: [offer()],
        library: [entry({ state: "blocked", defaultVersion: null, versions: [[F.v1, "revoked"]] }), entry({ rid: twin })],
        origins: [originSetting()],
      }),
    );
    m.apply(state("idle", { epoch: 1, detail: "docs.example.com", permitted: true }));
    m.select("site");
    const { root, on } = view(m);
    const keys = [...root.querySelectorAll("[data-key]")].map((e) => e.getAttribute("data-key")!);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toContain(`preview-${F.rid}-${F.v1}`);
    expect(keys).toContain(`library-preview-${F.rid}-${F.v1}`);
    root.querySelector<HTMLButtonElement>(`[data-key="library-preview-${F.rid}-${F.v1}"]`)!.click();
    expect(on.showPreview).toHaveBeenCalledWith({ resourceId: F.rid, version: F.v1 });
    expect(root.querySelector(`[data-key="revoke-${twin}"]`)).not.toBeNull();
  });

  it("a focused text box moved by the patch gets its focus and whole selection back (start, end, direction)", () => {
    const m = new PanelModel(tracker("t"));
    m.applyLink("connected");
    m.apply(capabilities({ offers: [], origins: [] }));
    m.select("sites");
    const { doc, root, render, v } = view(m);
    v.status = { ...STATUS, granted: [] };
    render();
    expect(root.textContent).toContain("No sites yet.");
    const input = root.querySelector<HTMLInputElement>("#site-input")!;
    input.focus();
    input.value = "docs.example";
    v.ui.siteInput = "docs.example";
    input.setSelectionRange(2, 7, "backward");
    // The "No sites yet" line above the box goes away: the patch moves the box's form forward with insertBefore.
    m.apply(capabilities({ revision: 2, offers: [], origins: [originSetting(), originSetting("https://a.example")] }));
    render();
    expect(root.textContent).not.toContain("No sites yet.");
    expect(root.querySelector("#site-input")).toBe(input);
    expect(doc.activeElement).toBe(input);
    expect([input.selectionStart, input.selectionEnd, input.selectionDirection]).toEqual([2, 7, "backward"]);
  });
});
