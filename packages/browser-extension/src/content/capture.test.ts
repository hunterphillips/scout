import { afterEach, describe, expect, it } from "vitest";
import type { ApproveResponse, PageTextMessage } from "../messages.js";
import { parseIssueRoute } from "../route.js";
import { LIMITS, SELECTORS } from "../selectors.js";
import { fakeClock, issueMain, listMain, makeDom, repoHomeMain, SENTINEL } from "../test-fakes.js";
import { createCaptureController } from "./capture.js";
import { extractIssue, truncateUtf8, utf8Length } from "./extract.js";

const REPO = "https://github.com/acme/widgets";
const LIST = "https://github.com/acme/widgets/issues";
const ISSUE1 = "https://github.com/acme/widgets/issues/1";
const ISSUE2 = "https://github.com/acme/widgets/issues/2";

describe("issue route gate", () => {
  it("accepts only https://github.com/<owner>/<repo>/issues/<n>", () => {
    for (const u of [ISSUE1, `${ISSUE1}/`, "https://github.com/Acme/Widgets/issues/42?q=x#issuecomment-1"]) expect(parseIssueRoute(u), u).not.toBeNull();
    for (const u of [
      "http://github.com/acme/widgets/issues/1",
      "https://gist.github.com/acme/widgets/issues/1",
      "https://github.com.evil.example/acme/widgets/issues/1",
      "https://user:pw@github.com/acme/widgets/issues/1",
      LIST,
      `${LIST}/new`,
      `${ISSUE1}/linked_closing_reference`,
      "https://github.com/acme/widgets/pull/1",
      REPO,
      `${LIST}/0`,
      "not a url",
    ])
      expect(parseIssueRoute(u), u).toBeNull();
  });

  it("drops query and fragment from the canonical URL", () => {
    expect(parseIssueRoute("https://github.com/Acme/Widgets/issues/42/?q=s#f")).toMatchObject({
      canonicalUrl: "https://github.com/Acme/Widgets/issues/42",
      key: "acme/widgets#42",
    });
  });
});

