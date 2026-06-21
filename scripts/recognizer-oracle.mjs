// Golden-corpus generator for the stroke recognizer parity test.
//
// Contains the prototype's JS recognizer (mockup/Atelier.dc.html) VERBATIM (as
// standalone functions), generates a deterministic set of input strokes, runs the
// oracle over them, and writes tests/corpus/recognizer.json. The Rust port
// (src-tauri/src/recognizer.rs) is asserted against this corpus by
// src-tauri/tests/recognizer_parity.rs.
//
// Determinism: a seeded PRNG (mulberry32) drives all jitter so re-running this
// regenerates an identical corpus (no churn). Run with: pnpm dump-corpus
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
const outPath = path.join(projectRoot, "src-tauri", "tests", "corpus", "recognizer.json");

// ---------------------------------------------------------------------------
// Recognizer — VERBATIM port of the prototype's class methods to plain functions.
// (mockup/Atelier.dc.html lines ~531-588.) Do not "improve" these — the Rust
// port mirrors them and the whole point is byte-for-byte algorithmic parity.
// ---------------------------------------------------------------------------
const _len = (p) => { let d = 0; for (let i = 1; i < p.length; i++) d += Math.hypot(p[i].x - p[i - 1].x, p[i].y - p[i - 1].y); return d; };
const _resample = (raw, n) => { const p = raw.map(q => ({ x: q.x, y: q.y })); const I = _len(p) / (n - 1); if (!isFinite(I) || I === 0) return p; let D = 0; const out = [p[0]]; for (let i = 1; i < p.length; i++) { let d = Math.hypot(p[i].x - p[i - 1].x, p[i].y - p[i - 1].y); if (D + d >= I) { const t = (I - D) / d; const np = { x: p[i - 1].x + t * (p[i].x - p[i - 1].x), y: p[i - 1].y + t * (p[i].y - p[i - 1].y) }; out.push(np); p.splice(i, 0, np); D = 0; } else D += d; } while (out.length < n) out.push({ x: p[p.length - 1].x, y: p[p.length - 1].y }); return out.slice(0, n); };
const _bbox = (p) => { let mnx = 1e9, mny = 1e9, mxx = -1e9, mxy = -1e9; for (const q of p) { mnx = Math.min(mnx, q.x); mny = Math.min(mny, q.y); mxx = Math.max(mxx, q.x); mxy = Math.max(mxy, q.y); } return { mnx, mny, mxx, mxy, w: mxx - mnx, h: mxy - mny }; };
const _area = (p) => { let a = 0; for (let i = 0; i < p.length; i++) { const j = (i + 1) % p.length; a += p[i].x * p[j].y - p[j].x * p[i].y; } return a / 2; };
const _angBetween = (a, b) => { const cr = a.x * b.y - a.y * b.x; const dt = a.x * b.x + a.y * b.y; return Math.atan2(cr, dt); };
const _spanX = (arr) => { if (!arr.length) return 0; let mn = 1e9, mx = -1e9; for (const q of arr) { mn = Math.min(mn, q.x); mx = Math.max(mx, q.x); } return mx - mn; };
const _spanY = (arr) => { if (!arr.length) return 0; let mn = 1e9, mx = -1e9; for (const q of arr) { mn = Math.min(mn, q.y); mx = Math.max(mx, q.y); } return mx - mn; };
const _triOrient2 = (pts, bb) => { const h = bb.h || 1, w = bb.w || 1;
  const topB = pts.filter(q => q.y <= bb.mny + h * 0.30), botB = pts.filter(q => q.y >= bb.mxy - h * 0.30);
  const leftB = pts.filter(q => q.x <= bb.mnx + w * 0.30), rightB = pts.filter(q => q.x >= bb.mxx - w * 0.30);
  const wTop = _spanX(topB), wBot = _spanX(botB), hLeft = _spanY(leftB), hRight = _spanY(rightB);
  const bands = [{ k: 'up', v: wTop }, { k: 'down', v: wBot }, { k: 'right', v: hRight }, { k: 'left', v: hLeft }].sort((a, b) => a.v - b.v);
  const apex = bands[0].k; let sideways = false, jutDir = 0;
  let type = apex === 'down' ? 'triangle-down' : apex === 'up' ? 'triangle-up' : (wBot >= wTop ? 'triangle-up' : 'triangle-down');
  if (apex === 'left' || apex === 'right') { sideways = true; jutDir = apex === 'right' ? 1 : -1; }
  return { type, sideways, jutDir };
};
const classify = (raw) => { const pts = _resample(raw, 64); const bb = _bbox(pts); const diag = Math.hypot(bb.w, bb.h) || 1; const gap = Math.hypot(pts[0].x - pts[pts.length - 1].x, pts[0].y - pts[pts.length - 1].y) / diag;
  const step = 3; const n0 = pts.length;
  const turn = new Array(n0); for (let i = 0; i < n0; i++) { const pa = pts[(i - step + n0) % n0], pb = pts[(i + step) % n0]; const a = { x: pts[i].x - pa.x, y: pts[i].y - pa.y }; const b = { x: pb.x - pts[i].x, y: pb.y - pts[i].y }; turn[i] = Math.abs(_angBetween(a, b)); }
  let startIdx = 0; if (gap < 0.34) { let mn = Infinity; for (let i = 0; i < n0; i++) { if (turn[i] < mn) { mn = turn[i]; startIdx = i; } } }
  const rot = startIdx ? pts.slice(startIdx).concat(pts.slice(0, startIdx)) : pts;
  const marks = []; for (let i = step; i < rot.length - step; i++) { const a = { x: rot[i].x - rot[i - step].x, y: rot[i].y - rot[i - step].y }; const b = { x: rot[i + step].x - rot[i].x, y: rot[i + step].y - rot[i].y }; const ang = Math.abs(_angBetween(a, b)); if (ang > 0.78) marks.push({ i, ang }); }
  const clusters = []; for (const m of marks) { const last = clusters[clusters.length - 1]; if (last && m.i - last.i <= 4) { if (m.ang > last.ang) { last.i = m.i; last.ang = m.ang; } } else clusters.push({ i: m.i, ang: m.ang }); }
  const nC = clusters.length; const peri = _len(pts); const area = Math.abs(_area(pts)); const circ = peri > 0 ? (4 * Math.PI * area) / (peri * peri) : 0;
  if (nC >= 5 && gap < 0.62) return { type: 'secret', base: 'secret', score: 88, nC, circ, gap, secret: true, sideways: false, jutDir: 0, aspect: 0, closure: 0, regularity: 0 };
  let type;
  if (nC >= 4 && gap < 0.5) type = 'square';
  else if (nC === 3) type = 'triangle';
  else if (nC <= 1 && circ > 0.6) type = 'circle';
  else if (nC === 2) type = 'triangle';
  else type = circ > 0.62 ? 'circle' : 'triangle';
  let base = type; let sideways = false, jutDir = 0;
  if (type === 'triangle') { const ori = _triOrient2(pts, bb); type = ori.type; base = 'triangle'; sideways = ori.sideways; jutDir = ori.jutDir; }
  const aspect = 1 - Math.min(1, Math.abs(bb.w - bb.h) / Math.max(bb.w, bb.h, 1));
  let clos = type === 'circle' ? Math.max(0, 1 - gap / 0.5) : Math.max(0, 1 - gap / 0.85) * 0.55 + 0.45;
  let reg;
  if (type === 'circle') { const cx = (bb.mnx + bb.mxx) / 2, cy = (bb.mny + bb.mxy) / 2; const rs = pts.map(q => Math.hypot(q.x - cx, q.y - cy)); const mean = rs.reduce((a, b) => a + b, 0) / rs.length; const v = rs.reduce((a, b) => a + Math.abs(b - mean), 0) / rs.length / (mean || 1); reg = Math.max(0, 1 - v * 1.8);
  } else { const ideal = type === 'square' ? 4 : 3; reg = Math.max(0, 1 - Math.abs(nC - ideal) * 0.28); }
  const score = Math.max(8, Math.min(100, (aspect * 0.34 + clos * 0.3 + reg * 0.36) * 100));
  return { type, base, score, nC, circ, gap, sideways, jutDir, aspect, closure: clos, regularity: reg };
};
const analyzeRing = (raw, center) => { const pts = _resample(raw, 64); const bb = _bbox(pts); const diag = Math.hypot(bb.w, bb.h) || 1; const gap = Math.hypot(pts[0].x - pts[pts.length - 1].x, pts[0].y - pts[pts.length - 1].y) / diag; const closed = gap < 0.3; const peri = _len(pts); const area = _area(pts); const acirc = Math.abs(area); const circ = peri > 0 ? (4 * Math.PI * acirc) / (peri * peri) : 0;
  let inside = false; if (center) { for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) { const xi = pts[i].x, yi = pts[i].y, xj = pts[j].x, yj = pts[j].y; const intersect = ((yi > center.y) !== (yj > center.y)) && (center.x < (xj - xi) * (center.y - yi) / ((yj - yi) || 1e-9) + xi); if (intersect) inside = !inside; } }
  const clos = Math.max(0, 1 - gap / 0.5); const score = Math.max(10, Math.min(100, (clos * 0.5 + Math.min(1, circ) * 0.5) * 100));
  return { closed, encloses: inside, ccw: (area > 0), score, circ, gap };
};

