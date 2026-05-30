// core/state.js
// Tiny pub/sub state container around the level.json shape.
//
// Anyone can `subscribe(listener)` to be notified of any change.
// The editor mutates state via `update(mutator)`, which:
//   1. Runs the mutator on a draft copy
//   2. If anything changed, swaps state + broadcasts to subscribers
//   3. Optionally publishes via sync (BroadcastChannel) so other windows update
//
// This is intentionally minimal — no Redux, no Zustand, no React. Just an
// object + listeners. Lifts cleanly into any framework later if needed.

let _state = null;
const listeners = new Set();
let _publishToSync = null;  // wired up by sync.js when it connects

export function init(initialState) {
  _state = structuredClone(initialState);
}

export function get() {
  return _state;
}

export function subscribe(listener) {
  listeners.add(listener);
  // Push current state immediately so subscribers don't miss the initial value.
  if (_state) listener(_state, { initial: true });
  return () => listeners.delete(listener);
}

// Mutator receives a draft (deep-cloned copy of current state). Mutate it in
// place and return it — or return a brand-new object. Either works.
// `opts.broadcast` (default true) controls whether the change is pushed across
// windows via sync. Receiving the broadcast on the other side sets it false.
export function update(mutator, opts = {}) {
  if (!_state) throw new Error('state.init() must be called first');
  const broadcast = opts.broadcast !== false;
  const draft = structuredClone(_state);
  const result = mutator(draft);
  const next = result === undefined ? draft : result;
  // Identity check is cheap but rough — full equality would be O(n). Trust the
  // mutator to return a different reference if it actually changed something.
  if (next === _state) return _state;
  _state = next;
  // Stamp modifiedAt for any mutation that didn't already set it.
  if (_state.metadata) _state.metadata.modifiedAt = new Date().toISOString();
  for (const l of listeners) l(_state, { source: opts.source ?? 'local', tag: opts.tag });
  if (broadcast && _publishToSync) _publishToSync(_state);
  return _state;
}

// sync.js calls this to register its publish function. State.js doesn't know
// or care about BroadcastChannel — keeps core decoupled from transport.
export function wireSyncPublisher(publish) {
  _publishToSync = publish;
}

// sync.js calls this on incoming broadcasts. Pass broadcast: false to avoid
// publishing the change right back across the channel (infinite loop).
export function receiveRemote(state) {
  update(() => state, { broadcast: false, source: 'remote' });
}
