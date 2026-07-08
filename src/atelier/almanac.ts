// The Almanac of Small Spells: one line a day in the wallpaper's top strip, picked
// deterministically from the date (no network, no state, no Rust). Pure + unit-tested
// like palette.ts.
//
// The lines are drawn from Witch Hat Atelier itself (Kamome Shirahama; volume noted),
// with the atelier's own tagline folded in. GIVER'S NOTE: salt this list freely with
// private lines in her voice — the pick is index-stable per date, so editing the list
// only reshuffles which day shows which line.

export const ALMANAC_LINES: readonly string[] = [
  "Understanding opens the way to mastery.", // Vol. 1
  "One's ideas are just as crucial to magic as one's skill with the pen.", // Vol. 2
  "There is no greater teacher than life itself.", // Vol. 2
  "Everyone's unsteady when first using a new tool.", // Vol. 1
  "Soon you'll be full of confidence, bounding as you please.", // Vol. 1
  "Teachings cannot take root if they fail to captivate the student.", // Vol. 6 — Beldaruit the Wise
  "Loveliness is the sustenance of life!", // Vol. 6
  "Ask what you can do to make it work. That's a big step forward.", // Vol. 6 (lightly compressed)
  "Magic exists to make people happy.",
  "Being upset when you're not able to do something is normal. That's what motivates you to grow.",
  "Hands that handle new tools are always clumsy.",
  "Even the greatest of witches is helpless in the grip of a fluffy bed…", // Vol. 2
  "Magic is not spoken here — it is drawn.", // the Atelier's own line
];

/** 1-based day of the year for a local date (Jan 1 → 1). Computed from calendar
 * fields — NOT epoch differences, which shift by an hour across DST and would
 * change the day's line at ~1 a.m. */
const MONTH_DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
export function dayOfYear(d: Date): number {
  const y = d.getFullYear();
  const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  let n = d.getDate();
  for (let m = 0; m < d.getMonth(); m++) n += MONTH_DAYS[m] + (m === 1 && leap ? 1 : 0);
  return n;
}

/** The day's almanac line: date-hashed, stable all day, advancing one line per day.
 * Uses a continuous serial day number (days since the epoch) from LOCAL calendar fields
 * via Date.UTC — DST-proof (stable regardless of local clock time) AND monotonic across
 * the year boundary, where year*1000 + dayOfYear would jump ~636 and step the line
 * backward on Jan 1. */
export function pickLine(d: Date, lines: readonly string[] = ALMANAC_LINES): string {
  if (!lines.length) return "";
  const serial = Math.round(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 86_400_000);
  return lines[((serial % lines.length) + lines.length) % lines.length];
}
