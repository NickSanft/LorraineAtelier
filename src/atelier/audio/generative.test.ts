import { describe, it, expect } from "vitest";
import { bands } from "./generative";

describe("bands", () => {
  it("returns object with bass, mid, high properties", () => {
    const b = bands(0);
    expect(b).toHaveProperty("bass");
    expect(b).toHaveProperty("mid");
    expect(b).toHaveProperty("high");
  });

  it("all bands are finite numbers", () => {
    for (const t of [0, 1000, 5000, 10000, 999999]) {
      const b = bands(t);
      expect(Number.isFinite(b.bass)).toBe(true);
      expect(Number.isFinite(b.mid)).toBe(true);
      expect(Number.isFinite(b.high)).toBe(true);
    }
  });

  it("all bands stay within reasonable bounds [0.0, 0.5]", () => {
    for (const t of [0, 1000, 5000, 10000, 50000, 100000]) {
      const b = bands(t);
      expect(b.bass).toBeGreaterThanOrEqual(0);
      expect(b.bass).toBeLessThanOrEqual(0.5);
      expect(b.mid).toBeGreaterThanOrEqual(0);
      expect(b.mid).toBeLessThanOrEqual(0.5);
      expect(b.high).toBeGreaterThanOrEqual(0);
      expect(b.high).toBeLessThanOrEqual(0.5);
    }
  });

  it("is deterministic (same t gives same output)", () => {
    const a = bands(12345);
    const b = bands(12345);
    expect(a.bass).toBe(b.bass);
    expect(a.mid).toBe(b.mid);
    expect(a.high).toBe(b.high);
  });

  it("values change over time (not constant)", () => {
    const set = new Set([bands(0).bass, bands(1000).bass, bands(5000).bass]);
    expect(set.size).toBeGreaterThan(1);
  });
});
