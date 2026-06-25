export {}; // module scope

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { PageFlip } from "page-flip/dist/js/page-flip.module.js";
import { drawGlyphPath } from "./atelier/draw/viz";
import type { Sigil } from "./atelier/palette";

// Casting overlay — the two-phase slate (the ONLY surface that takes pointer
// input; the wallpaper behind the icons cannot). Draw the central SIGIL, then
// close the RING to seal it. Recognition is authoritative in Rust (classify_sigil
// / analyze_ring); fire_spell commits the cast (launch + bloom).
//
// Canon refinements (5c):
//  • Light = the Fire triangle + a small CENTRE DOT (a second mark) → upgrades to
//    the 5th element. Detected here in the overlay (no recognizer change).
//  • Three-axis neatness: Size (here) / Steadiness / Symmetry (from Rust).
//  • Closing-dot instant-cast: a ring drawn with a gap becomes a PREPARED seal you
//    ignite with a single dot — the iconic instant-cast.

type Pt = { x: number; y: number };
interface SpellDto { key: string; element: string; glyph: string; app: string; hue: string; sigil: string }
interface SigilDto { kind: string; base: string; score: number; sideways: boolean; jutDir: number; secret: boolean; spell: SpellDto | null; symmetry: number; steadiness: number }
interface RingDto { closed: boolean; encloses: boolean; inverse: boolean; score: number; gap: number }
interface FireDto { launched: boolean; cursed: boolean; dismissed: boolean; message: string; icon: string; ink: number; key: string; born: boolean }

const TEAL = "#2fd6c6";
const GOLD = "#e8b84a";
// Client-side Light spell (Rust resolves key "light" → cosmetic illumination).
const LIGHT: SpellDto = { key: "light", element: "Light", glyph: "✦", app: "the atelier", hue: "#f5d27e", sigil: "triangle-up" };

const cast = document.getElementById("cast") as HTMLCanvasElement;
const cctx = cast.getContext("2d")!;
const phaseLabel = document.getElementById("phaseLabel")!;
const hudGlyph = document.getElementById("hudGlyph")!;
const hudName = document.getElementById("hudName")!;
const hudApp = document.getElementById("hudApp")!;
const barSize = document.getElementById("barSize") as HTMLElement;
const barSteady = document.getElementById("barSteady") as HTMLElement;
const barSym = document.getElementById("barSym") as HTMLElement;
const toast = document.getElementById("toast") as HTMLElement;
const toastIcon = document.getElementById("toastIcon")!;
const toastMsg = document.getElementById("toastMsg")!;
const slate = document.getElementById("slate") as HTMLElement;
const scrim = document.getElementById("scrim") as HTMLElement;
const storybook = document.getElementById("storybook") as HTMLElement;
const sbBook = document.getElementById("sbBook")!;
const sbCoverEl = document.getElementById("sbCover")!;
const sbDots = document.getElementById("sbDots")!;
const sbTurn = document.getElementById("sbTurn") as HTMLButtonElement;
const namingRite = document.getElementById("namingRite") as HTMLElement;
const nrBug = document.getElementById("nrBug") as HTMLImageElement;
const nrInput = document.getElementById("nrInput") as HTMLInputElement;
const nrName = document.getElementById("nrName") as HTMLButtonElement;
const nrLater = document.getElementById("nrLater") as HTMLButtonElement;

interface GiftDto { recipientName: string; heading: string; paragraphs: string[]; signature: string; birthday: string }

let W = 0, H = 0;
function resize() {
  const dpr = window.devicePixelRatio || 1;
  const r = cast.getBoundingClientRect();
  W = r.width; H = r.height;
  cast.width = Math.max(1, Math.round(W * dpr));
  cast.height = Math.max(1, Math.round(H * dpr));
  cctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  drawCast();
}
window.addEventListener("resize", resize);

// ---- casting state ----
type Phase = "sigil" | "ring";
let phase: Phase = "sigil";
let strokes: Pt[][] = [];
let curStroke: Pt[] | null = null;
let detected: SigilDto | null = null;
let sigilCenter: Pt | null = null;
let sigilScore = 0;
let sigilDiag = 0;
let prepared: { inverse: boolean; ringScore: number } | null = null;
let blooming = false;
let bloomRaf = 0;
let storybookOpen = false;
let namingOpen = false; // the first-cast naming rite is on screen (captures Enter/Esc)

function reset() {
  cancelAnimationFrame(bloomRaf);
  phase = "sigil"; strokes = []; curStroke = null; detected = null;
  sigilCenter = null; sigilScore = 0; sigilDiag = 0; prepared = null; blooming = false;
  storybook.style.display = "none"; // back to the casting slate
  namingRite.style.display = "none";
  slate.style.display = "flex";
  storybookOpen = false;
  namingOpen = false;
  phaseLabel.textContent = "Draw the central sigil";
  hudGlyph.textContent = "·"; hudGlyph.style.color = "var(--c-soft)";
  hudName.textContent = "Awaiting sigil"; hudApp.textContent = "—";
  setMeters(0, 0, 0);
  toast.style.display = "none";
  drawCast();
}

