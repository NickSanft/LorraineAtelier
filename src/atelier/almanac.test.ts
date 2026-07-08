import { describe, it, expect } from "vitest";
import { ALMANAC_LINES, dayOfYear, pickLine } from "./almanac";

describe("almanac", () => {
  it("has a non-empty line list with strip-friendly lengths", () => {
    expect(ALMANAC_LINES.length).toBeGreaterThan(0);
    for (const l of ALMANAC_LINES) {
      expect(l.trim().length).toBeGreaterThan(0);
      expect(l.length).toBeLessThanOrEqual(120); // fits the two-line pill
    }
  });

  it("is deterministic for a given date (any time of day)", () => {
    expect(pickLine(new Date(2026, 6, 25, 0, 30))).toBe(pickLine(new Date(2026, 6, 25, 23, 30)));
  });

  it("advances exactly one line per day (mod list length)", () => {
    const lines = ["a", "b", "c"];
    const i1 = lines.indexOf(pickLine(new Date(2026, 2, 10, 12), lines));
    const i2 = lines.indexOf(pickLine(new Date(2026, 2, 11, 12), lines));
    expect(i1).toBeGreaterThanOrEqual(0);
    expect((i1 + 1) % lines.length).toBe(i2);
  });

  it("advances by one across the year boundary (Dec 31 -> Jan 1), not backward", () => {
    const lines = ["a", "b", "c", "d", "e"];
    const dec31 = lines.indexOf(pickLine(new Date(2026, 11, 31, 12), lines));
    const jan1 = lines.indexOf(pickLine(new Date(2027, 0, 1, 12), lines));
    expect((dec31 + 1) % lines.length).toBe(jan1);
  });

  it("dayOfYear anchors: Jan 1 → 1, Dec 31 → 365 (366 in a leap year)", () => {
    expect(dayOfYear(new Date(2026, 0, 1, 12))).toBe(1);
    expect(dayOfYear(new Date(2026, 11, 31, 12))).toBe(365);
    expect(dayOfYear(new Date(2024, 11, 31, 12))).toBe(366);
  });

  it("returns empty for an empty list", () => {
    expect(pickLine(new Date(2026, 0, 1), [])).toBe("");
  });
});
