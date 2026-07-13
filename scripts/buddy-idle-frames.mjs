// One-time asset prep: turn the hand-drawn Brushbuddy IDLE frames into transparent,
// cropped, downscaled white-ink PNGs (public/buddy-idle/frame_NN.png) for the naming-rite
// idle animation. Same treatment as scripts/buddy-frames.mjs (the walk cycle): the source
// is dark ink on a light card, so we key alpha off how dark each pixel is (line cores →
// opaque, the light card → transparent) and recolour it WHITE so it glows on the dark
// overlay scrim; then crop every frame to the UNION bounding box (keeps the idle
// registered) and box-downscale (premultiplied, so soft edges stay clean).
//
// The idle frames are large (~3321x5024) and named frameNNNN.png (no underscore). We
// downscale to a target height rather than a fixed factor so the output sprite is a sane
// size regardless of the source resolution.
//
// Run: node scripts/buddy-idle-frames.mjs

import { readFileSync, writeFileSync, readdirSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import pkg from "pngjs";
const { PNG } = pkg;

const SRC = "mockup/assets/BrushbuddyIdle";
const OUT = "public/buddy-idle";
const CUTOFF = 236; // brightness >= this (the light card) → transparent; darker → ink
const TARGET_H = 540; // output max height in px (displayed ~half that; retina headroom)
// The source strokes are thin relative to the huge source resolution, so they wash out to
// a faint grey when box-downscaled. Boost the averaged alpha so line cores read solid white
// (also visually thickens the strokes a touch); the transparent card stays transparent.
const ALPHA_GAIN = 2.6;

mkdirSync(OUT, { recursive: true });
const files = readdirSync(SRC).filter((f) => /^frame\d+\.png$/.test(f)).sort();

const frames = [];
let minX = 1e9, minY = 1e9, maxX = -1, maxY = -1;

for (const f of files) {
  const png = PNG.sync.read(readFileSync(join(SRC, f)));
  const { width: w, height: h, data } = png;
  for (let i = 0; i < w * h; i++) {
    const bright = (data[i * 4] + data[i * 4 + 1] + data[i * 4 + 2]) / 3;
    // Fold in any existing transparency so a transparent source pixel never reads as ink.
    const srcA = data[i * 4 + 3] / 255;
    const a = bright >= CUTOFF ? 0 : Math.round(((CUTOFF - bright) / CUTOFF) * 255 * srcA);
    data[i * 4] = 255; data[i * 4 + 1] = 255; data[i * 4 + 2] = 255; data[i * 4 + 3] = a;
  }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (data[(y * w + x) * 4 + 3] > 16) {
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
  }
  frames.push(png);
}

const pad = 24;
minX = Math.max(0, minX - pad); minY = Math.max(0, minY - pad);
maxX = Math.min(frames[0].width - 1, maxX + pad); maxY = Math.min(frames[0].height - 1, maxY + pad);
const cw = maxX - minX + 1, ch = maxY - minY + 1;
const DOWNSCALE = Math.max(1, Math.round(ch / TARGET_H));
const ow = Math.floor(cw / DOWNSCALE), oh = Math.floor(ch / DOWNSCALE);

files.forEach((f, idx) => {
  const src = frames[idx];
  const out = new PNG({ width: ow, height: oh });
  for (let oy = 0; oy < oh; oy++) {
    for (let ox = 0; ox < ow; ox++) {
      let aSum = 0, rSum = 0, gSum = 0, bSum = 0, n = 0;
      for (let dy = 0; dy < DOWNSCALE; dy++) {
        for (let dx = 0; dx < DOWNSCALE; dx++) {
          const sx = minX + ox * DOWNSCALE + dx, sy = minY + oy * DOWNSCALE + dy;
          if (sx > maxX || sy > maxY) continue;
          const sp = (sy * src.width + sx) * 4;
          const a = src.data[sp + 3];
          aSum += a; rSum += src.data[sp] * a; gSum += src.data[sp + 1] * a; bSum += src.data[sp + 2] * a;
          n++;
        }
      }
      const dp = (oy * ow + ox) * 4;
      out.data[dp + 3] = n ? Math.min(255, Math.round((aSum / n) * ALPHA_GAIN)) : 0;
      if (aSum > 0) { out.data[dp] = Math.round(rSum / aSum); out.data[dp + 1] = Math.round(gSum / aSum); out.data[dp + 2] = Math.round(bSum / aSum); }
    }
  }
  writeFileSync(join(OUT, `frame_${String(idx).padStart(2, "0")}.png`), PNG.sync.write(out));
});

console.log(`wrote ${files.length} idle frames: crop ${cw}x${ch} /${DOWNSCALE} → ${ow}x${oh} in ${OUT}/`);