function pt(e: PointerEvent): Pt {
  const r = cast.getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top };
}

function bboxDiag(stroke: Pt[]): number {
  let mnx = 1e9, mny = 1e9, mxx = -1e9, mxy = -1e9;
  for (const p of stroke) { mnx = Math.min(mnx, p.x); mny = Math.min(mny, p.y); mxx = Math.max(mxx, p.x); mxy = Math.max(mxy, p.y); }
  return Math.hypot(mxx - mnx, mxy - mny);
}
// A small mark (a dot/tap) vs a ring: a ring must be large enough to enclose the sigil.
function isSmallMark(stroke: Pt[]): boolean {
  return bboxDiag(stroke) < Math.min(W, H) * 0.13;
}

cast.addEventListener("pointerdown", (e) => {
  if (blooming) return;
  e.preventDefault();
  cast.setPointerCapture(e.pointerId);
  curStroke = [pt(e)];
});
cast.addEventListener("pointermove", (e) => {
  if (!curStroke || blooming) return;
  curStroke.push(pt(e)); // the idle loop redraws each frame
});
cast.addEventListener("pointerup", () => {
  if (!curStroke || blooming) return;
  const stroke = curStroke; curStroke = null;

  if (phase === "sigil") {
    if (stroke.length < 4) return; // too short to be a sigil
    strokes.push(stroke);
    handleSigil(stroke);
    return;
  }

  // ring phase — a small mark (incl. a single-point tap) is a dot: it ignites a
  // prepared seal, or dots the centre of a Fire triangle to gather Light.
  const small = isSmallMark(stroke);
  if (prepared && small) { ignitePrepared(); return; }
  if (!prepared && small && detected?.spell?.key === "fire") { upgradeToLight(); return; }
  // Wind ○ + a centre dot = the canon decorative "bird" sigil — a bird takes wing.
  if (!prepared && small && detected?.spell?.key === "wind") { conjureBird(); return; }
  if (stroke.length < 4) return; // a stray short stroke that isn't a dot we handle
  strokes.push(stroke);
  handleRing(stroke);
});

async function handleSigil(stroke: Pt[]) {
  let res: SigilDto;
  try { res = await invoke<SigilDto>("classify_sigil", { points: stroke }); }
  catch { return; }
  if (res.secret) {
    void invoke("mark_secret_found");
    openStorybook();
    return;
  }
  if (!res.spell) {
    showToast("The sigil is unclear, mono-shirazu — try again.", "✦");
    strokes.pop();
    return;
  }
  detected = res;
  let sx = 0, sy = 0;
  for (const p of stroke) { sx += p.x; sy += p.y; }
  sigilCenter = { x: sx / stroke.length, y: sy / stroke.length };
  sigilScore = res.score;
  sigilDiag = bboxDiag(stroke);
  phase = "ring";
  phaseLabel.textContent = "Close the ring — or dot the centre for Light";
  showReading(res.spell);
  // Size is relative to the slate; Steadiness/Symmetry come from Rust.
  const size = Math.max(0, Math.min(1, sigilDiag / (Math.min(W, H) * 0.6)));
  setMeters(size * 100, res.steadiness * 100, res.symmetry * 100);
}

function upgradeToLight() {
  if (!detected) return;
  detected.spell = LIGHT;
  phaseLabel.textContent = "Light gathers — now close the ring";
  showReading(LIGHT);
}

// Decorative sigil egg: conjure a magic bird (it flies across the wallpaper). Free
// and cosmetic — no app, no ink; close the slate so the bird is seen.
function conjureBird() {
  blooming = true; // freeze input through the close
  showToast("✦ A bird takes wing from the page.", "✦");
  void invoke("conjure_bird");
  setTimeout(() => hide(), 800);
}

async function handleRing(stroke: Pt[]) {
  if (!detected?.spell || !sigilCenter) return;
  let ring: RingDto;
  try { ring = await invoke<RingDto>("analyze_ring", { points: stroke, center: sigilCenter }); }
  catch { return; }
  if (ring.closed && ring.encloses) { seal(ring.inverse, ring.score); return; }
  if (ring.encloses && ring.gap < 0.6) {
    // A deliberate gap → a prepared seal, ignited later by a single dot.
    prepared = { inverse: ring.inverse, ringScore: ring.score };
    phaseLabel.textContent = "Seal prepared — dot the gap to ignite";
    showToast("A gap remains — dot it to ignite.", "◌");
    return;
  }
  if (!ring.encloses) { failRing("The ring must enclose the sigil — it fizzles."); return; }
  failRing("The ring broke — the seal fizzles, dormant.");
}

function ignitePrepared() {
  if (!prepared) return;
  const { inverse, ringScore } = prepared;
  seal(inverse, ringScore);
}

