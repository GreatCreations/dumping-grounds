// src/game-entry.js — bundle entry. Imports the engine (which boots
// itself on import) and registers the game-mode-only key handlers
// (paint save/load, key-reference modal, branding footer toggle,
// crosshair toggle).
//
// The engine's existing pointer-lock entry (canvas click triggers
// requestPointerLock — see core/input/mouse.js) handles the click-
// to-play handoff. The HTML's #play-overlay just hides itself on
// pointer-lock-gained.

import * as storage from './core/storage.js';
import { setCrosshair } from './engine/hud.js';
import './engine/engine.js';      // boots immediately

// ---- Click-to-play / pointer-lock-loss overlay management ----
const playOverlay = document.getElementById('play-overlay');
const loadingOverlay = document.getElementById('loading-overlay');

function showOverlay()  { playOverlay && (playOverlay.style.display = 'flex'); }
function hideOverlay()  { playOverlay && (playOverlay.style.display = 'none'); }
function hideLoading()  { loadingOverlay && (loadingOverlay.style.display = 'none'); }

document.addEventListener('pointerlockchange', () => {
  if (document.pointerLockElement) hideOverlay();
  else                              showOverlay();
});

// Pointer lock must be triggered from a user gesture. The full-screen
// overlay covers the canvas (blocks canvas clicks from reaching mouse.js's
// pointer-lock listener), so the overlay handles the click directly: hide
// itself and request pointer lock on the canvas. This is the click-to-play
// handoff.
playOverlay && playOverlay.addEventListener('click', () => {
  const canvas = document.getElementById('preview-canvas');
  if (!canvas) return;
  hideOverlay();
  try { canvas.requestPointerLock?.(); } catch (e) { console.warn('[game] pointerLock request failed:', e); }
});

// Hide the loading GIF once the engine has had a tick to set up the scene.
// engine.js is responsible for status pill updates; we just want the GIF
// gone once the canvas has something to show.
setTimeout(hideLoading, 1500);

// ---- Paint persistence (Alt+P save, Alt+O purge) ----
// Engine's `state.jpegs` plus any painting sidecar is what we persist.
// We capture a SNAPSHOT of the painting layer when Alt+P is pressed.
//
// On boot, engine.js calls storage.loadPaint — our stub returns
// localStorage paint if present. So nothing extra needs to happen on
// boot for restore.
async function savePaintToLocalStorage() {
  // The engine's painting subsystem stores per-cell-per-face canvases.
  // For v1, we don't have a clean snapshot API exposed — but the
  // engine writes paint to state.jpegs as the player paints, and
  // those records ARE what loadPaint returns. So just snapshot the
  // current state's painting block and savePaint it.
  try {
    const { default: state } = await import('./core/state.js').catch(() => ({}));
    if (!state || !state.get) return false;
    const s = state.get();
    const snapshot = {
      jpegs: s?.jpegs ?? {},
      paint: s?.paint ?? null,
    };
    await storage.savePaint('the-architect', snapshot);
    flashStatus('Paint saved to local storage');
    return true;
  } catch (e) {
    console.warn('[game] savePaint failed:', e);
    return false;
  }
}

function purgePaintFromLocalStorage() {
  storage.clearPaint();
  flashStatus('Local-storage paint purged (refresh to see)');
}

// ---- Status pill flash ----
const statusEl = document.getElementById('preview-status');
function flashStatus(msg, ms = 2200) {
  if (!statusEl) return;
  const prev = statusEl.textContent;
  statusEl.textContent = msg;
  setTimeout(() => { if (statusEl.textContent === msg) statusEl.textContent = prev; }, ms);
}

// ---- Toggleable HUD elements (branding footer, crosshair, key modal) ----
const brandFooter = document.getElementById('brand-footer');
const keyModal    = document.getElementById('key-modal');

let crosshairOn = true;            // default ON
let brandOn     = true;            // default ON
let keyModalOn  = false;

function applyCrosshair() { setCrosshair(crosshairOn); }
function applyBrand()     { if (brandFooter) brandFooter.style.display = brandOn ? '' : 'none'; }
function applyKeyModal()  { if (keyModal) keyModal.style.display = keyModalOn ? 'flex' : 'none'; }

// Set initial states once engine boot has likely set crosshair.
setTimeout(() => { applyCrosshair(); applyBrand(); applyKeyModal(); }, 600);

// ---- Key handlers ----
window.addEventListener('keydown', (e) => {
  // Alt+P: save paint to localStorage
  if (e.altKey && (e.key === 'p' || e.key === 'P')) {
    e.preventDefault();
    savePaintToLocalStorage();
    return;
  }
  // Alt+O: purge localStorage paint
  if (e.altKey && (e.key === 'o' || e.key === 'O')) {
    e.preventDefault();
    purgePaintFromLocalStorage();
    return;
  }
  // X — toggle crosshair. Moved off Shift+= because the engine binds
  // Equal (=) to swatch-up via event.code (modifier-agnostic), so
  // Shift+= would fire both handlers on the same keypress.
  if ((e.key === 'x' || e.key === 'X') && !e.altKey && !e.ctrlKey && !e.metaKey) {
    e.preventDefault();
    crosshairOn = !crosshairOn;
    applyCrosshair();
    return;
  }
  // (No "'" handler — engine binds Quote to swatch-down; the footer is
  // permanent attribution and intentionally not toggleable in game.)
  // "/" — toggle key reference modal
  if (e.key === '/') {
    e.preventDefault();
    keyModalOn = !keyModalOn;
    applyKeyModal();
    return;
  }
});

// Close key modal on Escape (cleans up if it was open when pointer
// lock returned to free state)
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && keyModalOn) {
    keyModalOn = false;
    applyKeyModal();
  }
});
