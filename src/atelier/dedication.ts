// Static "spellbook" content for the birthday dedication storybook — the friends' birthday
// wishes and the closing credits. Kept here (not in the Rust Gift) as compile-time gift
// content, mirroring src/atelier/almanac.ts: one findable place to edit the personal words.
// Rendered by buildBookPages in src/overlay.ts, slotted between the dedication's opening
// pages and its "with all our love" close. Display only — no persistence, no Rust round-trip.

export interface Wish {
  wish: string; // the friend's message, shown verbatim on its own parchment page
  from: string; // rendered as the attribution, "— {from}"
}

export interface Credit {
  name: string;
  role: string;
}

// Divider page that introduces the friends' section (a gentle break after the dedication).
export const WISHES_TITLE = "Words from those who love you";

// One parchment page each, in this order, after the two opening dedication pages.
export const WISHES: Wish[] = [
  { from: "Evelyn", wish: "Happy birthday Lorraine! I'm so glad to have met you, and I hope that you have the best birthday ever!" },
  { from: "Alec", wish: "There is an abundance of magic in the world, but a shortage of magical people who can recognize it. Thanks for being magical!" },
  { from: "Scobey", wish: "Every year is another level unlocked — not just older, but wiser, stronger, and better equipped for whatever quest comes next. Here's to becoming OP." },
  { from: "Taylor", wish: "You are a perfect enclosing ring — magical. Happy Birthday Lorraine!" },
  { from: "Emily", wish: "Badass women fucking rock, yes you! \u{1F44A}" },
  { from: "Mike", wish: "“If more of us valued food and cheer and song above hoarded gold, it would be a merrier world.” Tolkien. Hope you have a merry birthday filled with food, cheer, and song." },
  { from: "Alex", wish: "“They're taking the homeboys to lasertag!” — Legalize Greenleaf. I can't wait to travel another year around the sun with you (｡♡‿♡｡)" },
];

// The closing credits page.
export const CREDITS: Credit[] = [
  { name: "Evelyn", role: "Drew the idle Brushbuddy animation" },
  { name: "Nick", role: "Built the app that Claude made good" },
  { name: "Alex", role: "QA Tester" },
  { name: "Everyone else", role: "for providing birthday quotes" },
];
