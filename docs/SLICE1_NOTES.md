# Slice 1 — de-risking vertical slice (results)

Goal: empirically settle the make-or-break unknowns from
[ARCHITECTURE_EVALUATION.md](ARCHITECTURE_EVALUATION.md) before writing the full
build plan. Built as a Tauri 2.11 + windows-rs 0.61 app and run on the dev
machine (Windows 11 **build 26200**, two monitors: 3440×1440 @100% + 1920×1080
@100%).

## Verdict: GREEN — the core architecture works

| Unknown | Result |
|---|---|
| **R1 — WebView2 renders behind WorkerW** | ✅ Confirmed visually. A Tauri WebView2 window reparented under WorkerW paints behind the desktop icons. |
| **Multi-monitor** — one window per display | ✅ Two wallpaper windows attached at correct **physical** rects (3440×1440@(0,0) and 1920×1080@(-1920,217)). |
| **R2 — DPI placement** | ✅ Correct placement using physical-pixel coords (PerMonitorV2). ⚠️ Not stress-tested at fractional scale — both monitors are 100%. **Must test on a 150%/200% monitor before shipping.** |
| **R3/R5 — WorkerW spawn/search on Germanium-gen Windows** | ✅ Progman-child WorkerW found; 0x052C with wParam 0xD / lParam 0x1. |
| **Tray + minimize-to-tray** | ✅ |
| **Global hotkey (Ctrl+Alt+W) → summonable click-through overlay** | ✅ Draws a glowing stroke; Esc dismisses. |

## Hard-won Tauri/WebView2 gotchas (now encoded in the code)

1. **`WebviewWindow::hwnd()` returns Err for windows created at *runtime*** (via
   `WebviewWindowBuilder` during/after `RunEvent::Ready`) — but works for
   **config-declared** windows. → Wallpaper windows are a fixed pool
   (`wallpaper-0..3`) declared in `tauri.conf.json`.
2. **Differing `additionalBrowserArgs` between windows splits WebView2 into
   separate environments and breaks/defers native-window creation** (hwnd stays
   Err). → The *identical* args string is set on **every** window so they share
   one environment.
3. **A config window that is `visible:false` AND non-transparent is created
   lazily** (no HWND until shown). The wallpaper windows use `transparent:true`
   (content is opaque, so it looks the same) to force eager realization.
4. **Dev vs prod asset loading**: a plain `cargo build` runs in dev mode and
   loads `devUrl`. Our dev port collided with DivoraVoiceMod's (both 1420), so it
   showed DivoraVoiceMod's page. → Our dev port moved to **1430**; for prod-mode
   test runs build with `cargo build --features custom-protocol` (embeds `dist`).
5. **`GetParent` can't read our window's cross-process WorkerW parent** (returns
   null). → "Is it attached?" is tracked in Rust (`ATTACHED` flags), not via
   GetParent.

## Open follow-ups for the full build (NOT stack-changing)

1. **Explorer-restart recovery needs window *recreation*, not re-attach.** On
   build 26200, killing `explorer.exe` destroys the WorkerW and, with it, our
   child wallpaper windows (`IsWindow` → false afterwards). The watchdog detects
   this; recreating a config webview window at runtime is the unsolved piece
   (runtime windows hit gotcha #1). Options to evaluate: relaunch the webview
   into a persistent host; a small native (non-WebView) host window per monitor
   that owns the WorkerW child and embeds the WebView2; or the
   `meslzy/tauri-plugin-wallpaper` approach.
2. **Parent-stability / WndProc subclassing.** Prior art (tauri-plugin-wallpaper)
   subclasses the window proc to intercept `WM_WINDOWPOSCHANGING` and survive
   Win+D / "show desktop". We attach once and it stays put in normal use, but the
   robust version should subclass to re-assert z-order/parent on those events.
3. **Pause-on-fullscreen** (battery) — not in the slice; planned.
4. **DPI at fractional scale** — verify on a scaled monitor.

## How to run the slice

```
pnpm install
pnpm build
cd src-tauri && cargo build --features custom-protocol
./target/debug/lorraine-atelier.exe
```

Tray → **Quit** to stop. `Ctrl+Alt+W` toggles the casting overlay.
