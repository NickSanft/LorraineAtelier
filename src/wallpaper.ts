export {}; // module scope

import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";

// Pure-logic core (DOM-free, unit-tested) extracted under src/atelier/*.
import type { Mode, Sigil } from "./atelier/palette";
import {
  PAL,
  SIGILS,
  getVarsForMode,
  getWallFilterForMode,
  getTintBackgroundForMode,
  getTintOpacityForMode,
} from "./atelier/palette";
import type { Bands } from "./atelier/audio/generative";
import { currentBands, onBandFrame, setAttuned, takeBeat, type BandFrameMsg } from "./atelier/audio/source";
import { makeMotes, drawAmbient, type Mote } from "./atelier/draw/ambient";
import { attuned, drawGlyphPath } from "./atelier/draw/viz";
import { makeSealState, stepSeal, drawSeal } from "./atelier/draw/seal";
import { glowOpacity } from "./atelier/draw/glow";

// Wallpaper renderer — ported faithfully from mockup/Atelier.dc.html (the spec).
// Display-only: the wallpaper receives no input, so interactive bits (dock, casting,
// the real Attune/day-night toggles) live elsewhere. Audio is the prototype's
// synthetic "bands" for now; Phase 6 will push real WASAPI bands from Rust.

// Current mode; initialized from persisted settings, updated live via set_mode.
let curMode: Mode = "night";

const root = document.getElementById("root")!;
const wall = document.getElementById("wall") as HTMLImageElement;
const tint = document.getElementById("tint")!;
const glow = document.getElementById("glow")!;
const ambient = document.getElementById("ambient") as HTMLCanvasElement;
const viz = document.getElementById("viz") as HTMLCanvasElement;
const bloom = document.getElementById("bloom") as HTMLCanvasElement;
const elWeekday = document.getElementById("weekday")!;
const elTime = document.getElementById("time")!;
const elAmpm = document.getElementById("ampm")!;
const elDate = document.getElementById("date")!;

// ---- Asset rendition selection by physical width ----
// The base art (the gift's wallpaper) ships at /wallpaper.webp and is used on
// every monitor. Higher-resolution per-monitor renditions are the gift-
// personalization step: drop e.g. wallpaper@3440.webp into public/ and add it to
// RENDITIONS so big monitors pick it up. Listing only files that actually exist
// means no request ever 404s; onerror is a final safety net back to the base.
const BASE_ART = "/wallpaper.webp";
// Per-monitor renditions, picked by physical size. `minAspect` guards aspect-ratio
// so a 16:9 4K monitor never grabs the 21:9 ultrawide art (object-fit:cover would
// otherwise crop the frame). Each entry's file must exist in public/.
const RENDITIONS: { minWidth: number; minAspect?: number; src: string }[] = [
  // 3440x1440 ultrawide (21:9 ≈ 2.39): the framed scene with the parchment border
  // extended left/right so nothing is cropped.
  { minWidth: 3000, minAspect: 2.2, src: "/wallpaper-3440.jpg" },
];
// Set the error handler BEFORE assigning src so a failed load falls back to base.
let curWallSrc = "";
wall.onerror = () => {
  if (!wall.src.endsWith(BASE_ART)) {
    wall.onerror = null; // avoid loops if the base itself is missing
    curWallSrc = BASE_ART;
    wall.src = BASE_ART;
  }
};
// Choose the rendition from the CURRENT physical size. The wallpaper webview is
// created at the config's default size and only sized to its monitor after attach,
// so this must run again once the real size arrives (resize + delayed retries),
// not just at module load — otherwise an ultrawide keeps the cover-cropped base.
function pickWall() {
  const pw = window.innerWidth * (window.devicePixelRatio || 1);
  const ph = window.innerHeight * (window.devicePixelRatio || 1);
  const aspect = pw / Math.max(1, ph);
  const r = RENDITIONS
    .filter((d) => pw >= d.minWidth && aspect >= (d.minAspect ?? 0))
    .sort((a, b) => b.minWidth - a.minWidth)[0];
  const want = r ? r.src : BASE_ART;
  if (want !== curWallSrc) {
    curWallSrc = want;
    wall.src = want;
  }
}
pickWall();
[400, 1200, 2500].forEach((t) => setTimeout(pickWall, t));

let pal = PAL[curMode];
let uiScale = 1;
let motes: Mote[] = [];

