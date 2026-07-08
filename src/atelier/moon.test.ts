import { describe, it, expect } from "vitest";
import { moonIllumination, moonPhase, SYNODIC_DAYS } from "./moon";

// Distance from a phase to "new" on the circular 0..1 scale.
const distToNew = (p: number) => Math.min(p, 1 - p);

describe("moon", () => {
  it("the epoch new moon reads as phase ~0", () => {
    expect(distToNew(moonPhase(new Date(Date.UTC(2000, 0, 6, 18, 14))))).toBeLessThan(0.001);
  });

  it("the 2000-01-21 04:40 UTC full moon reads as ~0.5", () => {
    expect(Math.abs(moonPhase(new Date(Date.UTC(2000, 0, 21, 4, 40))) - 0.5)).toBeLessThan(0.02);
  });

  it("the 2024-01-11 11:57 UTC new moon (297 cycles later) reads as ~0", () => {
    expect(distToNew(moonPhase(new Date(Date.UTC(2024, 0, 11, 11, 57))))).toBeLessThan(0.02);
  });

  it("advances by one day ≈ 1/synodic-month of phase", () => {
    const d1 = new Date(Date.UTC(2026, 6, 8, 12));
    const d2 = new Date(Date.UTC(2026, 6, 9, 12));
    const delta = (moonPhase(d2) - moonPhase(d1) + 1) % 1;
    expect(Math.abs(delta - 1 / SYNODIC_DAYS)).toBeLessThan(1e-9);
  });

  it("illumination: new → 0, quarters → 0.5, full → 1", () => {
    expect(moonIllumination(0)).toBeCloseTo(0, 6);
    expect(moonIllumination(0.25)).toBeCloseTo(0.5, 6);
    expect(moonIllumination(0.5)).toBeCloseTo(1, 6);
    expect(moonIllumination(0.75)).toBeCloseTo(0.5, 6);
  });
});
