// core/level-seed.js — idempotent level-seeding.
// Ensures level.stamps is initialized; everything else is user-authored.

export function seedEasterEgg(level) {
  if (!Array.isArray(level.objects)) level.objects = [];
  level.stamps = level.stamps || [];   // users author their own
  return level;
}
