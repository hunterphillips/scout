// Drives a Chrome for Testing instance over CDP for the Phase 1 manual check; see README.md.
// Drive the Chrome for Testing instance over CDP for the Phase 1 manual check.
// usage: node drive.mjs <cmd> [args]
//   popup <extId>            open chrome-extension://<id>/popup.html in a tab, print its text
//   grant <extId>            click "Grant sites" in the popup tab (opens Chrome's native prompt)
//   text <extId>             print the popup's text
//   goto <url>               open <url> in a new tab and bring it to front
//   front <substr>           bring the first tab whose url contains <substr> to front
//   tabs                     list tabs
//   shot <file>              screenshot of the front page
import { chromium } from "playwright-core";

const [cmd, ...args] = process.argv.slice(2);
const browser = await chromium.connectOverCDP("http://127.0.0.1:9333");
const ctx = browser.contexts()[0];
const pages = () => ctx.pages();
const popupUrl = (id) => `chrome-extension://${id}/popup.html`;
const findPage = (sub) => pages().find((p) => p.url().includes(sub));

try {
  if (cmd === "tabs") {
    for (const p of pages()) console.log(p.url());
  } else if (cmd === "popup") {
    let p = findPage(popupUrl(args[0]));
    if (!p) { p = await ctx.newPage(); await p.goto(popupUrl(args[0])); }
    await p.bringToFront();
    await p.waitForTimeout(500);
    console.log(await p.innerText("body"));
  } else if (cmd === "text") {
    const p = findPage(popupUrl(args[0]));
    console.log(p ? await p.innerText("body") : "(no popup tab)");
  } else if (cmd === "grant") {
    const p = findPage(popupUrl(args[0]));
    await p.bringToFront();
    const box = await p.locator("#grant").boundingBox();
    await p.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await p.waitForTimeout(1500);
    console.log(await p.innerText("body"));
  } else if (cmd === "goto") {
    const p = await ctx.newPage();
    await p.goto(args[0], { waitUntil: "domcontentloaded" });
    await p.bringToFront();
    await p.waitForTimeout(1200);
    console.log("front:", p.url());
  } else if (cmd === "front") {
    const p = findPage(args[0]);
    if (!p) throw new Error("no tab matching " + args[0]);
    await p.bringToFront();
    await p.waitForTimeout(1200);
    console.log("front:", p.url());
  } else if (cmd === "click") {
    const p = findPage(args[0]);
    await p.bringToFront();
    const loc = p.locator(args[1]).first();
    await loc.scrollIntoViewIfNeeded();
    const box = await loc.boundingBox();
    await p.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await p.waitForTimeout(2500);
    console.log("now:", p.url());
  } else if (cmd === "back") {
    const p = findPage(args[0]);
    await p.bringToFront();
    await p.goBack();
    await p.waitForTimeout(2500);
    console.log("now:", p.url());
  } else if (cmd === "shot") {
    const p = pages()[0];
    await p.screenshot({ path: args[0] });
    console.log("saved", args[0]);
  } else {
    throw new Error("unknown cmd " + cmd);
  }
} finally {
  await browser.close().catch(() => {});
}
