// core/input/keyboard.js — keyboard provider.
// Maps key codes to action emissions per the current binding table.

import { loadBindings } from './bindings.js';

let _emit = null;
let _keydown = null;
let _keyup = null;
let _bindings = loadBindings();

export const keyboardProvider = {
  start(emit) {
    _emit = emit;
    _keydown = (ev) => {
      const action = _bindings.keyboard[ev.code];
      if (action) {
        emit(action, 1);
        // Prevent the browser from scrolling on arrow/space when game has focus.
        if (ev.code === 'Space' || ev.code.startsWith('Arrow')) ev.preventDefault();
      }
    };
    _keyup = (ev) => {
      const action = _bindings.keyboard[ev.code];
      if (action) emit(action, 0);
    };
    window.addEventListener('keydown', _keydown);
    window.addEventListener('keyup',   _keyup);
  },
  stop() {
    window.removeEventListener('keydown', _keydown);
    window.removeEventListener('keyup',   _keyup);
  },
  refreshBindings() { _bindings = loadBindings(); },
};
