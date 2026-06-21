import type { CanvasPalette, Sigil } from "../palette";
import type { Bands } from "../audio/generative";

/** Trace a sigil path at the current origin. Does NOT stroke/fill (caller does). */
export function drawGlyphPath(
  ctx: CanvasRenderingContext2D,
  sigil: Sigil,
  s: number,
): void {
  ctx.beginPath();
  if (sigil === "circle") ctx.arc(0, 0, s, 0, 6.2832);
  else if (sigil === "square") ctx.rect(-s * 0.82, -s * 0.82, s * 1.64, s * 1.64);
  else if (sigil === "triangle-up") { ctx.moveTo(0, -s); ctx.lineTo(s * 0.92, s * 0.7); ctx.lineTo(-s * 0.92, s * 0.7); ctx.closePath(); }
  else { ctx.moveTo(0, s); ctx.lineTo(s * 0.92, -s * 0.7); ctx.lineTo(-s * 0.92, -s * 0.7); ctx.closePath(); }
}

/** Map time (ms) to the currently-attuned sigil, cycling through `sigils`. */
export function attuned(t: number, sigils: readonly Sigil[]): Sigil {
  return sigils[Math.floor(t / 4000) % sigils.length];
}

/**
 * Draw the visualizer seal: teal concentric rings, particles, gold spokes and
 * the central sigil. Caller supplies an already-DPR-scaled 2D context and
 * CSS-pixel dimensions. Math identical to the original drawViz().
 */
export function drawViz(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  ts: number,
  b: Bands,
  pal: CanvasPalette,
  activeSigil: Sigil,
): void {
  if (!w || !h) return;
  ctx.clearRect(0, 0, w, h);
  const cx = w / 2, cy = h / 2;
  const R = Math.min(w, h) / 2 - 8;
  const teal = pal.teal, gold = pal.gold;
  ctx.save();
  ctx.translate(cx, cy);
  const rings = [
    { r: R * 0.98, sp: 0.6, wd: 2.2 },
    { r: R * 0.74, sp: -0.9, wd: 1.6 },
    { r: R * 0.5, sp: 1.3, wd: 1.4 },
  ];
  rings.forEach((rg, i) => {
    ctx.beginPath();
    ctx.strokeStyle = teal;
    ctx.globalAlpha = 0.28 + (i === 0 ? b.mid : b.high) * 0.5;
    ctx.lineWidth = rg.wd;
    ctx.setLineDash([2, 10 + b.mid * 14]);
    ctx.lineDashOffset = -ts * 0.01 * rg.sp * (0.5 + b.mid * 2);
    ctx.shadowColor = teal;
    ctx.shadowBlur = 8 + b.bass * 18;
    ctx.arc(0, 0, rg.r, 0, 6.2832);
    ctx.stroke();
  });
  ctx.setLineDash([]);
  const np = 28;
  for (let i = 0; i < np; i++) {
    const ang = (i / np) * 6.2832 + ts * 0.0006 * (1 + b.mid * 3);
    const rr = R * 0.74 + Math.sin(ts * 0.002 + i) * 4;
    const x = Math.cos(ang) * rr, y = Math.sin(ang) * rr;
    const al = 0.25 + b.high * 0.7 * (i % 4 === 0 ? 1 : 0.5);
    ctx.beginPath();
    ctx.fillStyle = teal;
    ctx.globalAlpha = Math.min(1, al);
    ctx.shadowColor = teal;
    ctx.shadowBlur = 10;
    ctx.arc(x, y, 1.4 + b.high * 2.6, 0, 6.2832);
    ctx.fill();
  }
  ctx.globalAlpha = 0.12 + b.high * 0.45;
  ctx.strokeStyle = gold;
  ctx.lineWidth = 0.8;
  ctx.shadowBlur = 0;
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * 6.2832 + ts * 0.00008;
    ctx.beginPath();
    ctx.moveTo(Math.cos(a) * R * 0.5, Math.sin(a) * R * 0.5);
    ctx.lineTo(Math.cos(a) * R * 0.98, Math.sin(a) * R * 0.98);
    ctx.stroke();
  }
  const s = R * 0.2 * (1 + b.bass * 0.5);
  ctx.globalAlpha = 0.7 + b.bass * 0.3;
  ctx.strokeStyle = gold;
  ctx.fillStyle = gold;
  ctx.lineWidth = 2.4;
  ctx.shadowColor = gold;
  ctx.shadowBlur = 14 + b.bass * 26;
  drawGlyphPath(ctx, activeSigil, s);
  ctx.stroke();
  ctx.restore();
  ctx.globalAlpha = 1;
  ctx.shadowBlur = 0;
}