// ---------------------------------------------------------------------------
// Deterministic fixtures.
// ---------------------------------------------------------------------------
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rng = mulberry32(0x5EED1234);
const jitter = (amp) => (rng() - 0.5) * 2 * amp;

function linePts(a, b, k) { const out = []; for (let i = 0; i < k; i++) { const t = i / k; out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }); } return out; }
function circlePts(cx, cy, r, n, cw, amp = 0) { const out = []; for (let i = 0; i <= n; i++) { const t = i / n * Math.PI * 2; const a = cw ? t : -t; out.push({ x: cx + r * Math.cos(a) + jitter(amp), y: cy + r * Math.sin(a) + jitter(amp) }); } return out; }
function polyPts(verts, kPerEdge, amp = 0, close = true) { const out = []; const vs = close ? verts.concat([verts[0]]) : verts; for (let e = 0; e < vs.length - 1; e++) { const seg = linePts(vs[e], vs[e + 1], kPerEdge); for (const p of seg) out.push({ x: p.x + jitter(amp), y: p.y + jitter(amp) }); } out.push({ x: vs[vs.length - 1].x + jitter(amp), y: vs[vs.length - 1].y + jitter(amp) }); return out; }
function starPts(cx, cy, R, kPerEdge, amp = 0) {
  // {5/2} star: connect every 2nd vertex of a regular pentagon.
  const v = []; for (let i = 0; i < 5; i++) { const a = -Math.PI / 2 + i * 2 * Math.PI / 5; v.push({ x: cx + R * Math.cos(a), y: cy + R * Math.sin(a) }); }
  const order = [v[0], v[2], v[4], v[1], v[3]];
  return polyPts(order, kPerEdge, amp, true);
}
const toPairs = (pts) => pts.map(p => [p.x, p.y]);
const centroid = (pts) => { let sx = 0, sy = 0; for (const p of pts) { sx += p.x; sy += p.y; } return { x: sx / pts.length, y: sy / pts.length }; };

