// core/input/touch.js — touch provider with on-screen virtual joystick.
//
// Two zones split vertically:
//   - Left half: virtual stick that drives MOVE_FORWARD_AXIS + MOVE_RIGHT_AXIS
//   - Right half: drag to LOOK_YAW + LOOK_PITCH
// Tap a "jump" button (rendered on first touchstart) for JUMP.
//
// Stick UI is rendered procedurally — no extra DOM beyond what's needed.

import { ACTIONS } from './bindings.js';

let _emit = null;
let _stickEl = null;
let _stickActive = false;
let _stickCenter = null;
let _stickTouchId = null;
let _lookTouchId = null;
let _lookLast = null;

export const touchProvider = {
  start(emit) {
    if (!('ontouchstart' in window)) return;     // no touch capability → nothing to do
    _emit = emit;
    _stickEl = createStickEl();
    document.body.appendChild(_stickEl);

    window.addEventListener('touchstart', onStart, { passive: false });
    window.addEventListener('touchmove',  onMove,  { passive: false });
    window.addEventListener('touchend',   onEnd);
    window.addEventListener('touchcancel',onEnd);
  },
  stop() {
    window.removeEventListener('touchstart', onStart);
    window.removeEventListener('touchmove',  onMove);
    window.removeEventListener('touchend',   onEnd);
    window.removeEventListener('touchcancel',onEnd);
    _stickEl?.remove();
  },
};

function createStickEl() {
  const el = document.createElement('div');
  el.style.cssText = `
    position: fixed; left: 24px; bottom: 24px;
    width: 100px; height: 100px;
    border: 1px solid #0b0d14; border-radius: 50%;
    background: rgba(255,255,255,0.4);
    pointer-events: none; z-index: 50;
    display: none;`;
  return el;
}

function onStart(ev) {
  for (const t of ev.changedTouches) {
    const half = window.innerWidth / 2;
    if (t.clientX < half && _stickTouchId === null) {
      _stickTouchId = t.identifier;
      _stickCenter = { x: t.clientX, y: t.clientY };
      _stickActive = true;
      _stickEl.style.left = `${t.clientX - 50}px`;
      _stickEl.style.top  = `${t.clientY - 50}px`;
      _stickEl.style.display = 'block';
    } else if (t.clientX >= half && _lookTouchId === null) {
      _lookTouchId = t.identifier;
      _lookLast = { x: t.clientX, y: t.clientY };
    }
  }
}

function onMove(ev) {
  for (const t of ev.changedTouches) {
    if (t.identifier === _stickTouchId) {
      const dx = t.clientX - _stickCenter.x;
      const dy = t.clientY - _stickCenter.y;
      const limit = 50;
      const m = Math.min(1, Math.hypot(dx, dy) / limit);
      const ang = Math.atan2(dy, dx);
      _emit(ACTIONS.MOVE_FORWARD_AXIS, -Math.sin(ang) * m * 0 + (-dy / limit));
      _emit(ACTIONS.MOVE_RIGHT_AXIS,   dx / limit);
    } else if (t.identifier === _lookTouchId) {
      _emit(ACTIONS.LOOK_YAW,   -(t.clientX - _lookLast.x) * 0.005);
      _emit(ACTIONS.LOOK_PITCH, -(t.clientY - _lookLast.y) * 0.005);
      _lookLast = { x: t.clientX, y: t.clientY };
    }
  }
}

function onEnd(ev) {
  for (const t of ev.changedTouches) {
    if (t.identifier === _stickTouchId) {
      _stickTouchId = null;
      _stickActive = false;
      _stickEl.style.display = 'none';
      _emit(ACTIONS.MOVE_FORWARD_AXIS, 0);
      _emit(ACTIONS.MOVE_RIGHT_AXIS, 0);
    } else if (t.identifier === _lookTouchId) {
      _lookTouchId = null;
    }
  }
}
