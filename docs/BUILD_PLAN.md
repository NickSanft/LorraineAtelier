# Lorraine Atelier — Build Plan

> A Windows desktop **live wallpaper** themed on *Witch Hat Atelier* (magic is **drawn**, not spoken), built as a surprise birthday gift. Stack: **Rust + Tauri 2.11 + SolidJS + a thin `windows-rs` 0.61 Win32 layer**, three WebView surfaces over one Rust core. The visual/behavioral spec is `mockup/Atelier.dc.html` (Canvas-2D + Web-Audio + pointer-drawing prototype) and ports into a WebView almost verbatim.

**Phase 0 is DONE.** The de-risking vertical slice (Slice 1) is built and **proven GREEN** on Win11 build 26200, dual monitor (3440×1440@100% + 1920×1080@100%): a Tauri WebView2 window reparented under WorkerW renders behind the desktop icons, one window per monitor at correct physical rects, WorkerW search/spawn, tray, `Ctrl+Alt+W` hotkey, and a summonable click-through overlay all work. The make-or-break unknown that could have forced a stack change (native wallpaper renderer) is settled. See [`docs/SLICE1_NOTES.md`](SLICE1_NOTES.md) for the proven results + the encoded Tauri/WebView2 gotchas, and [`docs/ARCHITECTURE_EVALUATION.md`](ARCHITECTURE_EVALUATION.md) for the full architecture rationale and locked v1 decisions. **This plan starts from that proven base** and sequences the remaining work so the single highest unknown left — recovering the wallpaper after an `explorer.exe` restart — is tackled first, and so there is always a runnable app.

---

## 1. Final Architecture

### Three surfaces, one Rust core, one WebView2 environment

One OS process (the `lorraine-atelier` binary, `windows_subsystem="windows"` in release). **Exactly one WebView2 environment** — every window keeps the *identical* `additionalBrowserArgs` already in `tauri.conf.json` (`--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection,CalculateNativeWinOcclusion`). Slice 1 proved that diverging these per-window splits the environment and breaks native-window creation. Rust is the source of truth; the WebViews are pure view + stroke capture.

| Surface | Window label(s) | Role | Input? |
|---|---|---|---|
| **Wallpaper** | `wallpaper-0..3` (fixed config pool, `transparent:true` for eager HWND) | Ambient art + magic-circle clock + Silverwood glow + ink particles + FFT visualizer, behind desktop icons under WorkerW | **None** (hard platform constraint) |
| **Casting overlay** | `overlay` (top-most, transparent, `focus:false`, `visible:false`) | The *only* draw-to-cast surface; click-through when idle, summoned by hotkey/hot-corner/tray | Yes (when summoned) |
| **Control / tray** | `main` (close → hide to tray) | Settings, sigil→app mapping, spellbook, run-at-startup; owns the single WASAPI capture, recognizer, launcher, watchdog | Yes |

Window labels are **all config-declared, never runtime-created** — this dodges the Slice-1 gotcha that `WebviewWindow::hwnd()` returns `Err` for runtime windows. The pool cap of 4 monitors is the documented v1 limit.

### `src-tauri/src/` module map (final)

```
main.rs               // shim → lorraine_atelier_lib::run()
lib.rs                // composition root: Builder, plugins, setup(), RunEvent loop, watchdog wiring
state.rs              // AppState (Arc<Mutex<…>>) + persisted Settings (serde)
ipc.rs                // #[tauri::command] surface + typed event-name consts
tray.rs               // setup_tray (moved out of lib.rs)
store.rs              // tauri-plugin-store persistence: schema, migrate, seed from gift.default.json
casting.rs            // cast orchestration: classify_sigil / analyze_ring / fire_spell / clear_log
recognizer.rs        // PURE port of classify/analyze_ring/tri_orient (+helpers); no Tauri, no windows; unit-tested
launcher.rs           // LaunchTarget enum → tauri-plugin-shell / std::process; reversed-ring dismiss
eggs.rs               // date/seasonal/birthday gating; first-run; forbidden-magic refusal
audio/mod.rs          // AudioService handle
audio/engine.rs       // "lorraine-audio" thread: wasapi loopback + mpsc command loop
audio/analyzer.rs     // realfft 1024 + Hann + log-bin to prototype band edges + attack/release + flux/beat
audio/state.rs        // Arc<AudioState> atomics (bands, loudness, capturing, source)
windows/mod.rs        // re-exports; cfg(windows) gate
windows/workerw.rs    // EXISTING: WorkerW find/spawn, attach, enum_monitors, dpi, +cover_active_monitor, +window-match dismiss helper
windows/host.rs       // NEW: WallpaperHost — persistent per-monitor native host + reattach state machine
windows/subclass.rs   // NEW: WndProc subclass on the host (WM_WINDOWPOSCHANGING z-pin, WM_DPICHANGED, WM_DESTROY)
windows/shellhook.rs  // NEW: hidden message-only HWND: TaskbarCreated / WM_DISPLAYCHANGE / WM_DPICHANGED
windows/fullscreen.rs // NEW: per-monitor foreground-fullscreen detection (rect compare)
```

