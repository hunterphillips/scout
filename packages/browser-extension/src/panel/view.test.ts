import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { describe, expect, it, vi } from "vitest";
import type { StatusSnapshot } from "../messages.js";
import { PanelModel } from "./model.js";
import { ackFailed, ackOk, AGENTS, capabilities, entry, F, offer, originSetting, results, state, tracker } from "./test-frames.js";
import { type PanelHandlers, renderPanel, reviewTitle, sentText, siteName, statusRows, type ViewState } from "./view.js";

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
  for (const k of ["select", "open", "allow", "remove", "allowTyped", "showPreview", "restartPreview", "closePreview", "approve", "decline", "revoke", "autoAcquire", "cancelSheet", "grant", "destination", "agent", "pause", "githubCapture", "reconnect", "refresh", "retry", "dismiss"])
    h[k] = vi.fn();
  return h as unknown as PanelHandlers;
}

function view(model: PanelModel) {
  const dom = new JSDOM(`<!doctype html><body><div id="root"></div></body>`);
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
  it("sections in order, Page first and current; the nav comes after the view in Tab order", () => {
    const { root } = view(running());
    const nav = [...root.querySelectorAll("nav button")].map((b) => b.getAttribute("aria-label"));
    expect(nav).toEqual(["Page", "Sites", "Activity", "Settings"]);
    expect(root.querySelector('[aria-current="page"]')!.getAttribute("aria-label")).toBe("Page");
    expect(root.lastElementChild!.tagName).toBe("NAV");
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

  it("the results heading is updated in place, so its live region is not re-created", () => {
    const m = running();
    const { root, render } = view(m);
    const heading = root.querySelector("#results-heading")!;
    expect(heading.getAttribute("aria-live")).toBe("polite");
    expect(heading.textContent).toBe("Nothing yet");
    m.apply(state("working", { epoch: 1, jobId: "job-1" }));
    render();
    expect(root.querySelector("#results-heading")).toBe(heading);
    expect(heading.textContent).toBe("Looking for links…");
  });

  it("Settings' Diagnostics opens on a 'Now' row with the status, host and offer count", () => {
    const m = running();
    m.select("settings");
    const { root, render } = view(m);
    const now = () => {
      const dt = [...root.querySelectorAll("details.diagnostics dt")].find((e) => e.textContent === "Now")!;
      return dt.nextElementSibling!.textContent;
    };
    expect(now()).toBe("Idle · docs.example.com · 1 offer");
    m.apply(state("working", { epoch: 1, jobId: "job-1" }));
    render();
    expect(now()).toBe("Working · Looking for links…");
  });

  it("Settings has an Agent row: one button per agent the core found, the current one pressed, no other text", () => {
    const m = running();
    m.apply(capabilities({ revision: 2, origins: [originSetting()], agents: { available: [{ id: "claude-code", label: "Claude Code" }, { id: "codex", label: "Codex" }], current: "claude-code" } }));
    m.select("settings");
    const { root, on } = view(m);
    const card = root.querySelector('[data-key="agent-card"]')!;
    expect(card.textContent).toBe("AgentClaude CodeCodex");
    const buttons = [...card.querySelectorAll<HTMLButtonElement>("button")];
    expect(buttons.map((b) => [b.textContent, b.getAttribute("aria-pressed"), b.disabled])).toEqual([
      ["Claude Code", "true", false],
      ["Codex", "false", false],
    ]);
    expect(card.querySelector('[role="group"]')!.getAttribute("aria-labelledby")).toBe("agent-label");
    expect(root.querySelector("#agent-label")!.textContent).toBe("Agent");
    buttons[1]!.click();
    expect(on.agent).toHaveBeenCalledWith("codex");
  });

  it("an agent whose executable the core did not find has no button; with none found, or from an older core, there is no Agent row", () => {
    const m = running();
    m.select("settings");
    const { root, render } = view(m);
    expect(root.querySelector('[data-key="agent-card"]')).toBeNull(); // the frame carries no agents
    m.apply(capabilities({ revision: 2, agents: { available: [{ id: "codex", label: "Codex" }], current: "codex" } }));
    render();
    expect([...root.querySelectorAll('[data-key="agent-card"] button')].map((b) => b.textContent)).toEqual(["Codex"]);
    m.apply(capabilities({ revision: 3, agents: { available: [] } }));
    render();
    expect(root.querySelector('[data-key="agent-card"]')).toBeNull();
  });

  it("choosing an agent presses it at once and disables the row until the core answers; a refusal puts the current one back", () => {
    const m = running();
    m.apply(capabilities({ revision: 2, agents: AGENTS }));
    m.select("settings");
    const { root, render } = view(m);
    const pressed = () => [...root.querySelectorAll<HTMLButtonElement>('[data-key="agent-card"] button')].map((b) => [b.textContent, b.getAttribute("aria-pressed"), b.disabled]);
    const c = m.setAgent("agent-b")!;
    render();
    expect(pressed()).toEqual([
      ["Agent A", "false", true],
      ["Agent B", "true", true],
    ]);
    m.apply(ackFailed(c.commandId, "not_found"));
    render();
    expect(pressed()).toEqual([
      ["Agent A", "true", false],
      ["Agent B", "false", false],
    ]);
    expect(m.problems.some((p) => p.kind === "command" && p.record.id === c.commandId)).toBe(true);
    const ok = m.setAgent("agent-b")!;
    m.apply(ackOk(ok.commandId));
    render();
    expect(pressed()).toEqual([
      ["Agent A", "false", false],
      ["Agent B", "true", false],
    ]);
    m.applyLink("core_unavailable");
    render();
    expect(root.querySelector('[data-key="agent-card"]')).toBeNull();
  });

  it("a failed agent choice reads 'Agent failed' in Activity's Problems", () => {
    const m = running();
    m.apply(capabilities({ revision: 2, agents: AGENTS }));
    const c = m.setAgent("agent-b")!;
    m.apply(ackFailed(c.commandId, "store_error"));
    m.select("activity");
    const { root } = view(m);
    expect(root.querySelector(".problems")!.textContent).toContain("Agent failed: Scout couldn't save it.");
    expect(root.querySelector(`[data-key="problem-retry-${c.commandId}"]`)).toBeNull();
  });

  it("Approve is disabled with its reason until the shown preview is complete", () => {
    const m = running();
    m.showPreview({ resourceId: F.rid, version: F.v1 });
    const { root } = view(m);
    const approve = root.querySelector<HTMLButtonElement>('[data-key^="approve-"]')!;
    expect(approve.disabled).toBe(true);
    expect(root.querySelector(`#${approve.getAttribute("aria-describedby")}`)!.textContent).toBe("Preview is still loading.");
  });

  it("status rows and the Sent to Scout row: metadata only", () => {
    expect(statusRows(STATUS)).toEqual([
      ["Status", "connected"],
      ["Allowed sites", "docs.example.com"],
      ["Issue text", "off"],
    ]);
    expect(sentText(STATUS)).toBe("tab updates 1 · issues 0 · received 0 · dropped 0 · blocked 0");
  });

  it("names a site by its host, for any host", () => {
    expect(["www.backblaze.com", "developers.cloudflare.com", "github.com", "bbc.co.uk"].map(siteName)).toEqual(["backblaze.com", "developers.cloudflare.com", "github.com", "bbc.co.uk"]);
    expect(reviewTitle("agents_md", "www.backblaze.com")).toBe("backblaze.com wrote a guide for your agent");
    expect(reviewTitle("skill", "github.com")).toBe("github.com made a skill for your agent");
  });

  it("Settings' Diagnostics ends with the Sent to Scout row, and no other view shows it", () => {
    const m = running();
    const { root, render } = view(m);
    expect(root.querySelector("#sent-line")).toBeNull();
    m.select("activity");
    render();
    expect(root.querySelector("#sent-line")).toBeNull();
    m.select("settings");
    render();
    const sent = root.querySelector("details.diagnostics dl.status #sent-line")!;
    expect(sent.textContent).toBe(sentText(STATUS));
    expect(sent.previousElementSibling!.textContent).toBe("Sent to Scout");
    expect(sent.nextElementSibling).toBeNull();
  });

  // P4.7: the Quiet layout.
  it("the nav has four items; the current one carries aria-current and its label, and Activity shows a dot while there are problems", () => {
    const m = running();
    const { root, render } = view(m);
    const items = () => [...root.querySelectorAll<HTMLButtonElement>("nav.nav button")];
    expect(items().map((b) => b.getAttribute("data-key"))).toEqual(["nav-page", "nav-sites", "nav-activity", "nav-settings"]);
    expect(items().filter((b) => b.hasAttribute("aria-current")).map((b) => b.getAttribute("data-key"))).toEqual(["nav-page"]);
    expect(items().map((b) => b.textContent)).toEqual(["Page", "", "", ""]);
    const activity = () => root.querySelector<HTMLButtonElement>('[data-key="nav-activity"]')!;
    expect(activity().querySelector(".nav-dot")).toBeNull();
    expect(activity().getAttribute("aria-label")).toBe("Activity");

    m.applyLink("core_unavailable");
    m.select("sites");
    render();
    expect(items().filter((b) => b.hasAttribute("aria-current")).map((b) => b.getAttribute("data-key"))).toEqual(["nav-sites"]);
    expect(root.querySelector('[data-key="nav-sites"]')!.textContent).toBe("Sites");
    expect(activity().querySelector(".nav-dot")!.getAttribute("aria-hidden")).toBe("true");
    expect(activity().getAttribute("aria-label")).toBe("Activity, 1 problem");

    m.applyLink("connected");
    render();
    expect(activity().querySelector(".nav-dot")).toBeNull();
    expect(activity().getAttribute("aria-label")).toBe("Activity");
  });

  it("the review card counts the site's files ('1 of N') and Next shows the following one", () => {
    const m = running();
    m.apply(capabilities({ revision: 2, offers: [offer(), offer({ rid: F.rid2, version: F.v2 })], origins: [originSetting()] }));
    const { root, on, render } = view(m);
    const pill = root.querySelector<HTMLButtonElement>('[data-key="review-open"]')!;
    expect(pill.textContent).toContain("docs.example.com has 2 files for your agent · Review");
    expect(pill.getAttribute("aria-expanded")).toBe("false");
    pill.click();
    expect(on.showPreview).toHaveBeenCalledWith({ resourceId: F.rid, version: F.v1 });

    m.showPreview({ resourceId: F.rid, version: F.v1 });
    render();
    expect(root.querySelector('[data-key="review-open"]')).toBeNull();
    expect(root.querySelector("#preview-pane .review-foot")!.textContent).toContain("1 of 2");
    const next = root.querySelector<HTMLButtonElement>('[data-key="review-next"]')!;
    expect(next.getAttribute("aria-label")).toBe("Next file, 2 of 2");
    next.click();
    expect(on.showPreview).toHaveBeenLastCalledWith({ resourceId: F.rid2, version: F.v2 });

    m.showPreview({ resourceId: F.rid2, version: F.v2 });
    render();
    expect(root.querySelector("#preview-pane .review-foot")!.textContent).toContain("2 of 2");
    expect(root.querySelector('[data-key="review-next"]')!.getAttribute("aria-label")).toBe("Next file, 1 of 2");
    root.querySelector<HTMLButtonElement>('[data-key="review-next"]')!.click();
    expect(on.showPreview).toHaveBeenLastCalledWith({ resourceId: F.rid, version: F.v1 });
  });

  it("a single file's review card has no count and no Next", () => {
    const m = running();
    m.showPreview({ resourceId: F.rid, version: F.v1 });
    const { root } = view(m);
    expect(root.querySelector("#preview-pane")).not.toBeNull();
    expect(root.querySelector(".review-foot")).toBeNull();
    expect(root.querySelector('[data-key="review-next"]')).toBeNull();
  });

  it("the review card's buttons read 'Not now', then 'Approve'; a file that can't be declined shows only Approve", () => {
    const m = running();
    m.showPreview({ resourceId: F.rid, version: F.v1 });
    const { root, on } = view(m);
    const actions = () => [...root.querySelectorAll("#preview-pane .review-actions button")].map((b) => b.textContent);
    expect(actions()).toEqual(["Not now", "Approve"]);
    root.querySelector<HTMLButtonElement>(`[data-key="decline-${F.rid}-${F.v1}"]`)!.click();
    expect(on.decline).toHaveBeenCalledWith({ resourceId: F.rid, version: F.v1 });

    // A revoked library version the site no longer offers can be approved again, never declined.
    const m2 = new PanelModel(tracker("t"));
    m2.applyLink("connected");
    m2.apply(capabilities({ library: [entry({ state: "blocked", defaultVersion: null, versions: [[F.v1, "revoked"]] })], origins: [originSetting()] }));
    m2.apply(state("idle", { epoch: 1, detail: "docs.example.com", permitted: true }));
    m2.showPreview({ resourceId: F.rid, version: F.v1 });
    expect(m2.canDecline({ resourceId: F.rid, version: F.v1 })).toBe(false);
    const second = view(m2);
    expect([...second.root.querySelectorAll("#preview-pane .review-actions button")].map((b) => b.textContent)).toEqual(["Approve"]);
  });

  it("the context chip shows only while the agent grant is on, GitHub issue text is on, and an issue has been sent", () => {
    const m = running();
    m.apply({ type: "grant", agentBrowserContext: true, destinations: [] });
    const { root, v, render } = view(m);
    const chip = () => root.querySelector(".tray .chip");
    const on = { ...STATUS, githubCapture: true, counters: { ...STATUS.counters, forwarded: 1 } };
    v.status = on;
    render();
    expect(chip()!.textContent).toBe("Using your recent GitHub activity");

    v.status = { ...on, githubCapture: false };
    render();
    expect(chip()).toBeNull();
    v.status = { ...on, counters: { ...on.counters, forwarded: 0 } };
    render();
    expect(chip()).toBeNull();
    v.status = on;
    m.apply({ type: "grant", agentBrowserContext: false, destinations: [] });
    render();
    expect(chip()).toBeNull();
    m.apply({ type: "grant", agentBrowserContext: true, destinations: [] });
    render();
    expect(chip()).not.toBeNull();
    // The review card takes the tray's attention: the chip steps aside while it is open.
    m.showPreview({ resourceId: F.rid, version: F.v1 });
    render();
    expect(chip()).toBeNull();
  });

  it("the Diagnostics disclosure the user opened stays open (and is the same node) across renders", () => {
    const m = running();
    m.select("settings");
    const { root, render } = view(m);
    const details = root.querySelector<HTMLDetailsElement>("details.diagnostics")!;
    expect(details.open).toBe(false);
    details.open = true;
    m.apply(state("working", { epoch: 1, jobId: "job-1" }));
    render();
    expect(root.querySelector("details.diagnostics")).toBe(details);
    expect(details.open).toBe(true);
    details.open = false;
    render();
    expect(details.open).toBe(false);
  });

  it("the mark's dot pulses while Scout is looking for links, in every view", () => {
    const m = running();
    const { root, render } = view(m);
    const mark = () => root.querySelector("header .mark")!;
    expect(mark().classList.contains("working")).toBe(false);
    m.apply(state("working", { epoch: 1, jobId: "job-1" }));
    render();
    expect(mark().classList.contains("working")).toBe(true);
    for (const section of ["sites", "activity", "settings"] as const) {
      m.select(section);
      render();
      expect(mark().classList.contains("working")).toBe(true);
    }
    m.apply(results(1, { status: "empty" }));
    render();
    expect(mark().classList.contains("working")).toBe(false);
  });

  it("panel.html animates only the working mark's dot, and prefers-reduced-motion turns every animation off", () => {
    const css = readFileSync(new URL("../panel.html", import.meta.url), "utf8");
    expect(css).toMatch(/\.mark\.working \.mark-dot \{[^}]*animation: pulse/);
    const reduced = css.slice(css.indexOf("@media (prefers-reduced-motion: reduce)"));
    expect(reduced).toMatch(/^@media \(prefers-reduced-motion: reduce\) \{\s*\*, \*::before, \*::after \{ animation: none !important;/);
  });

  it("every results state renders its own sentence and its own heading", () => {
    const m = running();
    const seen = new Set<string>();
    const headings = new Set<string>();
    const { root, render } = view(m);
    const grab = () => {
      seen.add(root.querySelector("#results-explanation")!.textContent!);
      headings.add(root.querySelector("#results-heading")!.textContent!);
    };
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
    expect(headings.size).toBe(14);
  });

  it("Results says Scout can't be reached (or is connecting) while the link isn't up, and goes back to the results state on reconnect", () => {
    const m = running();
    m.apply(results(1, { status: "empty" }));
    const { root, render } = view(m);
    const explanation = () => root.querySelector("#results-explanation")!;
    expect(explanation().className).toBe("state state-empty");
    for (const [link, words, kind] of [
      ["core_unavailable", "Scout isn't running.", "link_down"],
      ["disconnected", "Chrome can't reach Scout", "link_down"],
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
    expect(row("docs.example.com").querySelector(".site-state")!.textContent).toBe("Allowed · Suggestions on");
    expect(row("docs.stripe.com").querySelector(".site-state")!.textContent).toBe("Not allowed · Suggestions on");
    expect(row("docs.stripe.com").querySelector('[data-key="allow-docs.stripe.com"]')).not.toBeNull();
    expect(row("docs.example.com").querySelector('[data-key="remove-docs.example.com"]')).not.toBeNull();
    expect(root.textContent).toContain("Turn on suggestions for a site from the Page view while you're on it.");
    expect(root.textContent).not.toContain("config.json");
    expect(root.textContent).not.toContain("Recommendations run only");
  });

  // P4.6: the per-site recommendations switch.
  it("the Page tray has a 'Suggest on <host>' switch, off by default, keyed by the full origin; a click sends set_destination", () => {
    const m = running();
    m.apply({ type: "grant", agentBrowserContext: false, destinations: [] });
    const { root, on, render } = view(m);
    const box = () => root.querySelector<HTMLInputElement>('[data-key="destination-https://docs.example.com"]')!;
    expect(box()).not.toBeNull();
    expect(box().type).toBe("checkbox");
    expect(box().checked).toBe(false);
    expect(box().disabled).toBe(false);
    expect(root.querySelector('label[for="destination-https://docs.example.com"]')!.textContent).toContain("Suggest on docs.example.com");
    expect(box().closest(".tray")).not.toBeNull();
    expect(root.textContent).toContain("When you stay on a page here, Scout asks your agent for links.");
    box().click();
    expect(on.destination).toHaveBeenCalledWith("https://docs.example.com", true);
    // The core's grant frame turns it on.
    m.apply({ type: "grant", agentBrowserContext: false, destinations: ["https://docs.example.com"] });
    render();
    expect(box().checked).toBe(true);
  });

  it("when Chrome doesn't allow the site the tray offers Allow instead of the switch; one already on can still be turned off", () => {
    const m = running();
    m.apply({ type: "grant", agentBrowserContext: false, destinations: [] });
    const { root, on, v, render } = view(m);
    v.status = { ...STATUS, granted: [] };
    render();
    const box = () => root.querySelector<HTMLInputElement>('[data-key="destination-https://docs.example.com"]');
    expect(box()).toBeNull();
    const allow = root.querySelector<HTMLButtonElement>('.tray [data-key="site-allow"]')!;
    expect(allow.getAttribute("aria-label")).toBe("Allow Scout on docs.example.com");
    expect(root.querySelector(".tray .allow-row")!.textContent).toContain("Allow Scout on docs.example.com");
    allow.click();
    expect(on.allow).toHaveBeenCalledWith("https://docs.example.com/*");
    m.apply({ type: "grant", agentBrowserContext: false, destinations: ["https://docs.example.com"] });
    render();
    expect(box()!.checked).toBe(true);
    expect(box()!.disabled).toBe(false);
    expect(root.querySelector('[data-key="site-allow"]')).not.toBeNull();
    box()!.click();
    expect(on.destination).toHaveBeenCalledWith("https://docs.example.com", false);
  });

  it("the switch waits for the core while its command is pending, and is disabled without a core", () => {
    const m = running();
    m.apply({ type: "grant", agentBrowserContext: false, destinations: [] });
    expect(m.setDestination("https://docs.example.com", true)).not.toBeNull();
    const { root, render } = view(m);
    const box = () => root.querySelector<HTMLInputElement>('[data-key="destination-https://docs.example.com"]')!;
    expect(box().disabled).toBe(true);
    expect(box().checked).toBe(false);
    expect(root.textContent).toContain("Waiting for Scout…");
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
    const page0 = root.querySelector("[data-key='nav-page']")!;
    const reason = root.querySelector("span.reason")!;
    m.apply(results(1, { status: "ok", items: [{ candidateId: "c1", title: "A", reason: "second", hostname: "docs.example.com" }] }));
    render();
    expect(root.querySelector("nav")).toBe(nav);
    expect(root.querySelector("[data-key='nav-page']")).toBe(page0);
    expect(root.querySelector("span.reason")).toBe(reason);
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
    m.select("sites");
    const { doc, root, on, render, v } = view(m);
    const autoKey = `[data-key="auto-acquire-${F.origin}"]`;
    const box = root.querySelector<HTMLInputElement>(autoKey)!;
    expect(box.disabled).toBe(false);
    const before = box.checked;
    box.click();
    expect(on.autoAcquire).toHaveBeenCalledWith(F.origin, !before, false);
    render();
    expect(root.querySelector(autoKey)).toBe(box);
    expect(box.checked).toBe(before);

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
    const { root, on, render } = view(m);
    const keys = () => [...root.querySelectorAll("[data-key]")].map((e) => e.getAttribute("data-key")!);
    expect(new Set(keys()).size).toBe(keys().length);
    expect(keys()).toContain("review-open");
    expect(keys()).toContain(`library-preview-${F.rid}-${F.v1}`);
    root.querySelector<HTMLButtonElement>(`[data-key="library-preview-${F.rid}-${F.v1}"]`)!.click();
    expect(on.showPreview).toHaveBeenCalledWith({ resourceId: F.rid, version: F.v1 });
    expect(root.querySelector(`[data-key="revoke-${twin}"]`)).not.toBeNull();
    // The offer's review card beside its own library line: still no collision.
    m.showPreview({ resourceId: F.rid, version: F.v1 });
    render();
    expect(new Set(keys()).size).toBe(keys().length);
    expect(keys()).toContain(`decline-${F.rid}-${F.v1}`);
    expect(keys()).toContain(`approve-${F.rid}-${F.v1}`);
    expect(keys()).toContain(`library-preview-${F.rid}-${F.v1}`);
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