describe("extractor", () => {
  it("returns only the title and main body, never comments, sidebar, nav, drafts or sticky header, without textContent", () => {
    const d = makeDom(ISSUE1, issueMain({ title: "Widget  breaks\n on save", body: "<h2>Steps</h2><p>Click <code>save</code>.</p><ul><li>one</li><li>two</li></ul>" }));
    const r = extractIssue(d.doc, parseIssueRoute(ISSUE1)!);
    expect(r).toMatchObject({ ok: true, title: "Widget breaks on save", body: "Steps\nClick save.\n\none\ntwo", bodyTruncated: false });
    for (const s of Object.values(SENTINEL)) expect(JSON.stringify(r)).not.toContain(s);
    expect(d.reads.other).toBe(0);
  });

  it("reads no text when the identity link names a different issue (stale SPA DOM)", () => {
    const d = makeDom(ISSUE2, issueMain({ number: 1 }));
    d.reads.nodeValue = 0;
    expect(extractIssue(d.doc, parseIssueRoute(ISSUE2)!)).toEqual({ ok: false, reason: "identity-mismatch" });
    expect(d.reads.nodeValue + d.reads.other).toBe(0);
  });

  it("keeps every selector in selectors.ts, verbatim from the spike", () => {
    expect(SELECTORS.title[0]?.css).toBe('[data-testid="issue-header"] [data-testid="issue-title"]');
    expect(SELECTORS.body[0]?.css).toBe('[data-testid="issue-body"] [data-testid="issue-body-viewer"] [data-testid="markdown-body"]');
    expect(SELECTORS.identity[0]?.css).toBe('[data-testid="issue-body"] [data-testid="issue-body-header-link"]');
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

  function harness(url: string, main: string, approve: (n: number) => Promise<ApproveResponse> = async () => ({ approved: true })) {
    const d = makeDom(url, main);
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

  it("repo home -> Issues -> issue extracts once, for the issue", async () => {
    const { d, clock, ctl, sent, approvals } = harness(REPO, repoHomeMain());
    ctl.start();
    await clock.advance(300);
    d.navigate(LIST);
    d.setMain(listMain());
    await clock.advance(300);
    expect(approvals).toEqual([]);
    d.navigate(ISSUE1);
    d.setMain(issueMain({ number: 1, title: "One", body: "<p>first</p>" }));
    await clock.advance(5000);
    expect(sent).toEqual([{ type: "page_text", navCounter: 2, url: ISSUE1, title: "One", text: "first", truncated: false }]);
    expect(ctl.state.extractions).toBe(1);
  });

  it("issue -> issue extracts the second issue only, never the stale first DOM under the new URL", async () => {
    const { d, clock, ctl, sent } = harness(ISSUE1, issueMain({ number: 1, title: "One" }));
    ctl.start();
    await clock.advance(200); // mid-settle for #1
    d.navigate(ISSUE2); // old DOM (#1) still in place
    await clock.advance(1000);
    expect(sent).toEqual([]);
    d.setMain(issueMain({ number: 2, title: "Two" }));
    await clock.advance(1000);
    expect(sent.map((m) => [m.url, m.title])).toEqual([[ISSUE2, "Two"]]);
  });

  it("issue -> issue list sends nothing and reads nothing on the list", async () => {
    const { d, clock, ctl, sent } = harness(ISSUE1, issueMain());
    ctl.start();
    await clock.advance(200);
    d.navigate(LIST);
    d.setMain(listMain());
    d.reads.nodeValue = 0;
    await clock.advance(6000);
    expect(sent).toEqual([]);
    expect(d.reads.nodeValue + d.reads.other).toBe(0);
  });

  it("a settle that finishes after navigation is dropped (href changed, no event seen yet)", async () => {
    const { d, clock, ctl, sent } = harness(ISSUE1, issueMain());
    ctl.start();
    await clock.advance(200);
    d.pushSilently(`${LIST}?q=is%3Aopen`); // no currententrychange; the 1 s check has not run
    await clock.advance(400); // settle would complete at 500 ms
    expect(sent).toEqual([]);
    await clock.advance(6000);
    expect(sent).toEqual([]);
  });

  it("a navCounter mismatch is dropped even when the href matches again", async () => {
    let release!: (r: ApproveResponse) => void;
    const { d, clock, ctl, sent, approvals } = harness(ISSUE1, issueMain(), (n) =>
      n === 1 ? new Promise((r) => (release = r)) : Promise.resolve({ approved: true }),
    );
    ctl.start();
    await clock.advance(50);
    d.navigate(LIST);
    d.navigate(ISSUE1); // same href as the first job, new navCounter
    await clock.advance(50);
    release({ approved: true }); // the first job resumes: href matches, navCounter does not
    await clock.advance(2000);
    expect(approvals.map((a) => a.navCounter)).toEqual([0, 2]);
    expect(sent.map((m) => m.navCounter)).toEqual([2]);
  });

  it("a 9 KiB body is cut to 8 KiB with truncated: true; the title to 300 chars", async () => {
    const { clock, ctl, sent } = harness(ISSUE1, issueMain({ title: "t".repeat(400), body: `<p>${"x".repeat(9 * 1024)}</p>` }));
    ctl.start();
    await clock.advance(1000);
    expect(sent).toHaveLength(1);
    const m = sent[0]!;
    expect(utf8Length(m.text)).toBe(LIMITS.bodyBytes);
    expect(m.truncated).toBe(true);
    expect(m.title).toHaveLength(300);
  });

  it("non-issue GitHub paths never ask for approval and never read text", async () => {
    for (const [url, main] of [
      [REPO, repoHomeMain()],
      [LIST, listMain()],
      [`${LIST}/new`, issueMain()],
      ["https://github.com/acme/widgets/pull/3", issueMain()],
    ] as const) {
      const { d, clock, ctl, sent, approvals } = harness(url, main);
      d.reads.nodeValue = 0;
      ctl.start();
      await clock.advance(6000);
      expect(approvals, url).toEqual([]);
      expect(sent, url).toEqual([]);
      expect(d.reads.nodeValue + d.reads.other, url).toBe(0);
    }
  });

  it("the 1 s URL check alone catches navigation without the Navigation API", async () => {
    const { d, clock, ctl, sent } = harness(REPO, repoHomeMain());
    ctl.start();
    d.pushSilently(ISSUE1);
    d.setMain(issueMain());
    await clock.advance(999);
    expect(ctl.navCounter).toBe(0);
    await clock.advance(1000);
    expect(ctl.navCounter).toBe(1);
    expect(sent).toHaveLength(1);
  });

  it("reads nothing when the background denies approval", async () => {
    const { d, clock, ctl, sent } = harness(ISSUE1, issueMain(), async () => ({ approved: false, reason: "not-foreground" }));
    d.reads.nodeValue = 0;
    ctl.start();
    await clock.advance(6000);
    expect(sent).toEqual([]);
    expect(d.reads.nodeValue + d.reads.other).toBe(0);
    expect(ctl.state.lastReason).toBe("not-foreground");
  });

  it("does not read a hidden page; captures once it becomes visible", async () => {
    const { d, clock, ctl, sent, approvals } = harness(ISSUE1, issueMain());
    d.setVisible(false);
    d.reads.nodeValue = 0;
    ctl.start();
    await clock.advance(2000);
    expect(approvals).toEqual([]);
    expect(d.reads.nodeValue).toBe(0);
    d.setVisible(true);
    await clock.advance(1000);
    expect(sent).toHaveLength(1);
  });

  it("a refresh that finds the URL changed asks for approval once, not twice", async () => {
    const { d, clock, ctl, approvals } = harness(REPO, repoHomeMain());
    ctl.start();
    d.pushSilently(ISSUE1); // no event yet; the refresh's URL check sees it
    d.setMain(issueMain());
    ctl.refresh();
    await clock.advance(0);
    expect(approvals).toEqual([{ navCounter: 1, url: ISSUE1 }]);
  });

  it("a background cancel mid-settle stops further text reads", async () => {
    const { d, clock, ctl, sent } = harness(ISSUE1, issueMain());
    ctl.start();
    await clock.advance(200);
    expect(d.reads.nodeValue).toBeGreaterThan(0);
    ctl.cancel();
    d.setMain(issueMain({ body: "<p>changed</p>" }));
    d.reads.nodeValue = 0;
    await clock.advance(6000);
    expect(d.reads.nodeValue).toBe(0);
    expect(sent).toEqual([]);
  });
});
