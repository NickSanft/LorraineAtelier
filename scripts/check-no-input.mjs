// Build-time lint gate: the wallpaper window receives NO pointer input by hard
// platform constraint (it lives behind desktop icons under WorkerW on Windows),
// so any click/pointer/mouse handler is a bug. Node ESM only — no bash/grep, so
// it runs identically on Windows cmd/PowerShell and CI.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");

const filesToCheck = [
  path.join(projectRoot, "src", "wallpaper.ts"),
  path.join(projectRoot, "wallpaper.html"),
];

// Forbidden input-handler patterns. Deliberately scoped to click/pointer/mouse
// event names so legitimate APIs (resize, setInterval, requestAnimationFrame,
// canvas ops, onerror) are NOT false-positives.
const forbiddenPatterns = [
  /\bonclick\b/i,                                                       // onclick attribute
  /\bon(?:pointer)(?:down|up|move|enter|leave|cancel|over|out)\b/i,     // onpointer* attributes
  /\bon(?:mouse)(?:down|up|move|enter|leave|over|out)\b/i,              // onmouse* attributes
  /\bon:click\b/i,                                                      // framework on:click
  /addEventListener\s*\(\s*['"](?:click|pointer|mouse)/i,               // addEventListener("click|pointer|mouse...")
];

const violations = [];

for (const filePath of filesToCheck) {
  if (!fs.existsSync(filePath)) {
    console.warn(`WARN: file not found (skipping): ${filePath}`);
    continue;
  }
  const lines = fs.readFileSync(filePath, "utf-8").split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (forbiddenPatterns.some((p) => p.test(lines[i]))) {
      violations.push({ file: filePath, lineNum: i + 1, line: lines[i].trim() });
    }
  }
}

if (violations.length > 0) {
  console.error("\nLINT ERROR: wallpaper contains forbidden input handlers!\n");
  console.error("The wallpaper window receives NO pointer input by hard platform constraint.");
  console.error("(It lives behind desktop icons under WorkerW on Windows.)\n");
  for (const v of violations) {
    console.error(`${v.file}:${v.lineNum}`);
    console.error(`  ${v.line}\n`);
  }
  process.exit(1);
}

console.log("[ok] no input handlers found in wallpaper frontend.");
process.exit(0);
