// core/signature.js
// NINETENTWO — easter egg layers 1 + 2.
//
// Layer 1 (silent, always present): every BroadcastChannel message gets a
//   `_signed` field. Sync receivers validate it. Anyone inspecting the message
//   bus in DevTools sees the stamp.
//
// Layer 2 (console summon): typing `V3D.summon()` in DevTools reveals an
//   ASCII-art logo + a poetic message. Increments a session counter.
//
// Layer 3 (in-world): planted by Phase 8's level-creation flow as a microscopic
//   invisible object at cell A0,1. Discovered by aiming the crosshair at that
//   spot in leash mode and triggering a raycast hit. Implemented in engine/hud.
//   This file holds only the signature logic + message constants.

const SIGNATURE = 'NINETENTWO';
const BUILT = '2026'; // year the foundation was poured; not the actual build number

let _summonCount = 0;

export function signMessage(msg) {
  return { ...msg, _signed: SIGNATURE };
}

export function verifySignature(msg) {
  return msg && msg._signed === SIGNATURE;
}

// Install the global console summon. Called once from each app entry point.
// Idempotent — calling twice doesn't double-bind.
export function installConsoleSummon() {
  if (typeof window === 'undefined') return;
  if (window.V3D && window.V3D.summon) return;
  window.V3D = window.V3D || {};
  window.V3D.summon = () => {
    _summonCount++;
    /* eslint-disable no-console */
    console.log('%c╔══════════════════════════════════════╗', 'color:#2cdde7;font-family:monospace');
    console.log('%c║       N I N E T E N T W O           ║', 'color:#2cdde7;font-family:monospace;font-weight:700');
    console.log('%c║          v3d engine — alpha          ║', 'color:#2cdde7;font-family:monospace');
    console.log('%c╚══════════════════════════════════════╝', 'color:#2cdde7;font-family:monospace');
    console.log('%cyou found the seam in the world.', 'color:#fafaf7;font-style:italic');
    console.log('%cthe world is a drawing.', 'color:#fafaf7;font-style:italic');
    console.log('%c—— stamped by NINETENTWO · ' + BUILT + ' ——', 'color:#9ea3ad');
    console.log(`%cseam-finds this session: ${_summonCount}`, 'color:#6b6f7a');
    /* eslint-enable no-console */
    return SIGNATURE;
  };
  // Silent breadcrumb so a curious dev opening the console sees nothing visible
  // but knows something's there if they look. The hint shows up in `window.V3D`.
  Object.defineProperty(window.V3D, 'hint', {
    value: 'V3D.summon()',
    enumerable: false,
  });
}

// Returns the signature string for any code that wants to read it directly.
export const SIGNATURE_STRING = SIGNATURE;
