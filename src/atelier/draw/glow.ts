import type { CanvasPalette } from "../palette";
import type { Bands } from "../audio/generative";

/**
 * Compute the glow element's opacity from the bass band and the palette's
 * glowMax. Returns a 3-decimal string ready for DOM style.opacity.
 * Identical to the original updateGlow() formula.
 */
export function glowOpacity(b: Bands, pal: CanvasPalette): string {
  return (pal.glowMax * (0.12 + b.bass * 0.85)).toFixed(3);
}