function applyMode(mode: Mode) {
  curMode = mode;
  const vars = getVarsForMode(mode);
  for (const k of Object.keys(vars)) root.style.setProperty(k, vars[k]);
  wall.style.filter = getWallFilterForMode(mode);
  tint.style.background = getTintBackgroundForMode(mode);
  tint.style.opacity = getTintOpacityForMode(mode);
  pal = PAL[mode];
  const glowCenter = mode === "night" ? ".5" : ".7"; // day glow needs a stronger centre to read
  glow.style.background = `radial-gradient(circle, ${pal.glowColor}${glowCenter}), ${pal.glowColor}0) 62%)`;
  // `screen` makes the teal bloom glow on the dark night scene, but it can't
  // brighten the bright day art (invisible) — use normal alpha compositing in day.
  glow.style.mixBlendMode = mode === "night" ? "screen" : "normal";
  updateDockDisplay(mode);
}

// ---- canvas sizing (DPR-aware; draws work in CSS px via cached _cssw/_cssh) ----
interface CV extends HTMLCanvasElement { _cssw?: number; _cssh?: number; }
function sizeCanvas(c: CV) {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const r = c.getBoundingClientRect();
  c.width = Math.max(1, Math.round(r.width * dpr));
  c.height = Math.max(1, Math.round(r.height * dpr));
  const ctx = c.getContext("2d")!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  c._cssw = r.width;
  c._cssh = r.height;
}

function sizeAll() {
  sizeCanvas(ambient);
  sizeCanvas(viz);
  sizeCanvas(bloom);
  const c = ambient as CV;
  const w = c._cssw || window.innerWidth, h = c._cssh || window.innerHeight;
  motes = makeMotes(w, h, 56);
}

function drawAmbientFrame(ts: number, b: Bands) {
  const c = ambient as CV;
  if (!motes.length) sizeAll();
  const ctx = c.getContext("2d")!;
  drawAmbient(ctx, motes, c._cssw!, c._cssh!, ts, b, pal);
}

const sealState = makeSealState();
function drawVizFrame(ts: number, b: Bands, dt: number, beat: boolean) {
  const c = viz as CV;
  const ctx = c.getContext("2d")!;
  stepSeal(sealState, b, dt, beat);
  drawSeal(ctx, c._cssw!, c._cssh!, sealState, pal, attuned(ts, SIGILS));
}

// ---- DockMirror (display-only) glue ----
// The dock in wallpaper.html is static markup with pointer-events:none and no
// handlers. This refreshes the day/night indicator (and could refresh the ink
// gauge) when MODE changes. No event listeners are attached — the no-input gate
// stays green. Initial markup already matches MODE="night" / 78% ink, so on first
// run this is a no-op; it exists for the Rust-driven mode switch in Phase 7.
function updateDockDisplay(mode: Mode, inkPercent?: number) {
  const modeIndicator = document.getElementById("modeIndicator");
  const inkLevelBar = document.getElementById("inkLevel");
  if (modeIndicator) {
    const isNight = mode === "night";
    modeIndicator.innerHTML =
      `<span style="font-size:calc(19px * var(--ui-scale,1));line-height:1;color:var(--c-gold)">${isNight ? "☾" : "☀"}</span>` +
      `<span style="font-family:'Cinzel',serif;font-size:calc(8px * var(--ui-scale,1));letter-spacing:.12em;text-transform:uppercase;color:var(--c-soft)">${isNight ? "Night" : "Day"}</span>`;
    scheduleHitRects(); // the mode indicator width changed → dock layout shifted
  }
  if (inkLevelBar && inkPercent != null) {
    inkLevelBar.style.height = Math.max(0, Math.min(100, inkPercent)) + "%";
  }
}

// ---- desktop-layer interactivity: publish hit-rects to Rust ----
// The dock has pointer-events:none and the wallpaper sits below the icons, so the
// OS never delivers clicks here. Instead Rust runs a low-level mouse hook and acts
// on a click only when it lands in one of these rects AND the desktop is exposed.
// We report each pill / the cast glyph in LOCAL physical px (origin = this monitor's
// top-left); Rust offsets by the monitor origin. Only the primary monitor has a dock.
interface HitRect { kind: string; key?: string; x0: number; y0: number; x1: number; y1: number; }
function publishHitRects() {
  const rects: HitRect[] = [];
  if (isPrimary) {
    const dpr = window.devicePixelRatio || 1;
    const add = (el: Element | null, kind: string, key?: string) => {
      if (!el) return;
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return;
      rects.push({ kind, key, x0: r.left * dpr, y0: r.top * dpr, x1: r.right * dpr, y1: r.bottom * dpr });
    };
    document.querySelectorAll("[data-pill]").forEach((el) => add(el, "pill", (el as HTMLElement).dataset.pill));
    add(document.getElementById("castGlyph"), "cast");
    add(document.getElementById("modeIndicator"), "mode");   // toggle day/night
    add(document.getElementById("attunePill"), "attune");    // toggle music attunement
    add(document.getElementById("tomesBtn"), "tomes");       // open the Tower of Tomes
  }
  invoke("set_hit_rects", { label: selfLabel, rects }).catch(() => {});
}
let hitRectsRaf = 0;
function scheduleHitRects() {
  cancelAnimationFrame(hitRectsRaf);
  // Two frames so layout (and any --ui-scale / inset change) has settled.
  hitRectsRaf = requestAnimationFrame(() => requestAnimationFrame(publishHitRects));
}

