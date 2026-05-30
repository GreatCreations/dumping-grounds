// engine/camera-rig.js — leashed + first-person camera, the gameplay signature.
//
// LEASH MODE (default, the invention):
//   - A `targetGroup` Object3D represents the player's "target" — what they
//     point at and rotate. WASD translates targetGroup; mouse-look rotates it.
//   - The camera is a CHILD of targetGroup, at local position = leashOffset
//     (default behind + above the target). Three.js parent transform
//     inheritance handles the leash physically: no per-frame lerp, no drift.
//   - Result: the camera mimics every movement of the target with a fixed
//     spatial relationship. Distinctive feel — third-person but the camera
//     never "settles" or eases independently.
//
// FIRST-PERSON MODE:
//   - Camera is detached, placed as direct scene child, copies target position
//     each frame and uses target rotation directly. No leash.
//
// Mode toggle reparents the camera with a ~0.3s tween to avoid pop.

import * as THREE from 'three';
import { cellToWorld } from '../core/grid-addr.js';

const TWEEN_MS = 300;

export function createRig(scene, s) {
  const targetGroup = new THREE.Group();
  targetGroup.name = 'v3d-target';
  scene.add(targetGroup);

  const spawn = cellToWorld(s.spawn.rowId, s.spawn.col, s.grid.cellSizeMeters);
  if (spawn) targetGroup.position.set(spawn.x, 0, spawn.z);
  targetGroup.rotation.y = s.spawn.yaw ?? 0;

  const camera = new THREE.PerspectiveCamera(s.camera.fov, 1, 0.01, 1000);
  const rig = {
    camera,
    targetGroup,
    mode: s.mode || 'leash',
    leashOffset: new THREE.Vector3(...s.camera.leashOffset),
    eyeY:    s.camera.leashOffset[1],  // current eye height (lerps with crouch)
    standEyeY: s.camera.leashOffset[1], // standing eye height (default 1.6)
    crouchEyeY: 0.7,                    // dipped eye height when crouched
    pitch: 0,                            // first-person pitch (radians)
    _tweenStart: 0,
    _tweenFrom: null,
    _tweenTo: null,
  };

  applyMode(rig, rig.mode, /*instant*/ true);
  return rig;
}

export function toggleMode(rig) {
  setMode(rig, rig.mode === 'leash' ? 'first-person' : 'leash');
}

export function setMode(rig, mode) {
  if (mode === rig.mode) return;
  rig.mode = mode;
  applyMode(rig, mode, false);
}

function applyMode(rig, mode, instant) {
  // Decide where the camera should live, then animate from current world-pos
  // to the new world-pos so the switch is smooth.
  const { camera, targetGroup, leashOffset } = rig;
  // Capture current world position before reparenting.
  const fromPos = new THREE.Vector3();
  camera.getWorldPosition(fromPos);

  if (mode === 'leash') {
    if (camera.parent !== targetGroup) targetGroup.add(camera);
    camera.position.set(leashOffset.x, rig.eyeY, leashOffset.z);
    // IMPORTANT: Object3D.lookAt operates in WORLD coordinates. To make the
    // camera look at the TARGETGROUP's local origin (eye-height ahead of the
    // player), convert that local point to world space first.
    targetGroup.updateMatrixWorld(true);
    const worldTarget = new THREE.Vector3(0, rig.eyeY, 0);
    targetGroup.localToWorld(worldTarget);
    camera.lookAt(worldTarget);
  } else {
    if (camera.parent !== targetGroup.parent) targetGroup.parent.add(camera);
    const wp = new THREE.Vector3();
    targetGroup.getWorldPosition(wp);
    camera.position.set(wp.x, wp.y + rig.eyeY, wp.z);   // current eye height at target
    // See updateRig comment: first-person needs +π so the camera faces the
    // same direction the player walks.
    camera.rotation.set(0, targetGroup.rotation.y + Math.PI, 0);
  }

  if (instant) return;
  // Lerp the local position back from fromPos→target over TWEEN_MS.
  const toPos = camera.position.clone();
  rig._tweenFrom = camera.parent.worldToLocal(fromPos);
  rig._tweenTo = toPos.clone();
  rig._tweenStart = performance.now();
  camera.position.copy(rig._tweenFrom);
}

