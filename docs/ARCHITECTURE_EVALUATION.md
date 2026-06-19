# Lorraine Atelier — Architecture Evaluation

*Lead-architect review of the proposed approach, before the full build plan. Verdicts are grounded in your own two prior codebases (DivoraVoiceMod = Rust+Tauri+cpal+realfft; LiveWallpaperPrototype = JUCE/C++ WorkerW) and a deep-research + adversarial-verification pass (27 agents). Where the research and your own prototype disagree, it is called out rather than smoothed over.*

---

### 1. Executive recommendation

**Stack: Rust + Tauri 2.x + SolidJS, with a thin `windows`-crate (windows-rs) Win32 layer for everything that touches the desktop shell.** This is not a close call. You already ship exactly this stack in DivoraVoiceMod (Tauri 2, SolidJS 1.9, cpal 0.15, realfft 3, signed installer, tray, global-shortcut, first-run wizard, a glyph-cast easter egg). Every non-wallpaper hard requirement on Lorraine's list is something you have already shipped once on this machine. The visual+behavioral spec (`mockup/Atelier.dc.html`) is pure Canvas2D + Web Audio + requestAnimationFrame + pointer events — it drops into a Tauri WebView almost verbatim, which is the single biggest schedule lever you have.

**High-level architecture: a three-surface model, driven by one Rust core process.**

