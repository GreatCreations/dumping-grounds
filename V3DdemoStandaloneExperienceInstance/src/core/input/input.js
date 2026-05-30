// core/input/input.js — action registry + per-source state + per-frame snapshot.
//
// Each input source (keyboard, gamepad, touch, mouse) writes to its OWN slot
// so they don't stomp each other. The engine reads a combined snapshot once
// per frame; the combine rules live in getSnapshot().
//
// Why this matters: a gamepad that polls every frame and emits `0` on its
// analog axes would otherwise clobber the keyboard's "W is held" state every
// frame, making keyboard input look like it "fades" each tick. With slots
// kept separate, the keyboard state persists between gamepad polls and the
// snapshot sums both contributions.

import { ACTIONS } from './bindings.js';

const state = {
  // Keyboard discrete pressed-state (booleans)
  keyForward:  false,
  keyBackward: false,
  keyLeft:     false,
  keyRight:    false,
  keyJump:     false,

  // Analog axes from gamepad/touch (-1 .. 1)
  axisForward: 0,
  axisRight:   0,

  // Look accumulators (radians). Both mouse and gamepad add into these.
  yaw:   0,
  pitch: 0,

  // Edge-triggered (consumed in getSnapshot)
  _jumpEdge:   false,
  _toggleEdge: false,
};

export function emit(action, value) {
  switch (action) {
    // Keyboard discrete
    case ACTIONS.MOVE_FORWARD:
      state.keyForward = !!value;
      if (state.keyForward) state._anyMoveEdge = true;
      break;
    case ACTIONS.MOVE_BACKWARD:
      state.keyBackward = !!value;
      break;
    case ACTIONS.MOVE_LEFT:
      state.keyLeft = !!value;
      break;
    case ACTIONS.MOVE_RIGHT:
      state.keyRight = !!value;
      break;
    case ACTIONS.JUMP:
      if (value && !state.keyJump) state._jumpEdge = true;
      state.keyJump = !!value;
      break;
    case ACTIONS.TOGGLE_MODE:
      if (value) state._toggleEdge = true;
      break;
    case ACTIONS.RESET:
      if (value) state._resetEdge = true;
      break;
    case ACTIONS.CROUCH:
      // Continuous: hold to crouch, release to stand. Both C and Shift map here.
      state.crouchHeld = !!value;
      break;
    case ACTIONS.PAINT_TOGGLE:
      if (value) state._paintToggleEdge = true;
      break;
    case ACTIONS.PAINT_SWATCH_UP:    if (value) state._paintSwatchEdge = 'up';    break;
    case ACTIONS.PAINT_SWATCH_DOWN:  if (value) state._paintSwatchEdge = 'down';  break;
    case ACTIONS.PAINT_SWATCH_LEFT:  if (value) state._paintSwatchEdge = 'left';  break;
    case ACTIONS.PAINT_SWATCH_RIGHT: if (value) state._paintSwatchEdge = 'right'; break;
    case ACTIONS.PAINT_BRUSH_DOWN:   if (value) state._paintBrushEdge = 'down';   break;
    case ACTIONS.PAINT_BRUSH_UP:     if (value) state._paintBrushEdge = 'up';     break;

    // Analog from gamepad / touch
    case ACTIONS.MOVE_FORWARD_AXIS:
      state.axisForward = clampSigned(value);
      break;
    case ACTIONS.MOVE_RIGHT_AXIS:
      state.axisRight = clampSigned(value);
      break;

    // Look deltas — accumulate
    case ACTIONS.LOOK_YAW:
      state.yaw += value;
      break;
    case ACTIONS.LOOK_PITCH:
      state.pitch = clampPitch(state.pitch + value);
      break;

    default: /* unknown action */ break;
  }
}

export function getSnapshot() {
  // Combine keyboard pressed-state + analog axes. Each source can contribute
  // up to ±1, total clamped to [-1, 1] so diagonal+stick can't exceed unit.
  const keyForward = (state.keyForward ? 1 : 0) + (state.keyBackward ? -1 : 0);
  const keyRight   = (state.keyRight   ? 1 : 0) + (state.keyLeft     ? -1 : 0);
  const forward = clampSigned(keyForward + state.axisForward);
  const right   = clampSigned(keyRight   + state.axisRight);
  const snap = {
    forward,
    right,
    yaw:   state.yaw,
    pitch: state.pitch,
    jump:       state._jumpEdge,
    toggleMode: state._toggleEdge,
    reset:      state._resetEdge,
    crouch:     !!state.crouchHeld,
    paintToggle: state._paintToggleEdge,
    paintSwatch: state._paintSwatchEdge,
    paintBrush:  state._paintBrushEdge,
  };
  state._jumpEdge   = false;
  state._toggleEdge = false;
  state._resetEdge  = false;
  state._paintToggleEdge = false;
  state._paintSwatchEdge = null;
  state._paintBrushEdge  = null;
  return snap;
}

// Zero the accumulated look angles. Used by reset-to-spawn so the player's
// camera orientation returns to the spawn yaw alongside their position.
export function resetLook() {
  state.yaw = 0;
  state.pitch = 0;
}

// --- Provider registration ---
const providers = [];
export function registerProvider(provider) {
  providers.push(provider);
  if (provider.start) provider.start(emit);
}
export function startAll() {
  // Idempotent: providers that registerProvider already started skip themselves.
  for (const p of providers) if (!p._started) { p.start?.(emit); p._started = true; }
}
export function stopAll() {
  for (const p of providers) { p.stop?.(); p._started = false; }
}

function clampSigned(v) { return Math.max(-1, Math.min(1, v)); }
function clampPitch(p)  { return Math.max(-Math.PI / 2 + 0.05, Math.min(Math.PI / 2 - 0.05, p)); }
