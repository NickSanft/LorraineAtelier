export {}; // module scope

import { invoke } from "@tauri-apps/api/core";
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
interface FireDto { launched: boolean; cursed: boolean; dismissed: boolean; message: string; icon: string; ink: number; key: string }

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
const storybook = document.getElementById("storybook") as HTMLElement;
const sbHeading = document.getElementById("sbHeading")!;
const sbBody = document.getElementById("sbBody")!;
const sbSig = document.getElementById("sbSig")!;

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

function reset() {
  cancelAnimationFrame(bloomRaf);
  phase = "sigil"; strokes = []; curStroke = null; detected = null;
  sigilCenter = null; sigilScore = 0; sigilDiag = 0; prepared = null; blooming = false;
  storybook.style.display = "none"; // back to the casting slate
  slate.style.display = "flex";
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
  if (!ring.encloses) { showToast("The ring must enclose the sigil.", "◌"); strokes.pop(); return; }
  showToast("The ring is broken — the spell lies dormant.", "◌"); strokes.pop();
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

function showReading(spell: SpellDto) {
  hudGlyph.textContent = spell.glyph; hudGlyph.style.color = spell.hue;
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
  const accent = phase === "ring" && detected?.spell ? detected.spell.hue : TEAL;
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
      cctx.beginPath(); cctx.strokeStyle = inverse ? GOLD : TEAL; cctx.globalAlpha = (1 - p) * 0.9;
      cctx.lineWidth = 2.4; cctx.shadowColor = cctx.strokeStyle; cctx.shadowBlur = 18 * (1 - p);
      cctx.arc(0, 0, rr, 0, 6.2832); cctx.stroke();
    }
    const ns = 10;
    for (let i = 0; i < ns; i++) {
      const a = (i / ns) * 6.2832; const len = 110 * ease;
      cctx.beginPath(); cctx.strokeStyle = GOLD; cctx.globalAlpha = (1 - p) * 0.8; cctx.lineWidth = 1.4;
      cctx.moveTo(0, 0); cctx.lineTo(Math.cos(a) * len, Math.sin(a) * len); cctx.stroke();
    }
    const gs = 18 + ease * 42;
    cctx.globalAlpha = Math.max(0, 1 - p * 1.05); cctx.strokeStyle = inverse ? GOLD : TEAL;
    cctx.lineWidth = 3; cctx.shadowColor = cctx.strokeStyle; cctx.shadowBlur = 24 * (1 - p);
    drawGlyphPath(cctx, sigil, gs); cctx.stroke();
    const fl = cctx.createRadialGradient(0, 0, 0, 0, 0, 220);
    fl.addColorStop(0, (inverse ? "rgba(232,184,74," : "rgba(47,214,198,") + (0.5 * (1 - p)).toFixed(3) + ")");
    fl.addColorStop(1, "rgba(0,0,0,0)");
    cctx.globalAlpha = 1; cctx.fillStyle = fl; cctx.beginPath(); cctx.arc(0, 0, 220, 0, 6.2832); cctx.fill();
    cctx.restore(); cctx.globalAlpha = 1; cctx.shadowBlur = 0;
    if (p < 1) { bloomRaf = requestAnimationFrame(anim); }
    else {
      blooming = false;
      strokes = []; curStroke = null; // clear the slate so the idle loop shows it empty
      cctx.clearRect(0, 0, W, H);
      showToast(fire.message, fire.icon);
      setTimeout(hide, fire.cursed ? 950 : 700);
    }
  };
  bloomRaf = requestAnimationFrame(anim);
}

let toastTimer = 0;
function showToast(msg: string, icon: string) {
  toastMsg.textContent = msg; toastIcon.textContent = icon || "✦";
  toast.style.display = "flex";
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => { toast.style.display = "none"; }, 4200);
}

async function openStorybook() {
  let gift: GiftDto | null = null;
  try { gift = (await invoke<{ gift: GiftDto }>("get_settings")).gift; } catch { /* */ }
  if (gift) {
    sbHeading.textContent = gift.recipientName ? `For ${gift.recipientName}` : gift.heading;
    sbBody.innerHTML = "";
    for (const p of gift.paragraphs) {
      const el = document.createElement("p");
      el.style.margin = "0 0 14px";
      el.textContent = p;
      sbBody.appendChild(el);
    }
    sbSig.textContent = gift.signature;
  }
  slate.style.display = "none";
  storybook.style.display = "block";
}

async function hide() {
  try {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    await getCurrentWindow().hide();
  } catch { /* browser preview */ }
}

document.getElementById("btnClear")!.addEventListener("click", reset);
document.getElementById("btnDismiss")!.addEventListener("click", () => { reset(); hide(); });
document.getElementById("sbClose")!.addEventListener("click", () => { reset(); hide(); });
window.addEventListener("keydown", (e) => { if (e.key === "Escape") { reset(); hide(); } });

// Clear the slate each time the window is summoned (regains focus).
(async () => {
  try {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    await getCurrentWindow().onFocusChanged(({ payload }) => { if (payload) reset(); });
  } catch { /* browser preview */ }
})();

// Continuous idle redraw so the seal canvas breathes (slowly counter-rotating
// guide rings) while you draw; the bloom animation takes over (this skips) during
// a cast. rAF throttles to ~0 while the overlay window is hidden.
function frame(ts: number) {
  if (!blooming) drawCast(ts);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

resize();
reset();
