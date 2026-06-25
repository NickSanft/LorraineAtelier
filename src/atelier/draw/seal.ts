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
  tempo: number; // eased pace 0..1 (14.2); scales the rotation/ripple cadence
}

export function makeSealState(): SealState {
  return { bass: 0, mid: 0, high: 0, loud: 0, prevBass: 0, beat: 0, outer: 0, inner: 0, ripples: [], tempo: 0.35 };
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
export function stepSeal(s: SealState, b: Bands, dt: number, beatHint = false, tempo = 0.35, ringSpeed = 1): void {
  s.tempo += (tempo - s.tempo) * Math.min(1, dt * 1.5); // ease toward the music's pace
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

  const tf = 0.65 + s.tempo; // pace factor (~1.0 at the calm default; faster music spins quicker)
  const rotf = tf * ringSpeed; // ring rotation also scaled by the user's ring-speed toggle
  s.outer += dt * (0.14 + s.bass * 0.7) * rotf;
  s.inner -= dt * (0.2 + s.high * 1.0) * rotf;
  for (const rp of s.ripples) {
    rp.r += dt * (90 + s.loud * 100) * tf; // ripples follow the music's pace (not the ring-speed)
    rp.a -= dt * 0.5; // slower fade
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
  // The canvas is larger than the seal so ripples have room; keep the rings their
  // original on-screen size by shrinking the radius fraction to match (0.88 → 0.57).
  const R = (Math.min(w, h) / 2 - 8) * (0.57 + s.loud * 0.18 + s.bass * 0.06); // loudness/bass → size
  const teal = pal.teal, gold = pal.gold;
  ctx.save();
  ctx.translate(cx, cy);

  // resonance ripples (a beat sends ink dispersing outward). They fade to nothing as
  // they near the enlarged canvas edge, so they dissolve cleanly instead of clipping.
  const rmax = Math.min(w, h) / 2 - 4;
  for (const rp of s.ripples) {
    const edge = Math.max(0, 1 - rp.r / rmax);
    ctx.beginPath();
    ctx.strokeStyle = teal;
    ctx.globalAlpha = rp.a * 0.5 * edge;
    ctx.lineWidth = 1.4 + rp.a * 1.4;
    ctx.shadowColor = teal;
    ctx.shadowBlur = 10 * rp.a;
    ctx.arc(0, 0, rp.r, 0, 6.2832);
    ctx.stroke();
  }

  // three concentric rings; alternating rotation; bass thickens the ink + bleed.
  // `frac` is the radius as a fraction of R; the dash count is derived from the
  // STABLE (un-breathing) radius so the pattern tiles the circle EXACTLY (no seam,
  // no "not-quite-a-circle" discontinuity) and never pops when the seal breathes.
  const baseR = (Math.min(w, h) / 2 - 8) * 0.57; // R at loud=bass=0 (matches the radius above)
  const DASH_PERIOD = 14; // nominal px between dashes → ~clean long-dash look
  const rings = [
    { frac: 0.98, rot: s.outer, band: s.mid, wd: 2.0 },
    { frac: 0.74, rot: s.inner, band: s.high, wd: 1.5 },
    { frac: 0.5, rot: s.outer * 1.4, band: s.bass, wd: 1.3 },
  ];
  rings.forEach((rg, i) => {
    const isOuter = i === 0;
    const r = R * rg.frac; // actual (audio-breathing) radius
    const n = Math.max(24, Math.round((2 * Math.PI * baseR * rg.frac) / DASH_PERIOD)); // stable dash count
    const period = (2 * Math.PI * r) / n; // tiles the actual circumference exactly
    // dash FRACTION (not gap) carries the breathing: the outer ring "closes" on a
    // beat by growing its dashes toward solid; inner rings shimmer subtly. Keeping
    // the period = circ/n fixed means the dash count never changes → clean circle.
    const dashFrac = isOuter ? 0.15 + 0.7 * s.beat : 0.14 + 0.12 * rg.band;
    const dash = Math.max(0.6, period * dashFrac);
    ctx.save();
    ctx.rotate(rg.rot);
    ctx.beginPath();
    ctx.strokeStyle = teal;
    // The outer ring breathes on the SLOW loudness envelope (gradual); the inner
    // rings snap with bass (lively). Keeps the outermost circle from flickering.
    ctx.globalAlpha = 0.32 + (isOuter ? s.loud * 0.5 : rg.band * 0.6);
    ctx.lineWidth = rg.wd + rg.band * 1.4 + (isOuter ? s.loud * 2.2 : s.bass * 3.2);
    ctx.setLineDash([dash, Math.max(0.6, period - dash)]);
    ctx.lineDashOffset = -rg.rot * 60;
    ctx.shadowColor = teal;
    ctx.shadowBlur = 7 + (isOuter ? s.loud * 14 : s.bass * 20); // ink bleed
    ctx.arc(0, 0, r, 0, 6.2832);
    ctx.stroke();
    ctx.restore();
  });
  ctx.setLineDash([]);

  // orbiting ink particles with short comet trails (ink has weight, trails off).
  const np = 26;
  const energy = s.mid * 0.55 + s.high * 0.7; // mid+treble drive particle vigor
  for (let i = 0; i < np; i++) {
    const a = (i / np) * 6.2832 + s.outer * 1.6;
    // particles push outward on bass and wobble on mid → clearly audio-reactive
    // even on bass-heavy music (treble alone is often too sparse to notice).
    const rr = R * (0.66 + s.bass * 0.18) + Math.sin(s.inner * 3 + i) * (3 + s.mid * 10);
    const x = Math.cos(a) * rr, y = Math.sin(a) * rr;
    const tail = 0.05 + s.mid * 0.22 + s.high * 0.1; // longer comet with energy
    const xt = Math.cos(a - tail) * rr, yt = Math.sin(a - tail) * rr;
    ctx.beginPath();
    ctx.strokeStyle = teal;
    ctx.globalAlpha = Math.min(1, 0.2 + energy * 1.1 * (i % 4 === 0 ? 1 : 0.55));
    ctx.lineWidth = 1.3 + energy * 4.0;
    ctx.lineCap = "round";
    ctx.shadowColor = teal;
    ctx.shadowBlur = 7 + energy * 14;
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
    ctx.globalAlpha = 0.15 + s.high * 0.9;
    ctx.lineWidth = 1.0 + s.high * 1.8;
    ctx.shadowColor = gold;
    ctx.shadowBlur = s.high * 26;
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
