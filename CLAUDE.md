# CLAUDE.md — working guide for Lorraine Atelier

Guidance for AI assistants (and humans) working in this repo. Keep it lean; deep detail lives in `docs/` and `README.md`.

## What this is

A Windows **live-wallpaper** desktop app themed on *Witch Hat Atelier* (magic is **drawn**, not spoken). It is a **surprise birthday gift** for Lorraine — so the repo is **private** and stays that way. It auto-blooms a dedication on her birthday (**July 25**). Feature-complete at **v1.0.0**. The deliverable is the personalized NSIS installer. See `README.md` for the full feature tour.

## Stack & layout

- **Backend:** Rust + Tauri 2.x + a thin `windows-rs` Win32 layer — `src-tauri/src/*.rs` (`lib.rs` is the core; `hook.rs`, `workerw.rs`, `host.rs`, `audio.rs`, `recognizer.rs`, `casting.rs`, `power.rs`, `settings.rs`, `autostart.rs`, `launcher.rs`).
- **Frontend:** **vanilla TypeScript + Canvas2D** (no framework — despite older notes mentioning SolidJS). Entry points: `wallpaper.html`/`src/wallpaper.ts` (the scene), `overlay.html`/`src/overlay.ts` (casting/storybook modal), `index.html`/`src/control.ts` (control panel). Shared pure modules in `src/atelier/*`. Built with Vite + `tsc`.
- **Package manager:** `pnpm`. **Tests:** Vitest (frontend) + `cargo test` (Rust, incl. recognizer parity).
- **Settings:** Rust is the sole writer, at `%APPDATA%\com.divora.lorraineatelier\settings.json`.

## Build & run — read before you build

- **The frontend is embedded into the Rust binary at compile time** (the `custom-protocol` Cargo feature). After **any** frontend change you must rebuild the Rust exe (`pnpm tauri build`, or `cargo build --features custom-protocol`). `pnpm build` alone does **not** update the running app.
- **`cargo test` — or any `cargo build` *without* `--features custom-protocol` — clobbers the debug exe into a dev-mode binary** that loads from `http://localhost:1430`. With no Vite dev server running, every window then shows "localhost refused to connect". Fix: rebuild with the feature (or run `cargo test --features custom-protocol`). This is the #1 "it broke" red herring.
- **The running app locks its exe** → `cargo build`/`tauri build` fail with "Access is denied". Stop it first: `Get-Process lorraine-atelier | Stop-Process -Force`.
- Type-checking Rust after an edit: `cargo check --manifest-path src-tauri/Cargo.toml` (fast, doesn't clobber the custom-protocol build).

## Architecture — three surfaces, one Rust core

1. **Wallpaper** — per-monitor borderless WebView windows reparented under **WorkerW** (behind desktop icons). **No input is possible here** — enforced by construction (the `scripts/check-no-input.mjs` lint gate runs in `pnpm build`).
2. **Overlay** — an on-demand, top-most modal window; the **only** focusable surface. Used for casting and the storybook. Hidden at rest.
3. **Rust core** — tray, settings, one shared WASAPI capture, the recognizer, app launch, and a ~600 ms watchdog that re-attaches the wallpaper on explorer restart / display change.

On-desktop interactivity (clickable dock, draggable brushbuddy) is done with a **global `WH_MOUSE_LL` mouse hook** (`hook.rs`) that acts only when the desktop is the exposed surface under the cursor — never a visible/focusable window. Deep design + history: `docs/ARCHITECTURE_EVALUATION.md`, `docs/BUILD_PLAN.md`, `docs/PHASE*_NOTES.md`, `docs/SLICE1_NOTES.md`.

## Hard constraints — things that bite

- **Don't casually edit the recognizer.** `recognizer.rs` is a parity-tested port; it's asserted equal to `scripts/recognizer-oracle.mjs` against a golden corpus. If you change it, regenerate the corpus (`pnpm dump-corpus`) and re-run `cargo test`. For *enhancements*, **don't touch the recognizer or the daily casting loop at all** (high fragility — see `docs/GIFT_BACKLOG.md`).
- **Per-window Tauri events:** a frontend `listen(event, handler)` with no target registers as `Any` and **bypasses `emit_to(label)` filtering** (every window receives every emit). Pattern for per-window events: Rust `emit_to(label)` **and** stamp the `label` into the payload; frontend registers `listen(event, handler, { target: selfLabel })` **and** drops any payload whose `label !== selfLabel`.
- **Never keep an always-shown top-level WebView2 window.** It steals and holds the foreground (WebView2 calls `SetFocus` on load; `WS_EX_NOACTIVATE` doesn't stop programmatic `SetForegroundWindow`). The overlay must stay hidden-at-rest and appear only as a modal.
- **Windows Defender:** the unsigned build trips a `Trojan:Win32/Bearfoos.B!ml` **ML false positive** (not a real infection). Clearance is **per-SHA-256** — submit the **exact final binary** to WDSI a few days before gifting and **don't rebuild after**. Full playbook: `docs/DEFENDER_FALSE_POSITIVE.md`.
- **The recipient is flash-sensitive.** Treat photosensitivity safeguards as requirements, not nice-to-haves: the ≤3 Hz glow/effect clamps, gradual glow easing, and the dark WebView2 `DefaultBackgroundColor` that hides the recreate/resume/display-change flashes. Don't introduce rapid brightness flicker.

## Conventions

- The owner commits **directly to `main`** per-phase (their stated preference). Confirm before pushing anything outward; the repo must stay private.
- **PowerShell mangles `git commit -m`** messages that contain embedded double-quotes or a bare `/`. Use single-quoted plain-ASCII messages, or pipe a heredoc to `git commit -F -` via the Bash tool.
- Put throwaway files in the scratchpad, not the repo.

## Where to look

| Need | File |
|------|------|
| Feature overview | `README.md` |
| Non-obvious gotchas + the 2026-06 memory-leak audit | `docs/DEV_NOTES.md` |
| Full phase-by-phase plan, research, decisions | `docs/BUILD_PLAN.md` |
| Stack/architecture rationale | `docs/ARCHITECTURE_EVALUATION.md` |
| Defender false-positive playbook | `docs/DEFENDER_FALSE_POSITIVE.md` |
| Post-v1 enhancement ideas + what to skip | `docs/GIFT_BACKLOG.md` |
