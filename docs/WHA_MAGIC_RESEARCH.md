# Witch Hat Atelier magic system — canon vs. the app's sigils

> Research reference (deep-research harness, 18 adversarially-verified claims). Goal: how
> to bring the app's on-screen sigils closer to *Witch Hat Atelier* canon. **Findings lean
> on fan wikis + reputable analyses + one Shirahama interview** — consistent across
> independent sources, but a wiki is not the primary text. Verify anything load-bearing
> against the volumes before shipping lore.

## Headline (the crux)

**The app's △/▽/○/□ elemental triangles are a _substitution_, not canon** — WHA does not use
the classical alchemical element symbols; it uses its own bespoke, ornate glyph vocabulary.
**But the _structure_ the app enforces is remarkably canon-accurate** (central element sigil
inside a ring you close to cast). So the fidelity gap is entirely in *how the sigils look and
are named*, not in *how casting works* — the cheap kind of gap to close.

## Verified findings

- **Magic is drawn, not spoken — the core premise is dead-on.** Shirahama chose drawing
  because it's "easy to understand" and copyable; witches "make magic by drawing patterns in
  enchanted ink"; magic is "a physical craft executed by drawing precise geometric ink
  circles called magic crests," castable by anyone with the tools.
- **A valid seal has THREE named parts — the app renders only two.** Glyph = **Sigil**
  (center; defines the element/outcome) + **Signs / Keystones** (drawn *around* the sigil; set
  effect, form, size, direction) + the **Ring** (outer boundary that completes + activates it).
  The app has the Sigil and the Ring but **no Signs/Keystones** — the one missing canon layer.
- **"Close the ring to cast" is verbatim canon.** A spell "only activates if its ring is
  complete," and you can *prepare* one by leaving a gap to fill later. The app's
  close-the-ring-to-cast **and** gap-as-prepared-seal (dot-to-ignite) mechanics are both
  directly canonical — the strongest fidelity asset.
- **The four elements ARE canon as a model — but as bespoke glyphs.** Fire/water/earth/wind
  are the named "**primary tetrad**" (ch. 5), each its own glyph (炎の紋 *honō no mon* fire,
  水の紋 water, …) at the seal's center. The four-element inner-glyph model is right; only the
  *shapes* are substituted.
- **Light is canonically a _fire variant_** (Olruggio, ch. 29) — "technically a variant of
  fire magic, but distinct enough to get its own category." The secret ✦ fifth is legitimate
  but fire-adjacent.
- **Named spells = element sigil + modifying keystones.** *Bird of Light Beacon* = a central
  **light** sigil + a "dispersion keystone" + "bird keystones." (Canon's conjured bird is
  light-based; the app's bird egg comes from ○ wind + a dot.)
- **Shirahama's style = Art Nouveau + runic circles.** Panel frames literally take "the shape
  of… runic circles"; ornate concentric ringwork is the visual target.
- **The body taboo has exactly one exception.** Magic drawn on/affecting the human body is
  outlawed *except the memory-wipe spell* (Day of the Pact). The app's harmless-petrification
  respects this — and the deferred **"clear history = memory-wipe"** idea is the single
  canon-sanctioned body magic, i.e. the most canon-grounded egg on the backlog.
- **The fudemushi is exact.** フデムシ = *fude* (inkbrush) + *mushi* (bug); "attracted to the
  scent of magical ink" — a hook for buddy behavior.

## What the app already gets right

Magic-is-drawn · seal = center-sigil-inside-a-ring · **close-the-ring-to-cast** ·
gap-as-prepared-seal · four-element tetrad · a distinct light/fifth · body taboo / harmless
misfires · the fudemushi. Most of the system, canon-correct.

## Recommendations

### (a) Presentation / lore — cheap, NO recognizer changes (favored)

Keep the four hand-drawable shapes and the parity-tested `recognizer.rs` **untouched**; change
only what is *rendered* and *named*.

1. **Add the missing "keystones" layer to the bloom render** (`startBloom`, canvas): small
   decorative marks at cardinal points *around* the central glyph, inside the ring → the
   canonical three-part **Sigil + Signs + Ring**. Pure rendering; big fidelity-per-pixel.
2. **Frame the bloom/HUD sigil in an ornate Art-Nouveau magic-circle** (concentric fine rings
   + radial ticks + the keystone marks). Enriches the existing bloom rings; respect the ≤3 Hz
   / gentle-easing photosensitivity clamps.
3. **Surface "close the ring" as canon** in the casting nudge / Tower of Tomes — one lore line
   ("a seal fires only when its ring is closed") makes the mechanic feel authentic and teaches
   the gesture.
4. **Adopt canon vocabulary** in the HUD/lore: **Sigil / Signs / Ring**.
5. **Fudemushi drawn to ink:** have the buddy drift toward a fresh cast / spell-ember for a
   moment (uses existing ember/cast hooks) — canon-grounded behavior.
6. **Frame the settings-reset as the memory-wipe** (deferred backlog egg) — the one sanctioned
   body magic.
7. *Optional:* tint the ✦ light bloom toward fire's warm palette; and/or tie the conjured bird
   to light (✦) rather than wind, matching *Bird of Light Beacon*.

### (b) Changing the recognized shapes — expensive (recommend against)

Replacing △/▽/○/□ with bespoke canon glyphs would require regenerating the golden corpus and
re-proving `recognizer.rs` parity (the fragile, off-limits path) AND hurt usability (real WHA
glyphs aren't reliably hand-drawable/recognizable). **Middle path:** keep the four simple
shapes as the *recognized input* but render the ornate canon seal — i.e. recommendation (a).

## Not firmly sourced (verify against the volumes)

Specific **ink colors**, the **philosopher's-stone origin**, and **"Silverwood ink"** were not
strongly corroborated by the harness — treat as unconfirmed.

## Sources

- [Fandom — Magic](https://witch-hat-atelier.fandom.com/wiki/Magic) ·
  [Spells](https://witch-hat-atelier.fandom.com/wiki/Spells) ·
  [Forbidden Magic](https://witch-hat-atelier.fandom.com/wiki/Forbidden_Magic) ·
  [Bird of Light Beacon](https://witch-hat-atelier.fandom.com/wiki/Bird_of_Light_Beacon) ·
  [Flying Puppet of Diversion](https://witch-hat-atelier.fandom.com/wiki/Flying_Puppet_of_Diversion) ·
  [Brushbuddy (Species)](https://witch-hat-atelier.fandom.com/wiki/Brushbuddy_(Species))
- [Telepedia — Sigils Explained](https://witchhatatelier.telepedia.net/wiki/Sigils_Explained)
- [GameRant — magic system explained](https://gamerant.com/witch-hat-atelier-magic-system-explained/)
- [FandomWire — magic glyphs](https://fandomwire.com/witch-hat-atelier-power-system-explained-what-are-magic-glyphs-how-do-they-work/) ·
  [forbidden spells](https://fandomwire.com/all-known-forbidden-spells-in-witch-hat-atelier-explained/)
- [The Comics Journal — the work of art](https://www.tcj.com/witch-hat-atelier-the-work-of-art/)
- [Anitrendz — Kamome Shirahama interview](https://www.anitrendz.com/news/2024/07/03/interview-witch-hat-ateliers-kamome-shirahama-muses-on-her-love-of-fantasy-fairy-tales-antiques)
