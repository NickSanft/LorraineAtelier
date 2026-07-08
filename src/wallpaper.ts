export {}; // module scope

import { listen } from "@tauri-apps/api/event";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
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
import { currentBands, currentTempo, onBandFrame, setAttuned, takeBeat, type BandFrameMsg } from "./atelier/audio/source";
import { makeMotes, drawAmbient, makeLanterns, drawLanterns, type Mote } from "./atelier/draw/ambient";
import { pickLine } from "./atelier/almanac";
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
// Clock/seal decorative rings — rotated in JS (see tick) instead of infinite CSS
// animations, which would keep the compositor presenting every vsync (high GPU).
const ring1 = document.getElementById("ring1");
const ring2 = document.getElementById("ring2");
const ring3 = document.getElementById("ring3");
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
// The art starts at opacity:0 in the HTML; bloom it in from dark on first paint (esp. a
// recreated webview after an explorer restart) instead of popping. Gradual fade →
// photosensitivity-safe. Only the first successful load fades; later rendition swaps don't.
if (wall.complete && wall.naturalWidth > 0) wall.style.opacity = "1";
else wall.addEventListener("load", () => { wall.style.opacity = "1"; }, { once: true });
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
  applyBuddyInkMode(); // white-ink buddy frames invert on the bright day scene
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
  // A hidden / not-yet-attached window measures 0×0; keep the last good size rather than
  // collapsing the canvas to 1×1 (which mis-seeds motes and draws off-by-one). A real
  // resize re-runs this once the window has dimensions.
  if (r.width < 1 || r.height < 1) return;
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

const lanterns = makeLanterns(5);
let lanternPreview = false; // transient preview override (forces dusk on)
// Dusk factor for the floatglow lanterns: 0 by day, eased to 1 in the evening, full
// through the night, eased back to 0 after dawn. Independent of the day/night toggle.
function duskFactor(): number {
  if (lanternPreview) return 1;
  const d = new Date(), m = d.getHours() * 60 + d.getMinutes();
  const dawn = 6 * 60, dawnEnd = 7 * 60, dusk = 18 * 60, duskEnd = 19 * 60;
  if (m >= duskEnd || m < dawn) return 1; // evening + night
  if (m >= dusk && m < duskEnd) return (m - dusk) / 60; // dusk ramp up
  if (m >= dawn && m < dawnEnd) return 1 - (m - dawn) / 60; // dawn ramp down
  return 0; // daytime
}
// ---- "a star among the motes" (the fifth seal's whisper) ----
// Once all four elements are inscribed but the secret pentacle is still unfound, an
// occasional lone mote drifts by as a tiny ✦ outline — the world's own margin-note
// toward the hidden seal ("a seal written in no tome"). It retires forever the moment
// the secret is found (tomes:changed re-syncs the flags). Primary monitor only, and the
// same slow drift / gentle breathe profile as the ambient motes (photosensitivity-safe).
let secretFound = false;
let allDiscovered = false;
interface HintStar { x: number; y: number; r: number; phase: number; last: number }
let hintStar: HintStar | null = null;
let nextHintStarAt = 120_000 + Math.random() * 120_000; // first whisper ~2–4 min after boot
function starPath(ctx: CanvasRenderingContext2D, x: number, y: number, R: number) {
  ctx.beginPath();
  for (let i = 0; i < 10; i++) {
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    const rad = i % 2 === 0 ? R : R * 0.45;
    const px = x + Math.cos(a) * rad, py = y + Math.sin(a) * rad;
    if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
  }
  ctx.closePath();
}
function drawHintStar(ctx: CanvasRenderingContext2D, w: number, h: number, ts: number) {
  if (!allDiscovered || secretFound || isPrimary === false) { hintStar = null; return; }
  if (!hintStar) {
    if (ts < nextHintStarAt) return;
    hintStar = {
      x: w * (0.12 + Math.random() * 0.76), y: h + 12,
      r: (5 + Math.random() * 2) * Math.max(1, uiScale),
      phase: Math.random() * 6.28, last: ts,
    };
    return;
  }
  const s = hintStar;
  const dt = Math.min(0.05, Math.max(0, (ts - s.last) / 1000)); s.last = ts;
  s.y -= 14 * dt * Math.max(1, uiScale); // rises a touch quicker than the slowest motes
  if (s.y < -14) { hintStar = null; nextHintStarAt = ts + 180_000 + Math.random() * 120_000; return; }
  const x = s.x + Math.sin(ts * 0.0003 + s.phase) * 14; // the motes' gentle sway
  const breathe = 0.62 + 0.28 * Math.sin(ts * 0.0006 + s.phase); // ≲0.1 Hz shimmer
  const edge = Math.min(1, (h + 12 - s.y) / (h * 0.08), s.y / (h * 0.1)); // ease in/out at the rims
  ctx.save();
  ctx.globalAlpha = Math.max(0, 0.55 * breathe * edge);
  ctx.strokeStyle = pal.gold;
  ctx.lineWidth = 1.2;
  ctx.lineJoin = "round";
  ctx.shadowColor = pal.gold;
  ctx.shadowBlur = 8;
  starPath(ctx, x, s.y, s.r);
  ctx.stroke();
  ctx.restore();
}

// ---- Spell Embers: every cast leaves a lingering warm trace in the room ----
// After a cast's bloom, one ember-lantern tinted by the element's hue (the element's
// glyph faintly inked inside) rises slowly from the bloom site over ~90 s, breathing
// like the floatglow lanterns (~0.06 Hz), then fades — spent conjuring-ink inhabiting
// the scene. Seeded purely off the existing cast:fire broadcast; capped at 8.
interface Ember { x: number; y0: number; rgb: string; sigil: Sigil; born: number; phase: number; r: number }
let embers: Ember[] = [];
const EMBER_DUR = 90_000;
const EMBER_MAX = 8;
function hexRgbPrefix(hex: string): string {
  const m = /^#?([0-9a-f]{6})$/i.exec((hex || "").trim());
  if (!m) return "rgba(47,214,198,"; // teal fallback
  const v = parseInt(m[1], 16);
  return `rgba(${(v >> 16) & 255},${(v >> 8) & 255},${v & 255},`;
}
function drawEmbers(ctx: CanvasRenderingContext2D, w: number, h: number, ts: number) {
  if (!embers.length) return;
  let expired = false;
  ctx.save();
  ctx.globalCompositeOperation = "lighter"; // reads as warm light, like the lanterns
  for (const e of embers) {
    const age = ts - e.born;
    const p = age / EMBER_DUR;
    if (p >= 1) { expired = true; continue; }
    const rise = (1 - Math.pow(1 - p, 2)) * h * 0.28; // decelerating upward drift (cooling)
    const x = e.x + Math.sin(ts * 0.00012 + e.phase) * w * 0.015;
    const y = e.y0 - rise;
    const breathe = 0.78 + 0.22 * Math.sin(ts * 0.0004 + e.phase); // ~0.06 Hz, lantern-class
    const a = Math.min(1, age / 4000) * (p > 0.8 ? (1 - p) / 0.2 : 1) * breathe;
    const g = ctx.createRadialGradient(x, y, 0, x, y, e.r);
    g.addColorStop(0, e.rgb + (0.34 * a).toFixed(3) + ")");
    g.addColorStop(0.45, e.rgb + (0.16 * a).toFixed(3) + ")");
    g.addColorStop(1, e.rgb + "0)");
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(x, y, e.r, 0, 6.2832); ctx.fill();
    ctx.fillStyle = `rgba(255,238,205,${(0.4 * a).toFixed(3)})`; // bright ember core
    ctx.beginPath(); ctx.arc(x, y, 2.2, 0, 6.2832); ctx.fill();
    // the element's glyph, faintly inked inside the glow (static — stillness is canon)
    ctx.save();
    ctx.translate(x, y);
    ctx.strokeStyle = e.rgb + (0.3 * a).toFixed(3) + ")";
    ctx.lineWidth = 1.2;
    drawGlyphPath(ctx, e.sigil, e.r * 0.4);
    ctx.stroke();
    ctx.restore();
  }
  ctx.restore();
  if (expired) embers = embers.filter((e) => ts - e.born < EMBER_DUR);
}