async function seal(inverse: boolean, ringScore: number) {
  if (!detected?.spell) return;
  const finalScore = Math.round(sigilScore * 0.5 + ringScore * 0.5);
  const spell = detected.spell;
  let fire: FireDto;
  try {
    fire = await invoke<FireDto>("fire_spell", {
      key: spell.key, score: finalScore, inverse,
      sideways: detected.sideways, jutDir: detected.jutDir, symmetry: detected.symmetry,
    });
  } catch { return; }
  prepared = null;
  bloom(spell.sigil as Sigil, finalScore, inverse, detected.sideways, detected.jutDir, fire);
}

// The element's colour, read from the --el-<key> CSS var so the colorblind toggle
// (a `cb` class on body, swapping to Okabe-Ito) flows through to the canvas too.
function elColor(key: string): string {
  return getComputedStyle(document.body).getPropertyValue(`--el-${key}`).trim() || TEAL;
}

function showReading(spell: SpellDto) {
  hudGlyph.textContent = spell.glyph; hudGlyph.style.color = elColor(spell.key);
  hudName.textContent = spell.element + " Sigil";
  hudApp.textContent = spell.key === "light" ? "→ illumination" : "→ " + spell.app;
}

function setMeters(sizePct: number, steadyPct: number, symPct: number) {
  barSize.style.width = Math.max(0, Math.min(100, sizePct)) + "%";
  barSteady.style.width = Math.max(0, Math.min(100, steadyPct)) + "%";
  barSym.style.width = Math.max(0, Math.min(100, symPct)) + "%";
}

// ---- drawing ----
// Inscribed-ink look: a soft coloured halo + a wet dark-ink body + a bright
// catching-light core, tinted by the active element (conjuring ink "catches light").
function renderStrokes() {
  cctx.lineJoin = "round"; cctx.lineCap = "round";
  const accent = phase === "ring" && detected?.spell ? elColor(detected.spell.key) : TEAL;
  const all = curStroke ? strokes.concat([curStroke]) : strokes;
  for (const st of all) {
    if (st.length < 2) continue;
    const path = () => {
      cctx.beginPath();
      cctx.moveTo(st[0].x, st[0].y);
      for (let i = 1; i < st.length; i++) cctx.lineTo(st[i].x, st[i].y);
    };
    cctx.strokeStyle = accent; cctx.shadowColor = accent; cctx.shadowBlur = 16; cctx.globalAlpha = 0.26; cctx.lineWidth = 12; path(); cctx.stroke();
    cctx.strokeStyle = "rgba(12,10,22,.92)"; cctx.shadowColor = "rgba(8,6,14,.85)"; cctx.shadowBlur = 6; cctx.globalAlpha = 1; cctx.lineWidth = 5.2; path(); cctx.stroke();
    cctx.strokeStyle = "rgba(245,236,206,.92)"; cctx.shadowColor = accent; cctx.shadowBlur = 10; cctx.lineWidth = 1.7; path(); cctx.stroke();
  }
  if (curStroke && curStroke.length) {
    const p = curStroke[curStroke.length - 1];
    cctx.beginPath(); cctx.fillStyle = accent; cctx.shadowColor = accent; cctx.shadowBlur = 14; cctx.globalAlpha = 0.9;
    cctx.arc(p.x, p.y, 2.6, 0, 6.2832); cctx.fill();
  }
  cctx.shadowBlur = 0; cctx.globalAlpha = 1;
}

function drawCast(ts = 0) {
  if (!W) return;
  const cx = W / 2, cy = H / 2;
  const R = Math.min(W, H) * 0.4;
  cctx.clearRect(0, 0, W, H);
  const halo = cctx.createRadialGradient(cx, cy, 0, cx, cy, R * 1.3);
  halo.addColorStop(0, "rgba(232,184,74,.05)");
  halo.addColorStop(1, "rgba(0,0,0,0)");
  cctx.fillStyle = halo; cctx.fillRect(0, 0, W, H);
  // outer ornamental ring (slow), carrying the four element marks
  cctx.save(); cctx.translate(cx, cy); cctx.rotate(ts * 0.00004);
  cctx.setLineDash([2, 12]); cctx.strokeStyle = "rgba(232,184,74,.14)"; cctx.lineWidth = 1;
  cctx.beginPath(); cctx.arc(0, 0, R * 1.16, 0, 6.2832); cctx.stroke(); cctx.setLineDash([]);
  cctx.fillStyle = "rgba(232,184,74,.28)"; cctx.font = "11px 'Cinzel', serif"; cctx.textAlign = "center"; cctx.textBaseline = "middle";
  const ticks = ["△", "□", "▽", "○"];
  for (let i = 0; i < 4; i++) { const a = i / 4 * 6.2832 - Math.PI / 2; cctx.fillText(ticks[i], Math.cos(a) * R * 1.16, Math.sin(a) * R * 1.16); }
  cctx.restore();
  // main guide ring (counter-rotating dashes), tinted by phase
  cctx.save(); cctx.translate(cx, cy); cctx.rotate(-ts * 0.00006);
  cctx.setLineDash([2, 9]); cctx.lineWidth = 1.2;
  cctx.strokeStyle = phase === "sigil" ? "rgba(232,184,74,.26)" : "rgba(47,214,198,.34)";
  cctx.beginPath(); cctx.arc(0, 0, R, 0, 6.2832); cctx.stroke(); cctx.setLineDash([]);
  cctx.restore();
  // hint (static)
  cctx.textBaseline = "alphabetic"; cctx.textAlign = "center";
  cctx.fillStyle = phase === "sigil" ? "rgba(239,230,210,.4)" : "rgba(232,184,74,.5)";
  cctx.font = "italic 15px 'EB Garamond', serif";
  cctx.fillText(phase === "sigil" ? "draw the sigil" : prepared ? "dot to ignite" : "close the ring", cx, cy - R - 18);
  renderStrokes();
}

