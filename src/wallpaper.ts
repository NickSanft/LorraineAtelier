export {}; // ensure module scope (this file has no other imports/exports)

// Wallpaper surface (Slice 1). Pure Canvas 2D, no audio capture: synthetic
// "bands" keep the seal breathing so we can verify it's rendering live behind
// the desktop icons. This is a deliberately small stand-in for the full
// Atelier visualizer; the real one ports from mockup/Atelier.dc.html.

const canvas = document.getElementById("c") as HTMLCanvasElement;
const ctx = canvas.getContext("2d")!;

let W = 0, H = 0, DPR = 1;
function resize() {
  DPR = window.devicePixelRatio || 1;
  W = canvas.clientWidth;
  H = canvas.clientHeight;
  canvas.width = Math.round(W * DPR);
  canvas.height = Math.round(H * DPR);
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
}
window.addEventListener("resize", resize);
resize();

// Drifting ink motes.
type Mote = { x: number; y: number; vx: number; vy: number; r: number; a: number };
const motes: Mote[] = [];
function seedMotes() {
  motes.length = 0;
  const n = Math.round((W * H) / 26000);
  for (let i = 0; i < n; i++) {
    motes.push({
      x: Math.random() * W, y: Math.random() * H,
      vx: (Math.random() - 0.5) * 0.12, vy: -0.05 - Math.random() * 0.12,
      r: 0.6 + Math.random() * 1.8, a: 0.12 + Math.random() * 0.3,
    });
  }
}
seedMotes();
window.addEventListener("resize", seedMotes);

const GOLD = "232,184,74";
const TEAL = "47,214,198";

function bands(t: number) {
  // Synthetic FFT stand-in: three slow oscillators in [0,1].
  const bass = 0.5 + 0.5 * Math.sin(t * 0.0011) * Math.sin(t * 0.0007 + 1);
  const mid = 0.5 + 0.5 * Math.sin(t * 0.0023 + 2);
  const high = 0.5 + 0.5 * Math.sin(t * 0.0041 + 4) * Math.cos(t * 0.0017);
  return { bass, mid, high };
}

function drawSeal(cx: number, cy: number, t: number, b: ReturnType<typeof bands>) {
  const base = Math.min(W, H) * 0.16;
  ctx.save();
  ctx.translate(cx, cy);

  // luminescent bloom driven by bass
  const glow = ctx.createRadialGradient(0, 0, 0, 0, 0, base * (1.6 + b.bass));
  glow.addColorStop(0, `rgba(${TEAL},${0.10 + b.bass * 0.22})`);
  glow.addColorStop(1, "rgba(47,214,198,0)");
  ctx.fillStyle = glow;
  ctx.fillRect(-W, -H, W * 2, H * 2);

  // concentric dashed rings, counter-rotating
  for (let i = 0; i < 3; i++) {
    const r = base * (0.6 + i * 0.32) * (1 + b.mid * 0.06);
    ctx.beginPath();
    ctx.setLineDash([6, 10 + i * 6]);
    ctx.lineDashOffset = (t * (0.02 + i * 0.01)) * (i % 2 ? -1 : 1);
    ctx.strokeStyle = `rgba(${i === 1 ? GOLD : TEAL},${0.35 + b.high * 0.4})`;
    ctx.lineWidth = 1.3;
    ctx.arc(0, 0, r, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.setLineDash([]);

  // radial spokes (high)
  const spokes = 12;
  ctx.strokeStyle = `rgba(${GOLD},${0.15 + b.high * 0.5})`;
  ctx.lineWidth = 1;
  for (let i = 0; i < spokes; i++) {
    const a = (i / spokes) * Math.PI * 2 + t * 0.0003;
    const r0 = base * 0.62, r1 = base * (1.0 + b.high * 0.25);
    ctx.beginPath();
    ctx.moveTo(Math.cos(a) * r0, Math.sin(a) * r0);
    ctx.lineTo(Math.cos(a) * r1, Math.sin(a) * r1);
    ctx.stroke();
  }

  // central sigil blooming with bass
  ctx.fillStyle = `rgba(${GOLD},${0.5 + b.bass * 0.5})`;
  ctx.beginPath();
  const pr = base * (0.16 + b.bass * 0.12);
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2 - Math.PI / 2;
    const rr = i % 2 ? pr : pr * 0.5;
    const x = Math.cos(a) * rr, y = Math.sin(a) * rr;
    i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
  }
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

function drawClock(cx: number, cy: number, t: number) {
  const r = Math.min(W, H) * 0.12;
  const now = new Date();
  ctx.save();
  ctx.translate(cx, cy);

  // halo for legibility
  const halo = ctx.createRadialGradient(0, 0, 0, 0, 0, r * 1.5);
  halo.addColorStop(0, "rgba(11,9,20,.6)");
  halo.addColorStop(1, "rgba(11,9,20,0)");
  ctx.fillStyle = halo;
  ctx.fillRect(-r * 2, -r * 2, r * 4, r * 4);

  // rotating tick ring
  ctx.rotate((t * 0.00006) % (Math.PI * 2));
  ctx.strokeStyle = `rgba(${GOLD},.5)`;
  ctx.lineWidth = 1;
  for (let i = 0; i < 48; i++) {
    const a = (i / 48) * Math.PI * 2;
    const r0 = r * (i % 4 === 0 ? 0.86 : 0.93), r1 = r;
    ctx.beginPath();
    ctx.moveTo(Math.cos(a) * r0, Math.sin(a) * r0);
    ctx.lineTo(Math.cos(a) * r1, Math.sin(a) * r1);
    ctx.stroke();
  }
  ctx.rotate(-((t * 0.00006) % (Math.PI * 2)));

  // time text
  const hh = now.getHours() % 12 || 12;
  const mm = now.getMinutes().toString().padStart(2, "0");
  ctx.fillStyle = "#efe6d2";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.font = `${Math.round(r * 0.42)}px "EB Garamond", Georgia, serif`;
  ctx.fillText(`${hh}:${mm}`, 0, -r * 0.04);
  ctx.fillStyle = `rgba(${GOLD},.9)`;
  ctx.font = `${Math.round(r * 0.14)}px "Cinzel", Georgia, serif`;
  ctx.fillText(now.toLocaleDateString(undefined, { weekday: "long" }).toUpperCase(), 0, r * 0.34);
  ctx.restore();
}

function frame(t: number) {
  ctx.clearRect(0, 0, W, H);
  const b = bands(t);

  // motes
  for (const m of motes) {
    m.x += m.vx; m.y += m.vy;
    if (m.y < -4) { m.y = H + 4; m.x = Math.random() * W; }
    if (m.x < -4) m.x = W + 4; else if (m.x > W + 4) m.x = -4;
    ctx.beginPath();
    ctx.fillStyle = `rgba(${GOLD},${m.a * (0.5 + b.high * 0.5)})`;
    ctx.arc(m.x, m.y, m.r, 0, Math.PI * 2);
    ctx.fill();
  }

  drawSeal(W * 0.34, H * 0.54, t, b);
  drawClock(W * 0.84, H * 0.22, t);

  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
