// core/input/gamepad.js — Gamepad API provider.
// Polled (the Gamepad API doesn't fire events for axes). Hooked in via rAF.
//
// Standard mapping:
//   - Left stick X/Y → MOVE_RIGHT_AXIS / MOVE_FORWARD_AXIS (Y inverted)
//   - Right stick X/Y → LOOK_YAW / LOOK_PITCH per-frame deltas
//   - Button A (0) → JUMP
//   - Button Y (3) → TOGGLE_MODE

import { ACTIONS } from './bindings.js';

const DEADZONE = 0.18;
const LOOK_SENS = 0.04;

let _emit = null;
let _running = false;
let _lastJump = false;
let _lastToggle = false;

export const gamepadProvider = {
  start(emit) {
    _emit = emit;
    _running = true;
    requestAnimationFrame(tick);
  },
  stop() { _running = false; },
};

function tick() {
  if (!_running) return;
  const pads = navigator.getGamepads?.() || [];
  for (const p of pads) {
    if (!p) continue;
    const fwd = dead(-p.axes[1]);
    const rgt = dead(p.axes[0]);
    _emit(ACTIONS.MOVE_FORWARD_AXIS, fwd);
    _emit(ACTIONS.MOVE_RIGHT_AXIS,   rgt);
    _emit(ACTIONS.LOOK_YAW,   -dead(p.axes[2]) * LOOK_SENS);
    _emit(ACTIONS.LOOK_PITCH, -dead(p.axes[3]) * LOOK_SENS);

    const jump = !!p.buttons[0]?.pressed;
    if (jump !== _lastJump) _emit(ACTIONS.JUMP, jump ? 1 : 0);
    _lastJump = jump;

    const toggle = !!p.buttons[3]?.pressed;
    if (toggle && !_lastToggle) _emit(ACTIONS.TOGGLE_MODE, 1);
    _lastToggle = toggle;
  }
  requestAnimationFrame(tick);
}

function dead(v) { return Math.abs(v) < DEADZONE ? 0 : v; }
