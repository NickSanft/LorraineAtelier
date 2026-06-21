// Pure palette data + mode-agnostic helpers. NO DOM access lives here so the
// constants/logic can be unit-tested and reused by Phase 5-6. All values are
// copied verbatim from the original wallpaper.ts (behavior-preserving extraction).

export type Mode = "day" | "night";

// Day palette is tuned for legibility over the bright artwork: dark, fairly opaque
// text + strong light halos/panels behind the widgets so they read against busy,
// varied background colours.
export const DAY_VARS: Record<string, string> = {
  "--c-text": "#1f1709", "--c-soft": "rgba(28,20,10,.9)", "--c-faint": "rgba(28,20,10,.68)",
  "--c-panel": "rgba(248,242,228,.95)", "--c-panel-2": "rgba(251,246,234,.98)",
  "--c-edge": "rgba(104,76,44,.62)", "--c-gold": "#855a1f", "--c-gold-2": "#a87b2b",
  "--c-teal": "#15756a", "--c-ink": "#1f1709", "--c-halo": "rgba(253,248,238,.94)",
};

export const NIGHT_VARS: Record<string, string> = {
  "--c-text": "#efe6d2", "--c-soft": "rgba(239,230,210,.66)", "--c-faint": "rgba(239,230,210,.4)",
  "--c-panel": "rgba(22,20,36,.6)", "--c-panel-2": "rgba(22,20,36,.82)",
  "--c-edge": "rgba(232,184,74,.42)", "--c-gold": "#e8b84a", "--c-gold-2": "#f5d27e",
  "--c-teal": "#2fd6c6", "--c-ink": "#0d0b16", "--c-halo": "rgba(11,9,20,.62)",
};

// Canvas palette (distinct from the CSS vars; mote/glowColor are partial rgba prefixes).
export interface CanvasPalette {
  teal: string;
  gold: string;
  azure: string;
  ink: string;
  mote: string;      // partial rgba prefix for motes, e.g. "rgba(120,92,52,"
  glowMax: number;
  glowColor: string; // partial rgba prefix, e.g. "rgba(180,137,58,"
}

export const PAL: Record<Mode, CanvasPalette> = {
  day: { teal: "#1d8c80", gold: "#b8893a", azure: "#3f6fc4", ink: "#3a2e22", mote: "rgba(252,238,200,", glowMax: 0.95, glowColor: "rgba(245,205,120," },
  night: { teal: "#2fd6c6", gold: "#e8b84a", azure: "#5a93f0", ink: "#0d0b16", mote: "rgba(120,200,190,", glowMax: 1.0, glowColor: "rgba(47,214,198," },
};

// Central sigil cycles through the four element seals (no progression state yet).
export const SIGILS = ["triangle-up", "triangle-down", "circle", "square"] as const;
export type Sigil = (typeof SIGILS)[number];

/** CSS custom properties for a given mode (apply to the DOM root). */
export function getVarsForMode(mode: Mode): Record<string, string> {
  return mode === "night" ? NIGHT_VARS : DAY_VARS;
}

/** Wallpaper image filter for a given mode (for img.style.filter). */
export function getWallFilterForMode(mode: Mode): string {
  return mode === "night"
    ? "brightness(.58) saturate(.85) contrast(1.02)"
    : "brightness(1.02) saturate(1.02)";
}

/** Tint overlay background for a given mode (for #tint.style.background). */
export function getTintBackgroundForMode(mode: Mode): string {
  return mode === "night"
    ? "radial-gradient(125% 120% at 50% 38%, rgba(44,32,72,.55), rgba(10,8,20,.8))"
    : "radial-gradient(125% 110% at 50% 8%, rgba(232,200,140,.16), rgba(120,86,46,.22))";
}

/** Tint overlay opacity for a given mode (for #tint.style.opacity). */
export function getTintOpacityForMode(mode: Mode): string {
  return mode === "night" ? ".92" : ".5";
}
