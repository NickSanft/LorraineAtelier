# Lorraine Atelier

A *Witch Hat Atelier*–themed Windows **live wallpaper** — an animated, hand-inked atelier scene that lives behind your desktop icons, reacts to your music, and lets you **draw magic to cast it**. Built as a surprise **birthday gift** for Lorraine (the app is named for her).

> 🔒 **Private project — a surprise gift.** Please keep the repo private. The theme: in *Witch Hat Atelier*, magic is **drawn**, not spoken — so is everything here.

Status: **feature-complete, v1.0.0** (Phases 0–13 done). The personalized NSIS installer is the deliverable; re-cut it after any change with `pnpm tauri build`.

---

## What it does

**The living scene**
- A per-monitor animated wallpaper (wall art, drifting ink-motes, a magic-circle clock with the **real moon phase** inked in, an audio-reactive "seal" visualizer, a dock) behind the desktop icons — every widget individually **movable and resizable**.
- **Day / Night** palettes; **Quiet Hours** that ease the scene to a dim "embers" state at night (the clock stays legible); warm **floatglow lanterns** at dusk; a daily **Almanac** line drawn from *Witch Hat Atelier* in the top strip.
- Low idle GPU by design (a damage-driven loop that also pauses when the display sleeps or the session locks), with **motion**, **main-screen-only**, **glow-intensity**, and **brushbuddy** controls.

**Draw-to-cast magic**
- Summon a casting overlay (`Ctrl+Alt+W`, the tray, or the on-desktop ✦ glyph), **inscribe a sigil** (△ fire, ▽ water, ○ wind, □ earth, and a secret ✦ star) and **close the ring** — clockwise casts, counter-clockwise dismisses.
- A pure-Rust recognizer scores the seal (size / steadiness / symmetry); the pre-cast reading names the element's **actual bound app**, and a confident cast **launches or focuses** it (Steam / Discord / browser / Files by default, all rebindable). A rare cursed misfire blooms into canon **Petrification** (a crystal eruption + time-stop) — always harmless.
- After the seal fires, a brief **quality caption** reads its neatness back ("A clean seal." / "the lines wavered"), and each cast leaves a slow **ember** of the element's colour drifting up the scene.

**The brushbuddy**
- The canon *fudemushi* — a hand-drawn ink companion that roams across all monitors, can be **picked up and dragged** (it animates ~5× faster while held), and accepts a custom sprite.
- A companion **idle fudemushi** that settles onto the desktop once the fudemushi hatches (your first cast, through the **naming rite**) and sways gently in place — **movable, resizable, and independently toggleable** like any other widget.

**Audio visualizer**
- Generative by default; one tap of **Attune** switches to live **WASAPI loopback** so the seal breathes with whatever's playing — and **follows the default output** if you switch devices mid-song. Its **glow intensity** is configurable (Off → Vivid), doubling as a gentle brightness control.
- At the seal's heart the four elements slowly cycle as hand-inked, **canon-flavoured sigils** (fire / water / wind / earth) — original glyphs evoking *Witch Hat Atelier*'s bespoke marks, distinct from the alchemical △▽○□ you draw to cast.

**Easter eggs & the gift**
- A **Tower of Tomes** spellbook (per-element cast counts + a sealed forbidden page) that whispers **milestone lines** as her lifetime casts pass 10 / 50 / 100 / 365; a conjured **born-from-ink bird**; a weekend **Silver-Eve** festival of falling stars (a named fudemushi looks up to watch); a one-time first-run welcome; a colorblind palette; and an in-world **casting self-discovery** nudge.
- Once all four elements are inscribed, an occasional ink-mote drifts by as a tiny **✦ star** — the world's own breadcrumb toward the hidden fifth seal.
- **The dedication:** drawing the secret ✦ pentacle reveals a parchment storybook written *For Lorraine* — the dedication, then **pages of birthday wishes from her friends**, and a closing **credits** page; it also **auto-blooms on her birthday (July 25)**.

**Robustness (it must just work, unattended)**
- Survives explorer restarts, display/DPI changes, and **sleep / wake / lock / unlock** (re-attaches the wallpaper automatically).
- Crash-resilient worker threads + a local, telemetry-free `crash.log` breadcrumb.
- Tray shell, run-at-startup, per-user NSIS installer (no admin required).