1. **Wallpaper layer** — one borderless WebView2 window *per monitor*, parented under the per-monitor WorkerW (behind desktop icons). Renders the ambient art, magic-circle clock, Silverwood glow, ink particles, and the FFT audio visualizer. **Receives no input** — a hard platform constraint, confirmed three ways (your JUCE prototype, Lively's source, Microsoft docs).
2. **Casting overlay layer** — a separate, summonable, top-level `WS_EX_TOPMOST | WS_EX_LAYERED` WebView window that is **click-through (`WS_EX_TRANSPARENT`) when idle** and toggles transparency *off* when summoned (global hotkey / tray / optional hot-corner) to capture the sigil+ring strokes. This is the *only* correct home for draw-to-cast. Your prototype already proved the pattern as "edit mode."
3. **Control/tray process** — owns the system tray, settings, the sigil→app mapping, run-at-startup, the single shared WASAPI audio capture, and the watchdog that re-spawns/re-attaches wallpaper windows on explorer restart / display change. Rust is the source of truth; the WebViews are pure view/interaction.

The recognizer, audio analysis, and process-launch all live in **Rust** (fast, headless-unit-testable), with the WebViews doing rendering and stroke capture only. That split lets you unit-test the load-bearing magic (recognition + classification) without a windowing harness — something your JUCE memory file notes you *couldn't* do for the DPI bug.

---

### 2. Framework decision

| Factor | Tauri 2 + SolidJS (WebView2) | Electron | JUCE / C++ (reuse prototype) | WPF / WinUI 3 (C#) |
|---|---|---|---|---|
| **Your proven expertise** | **Shipped (DivoraVoiceMod)** | None signalled | Shipped (LiveWallpaperPrototype) | None signalled |
| **Port cost of the Canvas/Web-Audio prototype** | **Near-zero** — Canvas2D/Web-Audio/rAF/pointer run as-is | Near-zero (same web stack) | **High** — rebuild all canvas layers in `juce::Graphics`, re-port recognizer to C++ | High — rebuild in Win2D/SkiaSharp |
| **Idle resource use (24/7 wallpaper)** | **Good** — small Rust core; WebView2 idles low if rAF is paused; one shared Edge runtime | Poor — bundles Chromium, heaviest RAM/idle | **Best** — native, lowest floor | Good (native) |
| **Installer / bundle size** | **Small** — `.msi`/NSIS via tauri-bundler; you already produce a signed one | Large (~150MB+ Chromium) | Small | Medium (WindowsAppSDK runtime) |
| **WASAPI loopback + FFT** | **Done** — cpal + realfft already in divora-core | node-native or addon | juce::dsp::FFT (done in prototype) | NAudio/CSCore |
| **WorkerW attachment feasibility** | Yes via windows-rs `SetParent` on the raw HWND (community plugins exist — see §2 caveat) | Yes (Lively/Electron precedent) | **Proven in your repo** | Yes |
| **Tray / global-hotkey / startup / DPI manifest** | **All shipped already** | Plugins exist | Shipped in prototype | Native |

**Verdict: Tauri 2 + SolidJS.** Reasoning, weighted:

- **Porting cost dominates the schedule.** The prototype is ~1,400 lines of Canvas2D/Web-Audio/pointer code and a self-contained `$1`-style recognizer (`mockup/Atelier.dc.html`, `classify()`/`analyzeRing()`). In a WebView that is *copy, wire, ship*. In JUCE or WPF it is a multi-week re-implementation of every visual layer plus the recognizer in a new language. Choosing native to save idle RAM would trade weeks of work for tens of MB — a bad trade for a gift with a deadline.
- **You've already paid the Tauri learning tax.** DivoraVoiceMod proves tray, global-shortcut, signed installer, first-run wizard, cpal capture, and a stroke-recognizer easter egg in this exact stack. Lorraine is "DivoraVoiceMod's plumbing + the wallpaper prototype's visuals."
- **JUCE is not wasted** — it is your reference implementation for the Win32 attachment. You port the *attachment sequence* (not the renderer) from C++ to windows-rs. That's ~1 file, the highest-value code you own.
- **Prior art in the exact stack exists:** `tauri-plugin-desktop-underlay` and `meslzy/tauri-plugin-wallpaper` (attach/detach/reset/pin, subclassing WndProc on `WM_WINDOWPOSCHANGING` to survive Win+D) — useful references even if you roll your own.

**The one real caveat — WebView2 behind WorkerW.** Reparenting a Tauri/WebView2 window under WorkerW is feasible (Lively does it with an embedded browser for HTML wallpapers), but two things need a smoke test in the vertical slice:
1. **WebView2 is a child-HWND host inside the Tauri window.** You `SetParent` the *outer* Tauri HWND under WorkerW; the WebView2 child rides along. Render genuinely borderless and verify on Win11 24H2 with icons hidden (the 24H2 top/right "edge-strip" bug interacts with borderless child rendering).
2. **WebView2 occlusion-detection can throttle/suspend rendering when it thinks it's hidden.** Behind icons it may believe it's occluded. If the visualizer freezes, disable occlusion via `additional_browser_args` (`--disable-features=CalculateNativeWinOcclusion`). **Slice-1 must-verify.**

If — and only if — that smoke test fails irrecoverably, the fallback is a **hybrid**: native Rust renderer (wgpu / Direct2D / `softbuffer`) for the *wallpaper layer only*, keeping the casting overlay as a WebView. Do not pre-optimize for that; prior art says the WebView path works.

---

### 3. Core architecture — the window/layer model

**The input-routing tension is the central design fact of this project. It is confirmed, not speculative:**

- Your own prototype: a WorkerW-parented window *cannot* receive desktop clicks — `SHELLDLL_DefView` absorbs them; in-window hit zones "essentially never fired."
- Lively's source confirms it and works around it with a separate raw-input-forwarding module (`RegisterRawInputDevices` + `PostMessage` to the wallpaper HWND).
- Microsoft docs confirm the desktop z-order; the `tauri-plugin-desktop-underlay` FAQ states attaching "disables all types of user interactions."

So "draw on the wallpaper to cast" **cannot literally be drawn on the wallpaper layer.** The lore gives you cover (below). Three layers:

**A) Wallpaper layer (one window per monitor, under WorkerW).**
- Renders everything ambient. No input. Pure rAF + Canvas.
- Primary monitor: clock, Silverwood, visualizer seal, brushbuddy, birthday glyphs. Secondary monitors: background + visualizer + vignette only (mirrors your prototype's "primary-only widgets" rule — avoids duplicate clocks).
- Receives state (mode, audio bands, ink level, cast events) from the Rust core over Tauri events/IPC.

**B) Casting overlay layer (top-level, summon on active monitor).**
- Normal top-level `WS_EX_TOPMOST | WS_EX_LAYERED` window. Idle = `WS_EX_TRANSPARENT` (fully click-through, invisible, near-zero cost). Summoned = transparency toggled off via `set_ignore_cursor_events(false)` (Tauri) / `SetWindowLongPtrW`, fade in the scrim + slate, capture strokes, run the two-phase sigil→ring flow, fire, fade out, re-arm click-through.
- This *is* the prototype's casting overlay (screen 2) — it ports verbatim; it just lives in its own window instead of a modal `<div>`.

**Recommended interaction model (decisive): summon-then-inscribe.** A global hotkey (default e.g. `Ctrl+Alt+Space`, themed "uncap the ink") — plus a tray "Inscribe" item, optionally a hot-corner — summons the overlay. The user draws sigil + ring on the summoned slate (exactly the prototype flow), the ring closes, the origami-unfold fires, the bound app launches, the overlay dismisses. This is honest to the constraint *and* lore-perfect: the witch's **long cloak hides the hands while drawing in secret** — i.e. the casting surface is deliberately summoned/concealed. Frame the hotkey as "drawing your hands beneath the cloak."

**Do NOT pursue raw-input forwarding to draw directly on the wallpaper for v1.** It's what Lively had to build, it's fiddly (`RegisterRawInputDevices` + `RIDEV_INPUTSINK` + reconstructing/`PostMessage`-ing coordinates), and it gains nothing the summoned overlay doesn't. Keep it as a *stretch* easter-egg only (§6, "ink-on-the-desktop").

**C) Control/tray process (the Rust core).**
- Owns: tray + menu, settings persistence (`discovered`, `secretFound`, ink, mappings, day/night), run-at-startup, the **single** WASAPI loopback capture (shared to all wallpaper windows — never N captures), the recognizer, process launching, and the **watchdog**.
- The watchdog is top-level so it *can* receive `RegisterWindowMessageW("TaskbarCreated")` (explorer restart) and `WM_DISPLAYCHANGE`/`WM_DPICHANGED`; on any of these it re-spawns WorkerW and re-attaches all wallpaper windows (full teardown+rebuild), backed by a low-rate (1–10 Hz) display-snapshot diff as belt-and-suspenders.

