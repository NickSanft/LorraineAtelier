export {}; // module scope

import { listen } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";

// Pure-logic core (DOM-free, unit-tested) extracted under src/atelier/*.
import type { Mode } from "./atelier/palette";
import {
  PAL,
  SIGILS,
  getVarsForMode,
  getWallFilterForMode,
  getTintBackgroundForMode,
  getTintOpacityForMode,
} from "./atelier/palette";
import { bands } from "./atelier/audio/generative";
import { makeMotes, drawAmbient, type Mote } from "./atelier/draw/ambient";
import { drawViz, attuned } from "./atelier/draw/viz";
import { glowOpacity } from "./atelier/draw/glow";

// Wallpaper renderer — ported faithfully from mockup/Atelier.dc.html (the spec).
// Display-only: the wallpaper receives no input, so interactive bits (dock, casting,
// the real Attune/day-night toggles) live elsewhere. Audio is the prototype's
// synthetic "bands" for now; Phase 6 will push real WASAPI bands from Rust.

// Default mode. Phase 7 settings will make this user-configurable + Rust-driven.
const MODE: Mode = "night";

const root = document.getElementById("root")!;
const wall = document.getElementById("wall") as HTMLImageElement;
const tint = document.getElementById("tint")!;
const glow = document.getElementById("glow")!;
const ambient = document.getElementById("ambient") as HTMLCanvasElement;
const viz = document.getElementById("viz") as HTMLCanvasElement;
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
const RENDITIONS: { minWidth: number; src: string }[] = [
  // { minWidth: 2561, src: "/wallpaper@3440.webp" },
  // { minWidth: 1921, src: "/wallpaper@1920.webp" },
];
const physicalWidth = window.innerWidth * (window.devicePixelRatio || 1);
const chosen = RENDITIONS
  .filter((r) => physicalWidth >= r.minWidth)
  .sort((a, b) => b.minWidth - a.minWidth)[0];
// Set the error handler BEFORE assigning src so a failed load falls back to base.
wall.onerror = () => {
  if (!wall.src.endsWith(BASE_ART)) {
    wall.onerror = null; // avoid loops if the base itself is missing
    wall.src = BASE_ART;
  }
};
wall.src = chosen ? chosen.src : BASE_ART;

let pal = PAL[MODE];
let uiScale = 1;
let motes: Mote[] = [];

function applyMode(mode: Mode) {
  const vars = getVarsForMode(mode);
  for (const k of Object.keys(vars)) root.style.setProperty(k, vars[k]);
  wall.style.filter = getWallFilterForMode(mode);
  tint.style.background = getTintBackgroundForMode(mode);
  tint.style.opacity = getTintOpacityForMode(mode);
  pal = PAL[mode];
  glow.style.background = `radial-gradient(circle, ${pal.glowColor}.5), ${pal.glowColor}0) 62%)`;
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
  const c = ambient as CV;
  const w = c._cssw || window.innerWidth, h = c._cssh || window.innerHeight;
  motes = makeMotes(w, h, 56);
}

function drawAmbientFrame(ts: number, b: ReturnType<typeof bands>) {
  const c = ambient as CV;
  if (!motes.length) sizeAll();
  const ctx = c.getContext("2d")!;
  drawAmbient(ctx, motes, c._cssw!, c._cssh!, ts, b, pal);
}

function drawVizFrame(ts: number, b: ReturnType<typeof bands>) {
  const c = viz as CV;
  const ctx = c.getContext("2d")!;
  drawViz(ctx, c._cssw!, c._cssh!, ts, b, pal, attuned(ts, SIGILS));
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
  }
  if (inkLevelBar && inkPercent != null) {
    inkLevelBar.style.height = Math.max(0, Math.min(100, inkPercent)) + "%";
  }
}

// ---- brushbuddy: a single ink companion that roams ACROSS all monitors ----
// Rust owns the buddy in virtual-desktop coordinates and pushes a `buddy` event
// to each monitor's wallpaper webview ~30 Hz (see spawn_buddy in lib.rs). Each
// window draws it in its own local coords and shows it only while it owns the
// buddy, so it walks off one screen and onto the next. The same event carries the
// `primary` flag that drives the primary/secondary widget split below.
interface BuddyMsg {
  label: string; x: number; y: number; visible: boolean; flip: number; eye: number; primary: boolean;
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
}

listen<BuddyMsg>("buddy", (e) => {
  const m = e.payload;
  if (m.label !== selfLabel) return; // ignore other monitors' messages (cross-talk guard)
  applyPrimary(m.primary);
  applyInsets(m.insetTop, m.insetRight, m.insetBottom, m.insetLeft);
  if (!buddyEl) return;
  buddyEl.style.opacity = m.visible ? "1" : "0";
  buddyEl.style.transform =
    `translate(${m.x - 24 - insetLeftCss}px, ${m.y - 21 - insetTopCss}px) scale(${m.flip * uiScale}, ${uiScale})`;
  if (buddyEyes) buddyEyes.style.transform = `scaleY(${m.eye.toFixed(3)})`;
}, { target: selfLabel });

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

function tick(ts: number) {
  const b = bands(ts);
  drawAmbientFrame(ts, b);
  drawVizFrame(ts, b);
  glow.style.opacity = glowOpacity(b, pal);
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
applyMode(MODE);
sizeAll();
window.addEventListener("resize", () => {
  setUiScale();
  sizeAll();
});
updateClock();
setInterval(updateClock, 1000);
requestAnimationFrame(tick);
