# Development Notes — gotchas & audits

A running index of the non-obvious snags hit building this gift, so they aren't re-learned, plus the results of the memory-leak audit. These are **point-in-time observations** — verify file/line claims against current code before relying on them. The at-a-glance rules also live in `../CLAUDE.md`.

## Build & environment

- **`custom-protocol` embeds the frontend at compile time.** After a frontend change you must `cargo build` (or `pnpm tauri build`) to re-embed — `pnpm build` alone does not update the running exe.
- **`cargo test` clobbers the custom-protocol exe.** `cargo test`, or any `cargo build` *without* `--features custom-protocol`, overwrites `src-tauri/target/debug/lorraine-atelier.exe` with a **dev-mode** binary that loads the frontend from `http://localhost:1430`. With no Vite dev server running, every window (wallpaper, overlay, control) shows Chromium's "localhost refused to connect / ERR_CONNECTION_REFUSED". It looks like an overlay/casting bug but is just a stale build. Fix: rebuild with `cargo build --features custom-protocol --manifest-path src-tauri/Cargo.toml`, or run tests as `cargo test --features custom-protocol`.
- **The running app locks `target/debug|release/lorraine-atelier.exe`** → `cargo build`/`tauri build` fail with "Access is denied". Stop it first: `Get-Process lorraine-atelier | Stop-Process -Force`.
- **PowerShell mangles `git commit -m`** args containing embedded double-quotes or a bare `/` ("pathspec … outside repository"). Use single-quoted plain-ASCII messages, or pipe a heredoc to `git commit -F -` via the Bash tool.
- **`Get-MpPreference`** (read Defender exclusions) needs admin — otherwise returns "Must be an administrator to view exclusions".

## Frontend / UI

- **`<canvas>` is a replaced element:** CSS `inset`/box sizing alone leaves it at its intrinsic 300×150. Set explicit width/height (this caused the seal/viz "missing sigils" clipping bug).
- **StPageFlip (`page-flip` npm):** ships no TS types (needs an ambient `.d.ts`); import the ESM `page-flip.module.js`. Its cover-leaves render as stray dark pages in a spread (we dropped them for a custom CSS-3D cover); single-page/portrait flipping *past the last page* makes the book vanish (use a 2-page spread with blank versos).
- **CSS-3D book:** `perspective` on the parent + `transform-origin:left center` + `backface-visibility:hidden` (an element disappears once rotated past 90°).
- **The wallpaper webview starts at the tauri.conf default size (800×600)** and is only sized to its monitor *after* attach → any size-dependent logic (rendition pick, canvas sizing) must re-run on `resize`, not just at module load.
- **Ultrawide art:** don't edge-stretch a thin slab (ornate corners smear); extend the parchment margin with a colour-sampled gradient. `wallpaper.ts` picks a rendition by physical size **and** aspect (only true ~21:9 uses the 3440 art).

## Casting / recognizer

- **`recognizer.rs` is parity-tested** against `scripts/recognizer-oracle.mjs` via a golden corpus (`src-tauri/tests/corpus/recognizer.json`). **Do not change `recognizer.rs` without regenerating the corpus** (`pnpm dump-corpus`) and re-running `cargo test`.
- **Ring direction is counter-intuitive:** the recognizer's `ccw = area > 0` is a **clockwise** ring in screen (y-down) coords = a normal **cast**; `analyze_ring` returns `inverse = !ccw`. So **CW = cast, CCW = dismiss** (the prototype's field name is misleading; the first wiring was backwards).
- **Tauri 2 app commands** (from `generate_handler!`) are invokable from any window **without** a capability entry (capabilities gate only plugin/core commands). The overlay calls `classify_sigil`/`analyze_ring`/`fire_spell` with no capability change.

## Per-window events & foreground

- **`Any`-target listeners bypass `emit_to` filtering** — see the pattern in `../CLAUDE.md` (emit_to + payload-stamped label + `listen(..., {target: selfLabel})` + drop mismatches). `capabilities/default.json` needs `"wallpaper-*"` + `"wp-r*"` globs so wallpaper webviews may listen (labels change to `wp-r{gen}-{i}` after explorer-restart recreation).
- **Never keep an always-shown top-level WebView2 window** — it steals and holds the foreground (WebView2 programmatically calls `SetFocus`/`MoveFocus` on load; a topmost window re-wins foreground; `WS_EX_NOACTIVATE` only blocks *click* activation). A foreground-demoting watchdog just creates a tug-of-war. The overlay is hidden at rest and shown only as a focusable modal; the `w.hide()` is what truly releases the foreground.
- **Desktop-layer input** comes from a `WH_MOUSE_LL` hook, not any window. Two hooks-specific gotchas: suppressing `WM_MOUSEMOVE` **freezes the system cursor** (the move is how the cursor advances) → only suppress the button-**down**; and `GetAsyncKeyState(VK_LBUTTON)` reads the physical button and is unreliable from the hook → rely on `WM_LBUTTONUP` + a buddy-thread backstop against a stuck drag.

