// core/audio.js — minimal Web Audio stub for the engine.
//
// One AudioContext, short tone-bursts triggered by gameplay events. No
// samples loaded; the inked-comic aesthetic gets a minimal "drawn" sound
// palette to match — clicks, pings, soft thuds.
//
// Browsers gate Web Audio behind a user gesture. We don't create the context
// until the first interaction, then keep it alive for the session.
//
// Engine hooks (in engine.js):
//   - JUMP rising-edge → sfx.jump()
//   - grounded false→true transition → sfx.land()
//   - distance walked while grounded → sfx.step() at intervals
//   - easter-egg raycast hit → sfx.egg()

let ctx = null;
let lastStepDist = 0;

function ensureCtx() {
  if (ctx) return ctx;
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return null;
  ctx = new AC();
  return ctx;
}

function tone(freq, dur, type = 'sine', gain = 0.05) {
  const c = ensureCtx();
  if (!c || c.state === 'suspended') return;
  const o = c.createOscillator();
  const g = c.createGain();
  o.type = type;
  o.frequency.value = freq;
  o.connect(g);
  g.connect(c.destination);
  // Exponential ramp avoids the click that a hard-stop creates.
  g.gain.setValueAtTime(gain, c.currentTime);
  g.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + dur);
  o.start(c.currentTime);
  o.stop(c.currentTime + dur + 0.02);
}

export const sfx = {
  jump:    () => tone(420, 0.06, 'square',   0.04),
  land:    () => tone(110, 0.12, 'triangle', 0.07),
  step:    () => tone(180, 0.03, 'triangle', 0.018),
  egg:     () => { tone(880, 0.10, 'sine', 0.04); setTimeout(() => tone(1320, 0.18, 'sine', 0.045), 70); setTimeout(() => tone(1760, 0.24, 'sine', 0.04), 180); },
  unlock:  () => tone(620, 0.08, 'sine', 0.04),
};

// Install one-shot listeners that resume the AudioContext on first user
// interaction. Must be called BEFORE the gesture (e.g., at module boot).
export function armOnUserGesture() {
  const resume = () => {
    const c = ensureCtx();
    if (c && c.state === 'suspended') c.resume();
    window.removeEventListener('pointerdown', resume);
    window.removeEventListener('keydown', resume);
  };
  window.addEventListener('pointerdown', resume, { once: false });
  window.addEventListener('keydown', resume, { once: false });
}

// Footstep cadence helper — engine passes total distance walked; this fires
// sfx.step() at ~1.5m intervals so the cadence matches the walk speed.
export function tickFootsteps(distance, grounded) {
  if (!grounded) { lastStepDist = distance; return; }
  if (distance - lastStepDist >= 1.5) {
    sfx.step();
    lastStepDist = distance;
  }
}
