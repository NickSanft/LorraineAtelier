// Pure synthetic audio-band generation. Takes time explicitly (no module state)
// so it is deterministic and testable. This is the golden definition Phase 6's
// real WASAPI bands will be reconciled against. Math identical to the original.

export interface Bands {
  bass: number;
  mid: number;
  high: number;
}

/**
 * Given time in milliseconds, return synthetic audio band magnitudes.
 * Deterministic and side-effect free.
 */
export function bands(t: number): Bands {
  return {
    bass: 0.18 + 0.12 * Math.sin(t * 0.0011) + 0.05 * Math.sin(t * 0.0007),
    mid: 0.14 + 0.1 * Math.sin(t * 0.0017 + 1),
    high: 0.08 + 0.07 * Math.sin(t * 0.0029 + 2),
  };
}
