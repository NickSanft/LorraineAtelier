export {}; // ensure module scope (only dynamic imports otherwise)

// Casting overlay (Slice 1). A summoned top-most window that captures a single
// ink stroke and renders it with a glow, then can be dismissed with Esc. This
// is the ONLY surface that can receive pointer input — the wallpaper layer
// (behind icons) cannot. Recognition/two-phase flow comes later.

const canvas = document.getElementById("c") as HTMLCanvasElement;
const ctx = canvas.getContext("2d")!;
const label = document.getElementById("label")!;

let W = 0, H = 0, DPR = 1;
function resize() {
  DPR = window.devicePixelRatio || 1;
  W = canvas.clientWidth; H = canvas.clientHeight;
  canvas.width = Math.round(W * DPR);
  canvas.height = Math.round(H * DPR);
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
}
window.addEventListener("resize", resize);
resize();

type Pt = { x: number; y: number };
let stroke: Pt[] = [];
let drawing = false;

function clear() {
  stroke = [];
  ctx.clearRect(0, 0, W, H);
  label.textContent = "Inscribe the sigil — Esc to dismiss";
}

function render() {
  ctx.clearRect(0, 0, W, H);
  if (stroke.length < 2) return;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  // glow pass
  ctx.strokeStyle = "rgba(47,214,198,.5)";
  ctx.lineWidth = 14;
  ctx.shadowColor = "rgba(47,214,198,.9)";
  ctx.shadowBlur = 24;
  trace();
  // core ink pass
  ctx.shadowBlur = 0;
  ctx.strokeStyle = "rgba(232,184,74,.95)";
  ctx.lineWidth = 3;
  trace();
}
function trace() {
  ctx.beginPath();
  ctx.moveTo(stroke[0].x, stroke[0].y);
  for (let i = 1; i < stroke.length; i++) ctx.lineTo(stroke[i].x, stroke[i].y);
  ctx.stroke();
}

canvas.addEventListener("pointerdown", (e) => {
  drawing = true;
  stroke = [{ x: e.clientX, y: e.clientY }];
  canvas.setPointerCapture(e.pointerId);
});
canvas.addEventListener("pointermove", (e) => {
  if (!drawing) return;
  stroke.push({ x: e.clientX, y: e.clientY });
  render();
});
canvas.addEventListener("pointerup", () => {
  drawing = false;
  label.textContent = `Captured ${stroke.length} points — Esc to dismiss, draw again to retry`;
});

async function hide() {
  try {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    await getCurrentWindow().hide();
  } catch { /* browser preview */ }
}

window.addEventListener("keydown", (e) => {
  if (e.key === "Escape") { clear(); hide(); }
});

// Clear the slate each time the window is summoned (regains focus).
(async () => {
  try {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    await getCurrentWindow().onFocusChanged(({ payload }) => { if (payload) clear(); });
  } catch { /* browser preview */ }
})();
