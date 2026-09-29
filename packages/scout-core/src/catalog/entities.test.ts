import { describe, expect, it } from "vitest";
import { decodeEntities } from "./entities.js";

describe("decodeEntities", () => {
  it("decodes the five XML names and valid numeric references in one pass", () => {
    expect(decodeEntities("a &amp; b &lt;c&gt; &quot;d&quot; &apos;e&apos;")).toBe(`a & b <c> "d" 'e'`);
    expect(decodeEntities("&#39;&#x2014;&#X41;")).toBe("'—A");
    expect(decodeEntities("&amp;lt;")).toBe("&lt;");
  });

  it("leaves case variants, unknown names, and invalid references as written", () => {
    expect(decodeEntities("&AMP; &Lt; &nbsp; &copy;")).toBe("&AMP; &Lt; &nbsp; &copy;");
    expect(decodeEntities("&#0; &#xD800; &#x110000; &#12345678;")).toBe("&#0; &#xD800; &#x110000; &#12345678;");
  });
});
