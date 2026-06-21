import type { CanvasPalette } from "../palette";
import type { Bands } from "../audio/generative";

export interface Mote {
  x: number;
  y: number;
  r: number;    // radius
  s: number;    // speed
  d: number;    // direction/phase
  a: number;    // alpha base
  gold: boolean; // glowing (gold) mote
}

/**
 * Factory: create n motes randomly distributed across a w x h canvas.
 * Uses Math.random() (non-deterministic) — matches original initAmbient().
 */
export function makeMotes(w: number, h: number, n: number): Mote[] {
  const motes: Mote[] = [];
  for (let i = 0; i < n; i++) {
    motes.push({
      x: Math.random() * w, y: Math.random() * h,
      r: 0.6 + Math.random() * 2.0, s: 0.15 + Math.random() * 0.5,
      d: Math.random() * 6.28, a: 0.1 + Math.random() * 0.4, gold: Math.random() < 0.16,
    });
  }
  return motes;
}

/**
 * Update + draw ambient motes. MUTATES the motes array (advances positions).
 * Caller supplies an already-DPR-scaled 2D context and CSS-pixel dimensions.
 */
export function drawAmbient(
  ctx: CanvasRenderingContext2D,
  motes: Mote[],
  w: number,
  h: number,
  ts: number,
  b: Bands,
  pal: CanvasPalette,
): void {
  ctx.clearRect(0, 0, w, h);
  for (const m of motes) {
    m.y -= m.s * (0.6 + b.mid * 1.6);
    m.x += Math.sin(ts * 0.0004 + m.d) * 0.25;
    if (m.y < -6) { m.y = h + 6; m.x = Math.random() * w; }
    const col = m.gold ? pal.glowColor : pal.mote;
    const al = m.a * (0.5 + 0.5 * Math.sin(ts * 0.001 + m.d));
    ctx.beginPath();
    ctx.fillStyle = col + al.toFixed(3) + ")";
    if (m.gold) { ctx.shadowColor = pal.glowColor + "0.8)"; ctx.shadowBlur = 8; } else ctx.shadowBlur = 0;
    ctx.arc(m.x, m.y, m.r, 0, 6.2832);
    ctx.fill();
  }
  ctx.shadowBlur = 0;
}