// ---- brushbuddy: a single ink companion that roams ACROSS all monitors ----
// Rust owns the buddy in virtual-desktop coordinates and pushes a `buddy` event
// to each monitor's wallpaper webview ~30 Hz (see spawn_buddy in lib.rs). Each
// window draws it in its own local coords and shows it only while it owns the
// buddy, so it walks off one screen and onto the next. The same event carries the
// `primary` flag that drives the primary/secondary widget split below.
interface BuddyMsg {
  label: string; x: number; y: number; visible: boolean; flip: number; eye: number; primary: boolean; held: boolean;
  insetTop: number; insetBottom: number; insetLeft: number; insetRight: number;
}
const buddyEl = document.getElementById("buddy");
const buddyEyes = document.getElementById("buddyEyes");
const clockEl = document.getElementById("clock");
const sealEl = document.getElementById("seal");
const topStripEl = document.getElementById("topstrip");
const dockEl = document.getElementById("dock");
let isPrimary: boolean | null = null;
// This webview's own label. Rust emits each monitor's buddy message to its slot
// label AND stamps the label into the payload; we act only on our own (Tauri 2.11
// `EventTarget::Any` listeners otherwise receive every window's emit).
const selfLabel = getCurrentWebviewWindow().label;
if (buddyEl) buddyEl.style.transformOrigin = "24px 21px"; // sprite centre, for scaling
if (buddyEyes) buddyEyes.style.transformOrigin = "center 23px";

// Primary monitor shows the full widgets (clock + seal + top strip + dock);
// secondary monitors stay calm — just art, ambient motes, glow, and the passing
// buddy. Restore each element's natural display (#topstrip + #dock are flex; the
// rest block).
function applyPrimary(primary: boolean) {
  if (primary === isPrimary) return;
  isPrimary = primary;
  if (clockEl) clockEl.style.display = primary ? "block" : "none";
  if (sealEl) sealEl.style.display = primary ? "block" : "none";
  if (topStripEl) topStripEl.style.display = primary ? "flex" : "none";
  if (dockEl) dockEl.style.display = primary ? "flex" : "none";
  scheduleHitRects(); // dock appeared/disappeared → republish (or clear) hit-rects
}

// ---- taskbar-aware safe area ----
// Inset the whole scene (#root holds the art + every widget) into the monitor's
// work area, so a pinned/locked taskbar gets its own strip and nothing — art,
// border, dock, buddy — is clipped behind it. An auto-hidden taskbar reserves no
// work area, so insets are 0 and the scene fills the monitor edge-to-edge. Insets
// arrive in physical px (Rust work area); convert to CSS px. The buddy is a child
// of #root, so its translate is offset by the left/top inset.
let curInsets = "";
let insetLeftCss = 0, insetTopCss = 0;
function applyInsets(top: number, right: number, bottom: number, left: number) {
  const key = `${top},${right},${bottom},${left}`;
  if (key === curInsets) return;
  curInsets = key;
  const dpr = window.devicePixelRatio || 1;
  insetTopCss = top / dpr;
  insetLeftCss = left / dpr;
  root.style.top = insetTopCss + "px";
  root.style.right = (right / dpr) + "px";
  root.style.bottom = (bottom / dpr) + "px";
  root.style.left = insetLeftCss + "px";
  sizeAll(); // canvases now cover the (possibly smaller) work area
  scheduleHitRects(); // the dock shifted with the work-area inset
}

