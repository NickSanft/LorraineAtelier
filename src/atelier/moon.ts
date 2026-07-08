// Moonline: the real lunar phase from pure date math — no network, no deps, no state.
// Epoch anchor: the new moon of 2000-01-06 18:14 UTC; mean synodic month 29.530589 days.
// A mean-cycle approximation is accurate to a few hours over decades — plenty for an
// inked almanac ornament. Pure + unit-tested like palette.ts.

export const SYNODIC_DAYS = 29.530588853;
const EPOCH_NEW_MOON_MS = Date.UTC(2000, 0, 6, 18, 14);

/** Moon phase 0..1: 0 = new, 0.25 = first quarter, 0.5 = full, 0.75 = last quarter. */
export function moonPhase(d: Date): number {
  const days = (d.getTime() - EPOCH_NEW_MOON_MS) / 86_400_000;
  const p = (days / SYNODIC_DAYS) % 1;
  return p < 0 ? p + 1 : p;
}

/** Illuminated fraction 0..1 for a phase (0 = new → 1 = full). */
export function moonIllumination(phase: number): number {
  return (1 - Math.cos(phase * 2 * Math.PI)) / 2;
}
