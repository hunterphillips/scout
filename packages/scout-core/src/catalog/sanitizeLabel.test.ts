import { describe, expect, it } from "vitest";
import { sanitizeLabel } from "./sanitizeLabel.js";

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
});