---

### 4. Handling the hard requirements

**Multi-monitor — one window per display.** Confirmed best practice (your prototype + Lively per-screen + research). Build a `Vec<WallpaperWindow>` from the enumerated monitors. Shared singleton services (audio, stats, settings) in the core; per-window owns only its canvas. Span/duplicate modes are a later toggle, not v1.

**Per-monitor DPI / UI-scaling — the highest-risk *known* bug, already solved by you.** Declare **PerMonitorV2** in the manifest (WM_DPICHANGED is delivered only to PerMonitorV2 processes). Then port the fix from your own memory file (`juce-windows-dpi-when-parenting-to-workerw.md`) verbatim: WorkerW/Progman are physical-pixel parents, so after `SetParent` you must **multiply the logical monitor rect by the per-monitor scale before `SetWindowPos`**, and subtract the physical parent origin (`ClientToScreen`) *after* the multiply. Use a per-monitor scale lookup (`GetDpiForMonitor`/`GetDpiForWindow(parent)/96`), never one global scale (200% laptop + 100% external is the standard mixed case). Guard `scale < 0.1 → 1.0`. **Symptom if wrong: window covers 1/scale² of the screen, top-left** — invisible on a 1080p@100% test box, so test on a 4K@200% monitor explicitly.

**Live resolution / hotplug / DPI change — re-attach, don't patch.** Treat `WM_DISPLAYCHANGE`, `WM_DPICHANGED`, and `TaskbarCreated` as triggers for a **full teardown+rebuild** of the per-monitor windows (re-runs `SetParent`). Explorer often destroys/recreates WorkerW on topology change, orphaning children, so message-handling alone is insufficient — keep the polling snapshot-diff watchdog. Cache scaled bitmaps; re-rasterize only on resize/display-change, never per frame.

