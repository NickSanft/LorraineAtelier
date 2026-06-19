# Handoff: Witch Hat Atelier — Live Desktop App

## Overview
A Witch-Hat-Atelier-themed desktop experience: a **live wallpaper** with an **audio
visualizer**, **light/dark (day/night) mode**, and a **draw-to-cast spell system** that
launches desktop apps. The core conceit of the manga — *magic is drawn, not spoken* — is
the interaction model: you inscribe a seal (a central **sigil** + an enclosing **ring**) on
a canvas, and closing the ring "fires" the spell, which launches the bound application.

The prototype also ships three discoverable easter eggs: an idle **brushbuddy** companion, a
**reversed-sign "juts sideways"** gag, a rare **cursed-ink misfire**, and a hidden
**secret glyph** that opens a personalizable storybook page.

## About the Design Files
The files in this bundle are **design references created in HTML/Canvas/JS** — a working
prototype that demonstrates the intended look, motion, and interaction. They are **not
production code to ship directly.**

Your task is to **recreate this experience in a real desktop shell.** Because the design is
a "live wallpaper that launches native apps," it needs a shell that can (a) render a window
behind/over the desktop and (b) spawn OS processes:
- **Recommended:** Electron or Tauri (the existing HTML/Canvas/Web-Audio port over almost
  directly into a WebView; native app-launch happens through the shell's process API).
- **Alternatives:** WPF/WinUI (C#), a Wallpaper-Engine-style native renderer, etc. — in which
  case treat the HTML as a visual+behavioral spec and rebuild with native primitives.

The "launch Steam/Discord" actions are **simulated with on-screen toasts** in the prototype.
In a real shell, wire the cast result to a process launcher (e.g. Electron
`shell.openPath` / `child_process.spawn`, Tauri `Command`, or `start`/`open` shell-outs),
with a **user-editable sigil→app mapping**.

## Fidelity
**High-fidelity.** Final colors, typography, spacing, motion, and the full recognition
algorithm are all implemented. Recreate the UI and behavior faithfully; exact tokens and the
recognition spec are documented below. (Canvas-drawn layers — ink strokes, the visualizer
seal, ambient particles — do not appear in the PNG screenshots due to a capture-engine
limitation; open `Atelier.dc.html` in a browser to see them live.)

---

## How to run the prototype
Open **`Atelier.dc.html`** directly in a modern browser (Chrome/Edge/Safari). It loads
`support.js` (the lightweight component runtime) and `assets/wallpaper.webp` via relative
paths — keep the folder structure intact. No build step, no network beyond Google Fonts
(Cinzel + EB Garamond).

The single source file is authored as a "Design Component": markup + a `class Component`
logic block. All UI is inline-styled; all live behavior (canvas drawing, Web Audio, the rAF
loops, recognition) lives in the logic class. Read `Atelier.dc.html` top-to-bottom — it is
the spec.

---

## Screens / Views

### 1. Desktop (resting) — `screenshots/01-desktop-day.png`, `02-desktop-night.png`
The always-on home surface.
- **Layout:** full-viewport (`position:fixed; inset:0`), z-layered:
  1. Wallpaper `<img>` (object-fit:cover) — `assets/wallpaper.webp`.
  2. Mode **tint** overlay (`mix-blend-mode:multiply`) — warm wash (day) / deep plum-indigo (night).
  3. **Glow** layer — radial teal/gold, `mix-blend-mode:screen`, opacity driven by audio bass.
  4. **Ambient** canvas — drifting ink motes + occasional gold sparks (full-screen, pointer-none).
  5. Vignette gradient.
  6. UI widgets (below).
  7. Brushbuddy sprite.
- **Top strip** (48px): left = `とんがり帽子のアトリエ` (EB Garamond 18px) + `ATELIER`
  (Cinzel 11px, letter-spacing .34em, uppercase). Right = `✦ N / 4 glyphs inscribed`
  (Cinzel 10.5px). Pointer-events:none.
- **Clock magic-circle** (top-left, 286×286): two counter-rotating ornamental SVG rings
  (dashed-circle "ticks", cardinal element glyphs, radial spokes) over an adaptive **halo**
  disc (radial gradient using `--c-halo`) for legibility. Center: weekday (Cinzel 11px),
  time (EB Garamond 52px) + AM/PM (Cinzel 15px gold), date (Cinzel 11px). Slow CSS rotation
  (`@keyframes wha-spin` 90–120s, `wha-spin-rev` 60–80s).
- **Visualizer seal** (left, ~300×300): a `<canvas>` rendering the ink-flow seal (see
  "Audio Visualizer"), with an outer dashed SVG ring and a "Attune / Resonance" play toggle
  pill beneath it.
- **Witch's-belt dock** (bottom-center, flex row, gap 14px): three glass panels
  (`backdrop-filter:blur(9px)`):
  1. Ink reservoir vial (depletes per cast, refills over time) + 4 spell vials
     (glyph + bound-app label; click opens casting).
  2. **Inscribe** button (gold-bordered, ⚝) — opens the casting overlay.
  3. **Tomes** (❧, opens spellbook) + **Day/Night** (☾/☀) toggle.

### 2. Casting overlay — `screenshots/03-casting-sigil.png`
Modal for drawing a spell. Scrim `rgba(8,6,14,.66)` + `backdrop-filter:blur(6px)`.
- **Slate** (520×520): dark radial-gradient ink surface, rounded 8px, gold hairline border.
  A `<canvas>` captures pointer strokes (`touch-action:none`). A faint dashed guide ring +
  phase label ("draw the sigil" / "close the ring") is rendered on it.
- **HUD** (248px column, right):
  - **Reading** card: detected sigil glyph in a ringed disc, element name + bound app,
    and a **Neatness** meter (`linear-gradient(90deg,#2fd6c6,#e8b84a)`, width = score%).
  - **Sigils** card: the 4-element legend (glyph · element · app) + the rule line
    *"Close the ring clockwise to cast — reverse it to dismiss."*
  - **Clear** / **Dismiss** buttons.
- **Two-phase flow:** phase `sigil` → draw the central glyph (classified + scored) → phase
  `ring` → draw the enclosing circle → on close, the **origami-unfold bloom** plays and the
  app "launches."

### 3. Spellbook / Tower of Tomes — `screenshots/04-spellbook.png`
Right-docked panel (380px), slides over a dim scrim.
- Header: `TOWER OF TOMES` (Cinzel) / *The Spellbook* (EB Garamond 27px) / italic subtitle.
- One row per element: ringed glyph disc, `ELEMENT SIGIL` name, italic description, bound app.
  Undiscovered elements show `✦ / ?? Undiscovered` in muted tone until first cast.
- A locked **Forbidden Page** row hints at the secret star; once found it unlocks and
  re-opens the storybook on click.
- Footer line changes with progress (and at 4/4 hints: *"Now trace the old five-point star…"*).

### 4. The Hidden Page (secret) — `screenshots/05-storybook.png`
A storybook interlude opened by the secret glyph. Aged-parchment page
(`linear-gradient(160deg,#f3ead2,#e7d9b6)`), double hairline border + corner ✦ marks +
❦/❧ flourishes, `AN INTERLUDE` / *The Hidden Page* heading, drop-cap prose, and a signature
line. **The two paragraphs are placeholder copy meant to be personalized** (a birthday note,
an in-joke, etc.).

---

## Interactions & Behavior

### Spell recognition (the core mechanic)
Implemented in the logic class; port the algorithm faithfully.
1. **Capture** pointer path as `{x,y}` points per stroke.
2. **Resample** to 64 evenly-spaced points (`$1`-style by arc length).
3. **Corner detection (turning angle):** for each point, angle between the vectors to the
   points ±3 away; mark where |angle| > 0.78 rad (~45°); cluster marks within 4 indices →
   corner count `nC`. **For closed shapes** (`gap < 0.34` of bbox diagonal) the path is first
   **rotated to start at its flattest point** so a corner sitting on the start/end seam is not
   missed (this was essential to count squares as 4, not 3).
4. **Circularity:** `circ = 4π·Area / Perimeter²`.
5. **Classify (corner-count first):**
   - `nC ≥ 5 && gap < 0.62` → **secret** glyph (pentacle/star).
   - `nC ≥ 4 && gap < 0.5` → **square** (Earth).
   - `nC === 3` → **triangle**.
   - `nC ≤ 1 && circ > 0.6` → **circle** (Wind).
   - `nC === 2` → triangle; else `circ > 0.62 ? circle : triangle`.
6. **Triangle orientation:** measure perpendicular span in 4 edge bands (top/bottom/left/right);
   the **narrowest band is the apex**. Apex up → Fire, apex down → Water, apex left/right →
   **sideways** (sets the jut-gag flag + direction).
7. **Ring analysis:** closure (`gap < 0.3`), encloses sigil centroid (point-in-polygon), and
   **signed area sign** for clockwise (cast) vs counter-clockwise (**inverse / dismiss**).
8. **Neatness score (0–100):** blend of bbox aspect (≈1), closure quality, and corner/radius
   regularity. Score gates the cast feedback tier (clean ≥70 / wavering 42–69 / sputter <42).

### Sigil → app mapping (default, make this user-editable)
| Sigil | Glyph | Element | Launches | Accent hue |
|------|-------|---------|----------|-----------|
| triangle-up   | △ | Fire  | **Steam**   | `#e8954a` |
| triangle-down | ▽ | Water | **Discord** | `#5a93f0` |
| circle        | ○ | Wind  | **Browser** | `#2fd6c6` |
| square        | □ | Earth | **Files**   | `#c79a4c` |

### Audio visualizer (ink-flow)
- **Source:** generative ambient pad via Web Audio — 4 detuned oscillators (saw + triangle)
  → lowpass biquad (LFO-modulated cutoff) → master gain (~0.09) → destination, with a chord
  that wanders every ~6.5s. An `AnalyserNode` (`fftSize 128`) feeds the visuals. Toggled by
  the Attune button (browsers require a user gesture to start audio). When off, gentle
  synthetic "bands" keep the seal breathing.
- **Bands:** bass `bins[0–4)`, mid `[4–16)`, high `[16–40)`, each normalized 0–1.
- **Mapping (canvas):** concentric rings as flowing dashes (`lineDashOffset` driven by mid),
  ink particles streaming around a ring (speed by mid, brightness by high), radial spokes
  (high), a central sigil that blooms with bass; the screen **glow** layer opacity
  `= glowMax·(0.12 + bass·0.85)` (luminescence/bloom).

### Cast feedback / activation
- **Origami-unfold bloom:** on a clean close, expanding rings + unfolding radial spokes + the
  glyph blooming, with a luminescent radial flash; rotation direction follows ring direction.
  Duration scales with neatness (1.3s clean → 1.7s sputter).
- **Reversed-sign "juts sideways":** a sideways/tilted sigil makes the bloom comically shoot
  off to the side (sinusoidal jut + wobble) before catching; aside: *"the lines tilted — X
  shot off sideways, then caught."*
- **Counter-clockwise ring = inverse:** dismisses (closes) the app instead of launching.
- **Cursed-ink misfire (~13% of clean casts):** the desktop "dries up" (root
  `filter: grayscale(.92) sepia(.32) contrast(1.06) brightness(.93)`), ~15 ink-blob splatters
  scale in across the screen, the visualizer warps; everything **self-reverts after ~2.3s**.
  Always harmless.

### Brushbuddy companion
A small ink sprite (absolutely-positioned, transform updated per rAF frame). State machine:
`wander` (random targets along the lower screen) → `drink` (after ~9s idle, walks to the ink
vial and bobs; naps after ~16s) → `scurry` (darts toward the most recent cast). Blinks
periodically; fades in on first placement. Toggleable.

### Day / Night
Toggling swaps a set of CSS custom properties on the root (chrome colors + the legibility
**halo**), retints the wallpaper overlay, adjusts the `<img>` filter (night ≈
`brightness(.58) saturate(.85)`), and switches the canvas color palette + glow strength.
Smooth 1.1s transitions.

### First-run / misc
- Welcome toast on launch addresses the user as *mono-shirazu* (lore term for "one who does
  not know").
- **Ink reservoir** depletes ~22% per cast and slowly refills — a diegetic cooldown.

---

## State Management
Component state (rebuild with your shell's state primitives):
- `mode` — `'day' | 'night'`
- `now` — Date, ticked every 1s for the clock
- `audioOn` — visualizer source running
- `casting` — casting overlay open
- `castPhase` — `'sigil' | 'ring'`
- `detected` — the matched spell object (or null)
- `score` — neatness 0–100
- `spellbookOpen`, `storybookOpen` — panel visibility
- `discovered` — `{ fire, water, wind, earth: boolean }`
- `secretFound` — boolean (unlocks the Forbidden Page)
- `ink` — reservoir 0–100
- `toast` / `toastIcon` — transient message
Imperative (non-render) state: current stroke buffer, `castStrokes`, `sigilCenter`,
`castSideways`, `curseWarp`, audio nodes, rAF handles, brushbuddy position/mode.

---

## Design Tokens

### Typography
- **Display / labels:** `Cinzel` (engraved Roman caps) — uppercase, letter-spacing .12–.42em.
- **Body / numerals / prose:** `EB Garamond` (incl. italic for asides & storybook).

### Brand palette (from the research brief)
```
--paper      #EFE6D2   parchment        --magic-teal   #2FD6C6  primary glow
--ink        #1A1B2E   conjuring ink     --magic-azure  #4A86E8  secondary glow
--wood       #6B4F3A   atelier wood      --magic-gold   #E8B84A  activation flare
--sage       #7C8B6F   environment       --robe-plum    #3A2A4D  jewel-tone robe
```

### UI theme tokens (CSS custom properties on the root; swapped on mode toggle)
| Token | Day | Night |
|------|-----|-------|
| `--c-text`   | `#241c14` | `#efe6d2` |
| `--c-soft`   | `rgba(36,28,20,.62)` | `rgba(239,230,210,.66)` |
| `--c-panel`  | `rgba(244,237,221,.74)` | `rgba(22,20,36,.6)` |
| `--c-edge`   | `rgba(120,90,58,.5)` | `rgba(232,184,74,.42)` |
| `--c-gold`   | `#9c6f2a` | `#e8b84a` |
| `--c-gold-2` | `#c79a4c` | `#f5d27e` |
| `--c-teal`   | `#1d8c80` | `#2fd6c6` |
| `--c-halo`   | `rgba(247,240,224,.72)` | `rgba(11,9,20,.62)` |

### Canvas palette (visualizer / ambient)
- **Day:** teal `#1d8c80`, gold `#b8893a`, azure `#3f6fc4`, mote `rgba(120,92,52,…)`,
  glow `rgba(180,137,58,…)`, glowMax `0.5`.
- **Night:** teal `#2fd6c6`, gold `#e8b84a`, azure `#5a93f0`, mote `rgba(120,200,190,…)`,
  glow `rgba(47,214,198,…)`, glowMax `1.0`.

### Motion
- Decorative ring rotation 60–200s linear infinite; mode transitions 1.1s ease;
  toast `wha-toast` 4.2s; cast bloom 1.3–1.7s; curse self-revert ~2.3s.

### Tweakable props (exposed in the prototype)
`initialMode` (day/night), `showBrushbuddy` (bool), `inkParticleCount` (int, default 56).

---

## Assets
- `assets/wallpaper.webp` — the key illustration used as the live wallpaper (1200×675).
  User-supplied; swap for the licensed/final art in production.
- Fonts: **Cinzel** + **EB Garamond** (Google Fonts). Self-host in production.
- All ornament (magic circles, dividers, the brushbuddy, dock glyphs) is drawn with
  inline SVG / Canvas / Unicode — no raster icon assets required.
- `RESEARCH_BRIEF.md` — the original Witch Hat Atelier research & design brief (background;
  lore, art-style references, the full easter-egg catalog, and source citations).

## Files
- `Atelier.dc.html` — the complete prototype (markup + `class Component` logic). **Primary spec.**
- `support.js` — the component runtime the prototype loads (keep alongside the HTML).
- `assets/wallpaper.webp` — wallpaper image.
- `screenshots/` — 01 desktop (day), 02 desktop (night), 03 casting overlay, 04 spellbook,
  05 the hidden page.
- `RESEARCH_BRIEF.md` — source research/brief.

## Not yet built (candidates for the real implementation)
- Native window-behind-desktop wallpaper hosting + real process launching & the editable
  sigil→app mapping UI.
- Persisting `discovered` / `secretFound` / settings across sessions.
- The forbidden-magic refusal gag (casting on the self), Petrify-a-window, Sylph-Shoes lift,
  Tartah's colorblind mode, seasonal/date glyphs, and the developer's personal secret message
  (write your own into The Hidden Page).
