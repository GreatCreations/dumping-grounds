// core/narration-fonts.js — Curated list of comic-style fonts used in
// narration boxes. Permanent Marker is the default. Comic Sans MS is
// an OS-installed alternative kept on the list; the rest are Google
// Fonts loaded via <link> in index.html and preview.html.
//
// Order matters: the FIRST entry is the default in font dropdowns
// (Permanent Marker), followed by Comic Sans MS for users who want
// the safer alternative, then alphabetical. More fonts can be added
// by appending here AND adding the URL to the fontUrl below; remove
// a font by deleting both entries.
//
// NARRATION_DEFAULT_FONT is the canonical default literal — import
// it everywhere instead of hardcoding the string so changing the
// default later is a one-file edit.

export const NARRATION_DEFAULT_FONT = 'Permanent Marker';

export const NARRATION_FONTS = [
  'Permanent Marker',
  'Comic Sans MS',
  'Bangers',
  'Bowlby One',
  'Caveat',
  'Cherry Cream Soda',
  'Coming Soon',
  'Crafty Girls',
  'Fredoka One',
  'Gloria Hallelujah',
  'Homemade Apple',
  'Indie Flower',
  'Just Another Hand',
  'Lobster',
  'Patrick Hand',
  'Reenie Beanie',
  'Schoolbell',
  'Shadows Into Light',
  'Special Elite',
  'Walter Turncoat',
];

// Comma-separated Google Fonts URL fragment. Used in index.html /
// preview.html so the browser loads them all in one request. Comic
// Sans MS is OS-installed, not in this list.
export const NARRATION_FONTS_GOOGLE_URL =
  'https://fonts.googleapis.com/css2?' +
  NARRATION_FONTS
    .filter(f => f !== 'Comic Sans MS')
    .map(f => `family=${f.replace(/ /g, '+')}`)
    .join('&') +
  '&display=swap';
