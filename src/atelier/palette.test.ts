import { describe, it, expect } from "vitest";
import { DAY_VARS, NIGHT_VARS, SIGILS, PAL, getVarsForMode } from "./palette";

describe("palette", () => {
  it("DAY_VARS and NIGHT_VARS have identical keys", () => {
    expect(Object.keys(DAY_VARS).sort()).toEqual(Object.keys(NIGHT_VARS).sort());
  });

  it("all expected CSS custom property keys are present", () => {
    const expected = [
      "--c-text", "--c-soft", "--c-faint", "--c-panel", "--c-panel-2",
      "--c-edge", "--c-gold", "--c-gold-2", "--c-teal", "--c-ink", "--c-halo",
    ];
    for (const key of expected) expect(Object.keys(DAY_VARS)).toContain(key);
  });

  it("SIGILS has exactly 4 elements", () => {
    expect(SIGILS).toHaveLength(4);
  });

  it("getVarsForMode returns the matching var map", () => {
    expect(getVarsForMode("night")).toBe(NIGHT_VARS);
    expect(getVarsForMode("day")).toBe(DAY_VARS);
  });

  it("PAL has day and night canvas palettes", () => {
    expect(PAL.day.glowMax).toBeGreaterThan(0);
    expect(PAL.day.glowMax).toBeLessThanOrEqual(1);
    expect(PAL.night.glowMax).toBe(1.0);
  });
});