listen<BuddyMsg>("buddy", (e) => {
  const m = e.payload;
  if (m.label !== selfLabel) return; // ignore other monitors' messages (cross-talk guard)
  applyPrimary(m.primary);
  applyInsets(m.insetTop, m.insetRight, m.insetBottom, m.insetLeft);
  if (!buddyEl) return;
  buddyEl.style.opacity = m.visible ? "1" : "0";
  // While held, the buddy lifts (scales up) and gains a warm glow — the "picked up" cue.
  const lift = m.held ? 1.16 : 1;
  buddyEl.style.transform =
    `translate(${m.x - 24 - insetLeftCss}px, ${m.y - 21 - insetTopCss}px) scale(${m.flip * uiScale * lift}, ${uiScale * lift})`;
  buddyEl.style.filter = m.held ? "drop-shadow(0 3px 6px rgba(8,6,14,.5)) drop-shadow(0 0 9px var(--c-gold))" : "";
  if (buddyEyes) buddyEyes.style.transform = `scaleY(${m.eye.toFixed(3)})`;
}, { target: selfLabel });

// ---- cast bloom: origami unfold driven by Rust `cast:fire` (broadcast to every
// monitor; all wallpaper windows bloom at their own centre). Reuses the shared
// drawGlyphPath so a cast and the visualizer seal speak the same glyph vocabulary.
interface CastFire { sigil: string; score: number; inverse: boolean; sideways: boolean; jutDir: number; hue: string; key: string; ink: number; }
let bloomRaf = 0;
function startBloom(m: CastFire) {
  const c = bloom as CV;
  const ctx = c.getContext("2d")!;
  const w = c._cssw || 0, h = c._cssh || 0;
  if (!w || !h) return;
  const cx = w / 2, cy = h / 2;
  const S = Math.max(1.4, uiScale * 1.7); // bloom scales up on bigger monitors
  const { score, inverse, sideways } = m;
  const jutDir = m.jutDir || 1;
  const sig = m.sigil as Sigil;
  const teal = pal.teal, gold = pal.gold;
  const start = performance.now();
  const dur = score >= 70 ? 1300 : score >= 42 ? 1500 : 1700;
  const sloppy = score < 42;
  cancelAnimationFrame(bloomRaf);
  const anim = (now: number) => {
    const p = Math.min(1, (now - start) / dur);
    ctx.clearRect(0, 0, w, h);
    const ease = p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2;
    const jx = sideways ? jutDir * Math.sin(p * Math.PI) * 180 * S : 0;
    const jy = sideways ? Math.sin(p * 9) * (1 - p) * 16 : 0;
    ctx.save();
    ctx.translate(cx + jx, cy + jy);
    ctx.rotate((inverse ? -1 : 1) * ease * 1.3 + (sideways ? Math.sin(p * 8) * 0.12 * (1 - p) : 0));
    for (let k = 0; k < 3; k++) {
      const rr = (40 + k * 46) * ease * S * (sloppy ? 1 + 0.12 * Math.sin(now * 0.05 + k) : 1);
      ctx.beginPath(); ctx.strokeStyle = inverse ? gold : teal; ctx.globalAlpha = (1 - p) * 0.85;
      ctx.lineWidth = 2.4 * S; ctx.shadowColor = ctx.strokeStyle; ctx.shadowBlur = 18 * (1 - p);
      ctx.arc(0, 0, rr, 0, 6.2832); ctx.stroke();
    }
    const ns = 10;
    for (let i = 0; i < ns; i++) {
      const a = (i / ns) * 6.2832, len = 110 * ease * S;
      ctx.beginPath(); ctx.strokeStyle = gold; ctx.globalAlpha = (1 - p) * 0.75; ctx.lineWidth = 1.4 * S;
      ctx.moveTo(0, 0); ctx.lineTo(Math.cos(a) * len, Math.sin(a) * len); ctx.stroke();
    }
    const gs = (18 + ease * 42) * S;
    ctx.globalAlpha = Math.max(0, 1 - p * 1.05); ctx.strokeStyle = inverse ? gold : teal;
    ctx.lineWidth = 3 * S; ctx.shadowColor = ctx.strokeStyle; ctx.shadowBlur = 24 * (1 - p);
    drawGlyphPath(ctx, sig, gs); ctx.stroke();
    const R = 220 * S;
    const fl = ctx.createRadialGradient(0, 0, 0, 0, 0, R);
    fl.addColorStop(0, (inverse ? "rgba(232,184,74," : "rgba(47,214,198,") + (0.42 * (1 - p)).toFixed(3) + ")");
    fl.addColorStop(1, "rgba(0,0,0,0)");
    ctx.globalAlpha = 1; ctx.fillStyle = fl; ctx.beginPath(); ctx.arc(0, 0, R, 0, 6.2832); ctx.fill();
    ctx.restore(); ctx.globalAlpha = 1; ctx.shadowBlur = 0;
    if (p < 1) bloomRaf = requestAnimationFrame(anim);
    else ctx.clearRect(0, 0, w, h);
  };
  bloomRaf = requestAnimationFrame(anim);
}