function drawAmbientFrame(ts: number, b: Bands) {
  const c = ambient as CV;
  if (!motes.length) sizeAll();
  // Fall back to the window size if the canvas hasn't measured yet (0×0 before attach),
  // so a not-yet-sized surface never feeds NaN/0 dims into the draws.
  const w = c._cssw || window.innerWidth, h = c._cssh || window.innerHeight;
  const ctx = c.getContext("2d")!;
  drawAmbient(ctx, motes, w, h, ts, b, pal);
  drawLanterns(ctx, lanterns, w, h, ts, duskFactor()); // warm orbs at dusk
  drawEmbers(ctx, w, h, ts); // spent conjuring-ink from recent casts
  drawHintStar(ctx, w, h, ts); // the fifth seal's whisper (gated; usually a no-op)
}

const sealState = makeSealState();
function drawVizFrame(ts: number, b: Bands, dt: number, beat: boolean, tempo: number) {
  const c = viz as CV;
  const ctx = c.getContext("2d")!;
  stepSeal(sealState, b, dt, beat, tempo, ringSpeed);
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
      `<span class="dglyph" style="color:var(--c-gold)">${isNight ? "☾" : "☀"}</span>` +
      `<span class="dlab">${isNight ? "Night" : "Day"}</span>`;
    scheduleHitRects(); // the mode indicator width changed → dock layout shifted
    scheduleSizes();
  }
  if (inkLevelBar && inkPercent != null) {
    inkLevelBar.style.height = Math.max(0, Math.min(100, inkPercent)) + "%";
  }
}

