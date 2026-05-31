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
function clearWaiting() { playOverlay && playOverlay.classList.remove('waiting'); }
function setWaiting()   { playOverlay && playOverlay.classList.add('waiting'); }
function hideLoading()  { loadingOverlay && (loadingOverlay.style.display = 'none'); }

document.addEventListener('pointerlockchange', () => {
  if (document.pointerLockElement) {
    // Lock acquired — drop the spinner state and hide the overlay.
    clearWaiting();
    hideOverlay();
  } else {
    // Lock lost — show overlay back in its idle "Click to Play" form.
    clearWaiting();
    showOverlay();
  }
});

// Pre-create the AudioContext on mousedown (one event earlier than click)
// so its ~100ms construction cost doesn't fall in the click→pointer-lock
// gap. Web Audio requires a user gesture, mousedown counts.
let _audioPrearmed = false;
function prearmAudio() {
  if (_audioPrearmed) return;
  _audioPrearmed = true;
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (AC) { const c = new AC(); if (c.state === 'suspended') c.resume(); }
  } catch {}
}

playOverlay && playOverlay.addEventListener('mousedown', prearmAudio);

playOverlay && playOverlay.addEventListener('click', () => {
  const canvas = document.getElementById('preview-canvas');
  if (!canvas) return;
  prearmAudio();
  // Keep the overlay visible during the browser's pointer-lock
  // acquisition window, but swap to a spinner so the gap reads as
  // "working" rather than "stuck". Cleared by pointerlockchange when
  // lock succeeds, or by the safety timeout below if it fails.
  setWaiting();
  try {
    canvas.requestPointerLock?.({ unadjustedMovement: true });
  } catch (e) {
    try { canvas.requestPointerLock?.(); } catch (e2) { console.warn('[game] pointerLock request failed:', e2); }
  }
  // Safety net: if pointer lock never fires pointerlockchange (e.g.,
  // the browser silently denies the request), restore the idle overlay
  // after 4s so the player isn't stuck staring at a spinner.
  setTimeout(() => {
    if (!document.pointerLockElement) clearWaiting();
  }, 4000);
});

// Hide the loading GIF as soon as the engine has rendered. Poll the
// V3D.debug surface (engine exposes scene + body once boot finishes)
// instead of using a fixed 1.5s timer — fast loads reach Click-to-Play
// sooner; an 800ms fallback covers cases where V3D.debug isn't ready.
let _loadingPoll;
function tryHideLoading() {
  if (window.V3D?.debug?.scene?.children?.length > 0) {
    hideLoading();
    clearInterval(_loadingPoll);
  }
}
_loadingPoll = setInterval(tryHideLoading, 50);
setTimeout(() => { clearInterval(_loadingPoll); hideLoading(); }, 800);

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

// Set initial states once engine boot has likely set crosshair. Engine
// boot is fast — 100ms is more than enough — and shorter means the
// crosshair appears closer to when the canvas first paints.
setTimeout(() => { applyCrosshair(); applyBrand(); applyKeyModal(); }, 100);

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
