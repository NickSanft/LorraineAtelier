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

#### Casting & glyphs — canon-grounded refinements (research)

> Our current Phase-5 design is already substantially canon-faithful — ring-closure activation, size+neatness→power, signed-area CW=cast/CCW=dismiss, the pentacle secret, and an origami bloom all map cleanly onto *Witch Hat Atelier* canon. The two highest-value, lowest-cost upgrades are: **(1)** add the canon **5th element (Light, a Fire-sigil variant)** and re-label our shape vocabulary as the canon **sigil / sign / ring** anatomy; and **(2)** add the signature **closing-dot "instant-cast"** trigger plus the **prepared-spell gap**. The genuinely new mechanic worth scoping is an explicit **modifier-sign middle phase** (the heart of canon spellcraft we currently skip) — but it is the heaviest lift and can stay a v2 stretch. Each item is tagged **[canon]** (grounded in the manga/wiki) or **[original]** (our extrapolation on top of canon), plus an effort estimate.

- **[canon][easy] Add the 5th element, Light, as a Fire-sigil variant.** Canon has five sigils — fire, water, earth, wind, and **light** (light is explicitly described as a variant of the fire sigil). Add a Light sigil drawn as our Fire shape with an added inner dot/rays so it reads as a deliberate variant, and re-label the existing four (△Fire/▽Water/○Wind/□Earth) as the canon element set. Bind Light to a "focus/spotlight" action. Recognizer cost is one new branch in the `classify` cascade keyed off a center-dot test inside the Fire triangle.
- **[canon][easy] Re-label the recognizer vocabulary as sigil / sign / ring in UI + docs.** Present the central shape as the **SIGIL** (element), the ring as the **RING** (activator), and surface those names in the overlay HUD, the Sigils legend, and the spellbook. Zero algorithm change; large authenticity gain and it sets up the sign phase below.
- **[canon][easy] Enforce "everything inside the ring" + a dud (fizzle) for an unclosed ring.** Canon: only sigil/signs within or connected to the closed ring contribute, and nothing fires until the ring closes. Grey out strokes outside the ring and play a gentle **fizzle** for an unclosed/abandoned ring — distinct from the cursed-misfire path.
- **[canon][medium] Add the closing-DOT activation + the prepared-spell gap (signature "instant-cast").** Canon's iconic instant-cast: pre-draw the glyph leaving a small **gap** in the ring, then close it with a single **dot** of ink. Fire the cast on a deliberate dot/tap at the ring's start; if left with a gap and no dot, store it as a **prepared spell** the user fires later with one tap. Re-frames the bloom as a true ring-closure *event*. Recognizer: detect the gap on the ring polyline + a terminal near-stationary dot.
- **[canon][medium] Upgrade the single neatness score into three named canon sub-scores (Size / Steadiness / Symmetry).** Canon quality rules are separable: **bigger = stronger**, **neater/steadier = more stable/longer-lasting**, **symmetry = stability** (asymmetric still casts but is unstable). Keep `aspect*0.34 + clos*0.30 + reg*0.36` under the hood but surface three labeled meters; let **asymmetry** (not just sloppiness) raise the cursed-misfire chance. Size→bloom scale/duration; steadiness→lifetime; symmetry→stability/misfire.
- **[canon][medium] Make stroke GEOMETRY semantic (tilt = spin, size = magnitude, column vs dispersion = directionality).** Canon: tilting a sign adds rotation (more tilt = more spin, less reach); larger sign = more magnitude (Coco over-powers a water spell by drawing one line too long); a long straight tail = focused "column" beam, a radial flourish = "dispersion". Map the user's stroke tilt→bloom spin, length/size→bloom magnitude/reach, column-vs-radial→directional vs radial bloom. Lighter than a full sign phase; reads geometry we already capture.
- **[canon][medium] Re-frame CW=cast / CCW=dismiss as a true canon sign-flip reversal.** Canon reversal is "flip the direction of a sign," and two identical-but-reversed seals **cancel out** (pairs: Floating Expansion/Reduction, Wall Breaker/Integration). Tighten our signed-shoelace `ccw` so a dismiss only cancels the spell that is the **mirror of it**, and play the dismiss bloom **in reverse** (ink un-drawing into the pen). Note: canon reverses the *sign*, not ring spin — our spin shortcut is an [original] adaptation.
- **[canon][easy] Tie ink cost to canon "conjuring ink" with a size→cost tradeoff.** Spells use conjuring ink (woodcruor from Silverwood trees); bigger seals are stronger. Scale the −22 drain with seal **size**, with a "refining woodcruor" refill flavor when empty — grounds the reservoir in lore.
- **[canon][easy] Re-skin the ~13% cursed misfire as a Brimmed-Cap / forbidden-magic backfire.** Forbidden magic is the Brimmed Caps' domain, and **Petrification** is the accidental miscast that opens the manga. Keep the Rust-decided roll, but show a corrupted "brimmed-cap scrawl" seal + themed toast (optionally a creeping Petrification grey-out that recedes).
- **[canon][easy] Lean into the "no magic on living things" taboo as flavor.** The Day of the Pact forbids magic on the human body (memory-wipe excepted); magic on **tools/objects is allowed** — exactly what we do. Add a Brimmed-Cap egg: a "forbidden" gesture (inverted self-body sigil, or drawing over a detected face/webcam) triggers a stern in-world refusal — dovetails with the Phase-7 "memory erasure = clear history" egg.
- **[canon→original][medium] Add a canon decorative/object sigil egg (a bird) to supplement the pentacle.** Canon decorative sigils make magic shaped like the drawn object — the **bird** sigil conjures a magic bird that flies around a while. Higher-fidelity than a generic star; keep the pentacle as the secret path but consider a bird bonus egg. (The pentacle is **[original]** — not a documented canon sigil.)
- **[canon][hard] Add the explicit MODIFIER-SIGN middle phase (sigil → signs → ring).** The biggest fidelity gap: canon seals are three ordered parts and the **signs** are the heart of spellcraft, which we skip. Insert a middle phase recognizing 2–4 simple sign marks (radial tick = direction, slash/chevron = rotation, doubled mark = magnitude) in radial/bilateral symmetry. High value, heaviest recognizer + UX change — scope as a v2 stretch after the closing-dot and 5th element land.
- **[canon][hard] Add nested-ring spell combining.** Canon: a spell can be wrapped in another ring (gap filled by a second spell) to combine effects. If the user draws a second seal inside an unresolved one, combine (e.g. Fire inside a Wind ring = swirling flame). Defer — combo rules are largely our extrapolation and depend on the sign phase.

