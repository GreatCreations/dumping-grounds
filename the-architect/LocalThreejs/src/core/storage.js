// src/core/storage.js — game-mode shim. Replaces the editor's storage
// layer with an in-memory + localStorage one so the bundled game can
// run from file:// with no HTTP server.

import { GAME_LEVEL, GAME_SLUG } from './embedded-level.js';

const PAINT_KEY = `v3d.game.${GAME_SLUG}.paint`;

export async function load(slug = GAME_SLUG) {
  const level = JSON.parse(JSON.stringify(GAME_LEVEL));
  // Game-instance default: crosshair ON in first-person regardless of what
  // the editor saved. Player can toggle off with X at runtime.
  if (level?.hud?.crosshair) level.hud.crosshair.enabled = true;
  return level;
}

export async function save() { /* read-only */ }

export async function loadPaint(slug = GAME_SLUG) {
  try {
    const s = localStorage.getItem(PAINT_KEY);
    if (!s) return null;
    return JSON.parse(s);
  } catch { return null; }
}

export async function savePaint(slug, sidecar) {
  try {
    localStorage.setItem(PAINT_KEY, JSON.stringify(sidecar));
    return true;
  } catch { return false; }
}

export function clearPaint() {
  try { localStorage.removeItem(PAINT_KEY); } catch {}
}

export async function loadStamp()   { return null; }
export async function loadList()    { return []; }
export async function saveBinary()  { return false; }
export async function listVersions(){ return []; }
export async function loadVersion() { return null; }