// ---- bloom (origami unfold, ported from the prototype's fireSpell) ----
function bloom(sigil: Sigil, score: number, inverse: boolean, sideways: boolean, jutDir: number, fire: FireDto) {
  blooming = true;
  const center = sigilCenter || { x: W / 2, y: H / 2 };
  const start = performance.now();
  const dur = score >= 70 ? 1300 : score >= 42 ? 1500 : 1700;
  const sloppy = score < 42;
  // A cursed misfire blooms CORRUPTED: the seal curdles COLD to a low-chroma
  // stone-violet (no jitter — stillness is canon), then Petrification erupts (below).
  const corrupt = fire.cursed;
  const main = corrupt ? "#6c6478" : inverse ? GOLD : TEAL; // cold stone-violet
  const rayCol = corrupt ? "#8a7a52" : GOLD; // drained cold-amber seam
  const anim = (now: number) => {
    const p = Math.min(1, (now - start) / dur);
    cctx.clearRect(0, 0, W, H);
    cctx.save(); cctx.globalAlpha = (1 - p) * 0.5; renderStrokes(); cctx.restore();
    const ease = p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2;
    const jx = sideways ? (jutDir || 1) * Math.sin(p * Math.PI) * 180 : 0;
    const jy = sideways ? Math.sin(p * 9) * (1 - p) * 16 : 0;
    cctx.save();
    cctx.translate(center.x + jx, center.y + jy);
    cctx.rotate((inverse ? -1 : 1) * ease * 1.3 + (sideways ? Math.sin(p * 8) * 0.12 * (1 - p) : 0));
    for (let k = 0; k < 3; k++) {
      const rr = (40 + k * 46) * ease * (sloppy ? 1 + 0.12 * Math.sin(now * 0.05 + k) : 1);
      cctx.beginPath(); cctx.strokeStyle = main; cctx.globalAlpha = (1 - p) * 0.9;
      cctx.lineWidth = 2.4; cctx.shadowColor = cctx.strokeStyle; cctx.shadowBlur = 18 * (1 - p);
      cctx.arc(0, 0, Math.max(1, rr), 0, 6.2832); cctx.stroke();
    }
    const ns = 10;
    for (let i = 0; i < ns; i++) {
      const a = (i / ns) * 6.2832; const len = 110 * ease;
      cctx.beginPath(); cctx.strokeStyle = rayCol; cctx.globalAlpha = (1 - p) * 0.8; cctx.lineWidth = 1.4;
      cctx.moveTo(0, 0); cctx.lineTo(Math.cos(a) * len, Math.sin(a) * len); cctx.stroke();
    }
    const gs = 18 + ease * 42;
    cctx.globalAlpha = Math.max(0, 1 - p * 1.05); cctx.strokeStyle = main;
    cctx.lineWidth = 3; cctx.shadowColor = cctx.strokeStyle; cctx.shadowBlur = 24 * (1 - p);
    drawGlyphPath(cctx, sigil, gs); cctx.stroke();
    const fl = cctx.createRadialGradient(0, 0, 0, 0, 0, 220);
    fl.addColorStop(0, (corrupt ? "rgba(108,100,120," : inverse ? "rgba(232,184,74," : "rgba(47,214,198,") + (0.5 * (1 - p)).toFixed(3) + ")");
    fl.addColorStop(1, "rgba(0,0,0,0)");
    cctx.globalAlpha = 1; cctx.fillStyle = fl; cctx.beginPath(); cctx.arc(0, 0, 220, 0, 6.2832); cctx.fill();
    cctx.restore(); cctx.globalAlpha = 1; cctx.shadowBlur = 0;
    if (p < 1) { bloomRaf = requestAnimationFrame(anim); }
    else {
      strokes = []; curStroke = null; // clear the slate so the idle loop shows it empty
      cctx.clearRect(0, 0, W, H);
      if (fire.cursed) {
        // Petrification creeps over the slate, then recedes (blooming stays true so
        // the idle loop doesn't draw over it); only then dismiss.
        petrify(() => { blooming = false; showToast(fire.message, fire.icon); setTimeout(hide, 450); });
      } else if (fire.born) {
        // The very first cast: don't toast or close — the seal gives way to the
        // fudemushi naming rite (the companion has just hatched from this spell).
        blooming = false;
        openNamingRite();
      } else {
        blooming = false;
        showToast(fire.message, fire.icon);
        setTimeout(hide, 700);
      }
    }
  };
  bloomRaf = requestAnimationFrame(anim);
}