listen<CastFire>("cast:fire", (e) => {
  const m = e.payload;
  updateDockDisplay(curMode, m.ink); // reflect spent ink in the dock gauge
  startBloom(m);
});

// Celebratory bloom (birthday auto-bloom / dedication preview) — no ink change.
listen("gift:bloom", () => startBloom({ sigil: "circle", score: 95, inverse: false, sideways: false, jutDir: 0, hue: pal.gold, key: "", ink: -1 }));

// Real-audio visualizer: Rust pushes band frames ~45 Hz when "Attune" is on; the
// seal/ambient/glow react to them via currentBands(). Falls back to generative
// automatically when capture stops.
const attuneLabel = document.getElementById("attuneLabel");
const attuneIcon = document.getElementById("attuneIcon");
listen<BandFrameMsg>("viz:bands", (e) => onBandFrame(e.payload));
listen<{ attuned: boolean; reason?: string }>("viz:source-changed", (e) => {
  setAttuned(e.payload.attuned);
  if (attuneLabel) attuneLabel.textContent = e.payload.attuned ? "Resonance" : "Attune";
  if (attuneIcon) attuneIcon.textContent = e.payload.attuned ? "♪" : "▶";
  scheduleHitRects(); // the pill's label width changed (Attune ↔ Resonance)
});

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function updateClock() {
  const d = new Date();
  const hh = d.getHours();
  const h12 = hh % 12 === 0 ? 12 : hh % 12;
  elWeekday.textContent = WEEKDAYS[d.getDay()];
  elTime.textContent = h12 + ":" + String(d.getMinutes()).padStart(2, "0");
  elAmpm.textContent = hh >= 12 ? "PM" : "AM";
  elDate.textContent = (MONTHS[d.getMonth()] + " " + d.getDate()).toUpperCase();
}

let lastTs = 0;
let glowVal = 0;
function tick(ts: number) {
  const dt = lastTs ? Math.min(0.05, (ts - lastTs) / 1000) : 0.016;
  lastTs = ts;
  const b = currentBands(ts); // generative or real (attuned) audio
  drawAmbientFrame(ts, b);
  drawVizFrame(ts, b, dt, takeBeat()); // advances sealState (smoothed bands)
  // Glow follows the seal's already-enveloped bass, then eases again so brightness
  // shifts gradually — no rapid flicker (photosensitivity-friendly).
  const glowTarget = parseFloat(glowOpacity({ bass: sealState.bass, mid: sealState.mid, high: sealState.high }, pal));
  glowVal += (glowTarget - glowVal) * 0.07;
  glow.style.opacity = glowVal.toFixed(3);
  requestAnimationFrame(tick);
}

// Widget size scales with monitor height so widgets stay proportional across
// resolutions (1440 → 1.5 = +50%; 1080 → ~1.1). Must run before sizeAll() so the
// scaled canvas bounding box is measured. Phase 7 will make widget size + position
// user-adjustable per monitor (the movable/resizable feature).
function setUiScale() {
  uiScale = Math.max(1, Math.min(2.2, window.innerHeight / 960));
  root.style.setProperty("--ui-scale", uiScale.toFixed(3));
}

setUiScale();
applyMode(curMode); // night by default (matches the inline CSS — no flash)
// Pull the persisted mode (transitions to day if set) + follow live changes.
function applyColorblind(on: boolean) { document.body.classList.toggle("cb", on); }
invoke<{ mode: Mode; colorblind?: boolean }>("get_settings").then((s) => { if (s?.mode) applyMode(s.mode); if (s) applyColorblind(!!s.colorblind); }).catch(() => {});
listen<string>("settings:mode", (e) => applyMode(e.payload as Mode));
listen<boolean>("settings:colorblind", (e) => applyColorblind(!!e.payload));
sizeAll();
scheduleHitRects(); // initial publish (clears until this monitor learns it's primary)
window.addEventListener("resize", () => {
  setUiScale();
  sizeAll();
  scheduleHitRects();
  pickWall(); // the window was just sized to its monitor → re-pick the rendition
});
updateClock();
setInterval(updateClock, 1000);
requestAnimationFrame(tick);