## Windows Defender false positive (the big one)

Full playbook: `DEFENDER_FALSE_POSITIVE.md`. Key points:

- Unsigned build flagged `Trojan:Win32/Bearfoos.B!ml` (cloud ML guess, not a signature) and quarantined; install→uninstall→reinstall just re-quarantines.
- **The locally-built exe is NOT flagged, but the downloaded + installed copy IS** — the trigger is the Mark-of-the-Web cloud lookup at install. To reproduce, stamp a copy with MOTW (`Set-Content -Path f -Stream Zone.Identifier -Value "[ZoneTransfer]`…`ZoneId=3"`); a plain local scan reads falsely clean.
- Tauri 2 **already** embeds PE version metadata (ProductName/FileDescription/CompanyName/version) from `tauri.conf.json` — verify with `(Get-Item exe).VersionInfo` before assuming it's empty. `tauri-winres` was unnecessary; only `bundle.publisher` was missing.
- Tauri's NSIS bundler patches the exe in place. Clearance is **per-SHA-256** → submit the **exact final binary** to WDSI (microsoft.com/wdsi/filesubmission, "Software developer") a few days before gifting and **don't rebuild after**. Autostart is opt-in to cut the loudest persistence signal.

## Process / communication

- **"dock" was ambiguous** once — the owner meant the control-panel *window* (boot minimized to tray), not the wallpaper witch's-belt dock. Confirm which surface before building.

## Memory-leak audit (2026-06-28)

A 16-agent audit (7 scoped finders + per-finding adversarial verification) over both surfaces. **3 confirmed leaks — all fixed 2026-06-29** (`cargo check` + `tsc -b` clean); everything else verified clean.

**Fixed**
1. `src-tauri/src/hook.rs` — `HOOK_THREAD_ID` teardown race. A fast off→on→off toggle of `desktop_interactive` could orphan a `WH_MOUSE_LL` hook + its pump thread (and compound — each cycle could install another live hook). Fixed by capturing `my_tid = GetCurrentThreadId()` and replacing the two exit-path `HOOK_THREAD_ID.store(0)` calls with `compare_exchange(my_tid, 0, …)`, so a thread only clears the slot if it still owns it.
2. `src-tauri/src/lib.rs` `rebuild_hit_rects` — `hit_rects_map` was insert-only, growing one entry per wallpaper-window recreation (explorer restart, DPI/resolution change, monitor hotplug, resume-from-sleep). Fixed with `map.retain(|label, _| labels.iter().any(|l| l == label));` (bounds the map to live slots ≤ `MAX_WALLPAPER`; also handles unplug).
3. `src/control.ts` — settings-window log buffer prepended onto `textContent` forever (the control window is hidden-not-destroyed, so it never resets). Fixed with a capped ring: `LOG_MAX = 200`, newest-first `logLines` array (unshift + `.length` truncate), rebuilt via `join`.

**Verified clean / false alarms — do not re-audit**
- Render loop is single-instance via the `loopGen` generation counter.
- Transient effect rAF loops (bloom/bird/hint/festival) are bounded ≤4 and self-terminate — a transient-GPU nuance, not a leak.
- The ~49:1 `addEventListener`:`removeEventListener` ratio is benign (rebuild paths wipe `innerHTML` first; all `listen()` are module-once).
- PageFlip storybook destroys + nulls in the same synchronous tick (no orphaned instance/listeners).
- Web Audio has **no** leak surface — the "audio" module is a pure band **visualizer** (math + a fixed 8-element array); there is no `AudioContext`/node graph.
- Rust threads/channels/listeners are all single-spawn / atomic-gated; the architecture is emit-only (zero Rust-side event listeners); the one mpsc channel is drained synchronously.

## Additional facts folded from the retired dev log (2026-07-03)

Preserved here when the long-form project-history memory was retired; a coverage audit confirmed the rest of that log was already in these docs, the code, or `mockup/RESEARCH_BRIEF.md`. Each item below was otherwise only in code.