// ---- dock element-pill labels reflect the LIVE spell-bindings ----
// Each pill's label is derived from what that element actually launches (its bound
// target), so a remap shows up instead of the old hardcoded "Steam/Discord/…". The
// target is a URL / protocol / path; we surface a short, friendly name.
function labelForTarget(target?: string): string {
  const s = (target || "").trim();
  if (!s || s.toLowerCase() === "files") return "Files";
  const m = /^([a-z][a-z0-9+.-]*):/i.exec(s);
  const scheme = m ? m[1].toLowerCase() : "";
  let label: string;
  if (scheme === "http" || scheme === "https") {
    let host = s;
    try { host = new URL(s).hostname; } catch { host = s.replace(/^https?:\/\//i, ""); }
    label = host.replace(/^www\./i, "").split(".")[0] || "Web";
  } else if (scheme && scheme !== "file") {
    label = scheme; // steam, discord, spotify, mailto, …
  } else {
    const base = s.split(/[\\/]/).pop() || s; // a path → the app/file basename
    label = base.replace(/\.[^.]+$/, "");
  }
  label = label.charAt(0).toUpperCase() + label.slice(1);
  return label.length > 11 ? label.slice(0, 10) + "…" : label;
}
function applyBindingLabels(mappings?: Record<string, string>) {
  if (!mappings) return;
  let changed = false;
  for (const key of ["fire", "water", "wind", "earth"]) {
    const el = document.getElementById("dockLab-" + key);
    if (!el) continue;
    const label = labelForTarget(mappings[key]);
    if (el.textContent !== label) { el.textContent = label; changed = true; }
  }
  if (changed) scheduleHitRects(); // label widths may have shifted the dock layout
}
listen<Record<string, string>>("settings:bindings", (e) => applyBindingLabels(e.payload));

// ---- tap feedback ----
// The dock can't receive DOM events, so the Rust hook emits `dock:tap` when a click
// lands on a control; flash that cell (a quick press + glow) so the tap is acknowledged.
function flashTap(kind: string, key?: string) {
  if (isPrimary === false) return; // only the primary monitor shows the dock
  let el: Element | null = null;
  if (kind === "pill" && key) el = document.querySelector(`[data-pill="${key}"]`);
  else if (kind === "cast") el = document.getElementById("castGlyph");
  else if (kind === "mode") el = document.getElementById("modeIndicator");
  else if (kind === "tomes") el = document.getElementById("tomesBtn");
  else if (kind === "attune") el = document.getElementById("attunePill");
  if (!el) return;
  el.classList.remove("dtap");
  void (el as HTMLElement).offsetWidth; // reflow so a rapid re-tap restarts the animation
  el.classList.add("dtap");
}
listen<string>("dock:tap", (e) => {
  const p = e.payload || "";
  if (p.startsWith("pill:")) flashTap("pill", p.slice(5));
  else if (p) flashTap(p);
});

// ---- hover affordance ----
// The wallpaper takes no DOM input, so the dock can't get a real :hover. Rust's mouse hook
// emits `dock:hover` (a cell key, or "" on leave) as the cursor moves over the dock on the
// exposed desktop; light that cell so the pointer has feedback that it's clickable.
function hoverEl(payload: string): Element | null {
  if (payload.startsWith("pill:")) return document.querySelector(`[data-pill="${payload.slice(5)}"]`);
  if (payload === "cast") return document.getElementById("castGlyph");
  if (payload === "mode") return document.getElementById("modeIndicator");
  if (payload === "attune") return document.getElementById("attunePill");
  if (payload === "tomes") return document.getElementById("tomesBtn");
  return null;
}
let hoveredEl: Element | null = null;
listen<string>("dock:hover", (e) => {
  if (isPrimary === false) return; // only the primary shows the dock
  const next = hoverEl(e.payload || "");
  if (next === hoveredEl) return;
  if (hoveredEl) hoveredEl.classList.remove("dhover");
  hoveredEl = next;
  if (hoveredEl) hoveredEl.classList.add("dhover");
});

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
const buddyImg = document.getElementById("buddyImg") as HTMLImageElement | null;
const buddySvg = document.getElementById("buddySvg") as SVGElement | null;
const buddyLabel = document.getElementById("buddyLabel");
const clockEl = document.getElementById("clock");
const sealEl = document.getElementById("seal");
const topStripEl = document.getElementById("topstrip");
const dockEl = document.getElementById("dock");
const titlePillEl = document.getElementById("titlePill");
const glyphsPillEl = document.getElementById("glyphsPill");
let isPrimary: boolean | null = null;

// ---- widget layout customization (control window edits {x%, y%, scale} per widget) ----
// An override repositions a widget (top-left anchor, % of the work area) and scales it
// on top of the auto monitor-height ui-scale. No override = its built-in placement.
interface WidgetPos { x: number; y: number; scale: number; vertical?: boolean }
const LAYOUT_WIDGETS: Record<string, HTMLElement | null> = { clock: clockEl, seal: sealEl, dock: dockEl, titlePill: titlePillEl, glyphsPill: glyphsPillEl };
const widgetOrigStyle: Record<string, string> = {};
for (const [name, el] of Object.entries(LAYOUT_WIDGETS)) if (el) widgetOrigStyle[name] = el.getAttribute("style") || "";
let widgetLayout: Record<string, WidgetPos> = {};
function applyWidgetLayout() {
  for (const [name, el] of Object.entries(LAYOUT_WIDGETS)) {
    if (!el) continue;
    const l = widgetLayout[name];
    const disp = el.style.display; // preserve primary/secondary visibility
    if (l) {
      el.style.left = l.x + "%";
      el.style.top = l.y + "%";
      el.style.right = "auto";
      el.style.bottom = "auto";
      el.style.transformOrigin = "top left";
      el.style.transform = `scale(${(uiScale * (l.scale || 1)).toFixed(3)})`;
    } else if (widgetOrigStyle[name] != null) {
      el.setAttribute("style", widgetOrigStyle[name]);
    }
    if (name === "dock") el.classList.toggle("dock-vertical", !!(l && l.vertical));
    el.style.display = disp;
  }
  scheduleSizes();
}
listen<Record<string, WidgetPos>>("settings:widgetLayout", (e) => { widgetLayout = e.payload || {}; applyWidgetLayout(); });

// Report each widget's actual rendered size (% of the work area) + the work-area
// aspect, so the control's layout preview can draw chips at true proportions. Only
// the primary monitor (which shows the widgets) reports.
function reportWidgetSizes() {
  if (!isPrimary) return;
  const rr = root.getBoundingClientRect();
  const rw = rr.width || 1, rh = rr.height || 1;
  const sizes: Record<string, { x: number; y: number; w: number; h: number }> = {};
  for (const [name, el] of Object.entries(LAYOUT_WIDGETS)) {
    if (!el) continue;
    const r = el.getBoundingClientRect();
    sizes[name] = { x: ((r.left - rr.left) / rw) * 100, y: ((r.top - rr.top) / rh) * 100, w: (r.width / rw) * 100, h: (r.height / rh) * 100 };
  }
  void invoke("report_widget_sizes", { sizes, aspect: rw / rh }).catch(() => {});
}
let sizesRaf = 0;
function scheduleSizes() {
  cancelAnimationFrame(sizesRaf);
  sizesRaf = requestAnimationFrame(() => requestAnimationFrame(reportWidgetSizes));
}
// This webview's own label. Rust emits each monitor's buddy message to its slot
// label AND stamps the label into the payload; we act only on our own (Tauri 2.11
// `EventTarget::Any` listeners otherwise receive every window's emit).
// Outside Tauri (a plain-browser dev preview) getCurrentWebviewWindow() THROWS at
// module scope, aborting the whole module (no sizeAll/startLoop → a dead scene) —
// fall back to a stub label so the scene renders in a browser too.
let selfLabel = "preview";
try { selfLabel = getCurrentWebviewWindow().label; } catch { /* browser preview */ }
if (buddyEl) buddyEl.style.transformOrigin = "44px 22px"; // sprite centre, for scaling
if (buddyEyes) buddyEyes.style.transformOrigin = "center 14px"; // new sprite's eye line

// ---- Brushbuddy walk frames (the DEFAULT sprite): white-ink line-art cycled from
// public/buddy/, advanced when the buddy moves and 5x while it is picked up. A custom
// `buddySprite` setting overrides these with a single static image.
const BUDDY_FRAMES = 18;
const BUDDY_FRAME_URLS = Array.from({ length: BUDDY_FRAMES }, (_, i) => `/buddy/frame_${String(i).padStart(2, "0")}.png`);
BUDDY_FRAME_URLS.forEach((u) => { const im = new Image(); im.src = u; }); // preload → instant swaps
let useFrames = true; // the walk frames are the default; false when a custom sprite is set
let frameIdx = 0, frameAccum = 0, lastBx = NaN, lastBy = NaN;
// One-time "hatch" ramp played when the fudemushi is born (first cast) or on the dev
// preview — a scale-pop out of nothing + a gold/teal ink-glow, folded into the
// per-frame buddy transform and counted down on each visible frame (~1.4 s at 30 Hz).
const BORN_DUR = 42;
let bornFrames = 0;
// The fudemushi's given name + a drifting label that surfaces briefly when it is
// (re)named and while it is picked up, then fades. LABEL_DUR ~ 3 s at 30 Hz.
let buddyName = "";
const LABEL_DUR = 92;
let labelFrames = 0;
function advanceBuddyFrame(m: BuddyMsg) {
  const moved = Number.isFinite(lastBx) ? Math.hypot(m.x - lastBx, m.y - lastBy) : 0;
  lastBx = m.x; lastBy = m.y;
  const step = m.held ? 5 : moved > 0.4 ? 1 : 0; // 5x while picked up; 1x walking; hold at rest
  frameAccum += step;
  if (frameAccum >= 1 && buddyImg) {
    frameIdx = (frameIdx + Math.floor(frameAccum)) % BUDDY_FRAMES;
    frameAccum -= Math.floor(frameAccum);
    buddyImg.src = BUDDY_FRAME_URLS[frameIdx];
  }
}
function applyBuddyInkMode() {
  // The white-ink frames invert to dark ink so they read on the bright DAY scene; a
  // custom (colour) sprite is shown as-is.
  if (buddyImg) buddyImg.style.filter = useFrames && curMode === "day" ? "invert(1)" : "";
}

// Swappable buddy sprite: empty = the default white-ink walk frames; a path/URL shows
// your own (static) image instead (local paths via Tauri's asset protocol). Falls
// back to the frames if a custom image fails to load.
function applyBuddySprite(src?: string) {
  if (!buddyImg || !buddySvg) return;
  buddySvg.style.display = "none"; // the old built-in SVG is superseded by the frames
  const s = (src || "").trim();
  if (s) {
    useFrames = false;
    const url = /^(https?:|\/|data:|asset:|tauri:|http:)/i.test(s) ? s : convertFileSrc(s);
    buddyImg.onerror = () => { buddyImg.onerror = null; useFrames = true; buddyImg.src = BUDDY_FRAME_URLS[frameIdx]; applyBuddyInkMode(); };
    buddyImg.src = url;
  } else {
    useFrames = true;
    buddyImg.onerror = null;
    buddyImg.src = BUDDY_FRAME_URLS[frameIdx];
  }
  buddyImg.style.display = "block";
  applyBuddyInkMode();
}
listen<string>("settings:buddySprite", (e) => applyBuddySprite(e.payload));
listen<boolean>("settings:buddyenabled", (e) => { if (buddyEl) buddyEl.style.display = e.payload ? "" : "none"; });
listen("buddy:born", () => { bornFrames = BORN_DUR; }); // the fudemushi hatches (first cast / dev preview)
listen<string>("settings:buddyname", (e) => { buddyName = (e.payload || "").trim(); if (buddyName) labelFrames = LABEL_DUR; }); // (re)named → drift the label

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
  scheduleSizes(); // widgets shown/hidden → re-report sizes to the layout preview
  updateLoopState(); // a secondary learned its role → may go static (primary-only mode)
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
  if (!m.visible) { buddyEl.style.opacity = "0"; if (buddyLabel) buddyLabel.style.opacity = "0"; return; } // hidden (off its monitor, or not yet hatched): skip transform → no damage
  // m.x/m.y arrive in physical px (Rust virtual-desktop coords); the transform and the
  // insets below are CSS px. Convert to CSS px so the drawn sprite lands where Rust
  // hit-tests it — otherwise, under fractional DPI (125%/150%, the laptop default) the
  // buddy is drawn dpr× too far from the origin and the drag never grabs it.
  const dpr = window.devicePixelRatio || 1;
  if (useFrames) advanceBuddyFrame(m); // step the walk cycle (5x while held)
  // While held, the buddy lifts (scales up) and gains a warm glow — the "picked up" cue.
  const lift = m.held ? 1.16 : 1;
  // The walk frames face LEFT, the opposite of the old SVG, so invert the flip for them.
  const sx = (useFrames ? -m.flip : m.flip) * uiScale * lift;
  // Birth (hatch) ramp: a one-time scale-pop out of nothing + a swelling gold/teal
  // ink-glow, played only on the frames right after the fudemushi is born.
  let bf = 1, bornGlow = "";
  if (bornFrames > 0) {
    const p = 1 - bornFrames / BORN_DUR; // 0 → 1 progress
    const c1 = 1.70158, c3 = c1 + 1;
    bf = 0.1 + 0.9 * (1 + c3 * Math.pow(p - 1, 3) + c1 * Math.pow(p - 1, 2)); // easeOutBack pop
    const g = Math.sin(Math.min(1, p * 1.15) * Math.PI); // glow swells then fades
    bornGlow = ` drop-shadow(0 0 ${(5 + g * 20).toFixed(1)}px var(--c-gold)) drop-shadow(0 0 ${(2 + g * 11).toFixed(1)}px var(--c-teal))`;
    buddyEl.style.opacity = Math.min(1, p * 1.7).toFixed(3);
    bornFrames--;
  } else {
    buddyEl.style.opacity = "1";
  }
  buddyEl.style.transform =
    `translate(${m.x / dpr - 44 - insetLeftCss}px, ${m.y / dpr - 22 - insetTopCss}px) scale(${sx * bf}, ${uiScale * lift * bf})`;
  buddyEl.style.filter = (m.held
    ? "drop-shadow(0 3px 6px rgba(8,6,14,.5)) drop-shadow(0 0 9px var(--c-gold))"
    : "drop-shadow(0 1px 3px rgba(8,6,14,.5))") + bornGlow;
  if (buddyEyes) buddyEyes.style.transform = `scaleY(${m.eye.toFixed(3)})`;
  // The drifting name label: held keeps it up; otherwise it lingers then fades. It
  // tracks the sprite, centred just above it (CSS eases the opacity in/out).
  if (buddyLabel) {
    if (m.held) labelFrames = LABEL_DUR; else if (labelFrames > 0) labelFrames--;
    const showLabel = buddyName.length > 0 && (m.held || labelFrames > 0);
    if (showLabel) {
      if (buddyLabel.textContent !== buddyName) buddyLabel.textContent = buddyName;
      buddyLabel.style.transform =
        `translate(${(m.x / dpr - insetLeftCss).toFixed(1)}px, ${(m.y / dpr - insetTopCss - 34 * uiScale).toFixed(1)}px) translateX(-50%)`;
    }
    buddyLabel.style.opacity = showLabel ? "1" : "0";
  }
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

// ---- bird sigil egg: a conjured bird BORN FROM INK (WHA "magic is drawn"). It
// glides in on a banking arc, beats asymmetric tapered-ink wings in flap→glide
// phrasing, trails sumi ink tinted toward the viz hue, then dissolves into ink-motes
// on exit. Day = near-black sumi; night = parchment-cream with a faint gold glow-ink.
let birdRaf = 0;

// A tapered curved brush-ribbon (filled): from A (half-width wa) through control C
// to B (half-width wb). The single primitive every part of the bird is drawn with.
function inkRibbon(ctx: CanvasRenderingContext2D, ax: number, ay: number, cx: number, cy: number, bx: number, by: number, wa: number, wb: number) {
  const dx = bx - ax, dy = by - ay, len = Math.hypot(dx, dy) || 1;
  const px = -dy / len, py = dx / len, wm = (wa + wb) / 2;
  ctx.beginPath();
  ctx.moveTo(ax + px * wa, ay + py * wa);
  ctx.quadraticCurveTo(cx + px * wm, cy + py * wm, bx + px * wb, by + py * wb);
  ctx.quadraticCurveTo(cx - px * wm, cy - py * wm, ax - px * wa, ay - py * wa);
  ctx.closePath();
  ctx.fill();
}

// Front-view bird (body + head + two wings + forked tail) in the current fillStyle.
// `wingY` is the wing-tip height (− up, + down); fl/fr foreshorten each wing for bank.
function birdBody(ctx: CanvasRenderingContext2D, wingY: number, fl: number, fr: number, g: number) {
  inkRibbon(ctx, 0, -6 * g, 0, 1 * g, 0, 8 * g, 1.7 * g, 0.5 * g); // torso (head→tail)
  ctx.beginPath(); ctx.ellipse(0, -6.4 * g, 2.4 * g, 2.7 * g, 0, 0, 6.2832); ctx.fill(); // head
  const cy = (-2 + (wingY + 2) * 0.6) * g; // wing curve control height
  inkRibbon(ctx, 2.4 * g, -2 * g, 12 * g * fr, cy, 22 * g * fr, wingY * g, 2.8 * g, 0.4 * g); // right wing
  inkRibbon(ctx, -2.4 * g, -2 * g, -12 * g * fl, cy, -22 * g * fl, wingY * g, 2.8 * g, 0.4 * g); // left wing
  inkRibbon(ctx, 0, 6 * g, -1.5 * g, 9 * g, -3.5 * g, 12 * g, 1.6 * g, 0.3 * g); // tail fork
  inkRibbon(ctx, 0, 6 * g, 1.5 * g, 9 * g, 3.5 * g, 12 * g, 1.6 * g, 0.3 * g);
}

function drawBird(ctx: CanvasRenderingContext2D, x: number, y: number, wingY: number, bank: number, s: number, alpha: number, accent: { color: string; alpha: number }) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(bank);
  ctx.scale(s, s);
  ctx.globalAlpha = Math.max(0, Math.min(1, alpha));
  const fr = Math.max(0.55, 1 - Math.max(0, bank) * 1.8); // banking foreshortens the far wing
  const fl = Math.max(0.55, 1 - Math.max(0, -bank) * 1.8);
  if (accent.alpha > 0) { // night gold glow-ink (slightly larger) / day faint paper offset
    ctx.save();
    ctx.globalAlpha = Math.max(0, Math.min(1, alpha)) * accent.alpha;
    ctx.fillStyle = accent.color;
    if (curMode !== "night") ctx.translate(1.2, 1.8);
    birdBody(ctx, wingY, fl, fr, curMode === "night" ? 1.16 : 1.0);
    ctx.restore();
  }
  ctx.fillStyle = curMode === "night" ? "#E8DEC9" : "#1A1714"; // sumi body
  birdBody(ctx, wingY, fl, fr, 1.0);
  ctx.restore();
  ctx.globalAlpha = 1;
}

function startBird() {
  const c = bloom as CV;
  const ctx = c.getContext("2d")!;
  const w = c._cssw || 0, h = c._cssh || 0;
  if (!w || !h) return;
  const reduced = !!window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches;
  const dir = Math.random() < 0.5 ? 1 : -1;
  const y0 = h * (0.16 + Math.random() * 0.30);
  const s = Math.max(1, uiScale) * 1.25;
  const dur = 7000 + Math.random() * 1800;
  const arc = h * (0.10 + Math.random() * 0.06);
  const drift = 44 * s;
  const accent = curMode === "night" ? { color: pal.gold, alpha: 0.45 } : { color: "#6B5E4A", alpha: 0.12 };
  const trail: { x: number; y: number; a: number }[] = [];
  let motes: { x: number; y: number; vx: number; vy: number; r: number; a: number }[] = [];
  let prevX = 0, prevY = 0, primed = false;
  const start = performance.now();
  cancelAnimationFrame(birdRaf);
  const anim = (now: number) => {
    const t = now - start, p = t / dur;
    ctx.clearRect(0, 0, w, h);
    if (p >= 1.3) return; // gone (after the exit motes settle)
    const ep = Math.min(1, p);
    const ease = ep < 0.5 ? 2 * ep * ep : 1 - Math.pow(-2 * ep + 2, 2) / 2; // easeInOutQuad
    const x = dir > 0 ? -60 + ease * (w + 120) : w + 60 - ease * (w + 120);
    const y = y0 - Math.sin(ep * Math.PI) * arc - ep * drift; // banking arc + drift up
    const vx = x - prevX, vy = y - prevY;
    prevX = x; prevY = y;
    const bank = reduced || !primed ? (dir > 0 ? 0.05 : -0.05) : Math.max(-0.22, Math.min(0.22, Math.atan2(vy, Math.abs(vx) + 0.001) * 0.55 + (dir > 0 ? 0.05 : -0.05)));
    primed = true;
    // wingbeat: slow flap↔glide phrasing × an asymmetric beat (fast down, slow up)
    const flapAmp = reduced ? 0.25 : 0.45 + 0.55 * Math.max(0, Math.cos(t * 0.0017));
    const bp = (t * 0.011) % 1;
    const wp = bp < 0.35 ? bp / 0.35 : 1 - (bp - 0.35) / 0.65; // 0=up .. 1=down
    const wingY = (-18 + 26 * wp) * flapAmp;
    let alpha = 1;
    if (ep < 0.12) alpha = ep / 0.12;                 // conjuring-on (wet-stroke reveal)
    else if (p > 0.9) alpha = Math.max(0, (1 - p) / 0.1); // dissolve toward ink
    // ink-trail (tinted toward the viz hue)
    if (p < 0.92 && !reduced) { trail.push({ x, y: y + 9 * s, a: 0.2 }); if (trail.length > 12) trail.shift(); }
    ctx.save();
    for (const tp of trail) { tp.a -= 0.016; if (tp.a <= 0) continue; ctx.globalAlpha = tp.a; ctx.fillStyle = pal.teal; ctx.beginPath(); ctx.arc(tp.x, tp.y, 2.1 * s, 0, 6.2832); ctx.fill(); }
    ctx.restore();
    // spawn exit ink-motes once, near the end
    if (p >= 0.9 && motes.length === 0 && !reduced) {
      const n = 8 + Math.floor(Math.random() * 5);
      for (let i = 0; i < n; i++) motes.push({ x, y, vx: (Math.random() - 0.5) * 34, vy: -8 - Math.random() * 30, r: 1.4 + Math.random() * 2.4, a: 0.55 });
    }
    if (p <= 1.02) drawBird(ctx, x, y, wingY, bank, s, alpha, accent);
    if (motes.length) {
      ctx.save(); ctx.fillStyle = pal.teal;
      for (const m of motes) { m.x += m.vx / 60; m.y += m.vy / 60; m.vy += 0.4; m.a -= 0.012; m.r *= 0.985; if (m.a <= 0) continue; ctx.globalAlpha = m.a; ctx.beginPath(); ctx.arc(m.x, m.y, m.r * s, 0, 6.2832); ctx.fill(); }
      ctx.restore();
      motes = motes.filter((m) => m.a > 0);
    }
    ctx.globalAlpha = 1;
    birdRaf = requestAnimationFrame(anim);
  };
  birdRaf = requestAnimationFrame(anim);
}
listen("cast:bird", () => startBird());

// ---- in-world casting self-discovery (Phase 13.2): a dip-pen traces a sigil and a
// parchment line invites her to take up the pen — so draw-to-cast (the heart of the
// gift) can't go unfound. Render-only on the #bloom canvas, dissolves on its own,
// reduced-motion-safe, primary monitor only. Rust gates how often it shows.
let hintRaf = 0;
function playCastHint() {
  const c = bloom as CV;
  const ctx = c.getContext("2d")!;
  const w = c._cssw || 0, h = c._cssh || 0;
  if (!w || !h) return;
  const reduced = !!window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches;
  const sc = Math.max(1, uiScale);
  const cx = w / 2, cy = h * 0.4;
  const R = Math.min(w, h) * 0.07 * sc;
  const trace = reduced ? 1 : 2400, hold = 4400, fade = 1600;
  const total = trace + hold + fade;
  const teal = pal.teal, gold = pal.gold;
  const start = performance.now();
  cancelAnimationFrame(hintRaf);
  const step = (now: number) => {
    const t = now - start;
    ctx.clearRect(0, 0, w, h);
    if (t >= total) { ctx.clearRect(0, 0, w, h); return; }
    const outA = t > trace + hold ? Math.max(0, 1 - (t - trace - hold) / fade) : Math.min(1, t / 400);
    // a soft scrim so the nudge reads on any wallpaper / mode
    const g = ctx.createRadialGradient(cx, cy + R * 0.6, 0, cx, cy + R * 0.6, R * 6);
    g.addColorStop(0, `rgba(8,6,16,${(0.5 * outA).toFixed(3)})`);
    g.addColorStop(1, "rgba(8,6,16,0)");
    ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
    // trace the ring (a circle sigil) with a dip-pen nib at the leading edge
    const tp = reduced ? 1 : Math.min(1, t / trace);
    ctx.save();
    ctx.translate(cx, cy);
    ctx.beginPath();
    ctx.strokeStyle = teal; ctx.globalAlpha = 0.9 * outA;
    ctx.lineWidth = 2.4 * sc; ctx.lineCap = "round";
    ctx.shadowColor = teal; ctx.shadowBlur = 12;
    ctx.arc(0, 0, R, -Math.PI / 2, -Math.PI / 2 + tp * 6.2832);
    ctx.stroke();
    if (tp < 1) {
      const a = -Math.PI / 2 + tp * 6.2832;
      ctx.beginPath(); ctx.fillStyle = gold; ctx.globalAlpha = outA;
      ctx.shadowColor = gold; ctx.shadowBlur = 16;
      ctx.arc(Math.cos(a) * R, Math.sin(a) * R, 3 * sc, 0, 6.2832); ctx.fill();
    }
    ctx.restore();
    ctx.shadowBlur = 0;
    // the invitation, fading in after the trace begins
    const textA = Math.min(1, Math.max(0, (t - trace * 0.7) / 700)) * outA;
    if (textA > 0) {
      ctx.textAlign = "center"; ctx.globalAlpha = textA;
      ctx.shadowColor = "rgba(0,0,0,.7)"; ctx.shadowBlur = 10;
      const s1 = Math.round(19 * sc);
      ctx.font = `${s1}px "Cinzel", serif`;
      ctx.fillStyle = gold;
      ctx.fillText("Magic is not spoken here — it is drawn.", cx, cy + R + s1 * 2.2);
      const s2 = Math.round(13 * sc);
      ctx.font = `${s2}px "EB Garamond", serif`;
      ctx.fillStyle = "rgba(243,236,222,.9)";
      ctx.fillText("take up the pen — Ctrl + Alt + W", cx, cy + R + s1 * 2.2 + s2 * 2.0);
      ctx.shadowBlur = 0;
    }
    ctx.globalAlpha = 1;
    hintRaf = requestAnimationFrame(step);
  };
  hintRaf = requestAnimationFrame(step);
}
listen("gift:casthint", () => { if (isPrimary !== false) playCastHint(); });

// ---- Silver-Eve festival egg: a drift of gold/silver star-motes ("the Night of
// the Falling Stars"), surfaced by Rust on the date or via the preview button.
let festivalRaf = 0;
function startFestival() {
  const c = bloom as CV;
  const ctx = c.getContext("2d")!;
  const w = c._cssw || 0, h = c._cssh || 0;
  if (!w || !h) return;
  const dur = 14000;
  const start = performance.now();
  const motes = Array.from({ length: 64 }, () => ({
    x: Math.random() * w, y: Math.random() * h, spd: 12 + Math.random() * 34,
    sway: Math.random() * 6.28, swaySpd: 0.4 + Math.random(), r: 1 + Math.random() * 2.2, gold: Math.random() < 0.55,
  }));
  let last = start;
  cancelAnimationFrame(festivalRaf);
  const anim = (now: number) => {
    const p = (now - start) / dur;
    const dt = Math.min(0.05, (now - last) / 1000); last = now;
    ctx.clearRect(0, 0, w, h);
    if (p >= 1) return;
    const fade = Math.min(1, Math.sin(p * Math.PI) * 1.8);
    for (const m of motes) {
      m.y += m.spd * dt;
      if (m.y > h + 12) { m.y = -12; m.x = Math.random() * w; }
      const x = m.x + Math.sin(now * 0.001 * m.swaySpd + m.sway) * 16;
      ctx.beginPath();
      ctx.fillStyle = m.gold ? `rgba(245,210,126,${(0.7 * fade).toFixed(3)})` : `rgba(214,222,235,${(0.6 * fade).toFixed(3)})`;
      ctx.shadowColor = ctx.fillStyle; ctx.shadowBlur = 9;
      ctx.arc(x, m.y, m.r, 0, 6.2832); ctx.fill();
    }
    ctx.shadowBlur = 0;
    festivalRaf = requestAnimationFrame(anim);
  };
  festivalRaf = requestAnimationFrame(anim);
}
listen("gift:festival", () => startFestival());

listen<CastFire>("cast:fire", (e) => {
  const m = e.payload;
  updateDockDisplay(curMode, m.ink); // reflect spent ink in the dock gauge
  startBloom(m);
  // Seed a spell ember at the bloom site (centre of this monitor): the cast's warmth
  // lingers in the room after the bloom fades.
  const c = ambient as CV;
  const w = c._cssw || window.innerWidth, h = c._cssh || window.innerHeight;
  if (embers.length >= EMBER_MAX) embers.shift();
  embers.push({
    x: w * (0.5 + (Math.random() - 0.5) * 0.08), y0: h * 0.56,
    rgb: hexRgbPrefix(m.hue), sigil: (m.sigil as Sigil) || "circle",
    born: performance.now(), phase: Math.random() * 6.28,
    r: (16 + Math.random() * 8) * Math.max(1, uiScale),
  });
});

// The score-tiered / dismiss flavour, surfaced as a gentle parchment caption near the
// dock after a cast (the overlay emits this before it closes). Primary monitor only; a
// single CSS opacity fade — photosensitivity-safe.
const castMsgEl = document.getElementById("castMsg");
const castMsgTextEl = document.getElementById("castMsgText");
const castMsgIconEl = document.getElementById("castMsgIcon");
let castMsgTimer = 0;
listen<{ message: string; icon: string; key: string }>("cast:msg", (e) => {
  if (isPrimary === false || !castMsgEl) return;
  if (castMsgTextEl) castMsgTextEl.textContent = e.payload.message || "";
  if (castMsgIconEl) castMsgIconEl.textContent = e.payload.icon || "✦";
  castMsgEl.style.opacity = "1";
  clearTimeout(castMsgTimer);
  castMsgTimer = window.setTimeout(() => { castMsgEl.style.opacity = "0"; }, 4200);
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

// ---- The Almanac of Small Spells: one Witch-Hat line a day in the top strip ----
// Deterministic by date (src/atelier/almanac.ts); crossfades at the day rollover,
// which updateClock's 1 s tick catches. No Rust, no persistence.
const almanacEl = document.getElementById("almanacPill");
let almanacDayKey = "";
function updateAlmanac(d: Date) {
  if (!almanacEl) return;
  const key = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
  if (key === almanacDayKey) return;
  almanacDayKey = key;
  const line = pickLine(d);
  if (almanacEl.textContent) {
    almanacEl.style.opacity = "0"; // gentle crossfade at midnight
    setTimeout(() => { almanacEl.textContent = line; almanacEl.style.opacity = "1"; }, 950);
  } else {
    almanacEl.textContent = line;
    almanacEl.style.opacity = "1";
  }
}

function updateClock() {
  const d = new Date();
  const hh = d.getHours();
  const h12 = hh % 12 === 0 ? 12 : hh % 12;
  elWeekday.textContent = WEEKDAYS[d.getDay()];
  elTime.textContent = h12 + ":" + String(d.getMinutes()).padStart(2, "0");
  elAmpm.textContent = hh >= 12 ? "PM" : "AM";
  elDate.textContent = (MONTHS[d.getMonth()] + " " + d.getDate()).toUpperCase();
  updateAlmanac(d);
}

let lastTs = 0;
let glowVal = 0;
let lastGlowStr = ""; // skip the glow opacity DOM write when the rounded value is unchanged
let frameRate = 30; // wallpaper render cap (fps); 0 = monitor refresh rate
let primaryOnly = true; // when true, only the primary monitor animates; secondaries stay static (~0 GPU)
let displayOn = true; // false while the monitor is powered off or the session is locked → pause the loop
let loopGen = 0; // bumped on framerate/loop change so the old loop self-cancels
let loopRunning = false;
let quietActive = false; // quiet-hours "embers" dim active
let quietLevel = 0; // eased 0..1; gentles the seal/motes/glow reactivity at night
let ringSpeed = 0.5; // seal ring rotation multiplier (1 / 0.5 / 0.25; settings:ringspeed) — half-speed default
// Drive the ambient loop with setTimeout, NOT requestAnimationFrame. An active rAF
// loop keeps Chromium's compositor in continuous "animating" mode, so it PRESENTS
// every vsync (e.g. 175 Hz) even though we only redraw at 30 Hz — confirmed via
// PresentMon as the dominant idle GPU cost (3 swapchains × ~175 fps). With a
// setTimeout loop the page damages only at our ~30 Hz draw, so the compositor
// presents ~30/s. Motion is dt-based, so cadence is unchanged. (Casting/bloom keep
// their own short-lived rAF loops — fine, they're transient.)
function drawFrame(ts: number) {
  const dt = lastTs ? Math.min(0.05, (ts - lastTs) / 1000) : 0.033;
  lastTs = ts;
  quietLevel += ((quietActive ? 1 : 0) - quietLevel) * 0.03; // ease the night calm (~2s)
  const raw = currentBands(ts); // generative or real (attuned) audio
  const qf = 1 - quietLevel * 0.55; // quiet hours gentle the reactivity
  const b = quietLevel > 0.01 ? { bass: raw.bass * qf, mid: raw.mid * qf, high: raw.high * qf } : raw;
  drawAmbientFrame(ts, b);
  drawVizFrame(ts, b, dt, takeBeat(), currentTempo()); // advances sealState (smoothed bands + pace)
  // Rotate the decorative clock/seal rings (was an infinite CSS animation). They live
  // ONLY on the primary (hidden elsewhere), so skip the writes on a known-secondary.
  if (isPrimary !== false) {
    if (ring1) ring1.style.transform = `rotate(${(ts / 333.333) % 360}deg)`; // 120s cw
    if (ring2) ring2.style.transform = `rotate(${(-ts / 222.222) % 360}deg)`; // 80s ccw
    if (ring3) ring3.style.transform = `rotate(${(ts / 555.556) % 360}deg)`; // 200s cw
  }
  // Glow follows the seal's already-enveloped bass, then eases again so brightness
  // shifts gradually — no rapid flicker (photosensitivity-friendly). Skip the DOM write
  // once the rounded value settles (a still/quiet scene costs nothing here).
  const glowTarget = parseFloat(glowOpacity({ bass: sealState.bass, mid: sealState.mid, high: sealState.high }, pal));
  glowVal += (glowTarget - glowVal) * 0.07;
  const glowStr = glowVal.toFixed(3);
  if (glowStr !== lastGlowStr) { lastGlowStr = glowStr; glow.style.opacity = glowStr; }
}

// Render loop. At 30/60 fps we drive with setTimeout, NOT requestAnimationFrame: an
// active rAF loop keeps the compositor presenting every vsync regardless of our draw
// rate (the dominant idle GPU cost, confirmed via PresentMon). setTimeout damages
// only at the cap, so the compositor presents at the cap. frameRate 0 = "monitor"
// uses rAF (full refresh; highest GPU, opt-in). loopGen cancels the old loop on a
// live framerate change.
function startLoop() {
  loopGen++;
  const gen = loopGen;
  loopRunning = true;
  const step = () => {
    if (gen !== loopGen) return; // superseded by a newer loop
    drawFrame(performance.now());
    if (frameRate <= 0) requestAnimationFrame(step);
    else setTimeout(step, 1000 / frameRate);
  };
  step();
}
function stopLoop() {
  loopGen++; // any in-flight step sees the gen change and stops
  loopRunning = false;
}
// A monitor animates unless it's a KNOWN secondary while "primary only" is on. A
// static (no-damage) webview produces ~0 compositor presents → ~0 GPU, while still
// showing the static art (the wall image + tint). No restart / no OS-wallpaper change.
function updateLoopState() {
  // Pause entirely while the display is off / the session is locked (nothing is visible),
  // else animate unless this is a known secondary under "primary only".
  const animate = displayOn && (!primaryOnly || isPrimary !== false);
  if (animate) {
    if (!loopRunning) startLoop();
  } else if (loopRunning) {
    stopLoop();
    glow.style.opacity = "0"; // drop the frozen bloom on a now-static secondary
  }
}
function setFrameRate(fps: number) {
  frameRate = Math.max(0, fps | 0);
  if (loopRunning) startLoop(); // retune live (no-op while static)
}

// ---- Quiet hours (13.3): the atelier dims to "embers" during the night window. The
// #quiet scrim eases via CSS (so static secondary monitors dim too); on the primary
// the render loop also lerps `quietLevel` to gentle the seal/motes/glow reactivity.
// Each window computes the window from its own local clock — no per-tick Rust traffic.
let quietCfg = { enabled: true, start: "22:00", end: "07:00" };
let quietPreview = false; // a transient preview override (holds the dim, then reverts)
const quietEl = document.getElementById("quiet");
function toMin(hhmm: string): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec((hhmm || "").trim());
  return m ? Math.min(23, +m[1]) * 60 + Math.min(59, +m[2]) : -1;
}
function isQuietNow(): boolean {
  if (!quietCfg.enabled) return false;
  const s = toMin(quietCfg.start), e = toMin(quietCfg.end);
  if (s < 0 || e < 0 || s === e) return false;
  const d = new Date(), now = d.getHours() * 60 + d.getMinutes();
  return s < e ? now >= s && now < e : now >= s || now < e; // wraps past midnight
}
function applyQuiet(active: boolean) {
  quietActive = active;
  if (quietEl) quietEl.style.opacity = active ? "0.5" : "0"; // CSS eases the dim
  // Keep the clock legible through quiet hours (22:00–07:00 is exactly when it's most
  // glanced at): lift it above the embers scrim and give it its own gentler eased dim,
  // so the time doesn't drop to ~half contrast with the rest of the scene. The dim rides
  // the element, so it follows a repositioned clock.
  if (clockEl) {
    clockEl.style.transition = "opacity 4s ease";
    clockEl.style.zIndex = active ? "95" : "20";
    clockEl.style.opacity = active ? "0.82" : "1";
  }
}
function checkQuiet() {
  if (!quietPreview) applyQuiet(isQuietNow());
}
setInterval(checkQuiet, 30000); // catch the window boundary (a cheap clock check)
listen<{ enabled: boolean; start: string; end: string }>("settings:quiethours", (e) => {
  if (e.payload) quietCfg = e.payload;
  checkQuiet();
});
listen("gift:quietpreview", () => {
  quietPreview = true;
  applyQuiet(true);
  setTimeout(() => { quietPreview = false; checkQuiet(); }, 8000);
});
listen("gift:lanternpreview", () => {
  lanternPreview = true;
  setTimeout(() => { lanternPreview = false; }, 12000);
});

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
// Top-strip "N / 4 glyphs inscribed" counter — base elements with at least one cast.
const glyphCountEl = document.getElementById("glyphcount");
const BASE_ELEMENTS = ["fire", "water", "wind", "earth"];
function updateGlyphCount(discovered?: Record<string, number>) {
  if (glyphCountEl) glyphCountEl.textContent = String(BASE_ELEMENTS.filter((k) => (discovered?.[k] ?? 0) > 0).length);
  allDiscovered = BASE_ELEMENTS.every((k) => (discovered?.[k] ?? 0) > 0); // gates the hint star
  scheduleSizes(); // the glyphs pill width changed → re-report size
}

// ---- Pages of the Tome: once-ever parchment lines honoring lifetime-cast milestones.
// Checked when tomes:changed re-syncs the counts (i.e. right after a cast); the reached
// milestone is persisted immediately so each line fires exactly once, ever. The line
// waits ~2.6 s so the cast's bloom and caption settle first, then fades in gently.
const milestoneEl = document.getElementById("milestoneMsg");
let milestoneShown = 0;
let milestoneTimer = 0;
const MILESTONES: [number, string][] = [
  [10, "Ten seals inscribed — the pen grows sure in your hand."],
  [50, "Fifty seals — drawn without looking. The hand remembers."],
  [100, "One hundred seals, each by your own hand."],
  [365, "A seal for every day of a year."],
];
function checkCastMilestone(discovered?: Record<string, number>) {
  if (isPrimary === false || !milestoneEl) return;
  const d = discovered || {};
  let total = 0;
  for (const k in d) total += d[k] || 0;
  let reached = 0, line = "";
  for (const [n, text] of MILESTONES) if (total >= n && n > milestoneShown) { reached = n; line = text; }
  if (!reached) return;
  milestoneShown = reached;
  invoke("set_milestone_shown", { value: reached }).catch(() => {});
  setTimeout(() => {
    milestoneEl.textContent = line;
    milestoneEl.style.opacity = "1";
    clearTimeout(milestoneTimer);
    milestoneTimer = window.setTimeout(() => { milestoneEl.style.opacity = "0"; }, 7500);
  }, 2600);
}
interface WallSettings { mode: Mode; colorblind?: boolean; discovered?: Record<string, number>; secretFound?: boolean; milestoneShown?: number; mappings?: Record<string, string>; buddySprite?: string; buddyName?: string; widgetLayout?: Record<string, WidgetPos>; frameRate?: number; primaryOnly?: boolean; buddyEnabled?: boolean; quietHoursEnabled?: boolean; quietStart?: string; quietEnd?: string; ringSpeed?: number }
invoke<WallSettings>("get_settings").then((s) => { if (s?.mode) applyMode(s.mode); if (s) { applyColorblind(!!s.colorblind); updateGlyphCount(s.discovered); secretFound = !!s.secretFound; if (typeof s.milestoneShown === "number") milestoneShown = s.milestoneShown; applyBindingLabels(s.mappings); applyBuddySprite(s.buddySprite); widgetLayout = s.widgetLayout || {}; applyWidgetLayout(); if (typeof s.frameRate === "number") setFrameRate(s.frameRate); if (typeof s.primaryOnly === "boolean") { primaryOnly = s.primaryOnly; updateLoopState(); } if (buddyEl) buddyEl.style.display = s.buddyEnabled === false ? "none" : ""; if (typeof s.quietHoursEnabled === "boolean") quietCfg = { enabled: s.quietHoursEnabled, start: s.quietStart || "22:00", end: s.quietEnd || "07:00" }; if (typeof s.ringSpeed === "number") ringSpeed = s.ringSpeed; buddyName = (s.buddyName || "").trim(); checkQuiet(); } }).catch(() => {});
listen<string>("settings:mode", (e) => applyMode(e.payload as Mode));
listen<number>("settings:framerate", (e) => setFrameRate(Number(e.payload) || 0));
listen<number>("settings:ringspeed", (e) => { ringSpeed = Number(e.payload) || 0.5; });
listen<boolean>("settings:primaryonly", (e) => { primaryOnly = !!e.payload; updateLoopState(); });
// Monitor powered off / session locked → pause the render loop; on / unlocked → resume.
// The last frame stays on the (now-off or hidden) canvas, so resuming just eases — no flash.
listen<boolean>("power:display", (e) => { displayOn = e.payload !== false; updateLoopState(); });
listen<boolean>("settings:colorblind", (e) => applyColorblind(!!e.payload));
// A new cast/secret updates the inscribed count (and the hint-star / milestone gates).
listen("tomes:changed", () => { invoke<WallSettings>("get_settings").then((s) => { updateGlyphCount(s?.discovered); secretFound = !!s?.secretFound; checkCastMilestone(s?.discovered); }).catch(() => {}); });
sizeAll();
scheduleHitRects(); // initial publish (clears until this monitor learns it's primary)
window.addEventListener("resize", () => {
  setUiScale();
  sizeAll();
  scheduleHitRects();
  pickWall(); // the window was just sized to its monitor → re-pick the rendition
  applyWidgetLayout(); // ui-scale changed → reapply custom widget scale
});
updateClock();
setInterval(updateClock, 1000);
startLoop(); // begins at the default 30 fps; setFrameRate retunes it once settings load
