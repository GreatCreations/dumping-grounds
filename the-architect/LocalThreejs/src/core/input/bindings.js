// core/input/bindings.js — action constants + default keyboard/gamepad bindings.
//
// The action layer abstracts what the engine cares about (MOVE_FORWARD,
// LOOK_YAW, JUMP, TOGGLE_MODE, ...) from the raw input source. Bindings are
// editable at runtime and persisted to localStorage so a player's remap
// survives reloads.

export const ACTIONS = Object.freeze({
  MOVE_FORWARD:       'move-forward',
  MOVE_BACKWARD:      'move-backward',
  MOVE_FORWARD_AXIS:  'move-forward-axis',   // for analog sticks (-1..1)
  MOVE_LEFT:          'move-left',
  MOVE_RIGHT:         'move-right',
  MOVE_RIGHT_AXIS:    'move-right-axis',     // analog (-1..1)
  LOOK_YAW:           'look-yaw',            // accumulator (delta-radians)
  LOOK_PITCH:         'look-pitch',          // accumulator (delta-radians)
  JUMP:               'jump',
  TOGGLE_MODE:        'toggle-mode',         // leash <-> first-person
  RESET:              'reset',               // teleport back to spawn (escape hatch)
  CROUCH:             'crouch',              // held: body shrinks, camera dips, walk slows
  PAINT_TOGGLE:       'paint-toggle',        // P: enter/exit paint mode
  PAINT_SWATCH_UP:    'paint-swatch-up',     // = : palette cursor up
  PAINT_SWATCH_DOWN:  'paint-swatch-down',   // ' : palette cursor down
  PAINT_SWATCH_LEFT:  'paint-swatch-left',   // [ : palette cursor left
  PAINT_SWATCH_RIGHT: 'paint-swatch-right',  // ] : palette cursor right
  PAINT_BRUSH_DOWN:   'paint-brush-down',    // , : brush size step down
  PAINT_BRUSH_UP:     'paint-brush-up',      // . : brush size step up
});

// Default keyboard mapping. Provider modules look up their key → action via these.
export const DEFAULT_KEYBOARD = {
  'KeyW': ACTIONS.MOVE_FORWARD,
  'KeyS': ACTIONS.MOVE_BACKWARD,
  'KeyA': ACTIONS.MOVE_LEFT,
  'KeyD': ACTIONS.MOVE_RIGHT,
  'ArrowUp':    ACTIONS.MOVE_FORWARD,
  'ArrowDown':  ACTIONS.MOVE_BACKWARD,
  'ArrowLeft':  ACTIONS.MOVE_LEFT,
  'ArrowRight': ACTIONS.MOVE_RIGHT,
  'Space':      ACTIONS.JUMP,
  'KeyV':       ACTIONS.TOGGLE_MODE,
  'KeyR':       ACTIONS.RESET,
  'KeyC':       ACTIONS.CROUCH,
  'ShiftLeft':  ACTIONS.CROUCH,
  'KeyP':       ACTIONS.PAINT_TOGGLE,
  'Equal':      ACTIONS.PAINT_SWATCH_UP,
  'Quote':      ACTIONS.PAINT_SWATCH_DOWN,
  'BracketLeft':  ACTIONS.PAINT_SWATCH_LEFT,
  'BracketRight': ACTIONS.PAINT_SWATCH_RIGHT,
  'Comma':        ACTIONS.PAINT_BRUSH_DOWN,
  'Period':       ACTIONS.PAINT_BRUSH_UP,
};

const STORAGE_KEY = 'v3d.bindings';

export function loadBindings() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { keyboard: { ...DEFAULT_KEYBOARD } };
    return JSON.parse(raw);
  } catch {
    return { keyboard: { ...DEFAULT_KEYBOARD } };
  }
}

export function saveBindings(b) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(b)); } catch {}
}
