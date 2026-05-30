// engine/hud.js — overlay UI in the preview window.
//
//   - Crosshair: shown in FIRST-PERSON mode only (the player's aim reticle).
//   - Player capsule marker: shown in LEASH mode only — a dashed wireframe
//     box matching the body's current size (shrinks when crouching) at the
//     player's position. Replaces the crosshair so the user can see WHERE
//     and HOW BIG their character is in third-person.
//   - Easter-egg subtitle: appears on the first raycast hit of the Layer-3
//     microscopic plant at A0/col 1.

import * as THREE from 'three';
import { sfx } from '../core/audio.js';

const EGG_SUBTITLE = '~ stamped by NINETENTWO ~';
let _subEl = null;
let _shownThisSession = false;

// Crosshair visibility per mode (called every frame from engine.js).
export function setCrosshair(visible, color = '#000000', size = 12) {
  const el = document.getElementById('crosshair');
  if (!el) return;
  el.classList.toggle('hidden', !visible);
  el.style.width  = `${size}px`;
  el.style.height = `${size}px`;
  el.style.marginLeft = `${-size / 2}px`;
  el.style.marginTop  = `${-size / 2}px`;
  for (const line of el.querySelectorAll('line')) line.setAttribute('stroke', color);
}

// Build the dashed wireframe player-capsule marker (a box sized to the body's
// current footprint and height) plus a small chevron on the front (+Z) face
// so the user can see WHICH WAY the player is facing as the marker rotates
// with yaw. Added to the scene once at boot; the engine updates its
// position/scale/rotation/visibility each frame.
export function createPlayerMarker(scene) {
  const group = new THREE.Group();
  const mat = new THREE.LineDashedMaterial({
    color: 0x0b0d14,
    dashSize: 0.12,
    gapSize:  0.08,
  });

  // Unit-size capsule outline — scales to body.height/width each frame.
  const boxGeom = new THREE.BoxGeometry(1, 1, 1);
  const edgesGeom = new THREE.EdgesGeometry(boxGeom);
  const box = new THREE.LineSegments(edgesGeom, mat);
  box.computeLineDistances();
  group.add(box);

  // Forward chevron: a small arrow on the +Z face so the user can read the
  // marker's orientation at a glance. Solid (non-dashed) so it stands out.
  const arrowMat = new THREE.LineBasicMaterial({ color: 0x0b0d14 });
  const arrowGeom = new THREE.BufferGeometry();
  arrowGeom.setFromPoints([
    new THREE.Vector3(-0.25, 0.5, 0.5),
    new THREE.Vector3( 0,    0.5, 0.7),
    new THREE.Vector3( 0.25, 0.5, 0.5),
  ]);
  const arrow = new THREE.Line(arrowGeom, arrowMat);
  group.add(arrow);

  // Semi-transparent colored faces so orientation is readable from every angle:
  //   sides (±X)  → coral / orange
  //   top    (+Y) → baby pink
  //   bottom (-Y) → cyan
  // Combined with the front chevron this gives ~4 independent orientation cues.
  function tintedFace(color) {
    return new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: 0.35,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
  }
  function sideFace(xLocal, mat) {
    const plane = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), mat);
    plane.position.set(xLocal, 0, 0);
    plane.rotation.y = xLocal > 0 ? -Math.PI / 2 : Math.PI / 2;
    return plane;
  }
  function horizFace(yLocal, mat) {
    const plane = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), mat);
    plane.position.set(0, yLocal, 0);
    plane.rotation.x = -Math.PI / 2;
    return plane;
  }
  const sideMat = tintedFace(0xee7967);   // coral
  const topMat  = tintedFace(0xf8c8dc);   // baby pink
  const baseMat = tintedFace(0x2cdde7);   // cyan
  group.add(sideFace(+0.5, sideMat));     // +X face — player's left
  group.add(sideFace(-0.5, sideMat));     // -X face — player's right
  group.add(horizFace(+0.5, topMat));     // +Y face — top
  group.add(horizFace(-0.5, baseMat));    // -Y face — base

  group.renderOrder = 100;   // draw on top of walls so it never gets occluded
  scene.add(group);
  return group;
}

// Update marker each frame. Hidden in first-person (player IS the camera).
// `yaw`  — player's facing direction in radians (targetGroup.rotation.y).
// `roll` — small banking angle around the marker's forward axis (≈ ±6°).
//          Lets the dashbox lean INTO the turn for the right "feel."
export function updatePlayerMarker(marker, body, mode, yaw, roll = 0) {
  if (!marker) return;
  if (mode !== 'leash') { marker.visible = false; return; }
  marker.visible = true;
  const w = body.radius * 2;
  marker.scale.set(w, body.height, w);
  marker.position.set(body.pos.x, body.pos.y + body.height / 2, body.pos.z);
  // YXZ: yaw is applied first, then pitch (= 0), then roll — so the roll
  // happens around the marker's CURRENT forward axis (post-yaw).
  marker.rotation.set(0, yaw || 0, roll || 0, 'YXZ');
}

// Egg raycast — unchanged.
export function tickEggRaycast(camera, sceneRoot) {
  if (_shownThisSession) return;
  const raycaster = new THREE.Raycaster();
  raycaster.setFromCamera(new THREE.Vector2(0, 0), camera);
  const hits = raycaster.intersectObject(sceneRoot, true);
  for (const h of hits) {
    let n = h.object;
    while (n) {
      if (n.userData?.v3dEgg) {
        showEggSubtitle();
        _shownThisSession = true;
        return;
      }
      n = n.parent;
    }
  }
}

function showEggSubtitle() {
  sfx.egg();
  if (!_subEl) {
    _subEl = document.createElement('div');
    _subEl.style.cssText = `
      position: fixed; left: 0; right: 0; bottom: 18%;
      text-align: center; font-family: 'Inter', sans-serif;
      font-style: italic; font-size: 16px; color: #0b0d14;
      letter-spacing: 0.06em; pointer-events: none;
      opacity: 0; transition: opacity 0.6s ease;
      text-shadow: 0 0 12px rgba(250,250,247,0.9);
      z-index: 99;`;
    document.body.appendChild(_subEl);
  }
  _subEl.textContent = EGG_SUBTITLE;
  requestAnimationFrame(() => { _subEl.style.opacity = '1'; });
  setTimeout(() => { _subEl.style.opacity = '0'; }, 5000);
}
