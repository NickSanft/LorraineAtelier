// Visual-regression harness for the wallpaper's PURE canvas draw modules.
//
// Each case renders a draw function to an offscreen Skia canvas (@napi-rs/canvas —
// prebuilt, no native build, deterministic) with FIXED inputs, exports a PNG, and
// pixel-diffs it against a committed baseline. A change that alters a widget's look
// beyond a small tolerance fails the test, so future edits can't silently drift.
//
// Baselines live in tests/visual/baselines/. Regenerate them intentionally with
//   pnpm test:visual:update
// (review the PNG diff under tests/visual/__diffs__/ before committing new ones).
//
// The harness renders with Skia, not Chromium, so it tracks OUR code rather than the
// browser — exactly what we want for catching regressions. It targets only the pure,
// DOM-free modules (seal/viz/glyph/ambient); DOM-coupled effects (bird, petrify) and
// font-dependent widgets (clock/dock) are out of scope.

import { describe, it, expect } from "vitest";
import { createCanvas } from "@napi-rs/canvas";
import { readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { PNG } from "pngjs";
import pixelmatch from "pixelmatch";

import { PAL, SIGILS } from "../../src/atelier/palette";
import type { Bands } from "../../src/atelier/audio/generative";
import { drawSeal, makeSealState } from "../../src/atelier/draw/seal";
import { drawViz, drawGlyphPath } from "../../src/atelier/draw/viz";
import { drawAmbient, type Mote } from "../../src/atelier/draw/ambient";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BASE = join(__dirname, "baselines");
const DIFF = join(__dirname, "__diffs__");
const UPDATE = process.env.UPDATE_VISUAL === "1";

// Per-pixel colour tolerance (pixelmatch) + the max fraction of pixels allowed to
// differ. A genuine widget change moves far more than this; AA/blur noise moves far
// less. Tuned so the suite is stable but real regressions fail loudly.
const PIXEL_THRESHOLD = 0.12;
const MAX_DIFF_RATIO = 0.02;

// Deterministic inputs (no Math.random / Date.now anywhere in the draw paths below).
const BANDS: Bands = { bass: 0.55, mid: 0.42, high: 0.3 };
const TS = 12_000; // a fixed timestamp for time-driven motion

function renderPNG(w: number, h: number, draw: (ctx: CanvasRenderingContext2D) => void): Buffer {
  const canvas = createCanvas(w, h);
  const ctx = canvas.getContext("2d") as unknown as CanvasRenderingContext2D;
  draw(ctx);
  return canvas.toBuffer("image/png");
}

function compare(name: string, png: Buffer): void {
  const baseline = join(BASE, `${name}.png`);
  if (UPDATE || !existsSync(baseline)) {
    mkdirSync(BASE, { recursive: true });
    writeFileSync(baseline, png);
    if (!UPDATE) {
      throw new Error(`Visual baseline "${name}" was missing — created it. Re-run the suite to verify, and commit tests/visual/baselines/${name}.png.`);
    }
    return; // --update: accept the new baseline
  }
  const expected = PNG.sync.read(readFileSync(baseline));
  const actual = PNG.sync.read(png);
  expect(actual.width, `${name}: width`).toBe(expected.width);
  expect(actual.height, `${name}: height`).toBe(expected.height);
  const diff = new PNG({ width: expected.width, height: expected.height });
  const changed = pixelmatch(expected.data, actual.data, diff.data, expected.width, expected.height, { threshold: PIXEL_THRESHOLD });
  const ratio = changed / (expected.width * expected.height);
  if (ratio > MAX_DIFF_RATIO) {
    mkdirSync(DIFF, { recursive: true });
    writeFileSync(join(DIFF, `${name}.actual.png`), png);
    writeFileSync(join(DIFF, `${name}.diff.png`), PNG.sync.write(diff));
  }
  expect(
    ratio,
    `${name}: ${(ratio * 100).toFixed(2)}% of pixels changed (> ${(MAX_DIFF_RATIO * 100).toFixed(0)}%). If intentional, run \`pnpm test:visual:update\`; otherwise see tests/visual/__diffs__/${name}.diff.png`,
  ).toBeLessThanOrEqual(MAX_DIFF_RATIO);
}

// A fixed, mid-energy seal state (so rings/particles/keystones/sigil all render).
function fixedSeal() {
  const s = makeSealState();
  s.bass = 0.55; s.mid = 0.42; s.high = 0.3; s.loud = 0.5; s.prevBass = 0.5;
  s.beat = 0.4; s.outer = 0.8; s.inner = -0.6;
  s.ripples = [{ r: 36, a: 0.5 }];
  return s;
}

// A fixed mote field (built by hand so makeMotes' Math.random is never hit; none sit
// near the top edge, so drawAmbient's wrap-around RNG is never triggered either).
function fixedMotes(): Mote[] {
  const out: Mote[] = [];
  for (let i = 0; i < 24; i++) {
    out.push({
      x: ((i * 53) % 280) + 10,
      y: ((i * 89) % 150) + 30,
      r: 0.8 + (i % 5) * 0.35,
      s: 0.2 + (i % 4) * 0.1,
      d: (i * 0.7) % 6.28,
      a: 0.15 + (i % 3) * 0.12,
      gold: i % 6 === 0,
    });
  }
  return out;
}

describe("visual regression — pure draw modules", () => {
  for (const mode of ["night", "day"] as const) {
    it(`seal (${mode})`, () => {
      compare(`seal-${mode}`, renderPNG(300, 300, (ctx) => drawSeal(ctx, 300, 300, fixedSeal(), PAL[mode], "circle")));
    });

    it(`viz (${mode})`, () => {
      compare(`viz-${mode}`, renderPNG(300, 300, (ctx) => drawViz(ctx, 300, 300, TS, BANDS, PAL[mode], "triangle-up")));
    });

    it(`ambient (${mode})`, () => {
      compare(`ambient-${mode}`, renderPNG(300, 200, (ctx) => drawAmbient(ctx, fixedMotes(), 300, 200, TS, BANDS, PAL[mode])));
    });
  }

  for (const sigil of SIGILS) {
    it(`glyph ${sigil}`, () => {
      compare(`glyph-${sigil}`, renderPNG(96, 96, (ctx) => {
        ctx.save();
        ctx.translate(48, 48);
        ctx.strokeStyle = PAL.night.gold;
        ctx.lineWidth = 3;
        drawGlyphPath(ctx, sigil, 30);
        ctx.stroke();
        ctx.restore();
      }));
    });
  }
});
