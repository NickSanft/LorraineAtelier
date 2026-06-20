# Phase 3 — Pause/throttle on fullscreen (results)

Goal (from [BUILD_PLAN.md](BUILD_PLAN.md)): pause a monitor's wallpaper (and, later,
release audio) when a fullscreen app covers it, to save GPU/CPU/battery.

**Status: DONE** on Win11 build 26200, dual monitor — shipped as an **opt-in** option.

## Behavior

- **Detection is coverage-based, per monitor:** `workerw::monitor_covered(mon)` checks the
  window at the monitor's *centre* (`WindowFromPoint` → `GetAncestor(GA_ROOT)`); if it's a
  non-shell, non-ours top-level window whose rect fully covers the monitor, that monitor is
  considered covered. This:
  - pauses **regardless of focus** (a fullscreen window keeps the monitor paused even when you
    switch to another window/monitor) — **no flapping** (the earlier foreground-based attempt
    flapped as focus changed),
  - is **per monitor** (a fullscreen video on monitor 2 pauses only monitor 2 while you work on
    monitor 1),
  - correctly **ignores maximized windows** (the taskbar stays visible, so they don't fully cover).
- **Pause is native:** `controller.SetIsVisible(false)` stops WebView2 compositing and throttles
  the page's rAF — no JS or capability changes. Resume is `SetIsVisible(true)`.

## Default: OFF (opt-in)

Resuming re-composites the WebView2 from hidden, which causes a **brief flash**. That trade —
a visible blip every time you close a fullscreen window — isn't worth the small idle saving of a
*hidden* wallpaper, so the feature is **off by default**: out of the box the wallpaper just keeps
rendering and there's no flash. It's exposed as a power-saving toggle (e.g. for laptops on battery):

- Rust: `PAUSE_ON_FULLSCREEN` atomic (default false); `update_pause` short-circuits when off (no
  per-tick probing).
- Command: `set_pause_on_fullscreen(enabled: bool)` — to be wired to a Settings toggle in **Phase 7**.

## Deferred

- **Audio release on pause** — there's no audio yet; releasing the shared WASAPI capture when all
  monitors are paused hooks into `update_pause` in **Phase 6**.
## Flash polish (done)

The brief white flash when a webview re-composites — on resume from pause, and on the recreate
paths (explorer restart, display change) — is now **dark/near-invisible**: the host window's class
background brush is set to the wallpaper colour `#0b0914`, and each WebView2 controller's
`DefaultBackgroundColor` is set to the same (`ICoreWebView2Controller2::SetDefaultBackgroundColor`).
Verified: recovery flash is now dark instead of white.
