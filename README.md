# Lorraine Atelier

A *Witch Hat Atelier*–themed Windows **live-wallpaper** desktop app — an animated wallpaper that lives behind your desktop icons, an audio visualizer, and a **draw-to-cast** spell system (inscribe a sigil, close the ring, launch an app).

> 🔒 Private project. Architecture, decisions, and risks are documented in
> [docs/ARCHITECTURE_EVALUATION.md](docs/ARCHITECTURE_EVALUATION.md).

## Stack (planned)

**Rust + Tauri 2.x + SolidJS**, with a thin [`windows`](https://crates.io/crates/windows) (windows-rs) Win32 layer for desktop-shell integration (WorkerW attachment, per-monitor DPI, display-change recovery).

## Architecture in one line

Three surfaces, one Rust core: per-monitor WebViews **under WorkerW** for the wallpaper + visualizer (no input), a separate summonable top-most **click-through overlay** for draw-to-cast, and a **Rust control/tray process** owning settings, the shared WASAPI audio capture, the recognizer, app-launching, and the attach/re-attach watchdog.

## Layout

- `mockup/` — high-fidelity HTML/Canvas/Web-Audio design prototype (`Atelier.dc.html`); the visual + behavioral spec.
- `docs/` — architecture evaluation and planning docs.