// Sigil fixtures (classify).
const sigilCases = [];
const addSig = (name, pts) => { const r = classify(pts); sigilCases.push({ name, points: toPairs(pts), expected: { kind: r.type, base: r.base, nC: r.nC, score: r.score, gap: r.gap, circ: r.circ, sideways: !!r.sideways, jutDir: r.jutDir || 0, secret: !!r.secret, aspect: r.aspect, closure: r.closure, regularity: r.regularity } }); };

addSig("circle_cw_clean", circlePts(150, 150, 100, 96, true));
addSig("circle_ccw_clean", circlePts(150, 150, 100, 96, false));
addSig("circle_noisy", circlePts(150, 150, 100, 96, true, 4));
addSig("square_clean", polyPts([{ x: 60, y: 60 }, { x: 240, y: 60 }, { x: 240, y: 240 }, { x: 60, y: 240 }], 16));
addSig("square_noisy", polyPts([{ x: 60, y: 62 }, { x: 242, y: 60 }, { x: 240, y: 240 }, { x: 60, y: 238 }], 16, 4));
addSig("triangle_up_clean", polyPts([{ x: 150, y: 55 }, { x: 245, y: 240 }, { x: 55, y: 240 }], 22));
addSig("triangle_down_clean", polyPts([{ x: 55, y: 60 }, { x: 245, y: 60 }, { x: 150, y: 245 }], 22));
addSig("triangle_left_clean", polyPts([{ x: 55, y: 150 }, { x: 240, y: 55 }, { x: 240, y: 245 }], 22));
addSig("triangle_right_clean", polyPts([{ x: 245, y: 150 }, { x: 60, y: 55 }, { x: 60, y: 245 }], 22));
addSig("triangle_up_noisy", polyPts([{ x: 150, y: 58 }, { x: 244, y: 240 }, { x: 56, y: 242 }], 22, 4));
addSig("pentacle_secret", starPts(150, 150, 110, 16));
addSig("pentacle_secret_noisy", starPts(150, 150, 110, 16, 3));

// Ring fixtures (analyzeRing). Center = the would-be sigil centroid.
const ringCases = [];
const addRing = (name, pts, center) => { const r = analyzeRing(pts, center); ringCases.push({ name, points: toPairs(pts), center: [center.x, center.y], expected: { closed: r.closed, encloses: r.encloses, ccw: r.ccw, score: r.score, circ: r.circ, gap: r.gap } }); };

addRing("ring_cw_encloses", circlePts(150, 150, 120, 96, true), { x: 150, y: 150 });
addRing("ring_ccw_encloses", circlePts(150, 150, 120, 96, false), { x: 150, y: 150 });
addRing("ring_cw_noisy", circlePts(150, 150, 120, 96, true, 5), { x: 150, y: 150 });
// Open ring: a 300-degree arc leaves a clear gap → not closed.
const openArc = (() => { const out = []; const n = 90; for (let i = 0; i <= n; i++) { const t = (i / n) * (Math.PI * 2 * (300 / 360)); out.push({ x: 150 + 120 * Math.cos(t), y: 150 + 120 * Math.sin(t) }); } return out; })();
addRing("ring_open_arc", openArc, { x: 150, y: 150 });
// Closed ring but the centre lies far outside it → does not enclose.
addRing("ring_not_enclosing", circlePts(150, 150, 80, 96, true), { x: 360, y: 360 });

const corpus = { classify: sigilCases, ring: ringCases };
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, JSON.stringify(corpus, null, 2) + "\n", "utf-8");
console.log(`[oracle] wrote ${sigilCases.length} classify + ${ringCases.length} ring cases -> ${path.relative(projectRoot, outPath)}`);
