import type { CanvasPalette, Sigil } from "../palette";
import type { Bands } from "../audio/generative";
import { drawGlyphPath } from "./viz";

// The visualizer "seal" — an audio-reactive magic circle rendered as drawn INK
// rather than generic glow (Phase 6 ink-magic refinements). It is stateful: bands
// are smoothed with an asymmetric attack/release envelope (snap up, ease down), a
// bass-flux rising edge fires a "beat" that closes the ring + emits a resonance
// ripple, and the concentric rings counter-rotate. Source-agnostic: feed it the
// generative `bands()` (calm reverie — rarely beats) or real WASAPI bands (Phase
// 6b, which beats). The same Bands shape drives both.

export interface Ripple { r: number; a: number }

export interface SealState {
  bass: number;
  mid: number;
  high: number;
  loud: number; // slow loudness envelope → seal size + steadiness
  prevBass: number;
  beat: number; // 0..1, decays after a beat (drives the ring-close flash)
  outer: number; // outer ring rotation
  inner: number; // inner ring counter-rotation
  ripples: Ripple[];
}

export function makeSealState(): SealState {
  return { bass: 0, mid: 0, high: 0, loud: 0, prevBass: 0, beat: 0, outer: 0, inner: 0, ripples: [] };
}

/** Asymmetric one-pole: fast attack on a rise, slow release on a fall. */
function env(cur: number, target: number, attack: number, release: number): number {
  const k = target > cur ? attack : release;
  return cur + (target - cur) * k;
}

/**
 * Advance the seal envelopes/beat/ripples by `dt` seconds. Pure w.r.t. the DOM;
 * mutates `s`. `beatHint` lets a real-audio source force a beat (else it's derived
 * from bass flux, so the generative signal stays calm).
 */
export function stepSeal(s: SealState, b: Bands, dt: number, beatHint = false): void {
  s.bass = env(s.bass, b.bass, 0.6, 0.12);
  s.mid = env(s.mid, b.mid, 0.5, 0.12);
  s.high = env(s.high, b.high, 0.7, 0.16);
  s.loud = env(s.loud, (b.bass + b.mid + b.high) / 3, 0.05, 0.03);

  const flux = b.bass - s.prevBass;
  s.prevBass = b.bass;
  if ((beatHint || flux > 0.05) && s.beat < 0.25) {
    s.beat = 1;
    s.ripples.push({ r: 0, a: 1 });
  }
  s.beat = Math.max(0, s.beat - dt * 2.4);

  s.outer += dt * (0.14 + s.bass * 0.7);
  s.inner -= dt * (0.2 + s.high * 1.0);
  for (const rp of s.ripples) {
    rp.r += dt * (210 + s.loud * 200);
    rp.a -= dt * 0.85;
  }
  s.ripples = s.ripples.filter((rp) => rp.a > 0);
}

/**
 * Render the seal. Caller supplies an already-DPR-scaled 2D context + CSS-pixel
 * dims. Bass thickens the ink (line width + bleed), treble ignites the glyph and
 * keystones, sustained loudness scales the whole seal, and a beat closes the outer
 * ring + sends a resonance ripple outward.
 */
