import { bands as genBands, type Bands } from "./generative";

// Visualizer source switch: generative (default) vs attuned (real WASAPI loopback
// bands pushed from Rust at ~45 Hz). HARD INVARIANT: the render loop calls
// currentBands() every frame and never depends on the audio thread existing — if
// capture stops/fails, `attuned` flips false and we transparently return the
// generative signal.

export interface BandFrameMsg { bands: number[]; loudness: number; beat: boolean; source: number; seq: number }

let attuned = false;
let frame: number[] = [0, 0, 0, 0, 0, 0, 0, 0];
let loud = 0;
let pendingBeat = false;
let lastSeq = -1;

export function onBandFrame(f: BandFrameMsg) {
  if (f.seq <= lastSeq && lastSeq - f.seq < 1000) return; // drop stale/dup frames
  lastSeq = f.seq;
  frame = f.bands;
  loud = f.loudness;
  if (f.beat) pendingBeat = true;
  attuned = true;
}

export function setAttuned(on: boolean) {
  attuned = on;
  if (!on) { frame = [0, 0, 0, 0, 0, 0, 0, 0]; loud = 0; pendingBeat = false; }
}

export function isAttuned(): boolean { return attuned; }
export function loudness(): number { return attuned ? loud : 0; }

/** Current bands for this frame: real (attuned) or generative. */
export function currentBands(t: number): Bands {
  return attuned ? { bass: frame[0], mid: frame[1], high: frame[2] } : genBands(t);
}

/** Consume a pending real-audio beat (onset) for this frame. */
export function takeBeat(): boolean { const b = pendingBeat; pendingBeat = false; return b; }

/** Pace 0..1 carried in the spare bands[3] slot (14.2): the seal's rotation/ripple
 * cadence follows it when attuned. Generative stays at the calm default (~unchanged
 * look). */
export function currentTempo(): number {
  return attuned ? (frame[3] || 0.35) : 0.35;
}