**Build & environment**
- **Art conversion:** `public/wallpaper.webp` was made from `mockup/assets/WitchHat2560x1440.jpg` via `ffmpeg` libwebp q80 (cwebp/ImageMagick weren't installed; ffmpeg was) → ~720 KB. Per-monitor `@3440`/`@1920` renditions are the personalization step (uncomment the `RENDITIONS` lines in `wallpaper.ts`).
- **Avoid `@` in `public/` asset filenames** — it can break the Tauri asset-protocol URL; use a hyphen (hence `wallpaper-3440.jpg`, not `wallpaper@3440`).

**Frontend / UI**
- **Latent fractional-DPI buddy bug:** the brushbuddy translate offset in `wallpaper.ts` uses the Rust-supplied physical px directly as CSS px (assumes `dpr=1`). Correct on a 100%-scale setup; under fractional DPI the buddy/label is off by the scale factor. Fix by dividing `m.x`/`m.y` by `dpr`.
- **Widget sizing** is monitor-proportional via a `--ui-scale` CSS var = `clamp(innerHeight/960, 1, 2.2)` (~50% larger on a 1440p monitor). **Dock vials must be content-width** (`white-space:nowrap` + padding, never a fixed width) or long labels overlap.
- **Toggle no-op gotcha:** a control that flips a local *guess* of state can be stale, so the first click does nothing. Flip the authoritative persisted state (e.g. `toggle_mode`) and drive the label from the `settings:mode` / `viz:source-changed` broadcast — no optimistic UI.
- **Day-mode legibility** is done entirely by the `DAY_VARS` palette swap in `applyMode` (darker/near-opaque `--c-text`/`--c-panel`, solid clock halo, bold AM/PM, gold Inscribe pill over an opaque panel) so the shared widgets read over the bright artwork — there are no day-specific class rules.
- **Symbol glyphs** ⚝ ❧ ☾ ☀ aren't in Cinzel/EB Garamond and fall back to the Windows system font (verified fine). The self-hosted Cinzel + EB Garamond WOFF2 live in `public/fonts/` (~1.4 MB, 43 files).
- **Taskbar-aware layout:** `workerw::Monitor` carries `work_{x,y,w,h}` from `rcWork` (monitor minus a space-reserving taskbar; equals the full monitor when the taskbar auto-hides). Rust emits physical-px insets (monitor rect − work rect) in `BuddyMsg`; `wallpaper.ts applyInsets()` insets the whole `#root` scene (CSS px = inset/dpr) so it sits above the taskbar, refreshed on the watchdog tick.

**Casting / recognizer**
- **Misfire math (precise):** the cursed-misfire chance is symmetry-driven `0.10 + (1 − symmetry) * 0.12` (≈10% at perfect symmetry → 22% fully lopsided), gated on `score ≥ 50` and not inverse/sideways/first-cast — the "~13%" shorthand elsewhere is just the midpoint. Ink is a process `AtomicI32` starting at 78, −22 per cast, clamped to ≥ 6.
- **Casting lore basis** (full lore in `mockup/RESEARCH_BRIEF.md`): the canon seal = sigil (element) + signs (modifiers) + a ring that fires only on closure, assembled inside-out; sign geometry is semantic (tilt = spin, size = magnitude, flip/mirror = invert). That is *why* the recognizer scores size/steadiness/symmetry and treats **CW = cast / CCW = dismiss** (a flipped/reversed seal cancels). Forbidden magic = casting on the human body (memory-wipe the lone exception → the "clear history" egg hook); the cursed misfire's canon identity is a Brimmed-Cap backfire, and Petrification is the manga's opening miscast. Ink = woodcruor / conjuring ink from Silverwood.

**Audio (WASAPI)**
- **`initialize_client` must take `Direction::Capture`, not `Direction::Render`, even for a Render/loopback device** — passing `Render` makes `get_audiocaptureclient` fail with `AUDCLNT_E_WRONG_ENDPOINT_TYPE` (0x88890003). `initialize_mta()` returns an HRESULT (use `.ok().map_err(...)`).

**Foreground**
- Why the always-shown-overlay approach was abandoned, concretely: the foreground-demoting watchdog called `SetForegroundWindow`, which returned `true` but left the foreground on the overlay or dropped it to 0/limbo, and demote → limbo → Windows re-activating the topmost overlay was a self-perpetuating tug-of-war.
