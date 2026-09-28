import { describe, expect, it } from "vitest";
import { SANITIZE_INPUT_FACTOR, sanitizeLabel } from "./sanitizeLabel.js";

describe("sanitizeLabel", () => {
  it("strips control and bidi/zero-width characters and collapses whitespace", () => {
    expect(sanitizeLabel("  Every\u0000day\n\tBack\u200Bpack \u202Egnissim\u202C\u0085 20L  ", 160)).toBe("Every day Backpack gnissim 20L");
  });

  it("unwraps Markdown links, drops images, and removes tags and backticks", () => {
    const text = "See [the [nested] guide](https://evil.example) ![logo](https://evil.example/a.png) <a href='x'>here</a> `code`";
    expect(sanitizeLabel(text, 160)).toBe("See the nested guide here code");
  });

  it("caps on code points without splitting a surrogate pair", () => {
    expect(sanitizeLabel("ab😀cd", 3)).toBe("ab😀");
    expect(sanitizeLabel("x".repeat(500), 160)).toHaveLength(160);
  });

  it("removes Unicode tag characters, soft hyphens, and other invisible format characters", () => {
    const tagged = "Safe\u{E0001}\u{E0041}\u{E0042}\u{E007F} label";
    expect(sanitizeLabel(tagged, 160)).toBe("Safe label");
    expect(sanitizeLabel("soft\u00ADhyphen\u2060joined\u2064\u061C\u180Etext", 160)).toBe("softhyphenjoinedtext");
  });

  it.each([
    ["<", "<<<<"],
    ["](", "](]("],
    ["![", "![!["],
  ])("reads a bounded prefix of 400 KB of %s quickly", (_name, unit) => {
    const hostile = `Title ${unit.repeat((400 * 1024) / unit.length)}`;
    const started = performance.now();
    const out = sanitizeLabel(hostile, 160);
    expect(performance.now() - started).toBeLessThan(100);
    expect(out).toBe("Title");
  });

  it("drops an unterminated tag left open by the input bound", () => {
    const text = `Good label <${"x".repeat(160 * SANITIZE_INPUT_FACTOR)}>`;
    expect(sanitizeLabel(text, 160)).toBe("Good label");
  });
});
