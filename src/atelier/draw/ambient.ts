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
    // A soft self-coloured glow so motes read against a bright (day) background
    // too, not just the dark night scene; gold motes glow a touch stronger.
    ctx.shadowColor = (m.gold ? pal.glowColor : pal.mote) + "0.9)";
    ctx.shadowBlur = m.gold ? 10 : 7;
    ctx.arc(m.x, m.y, m.r, 0, 6.2832);
    ctx.fill();
  }
  ctx.shadowBlur = 0;
}

// ---- Floatglow lanterns (13.3/13.5): a few soft, warm light-orbs that fade in at
// dusk and drift slowly — a recognizable Witch-Hat-Atelier artifact, larger and
// calmer than the ink-motes. Render-only, additive glow, breathe <=0.5 Hz.

export interface Lantern {
  x: number; // base position as a fraction of width (0..1)
  y: number; // base position as a fraction of height (0..1)
  r: number; // glow radius (px)
  phase: number; // per-lantern phase offset
  spd: number; // bob/breathe speed scale
  drift: number; // horizontal drift scale
}

/** n lanterns scattered over the upper-middle of the scene (uses Math.random). */
export function makeLanterns(n: number): Lantern[] {
  const out: Lantern[] = [];
  for (let i = 0; i < n; i++) {
    out.push({
      x: 0.1 + Math.random() * 0.8,
      y: 0.22 + Math.random() * 0.5,
      r: 26 + Math.random() * 28,
      phase: Math.random() * 6.28,
      spd: 0.6 + Math.random() * 0.6,
      drift: 0.5 + Math.random() * 0.8,
    });
  }
  return out;
}

/**
 * Draw the lanterns at overall `alpha` (the dusk factor: 0 by day, 1 by night). Each
 * drifts slowly and breathes gently (well under 3 Hz). Additive ("lighter") so they
 * read as warm light. Caller supplies an already-DPR-scaled ctx + CSS-pixel dims.
 */
export function drawLanterns(
  ctx: CanvasRenderingContext2D,
  lanterns: Lantern[],
  w: number,
  h: number,
  ts: number,
  alpha: number,
): void {
  if (alpha <= 0.001 || !w || !h) return;
  const t = ts * 0.001;
  ctx.save();
  ctx.globalCompositeOperation = "lighter";
  for (const l of lanterns) {
    const cx = l.x * w + Math.sin(t * 0.12 * l.drift + l.phase) * w * 0.03;
    const cy = l.y * h + Math.cos(t * 0.09 * l.spd + l.phase) * h * 0.025;
    const breathe = 0.78 + 0.22 * Math.sin(t * 0.4 * l.spd + l.phase); // ~0.06 Hz
    const a = alpha * breathe;
    const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, l.r);
    g.addColorStop(0, `rgba(255,214,150,${(0.4 * a).toFixed(3)})`); // warm core glow
    g.addColorStop(0.4, `rgba(240,184,90,${(0.2 * a).toFixed(3)})`);
    g.addColorStop(1, "rgba(240,184,90,0)");
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(cx, cy, l.r, 0, 6.2832);
    ctx.fill();
    ctx.fillStyle = `rgba(255,238,205,${(0.5 * a).toFixed(3)})`; // bright ember core
    ctx.beginPath();
    ctx.arc(cx, cy, 2.4, 0, 6.2832);
    ctx.fill();
  }
  ctx.restore();
}