// Cursed misfire = a Brimmed-Cap backfire: WHA Petrification, which is CRYSTAL, not
// grey stone. Faceted crystalline shards erupt from the seal outward (dip-pen ink
// outlines + chalky catch-lights + crevice hatching = Shirahama's engraving), march
// arrhythmically (eating the glyph first), FREEZE absolutely still (the time-stop
// beat that sells the dread), then crumble from the frontier inward into stone-dust.
// Always harmless — it passes. Forbidden tint stays muted (cold stone-violet + a
// drained cold-amber seam), never neon; no continuous jitter (stillness is canon).
function petrify(onDone: () => void) {
  const cx = sigilCenter?.x ?? W / 2, cy = sigilCenter?.y ?? H / 2;
  const maxR = Math.hypot(W, H) * 0.58;
  const RINGS = [0, 0.2, 0.42, 0.66, 1.0]; // denser facets near the centre
  const STONE = ["#6f6a63", "#514c46", "#2c2925"]; // cool parchment-grey crystal body
  type Pt = { x: number; y: number };
  type Facet = { pts: Pt[]; mx: number; my: number; nucR: number; fill: string; violet: boolean; hatch: boolean; light: number; dusted: boolean };
  const facets: Facet[] = [];
  const jit = maxR * 0.05, jr = () => Math.random() - 0.5;
  const corner = (r: number, a: number): Pt => ({ x: cx + Math.cos(a) * r + jr() * jit, y: cy + Math.sin(a) * r + jr() * jit });
  for (let ri = 0; ri < RINGS.length - 1; ri++) {
    const r0 = RINGS[ri] * maxR, r1 = RINGS[ri + 1] * maxR, sectors = 8 + ri * 3;
    for (let si = 0; si < sectors; si++) {
      const a0 = (si / sectors) * 6.2832, a1 = ((si + 1) / sectors) * 6.2832;
      const pts: Pt[] = ri === 0
        ? [{ x: cx + jr() * 6, y: cy + jr() * 6 }, corner(r1, a0), corner(r1, a1)]
        : [corner(r0, a0), corner(r0, a1), corner(r1, a1), corner(r1, a0)];
      const mx = pts.reduce((s, q) => s + q.x, 0) / pts.length, my = pts.reduce((s, q) => s + q.y, 0) / pts.length;
      const violet = Math.random() < 0.16;
      facets.push({ pts, mx, my, nucR: (r0 + r1) / 2 + jr() * maxR * 0.08, fill: violet ? "#5b5266" : STONE[(Math.random() * 3) | 0], violet, hatch: Math.random() < 0.5, light: (Math.random() * pts.length) | 0, dusted: false });
    }
  }
  const ignite = 180, spread = 860, hold = 620, recede = 980, total = ignite + spread + hold + recede;
  const start = performance.now();
  const motes: { x: number; y: number; vx: number; vy: number; r: number; a: number }[] = [];
  const smooth = (e: number) => e * e * (3 - 2 * e);
  const trace = (p: Pt[]) => { cctx.beginPath(); cctx.moveTo(p[0].x, p[0].y); for (let i = 1; i < p.length; i++) cctx.lineTo(p[i].x, p[i].y); cctx.closePath(); };
  const anim = (now: number) => {
    const t = now - start;
    cctx.clearRect(0, 0, W, H);
    let front = 0, crumble = maxR + 1;
    if (t < ignite) front = maxR * 0.12 * (t / ignite);                       // ignition
    else if (t < ignite + spread) { const e = (t - ignite) / spread; front = maxR * smooth(Math.min(1, e + 0.05 * Math.sin(e * 16))); } // arrhythmic spread
    else if (t < ignite + spread + hold) front = maxR + 1;                    // FROZEN HOLD (time stops)
    else { front = maxR + 1; crumble = maxR * (1 - smooth((t - ignite - spread - hold) / recede)); } // crumble-recede
    for (const f of facets) {
      if (f.nucR > front) continue; // not yet erupted
      if (f.nucR > crumble) { // crumbling from the frontier inward → stone-dust
        if (!f.dusted) { f.dusted = true; for (let d = 0; d < 2; d++) motes.push({ x: f.mx, y: f.my, vx: jr() * 26, vy: 5 + Math.random() * 20, r: 1.4 + Math.random() * 2.2, a: 0.55 }); }
        continue;
      }
      const a = Math.min(1, (front - f.nucR) / (maxR * 0.06)); // local eruption ramp
      const e1 = f.pts[(f.light + 1) % f.pts.length];
      trace(f.pts); cctx.globalAlpha = a * 0.92; cctx.fillStyle = f.fill; cctx.fill();
      cctx.globalAlpha = a * 0.42; cctx.strokeStyle = "#cdc6b6"; cctx.lineWidth = 1.1; cctx.beginPath(); cctx.moveTo(f.pts[f.light].x, f.pts[f.light].y); cctx.lineTo(e1.x, e1.y); cctx.stroke(); // chalky catch-light rim
      trace(f.pts); cctx.globalAlpha = a * 0.85; cctx.strokeStyle = "#1b1714"; cctx.lineWidth = 1.4; cctx.lineJoin = "round"; cctx.stroke(); // dip-pen outline
      if (f.violet) { const e2 = f.pts[(f.light + 2) % f.pts.length]; cctx.globalAlpha = a * 0.3; cctx.strokeStyle = "#8a7a52"; cctx.lineWidth = 0.8; cctx.beginPath(); cctx.moveTo(e1.x, e1.y); cctx.lineTo(e2.x, e2.y); cctx.stroke(); } // cold-amber seam glint
      if (f.hatch) { cctx.globalAlpha = a * 0.38; cctx.strokeStyle = "#1b1714"; cctx.lineWidth = 0.7; const o = f.pts[2 % f.pts.length]; for (let hI = 1; hI <= 3; hI++) { const u = hI / 4; cctx.beginPath(); cctx.moveTo(f.pts[0].x + (e1.x - f.pts[0].x) * u, f.pts[0].y + (e1.y - f.pts[0].y) * u); cctx.lineTo(f.pts[0].x + (o.x - f.pts[0].x) * u, f.pts[0].y + (o.y - f.pts[0].y) * u); cctx.stroke(); } } // crevice hatching
    }
    if (t < ignite + 140) { const sa = Math.max(0, 1 - t / (ignite + 140)); cctx.globalAlpha = sa * 0.8; cctx.fillStyle = "#d2dae2"; cctx.beginPath(); cctx.arc(cx, cy, 7 + (1 - sa) * 26, 0, 6.2832); cctx.fill(); } // cold ignition spark
    for (const m of motes) { m.x += m.vx / 60; m.y += m.vy / 60; m.vy += 0.5; m.a -= 0.013; m.r *= 0.99; if (m.a <= 0) continue; cctx.globalAlpha = m.a; cctx.fillStyle = "#8d877c"; cctx.beginPath(); cctx.arc(m.x, m.y, m.r, 0, 6.2832); cctx.fill(); } // warm stone-dust
    cctx.globalAlpha = 1;
    if (t < total) requestAnimationFrame(anim);
    else { cctx.clearRect(0, 0, W, H); onDone(); }
  };
  requestAnimationFrame(anim);
}

