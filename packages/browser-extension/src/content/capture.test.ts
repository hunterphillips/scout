import { afterEach, describe, expect, it } from "vitest";
import { LIMITS } from "../limits.js";
import type { ApproveResponse, PageTextMessage } from "../messages.js";
import { bodyOnlyPage, docsPage, fakeClock, makeDom, SENTINEL, trackerPage, typingPage } from "../test-fakes.js";
import { createCaptureController } from "./capture.js";
import { extractPage, truncateUtf8, utf8Length } from "./extract.js";

const ISSUE1 = "https://tracker.example/acme/widgets/issues/1";
const ISSUE2 = "https://tracker.example/acme/widgets/issues/2";
const DOCS = "https://docs.example/billing";

/** Settle (500 ms of stable text, on 100 ms ticks) plus the 3 s dwell. */
const SEND_AT = LIMITS.settleMs + LIMITS.dwellMs;

describe("extractor", () => {
  it("reads `main` only, never nav, header, footer, aside, dialog or form drafts, without textContent", () => {
    const d = makeDom(ISSUE1, trackerPage({ body: "<h2>Steps</h2><p>Click <code>save</code>.</p><ul><li>one</li><li>two</li></ul>" }), "  Widget  breaks\n on save · Tracker ");
    const r = extractPage(d.doc);
    expect(r).toMatchObject({ ok: true, title: "Widget breaks on save · Tracker", body: "Widget breaks on save\n\nSteps\nClick save.\n\none\ntwo", bodyTruncated: false });
    for (const s of Object.values(SENTINEL)) expect(JSON.stringify(r)).not.toContain(s);
    expect(d.reads.other).toBe(0);
  });

  it('reads an `article` when there is no `main`, skipping elements with landmark roles; `[role="main"]` comes before `article`', () => {
    const d = makeDom(DOCS, docsPage());
    const r = extractPage(d.doc);
    expect(r).toMatchObject({ ok: true, title: "Page title", body: "Billing\nInvoices are sent on the first of each month." });
    for (const s of Object.values(SENTINEL)) expect(JSON.stringify(r)).not.toContain(s);
    d.setBody(`<div role="main"><p>The role=main region wins over the article below it.</p></div><article><p>${SENTINEL.sidebar}</p></article>`);
    expect(extractPage(d.doc)).toMatchObject({ ok: true, body: "The role=main region wins over the article below it." });
  });

  it("falls back to `body`, still skipping nav and footer", () => {
    const d = makeDom("https://plain.example/", bodyOnlyPage());
    const r = extractPage(d.doc);
    expect(r).toMatchObject({ ok: true, body: "A plain page with its text straight in the body element." });
    for (const s of Object.values(SENTINEL)) expect(JSON.stringify(r)).not.toContain(s);
  });

  it("takes the first h1 as the title when document.title is empty", () => {
    const d = makeDom(ISSUE1, trackerPage({ title: "From the heading" }), "   ");
    expect(extractPage(d.doc)).toMatchObject({ ok: true, title: "From the heading" });
  });

  it("refuses with `editing` while the focused element is editable, reading no text", () => {
    const d = makeDom(ISSUE1, typingPage());
    expect(extractPage(d.doc)).toMatchObject({ ok: true });
    (d.doc.getElementById("draft") as HTMLTextAreaElement).focus();
    d.reads.nodeValue = 0;
    expect(extractPage(d.doc)).toEqual({ ok: false, reason: "editing" });
    expect(d.reads.nodeValue + d.reads.other).toBe(0);
    d.setBody(`<main><p>An editor with enough text in it to be worth sending along.</p><div id="ed" contenteditable="true" tabindex="0">x</div></main>`);
    (d.doc.getElementById("ed") as HTMLElement).focus();
    expect(extractPage(d.doc)).toEqual({ ok: false, reason: "editing" });
  });

  it("a focused checkbox is not typing; a hidden `main` is not the content root", () => {
    const d = makeDom(ISSUE1, `<main hidden><p>${SENTINEL.dialog} an inactive view that is not on screen</p></main><main><p>The visible view, with enough text to be worth sending.</p><input id="done" type="checkbox"></main>`);
    (d.doc.getElementById("done") as HTMLInputElement).focus();
    expect(extractPage(d.doc)).toMatchObject({ ok: true, body: "The visible view, with enough text to be worth sending." });
  });

  it("a body under 40 bytes is `no-content`", () => {
    const d = makeDom(ISSUE1, "<main><p>Loading…</p></main><footer>a long footer that does not count toward the body</footer>");
    expect(extractPage(d.doc)).toEqual({ ok: false, reason: "no-content" });
  });

  it("cuts the body to 8 KiB and the title to 300 chars", () => {
    const d = makeDom(ISSUE1, `<main><p>${"x".repeat(9 * 1024)}</p></main>`, "t".repeat(400));
    const r = extractPage(d.doc);
    if (!r.ok) throw new Error("expected text");
    expect(utf8Length(r.body)).toBe(LIMITS.bodyBytes);
    expect(r.bodyTruncated).toBe(true);
    expect(r.title).toHaveLength(300);
  });

  it("skips subtrees hidden by CSS: display:none, content-visibility:hidden and opacity:0, inline or from a stylesheet", () => {
    const d = makeDom(
      ISSUE1,
      `<style>.hidden { display: none !important } .gl-hidden { display: none } .cv { content-visibility: hidden } .faded { opacity: 0 }</style>
<main><div class="new-issue-params hidden"><p>### Full description (raw markdown copy)</p></div>
  <div class="gl-hidden"><p>GitLab AI Context: READ AGENTS.md and CLAUDE.md, use glab</p></div>
  <div style="display:none"><span>${SENTINEL.dialog} inline display none</span></div>
  <section class="cv"><p>${SENTINEL.sidebar} content-visibility hidden</p></section>
  <p class="faded">${SENTINEL.nav} faded out</p>
  <h1>Pipeline fails on save</h1><p>The rendered description the user actually sees.</p></main>`,
    );
    const r = extractPage(d.doc);
    expect(r).toMatchObject({ ok: true, body: "Pipeline fails on save\nThe rendered description the user actually sees." });
    expect(d.reads.other).toBe(0);
  });

  it("visibility:hidden hides an element's own text but not a descendant that sets visibility:visible", () => {
    const d = makeDom(
      ISSUE1,
      `<style>.inv { visibility: hidden } .shown { visibility: visible }</style>
<main><p>Visible lead paragraph with enough text to send.</p>
  <div class="inv">${SENTINEL.dialog} hidden own text<p>${SENTINEL.nav} hidden child</p><p class="shown">Shown child text.</p></div>
  <div style="visibility:hidden"><span>${SENTINEL.footer}</span><span style="visibility:visible">Inline shown.</span></div></main>`,
    );
    const r = extractPage(d.doc);
    expect(r).toMatchObject({ ok: true, body: "Visible lead paragraph with enough text to send.\n\nShown child text.\n\nInline shown." });
  });

  it("a CSS-hidden duplicate of visible text is captured once (Jira's collapsed comment copy)", () => {
    const comment = "We are starting to have separate config classes for remote log storage.";
    const d = makeDom(
      ISSUE1,
      `<style>.twixi-wrap.concise { display: none }</style>
<main><div class="activity-comment"><div class="twixi-wrap verbose"><p>${comment}</p></div><div class="twixi-wrap concise"><p>${comment}</p></div></div></main>`,
    );
    const r = extractPage(d.doc);
    if (!r.ok) throw new Error("expected text");
    expect(r.body).toBe(comment);
  });

  it("a CSS-hidden `main` is not the content root", () => {
    const d = makeDom(ISSUE1, `<div style="display:none"><main><p>${SENTINEL.dialog} an inactive view that is not on screen</p></main></div><article><p>The visible article, with enough text to be worth sending.</p></article>`);
    expect(extractPage(d.doc)).toMatchObject({ ok: true, body: "The visible article, with enough text to be worth sending." });
  });

  it("uses Element.checkVisibility where it exists, still descending into display:contents", () => {
    const d = makeDom(ISSUE1, `<style>.gone { display: none }</style><main><div style="display:contents"><p>Text inside a display:contents wrapper is on screen.</p></div><div class="gone"><p>${SENTINEL.dialog}</p></div></main>`);
    const view = d.win;
    let calls = 0;
    // Chrome's semantics: false when the element or an ancestor is display:none, or it has no box (display:contents).
    (view.Element.prototype as Element & { checkVisibility: () => boolean }).checkVisibility = function (this: Element) {
      calls++;
      for (let e: Element | null = this; e; e = e.parentElement) if (view.getComputedStyle(e).display === "none") return false;
      return view.getComputedStyle(this).display !== "contents";
    };
    expect(extractPage(d.doc)).toMatchObject({ ok: true, body: "Text inside a display:contents wrapper is on screen." });
    expect(calls).toBeGreaterThan(0);
  });

  it("rejects a hidden subtree whole, without a style lookup per descendant", () => {
    const d = makeDom(ISSUE1, `<main><p>Visible text, with enough of it to be worth sending.</p><div style="display:none">${"<div><span>x</span></div>".repeat(500)}</div></main>`);
    const real = d.win.getComputedStyle.bind(d.win);
    let calls = 0;
    d.win.getComputedStyle = ((e: Element, p?: string | null) => (calls++, real(e, p))) as typeof d.win.getComputedStyle;
    expect(extractPage(d.doc)).toMatchObject({ ok: true, body: "Visible text, with enough of it to be worth sending." });
    expect(calls).toBeLessThan(20);
  });

  it("applies the 8 KiB cap to the normalized text: whitespace-heavy markup fills the cap", () => {
    const indent = "\n" + " ".repeat(60);
    const para = (n: number) => `${indent}<p>${indent}abcdefghi${indent}</p>`.repeat(n);
    // Paragraphs normalize to "abcdefghi" joined by "\n\n": 744 fit in 8182 bytes, the 745th is cut to "\n\nabcdefgh".
    const d = makeDom(ISSUE1, `<main>${para(2000)}</main>`);
    const r = extractPage(d.doc);
    if (!r.ok) throw new Error("expected text");
    expect(utf8Length(r.body)).toBe(LIMITS.bodyBytes);
    expect(r.body.endsWith("abcdefghi\n\nabcdefgh")).toBe(true);
    expect(r.bodyTruncated).toBe(true);
    // Over 100 KB of raw text that normalizes to under 8 KiB is sent whole and not marked truncated.
    d.setBody(`<main>${para(600)}</main>`);
    const s = extractPage(d.doc);
    if (!s.ok) throw new Error("expected text");
    expect(utf8Length(s.body)).toBe(600 * 11 - 2);
    expect(s.bodyTruncated).toBe(false);
  });

  it("never splits a code point at the byte cap", () => {
    const s = "é".repeat(10) + "😀".repeat(10);
    for (let cap = 0; cap <= utf8Length(s); cap++) {
      const r = truncateUtf8(s, cap);
      expect(utf8Length(r.text)).toBeLessThanOrEqual(cap);
      expect(s.startsWith(r.text)).toBe(true);
    }
  });
});

