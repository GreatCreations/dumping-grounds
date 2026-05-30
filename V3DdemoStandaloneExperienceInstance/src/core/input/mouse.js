// core/input/mouse.js — mouse provider with TWO modes:
//
//   LEASH mode:
//     Cursor X → player yaw RATE (accumulates). Right cursor turns the player
//                right at a rate proportional to horizontal offset. The dashbox
//                visibly rotates as the player turns.
//     Cursor Y → camera pitch OFFSET (position-based). Top of screen tilts the
//                camera up to +45°, bottom tilts down to -45°.
//     Cursor X also adds a small camera yaw OFFSET so the dashbox visibly
//                drifts off-center. Engine reads cursor fraction directly.
//
//   FIRST-PERSON mode: pointer-lock + delta-based look (classic FPS).

import { ACTIONS } from './bindings.js';

const FP_SENSITIVITY     = 0.002;
const VCURSOR_SENSITIVITY = 0.0018;   // virtual-cursor speed under pointer lock
const LEASH_YAW_RATE      = 1.5;       // radians/sec at the canvas edge
const DEADZONE            = 0.06;

let _emit = null;
let _canvas = null;
let _mode = 'leash';
let _mousePosFrac = null;
let _lastTick = 0;

export const mouseProvider = {
  start(emit) {
    _emit = emit;
    _canvas = document.getElementById('preview-canvas');
    if (!_canvas) return;

    // When NOT pointer-locked, track position directly off the canvas.
    _canvas.addEventListener('mousemove', (ev) => {
      if (document.pointerLockElement === _canvas) return;
      const r = _canvas.getBoundingClientRect();
      _mousePosFrac = {
        x: (ev.clientX - r.left) / r.width,
        y: (ev.clientY - r.top)  / r.height,
      };
    });
    _canvas.addEventListener('mouseleave', () => {
      if (document.pointerLockElement !== _canvas) _mousePosFrac = null;
    });

    // Click engages pointer lock in BOTH modes — leash uses a virtual cursor.
    _canvas.addEventListener('click', () => {
      if (document.pointerLockElement !== _canvas) _canvas.requestPointerLock?.();
    });
    document.addEventListener('pointerlockchange', () => {
      const locked = document.pointerLockElement === _canvas;
      if (locked && !_mousePosFrac) _mousePosFrac = { x: 0.5, y: 0.5 };
      // Don't null out _mousePosFrac on unlock — preserve last position.
    });

    // Movement handler — different behavior per mode while pointer-locked.
    document.addEventListener('mousemove', (ev) => {
      if (document.pointerLockElement !== _canvas) return;
      if (_mode === 'first-person') {
        // Mouse right → turn right. In our coord system a right turn is a
        // NEGATIVE yaw delta (positive Y rotation = left turn), so negate.
        _emit(ACTIONS.LOOK_YAW,   -ev.movementX * FP_SENSITIVITY);
        _emit(ACTIONS.LOOK_PITCH, -ev.movementY * FP_SENSITIVITY);
      } else {
        // Leash: integrate movement into the virtual cursor position.
        if (!_mousePosFrac) _mousePosFrac = { x: 0.5, y: 0.5 };
        _mousePosFrac.x = Math.max(0, Math.min(1, _mousePosFrac.x + ev.movementX * VCURSOR_SENSITIVITY));
        _mousePosFrac.y = Math.max(0, Math.min(1, _mousePosFrac.y + ev.movementY * VCURSOR_SENSITIVITY));
      }
    });

    // Leash mode rAF loop: cursor X drives the player's yaw rate.
    _lastTick = performance.now();
    const loop = () => {
      const now = performance.now();
      const dt = Math.min(0.05, (now - _lastTick) / 1000);
      _lastTick = now;
      if (_mode === 'leash' && _mousePosFrac) {
        const ox = (_mousePosFrac.x - 0.5) * 2;
        const o  = (Math.abs(ox) > DEADZONE) ? ox : 0;
        // Right cursor (ox > 0) → player turns right → yaw decreases in our
        // convention (right turn = -Y rotation), so emit negative delta.
        if (o !== 0) _emit(ACTIONS.LOOK_YAW, -o * LEASH_YAW_RATE * dt);
      }
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  },
  setMode(m) {
    _mode = m;
    if (m !== 'first-person' && document.pointerLockElement === _canvas) {
      document.exitPointerLock?.();
    }
  },
  stop() {},
};

// Engine reads this each frame for the camera yaw/pitch offset overlay.
// Returns {x, y} in 0..1 of the preview canvas, or null if the cursor isn't over it.
export function getCursorFraction() {
  return _mousePosFrac;
}