// A gentle dud for a broken/unclosed ring — the seal sags into grey ink-motes and
// dissipates WITHOUT firing (distinct from the cursed Petrification misfire above).
function fizzle(onDone: () => void) {
  blooming = true; // block input during the brief dud
  const start = performance.now();
  const dur = 620;
  const c = sigilCenter ?? { x: W / 2, y: H / 2 };
  const motes = Array.from({ length: 10 }, () => ({ a: Math.random() * 6.2832, spd: 0.5 + Math.random(), drift: (Math.random() - 0.5) * 0.7 }));
  const anim = (now: number) => {
    const p = Math.min(1, (now - start) / dur);
    cctx.clearRect(0, 0, W, H);
    cctx.save(); cctx.globalAlpha = 1 - p; renderStrokes(); cctx.restore();
    for (const m of motes) {
      const rr = p * 46 * m.spd;
      const x = c.x + Math.cos(m.a) * rr * 0.4 + m.drift * rr;
      const y = c.y - rr * 1.5;
      cctx.beginPath(); cctx.fillStyle = `rgba(150,146,140,${((1 - p) * 0.5).toFixed(3)})`;
      cctx.arc(x, y, 2.2 * (1 - p) + 0.5, 0, 6.2832); cctx.fill();
    }
    if (p < 1) requestAnimationFrame(anim);
    else { blooming = false; cctx.clearRect(0, 0, W, H); onDone(); }
  };
  requestAnimationFrame(anim);
}

// A failed ring: toast + fizzle the broken ring away, then drop it and let the user
// re-draw the ring (the sigil stays).
function failRing(msg: string) {
  showToast(msg, "◌");
  fizzle(() => { strokes.pop(); drawCast(); });
}

let toastTimer = 0;
function showToast(msg: string, icon: string) {
  toastMsg.textContent = msg; toastIcon.textContent = icon || "✦";
  toast.style.display = "flex";
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => { toast.style.display = "none"; }, 4200);
}

// The dedication is a leather-bound spellbook (14.1, soft-bend via StPageFlip): a
// closed cover (debossed ✦) swings open, then parchment pages flip with a real page
// bend; the final page bears the inked pentacle. The words are mounted before any
// motion, and reduced-motion makes every flip instant.
const prefersReduced = () => !!window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches;
let pageFlip: PageFlip | null = null;
let sbCur = 0; // current page index (0 = cover)
let sbTotal = 0;