// Per-frame update: advance any active tween + apply pitch for first-person.
export function updateRig(rig) {
  if (rig._tweenStart) {
    const t = Math.min(1, (performance.now() - rig._tweenStart) / TWEEN_MS);
    rig.camera.position.lerpVectors(rig._tweenFrom, rig._tweenTo, easeOutCubic(t));
    if (t >= 1) rig._tweenStart = 0;
  }
  if (rig.mode === 'first-person') {
    // Track target position; rotation = target.yaw + local pitch. Eye height
    // uses rig.eyeY which the engine lerps each frame based on crouch state.
    //
    // The +π on yaw is essential: Three.js cameras default to facing -Z,
    // but our world convention has the player facing +Z (lookAt set up that
    // way in leash mode). Without the +π, the first-person camera looks the
    // opposite of where the player walks — every key feels inverted.
    const wp = new THREE.Vector3();
    rig.targetGroup.getWorldPosition(wp);
    rig.camera.position.set(wp.x, wp.y + rig.eyeY, wp.z);
    rig.camera.rotation.set(rig.pitch, rig.targetGroup.rotation.y + Math.PI, 0, 'YXZ');
  } else if (rig.mode === 'leash' && !rig._tweenStart) {
    // Track current eyeY so crouching dips the leash camera in real time.
    rig.camera.position.y = rig.eyeY;
  }
}

// Lerp the camera's eye height toward the target value. Called per frame from
// engine.js. Smooth (~150ms) avoids jarring snap when toggling crouch.
export function updateEyeHeight(rig, crouching, dt) {
  const targetEyeY = crouching ? rig.crouchEyeY : rig.standEyeY;
  rig.eyeY += (targetEyeY - rig.eyeY) * Math.min(1, dt * 8);
}

function easeOutCubic(t) { return 1 - Math.pow(1 - t, 3); }

// Pulls the leash camera forward along its leash if a wall is between the
// player's eye and the camera's desired world position. Without this the
// camera ends up inside walls when the player backs into a corner — front-side
// rendering culls the inside face and the world appears to vanish.
//
// Called once per frame from engine.js after physics. No-op in first-person mode.
export function clipLeashCamera(rig, aabbs) {
  if (rig.mode !== 'leash' || rig._tweenStart) return;
  const target = rig.targetGroup;
  // Use the CURRENT eye height (lerped by crouch), not the static leashOffset.y,
  // so this function doesn't undo the crouch dip every frame.
  const eyeY = rig.eyeY;
  const fullBack = Math.hypot(rig.leashOffset.x, rig.leashOffset.z);
  if (fullBack < 0.01) return;

  // Unit direction (in target-local frame) along which the camera sits.
  const lx = rig.leashOffset.x / fullBack;
  const lz = rig.leashOffset.z / fullBack;

  // World eye position (player head height, current target position).
  target.updateMatrixWorld(true);
  const eyeWorld = new THREE.Vector3();
  target.getWorldPosition(eyeWorld);
  eyeWorld.y += eyeY;

  // Rotate the leash direction by the target's yaw to get the world ray.
  const yaw = target.rotation.y;
  const cos = Math.cos(yaw), sin = Math.sin(yaw);
  // Three.js Y-rotation matrix: (x,y,z) → (cos*x + sin*z, y, -sin*x + cos*z)
  const dir = new THREE.Vector3(cos * lx + sin * lz, 0, -sin * lx + cos * lz);

  // Find the nearest wall hit along the leash ray, capped at full leash length.
  let safe = fullBack;
  for (const box of aabbs) {
    const t = rayAABB(eyeWorld, dir, box, fullBack);
    if (t !== null && t < safe) safe = Math.max(0.15, t - 0.1);
  }

  // Pull the camera in to the safe distance. Eye-height (Y) stays constant.
  const ratio = safe / fullBack;
  rig.camera.position.set(rig.leashOffset.x * ratio, eyeY, rig.leashOffset.z * ratio);
}

// Slab-method ray-AABB; returns the entry parameter t along `dir` (which is a
// unit vector), or null if the ray misses the box or hits beyond `maxT`.
function rayAABB(origin, dir, box, maxT) {
  let tmin = 0, tmax = maxT;
  for (const ax of ['x', 'y', 'z']) {
    const o = origin[ax], d = dir[ax];
    const lo = box.min[ax], hi = box.max[ax];
    if (Math.abs(d) < 1e-8) {
      if (o < lo || o > hi) return null;
    } else {
      const inv = 1 / d;
      let t1 = (lo - o) * inv;
      let t2 = (hi - o) * inv;
      if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; }
      if (t1 > tmin) tmin = t1;
      if (t2 < tmax) tmax = t2;
      if (tmin > tmax) return null;
    }
  }
  return tmin;
}