**Minimize-to-tray (default).** Already shipped in DivoraVoiceMod (`tauri` `tray-icon` feature). The "window" here is the settings window; closing it minimizes the *control UI* to tray while the wallpaper keeps rendering. Tray menu: Day/Night, Pause/Resume, Inscribe, Settings, Quit.

**Run-at-startup.** Use `tauri-plugin-autostart` (writes `HKCU\...\CurrentVersion\Run` via the `auto-launch` crate; no Task Scheduler, no admin) with a settings toggle. Start minimized to tray.

**Installer.** Reuse the DivoraVoiceMod `tauri.bundle` + signing flow. **Note (verified):** Tauri's **NSIS** bundler supports a true *per-user* install (`installMode: "currentUser"`, no admin/UAC); Tauri's **WiX/MSI cannot be configured for per-user** scope (perMachine only — open issue). For a per-user wallpaper/tray app, **NSIS is the better default**, which revises the earlier MSI lean (see §8 / decision 4).

**Pause/throttle policy (a requirement the spec under-specifies).** Your JUCE prototype did *not* build occlusion/fullscreen pause; for a 24/7 laptop wallpaper this matters. Mirror Wallpaper Engine: detect foreground fullscreen by **pixel-perfect window-rect-vs-monitor-rect comparison** (`GetForegroundWindow` + rect compare — catches *borderless* fullscreen games that style-bit checks miss), pause that monitor's rAF, **fully release the WASAPI capture when paused**, and keep the "skip repaint when audio essentially silent" trick (`maxDelta > 0.005`). Default on, with a "keep running" override.

---

### 5. The audio visualizer

**Ship both, gated behind one toggle; default to generative, make WASAPI the headline "Attune to your music" feature for the recipient.**