let sbContent = 0; // number of dedication (right-hand) pages

function blankLeaf(): HTMLElement {
  const b = document.createElement("div");
  b.className = "sb-leaf sb-pg sb-blank";
  return b;
}

function buildBookPages(gift: GiftDto): HTMLElement[] {
  const pages: HTMLElement[] = [];
  // Each opening = a BLANK left page + the dedication on the right page. A leading
  // blank starts the book on (blank | first page); a trailing blank backs the last
  // page so a flip never reveals empty space. No cover leaves (they render as stray
  // dark pages in a two-page spread).
  const heading = gift.recipientName ? `For ${gift.recipientName}` : gift.heading;
  const paras = gift.paragraphs.length ? gift.paragraphs : [""];
  sbContent = paras.length;
  paras.forEach((p, i) => {
    pages.push(blankLeaf());
    const leaf = document.createElement("div");
    leaf.className = "sb-leaf sb-pg";
    const inner = document.createElement("div");
    inner.className = "sb-pg-inner";
    if (i === 0) {
      const h = document.createElement("div"); h.className = "sb-h"; h.textContent = heading; inner.appendChild(h);
      const o = document.createElement("div"); o.className = "sb-o"; o.textContent = "✦"; inner.appendChild(o);
    }
    const para = document.createElement("p"); para.className = "sb-p"; para.textContent = p; inner.appendChild(para);
    if (i === paras.length - 1) {
      const sig = document.createElement("div"); sig.className = "sb-sig"; sig.textContent = gift.signature; inner.appendChild(sig);
      const seal = document.createElement("div"); seal.className = "sb-seal"; seal.textContent = "✦"; inner.appendChild(seal);
    }
    leaf.appendChild(inner);
    pages.push(leaf);
  });
  pages.push(blankLeaf()); // trailing blank → the last leaf always has a page behind it
  return pages;
}

function updateSbNav() {
  // one dot per dedication page; the right-hand content pages sit at odd indices (cover=0).
  const active = Math.max(0, Math.min(sbContent - 1, Math.floor(sbCur / 2)));
  sbDots.innerHTML = "";
  for (let i = 0; i < sbContent; i++) {
    const d = document.createElement("span");
    d.style.cssText = `width:7px;height:7px;border-radius:50%;background:${i === active ? "#e8b84a" : "rgba(232,200,120,.28)"}`;
    sbDots.appendChild(d);
  }
  // the last content spread starts at index sbTotal-3 (the trailing blank is last).
  sbTurn.textContent = sbCur >= sbTotal - 3 ? "Close the book ✦" : "Turn the page ▸";
}

function turnPage() {
  if (!pageFlip || sbCur >= sbTotal - 3) { reset(); hide(); } // showing the last content → close
  else pageFlip.flipNext();
}

async function openStorybook() {
  let gift: GiftDto | null = null;
  try { gift = (await invoke<{ gift: GiftDto }>("get_settings")).gift; } catch { /* */ }
  // Enter storybook mode FIRST so a casting-mode race (or a failed mount) can never
  // leave the casting slate showing.
  scrim.style.display = "block";
  slate.style.display = "none";
  storybook.style.display = "block";
  storybookOpen = true;
  const reduced = prefersReduced();
  // The leather cover swings open over the book on reveal (its own CSS 3D; vanishes
  // past 90° via backface-visibility), then is removed. Skipped under reduced-motion.
  if (reduced) {
    sbCoverEl.style.display = "none";
    sbBook.style.opacity = "1";
  } else {
    sbBook.style.transition = "none";
    sbBook.style.opacity = "0"; // hide the open spread behind the closed, centred cover
    sbCoverEl.style.display = "flex";
    sbCoverEl.style.transition = "none";
    sbCoverEl.style.transform = "rotateY(0deg)";
    window.setTimeout(() => {
      sbCoverEl.style.transition = "transform .95s cubic-bezier(.3,.7,.25,1)";
      sbCoverEl.style.transform = "rotateY(-170deg)";
      sbBook.style.transition = "opacity .55s ease .15s"; // reveal the spread as the cover lifts
      sbBook.style.opacity = "1";
    }, 460);
    window.setTimeout(() => { sbCoverEl.style.display = "none"; }, 1500);
  }
  if (pageFlip) { try { pageFlip.destroy(); } catch { /* */ } pageFlip = null; }
  sbBook.innerHTML = "";
  const pages = gift ? buildBookPages(gift) : [];
  sbTotal = pages.length;
  sbCur = 0;
  updateSbNav();
  try {
    // mount on a FRESH child each time (StPageFlip leaves state on a reused element).
    const book = document.createElement("div");
    book.style.cssText = "width:100%;height:100%";
    for (const p of pages) book.appendChild(p);
    sbBook.appendChild(book);
    pageFlip = new PageFlip(book, {
      width: 340, height: 460, size: "stretch",
      minWidth: 180, maxWidth: 380, minHeight: 252, maxHeight: 540,
      showCover: false, usePortrait: false,
      maxShadowOpacity: 0.45, drawShadow: true,
      flippingTime: reduced ? 0 : 800,
      useMouseEvents: !reduced, showPageCorners: !reduced, mobileScrollSupport: false,
    });
    pageFlip.loadFromHTML(pages);
    pageFlip.on("flip", (e) => { sbCur = e.data; updateSbNav(); });
  } catch { /* mount failed — storybook mode is at least active (no slate) */ }
}

