import { describe, it, expect } from "vitest";
import { makeSealState, stepSeal } from "./seal";

const B = (bass: number, mid: number, high: number) => ({ bass, mid, high });

describe("stepSeal", () => {
  it("envelopes converge toward the band targets", () => {
    const s = makeSealState();
    for (let i = 0; i < 120; i++) stepSeal(s, B(0.4, 0.3, 0.2), 0.016);
    expect(s.bass).toBeGreaterThan(0.35);
    expect(s.bass).toBeLessThanOrEqual(0.4001);
    expect(s.mid).toBeGreaterThan(0.25);
    expect(s.high).toBeGreaterThan(0.15);
  });

  it("a beat hint spawns a resonance ripple and lights the beat flash", () => {
    const s = makeSealState();
    stepSeal(s, B(0.2, 0.2, 0.2), 0.016, true);
    expect(s.ripples.length).toBe(1);
    expect(s.beat).toBeGreaterThan(0.5);
  });

  it("rings advance and ripples expand then fade out", () => {
    const s = makeSealState();
    stepSeal(s, B(0.2, 0.2, 0.2), 0.016, true);
    const outer0 = s.outer;
    for (let i = 0; i < 200; i++) stepSeal(s, B(0.2, 0.2, 0.2), 0.05);
    expect(s.outer).toBeGreaterThan(outer0);
    expect(s.ripples.length).toBe(0);
  });
});
