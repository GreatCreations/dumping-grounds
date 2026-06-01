// core/sync.js
// BroadcastChannel wrapper for cross-window real-time state sync.
//
// Editor (window A) publishes state changes; Preview (window B) receives them
// and updates without a server roundtrip. Pure client-side. Same-origin only.
//
// Every message carries a hidden `_signed` field as the V3DD Engine identity
// stamp — easter-egg Layer 1. (Receivers don't gate on this; it's just there.)

import * as state from './state.js';
import { signMessage, verifySignature } from './signature.js';

const CHANNEL = 'v3d-sync';
let bc = null;

export function init() {
  if (typeof BroadcastChannel === 'undefined') {
    // Older browser — sync is silently disabled; each window operates standalone.
    console.warn('[v3d-sync] BroadcastChannel unsupported; editor/preview will not sync live.');
    return;
  }
  bc = new BroadcastChannel(CHANNEL);
  console.log('[v3d-sync] init — listener attached on channel', CHANNEL);
  bc.onmessage = (ev) => {
    const msg = ev.data;
    console.log('[v3d-sync] RX', msg?.type, 'verified=', verifySignature(msg));
    if (!msg || msg.type !== 'state-update') return;
    if (!verifySignature(msg)) {
      console.warn('[v3d-sync] received unsigned/foreign message — ignored.');
      return;
    }
    state.receiveRemote(msg.payload);
  };
  state.wireSyncPublisher((s) => {
    console.log('[v3d-sync] TX state-update');
    publish(s);
  });
}

function publish(nextState) {
  if (!bc) return;
  bc.postMessage(signMessage({
    type: 'state-update',
    payload: nextState,
    sentAt: Date.now(),
  }));
}

// Manual close (e.g., for unit tests). Normal pages just let it live for the page lifetime.
export function close() {
  if (bc) { bc.close(); bc = null; }
}