**Visual/bloom note (anime-grounded, [canon-style]):** make the cast resolve in **black ink first, then ignite** — draw recognized strokes as wet black silverwood ink, and only on ring-closure let the line brighten into a thin warm-gold/teal luminous line that "catches light." Render the bloom as an **origami unfold** (concentric rings + radial spokes folding outward ~0.4–0.6 s, sigil settling last) in **light *and* shadow** (bright line + soft drop-shadow), not pure additive neon, with per-element ink motion (Fire upward, Water falling droplets, Wind spiraling, Earth a heavy settling ripple). These are 2026 anime extrapolations of the monochrome manga, not literal panels.

**Sources.** [Magic — Telepedia WHA Wiki](https://witchhatatelier.telepedia.net/wiki/Magic) · [Signs Explained — Telepedia](https://witchhatatelier.telepedia.net/wiki/Signs_Explained) · [Spells — Fandom](https://witch-hat-atelier.fandom.com/wiki/Spells) · [Magic System Explained — Game Rant](https://gamerant.com/witch-hat-atelier-magic-system-explained/) · [Power System / Magic Glyphs — FandomWire](https://fandomwire.com/witch-hat-atelier-power-system-explained-what-are-magic-glyphs-how-do-they-work/) · [Forbidden Spells — FandomWire](https://fandomwire.com/all-known-forbidden-spells-in-witch-hat-atelier-explained/) · [Conjuring Ink — Fandom](https://witch-hat-atelier.fandom.com/wiki/Conjuring_Ink)

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

#### Audio visualizer — ink-magic refinements (research)

> The Phase-6 plan already nails the spine: an 8-float band pipeline, per-band attack/release one-pole, spectral-flux onset → `beat`, a generative↔attuned toggle, and a concentric-ring `VizSeal`. The research adds two layers: **(a)** signal-processing polish that makes the motion feel *alive* rather than meter-like, and **(b)** an ink-magic re-theme so the seal reads as an actually-inscribed glyph (sigil + signs + ring) instead of generic teal rings. All Canvas2D-implementable off the existing 8 bands @ 45 Hz. Highest-value, lowest-cost: **asymmetric attack/release + perceptual weighting + log amplitude** (small, shared with the cast bloom) and the **beat = "the ring closes" moment**.

**Signal processing (makes the motion feel alive)**
- **[easy] Asymmetric attack/release on every audio-driven quantity.** Snap up instantly on a rise, decay with an exponential release (~tau 0.06 s ⇒ per-frame coeff ≈ exp(−1/(0.06·45)) ≈ 0.69 at 45 Hz). Apply to ring thickness, glyph brightness, particle speed. **Reuse the same envelope util for the Phase-5 cast bloom** so cast and beat share one feel.
- **[easy] Perceptual band weighting + log/dB amplitude.** Multiply the 8 bands by an A-weighting-style gain (boost 2–5 kHz treble, attenuate sub-bass) and scale radius to dB/log (or pow γ≈2). Without this, bass dominates and treble glyphs look dead. Tune against the generative `bands()` golden reference (match *feel* per R-BANDS, not numbers).
- **[easy] log-of-MAX (not mean) per band + frame-rate-adapted smoothing.** Take the log of the **max** energy per band so narrow peaks punch through; adapt the smoothing constant to the real frame rate (`s' = s^(1/R)`) so behavior is identical at 45 Hz or when frames drop.
- **[medium] Replace per-band EMA with a 2nd-order spring-damper.** Give each band's drawn radius position+velocity, pulled to target with stiffness k, damping near critical (ζ≈0.9–1.0). Rings "breathe" and settle like living ink instead of a flat meter; layer asymmetric release on top.
- **[medium] Percentile auto-gain + noise gate.** Track a rolling high-percentile of recent band energy as the normalizer so soft tracks still animate and loud tracks don't pin the seal to max.
- **[medium] Per-band spectral-flux onsets (kick/snare/hat) atop the global beat.** Keep separate bass/mid/high onsets against adaptive thresholds so different seal elements fire independently.

**Ink-magic re-theme (reads as a real WHA seal)**
- **[medium] Re-skin the seal as a literal sigil + signs + ring stack.** A central rotating **sigil** (matches the user's last cast element), a ring of discrete **sign/keystone** marks in **radial symmetry** (not abstract particles), and 2–3 nested **rings** — the canon glyph anatomy. Optionally style on the canon memory-erasure seal aesthetic (concentric circles + central dot + radiating keystones).
- **[medium] Beat = "close the ring" (the canon activation instant).** On a beat, sweep the outer ring's dash-offset to 0 (completing it) and emit one outward resonance ripple; between beats let a small **gap** re-open (the canon instant-cast gap). Loud passages literally re-"cast" the seal. **Reuse the Phase-5 origami-unfold bloom** so cast and beat share a vocabulary.
- **[easy] Bass = ink flow (thicken the line), not a bass bar.** Drive `lineWidth` + a subtle ink-bleed (`shadowBlur`) of the inner rings with bass, so low end "thickens the ink" and blooms strokes outward.
- **[medium] Treble = igniting glyphs/keystones.** Map high bands to brightness/ignition of the central glyph + keystone strokes — treble flares keystones gold with a bright head travelling the stroke path; mids fill the middle ring.
- **[medium] Sustained loudness = bigger, neater seal (size + neatness = power).** A slow loudness envelope scales overall radius and **reduces jitter** as energy sustains; quiet passages shrink + loosen lines to hand-drawn. Direct canon translation.
- **[medium] Render orbiting particles as INK, not light dots.** Comet trails that "trail off," occasional ink-blot feathering; a bass hit sends a wet ink **ripple** dispersing outward.
- **[medium] Counter-rotating concentric rings (alchemy/astrolabe read).** Inner ring angular velocity follows bass one way, outer ring follows treble the other; particle streak (motion-blur) on a beat. Nods to the series' Art Nouveau alchemy-wheel linework.

**Day/night & generative-vs-attuned feel**
- **[easy] Day/Night palette tied to `set_mode`.** NIGHT = canon **black-and-gold** (gold ink on near-black, warm-gold glow); DAY = teal-on-parchment with paper grain. Drive only glow hue/brightness with treble, saturation/bloom with bass — **never strobe the whole background**. (Teal is [original]; gold-on-black is the more canon-faithful night.)
- **[medium] Make the generative↔attuned toggle feel like ink waking up.** GENERATIVE = a slow low-amplitude "reverie" (gentle breathing, occasional self-drawn keystones, **no sharp beats** — drop synthetic flux sensitivity so idle never strobes). ATTUNE = a one-time animated "ink flood" filling the ring from the gap, after which beats/flux sharpen and the palette deepens — reinforcing "the seal answers *your* music."

**Safety (always-on wallpaper)**
- **[easy] Photosensitivity guard (shared with the Phase-5 bloom).** Clamp full-seal brightness pulses to ≤ ~3 Hz, keep every brightness change **enveloped** (no instant full-canvas flashes), cap bloom contrast. This runs all day — err gentler; apply the same clamp to the cast bloom.

**Sources.** [A better FFT-based audio visualization — dlbeer](https://dlbeer.co.nz/articles/fftvis.html) · [lookas (spring-damper, mel + A-weighting, auto-gain)](https://github.com/rccyx/lookas) · [Spectral-flux beat mapping — Medium](https://medium.com/giant-scam/algorithmic-beat-mapping-in-unity-real-time-audio-analysis-using-the-unity-api-6e9595823ce4) · [Equal-loudness contour — Wikipedia](https://en.wikipedia.org/wiki/Equal-loudness_contour) · [Photosensitive epilepsy — Epilepsy Society](https://epilepsysociety.org.uk/about-epilepsy/epileptic-seizures/seizure-triggers/photosensitive-epilepsy) · [Magic — Fandom WHA Wiki](https://witch-hat-atelier.fandom.com/wiki/Magic)

### Phase 7 — Features, easter eggs & persistence
**Goal:** the full egg catalog + the user-editable mapping UI + persisted state, with the hard v1/deferred split.
**Deliverables:** `store.rs` schema/migrations + `tauri-plugin-store`; `eggs.rs`; control-window panels (Spell Bindings, Tower of Tomes, settings, hidden dedication); the v1 egg catalog wired.
**Key tasks:**
- Persistence: single JSON doc at `%APPDATA%\com.divora.lorraineatelier\atelier-state.json`, Rust sole writer, `schemaVersion`-gated migration. Fields: `firstRun`, `discovered{fire,water,wind,earth}`, `secretFound`, `ink`, `mode`, `mappings`, `castLog`, `settings{showBrushbuddy, colorblind, attuneOnStart, pauseOnFullscreen, keepRunningOnFullscreen, hotCorner, runAtStartup, vizSource, vizMix, resonanceArmed}`, and the `gift{recipientName, birthday("MM-DD"), silverEve, storybook{heading,paragraphs,signature}}` slot. Every mutation persists synchronously + emits `state:changed`. Each window also pulls `load_state` on mount (don't rely solely on push).
- Control "Spell Bindings" panel: one row per element (glyph disc, launch-type selector App-preset/Folder/URL/Custom, resolved target, **per-row "Test cast"**, Reset-to-defaults). Defaults △Fire→Steam, ▽Water→Discord, ○Wind→Browser, □Earth→Files.
- **v1 eggs:** brushbuddy companion (idle state machine, scurry-to-cast off `cast:fire`; primary-only; settings toggle); ~13% cursed-ink misfire (Rust-decided, self-reverts ~2.3 s, harmless); reversed-sign jut gag; secret-pentacle storybook (the gift); Tower-of-Tomes spellbook (collectible log + locked Forbidden Page unlocking on `secretFound`, footer hint at 4/4); mono-shirazu first-run welcome; forbidden-magic refusal = "memory erasure" (clear-history button, v1 uses a reserved self-glyph gate); Tartah colorblind mode (deliberate menu toggle — accessibility); Silver-Eve/seasonal + **birthday auto-bloom** (date checks in `eggs.rs` vs local time, `lastBirthdaySurfacedYear` so it fires at most once/year, surfaces the Hidden Page); ink-reservoir cooldown (Rust-authoritative refill so it persists across overlay reloads); resonance sigil + woodcruor (from Phase 6).
- Day/Night: swap CSS custom props + canvas palette + img filter, 1.1 s transitions; `set_mode` persists.
- **Widget layout customization (movable / resizable widgets):** let the user reposition and resize the wallpaper widgets (clock, visualizer seal, and later the dock mirror / brushbuddy) **per monitor**. Because the wallpaper takes no input, this is edited in the **control window** (a layout panel — drag handles + size sliders over a monitor preview, or simple X/Y/scale fields), and the chosen `{x, y, scale}` per widget per monitor is persisted and pushed to the wallpaper, which already drives size off a `--ui-scale` CSS var (Phase 4) — extend that to per-widget `--<widget>-scale` + position. Sensible default size already scales with monitor height (1440 → ×1.5). Persisted in the store under `widgetLayout`.
- **Interactive wallpaper input (clickable dock + draggable buddy) [requested]:** make the on-desktop **DockMirror** actually clickable (Inscribe → summon overlay; Day/Night → `set_mode`; Attune → `set_viz_source`; Tomes → spellbook) and enable the brushbuddy pick-up/drag. Today the wallpaper takes **no pointer input** (R-NOINPUT) — those actions live only in the tray + control window — but the user wants the dock interactive. **Research lead:** the earlier **LiveWallpaperPrototype (JUCE)** *did* have interactable easter-egg pieces on its WorkerW-child window, so direct input on the wallpaper layer is achievable — investigate first whether our **WebView2-in-host (WS_CHILD under WorkerW)** can receive clicks directly (hit-testing / WS_EX styles / forwarding), since that would make the existing HTML dock+buddy clickable with no new surface. **Fallback:** a transient, summonable **interactive overlay/"playpen"** (the casting-overlay model) that hit-tests the dock/buddy and writes actions/positions back to Rust. This unifies the dock-click and the buddy pick-up-&-drag (same mechanism). Gate behind a setting; never block desktop-icon clicks. *Effort: M–L; can land as its own slice.*
- **Brushbuddy enrichment (animation, navigation & interactive drag):** deepen the cross-monitor brushbuddy (the roaming companion built in Phase 4 — Rust-owned in virtual-desktop coords, per-window `buddy` event, owner-monitor visibility, seam y-ease) along three axes. Keep the buddy **Rust-driven** (state lives in `spawn_buddy`; the wallpaper stays a pure view) so it can never desync across monitors. **Canon correction (research, 2026-06-20):** the current sprite is OFF-canon — "Brushbuddy" is the real Kodansha name for *Witch Hat Atelier*'s mascot (JP フデムシ *fudemushi* = ink-brush + bug), a **fluffy four-legged creature with one oversized brush-tail, drawn to the scent of magic ink** — NOT a hatted ink-blob. A faithful redesign is now the P0 art task; see the research-grounded subsection at the end of this phase for the full identity, art spec, and prioritized behavior catalog.
  - **Animation:** richer sprite states beyond the current walk / nap / blink — squash-and-stretch on direction changes, idle fidgets (look-around, stretch, sit), a startled hop when a cast fires nearby (`cast:fire`), an ink-drip trail; consider multi-frame or simple skeletal motion rather than the single static SVG.
  - **Navigation:** smarter roaming than today's pick-a-random-target wander — eased accel/decel, edge loitering, perching on/under widgets, drifting toward the monitor with the most recent cursor activity, and avoiding the clock/seal footprints; respect each monitor's seam geometry so crossings read naturally at any layout/DPI.
  - **Pick-up & drag with particle effects:** let the user grab the buddy with the mouse, fling/drop it (inertia + a burst of ink-mote particles on grab / throw / land), then watch it scurry back. **Input caveat (R-NOINPUT):** the wallpaper window receives no pointer input by platform constraint, so the drag cannot be handled on the wallpaper directly. Realistic paths: **(a, preferred)** a lightweight, transient **interactive surface** — reuse the casting `overlay` (or a dedicated click-through-toggling "playpen" window) that hit-tests the buddy, runs the drag, and writes the new position back to Rust, which keeps driving the wallpaper buddy; **(b)** the hard-deferred low-level raw-input forwarding path (see §5 "ink on the desktop"). Particles render on whichever surface owns the buddy during the interaction. Gate behind the existing `showBrushbuddy` setting plus a new "playful buddy" toggle.
**Exit criteria:** all v1 eggs fire from their gates; bindings editable + persisted + reflected in the overlay legend; pentacle → storybook; birthday auto-surface fires once; state survives restart.
**Effort: XL**

#### Brushbuddy — identity, art & behavior (research-grounded)

> Deepens the Phase-7 "Brushbuddy enrichment (animation, navigation & interactive drag)" bullet with a research-grounded identity, art spec, and prioritized behavior catalog. **Invariant:** the buddy stays **Rust-owned** (state in `spawn_buddy`, virtual-desktop coords, per-window `buddy` event); every wallpaper window is a pure view that interpolates, so the companion can never desync across monitors. The wallpaper takes **no pointer input** (R-NOINPUT), so any grab/drag/pet runs on a transient interactive surface (the casting `overlay` or a dedicated click-through-toggling "playpen" window) that writes positions back to Rust.

**Identity.** "Brushbuddy" is the **canon** Kodansha English name (JP フデムシ *fudemushi* = *fude* "ink brush" + *mushi* "bug") for *Witch Hat Atelier*'s mascot — a small, docile, fully fur-covered creature whose name and design are both inspired by an ink brush, drawn to the **scent of magic (conjuring) ink** (hence it haunts witches). We lean into that canon: a fluffy ink-brush familiar with the signature anatomy — rounded torso, four short stubby legs, and **one oversized, thick, tapering brush-tail** (about as thick as the body). This **replaces the prototype placeholder** (a dark ink-blob with a pointed top, no tail/fur). Two clearly-labeled **original** embellishments sit on top of canon: an optional **removable witch-hat** accessory (canon Brushbuddy is hatless) and the in-world conceit that, bathing in conjuring ink, it acts as a **living brush** (fading ink trails, nosing toward inky things). Register: Totoro/Jiji comfort-mascot — gentle, curious, slightly clumsy; never a Clippy interrupter.

**Art spec.**
- **Silhouette (do first):** one instantly-readable shape — fluffy torso on four stubby legs + one long brush-tail that sweeps like a single sumi-e stroke; the **tail is the signature read** and the primary rig. Must hold at 32–48 px.
- **Line weight:** hand-inked dip-pen line-art, not flat vector fill — confident dark contour with taper at stroke ends; fake the series' cross-hatching with just **1–3 deliberate hatch strokes** per shadow zone at sprite scale (full fields turn to mud).
- **Fur:** bristle/brushstroke clumps (canon fur "resembles brush bristles") → slightly ragged soft-edged outline, never airbrushed; include the cheap canon tell, a **patch of fur between the eyes** in a different tone.
- **Eyes/face:** large, round, warm, "smiling"; ink the eye outline at the body's pen weight; **single small catchlight** (no glossy gacha eyes).
- **Palette — body:** inky monochrome to honor the B&W manga. Default **dark/charcoal** variant (#F4ECDB → #1E1A17) to fit the existing aesthetic while being canon-accurate; ship **white** + **striped** variants too (all canon → lore-justified recipient skin picker).
- **Palette — accents/magic:** amber/sepia glow #E2A23B / #C8852F, parchment #EFE3C6, gold-leaf #C9A24B; muted Atelier-blue #3E6E8E sparingly (hat band/ribbon, echoing Coco). Ink-trail tint can lean toward the active visualizer hue.
- **Magic = ink, not sparkles:** trails, footprints, grab/throw/land particles are **ink-motes / sumi blots**, not glow or sci-fi sparks. Any shown micro-spell is a correct **seal** (central sigil + modifier signs + enclosing ring) that activates by drawing the ring **last** and closing it with a **final dot** — a soft luminous bloom, never an explosion.
- **Ornament:** speech/idle chrome uses thin Mucha-style filigree + gold-foil edges + "tattered-scroll" framing — line-only, asymmetric-elegant.
- **Motif props (sparing):** dip pens/inkpots/ink drops, a nut/berry treat (canon diet), celestial dots, runic marks, **brimless** cone hat only (a brimmed buckled hat signals the antagonist faction).
- **Day vs Night** (off existing `set_mode`, 1.1 s transition): day = brighter, livelier, more roaming; dusk = small lantern/hat glow; night = dimmer/cooler, slower, more napping, faster-fading trails, curled with tail furled like a brush.
- **Avoid:** flat textureless fills; neon/rainbow; sci-fi glow/lens-flare/sparkle VFX; airbrushed gradient fur; machine-perfect halos; glossy mega-eyes; the cliché brimmed-buckled wizard hat. Retire the pointed ink-blob once the fluffy-tail redesign lands.

**Behavior catalog (prioritized — tie to real app features; Rust-driven unless an input surface is required).**
- **P0 — Canon fluffy-tail redesign (art base).** Reskin placeholder → canon buddy; dark default + white/striped skins. *Trigger:* foundational. *Feasibility:* M. *Input surface:* no.
- **P0 — Tail-driven idle life loop.** Breathing, blink, fur ripple, expressive tail sway, rare sit/look-around/stretch, nut/berry nibble; randomized so it never repeats Clippy-style. *Trigger:* idle timer in `spawn_buddy`. *F:* E. *Input:* no.
- **P0 — Sleep/nap with render pause.** Curl up (furled tail, Zzz ink-wisps), drop to near-static frame so it stops redrawing — folds into the `wallpaper://paused` / idle-throttle power policy. *Trigger:* long inactivity / night. *F:* E. *Input:* no.
- **P0 — Day/Night behavior shift.** Mood + palette track scene mode. *Trigger:* `set_mode` → `state:changed`. *F:* E. *Input:* no.
- **P0 — Startled hop on nearby cast.** Squash-stretch hop + tail flick, then perk toward the bloom. *Trigger:* `cast:fire`. *F:* E. *Input:* no.
- **P1 — Scurry to bloom & sniff fresh ink.** Promote the prototype's `buddy.mode='scurry'` to Rust and aim it at the bloom origin; sniff/spin in ink-petals, then wander home. *Trigger:* `cast:fire`. *F:* M. *Input:* no.
- **P1 — Ink-scent seeking (signature canon behavior).** Drift toward "inky" things — dark UI, the magic-circle clock, the audio seal, and (read-only) the polled cursor — glancing/following at a distance; **no pointer capture**. *Trigger:* proximity/idle steering (+ optional read-only cursor poll). *F:* E. *Input:* no.
- **P1 — Ink-trail tail as a living brush.** Fading sumi-ink trail / inky footprints, fresher near ink sources; tint can lean to the visualizer hue. *Trigger:* movement (Rust deltas). *F:* M. *Input:* no.
- **P1 — Smarter navigation & seam-aware roaming.** Eased accel/decel, edge loitering, perch on/under widgets, drift toward the most-recently-active monitor, avoid the clock/seal footprints, honor the seam y-ease at any layout/DPI. *Trigger:* continuous in `spawn_buddy`. *F:* M. *Input:* no.
- **P1 — Multi-monitor roam with ink-portal crossing.** Stylize seam crossings as a small ink-circle portal (dip in one edge, emerge on the next monitor). *Trigger:* screen-edge crossing. *F:* M. *Input:* no.
- **P1 — Magic-circle clock pilgrimage.** On the hour, walk to the clock, watch the ring / boop a glyph, rarely wind it with the tail. *Trigger:* hourly tick. *F:* M. *Input:* no.
- **P1 — Visualizer-seal dance.** Bob/tail-sway to the beat, bass-hit hop when the seal is loud; lounge near it when quiet — reuses `viz:bands`. *Trigger:* `viz:bands` amplitude/beat. *F:* M. *Input:* no.
- **P1 — Ink-reservoir empathy.** Mood tracks the Rust-authoritative ink gauge: full = lively, low = sluggish/droopy + gentle glance (no nag), empty = naps. *Trigger:* ink thresholds (`state:changed`). *F:* E. *Input:* no.
- **P2 — Closing-the-circle micro-spell idle.** Rare: ink an open arc, pause, tap the closing dot → soft glyph-bloom; may nap inside a neat circle (lingers) vs a rushed one (fades). *Trigger:* rare idle roll. *F:* M. *Input:* no.
- **P2 — Seasonal / Silver-Eve / birthday reactions.** Joins the existing date eggs; on the birthday nudges/leads toward the blooming Silverwood / Hidden Page (once-a-year emotional beat). *Trigger:* `cast:season` / `cast:birthday` (`eggs.rs`). *F:* E. *Input:* no.
- **P2 — Stat/mood drift.** Cosmetic energy/affection/ink-stain drift with uptime + activity; no failure state. *Trigger:* continuous. *F:* E. *Input:* no.
- **P2 (flagship, input) — Pick-up / drag / throw with ink-mote particles.** Grab, fling, drop (inertia, throw velocity from mouse history, bounce w/ energy loss, ink-splash on settle), then scurry back. Runs on the transient interactive surface (overlay/"playpen"), which hit-tests the buddy and writes its position back to Rust. **De-risk Tauri `setIgnoreCursorEvents` toggling first** (known bug, tauri-apps/tauri#11461). Gated behind `showBrushbuddy` + a new "playful buddy" toggle. *Trigger:* mouse-down on buddy. *F:* H. *Input:* yes.
- **P2 (input) — Pet / boop reaction.** Click/hover → purr/wiggle, happy eye-close, heart ink-puff; over-petting → puff up, turn away, tail flick (canon dislike of over-petting). Opt-in, easily disabled. *Trigger:* click/hover on buddy (overlay/playpen). *F:* M. *Input:* yes.
- **P3 — Rare easter-egg antics.** Try on the user's hat, chase an ink droplet, roll in spilled ink (turns black a while), draw a tail-sigil mini ink-firework, grumpy "PuffPuff" rename gag (canon nickname it dislikes). *Trigger:* rare/hidden roll. *F:* M. *Input:* no.
- **Cross-cutting — Anti-annoyance & trust guardrails.** Never block clicks or cover active content; intermittent/randomized reactions; interactive + sound opt-in and disablable; shoo/hide + global off (`showBrushbuddy`); never phone home; single Rust-timed loop with true sleep (pause redraw, not just lower FPS). *Trigger:* design-wide. *F:* E.

**Sources.** [Brushbuddy species (Fandom)](https://witch-hat-atelier.fandom.com/wiki/Brushbuddy_(Species)) · [Official anime character page](https://tongari-anime.com/en/character/detail/?chara=08) · [Game Rant (mascot role)](https://gamerant.com/witch-hat-atelier-brushbuddy-popularity-explained/) · [Art analysis (The Vault)](https://thevaultpublication.com/2020/03/20/the-spellbinding-art-of-witch-hat-atelier/) · [Kamome Shirahama (Wikipedia)](https://en.wikipedia.org/wiki/Kamome_Shirahama) · [ANN creator interview](https://www.animenewsnetwork.com/interview/2024-11-06/how-witch-hat-atelier-manga-creator-made-magic-for-everyone/.217078) · [Magic glyph guide (AniFlixy)](https://aniflixy.com/how-to-draw-spells-in-witch-hat-atelier-guide-to-magic-glyphs-and-symbols/) · [Desktop-pet lessons (WindowPet)](https://github.com/SeakMengs/WindowPet) · [Tauri setIgnoreCursorEvents bug](https://github.com/tauri-apps/tauri/issues/11461)

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
- **Cursed-misfire → Petrification fidelity pass (post-v1 polish; research-grounded 2026-06-21).** The shipped misfire (commit `aa2eb92`: corrupted grey-violet bloom + smooth grey radial wash + 9 straight radial cracks + grey motes) reads as a generic cracked-phone-screen, *not* Witch Hat Atelier. **Canon:** WHA petrification is **CRYSTAL, not grey stone** — the Ch.1 forbidden seal (earth sigil + time-stop + column/bend/dispersion/region signs) makes "crystal-shaped stones erupt" in fast waves of "blue, prismatic, frozen-solid glitter," flash-freezing the victim mid-pose (Coco's mother, lantern still raised); the **time-stop** makes it read *eternal and STILL*, and the dread comes from a warm/soft home turning instantly to cold beautiful crystal. Forbidden magic is signalled by a **darkening (white→black) palette** + an over-dense, broken/gapped seal — not a separate "evil ink." **Rework (keep the Rust-decided ~13% roll: harmless, transient, overlay-only, recede-to-clean):**
  - *Geometry:* replace the radial gradient + straight cracks with a **faceted crystalline eruption** — convex polygon shards nucleating off existing edges from the seal outward (Voronoi/L-system fracture), bigger/denser at center, jagged sparse frontier (the "dispersion" sign); **no uniform circle, no pie-slice cracks**.
  - *Render as ink-art:* outline each facet in a near-black dip-pen line (#1b1714) + short **parallel hatching** in the crevices (WHA's engraving signature) + chalky crystal catch-light rims (#b9b2a4→#d9d2c2); stone body cool parchment-grey (#6f6a63→#514c46→#2c2925), fully transparent between facets so the art shows through.
  - *Corruption tint* muted + sparing (ignition flash + thin seam glints only): low-chroma stone-violet (#5b5266/#6c6478) + drained cold-amber seam glow (#8a7a52→#4a4030) — never neon.
  - *Motion (4 beats, ~1.8–2.4s total):* **Ignition** (~180ms cold spark; the bloom curdles faster/colder to stone) → **Spread** (~700–900ms arrhythmic facet march, optionally **eating the drawn glyph** first) → **Frozen hold** (~500–700ms, absolutely STILL — the time-stop beat that sells it) → **Crumble-recede** (facets fracture into warm stone-dust motes #8d877c, ink line lightens last, clean slate returns from the frontier inward).
  - *Restraint:* **drop the continuous jitter** (stillness is more canon AND safer); single soft ramps, ≤3 Hz flashing per the photosensitivity rule; mode-aware palette (lighter body/darker line in day; darker body/more-visible violet seam in night); cap facets (~60–80) for the WorkerW WebView2 host; degrade to a single-layer faceted overlay (skip per-facet hatching) on constrained/secondary monitors; keep the gentle lore-framed toast.
  - *Files:* `src/overlay.ts` (`petrify()` + the `corrupt` branch of `bloom()`), harmonized with `src/atelier/palette.ts`. *Sources:* Fandom/Telepedia *Petrification* + *Crystal Shard* + *Forbidden Magic*; AniFlixy Ch.1 analysis; Shirahama (dip-pen) + WHA (hatching) on Wikipedia.
- **Bird decorative-sigil → conjured-bird fidelity pass (post-v1 polish; research-grounded 2026-06-21).** The shipped bird (commit `df4e192`: a single dark 2-quadratic-arc seagull + teal drop-shadow, sine flap + sine drift-up, ~5s, on the bloom canvas) reads as a generic gull, not a WHA conjuration. **Canon:** decorative sigils manifest magic in the drawn object's shape (Sword/Crystal/Smoke/Owlcat-head sigils; Agott conjures a "glowy bird"/Bird of Light) — a conjured bird is the magic given a momentary body of glowing conjuring-ink/light (gold + midnight-blue), **born from an ink stroke**, gliding with quiet grace, then **dissolving back into ink**; the franchise is "magic is DRAWN" in analog dip-pen (Shirahama: rounded nib, etching hatching), never an energy blast. **Rework (keep it free/cosmetic + fleeting):**
  - *Brushwork:* replace the constant-width 2-arc silhouette with **tapered filled ribbons** (per-stroke width envelope ~0.6px tips → 3–4px belly) from **5–7 strokes** (head/neck, two wing leading-edges, tail fan, body) + a wobbled sumi-blob torso + 2–4 gated interior hatch strokes + faint along-stroke alpha texture (brushed, not vector).
  - *Motion:* **3 wing keyframes** (down-cupped / mid-M / up-V) interpolated; **asymmetric wingbeat** (~35% fast downstroke + 65% slow upstroke, non-sinusoidal); **flap/glide phrasing** (3–5 flaps then a 1.5–2s held glide); a **banking cubic-Bézier arc** across+up (rotate ±8–12° toward velocity, foreshorten the far wing at peak bank); bob coupled to wingbeat; **enter/exit off-canvas in flight** (~6–9s, eased).
  - *Ink:* **conjuring-on** wet-stroke reveal at entry; a short tapering **sumi ink-trail** (last ~12 points, 0.12–0.22 alpha, ~500ms decay, tinted toward the element/viz hue); **ink-mote dispersal on exit** (6–12 shrinking drifting droplets) instead of a plain fade.
  - *Palette:* warm near-black sumi body **#1A1714 (day)** / parchment-cream **#E8DEC9 (night)**; replace the teal shadow with a faint warm-paper offset **#6B5E4A ~0.10** (day) / gold glow-ink accent (night); trail/motes lerp 25–40% toward the element hue, body stays ink.
  - *Restraint:* keep it **rare/fleeting** (not a tight loop) so it stays "quiet wonder"; no strobe (gold accent ≤1Hz breathe); per-monitor budget (precompute keyframes/ribbons, cap trail ~12 + motes ~12, prefer an offscreen sprite stamped per frame); degrade to a clean tapered silhouette when small/busy; honor prefers-reduced-motion; never obscure icons.
  - *Files:* `src/wallpaper.ts` (`startBird()`/`drawBird()`), harmonized with `src/atelier/palette.ts`. *Sources:* Telepedia *Decorative Sigils* + *Conjuring Ink*; Fandom *Magic*; Geekiary (Agott's "glowy bird"); Shirahama/WHA (dip-pen + hatching) on Wikipedia.
- **Point-accurate cast-bloom placement** — v1 blooms centered per-monitor; forwarding the exact cast point through the DPI/origin transform is a later enhancement.
- **Pentacle-of-Proving achievement track / hat customization** — larger meta-progression, out of scope.
- **More than 4 monitors** — the config-window pool caps at 4 (`wallpaper-0..3`); documented limit, not a regression.
- **Span/duplicate wallpaper modes** — one window per monitor only; a later toggle.
- **Auto-update** — skipped (Tauri updater can't auth private GitHub release assets); ship a one-off installer.
- **Code signing** — unsigned is acceptable (self-signed == unsigned for SmartScreen, EV no longer bypasses it); recipient clicks "Run anyway" once.
- **Shared-memory audio IPC ring** — documented escalation only; the 45 Hz JSON event path is the v1 shipping path, gated behind a real profile.
- **Audible generative ambience** — the generative pad's master gain stays muted in the wallpaper windows for v1 (only its numeric `bands()` output is used).
