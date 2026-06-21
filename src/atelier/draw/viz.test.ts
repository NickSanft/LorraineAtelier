import { describe, it, expect, beforeEach, vi } from "vitest";
import { drawGlyphPath, attuned } from "./viz";
import { SIGILS } from "../palette";

describe("drawGlyphPath", () => {
  let mockCtx: CanvasRenderingContext2D;

  beforeEach(() => {
    mockCtx = {
      beginPath: vi.fn(),
      arc: vi.fn(),
      rect: vi.fn(),
      moveTo: vi.fn(),
      lineTo: vi.fn(),
      closePath: vi.fn(),
    } as unknown as CanvasRenderingContext2D;
  });

  it("calls beginPath for every sigil", () => {
    for (const sigil of SIGILS) {
      (mockCtx.beginPath as ReturnType<typeof vi.fn>).mockClear();
      drawGlyphPath(mockCtx, sigil, 10);
      expect(mockCtx.beginPath).toHaveBeenCalled();
    }
  });

  it("calls arc for circle", () => {
    drawGlyphPath(mockCtx, "circle", 5);
    expect(mockCtx.arc).toHaveBeenCalled();
  });

  it("calls rect for square", () => {
    drawGlyphPath(mockCtx, "square", 5);
    expect(mockCtx.rect).toHaveBeenCalled();
  });

  it("calls moveTo/lineTo for triangle-up", () => {
    drawGlyphPath(mockCtx, "triangle-up", 5);
    expect(mockCtx.moveTo).toHaveBeenCalled();
    expect(mockCtx.lineTo).toHaveBeenCalled();
  });

  it("calls moveTo/lineTo for triangle-down", () => {
    drawGlyphPath(mockCtx, "triangle-down", 5);
    expect(mockCtx.moveTo).toHaveBeenCalled();
    expect(mockCtx.lineTo).toHaveBeenCalled();
  });
});

describe("attuned", () => {
  it("cycles through SIGILS over time and wraps", () => {
    const seq: string[] = [];
    for (let t = 0; t < 20000; t += 4000) seq.push(attuned(t, SIGILS));
    expect(seq[0]).toBe(SIGILS[0]);
    expect(seq[1]).toBe(SIGILS[1]);
    expect(seq[2]).toBe(SIGILS[2]);
    expect(seq[3]).toBe(SIGILS[3]);
    expect(seq[4]).toBe(SIGILS[0]); // wraps
  });

  it("returns a valid sigil for any time", () => {
    for (const t of [0, 1000, 5000, 100000, 999999]) {
      expect(SIGILS).toContain(attuned(t, SIGILS));
    }
  });
});
