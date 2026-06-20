# Phase 2 — Fractional DPI + live display-change (results)

Goal (from [BUILD_PLAN.md](BUILD_PLAN.md)): verify the wallpaper places correctly at
fractional/mixed DPI (both dev monitors are 100%), and handle live resolution/scale
changes while running.

**Status: DONE and verified** on Win11 build 26200, dual monitor.

## What was verified

A client-size assertion logs `GetClientRect(host)` vs the monitor rect after every attach.
Across an extensive live test (scale + resolution changed repeatedly on both monitors), **every
rebuild reported `client=WxH OK`** — the host always exactly fills the monitor:

| Change | Values exercised | Result |
|---|---|---|
| **Fractional DPI** | 96 → 144 (150%) → 168 (175%), both monitors | ✅ fills + crisp |
| **Resolution** | 3440×1440 ↔ 2560×1440; 1920×1080 ↔ 1680×1050 | ✅ fills correctly |

This confirms the **no-multiply physical-pixel placement** is correct for a PerMonitorV2
process: `GetMonitorInfoW`'s `rcMonitor` is physical pixels, the host is placed at
`mon.{x,y}` (minus the WorkerW client origin) with size `mon.{w,h}` verbatim — no scale
multiply (which is what the JUCE port needed, because it received *logical* DIPs). WebView2,
hosted in the per-monitor host, picks up the monitor's rasterization scale on (re)creation, so
the canvas renders crisp at fractional DPI with no special handling — the `devicePixelRatio`
path in `wallpaper.ts` is sufficient (no Rust-supplied-physical-size override needed).

## Live display-change handling (`ensure_attached`)

Each slot records the `(x, y, w, h, dpi)` it was last placed for (`slot_rects`). On the
watchdog tick:
- **geometry/DPI changed** (live tuple ≠ stored) → rebuild that slot (recreate the webview +
  fresh host at the new rect). Reuses the explorer-restart recovery path; a fresh webview
  cleanly picks up the new resolution and rasterization scale. (A ~1s reload on a rare,
  deliberate action — acceptable; the scene is regenerable.)
- **monitor unplugged** (count decreased) → destroy that slot's host.
- **monitor added** (count increased) → the normal cold-create path attaches it.

No window accumulation: each rebuild closes the previous webview before creating the next.

## Deferred / not needed

- **In-place resize** (move host + `controller.SetBounds` without a reload) — a possible future
  optimization to avoid the reload flash on resolution change. The recreate path is simpler and
  proven; revisit only if the reload proves annoying in practice.
- **Shell-hook for instant display-change reaction** — the 600 ms watchdog is sufficient.
- The placeholder `wallpaper.webp` (1200×675) looks soft/"stretched" upscaled on the 3440-wide
  ultrawide — that's the asset, fixed in **Phase 4** (real art + per-monitor renditions, risk R‑ASSET).
