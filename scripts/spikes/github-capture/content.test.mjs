import { afterEach, describe, expect, it } from "vitest";
import { boundedText, createCaptureController, extractIssue, truncateChars, truncateUtf8, utf8Length } from "./src/content-core.mjs";
import { parseIssueRoute } from "./src/route.mjs";
import { LIMITS, SELECTORS } from "./src/selectors.mjs";
import { issueMain, listMain, makeDom, repoHomeMain, SENTINEL } from "./test-fakes.mjs";

const ISSUE1 = "https://github.com/acme/widgets/issues/1";
const ISSUE2 = "https://github.com/acme/widgets/issues/2";
const LIST = "https://github.com/acme/widgets/issues";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const FAST = { settleMs: 40, maxWaitMs: 400, tickMs: 5, pollMs: 20 };

const allSentinels = Object.values(SENTINEL);
const expectClean = (s) => {
  for (const x of allSentinels) expect(s).not.toContain(x);
};

describe("issue route gate", () => {
  it("accepts only https://github.com/<owner>/<repo>/issues/<n>", () => {
    const ok = [
      "https://github.com/acme/widgets/issues/1",
      "https://github.com/acme/widgets/issues/42/",
      "https://github.com/Acme/Widgets/issues/42?q=secret#issuecomment-1",
    ];
    for (const u of ok) expect(parseIssueRoute(u), u).not.toBeNull();
    const bad = [
      "http://github.com/acme/widgets/issues/1",
      "https://gist.github.com/acme/widgets/issues/1",
      "https://github.com.evil.example/acme/widgets/issues/1",
      "https://github.com:8443/acme/widgets/issues/1",
      "https://user:pw@github.com/acme/widgets/issues/1",
      "https://github.com/acme/widgets/issues",
      "https://github.com/acme/widgets/issues/new",
      "https://github.com/acme/widgets/issues/1/linked_closing_reference",
      "https://github.com/acme/widgets/pull/1",
      "https://github.com/acme/widgets",
      "https://github.com/acme/widgets/issues/0",
      "not a url",
    ];
    for (const u of bad) expect(parseIssueRoute(u), u).toBeNull();
  });

  it("strips query and fragment from the canonical URL but keys on owner/repo/number", () => {
    const r = parseIssueRoute("https://github.com/Acme/Widgets/issues/42/?q=secret#frag");
    expect(r.canonicalUrl).toBe("https://github.com/Acme/Widgets/issues/42");
    expect(r.key).toBe("acme/widgets#42");
  });
});

describe("UTF-8 and character limits", () => {
  it("never splits a code point when cutting to a byte cap", () => {
    const s = "é".repeat(10) + "😀".repeat(10);
    for (let cap = 0; cap <= utf8Length(s); cap++) {
      const r = truncateUtf8(s, cap);
      expect(utf8Length(r.text)).toBeLessThanOrEqual(cap);
      expect(r.text).not.toContain("�");
      expect(s.startsWith(r.text)).toBe(true);
      expect(r.truncated).toBe(cap < utf8Length(s));
    }
  });

  it("cuts titles to 300 code points without breaking surrogate pairs", () => {
    const r = truncateChars("😀".repeat(301), 300);
    expect(r.truncated).toBe(true);
    expect(Array.from(r.text)).toHaveLength(300);
    expect(r.text.endsWith("😀")).toBe(true);
  });
});

