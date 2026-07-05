# Gift enhancement backlog

> **Snapshot from 2026-06-23**, curated from a 7-lens ideation workflow (46 ideas → shortlist) to *elevate* an already-shipped gift before July 25. **Several of these have since shipped** (Quiet Hours, floatglow lanterns, casting self-discovery, sleep/wake resilience, and others — see `README.md` for what's actually in v1.0.0). Treat this as a historical idea list, not a live TODO. The **"deliberately skip"** section below is the durable part.

## Top picks (were the priority order)

1. **Sleep/Wake & Lock resilience** (M) — wire `WM_POWERBROADCAST` + WTS session events into the existing `ensure_attached`/`recreate_window` recovery; `SetIsVisible(false)` on lock. *The one failure mode that could ruin July 25 (blank/frozen wallpaper after sleep).* → **shipped** (`power.rs`).
2. **In-world casting self-discovery** (M) — motes coalesce into a dip-pen that auto-traces a sigil + "Magic is not spoken here — it is drawn," a few times, then suppressed after her first cast. Without it the casting feature (the heart) may go undiscovered (no manual; control window is tray-hidden). → **shipped** (cast-hint).
3. **Buddy throws the birthday party** (M) — wire the brushbuddy into the existing `check_birthday` flow (party hat, draws a banner beside the auto-bloom).
4. **Coco's picture-book dedication** (M) — reframe the storybook as a hand-bound spellbook with turning pages (canon: the manga opens with Coco copying seals into a picture book). Presentation-only; strings already in `settings.gift.paragraphs`. → **shipped** (PageFlip storybook).
5. **Pointed-Hat first-cast ceremony** (S) — first clean cast → one-time "By your own hand, the seal is sealed. Welcome to the Atelier." New `first_cast_done` flag.
6. **Photos-as-ink** (S) — giver drops local photo(s) in `public/`; a "memory" leaf reveals one stylized to sumi/parchment. Local-only.
7. **Quiet Hours** (M) — scene eases to a dim "embers" state ~22:00–07:00 off the existing 60 s `GetLocalTime` tick; comfort + free idle-GPU. → **shipped**.

## Also-good (runners-up)

Single-monitor/laptop + fractional-DPI hardening + first-paint dark guard; crash resilience (supervised thread restart + local crash log); full reduced-motion sweep through seal/ambient/glow; clean-uninstall + restore-defaults; tempo/BPM-locked seal; pre-birthday countdown ring; in-world "grimoire" help card; solar time-of-day lighting curve (L); buddy night rest cycle; floatglow lanterns at dusk (**shipped**); name-your-fudemushi.

## Still-deferred implementation items (from the dev log)

Distinct from the ideation shortlist above — these are known unfinished pieces, not new ideas:

- **Widget layout customization** — let the recipient reposition on-screen widgets per monitor (persisted layout).
- **Broader `castLog` persistence** — persist/expand the discovered-cast log beyond the current settings layer.
- **Real reversed-ring dismiss** — a counter-clockwise seal currently shows a themed bloom + toast; a best-effort `WM_CLOSE` of the focused app (R-DISMISS) is the later enhancement.
- **Brushbuddy enrichment** — tail sway, naps (with render pause), startled squash-stretch hop on `cast:fire`, ink-trail, and a white/striped skin picker (the `--buddy-*` CSS-var seam is ready).

## Deliberately SKIP before July 25 (risk / taste) — the durable guidance

- **Anything that touches the recognizer or the daily casting loop** — the canon "signs" middle phase, the stillness/modifier sign, an "L"-monogram centre-sigil (all high recognizer-fragility against the golden corpus; could silently break her everyday cast).
- **Cast sound design** (cuts against "magic is drawn"; off-by-default at best).
- **Mouse-parallax** (icon-misalign / GPU risk).
- The **long tail** of seasonal/weather/constellation flourishes (dilute focus).

Hold these for a post-birthday "new pages" wave.

## Original phased plan

Wk1 robustness + discovery (longest soak) · Wk2 emotional gems · Wk3 Quiet Hours + photos + laptop/DPI hardening · Wk4 **no new features** — harden, reduced-motion, re-cut installer, clean-machine + multi-day unattended soak (sleep/lock/reboot/birthday-spoof). Any re-cut must respect the `custom-protocol` embed rule (see `DEV_NOTES.md`).
