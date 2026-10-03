import { describe, expect, it } from "vitest";
import { iconClickAction } from "./toggle.js";

describe("iconClickAction", () => {
  it("closes only an open panel, and only where Chrome can close it", () => {
    expect(iconClickAction({ panelOpenInWindow: true, canClose: true })).toBe("close");
    expect(iconClickAction({ panelOpenInWindow: true, canClose: false })).toBe("open");
    expect(iconClickAction({ panelOpenInWindow: false, canClose: true })).toBe("open");
    expect(iconClickAction({ panelOpenInWindow: false, canClose: false })).toBe("open");
  });
});