- **Generative (ship-now):** the prototype's 4-detuned-oscillator ambient pad → lowpass (LFO cutoff) → AnalyserNode (`fftSize 128`) → bands `bass[0,4) mid[4,16) high[16,40)`. Runs entirely in the WebView, needs no Rust, guarantees the seal "breathes" on a silent machine. Zero-risk baseline / demo-on-any-machine path.
- **Real WASAPI loopback (the recipient's wheelhouse):** you already have **cpal 0.15 + realfft 3** in divora-core and a proven WASAPI capture path. Capture loopback in Rust, FFT in Rust (Hann window, ~1024 samples — your JUCE order-10), log-bin to the same bands, attack/release smooth, push the band array to the WebViews.

**IPC / data-flow (the decision that matters here):** the visualizer wants ~60 fps band updates across N windows. Do **not** round-trip per-frame band data through Tauri's JSON IPC for every frame. Two good options:
1. **Tauri event emit at a capped rate (~30–60 Hz) of a tiny payload** (3–8 floats). Small enough that JSON is fine; start here.
2. If profiling shows IPC overhead, **shared memory / lock-free ring buffer** read via a small typed array, or downsample to 30 Hz. (Mirrors your DivoraVoiceMod "no large buffers through IPC" instinct: keep audio *samples* in Rust, send only derived *bands*.)

Keep FFT + smoothing in Rust so generative and real paths emit an identical band-array shape — the WebView renderer is then source-agnostic and you flip sources with one setting. If WASAPI init fails, fall back to generative silently and log it; the wallpaper never breaks because audio broke.

---

### 6. Feature & easter-egg suggestions

**Keep the entire spec catalog** (brushbuddy, reversed-sign jut, ~13% cursed-ink misfire, secret-glyph storybook, Tower of Tomes, Tartah colorblind mode, seasonal/birthday glyphs, mono-shirazu first-run, forbidden-magic refusal, the personal hidden birthday message). They're already designed and largely implemented in the prototype — porting is mostly wiring. New, lore-consistent, recipient-tuned ideas (audio/visualizer person + birthday gift):

1. **"Resonance sigil" — cast *with sound*.** A secret seal that, instead of launching an app, *binds the visualizer to the current spectrum* and blooms the seal in time with onsets — a beat-reactive origami-unfold. Lets them literally "cast their music onto the desktop." Best recipient-specific egg.
2. **Woodcruor meter from real loudness.** Tie the ink reservoir's refill rate (currently a timer) to ambient audio energy — the Silverwood "bleeds ink faster when the room is loud." Diegetic; shows off the audio pipeline.
3. **"Tune the seal" hidden mixer.** A forbidden Tower-of-Tomes page revealing a tiny EQ/visualizer console (band gains, attack/release, palette) — themed as "mixing magical dyes into the ink" (dyes are canon).
4. **Silver Eve onset on their birthday.** Make the *Silverwood bloom* trigger automatically on the recipient's birthday date with the personal hidden message auto-surfacing once — so the gift "knows" the day even if they never find the secret glyph (belt-and-suspenders for the emotional payload).
5. **"Pen pressure as line weight."** If their tablet/pen reports pressure (pointer events expose `pressure`), thicken the ink with pressure and *raise the neatness ceiling* — rewards the careful drawer ("neater seals are stabler").
6. **A "memory erasure" function done right.** Map the lore's one allowed body-magic (memory erasure) to "clear recent/history" — wire it to clear the app's own discovered/recent-cast log, with a Qifrey-style aside. Canon-perfect.
7. **Stretch only: "ink on the desktop."** A rare mode where dragging on empty desktop space leaves a fading ink trail on the wallpaper layer (via raw-input forwarding). Explicitly v2 — do not let it block v1.

**One caution:** the **Sylph-Shoes "lift the desktop icons"** egg requires manipulating the icon `SysListView32`, finicky across builds. Keep it as a *wallpaper-layer fake* (lift painted icon-like motes on your canvas) — same delight, none of the fragility.

---

### 7. Risk register

| # | Risk | Severity | Mitigation |
|---|---|---|---|
| R1 | **WebView2-behind-WorkerW doesn't render / freezes (occlusion) / 24H2 edge-strip bug** | High | Slice-1 smoke test; disable WebView2 occlusion (`additional_browser_args` `--disable-features=CalculateNativeWinOcclusion`); render fully borderless; test on Win11 24H2 with icons hidden. Fallback: native Rust renderer for wallpaper layer only. |
| R2 | **DPI 1/scale² sizing bug after SetParent** | High (but *known*) | Port your `juce-windows-dpi-...` fix verbatim; PerMonitorV2 manifest; per-monitor scale multiply before `SetWindowPos`; test on 4K@200%. |
| R3 | **Windows 11 24H2 ("Germanium") WorkerW fragility** | High | Make 24H2 a first-class test target; WorkerW-search by "no SHELLDLL_DefView child" + Progman fallback; retry/delay on boot (WorkerW spawns late on 24H2); KB5050009/KB5050094-level build restored behavior. |
| R4 | **explorer.exe restart / display change orphans wallpaper** | Medium | `TaskbarCreated` + `WM_DISPLAYCHANGE`/`WM_DPICHANGED` handlers in the top-level control process → full teardown+rebuild; polling watchdog as backstop. |
| R5 | **0x052C spawn params uncertainty** | Medium | Research *refuted* "0xD is the reliable form"; most working code uses `0/0` single-send, but your prototype found `0xD/0x1` worked on your box. **Try `0/0` first, fall back to `0xD`** — and rely on the WorkerW **search + Progman fallback**, never on the spawn's return value. |
| R6 | **Per-frame audio IPC overhead at 60fps × N monitors** | Medium | Cap band-emit to 30–60 Hz, tiny payload (≤8 floats); keep samples in Rust; shared-memory ring buffer only if profiling demands. |
| R7 | **WASAPI loopback init failure / device changes** | Low | Proven graceful fallback to generative; handle default-device-change events; release capture on pause. |
| R8 | **Recognizer accuracy in the wild** (tuned to mouse on a 520px slate) | Medium | Port `classify()`/`analyzeRing()` to Rust *with* the JS as a golden-reference test corpus; add a calibration/practice screen; the neatness score already gates feedback so misfires read as "sloppy seal," not "bug." |

**What to prototype first — the de-risking vertical slice (build this before the full plan):**

> **Slice 1 ("the seal lights up"):** one monitor only. (a) Spawn/find WorkerW, attach one borderless Tauri+WebView2 window behind the icons, render the prototype's wallpaper + clock + *generative* visualizer at correct DPI on a high-DPI monitor. (b) A separate top-most click-through overlay summoned by a global hotkey that captures one stroke and shows it. (c) Tray icon with Quit. (d) Survive an `explorer.exe` restart (Task Manager → restart Explorer) and re-attach.

That slice exercises every load-bearing unknown — WebView2-behind-WorkerW (R1), DPI (R2), WorkerW search/spawn (R3, R5), explorer recovery (R4), and the overlay-input split (the whole §3 thesis) — while being a fraction of the full build. **Do not write the full build plan until slice 1's R1 (WebView2 behind WorkerW) is empirically confirmed**, because the one scenario that would force a stack change (native wallpaper renderer) is decided entirely there.

---

### 8. Open decisions (decide before the full plan)

1. **Casting-overlay summon model** — hotkey only / hot-corner only / **both + tray "Inscribe"** *(recommended)*.
2. **Default visualizer source on first run** — generative / WASAPI / **generative by default + a one-tap "Attune to your music" switch** *(recommended)*.
3. **Audio capture scope** — system loopback only / selectable device / **loopback only for v1, selector deferred** *(recommended)*.
4. **Installer format & signing** — NSIS (per-user, reuse Tauri config) / WiX-MSI / signed-with-existing-cert. **Revised recommendation: NSIS per-user** (Tauri MSI can't do per-user). Signing note below.
5. **Default pause/throttle aggressiveness** — never / **pause+release-audio on foreground fullscreen, per-monitor, with override** *(recommended)* / pause only true-fullscreen.
6. **v1 easter-egg scope** — full catalog + new audio eggs / **full catalog + Resonance-sigil + birthday-bloom, defer raw-input "ink on desktop"** *(recommended)*.

**Signing reality (verified, 2026):** EV certs **no longer** grant instant SmartScreen reputation, and a **self-signed cert behaves the same as no signature** for SmartScreen. For a private one-off gift the recipient launches once, "More info → Run anyway" is a non-issue; signing with your existing cert is a nicety, not a requirement, and buying anything new is unjustified.

**Auto-update (verified):** Tauri's updater **can't natively authenticate private GitHub release assets** (the `latest.json` URLs can't carry a token; a token-holding proxy/update server is the de-facto workaround). For a gift, **skip auto-update** and ship a one-off installer (or a manual "check for updates" later).

---

### Appendix — verification confidence

The deep-research claims were adversarially fact-checked. Notable verdicts:

- **confirmed:** DivoraVoiceMod already uses the exact Tauri primitives Lorraine needs; Tauri overlay click-through via `set_ignore_cursor_events` + `tauri-plugin-global-shortcut`; NSIS supports per-user / Tauri MSI does not; `tauri-plugin-autostart` writes HKCU Run; EV no longer bypasses SmartScreen; self-signed == unsigned for SmartScreen; Tauri updater can't auth private release assets.
- **refuted:** "wParam=0xD is the *reliable* spawn form" — most working code uses `0/0`; treat spawn params as best-effort and rely on the WorkerW search (R5).
- **partial (true but nuanced):** the WorkerW/Progman technique still works in 2025-26 but is more fragile on Win11 24H2; the no-input constraint on WorkerW-parented windows; one-window-per-monitor; WebView can't capture system audio (native must push bands).