export function drawSeal(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  s: SealState,
  pal: CanvasPalette,
  sigil: Sigil,
): void {
  if (!w || !h) return;
  ctx.clearRect(0, 0, w, h);
  const cx = w / 2, cy = h / 2;
  const R = (Math.min(w, h) / 2 - 8) * (0.9 + s.loud * 0.2); // loudness → size
  const teal = pal.teal, gold = pal.gold;
  ctx.save();
  ctx.translate(cx, cy);

  // resonance ripples (a beat sends ink dispersing outward)
  for (const rp of s.ripples) {
    ctx.beginPath();
    ctx.strokeStyle = teal;
    ctx.globalAlpha = rp.a * 0.5;
    ctx.lineWidth = 1.4 + rp.a * 1.4;
    ctx.shadowColor = teal;
    ctx.shadowBlur = 10 * rp.a;
    ctx.arc(0, 0, rp.r, 0, 6.2832);
    ctx.stroke();
  }

  // three concentric rings; alternating rotation; bass thickens the ink + bleed.
  const rings = [
    { r: R * 0.98, rot: s.outer, band: s.mid, wd: 2.0 },
    { r: R * 0.74, rot: s.inner, band: s.high, wd: 1.5 },
    { r: R * 0.5, rot: s.outer * 1.4, band: s.bass, wd: 1.3 },
  ];
  rings.forEach((rg, i) => {
    ctx.save();
    ctx.rotate(rg.rot);
    ctx.beginPath();
    ctx.strokeStyle = teal;
    ctx.globalAlpha = 0.3 + rg.band * 0.5;
    ctx.lineWidth = rg.wd + s.bass * 2.4; // bass = ink flow (thicker line)
    // on a beat the outer ring "closes" (solid); otherwise it's a drawn dash
    if (i === 0 && s.beat > 0.45) ctx.setLineDash([]);
    else ctx.setLineDash([2, 9 + s.mid * 14]);
    ctx.lineDashOffset = -rg.rot * 60;
    ctx.shadowColor = teal;
    ctx.shadowBlur = 7 + s.bass * 20; // ink bleed
    ctx.arc(0, 0, rg.r, 0, 6.2832);
    ctx.stroke();
    ctx.restore();
  });
  ctx.setLineDash([]);

  // orbiting ink particles with short comet trails (ink has weight, trails off).
  const np = 26;
  for (let i = 0; i < np; i++) {
    const a = (i / np) * 6.2832 + s.outer * 1.6;
    const rr = R * 0.74 + Math.sin(s.inner * 3 + i) * 4;
    const x = Math.cos(a) * rr, y = Math.sin(a) * rr;
    const tail = 0.05 + s.mid * 0.12;
    const xt = Math.cos(a - tail) * rr, yt = Math.sin(a - tail) * rr;
    ctx.beginPath();
    ctx.strokeStyle = teal;
    ctx.globalAlpha = Math.min(1, 0.22 + s.high * 0.7 * (i % 4 === 0 ? 1 : 0.5));
    ctx.lineWidth = 1.2 + s.high * 2.2;
    ctx.lineCap = "round";
    ctx.shadowColor = teal;
    ctx.shadowBlur = 8;
    ctx.moveTo(xt, yt);
    ctx.lineTo(x, y);
    ctx.stroke();
  }

  // gold keystone spokes — treble "ignites" them.
  ctx.shadowBlur = 0;
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * 6.2832 + s.outer * 0.2;
    ctx.beginPath();
    ctx.strokeStyle = gold;
    ctx.globalAlpha = 0.12 + s.high * 0.6;
    ctx.lineWidth = 0.9 + s.high * 1.2;
    ctx.shadowColor = gold;
    ctx.shadowBlur = s.high * 16;
    ctx.moveTo(Math.cos(a) * R * 0.5, Math.sin(a) * R * 0.5);
    ctx.lineTo(Math.cos(a) * R * 0.98, Math.sin(a) * R * 0.98);
    ctx.stroke();
  }

  // central sigil — bass swells it, treble + a beat make it flare gold.
  const size = R * 0.2 * (1 + s.bass * 0.5);
  ctx.globalAlpha = 0.7 + s.bass * 0.3;
  ctx.strokeStyle = gold;
  ctx.lineWidth = 2.2 + s.beat * 1.6;
  ctx.shadowColor = gold;
  ctx.shadowBlur = 12 + s.high * 24 + s.beat * 28;
  drawGlyphPath(ctx, sigil, size);
  ctx.stroke();

  ctx.restore();
  ctx.globalAlpha = 1;
  ctx.shadowBlur = 0;
}