---

## Stack

- **Rust + Tauri 2.11** with a thin [`windows`](https://crates.io/crates/windows) (windows-rs 0.61) Win32 layer — WorkerW attachment, per-monitor DPI, display/power/session recovery, a global mouse hook for desktop interactivity.
- **WebView2** surfaces driven by **vanilla TypeScript + Canvas 2D** (no framework; pure draw modules under `src/atelier/`).
- Audio: **WASAPI loopback** via the [`wasapi`](https://crates.io/crates/wasapi) crate + `realfft`.
- Packaging: **NSIS, per-user** (`installMode: currentUser`), unsigned, one-off (no auto-update).

## Architecture in one line

Three surfaces, one Rust core: per-monitor WebViews **under WorkerW** for the wallpaper + visualizer (which receive no input), a separate on-demand focusable **casting overlay** for draw-to-cast, and a **Rust control/tray process** that owns settings, the shared audio capture, the recognizer, app-launching, the brushbuddy, and the attach/re-attach watchdog. Desktop interactivity (clicking the dock, dragging the buddy) is handled by a low-level mouse hook that acts only when the desktop is the exposed surface.

---

## Build & run

Requires Windows 10/11 (x64), [Rust](https://rustup.rs/), [Node ≥ 20](https://nodejs.org/) + [pnpm](https://pnpm.io/), and the Tauri prerequisites (WebView2 runtime + MSVC build tools).

```sh
pnpm install

# Dev build of the wallpaper exe (embeds the frontend, no dev server):
pnpm build
cargo build --features custom-protocol --manifest-path src-tauri/Cargo.toml
./src-tauri/target/debug/lorraine-atelier.exe

# Tests
pnpm test            # unit + visual-regression (Skia canvas snapshots)
cargo test --features custom-protocol --manifest-path src-tauri/Cargo.toml

# Final installer  →  src-tauri/target/release/bundle/nsis/Lorraine Atelier_*_x64-setup.exe
pnpm tauri build
```

> ⚠️ **Gotcha:** the `custom-protocol` feature is what embeds the frontend (`dist/`) into the exe. A plain `cargo test` / `cargo build` (without it) produces a **dev-mode** binary that loads `http://localhost:1430`, so every window shows "localhost refused to connect." Always rebuild with `--features custom-protocol` before launching. The frontend is embedded at **compile time**, so after any `pnpm build` you must `cargo build` again to re-embed it.

## Personalizing the gift

The dedication, recipient name, birthday, and Silver-Eve date live in `Gift::default()` in [`src-tauri/src/settings.rs`](src-tauri/src/settings.rs); the friends' **birthday wishes** and the **credits** page live in [`src/atelier/dedication.ts`](src/atelier/dedication.ts); the daily **Almanac** lines live in [`src/atelier/almanac.ts`](src/atelier/almanac.ts) (verbatim *Witch Hat Atelier* quotes — salt in your own if you like). Edit them (so they ship in the binary), then re-cut the installer with `pnpm tauri build`. The recipient discovers the secret ✦ pentacle herself; setting a recipient name makes the storybook title itself *"For …"*.

## Layout

- `src/` — the frontend: `wallpaper.ts`, `overlay.ts` (casting), `control.ts` (tray panel), and the pure, unit-tested draw/audio/recognizer modules under `src/atelier/`.
- `src-tauri/src/` — the Rust core: `lib.rs` (orchestration), `workerw.rs` / `host.rs` (WorkerW attachment), `power.rs` (sleep/lock recovery), `casting.rs` / `recognizer.rs` / `launcher.rs`, `audio.rs`, `settings.rs`, `hook.rs`, `autostart.rs`.
- `tests/visual/` — Skia-canvas visual-regression baselines for the widgets.
- `scripts/` — recognizer golden-corpus oracle, the no-input lint gate, and the brushbuddy frame processor.
- `mockup/` — the original high-fidelity HTML/Canvas/Web-Audio design prototype + research briefs.
- `docs/` — the full [build plan](docs/BUILD_PLAN.md) and [architecture evaluation](docs/ARCHITECTURE_EVALUATION.md).
