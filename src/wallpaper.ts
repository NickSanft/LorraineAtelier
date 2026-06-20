export {}; // module scope

// Wallpaper renderer — ported faithfully from mockup/Atelier.dc.html (the spec).
// Display-only: the wallpaper receives no input, so interactive bits (dock, casting,
// the real Attune/day-night toggles) live elsewhere. Audio is the prototype's
// synthetic "bands" for now; Phase 6 will push real WASAPI bands from Rust.

type Mode = "day" | "night";
// Default mode. Phase 7 settings will make this user-configurable + Rust-driven.
const MODE: Mode = "night";

const DAY_VARS: Record<string, string> = {
  "--c-text": "#241c14", "--c-soft": "rgba(36,28,20,.62)", "--c-faint": "rgba(36,28,20,.4)",
  "--c-panel": "rgba(244,237,221,.74)", "--c-panel-2": "rgba(244,237,221,.9)",
  "--c-edge": "rgba(120,90,58,.5)", "--c-gold": "#9c6f2a", "--c-gold-2": "#c79a4c",
  "--c-teal": "#1d8c80", "--c-ink": "#241c14", "--c-halo": "rgba(247,240,224,.72)",
};
const NIGHT_VARS: Record<string, string> = {
  "--c-text": "#efe6d2", "--c-soft": "rgba(239,230,210,.66)", "--c-faint": "rgba(239,230,210,.4)",
  "--c-panel": "rgba(22,20,36,.6)", "--c-panel-2": "rgba(22,20,36,.82)",
  "--c-edge": "rgba(232,184,74,.42)", "--c-gold": "#e8b84a", "--c-gold-2": "#f5d27e",
  "--c-teal": "#2fd6c6", "--c-ink": "#0d0b16", "--c-halo": "rgba(11,9,20,.62)",
};
// Canvas palette (distinct from the CSS vars; mote/glowColor are partial rgba prefixes).
const PAL = {
  day: { teal: "#1d8c80", gold: "#b8893a", azure: "#3f6fc4", ink: "#3a2e22", mote: "rgba(120,92,52,", glowMax: 0.5, glowColor: "rgba(180,137,58," },
  night: { teal: "#2fd6c6", gold: "#e8b84a", azure: "#5a93f0", ink: "#0d0b16", mote: "rgba(120,200,190,", glowMax: 1.0, glowColor: "rgba(47,214,198," },
};
// Central sigil cycles through the four element seals (no progression state yet).
const SIGILS = ["triangle-up", "triangle-down", "circle", "square"];

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

let pal = PAL[MODE];

function applyMode(mode: Mode) {
  const vars = mode === "night" ? NIGHT_VARS : DAY_VARS;
  for (const k of Object.keys(vars)) root.style.setProperty(k, vars[k]);
  wall.style.filter =
    mode === "night" ? "brightness(.58) saturate(.85) contrast(1.02)" : "brightness(1.02) saturate(1.02)";
  tint.style.background =
    mode === "night"
      ? "radial-gradient(125% 120% at 50% 38%, rgba(44,32,72,.55), rgba(10,8,20,.8))"
      : "radial-gradient(125% 110% at 50% 8%, rgba(232,200,140,.16), rgba(120,86,46,.22))";
  tint.style.opacity = mode === "night" ? ".92" : ".5";
  pal = PAL[mode];
  glow.style.background = `radial-gradient(circle, ${pal.glowColor}.5), ${pal.glowColor}0) 62%)`;
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

interface Mote { x: number; y: number; r: number; s: number; d: number; a: number; gold: boolean; }
let motes: Mote[] = [];
function initAmbient() {
  const c = ambient as CV;
  const w = c._cssw || window.innerWidth, h = c._cssh || window.innerHeight;
  const n = 56;
  motes = [];
  for (let i = 0; i < n; i++) {
    motes.push({
      x: Math.random() * w, y: Math.random() * h,
      r: 0.6 + Math.random() * 2.0, s: 0.15 + Math.random() * 0.5,
      d: Math.random() * 6.28, a: 0.1 + Math.random() * 0.4, gold: Math.random() < 0.16,
    });
  }
}
function sizeAll() {
  sizeCanvas(ambient);
  sizeCanvas(viz);
  initAmbient();
}

interface Bands { bass: number; mid: number; high: number; }
let _t = 0;
function bands(): Bands {
  const t = _t;
  return {
    bass: 0.18 + 0.12 * Math.sin(t * 0.0011) + 0.05 * Math.sin(t * 0.0007),
    mid: 0.14 + 0.1 * Math.sin(t * 0.0017 + 1),
    high: 0.08 + 0.07 * Math.sin(t * 0.0029 + 2),
  };
}

function drawAmbient(ts: number, b: Bands) {
  const c = ambient as CV;
  if (!motes.length) initAmbient();
  const ctx = c.getContext("2d")!;
  const w = c._cssw!, h = c._cssh!;
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

function drawGlyphPath(ctx: CanvasRenderingContext2D, sigil: string, s: number) {
  ctx.beginPath();
  if (sigil === "circle") ctx.arc(0, 0, s, 0, 6.2832);
  else if (sigil === "square") ctx.rect(-s * 0.82, -s * 0.82, s * 1.64, s * 1.64);
  else if (sigil === "triangle-up") { ctx.moveTo(0, -s); ctx.lineTo(s * 0.92, s * 0.7); ctx.lineTo(-s * 0.92, s * 0.7); ctx.closePath(); }
  else { ctx.moveTo(0, s); ctx.lineTo(s * 0.92, -s * 0.7); ctx.lineTo(-s * 0.92, -s * 0.7); ctx.closePath(); }
}
function attuned(): string { return SIGILS[Math.floor(_t / 4000) % SIGILS.length]; }

function drawViz(ts: number, b: Bands) {
  const c = viz as CV;
  const ctx = c.getContext("2d")!;
  const w = c._cssw!, h = c._cssh!;
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
  const at = attuned();
  const s = R * 0.2 * (1 + b.bass * 0.5);
  ctx.globalAlpha = 0.7 + b.bass * 0.3;
  ctx.strokeStyle = gold;
  ctx.fillStyle = gold;
  ctx.lineWidth = 2.4;
  ctx.shadowColor = gold;
  ctx.shadowBlur = 14 + b.bass * 26;
  drawGlyphPath(ctx, at, s);
  ctx.stroke();
  ctx.restore();
  ctx.globalAlpha = 1;
  ctx.shadowBlur = 0;
}

function updateGlow(b: Bands) {
  glow.style.opacity = (pal.glowMax * (0.12 + b.bass * 0.85)).toFixed(3);
}

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
  _t = ts;
  const b = bands();
  drawAmbient(ts, b);
  drawViz(ts, b);
  updateGlow(b);
  requestAnimationFrame(tick);
}

// Widget size scales with monitor height so widgets stay proportional across
// resolutions (1440 → 1.5 = +50%; 1080 → ~1.1). Must run before sizeAll() so the
// scaled canvas bounding box is measured. Phase 7 will make widget size + position
// user-adjustable per monitor (the movable/resizable feature).
function setUiScale() {
  const s = Math.max(1, Math.min(2.2, window.innerHeight / 960));
  root.style.setProperty("--ui-scale", s.toFixed(3));
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