// The first-cast hatching ceremony: the casting seal gives way to a parchment card
// where the newly-hatched fudemushi uncurls and Lorraine names it. The overlay still
// holds focus (the first cast launches no app), so the name field can be typed into.
function openNamingRite() {
  blooming = false;
  scrim.style.display = "block";   // keep the dimmed backdrop behind the card
  slate.style.display = "none";
  storybook.style.display = "none";
  storybookOpen = false;
  namingOpen = true;
  nrInput.value = "";
  namingRite.style.display = "block";
  // Restart the entrance + hatch animations on each open so the dev preview replays.
  namingRite.style.animation = "none"; void namingRite.offsetWidth; namingRite.style.animation = "";
  nrBug.style.animation = "none"; void nrBug.offsetWidth; nrBug.style.animation = "";
  setTimeout(() => nrInput.focus(), 60);
}

// Close the rite: persist the name (if given), then hide the overlay. "later" leaves
// the fudemushi unnamed — it can be named anytime from the control panel.
function finishNaming(save: boolean) {
  if (!namingOpen) return;
  namingOpen = false;
  const name = nrInput.value.trim();
  if (save && name) invoke("set_buddy_name", { name }).catch(() => {});
  namingRite.style.display = "none";
  hide();
}

// Rust shows/hides the overlay window; this just sets what's on it. casting →
// scrim + slate; idle → nothing (the window is about to be hidden by Rust).
function setOverlayMode(m: string) {
  if (m === "casting") {
    scrim.style.display = "block";
    reset();   // shows the slate, sigil phase, hides the storybook
    resize();  // size the now-visible cast canvas
  } else {
    scrim.style.display = "none";
    slate.style.display = "none";
    storybook.style.display = "none";
    namingRite.style.display = "none";
    storybookOpen = false;
    namingOpen = false;
  }
}

// "Hide" closes casting: Rust hides the window and restores the prior foreground.
async function hide() {
  try { await invoke("close_casting"); } catch { /* browser preview */ }
}

document.getElementById("btnClear")!.addEventListener("click", reset);
document.getElementById("btnDismiss")!.addEventListener("click", () => { reset(); hide(); });
sbTurn.addEventListener("click", turnPage); // turn the page, or close the book on the last
nrName.addEventListener("click", () => finishNaming(true));
nrLater.addEventListener("click", () => finishNaming(false));
nrInput.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); finishNaming(true); } });
window.addEventListener("keydown", (e) => {
  if (namingOpen) {
    if (e.key === "Enter") { e.preventDefault(); finishNaming(true); }
    else if (e.key === "Escape") { e.preventDefault(); finishNaming(false); }
    return;
  }
  if (e.key === "Escape") { reset(); hide(); }
  else if (storybookOpen && pageFlip) {
    if (e.key === "ArrowRight" || e.key === " ") turnPage();
    else if (e.key === "ArrowLeft" && sbCur > 0) pageFlip.flipPrev();
  }
});

// Rust drives the overlay mode (it shows the window for casting, hides it after).
listen<string>("overlay:mode", (e) => setOverlayMode(e.payload));

// The birthday auto-bloom (and the Preview button) surface the dedication here.
listen("gift:birthday", () => openStorybook());

// The dev "Preview naming rite" button surfaces the first-cast ceremony here.
listen("gift:naming", () => openNamingRite());

// Preview the cursed-misfire Petrification on demand (the dev "Preview misfire"
// button) — a representative full misfire on a sample earth seal, then it passes.
listen("preview:petrify", () => {
  if (blooming) return;
  reset();
  bloom("square", 78, false, false, 0, { launched: false, cursed: true, dismissed: false, message: "A miscast — the seal curdles to crystal, then passes.", icon: "🜨", ink: 0, key: "earth", born: false });
});

// Colorblind-safe element palette (a `cb` class on body swaps the --el-* vars).
function applyColorblind(on: boolean) { document.body.classList.toggle("cb", on); }
invoke<{ colorblind?: boolean }>("get_settings").then((s) => applyColorblind(!!s?.colorblind)).catch(() => {});
listen<boolean>("settings:colorblind", (e) => applyColorblind(!!e.payload));

// Continuous idle redraw so the seal canvas breathes (slowly counter-rotating
// guide rings) while you draw; the bloom animation takes over (this skips) during
// a cast. rAF throttles to ~0 while the overlay window is hidden.
function frame(ts: number) {
  if (!blooming) drawCast(ts);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

resize();
setOverlayMode("idle");
