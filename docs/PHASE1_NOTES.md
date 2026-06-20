# Phase 1 — Harden the wallpaper host (results)

Goal (from [BUILD_PLAN.md](BUILD_PLAN.md)): the wallpaper survives an `explorer.exe`
restart, Win+D / Show-Desktop, and stays correct — before any visual polish.

**Status: DONE and verified** on Win11 build 26200, dual monitor (3440×1440 + 1920×1080 @100%).

## What works

| Check | Result |
|---|---|
| **Explorer restart** (Task Manager → Restart, or `Stop-Process explorer`) | ✅ wallpaper comes back on both monitors (~1s) |
| **Rapid double Explorer restart** (the review-flagged race) | ✅ recovers, exactly one recreate per host death, converges |
| **Win+D / Show Desktop** | ✅ wallpaper stays correct (it lives in the WorkerW layer Show-Desktop reveals — no z-pin needed) |
| **System tray after Explorer restart** | ✅ Tauri's tray re-adds itself on `TaskbarCreated` (the transient `Error removing system tray icon` is harmless) |

## The key finding (corrects the plan's premise)

The plan assumed we could **re-home** the live WebView2 controller onto a fresh host
after an Explorer restart ("content preserved, no reload"). **That is impossible.**
When Explorer restarts it destroys WorkerW and, with it, our host child window. A
WebView2 controller whose host HWND is force-destroyed goes **permanently invalid** —
`ICoreWebView2Controller::SetParentWindow` then returns `ERROR_INVALID_STATE`
(`0x8007139F`). No window under WorkerW survives an Explorer restart (children die with
the parent), and the controller can't be revived.

So recovery **recreates** the webview instead of re-homing it. This is fine: the
wallpaper scene is **regenerable** (clock, seal, motes) and all real state (discovered
glyphs, ink, mode) lives in Rust — so a ~1s recreate is visually seamless, not data loss.

## The architecture (`src-tauri/src/host.rs` + `lib.rs`)

```
WorkerW (explorer-owned, dies on restart)
  └─ LorraineWallpaperHost  (our window class, WS_CHILD, one per monitor)
       └─ WebView2 controller  (moved in via with_webview → SetParentWindow + SetBounds + SetIsVisible)
```

- The wallpaper webview's **controller** is reparented into our native host window
  (not the Tauri window — Tauri never exposes a runtime window's `hwnd()`).
- Per-monitor state in Rust statics: `HOSTS[i]` (host HWND as isize), `ATTACHED[i]`
  (set from inside the async `with_webview` closure on success), `slot_labels[i]`
  (current webview window label), `RECREATE_GEN` (unique labels for recreated windows).
- A **watchdog** (600 ms) calls `ensure_attached` on the main thread.

**Recovery model (the review fix):** recovery is driven purely off the **host-handle
transition** — if `HOSTS[i]` is non-zero but no longer a live window, a host we created
has died, so its controller is invalid → `recreate_window` (close the dead webview, build
a fresh runtime one with a new label), then clear `HOSTS[i]` so the next pass cold-creates
a fresh host and homes the fresh controller. Driving this off the handle (rather than a
separate "ever attached" flag) is robust to rapid repeated restarts and has no
sync-clear/async-set race. (An adversarial 20-agent review caught that exact race in the
first cut; this model removes it.)

## Deferred to Phase 2 (display/DPI area — same code, grouped intentionally)

- **Fractional / mixed DPI** (150% / 200%) placement verification — both dev monitors are 100%.
- **Live display-resolution change** while running → resize hosts + controller bounds in place
  (must NOT destroy the host, which would invalidate the controller — resize via `SetWindowPos`
  + `controller.SetBounds`).
- **Monitor hotplug** (count change) handling.
- **Shell-hook** (`TaskbarCreated`/`WM_DISPLAYCHANGE` window) for *instant* recovery — the 600 ms
  watchdog is good enough for now; the shell-hook is a latency optimization.

## Run

```
pnpm install && pnpm build
cd src-tauri && cargo build --features custom-protocol
./target/debug/lorraine-atelier.exe
```