`src/` frontend (existing multi-page Vite scaffold, dev port 1430): `index.html`→`control.ts` (`main`), `wallpaper.html`→`wallpaper.ts` (`wallpaper-N`), `overlay.html`→`overlay.ts` (`overlay`). Each grows into a small Solid app. New shared, DOM-free, Tauri-free module tree `src/atelier/*` (palette, spells, audio/generative, draw/*, recognize/* TS oracle) is lifted out of the prototype and imported by all three pages — unit-tested under Vitest.

### The load-bearing decision: persistent per-monitor native host window

An `explorer.exe` restart destroys WorkerW **and our WS_CHILD wallpaper windows with it** (`IsWindow=false` after). Runtime-recreating a config webview hits the `hwnd()`-`Err` gotcha. **Decision: a persistent, cheap, OUR-class native host window per monitor owns the WorkerW child and embeds the Tauri/WebView2 window as its own child.** Two-level parenting:

```
WorkerW (explorer-owned, volatile)
  └─ LorraineWallpaperHost  (OUR class, WS_CHILD, one per monitor)  ← recreated cheaply on TaskbarCreated
       └─ Tauri "wallpaper-i" HWND (WS_CHILD of the host)           ← config-declared, NEVER destroyed
            └─ WebView2 Chrome_WidgetWin child (rides along)
```

The Tauri wallpaper HWND is constant for the life of the process (so `hwnd()` always works), and recovery becomes a `SetParent` re-stitch, never a window recreation — so **WebView2 content/state survives an explorer restart** (at most a one-frame flicker, not a reload). This is the single biggest correctness win over Slice 1, which would have shown a dead/blank wallpaper after restart-Explorer. Rejected alternatives: runtime webview recreation (loses the handle to the `hwnd()` gotcha); adopting `meslzy/tauri-plugin-wallpaper` wholesale (re-validates our proven WorkerW search and inherits its assumptions). We keep that plugin as a *reference* for the subclass technique only.

### IPC surface

**Commands** (extend the four existing): window — `reattach_wallpaper`, `detach_wallpaper`, `toggle_overlay`, `get_status`, `set_pause(monitor_idx,bool)`, `get_monitors()`; state/settings — `load_state`, `get_settings`/`save_settings`, `set_mode`, `set_setting(key,val)`, `clear_log`; mapping — `get_mappings`, `set_mapping`, `reset_mappings`, `test_launch`; casting — `classify_sigil`, `analyze_ring`, `fire_spell`; audio — `set_viz_source`, `set_viz_mix`, `viz_status`.

**Events** (Rust → WebViews, names as `const`): `state:changed` (whole persisted store, re-emitted on every window ready/focus so N windows + overlay + control stay coherent); `mappings:changed`; `viz:bands` (the `BandFrame`, single global `emit` at capped 45 Hz, only wallpaper pages listen); `viz:source-changed`; `wallpaper://paused` (per-window, stops that monitor's rAF); `cast:summon` / `cast:toast` / `cast:secret`; `cast:fire` (the `BloomPayload`, emitted to each attached `wallpaper-i`); `cast:dismiss`; `cast:season` / `cast:birthday`; plus the existing `log`.

---

## 2. Phased Roadmap

Phases are ordered so the **riskiest remaining unknown (explorer-restart recovery + parent stability) is Phase 1**, fractional-DPI verification rides alongside it, and every phase ends with a runnable app. Phases 4–6 (port / casting / audio) each have an independent, parallelizable head-start (extract shared modules; port recognizer; lift audio module tree) flagged in their tasks.

### Phase 1 — Harden the wallpaper host (explorer-recovery + stability)
**Goal:** the wallpaper survives an `explorer.exe` restart, Win+D, and topology changes, with content (not just placement) preserved. This is the highest unknown — prove it before any visual polish.
**Deliverables:** `windows/host.rs` (WallpaperHost + reattach state machine), `windows/subclass.rs`, `windows/shellhook.rs`, `MonitorSnapshot`/`WallpaperHostState` in `state.rs`, `host::ensure_all()` wired into `RunEvent::Ready`, `Cargo.toml` adds `windows` feature `Win32_UI_Shell`.
**Key tasks:**
- Build the persistent per-monitor `LorraineWallpaperHost` (`CreateWindowExW`, `WS_CHILD|WS_VISIBLE` under WorkerW), `SetParent(tauri_wallpaper_i, host_i)`, `SetWindowPos` to host rect.
- Recovery sequence on any teardown trigger: re-find/spawn WorkerW → recreate dead hosts (cheap, our class, no `hwnd()`) → re-stitch the still-alive Tauri HWND under the fresh host → re-assert `attached`.
- Subclass the **host** (not the Tauri window): `WM_WINDOWPOSCHANGING` → force `SWP_NOZORDER` + clamp to (0,0) to survive Win+D / "Show desktop"; `WM_DPICHANGED` → rebuild that monitor; `WM_DESTROY` → clear `attached`. Gate the z-pin behind a feature flag.
- Hidden `HWND_MESSAGE` window: `RegisterWindowMessageW("TaskbarCreated")` (authoritative explorer-restart signal), `WM_DISPLAYCHANGE`, `WM_DPICHANGED`, optional `WM_SETTINGCHANGE`/`WM_DEVICECHANGE`. On trigger: re-`enum_monitors()`, diff snapshots, run recovery for all indices ("re-attach, don't patch"); unchanged → no-op.
- Drop the watchdog poll from 600 ms → ~2 s (messages now carry urgent cases; poll is backstop). All HWND work via `run_on_main_thread`. `RunEvent::Exit` → detach + destroy hosts cleanly.
- **Fallback if re-parent leaves the webview blank:** relaunch the webview URL into the same persistent HWND.
**Exit criteria:** Task Manager → Restart Explorer → wallpaper reappears with **content persisted** (assert, not just placement). Win+D / Show-desktop keeps the wallpaper pinned at the bottom of WorkerW z-order. Unplug/replug + resolution change rebuilds correctly.
**Effort: L**

### Phase 2 — Fractional-DPI verification (150% / 200% / mixed)
**Goal:** empirically close the only Slice-1 placement unknown — both dev monitors are 100%. Do this before any frontend visual polish so a `1/scale²` regression surfaces immediately.
**Deliverables:** a logged assertion `GetClientRect(host) == mon.{w,h}` after each attach (logs `mon.dpi`); confirmation that no-multiply physical-pixel placement holds at fractional scale; the canvas backing-store contract for `wallpaper.ts`.
**Key tasks:**
- Preserve the proven no-multiply rule: PerMonitorV2 → `rcMonitor` is physical px; placement = `mon.{x,y}` minus parent `ClientToScreen` origin, `mon.{w,h}` verbatim, **no scale multiply** (diverges from the JUCE port, which received logical DIPs and had to multiply).
- Live-change a dev monitor's scale to 150% then 200%; confirm full-fill (no top-left `1/scale²` shrink), crisp clock/visualizer (DPR honored), and `WM_DPICHANGED` rebuild.
- Mixed-DPI case: 3440×1440@100% + 1920×1080@150% — verify each `wallpaper-i` lands on the correct monitor at correct physical size.
- Define the WebView canvas contract: render-target = `cssSize * devicePixelRatio`; **if WebView2's reported DPR ≠ the monitor scale, drive canvas dimensions from the Rust-supplied physical w/h** passed in the init event instead of trusting `devicePixelRatio`.
- (If no fractional panel available) add a virtual display (IddSampleDriver/`usbmmidd`) or RDP in for a 3rd monitor at fractional scale.
**Exit criteria:** wallpaper fills exactly each monitor at 100/150/200% and mixed; client-rect assertion green; canvas crispness confirmed.
**Effort: M**

### Phase 3 — Pause/throttle on foreground fullscreen + audio release
**Goal:** the locked v1 power policy — pause + release audio on foreground fullscreen, per-monitor, with a "keep running" override.
**Deliverables:** `windows/fullscreen.rs`, per-monitor pause state, `wallpaper://paused` event, the WASAPI reference-count coordination with `audio.rs`.
**Key tasks:**
- Per-monitor detection in the 2 s tick: `GetForegroundWindow` → `GetWindowRect` → `MonitorFromWindow`; occluded when the foreground rect **equals** that monitor's `rcMonitor` (pixel-perfect — catches *borderless* fullscreen games that `WS_POPUP` checks miss). Exclude shell/Progman/WorkerW/our host.
- On occlusion: emit `wallpaper://paused {true}` (stops that window's rAF), set `paused`, honor a per-app/global **"keep running"** override.
- **Release WASAPI only when ALL monitors are paused** — reference-count "wants audio" in `AppState` behind the mutex; release at zero, re-acquire at first increment, all on the main thread (don't kill audio because one of two monitors has a fullscreen game).
- Specify the WebView-side "skip repaint when silent" complement (`maxDelta > 0.005`) for the "visible but quiet" case (implemented in Phase 4's `wallpaper.ts`).
**Exit criteria:** a borderless fullscreen game on one monitor pauses only that monitor; audio releases only when no monitor renders; override toggle works; false-positive on a maximized borderless app is one toggle away.
**Effort: M**

### Phase 4 — Port the prototype to production (rendering + shared core)
**Goal:** the wallpaper scene renders the full prototype (verbatim draw layers), decomposed along the input boundary across the three windows.
**Deliverables:** `src/atelier/*` shared modules (with Vitest); `WallpaperScene`, `MagicClock`, `VizSeal`, `TopStrip`, `BrushBuddy`, `Toast`, handler-free `DockMirror`; self-hosted fonts; wallpaper image rendition pipeline; primary/secondary monitor gating.
**Key tasks:**
- **(Head-start, unblocks everything)** Extract DOM-free `src/atelier/`: `palette.ts` (day/night tokens, canvas `pal`, `--c-*` vars), `spells.ts` (cosmetic half of the spells table), `audio/generative.ts` (4-osc pad → AnalyserNode fftSize 128 → `bands()` bass[0,4)/mid[4,16)/high[16,40) — **the golden band-shape definition**), `draw/*` (ambient/viz/glow/buddy/bloom — verbatim), `recognize/*` (TS oracle, retained for the golden corpus).
- Mount a real Solid root in `wallpaper.html`; one rAF master loop mirroring the prototype `tick()`. Layering exactly as the prototype (img/tint/glow/ambient/vignette/widgets/buddy). **Ink level is owned by Rust now** — the wallpaper only displays the vial height.
- Self-host **Cinzel** (400/500/600/700) + **EB Garamond** (400/500/600 + italic) WOFF2 into `public/fonts/`; drop the Google `<link>`s; `await document.fonts.ready` before first canvas text paint (wire into the reveal-on-paint pattern). CJK fallback in the font stack for the Japanese top-strip text.
- Asset pipeline: source art ≥3440px → two `cover`-cropped WebP renditions (`@3440`, `@1920`); pick per-window by physical width from Rust; CSS `background-image` on the scene root so the night `filter` + tint compose. (Shipped `wallpaper.webp` is only 1200×675 — placeholder for dev only.)
- Primary/secondary gating: `enum_monitors()` marks `MONITORINFOF_PRIMARY`; pass `{isPrimary, physicalW, physicalH}` to each window. **Primary:** full scene. **Secondary:** ambient + glow + tint + vignette + art + toasts only (no clock/seal/dock/buddy). One props-gated component tree.
- Lint/grep gate: fail the build if `onClick`/`onPointer*` appears under wallpaper components (the no-input constraint enforced by construction).
**Exit criteria:** wallpaper renders the full ambient scene crisply at 100/150/200%; primary shows widgets, secondary stays calm; fonts load with no FOUT; Vitest green on draw-pure + palette.
**Effort: L**

### Phase 5 — Casting mechanic + recognizer (overlay → Rust → wallpaper)
**Goal:** the end-to-end "draw a seal → classify → launch → bloom through the desktop" loop, with recognition authoritative in Rust.
**Deliverables:** `recognizer.rs` (pure, `#![forbid(unsafe_code)]`) + golden corpus + tests; `casting.rs`; `launcher.rs` + `tauri-plugin-shell`; the two-phase `CastingOverlay.tsx`; the wallpaper origami bloom.
**Key tasks:**
- **(Head-start, no deps)** Port `classify` / `analyze_ring` / `tri_orient` + helpers to `recognizer.rs`, line-for-line. **Faithfulness checklist (the brief's "essential" subtleties):** arc-length resample to 64 (reimplement the JS in-place splice as a forward walk); **closed-shape seam rotation to flattest start when `gap<0.34`** (makes squares count 4 not 3 — comment it); turning-angle corners `step=3`, threshold `0.78` rad, cluster within 4; classify cascade (secret `nC≥5 & gap<0.62` → square `nC≥4 & gap<0.5` → triangle `nC==3` → circle `nC≤1 & circ>0.6` → `nC==2`→triangle → circularity tiebreak); triangle apex by narrowest of 4 edge bands (up=Fire/down=Water/sideways=jut gag); **signed shoelace `ccw = area>0`** (cast vs dismiss — easy to invert, preserve the exact screen-coord sign); neatness `aspect*0.34 + clos*0.30 + reg*0.36`, clamp 8–100.
- **Golden corpus:** `npm run dump-corpus` runs the retained TS oracle over fixtures (clean △▽○□ + pentacle + sideways + CW/CCW rings + *recorded real strokes* captured from the overlay) → `tests/corpus/*.json`. Rust `#[test]` asserts `kind`/`sideways`/`secret`/`ccw` exact and `score` ±1–2. Keep a `recognize-parity` Vitest so future algorithm tweaks force deliberate corpus regen.
- Rebuild `overlay.ts` into the SPEC two-phase slate (520px canvas, dashed guide ring, phase label, HUD: Reading card + Neatness meter + Sigils legend reading **live mappings** + Clear/Dismiss). Pointer capture/`drawCast` port verbatim. On sigil `pointerup` → `invoke('classify_sigil',{points})`; on ring `pointerup` → `invoke('analyze_ring',{points,center})`; on valid ring → `invoke('fire_spell',{sigil,score,inverse,sideways,jutDir})`.
- **`fire_spell` is the sole side-effecting, atomic call in Rust:** resolve sigil→app via persisted mapping; **~13% cursed-misfire RNG decided HERE** (`!inverse && !sideways && score≥55 && rand<0.13`); ink −22 (clamp ≥6); mark discovered; append cast log; persist; launch (or dismiss if `ccw`); emit `cast:fire` to each `wallpaper-i`. Splitting `recognize_*` (preview) from `fire_spell` (commit) keeps the HUD live without launching, and makes the cursed roll/ink/launch atomic (overlay can die mid-bloom without double-launch).
- `launcher.rs`: `LaunchTarget` enum `{SteamUri, Discord, Url, Files, Exe{path,args}, Shell}`; defaults via **robust handlers not hardcoded paths** (Fire→`steam://open/main`, Wind→default browser, Earth→`explorer` on a folder, Water→`discord://`). Reversed ring (`ccw`) → best-effort `WM_CLOSE` on a process-name-matched top-level window (helper in `workerw.rs`) + themed reversed-bloom + toast; **never force-kill**.
- Bloom ownership: overlay plays a local slate bloom for immediate feedback then hides; the **wallpaper bloom** (origami unfold — expanding rings + spokes + glyph bloom + radial flash, dir from ring, 1.3–1.7 s by score) is driven entirely by the `cast:fire` event. v1: bloom centered per-monitor (coord-forwarding is a later enhancement). Toast is Rust-authored so it persists on the wallpaper after the overlay closes.
- Overlay summon: extend the existing `toggle_overlay` (hotkey + tray "Inscribe" + hot-corner + dock Inscribe button) to **active-monitor** placement (`GetCursorPos`→`MonitorFromPoint`→that `rcMonitor`, `cover_active_monitor`) — replacing Slice-1's `cover_virtual_screen`. Clear slate + reset to `phase:'sigil'` on summon.
**Exit criteria:** drawing △+CW ring launches the bound app and blooms through the desktop on all monitors; CCW ring dismisses; pentacle opens the storybook; recognizer parity tests green; "Test cast" in control validates a binding without drawing.
**Effort: XL**

### Phase 6 — Audio visualizer (generative + WASAPI loopback)
**Goal:** the source-agnostic 8-float band pipeline; generative default + one-tap "Attune to your music" → WASAPI loopback; the recipient-tuned audio eggs.
**Deliverables:** `audio/*` module tree, the capped `viz:bands` emit, the three commands, `src/audio/source.ts` accessor, persistence fields.
**Key tasks:**
- **(Head-start)** Lift the engine command loop + `ringbuf` + `LevelMeter` + realfft/Hann structure near-verbatim from DivoraVoiceMod's divora-core (don't pull the whole crate).
- **Capture: use the `wasapi` crate, NOT cpal** for loopback — cpal 0.15's output-as-input path is unreliable in mainline (RustAudio/cpal #476; PR #339 merged then removed). Open the default render endpoint with `AUDCLNT_STREAMFLAGS_LOOPBACK` (shared mode), event-driven blocking capture on the `"lorraine-audio"` thread, mono-mix into `HeapRb<f32>` (~8192). Rides the existing `windows 0.61` dep; keep cpal only for a future mic mode.
- Analyzer: `WINDOW=1024`, precomputed Hann, `RealToComplex::process` → 513 bins; **log-bin to the prototype's frequency edges** (bass <1.5k, mid 1.5–6k, high 6–15k) not bin indices; normalize via fixed dB reference + soft-clip tuned so a typical track lands mid-scale (**match the visual feel of the generative `/255`, not numeric equality**); per-band attack/release one-pole (fast attack ~0.3, slow release ~0.05–0.1, the loopback analog of `smoothingTimeConstant=0.82`); wide-band RMS for loudness; spectral-flux onset → `beat`.
- IPC: a Tokio interval emits `BandFrame { bands:[f32;8], loudness, beat, source:u8, seq:u32 }` once globally at **45 Hz** (renderer interpolates to 60/144 Hz; `seq` drops stale/dup frames; only wallpaper pages listen). v1 fills `[0..3]`; extra slots pre-wired. ~60 bytes JSON. Documented escalation (not built): shared-memory ring via `CreateFileMappingW`, gated behind a real profile.
- `src/audio/source.ts` `currentBands()`: generative → local `bands()`; attuned → last `BandFrame`. Toggle calls `set_viz_source`. **Hard invariant: the wallpaper render loop never depends on the audio thread existing** — any `StartCapture` failure (no endpoint, exclusive-mode lock, RDP) logs, demotes to generative, emits `viz:source-changed{attuned:false,reason}`, control shows a gentle toast.
- Default-device change: `IMMNotificationClient` `OnDefaultDeviceChanged(eRender,eConsole)`, debounced ~250 ms, re-open serialized through the mpsc command loop; fail → generative.
- Release client (not mute) on pause/fullscreen (Phase 3 sends `StopCapture`); re-acquire on un-pause unless "keep running".
- **Audio eggs (ride the same BandFrame):** Resonance sigil (snapshot current band balance as a gain profile + `beat`-driven central bloom); woodcruor refill from `loudness` (`+base*(0.4+1.6*loudness)` when attuned); "tune the seal" mixer (per-band weights + attack/release "viscosity" via `set_viz_mix`, honored by both sources).
**Exit criteria:** "Attune" switches to real loopback with the viz looking identical across the toggle; failure silently stays generative; device switch re-resolves; resonance + woodcruor eggs work.
**Effort: L**

### Phase 7 — Features, easter eggs & persistence
**Goal:** the full egg catalog + the user-editable mapping UI + persisted state, with the hard v1/deferred split.
**Deliverables:** `store.rs` schema/migrations + `tauri-plugin-store`; `eggs.rs`; control-window panels (Spell Bindings, Tower of Tomes, settings, hidden dedication); the v1 egg catalog wired.
**Key tasks:**
- Persistence: single JSON doc at `%APPDATA%\com.divora.lorraineatelier\atelier-state.json`, Rust sole writer, `schemaVersion`-gated migration. Fields: `firstRun`, `discovered{fire,water,wind,earth}`, `secretFound`, `ink`, `mode`, `mappings`, `castLog`, `settings{showBrushbuddy, colorblind, attuneOnStart, pauseOnFullscreen, keepRunningOnFullscreen, hotCorner, runAtStartup, vizSource, vizMix, resonanceArmed}`, and the `gift{recipientName, birthday("MM-DD"), silverEve, storybook{heading,paragraphs,signature}}` slot. Every mutation persists synchronously + emits `state:changed`. Each window also pulls `load_state` on mount (don't rely solely on push).
- Control "Spell Bindings" panel: one row per element (glyph disc, launch-type selector App-preset/Folder/URL/Custom, resolved target, **per-row "Test cast"**, Reset-to-defaults). Defaults △Fire→Steam, ▽Water→Discord, ○Wind→Browser, □Earth→Files.
- **v1 eggs:** brushbuddy companion (idle state machine, scurry-to-cast off `cast:fire`; primary-only; settings toggle); ~13% cursed-ink misfire (Rust-decided, self-reverts ~2.3 s, harmless); reversed-sign jut gag; secret-pentacle storybook (the gift); Tower-of-Tomes spellbook (collectible log + locked Forbidden Page unlocking on `secretFound`, footer hint at 4/4); mono-shirazu first-run welcome; forbidden-magic refusal = "memory erasure" (clear-history button, v1 uses a reserved self-glyph gate); Tartah colorblind mode (deliberate menu toggle — accessibility); Silver-Eve/seasonal + **birthday auto-bloom** (date checks in `eggs.rs` vs local time, `lastBirthdaySurfacedYear` so it fires at most once/year, surfaces the Hidden Page); ink-reservoir cooldown (Rust-authoritative refill so it persists across overlay reloads); resonance sigil + woodcruor (from Phase 6).
- Day/Night: swap CSS custom props + canvas palette + img filter, 1.1 s transitions; `set_mode` persists.
- **Widget layout customization (movable / resizable widgets):** let the user reposition and resize the wallpaper widgets (clock, visualizer seal, and later the dock mirror / brushbuddy) **per monitor**. Because the wallpaper takes no input, this is edited in the **control window** (a layout panel — drag handles + size sliders over a monitor preview, or simple X/Y/scale fields), and the chosen `{x, y, scale}` per widget per monitor is persisted and pushed to the wallpaper, which already drives size off a `--ui-scale` CSS var (Phase 4) — extend that to per-widget `--<widget>-scale` + position. Sensible default size already scales with monitor height (1440 → ×1.5). Persisted in the store under `widgetLayout`.
- **Brushbuddy enrichment (animation, navigation & interactive drag):** deepen the cross-monitor brushbuddy (the roaming companion built in Phase 4 — Rust-owned in virtual-desktop coords, per-window `buddy` event, owner-monitor visibility, seam y-ease) along three axes. Keep the buddy **Rust-driven** (state lives in `spawn_buddy`; the wallpaper stays a pure view) so it can never desync across monitors.
  - **Animation:** richer sprite states beyond the current walk / nap / blink — squash-and-stretch on direction changes, idle fidgets (look-around, stretch, sit), a startled hop when a cast fires nearby (`cast:fire`), an ink-drip trail; consider multi-frame or simple skeletal motion rather than the single static SVG.
  - **Navigation:** smarter roaming than today's pick-a-random-target wander — eased accel/decel, edge loitering, perching on/under widgets, drifting toward the monitor with the most recent cursor activity, and avoiding the clock/seal footprints; respect each monitor's seam geometry so crossings read naturally at any layout/DPI.
  - **Pick-up & drag with particle effects:** let the user grab the buddy with the mouse, fling/drop it (inertia + a burst of ink-mote particles on grab / throw / land), then watch it scurry back. **Input caveat (R-NOINPUT):** the wallpaper window receives no pointer input by platform constraint, so the drag cannot be handled on the wallpaper directly. Realistic paths: **(a, preferred)** a lightweight, transient **interactive surface** — reuse the casting `overlay` (or a dedicated click-through-toggling "playpen" window) that hit-tests the buddy, runs the drag, and writes the new position back to Rust, which keeps driving the wallpaper buddy; **(b)** the hard-deferred low-level raw-input forwarding path (see §5 "ink on the desktop"). Particles render on whichever surface owns the buddy during the interaction. Gate behind the existing `showBrushbuddy` setting plus a new "playful buddy" toggle.
**Exit criteria:** all v1 eggs fire from their gates; bindings editable + persisted + reflected in the overlay legend; pentacle → storybook; birthday auto-surface fires once; state survives restart.
**Effort: XL**

### Phase 8 — Shell, first-run & startup wiring
**Goal:** the app behaves as a polished tray utility from first launch.
**Deliverables:** tray menu, run-at-startup, first-run welcome, startup sequencing, capabilities.
**Key tasks:**
- Tray menu (Day/Night, Pause/Resume, Inscribe, Settings, Quit); `main` close → hide to tray (default minimize-to-tray); reuse DivoraVoiceMod's hidden-window reveal-on-paint.
- `tauri-plugin-autostart` (HKCU Run, no admin) behind the `runAtStartup` setting; start minimized to tray.
- Startup sequence in `lib.rs`: `set_dpi_awareness()` before Builder → `setup()` loads `Settings`, builds tray, registers hotkey + hot-corner + shellhook window → `RunEvent::Ready` runs `host::ensure_all()` then spawns the 2 s watchdog and the audio service → `RunEvent::Exit` detaches + destroys hosts. If `vizSource=="attuned"`, attempt capture once; on failure silently demote.
- Extend `capabilities/default.json`: `shell:allow-open`, store permissions, autostart, plus existing window/global-shortcut perms.
**Exit criteria:** fresh launch → tray + wallpaper up, mono-shirazu welcome, run-at-startup toggle persists and takes effect on reboot.
**Effort: M**

### Phase 9 — Packaging (NSIS per-user, one-off installer)
**Goal:** a single installer the recipient runs once.
**Deliverables:** NSIS per-user installer (already configured: `bundle.targets:["nsis"]`, `installMode:"currentUser"`), version-stamped GitHub Actions build, embedded resources.
**Key tasks:**
- Reuse the DivoraVoiceMod release profile (lto, codegen-units=1, panic=abort, strip) and the `release.yml` that version-stamps from the git tag (build NSIS).
- Bundle `gift.default.json` + the two wallpaper renditions + fonts as Tauri resources (embedded in `dist`, no runtime fetch).
- **Skip auto-update** (Tauri updater can't auth private GitHub assets) — one-off installer only.
- Replace the placeholder app icon (`src-tauri/icons/*`) with the themed Lorraine Atelier icon before the final build.
- **Unsigned is acceptable** (self-signed == unsigned for SmartScreen; EV no longer bypasses it) — recipient clicks "More info → Run anyway" once.
**Exit criteria:** the NSIS installer installs per-user without admin/UAC, launches to tray, and survives a reboot with run-at-startup on.
**Effort: S**

### Phase 10 — Pre-gift QA pass
**Goal:** the gift works on the recipient's machine, first try, on the special day.
**Deliverables:** a QA checklist run on the dev rig + (ideally) a clean second machine.
**Key tasks:**
- Re-run the Phase-1 explorer-restart and Phase-2 fractional/mixed-DPI checks on a fresh install.
- Verify all four default bindings via "Test cast"; confirm the recipient's actual apps (Steam/Discord/browser/files) launch.
- Set the `gift.default.json` birthday to a near date and confirm the auto-bloom + Hidden Page surface once; then set the real birthday.
- Draw all five sigils + CW/CCW rings with a mouse on the 520px slate; confirm recognition reads as intended (sloppy = "neatness", not bug).
- Toggle Attune on the recipient's audio setup; confirm graceful fallback if loopback is unavailable.
- Confirm pause-on-fullscreen + "keep running" override with a real fullscreen app; confirm idle resource use is low.
- Personalization checklist (below) fully completed.
**Exit criteria:** every item green on a clean install; the personal message is correct and the birthday auto-bloom is armed for the real date.
**Effort: M**

---

## 3. Consolidated Risk Register

| # | Risk | Severity | Mitigation |
|---|---|---|---|
| R-HOST | Re-parenting an already-realized WebView2-hosting Tauri window under a freshly created host is unproven vs Slice-1's attach-from-fresh path; the host layer itself can be torn down by explorer restart. | High | Host is OUR class, recreated cheaply on `TaskbarCreated`; the Tauri HWND is only re-parented (never destroyed) so WebView2 state survives. **Prototype this recovery as the first build task (Phase 1).** Fallback: relaunch the webview URL into the same persistent HWND if re-parent leaves it blank. Assert content (not just placement) persists. |
| R-DPI | Fractional DPI (150%/200%) untested — the documented `1/scale²` top-left-shrink bug surface; WebView2's reported DPR may not equal the monitor scale, mis-sizing canvases. | High | No-multiply physical-pixel placement is theoretically correct for PerMonitorV2; **confirm empirically in Phase 2** by live-changing scale and asserting `GetClientRect(host)==mon.{w,h}`. If DPR is wrong, drive canvas dims from Rust-supplied physical w/h, not `devicePixelRatio`. |
| R-ZPIN | `WM_WINDOWPOSCHANGING` z-pinning can fight desktop composition → flicker or a stuck window on Win+D across 24H2 builds. | Med | Copy the exact veto from `tauri-plugin-wallpaper` as reference; gate behind a feature flag so it can be disabled per-build. |
| R-FS | Pixel-perfect fullscreen detection can false-positive on a maximized borderless app exactly matching the monitor rect. | Med | Require foreground AND rect-equality; exclude shell windows; the "keep running" override is one toggle away. |
| R-AUDIO-RC | Per-monitor pause must not race the single shared WASAPI stream (release while another monitor still wants it). | Med | Reference-count "wants audio" in `AppState` behind the mutex; release at zero, re-acquire at first increment, all on the main thread. |
| R-LOOPBACK | cpal 0.15 loopback is unreliable in mainline (cpal #476); WASAPI loopback collides with exclusive-mode fullscreen games. | Med | Use the `wasapi` crate (raw `IAudioClient` + `AUDCLNT_STREAMFLAGS_LOOPBACK`), riding the existing `windows 0.61` dep; the fullscreen detector already releases the client; on `StartCapture` failure demote to generative + toast, never retry-spin. |
| R-BANDS | Band-shape parity between the WebView AnalyserNode (fftSize 128, `/255`, smoothing 0.82) and the Rust 1024-pt realfft path is approximate, not exact. | Med | Match on frequency *edges* not bin indices; tune a fixed dB reference + soft-clip; capture the generative `bands()` as a golden visual reference — the renderer must *look* identical across the toggle, not be numerically equal. |
| R-DEVCHG | `IMMNotificationClient` can fire an event storm on a single device switch and race the audio thread teardown. | Med | Debounce ~250 ms; serialize re-open through the mpsc command loop; fall back to generative on failure. |
| R-RECOG | Rust recognizer port can silently diverge from JS — the in-place `splice` resample and the screen-coord signed-area sign (cast vs dismiss), or mis-count square corners. | Med | Golden-reference corpus (JS oracle) with exact match on `kind`/`ccw`/`secret`/`sideways` and `score` ±1–2; include **recorded real strokes** so the corner-clustering and flattest-start-rotation paths are exercised. |
| R-SYNC | State (discovered/ink/mode/mapping) lives in Rust, mirrored to N wallpaper windows + overlay + control; a window summoned mid-update shows stale counts. | Med | Single authoritative `state:changed` event with the whole store, re-emitted on every window ready/focus, plus a `load_state` pull on mount. |
| R-NOINPUT | The prototype's dock/Attune/Tomes/Day-Night handlers live on the resting surface; if ported onto the wallpaper they're silently dead (platform constraint, invisible in a browser preview). | Med | Enforce by construction — wallpaper imports a handler-free `DockMirror`; all controls live only in control/overlay/tray; lint/grep gate fails on `onClick`/`onPointer*` under wallpaper components. |
| R-DISMISS | Reversed-ring "close the app" over-promises (multi-window apps, elevated processes, Steam/Discord backgrounding). | Med | v1 dismiss = best-effort `WM_CLOSE` on a process-name-matched top-level window; always play the themed reversed-bloom + toast so the egg lands even when nothing closes; never force-kill. |
| R-COORD | Forwarding the exact cast point from the overlay (virtual-screen coords) to per-monitor wallpaper windows (physical rects under WorkerW) is error-prone DPI/origin math. | Low | v1 bloom is centered per-monitor (reads fine); point-accurate placement is a later enhancement reusing `workerw.rs`'s origin transform. |
| R-LAUNCH | Hardcoded exe paths break if Steam/Discord install elsewhere or aren't present. | Low | Prefer protocol handlers (`steam://`, `discord://`, default-browser) and folder/`explorer`; "Test cast" per binding validates the recipient's machine before gifting. |
| R-BLOOM | Splitting `fireSpell` (bloom in overlay, state in Rust) risks double-applying ink or a race where the overlay hides before the wallpaper echo plays. | Low | `fire_spell` is the **sole** state mutator; the overlay bloom is presentation-only and reads nothing back; the wallpaper echo is driven entirely by `cast:fire`. |
| R-BDAY | Birthday/Silver-Eve auto-surface mis-fires (timezone, app left running across midnight, fires every launch). | Low | Store `lastBirthdaySurfacedYear`; check on startup + a once-a-minute date-rollover tick using **local** time; surface at most once per year. |
| R-ASSET | Shipped `wallpaper.webp` is 1200×675 — visibly blurry on the 3440×1440 primary. | Low | Require ≥3440px source art + the two-rendition pipeline before the gift build; low-res placeholder is dev-only. |
| R-IPC | Global `viz:bands` reaches control/overlay too; a window recreated on explorer restart may miss/dup frames. | Low | `seq` counter drops stale/dup; only wallpaper pages register the listener; re-attach re-establishes it; ~60-byte payload makes extra recipients free. |

**Carried Slice-1 follow-ups (now owned by phases):** explorer-restart recovery via window recreation → **Phase 1** (host-window approach); WndProc subclass for Win+D/parent stability → **Phase 1**; pause-on-fullscreen → **Phase 3**; fractional-DPI verification → **Phase 2**.

---

## 4. Gift-Personalization Checklist

Everything ships generic except **one file the dev personalizes before building the installer** — no recompile of logic required.

- [ ] **The birthday message (primary slot):** edit `src-tauri/resources/gift.default.json` (bundled as a Tauri resource, marked with a `// FILL ME IN` banner). Fill `recipientName`, the three `storybook` strings (`heading`, `paragraphs[]`, `signature`). On `firstRun`, `store::init` seeds the `gift` object from this file into `atelier-state.json`. The SPEC's placeholder storybook copy (`Atelier.dc.html` lines 190–192) is the literal default so the page renders even if untouched.
- [ ] **The birthday date (auto-bloom):** set `gift.default.json → birthday` to `"MM-DD"`. `eggs.rs::today_specials()` checks it against local time on startup + once-a-minute rollover; on the day the Silverwood blooms and the Hidden Page auto-surfaces once (guarded by `lastBirthdaySurfacedYear`). This is the belt-and-suspenders for the emotional payload — the gift "knows" the day even if the secret glyph is never found.
- [ ] **The secret glyph (manual path to the message):** no edit needed — the pentacle (`classify` returns `secret` when `nC≥5 & gap<0.62`) sets `secretFound`, unlocks the Forbidden Page, and opens the storybook. Optionally verify by drawing a five-point star on the overlay slate.
- [ ] **Silver Eve (optional seasonal):** set `gift.default.json → silverEve` to an optional `"MM-DD"` for the festival-lights egg.
- [ ] **App icon:** replace the placeholder `src-tauri/icons/*` (32x32.png, 128x128.png, 128x128@2x.png, icon.ico, icon.png) with the themed Lorraine Atelier icon before the final build.
- [ ] **Default sigil→app bindings:** confirm △Fire→Steam, ▽Water→Discord, ○Wind→Browser, □Earth→Files match the recipient's installed apps; adjust defaults in `store.rs` or leave for the recipient to edit in the control window's Spell Bindings panel. Use "Test cast" to validate on the target machine.
- [ ] **(Optional) Live edit without rebuild:** the control UI's hidden "Atelier dedication" panel (reachable after `secretFound` or via a tray dev item) edits the same `gift` fields at runtime, and the JSON can be hand-edited before gifting.

---

## 5. What's NOT in v1

- **Raw-input "ink on the desktop"** — hard-deferred. Needs the brittle low-level input-forwarding path (`RegisterRawInputDevices` + `PostMessage`) to inject strokes onto the WorkerW layer that *receives no input* by platform constraint. The overlay is the sanctioned draw surface.
- **WASAPI device selector** — v1 is **system loopback only**; per-device selection deferred.
- **Petrify-a-window / Sylph-Shoes "lift the desktop icons"** — needs reliable foreign-window / `SysListView32` manipulation across DPI; parked behind the same window-enumeration helper as reversed-ring dismiss. (If revived later, do the icon-lift as a wallpaper-layer *fake* — painted motes — not real `SysListView32` manipulation.)
- **"Tune the seal" mixer (dyes) + pen-pressure line weight** — pure polish; pressure needs Pointer Events `pressure` plumbed through the overlay→Rust path. Defer to a polish pass. (The Resonance sigil + woodcruor-from-loudness eggs *are* in v1.)
- **Point-accurate cast-bloom placement** — v1 blooms centered per-monitor; forwarding the exact cast point through the DPI/origin transform is a later enhancement.
- **Pentacle-of-Proving achievement track / hat customization** — larger meta-progression, out of scope.
- **More than 4 monitors** — the config-window pool caps at 4 (`wallpaper-0..3`); documented limit, not a regression.
- **Span/duplicate wallpaper modes** — one window per monitor only; a later toggle.
- **Auto-update** — skipped (Tauri updater can't auth private GitHub release assets); ship a one-off installer.
- **Code signing** — unsigned is acceptable (self-signed == unsigned for SmartScreen, EV no longer bypasses it); recipient clicks "Run anyway" once.
- **Shared-memory audio IPC ring** — documented escalation only; the 45 Hz JSON event path is the v1 shipping path, gated behind a real profile.
- **Audible generative ambience** — the generative pad's master gain stays muted in the wallpaper windows for v1 (only its numeric `bands()` output is used).
