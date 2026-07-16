import type { Sigil } from "../palette";

// Original, hand-inked element glyphs for the audio-visualizer "seal" centre — a canon-
// FLAVOURED alternative to the alchemical △▽○□ (which the drawing/recognizer keep). Witch
// Hat Atelier's element sigils are bespoke ink glyphs, not the classical element triangles;
// these are our OWN designs evoking each element (fire flame, water droplet + ripples, wind
// triskele, earth rooted seed, light sunburst) — see docs/WHA_MAGIC_RESEARCH.md. Display
// only; the recognizer and the cast bloom still use drawGlyphPath.
//
// Paths are authored in a 120×120 box (centre 60,60); drawElementSigil maps that box to a
// `size`-radius glyph at the current origin via a DOMMatrix, so ctx lineWidth/shadow stay in
// device space (no per-scale compensation) and it renders identically in the browser and in
// the @napi-rs/canvas visual tests.

type Element = "fire" | "water" | "wind" | "earth" | "light";

const SIGIL_TO_ELEMENT: Record<Sigil, Element> = {
  "triangle-up": "fire",
  "triangle-down": "water",
  circle: "wind",
  square: "earth",
};

interface Glyph {
  strokes: string[]; // stroked SVG path data (120-box coords)
  circles?: [number, number, number][]; // stroked circles [cx, cy, r]
  dots?: [number, number, number][]; // filled (gold) circles [cx, cy, r]
  gold?: boolean; // stroke the whole glyph in gold (light)
  wind?: boolean; // special: the single arm, rotated ×3
}

const GLYPHS: Record<Element, Glyph> = {
  fire: {
    strokes: [
      "M60 16 C 78 42 78 66 60 92 C 42 66 42 42 60 16 Z",
      "M60 46 C 69 59 69 72 60 84 C 51 72 51 59 60 46 Z",
      "M46 44 C 37 37 39 27 47 22 C 43 30 46 37 51 41",
      "M74 44 C 83 37 81 27 73 22 C 77 30 74 37 69 41",
    ],
    dots: [[60, 67, 3.4]],
  },
  water: {
    strokes: [
      "M60 16 C 77 46 73 64 60 68 C 47 64 43 46 60 16 Z",
      "M60 16 C 59 12 63 10 62 7",
      "M34 78 q 13 -9 26 0 q 13 9 26 0",
      "M40 88 q 10 -7 20 0 q 10 7 20 0",
    ],
    dots: [[60, 48, 2.6]],
  },
  wind: {
    strokes: ["M60 55 C 55 41 69 33 81 39 C 73 37 66 46 64 56"],
    wind: true,
  },
  earth: {
    strokes: [
      "M30 72 L 90 72",
      "M60 72 C 57 82 49 86 43 93",
      "M60 72 C 63 82 71 86 77 93",
      "M60 72 L 60 94",
      "M60 72 L 60 50",
      "M60 55 C 51 53 47 45 49 39 C 55 43 60 49 60 55 Z",
      "M60 51 C 69 49 73 41 71 35 C 65 39 60 45 60 51 Z",
    ],
    dots: [[60, 72, 3.2]],
  },
  light: {
    strokes: [
      "M60 45 L60 20", "M60 75 L60 100", "M45 60 L20 60", "M75 60 L100 60",
      "M50 50 L41 41", "M70 50 L79 41", "M50 70 L41 79", "M70 70 L79 79",
    ],
    circles: [[60, 60, 6]],
    dots: [[60, 60, 2.4]],
    gold: true,
  },
};

const TAU = 6.28318530718;