describe("extractor (synthetic DOM mirroring live GitHub)", () => {
  it("keeps every selector in one place with stable ids", () => {
    const ids = [...SELECTORS.title, ...SELECTORS.body, ...SELECTORS.identity].map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("returns only the title and main body, not comments, sidebar, nav, drafts or sticky header", () => {
    const d = makeDom(ISSUE1, issueMain({ title: "Widget  breaks\n on save", body: "<h2>Steps</h2><p>Click <code>save</code>.</p><ul><li>one</li><li>two</li></ul>" }));
    d.doc.querySelector("textarea").value = SENTINEL.typed;
    const r = extractIssue(d.doc, parseIssueRoute(ISSUE1));
    expect(r.ok).toBe(true);
    expect(r.title).toBe("Widget breaks on save");
    expect(r.body).toBe("Steps\nClick save.\n\none\ntwo");
    expect(r.selectorIds).toEqual([SELECTORS.identity[0].id, SELECTORS.title[0].id, SELECTORS.body[0].id]);
    expectClean(JSON.stringify(r));
    expect(d.reads.other).toBe(0);
  });

  it("skips form controls, contenteditable, buttons and hidden parts inside the body", () => {
    const body = `<p>keep</p><textarea>${SENTINEL.draft}</textarea><input value="${SENTINEL.draft}"><select><option>${SENTINEL.draft}</option></select><div contenteditable="true">${SENTINEL.editable}</div><button>${SENTINEL.button}</button><span hidden>${SENTINEL.sticky}</span><span aria-hidden="true">${SENTINEL.sticky}</span><p>also keep</p>`;
    const d = makeDom(ISSUE1, issueMain({ body }));
    d.doc.querySelector('[data-testid="issue-body"] textarea').value = SENTINEL.typed;
    const r = extractIssue(d.doc, parseIssueRoute(ISSUE1));
    expect(r.ok).toBe(true);
    expect(r.body).toBe("keep\nalso keep");
    expectClean(r.body);
    expect(d.reads.other).toBe(0);
  });

  it("refuses a body that is being edited (inside a form or contenteditable)", () => {
    const d = makeDom(ISSUE1, issueMain());
    const viewer = d.doc.querySelector('[data-testid="issue-body-viewer"]');
    const form = d.doc.createElement("form");
    viewer.parentNode.replaceChild(form, viewer);
    form.appendChild(viewer);
    d.reads.nodeValue = 0;
    expect(extractIssue(d.doc, parseIssueRoute(ISSUE1))).toEqual({ ok: false, reason: "editable" });
    expect(d.reads.nodeValue).toBe(0);
  });

  it("reads no text when the identity link names a different issue (stale SPA DOM)", () => {
    const d = makeDom(ISSUE2, issueMain({ number: 1 }));
    d.reads.nodeValue = 0;
    expect(extractIssue(d.doc, parseIssueRoute(ISSUE2))).toEqual({ ok: false, reason: "identity-mismatch" });
    expect(d.reads.nodeValue).toBe(0);
    expect(d.reads.other).toBe(0);
  });

  it("fails closed on missing or duplicated targets", () => {
    const d = makeDom(ISSUE1, issueMain() + `<div data-testid="issue-body"><div data-testid="issue-body-viewer"><div data-testid="markdown-body">dup</div></div></div>`);
    const r = extractIssue(d.doc, parseIssueRoute(ISSUE1));
    expect(r.ok).toBe(false);
    const e = makeDom(ISSUE1, listMain());
    expect(extractIssue(e.doc, parseIssueRoute(ISSUE1))).toEqual({ ok: false, reason: "identity-missing" });
  });

  it("caps the body at 8 KiB with a truncated flag and stops walking huge DOMs early", () => {
    const para = `<p>${"ü".repeat(200)}</p>`;
    const d = makeDom(ISSUE1, issueMain({ body: para.repeat(5000) }));
    d.reads.nodeValue = 0;
    const r = extractIssue(d.doc, parseIssueRoute(ISSUE1));
    expect(r.ok).toBe(true);
    expect(r.bodyTruncated).toBe(true);
    expect(utf8Length(r.body)).toBeLessThanOrEqual(LIMITS.bodyBytes);
    expect(r.bodyBytes).toBe(utf8Length(r.body));
    expect(d.reads.nodeValue).toBeLessThan(60); // ~9 KiB of 400-byte nodes, not 5000
  });

  it("caps the title at 300 characters", () => {
    const d = makeDom(ISSUE1, issueMain({ title: "t".repeat(1000) }));
    const r = extractIssue(d.doc, parseIssueRoute(ISSUE1));
    expect(r.title).toHaveLength(300);
    expect(r.titleTruncated).toBe(true);
  });

  it("boundedText never touches textContent/innerText", () => {
    const d = makeDom(ISSUE1, issueMain());
    boundedText(d.doc.querySelector('[data-testid="issue-body"]'), 100);
    expect(d.reads.other).toBe(0);
  });
});

describe("capture controller (SPA state machine)", () => {
  const ctls = [];
  afterEach(() => {
    for (const c of ctls.splice(0)) c.stop();
  });

  function harness(url, main, { approve = async () => ({ approved: true, token: "tok" }) } = {}) {
    const d = makeDom(url, main);
    const log = { approvals: [], captures: [], routes: [] };
    const ctl = createCaptureController({
      win: d.win,
      doc: d.doc,
      limits: FAST,
      requestApproval: async (m) => {
        log.approvals.push({ ...m, href: d.win.location.href });
        return approve(m, d);
      },
      sendCapture: async (p) => void log.captures.push(p),
      sendRoute: (p) => log.routes.push(p),
    });
    ctls.push(ctl);
    return { d, ctl, log };
  }

  it("on non-issue pages only watches the URL: no approval, no text reads", async () => {
    for (const [url, main] of [
      ["https://github.com/acme/widgets", repoHomeMain()],
      [LIST, listMain()],
      ["https://github.com/acme/widgets/pull/3", issueMain()],
    ]) {
      const { d, ctl, log } = harness(url, main);
      d.reads.nodeValue = 0;
      ctl.start();
      await sleep(80);
      expect(log.approvals).toEqual([]);
      expect(log.captures).toEqual([]);
      expect(log.routes).toEqual([{ issue: false, gen: 0 }]);
      expect(d.reads.nodeValue + d.reads.other).toBe(0);
    }
  });

  it("does not read a hidden page, then captures once it becomes visible", async () => {
    const { d, ctl, log } = harness(ISSUE1, issueMain());
    d.setVisible(false);
    d.reads.nodeValue = 0;
    ctl.start();
    await sleep(80);
    expect(log.approvals).toEqual([]);
    expect(d.reads.nodeValue).toBe(0);
    d.setVisible(true);
    await sleep(150);
    expect(log.captures).toHaveLength(1);
  });

  it("reads nothing when the background denies approval", async () => {
    const { d, ctl, log } = harness(ISSUE1, issueMain(), { approve: async () => ({ approved: false, reason: "not-foreground" }) });
    d.reads.nodeValue = 0;
    ctl.start();
    await sleep(100);
    expect(log.approvals).toHaveLength(1);
    expect(log.captures).toEqual([]);
    expect(d.reads.nodeValue + d.reads.other).toBe(0);
    expect(ctl.state.lastReason).toBe("not-foreground");
  });

  it("captures after the text settles, with metadata and without the URL", async () => {
    const { d, ctl, log } = harness(ISSUE1 + "?q=private#frag", issueMain({ body: "<p>v1</p>" }));
    ctl.start();
    await sleep(20);
    d.setMain(issueMain({ body: "<p>v2</p>" }));
    await sleep(20);
    d.setMain(issueMain({ body: "<p>v3 final</p>" }));
    await sleep(200);
    expect(log.captures).toHaveLength(1);
    const p = log.captures[0];
    expect(p).toMatchObject({ type: "capture", token: "tok", routeKey: "acme/widgets#1", body: "v3 final", title: "Issue title" });
    expect(p.settleMs).toBeGreaterThanOrEqual(FAST.settleMs);
    expect(JSON.stringify(p)).not.toContain("private");
    expect(JSON.stringify(p)).not.toContain("https://");
  });

  it("gives up after the max wait with a text-free failure", async () => {
    const { ctl, log } = harness(ISSUE2, issueMain({ number: 1 })); // stale DOM never updates
    ctl.start();
    await sleep(600);
    expect(log.captures).toEqual([{ type: "capture-failed", gen: 0, token: "tok", routeKey: "acme/widgets#2", reason: "identity-mismatch", settleMs: expect.any(Number) }]);
  });

  it("drops a late capture when the URL changes while approval is pending (issue -> issue)", async () => {
    let release;
    const gate = new Promise((r) => (release = r));
    let first = true;
    const { d, ctl, log } = harness(ISSUE1, issueMain({ number: 1, title: "One" }), {
      approve: async () => {
        if (first) {
          first = false;
          await gate;
        }
        return { approved: true, token: "t" };
      },
    });
    ctl.start();
    await sleep(10);
    d.pushUrl(ISSUE2); // SPA navigation, old DOM still in place
    await sleep(40); // URL poll notices
    release();
    await sleep(80);
    expect(log.captures).toEqual([]); // stale DOM: identity is still #1
    d.setMain(issueMain({ number: 2, title: "Two" }));
    await sleep(200);
    expect(log.captures).toHaveLength(1);
    expect(log.captures[0]).toMatchObject({ routeKey: "acme/widgets#2", title: "Two", gen: 1 });
  });

  it("repo home -> Issues -> issue -> issue -> list, all without reload", async () => {
    const { d, ctl, log } = harness("https://github.com/acme/widgets", repoHomeMain());
    ctl.start();
    await sleep(30);
    d.pushUrl(LIST);
    d.setMain(listMain());
    await sleep(40);
    d.pushUrl(ISSUE1);
    d.setMain(issueMain({ number: 1, title: "One" }));
    await sleep(200);
    d.pushUrl(ISSUE2);
    d.setMain(issueMain({ number: 2, title: "Two" }));
    await sleep(200);
    d.reads.nodeValue = 0;
    d.pushUrl(LIST);
    d.setMain(listMain());
    await sleep(200);
    expect(log.captures.map((c) => [c.routeKey, c.title])).toEqual([
      ["acme/widgets#1", "One"],
      ["acme/widgets#2", "Two"],
    ]);
    expect(log.routes.map((r) => r.issue)).toEqual([false, false, false]);
    expect(d.reads.nodeValue).toBe(0); // back on the list: nothing read
  });

  it("issue -> list during settling captures nothing", async () => {
    const { d, ctl, log } = harness(ISSUE1, issueMain());
    ctl.start();
    await sleep(15);
    d.pushUrl(LIST);
    await sleep(200);
    expect(log.captures).toEqual([]);
  });

  it("stops reading when the tab is hidden mid-settle, and resumes on return", async () => {
    const { d, ctl, log } = harness(ISSUE1, issueMain());
    ctl.start();
    await sleep(15);
    d.setVisible(false);
    d.reads.nodeValue = 0;
    await sleep(150);
    expect(log.captures).toEqual([]);
    expect(d.reads.nodeValue).toBe(0);
    d.setVisible(true);
    await sleep(200);
    expect(log.captures).toHaveLength(1);
  });

  it("refresh re-captures the current issue (bridge reconnected)", async () => {
    const { ctl, log } = harness(ISSUE1, issueMain());
    ctl.start();
    await sleep(150);
    ctl.refresh();
    await sleep(150);
    expect(log.captures).toHaveLength(2);
  });

  it("never writes to the page, fetches, or logs", async () => {
    const logs = [];
    const orig = { ...console };
    for (const k of ["log", "info", "warn", "error", "debug"]) console[k] = (...a) => logs.push(a);
    try {
      const { d, ctl, log } = harness(ISSUE1, issueMain());
      const before = d.html();
      ctl.start();
      await sleep(200);
      expect(log.captures).toHaveLength(1);
      expect(d.html()).toBe(before);
      expect(d.fetchCalls).toEqual([]);
    } finally {
      Object.assign(console, orig);
    }
    expect(logs).toEqual([]);
  });
});

describe("cancellation stops DOM reads, not just forwarding (fake clock + read counter)", () => {
  const macro = () => new Promise((r) => setImmediate(r));
  function fakeClock() {
    let t = 0;
    const q = [];
    return {
      now: () => t,
      setTimeout: (fn, ms) => {
        const e = { at: t + ms, fn };
        q.push(e);
        return e;
      },
      clearTimeout: () => {},
      setInterval: () => 0, // URL poll not needed here
      clearInterval: () => {},
      async advance(ms) {
        const end = t + ms;
        for (;;) {
          await macro();
          q.sort((a, b) => a.at - b.at);
          const n = q[0];
          if (!n || n.at > end) break;
          q.shift();
          t = n.at;
          n.fn();
        }
        t = end;
        await macro();
      },
    };
  }

  function clocked(url = ISSUE1) {
    const d = makeDom(url, issueMain());
    const clock = fakeClock();
    const log = { approvals: 0, captures: [] };
    const ctl = createCaptureController({
      win: d.win,
      doc: d.doc,
      limits: { settleMs: 500, maxWaitMs: 5000, tickMs: 100, pollMs: 1000 },
      now: clock.now,
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
      setInterval: clock.setInterval,
      clearInterval: clock.clearInterval,
      requestApproval: async () => (log.approvals++, { approved: true, token: "t" }),
      sendCapture: async (p) => void log.captures.push(p),
      sendRoute: () => {},
    });
    return { d, clock, log, ctl };
  }

  it("background cancel mid-settle: no further text reads for the rest of the 5 s window", async () => {
    const { d, clock, log, ctl } = clocked();
    ctl.start();
    await clock.advance(200);
    expect(d.reads.nodeValue).toBeGreaterThan(0); // was reading (approved, settling)
    // Keep the DOM changing so a live loop would keep re-reading.
    d.setMain(issueMain({ body: "<p>changed</p>" }));
    ctl.cancel();
    const frozen = d.reads.nodeValue;
    for (let i = 0; i < 10; i++) {
      d.setMain(issueMain({ body: `<p>changed ${i}</p>` }));
      await clock.advance(600);
    }
    expect(d.reads.nodeValue).toBe(frozen);
    expect(log.captures).toEqual([]);
    expect(ctl.state.phase).toBe("cancelled");
    ctl.stop();
  });

  it("recaptures normally when allowed again (refresh after cancel)", async () => {
    const { clock, log, ctl } = clocked();
    ctl.start();
    await clock.advance(200);
    ctl.cancel();
    await clock.advance(6000);
    expect(log.captures).toEqual([]);
    ctl.refresh();
    await clock.advance(800);
    expect(log.captures).toHaveLength(1);
    expect(log.captures[0].settleMs).toBeGreaterThanOrEqual(500);
    ctl.stop();
  });

  it("window blur cancels reads locally even if no background message arrives; focus resumes", async () => {
    const { d, clock, log, ctl } = clocked();
    ctl.start();
    await clock.advance(200);
    d.win.dispatchEvent(new d.win.Event("blur"));
    const frozen = d.reads.nodeValue;
    await clock.advance(6000);
    expect(d.reads.nodeValue).toBe(frozen);
    expect(log.captures).toEqual([]);
    d.win.dispatchEvent(new d.win.Event("focus"));
    await clock.advance(800);
    expect(log.captures).toHaveLength(1);
    ctl.stop();
  });

  it("a cancel that lands while approval is pending prevents any read at all", async () => {
    const d = makeDom(ISSUE1, issueMain());
    let release;
    const ctl = createCaptureController({
      win: d.win,
      doc: d.doc,
      limits: FAST,
      requestApproval: () => new Promise((r) => (release = () => r({ approved: true, token: "t" }))),
      sendCapture: async () => {},
      sendRoute: () => {},
    });
    ctl.start();
    await sleep(5);
    d.reads.nodeValue = 0;
    ctl.cancel();
    release();
    await sleep(100);
    expect(d.reads.nodeValue).toBe(0);
    ctl.stop();
  });
});

describe("content entry: background cancel / stop messages", () => {
  it("cancel freezes reads, stop disconnects, and a re-injection after revoke starts fresh", async () => {
    const { startContentScript } = await import("./src/content-core.mjs");
    const d = makeDom(ISSUE1, issueMain());
    const listeners = [];
    const sent = [];
    let approve = true;
    const chrome = {
      runtime: {
        id: "abcdefghijklmnopabcdefghijklmnop",
        sendMessage: async (m) => {
          sent.push(m.type);
          if (m.type === "approve") return approve ? { approved: true, token: "t" } : { approved: false, reason: "permission" };
          return { ok: true };
        },
        onMessage: { addListener: (f) => listeners.push(f) },
      },
    };
    const self = { id: chrome.runtime.id };
    const ctl = startContentScript(chrome, d.win);
    await sleep(30); // settling (settleMs 500 by default)
    expect(d.reads.nodeValue).toBeGreaterThan(0);
    for (const f of listeners) f({ type: "cancel" }, { id: "someone-else" }); // foreign sender ignored
    expect(ctl.state.cancels).toBe(0);
    for (const f of listeners) f({ type: "cancel", stop: true }, self);
    const frozen = d.reads.nodeValue;
    await sleep(700);
    expect(d.reads.nodeValue).toBe(frozen);
    expect(sent).not.toContain("capture");
    expect(ctl.stopped).toBe(true);
    for (const f of listeners) f({ type: "refresh" }, self); // stopped: no-op
    await sleep(50);
    expect(d.reads.nodeValue).toBe(frozen);
    // Re-granted: background re-injects; a new controller starts, still gated.
    approve = false;
    const again = startContentScript(chrome, d.win);
    expect(again).not.toBeNull();
    expect(startContentScript(chrome, d.win)).toBeNull(); // live one: re-injection is a no-op
    await sleep(50);
    expect(listeners).toHaveLength(1);
    expect(d.reads.nodeValue).toBe(frozen); // denied approval: still no reads
    again.stop();
  });
});
