import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vite";

// Multi-page app: a control window (index.html), the wallpaper surface
// (wallpaper.html, rendered behind the desktop icons), and the casting
// overlay (overlay.html, a summoned top-most window). Vanilla TS + Canvas2D,
// no framework — so no Vite framework plugins.
export default defineConfig({
  clearScreen: false,
  server: {
    // 1430 (not Tauri's usual 1420) to avoid colliding with DivoraVoiceMod's
    // dev server, which also runs on 1420 on this machine.
    port: 1430,
    strictPort: true,
    watch: { ignored: ["**/src-tauri/**"] },
  },
  build: {
    target: "esnext",
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL("./index.html", import.meta.url)),
        wallpaper: fileURLToPath(new URL("./wallpaper.html", import.meta.url)),
        overlay: fileURLToPath(new URL("./overlay.html", import.meta.url)),
      },
    },
  },
});