// Trace an SVG path (the subset our glyphs use: M/L/C/Q/Z, absolute + relative) onto the
// context with plain moveTo/lineTo/bezierCurveTo/quadraticCurveTo — no Path2D, so it runs
// under both WebView2 and node/@napi-rs/canvas (matching drawGlyphPath's approach). Caller
// wraps in beginPath()/stroke().
function tracePath(ctx: CanvasRenderingContext2D, d: string): void {
  const toks = d.match(/[a-zA-Z]|-?\d*\.?\d+/g) || [];
  let i = 0, cx = 0, cy = 0, sx = 0, sy = 0, cmd = "";
  const n = () => parseFloat(toks[i++]);
  while (i < toks.length) {
    if (/[a-zA-Z]/.test(toks[i])) cmd = toks[i++];
    const rel = cmd === cmd.toLowerCase();
    switch (cmd.toUpperCase()) {
      case "M": { let x = n(), y = n(); if (rel) { x += cx; y += cy; } ctx.moveTo(x, y); cx = sx = x; cy = sy = y; cmd = rel ? "l" : "L"; break; }
      case "L": { let x = n(), y = n(); if (rel) { x += cx; y += cy; } ctx.lineTo(x, y); cx = x; cy = y; break; }
      case "C": { let x1 = n(), y1 = n(), x2 = n(), y2 = n(), x = n(), y = n(); if (rel) { x1 += cx; y1 += cy; x2 += cx; y2 += cy; x += cx; y += cy; } ctx.bezierCurveTo(x1, y1, x2, y2, x, y); cx = x; cy = y; break; }
      case "Q": { let x1 = n(), y1 = n(), x = n(), y = n(); if (rel) { x1 += cx; y1 += cy; x += cx; y += cy; } ctx.quadraticCurveTo(x1, y1, x, y); cx = x; cy = y; break; }
      case "Z": ctx.closePath(); cx = sx; cy = sy; break;
      default: i++;
    }
  }
}

/**
 * Stroke the element glyph for `sigil` at `size`-radius, centred at the current origin.
 * The caller sets lineWidth / globalAlpha / shadowBlur (audio-reactive); this sets the ink
 * colour (teal glyphs with gold accents; light is all gold) and its own shadow colour.
 * Scales the 120-box into place with the plain 2D transform (no DOMMatrix, so it renders
 * in both WebView2 and the node/@napi-rs/canvas visual tests), compensating the caller's
 * device-space line weight / shadow for the scale.
 */
export function drawElementSigil(
  ctx: CanvasRenderingContext2D,
  sigil: Sigil,
  size: number,
  teal: string,
  gold: string,
): void {
  const g = GLYPHS[SIGIL_TO_ELEMENT[sigil]];
  const ink = g.gold ? gold : teal;
  const k = size / 44; // 44 ≈ the glyph's half-extent in the 120 box
  const dw = ctx.lineWidth, db = ctx.shadowBlur; // device-space, set by the caller
  ctx.save();
  ctx.scale(k, k);
  ctx.translate(-60, -60); // box (60,60) → the seal centre (the current origin)
  ctx.lineWidth = dw / k; // keep the caller's device line weight through the scale
  ctx.shadowBlur = db / k;
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  ctx.strokeStyle = ink;
  ctx.fillStyle = gold;
  ctx.shadowColor = ink;

  if (g.wind) {
    for (let i = 0; i < 3; i++) {
      ctx.save();
      ctx.translate(60, 60); // rotate the arm about the box centre
      ctx.rotate((i * TAU) / 3);
      ctx.translate(-60, -60);
      ctx.beginPath(); tracePath(ctx, g.strokes[0]); ctx.stroke();
      ctx.beginPath(); ctx.arc(81, 39, 1.8, 0, TAU); ctx.fill(); // arm-tip dot
      ctx.restore();
    }
    ctx.beginPath(); ctx.arc(60, 60, 2.6, 0, TAU); ctx.fill(); // hub
  } else {
    for (const d of g.strokes) { ctx.beginPath(); tracePath(ctx, d); ctx.stroke(); }
    if (g.circles) for (const [x, y, r] of g.circles) { ctx.beginPath(); ctx.arc(x, y, r, 0, TAU); ctx.stroke(); }
    if (g.dots) for (const [x, y, r] of g.dots) { ctx.beginPath(); ctx.arc(x, y, r, 0, TAU); ctx.fill(); }
  }
  ctx.restore();
}
