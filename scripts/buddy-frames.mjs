// One-time asset prep: turn the hand-drawn Brushbuddy walk frames into transparent,
// cropped, downscaled PNGs for the wallpaper sprite (public/buddy/frame_NN.png).
//
// The source is BLACK line-art on an opaque #F1F1F1 card — and the body interior is
// the SAME #F1F1F1 (no fill), so there is no body to "keep": the drawing IS the
// outlines. We convert it to WHITE ink on transparency — alpha from how dark a pixel
// is (line cores → opaque, the light card → transparent), recoloured white so it
// glows on the dark atelier and can be tinted/inverted per mode in CSS. Then crop
// every frame to the UNION bounding box (so the walk cycle stays registered) and
// box-downscale (premultiplied, so soft edges stay clean).
//
// Run: node scripts/buddy-frames.mjs   (pngjs is already a devDependency)

import { readFileSync, writeFileSync, readdirSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import pkg from "pngjs";
const { PNG } = pkg;

const SRC = "mockup/assets/Brushbuddy";
const OUT = "public/buddy";
const CUTOFF = 236; // brightness >= this (the ~#F1F1F1 card) → transparent; darker → ink
const DOWNSCALE = 3; // 853x480 source → ~1/3 (plenty crisp at the buddy's ~60px)

mkdirSync(OUT, { recursive: true });
const files = readdirSync(SRC).filter((f) => /^frame_\d+.*\.png$/.test(f)).sort();

const frames = [];
let minX = 1e9, minY = 1e9, maxX = -1, maxY = -1;

for (const f of files) {
  const png = PNG.sync.read(readFileSync(join(SRC, f)));
  const { width: w, height: h, data } = png;
  for (let i = 0; i < w * h; i++) {
    const bright = (data[i * 4] + data[i * 4 + 1] + data[i * 4 + 2]) / 3;
    const a = bright >= CUTOFF ? 0 : Math.round(((CUTOFF - bright) / CUTOFF) * 255);
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

const pad = 8;
minX = Math.max(0, minX - pad); minY = Math.max(0, minY - pad);
maxX = Math.min(frames[0].width - 1, maxX + pad); maxY = Math.min(frames[0].height - 1, maxY + pad);
const cw = maxX - minX + 1, ch = maxY - minY + 1;
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
      out.data[dp + 3] = n ? Math.round(aSum / n) : 0;
      if (aSum > 0) { out.data[dp] = Math.round(rSum / aSum); out.data[dp + 1] = Math.round(gSum / aSum); out.data[dp + 2] = Math.round(bSum / aSum); }
    }
  }
  writeFileSync(join(OUT, `frame_${String(idx).padStart(2, "0")}.png`), PNG.sync.write(out));
});

console.log(`wrote ${files.length} frames: source crop ${cw}x${ch} → output ${ow}x${oh} in ${OUT}/`);