describe("capture controller (jsdom + synthetic History/Navigation driver + fake clock)", () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    for (const c of cleanups.splice(0)) c();
  });

  function harness(url: string, body: string, approve: (n: number) => Promise<ApproveResponse> = async () => ({ approved: true })) {
    const d = makeDom(url, body);
    const clock = fakeClock();
    const sent: PageTextMessage[] = [];
    const approvals: Array<{ navCounter: number; url: string }> = [];
    const ctl = createCaptureController({
      win: d.win,
      doc: d.doc,
      navigation: d.navigation,
      MutationObserver: d.win.MutationObserver,
      clock,
      requestApproval: (m) => {
        approvals.push(m);
        return approve(approvals.length);
      },
      sendPageText: async (m) => void sent.push(m),
    });
    cleanups.push(() => {
      ctl.stop();
      d.close();
    });
    return { d, clock, ctl, sent, approvals };
  }

  it("sends nothing before 3 s visible after the page settles, then sends once", async () => {
    const { clock, ctl, sent } = harness(ISSUE1, trackerPage({ body: "<p>The first issue, long enough to send.</p>" }));
    ctl.start();
    await clock.advance(SEND_AT - 100);
    expect(sent).toEqual([]);
    expect(ctl.state.phase).toBe("dwelling");
    await clock.advance(200);
    expect(sent).toEqual([{ type: "page_text", navCounter: 0, url: ISSUE1, title: "Page title", text: "Widget breaks on save\n\nThe first issue, long enough to send.", truncated: false }]);
    await clock.advance(10_000);
    expect(sent).toHaveLength(1);
  });

  it("every URL change starts a job: tracker issue, then a docs page on another route", async () => {
    const { d, clock, ctl, sent, approvals } = harness(ISSUE1, trackerPage());
    ctl.start();
    await clock.advance(SEND_AT + 100);
    d.navigate(`${ISSUE1}/files`);
    d.setBody(docsPage(), "Files");
    await clock.advance(SEND_AT + 100);
    expect(approvals.map((a) => a.url)).toEqual([ISSUE1, `${ISSUE1}/files`]);
    expect(sent.map((m) => [m.url, m.title])).toEqual([
      [ISSUE1, "Page title"],
      [`${ISSUE1}/files`, "Files"],
    ]);
  });

  it("navigation during the dwell cancels it; only the new page is sent", async () => {
    const { d, clock, ctl, sent } = harness(ISSUE1, trackerPage({ title: "One" }));
    ctl.start();
    await clock.advance(2000); // settled, mid-dwell
    d.navigate(ISSUE2);
    d.setBody(trackerPage({ title: "Two" }));
    await clock.advance(SEND_AT + 100);
    expect(sent.map((m) => [m.url, m.navCounter])).toEqual([[ISSUE2, 1]]);
    expect(sent[0]!.text).toContain("Two");
  });

  it("blur during the dwell cancels it; focus starts a fresh full dwell", async () => {
    const { d, clock, ctl, sent } = harness(ISSUE1, trackerPage());
    ctl.start();
    await clock.advance(2000);
    d.win.dispatchEvent(new d.win.Event("blur"));
    await clock.advance(5000);
    expect(sent).toEqual([]);
    d.win.dispatchEvent(new d.win.Event("focus"));
    await clock.advance(SEND_AT - 100);
    expect(sent).toEqual([]);
    await clock.advance(200);
    expect(sent).toHaveLength(1);
  });

  it("hiding the page during the dwell cancels it; showing it again starts a fresh full dwell", async () => {
    const { d, clock, ctl, sent } = harness(ISSUE1, trackerPage());
    ctl.start();
    await clock.advance(SEND_AT - 100);
    d.setVisible(false);
    await clock.advance(5000);
    expect(sent).toEqual([]);
    d.setVisible(true);
    await clock.advance(SEND_AT - 100);
    expect(sent).toEqual([]);
    await clock.advance(200);
    expect(sent).toHaveLength(1);
  });

  it("a fragment-only change is the same page: it neither cancels the dwell nor sends again", async () => {
    const { d, clock, ctl, sent, approvals } = harness(DOCS, docsPage());
    ctl.start();
    await clock.advance(2000); // mid-dwell
    d.navigate(`${DOCS}#invoices`);
    await clock.advance(SEND_AT - 2000 + 100);
    expect(sent.map((m) => m.url)).toEqual([DOCS]);
    d.navigate(`${DOCS}#refunds`);
    await clock.advance(SEND_AT + 1000);
    expect(ctl.navCounter).toBe(0);
    expect(approvals).toHaveLength(1);
    expect(sent).toHaveLength(1);
  });

  it("asks approval for and sends the URL without its fragment", async () => {
    const { clock, ctl, sent, approvals } = harness(`${DOCS}?v=2#invoices`, docsPage());
    ctl.start();
    await clock.advance(SEND_AT + 100);
    expect(approvals[0]!.url).toBe(`${DOCS}?v=2`);
    expect(sent.map((m) => m.url)).toEqual([`${DOCS}?v=2`]);
  });

  it("waits while the user is typing and sends nothing if they keep typing", async () => {
    const { d, clock, ctl, sent } = harness(ISSUE1, typingPage());
    (d.doc.getElementById("draft") as HTMLTextAreaElement).focus();
    ctl.start();
    await clock.advance(10_000);
    expect(sent).toEqual([]);
    expect(ctl.state).toMatchObject({ phase: "failed", lastReason: "editing" });
  });

  it("a settle that finishes after navigation is dropped (href changed, no event seen yet)", async () => {
    const { d, clock, ctl, sent } = harness(ISSUE1, trackerPage());
    ctl.start();
    await clock.advance(200);
    d.pushSilently(`${ISSUE1}?q=is%3Aopen`); // no currententrychange; the 1 s check has not run
    await clock.advance(400); // settle would complete at 500 ms
    expect(sent.filter((m) => m.navCounter === 0)).toEqual([]);
    await clock.advance(10_000);
    expect(sent.map((m) => m.navCounter)).toEqual([1]); // only the job the URL check started
  });

  it("a navCounter mismatch is dropped even when the href matches again", async () => {
    let release!: (r: ApproveResponse) => void;
    const { d, clock, ctl, sent, approvals } = harness(ISSUE1, trackerPage(), (n) =>
      n === 1 ? new Promise((r) => (release = r)) : Promise.resolve({ approved: true }),
    );
    ctl.start();
    await clock.advance(50);
    d.navigate(ISSUE2);
    d.navigate(ISSUE1); // same href as the first job, new navCounter
    await clock.advance(50);
    release({ approved: true }); // the first job resumes: href matches, navCounter does not
    await clock.advance(SEND_AT + 1000);
    expect(approvals.map((a) => a.navCounter)).toEqual([0, 1, 2]);
    expect(sent.map((m) => m.navCounter)).toEqual([2]);
  });

  it("the 1 s URL check alone catches navigation without the Navigation API", async () => {
    const { d, clock, ctl, approvals } = harness(ISSUE1, trackerPage());
    ctl.start();
    d.pushSilently(ISSUE2);
    await clock.advance(999);
    expect(ctl.navCounter).toBe(0);
    await clock.advance(1000);
    expect(ctl.navCounter).toBe(1);
    expect(approvals.at(-1)).toEqual({ navCounter: 1, url: ISSUE2 });
  });

  it("reads nothing when the background denies approval", async () => {
    const { d, clock, ctl, sent } = harness(ISSUE1, trackerPage(), async () => ({ approved: false, reason: "not-foreground" }));
    d.reads.nodeValue = 0;
    ctl.start();
    await clock.advance(10_000);
    expect(sent).toEqual([]);
    expect(d.reads.nodeValue + d.reads.other).toBe(0);
    expect(ctl.state.lastReason).toBe("not-foreground");
  });

  it("does not read a hidden page; captures once it becomes visible", async () => {
    const { d, clock, ctl, sent, approvals } = harness(ISSUE1, trackerPage());
    d.setVisible(false);
    d.reads.nodeValue = 0;
    ctl.start();
    await clock.advance(SEND_AT + 1000);
    expect(approvals).toEqual([]);
    expect(d.reads.nodeValue).toBe(0);
    d.setVisible(true);
    await clock.advance(SEND_AT + 100);
    expect(sent).toHaveLength(1);
  });

  it("a refresh that finds the URL changed asks for approval once, not twice", async () => {
    const { d, clock, ctl, approvals } = harness(ISSUE1, trackerPage());
    ctl.start();
    await clock.advance(0);
    d.pushSilently(ISSUE2); // no event yet; the refresh's URL check sees it
    ctl.refresh();
    await clock.advance(0);
    expect(approvals).toEqual([
      { navCounter: 0, url: ISSUE1 },
      { navCounter: 1, url: ISSUE2 },
    ]);
  });

  it("a background cancel mid-settle stops further text reads", async () => {
    const { d, clock, ctl, sent } = harness(ISSUE1, trackerPage());
    ctl.start();
    await clock.advance(200);
    expect(d.reads.nodeValue).toBeGreaterThan(0);
    ctl.cancel();
    d.setBody(trackerPage({ body: "<p>changed</p>" }));
    d.reads.nodeValue = 0;
    await clock.advance(10_000);
    expect(d.reads.nodeValue).toBe(0);
    expect(sent).toEqual([]);
  });
});
