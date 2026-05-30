// engine/engine.js — Preview window main loop.
//
// Wires every engine module together:
//   - reads level state from core/state
//   - rebuilds scene chunks on every state change (sync- or local-driven)
//   - runs the camera rig, physics, input layer, and the easter-egg raycaster
//   - draws inked-comic walls + GLB objects + skydome + lights + floor + crosshair
//
// Boot is wrapped in a try/catch and STAGES status updates to the HUD pill, so
// any silent failure is visible at a glance instead of a frozen "starting…".

import * as THREE from 'three';
import * as state   from '../core/state.js';
import * as sync    from '../core/sync.js';
import * as storage from '../core/storage.js';
import { defaultLevel, fillDefaults } from '../core/schema.js';
import { installConsoleSummon } from '../core/signature.js';
import { seedEasterEgg } from '../core/level-seed.js';
import { buildLights, applyCycleLighting } from './lights.js';
import { buildGlobe, buildStars, updateStars, applyCycleSky, applyCycleStarsFade, applyCycleStarsRotation, applyCycleDomeOpacity, buildAtmosphereRings, applyCycleAtmosphereRings }  from './globe.js';
import { buildProjectedShadows } from './projected-shadows.js';
import { buildFloor, buildCeiling, getAnimatedPlaneMeshes } from './floor-ceiling.js';
import { buildWalls, wallAABBs } from './walls.js';
import { buildPlates, plateAABBs } from './plates.js';
import { buildObjects, objectAABBs } from './objects.js';
import { buildOpenings, openingAABBs } from './openings.js';
import { buildTrims, trimAABBs } from './trim.js';
import { createRig, updateRig, toggleMode, clipLeashCamera, updateEyeHeight } from './camera-rig.js';
import { setCrosshair, tickEggRaycast, createPlayerMarker, updatePlayerMarker } from './hud.js';
import * as inputApi from '../core/input/input.js';
import { keyboardProvider } from '../core/input/keyboard.js';
import { mouseProvider, getCursorFraction } from '../core/input/mouse.js';
import { touchProvider }    from '../core/input/touch.js';
import { gamepadProvider }  from '../core/input/gamepad.js';
import { createBody, step as physicsStep } from '../core/physics/physics.js';
import { cellToWorld } from '../core/grid-addr.js';
import { sfx, armOnUserGesture, tickFootsteps } from '../core/audio.js';
import { syncLevelMeshes } from '../core/mesh-registry.js';
import { setCurrentSlug } from '../core/asset-paths.js';
import { sharedLineMaterial } from './inked.js';
import { createNarrationSystem } from './narration.js';
import { setPaintMode, isPaintModeOn, applyPaintHit, raycastPaintPlane, getActiveIndex, loadFromLevel as loadPaintFromLevel, saveToLevel as savePaintToLevel, applyJpegFromHit, nudgeBrushSize, getBrushSize, syncFromLevel as syncPaintFromLevel, setPaintRoot, clearBackingMeshes, registerBackingMesh, restoreLazyCellPlanes, loadFromObject as loadPaintFromObject, serializeToObject as serializePaintObject, hasPaintData } from './painting.js';
import { mountPaintUi, showPaintUi, hidePaintUi, navSwatch, setImportJpegHandler, refreshBrushReadout } from './paint-ui.js';

const SLUG = new URLSearchParams(location.search).get('level') || 'untitled';
setCurrentSlug(SLUG);


// Cross-window level-switch sync. When the editor switches level,
// it broadcasts {type:'switch', slug:'newSlug'} on `v3d-level`.
// Any preview window open against a DIFFERENT slug reloads onto the
// new one so editor + preview stay paired. A preview on the same
// slug ignores it (already showing the right level).
if (typeof BroadcastChannel !== 'undefined') {
  try {
    const _levelBus = new BroadcastChannel('v3d-level');
    _levelBus.addEventListener('message', (ev) => {
      const m = ev.data;
      if (m?.type !== 'switch' || !m.slug) return;
      if (m.slug === SLUG) return;
      const url = new URL(location.href);
      url.searchParams.set('level', m.slug);
      location.href = url.toString();
    });
  } catch {}
}
const $ = (id) => document.getElementById(id);

const statusPill = $('preview-status');
const stage = (s) => { console.log('[engine]', s); if (statusPill) statusPill.textContent = s; };

// Browser extensions (MetaMask, others) inject content scripts that often
// throw or reject promises in our window. They show up in unhandledrejection /
// error events even though we don't own them. This sniff filters out anything
// that mentions a known extension surface or stack-trace marker.
function isExtensionNoise(payload) {
  const msg = String(payload?.message || payload || '');
  const stack = String(payload?.stack || '');
  return /MetaMask|inpage\.js|chrome-extension:|moz-extension:/i.test(msg + stack);
}

window.addEventListener('error', (e) => {
  if (isExtensionNoise(e.error || e)) { e.preventDefault?.(); return; }
  console.error('[engine] window error:', e.error || e.message);
  if (statusPill) statusPill.textContent = `engine error: ${e.message}`;
});
window.addEventListener('unhandledrejection', (e) => {
  // preventDefault() tells the browser "this rejection is handled" — suppresses
  // the default "Uncaught (in promise)" log entry for extension noise too.
  if (isExtensionNoise(e.reason)) { e.preventDefault?.(); return; }
  console.error('[engine] promise rejection:', e.reason);
  if (statusPill) statusPill.textContent = `engine rejection: ${e.reason?.message || e.reason}`;
});

(async () => {
try {
  installConsoleSummon();
  stage(`preview: loading "${SLUG}"…`);

  // ---- Boot state ----
  const loaded = await storage.load(SLUG);
  stage(`preview: state loaded`);
  let initial = fillDefaults(loaded, SLUG) || defaultLevel(SLUG);
  initial = seedEasterEgg(initial);
  state.init(initial);
  sync.init();
  // Seed the input yaw accumulator with the level's spawn yaw. Without this,
  // state.yaw=0 at boot and the per-frame `targetGroup.rotation.y = snap.yaw`
  // overwrites whatever createRig set, effectively ignoring spawn.yaw.
  if (initial.spawn?.yaw) inputApi.emit('look-yaw', initial.spawn.yaw);
  // Restore paint from disk. Paint now lives in levels/<slug>/paint.json
  // (Phase B' refactor). Migration path: if the sidecar is absent OR
  // empty AND the level.json carries inline paint (legacy format),
  // lift the inline paint into the sidecar Maps. The inline copy
  // stays in `initial` until the next save, which will strip it.
  //
  // Spec note: paint loading is supposed to be opt-in via a "Load
  // paint" button. The preview window auto-loads it (paint is part
  // of what you came to see); the editor's opt-in toggle is added
  // when the topbar dropdown ships in Phase D. For now both windows
  // attempt the load — opt-in is a UI gate, not a data-layer concern.
  try {
    const sidecar = await storage.loadPaint(SLUG);
    if (sidecar && (Object.keys(sidecar.paint || {}).length || Object.keys(sidecar.jpegs || {}).length)) {
      loadPaintFromObject(sidecar);
    } else if (initial.paint || initial.jpegs) {
      // Legacy inline paint — migrate into the sidecar Maps.
      loadPaintFromLevel(initial);
    }
  } catch (e) {
    console.warn('[engine] paint sidecar load failed, falling back to inline:', e?.message);
    loadPaintFromLevel(initial);
  }
  // Merge any imported meshes from the level into the runtime registry.
  syncLevelMeshes(initial);
  // Keep registry up to date on broadcast state changes (e.g., editor imports
  // a mesh while preview is open). Skip for opening-swing commits — mesh
  // registry doesn't depend on door angles.
  state.subscribe((s, meta) => {
    if (meta?.tag === 'opening-swing') return;
    syncLevelMeshes(s);
  });
  stage(`preview: state ready`);

  // ---- Three.js scene ----
  const canvas = $('preview-canvas');
  if (!canvas) throw new Error('#preview-canvas not in DOM');
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  // Use the device's actual pixel ratio (no cap). On a 4K Retina display this
  // means rendering at the panel's native resolution — sharper lines, less
  // aliasing. Trades fill-rate for clarity; the inked-comic look is mostly
  // strokes so the win is worth the cost here.
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  // No clearColor: the globe (back-side sphere) IS the background. Inked-comic
  // requires one continuous off-white world.

  const scene = new THREE.Scene();
  const rootFloor   = new THREE.Group(); scene.add(rootFloor);
  const rootCeiling = new THREE.Group(); scene.add(rootCeiling);
  const rootGlobe   = new THREE.Group(); scene.add(rootGlobe);
  // Star sphere lives in its OWN scene-graph root, completely separate
  // from the dome. Engine.js owns this so the per-frame camera-follow
  // update can move the star sphere freely without touching the dome's
  // transform hierarchy.
  const rootStars   = new THREE.Group(); scene.add(rootStars);
  const rootLights  = new THREE.Group(); scene.add(rootLights);
  const rootWalls   = new THREE.Group(); scene.add(rootWalls);
  const rootPlates  = new THREE.Group(); scene.add(rootPlates);
  const rootObjects = new THREE.Group(); scene.add(rootObjects);
  const rootOpenings = new THREE.Group(); scene.add(rootOpenings);
  const rootTrims    = new THREE.Group(); scene.add(rootTrims);
  // Projected polygon shadows live in their own group so the
  // system can be cleared and rebuilt independently when its
  // world flag toggles.
  const rootProjShad = new THREE.Group(); scene.add(rootProjShad);
  // Lazy paint planes (per-cell paint on floor / ceiling) live here so they
  // survive floor/ceiling rebuilds. clearPaintPlanes() empties this group.
  const rootPaint = new THREE.Group(); scene.add(rootPaint);
  setPaintRoot(rootPaint);
  // Dashed wireframe outlining the player's body — visible in leash mode only.
  const playerMarker = createPlayerMarker(scene);
  stage(`preview: scene built`);

  const rig = createRig(scene, state.get());
  stage(`preview: camera rig live (${rig.mode})`);

  function resize() {
    renderer.setSize(window.innerWidth, window.innerHeight, false);
    rig.camera.aspect = window.innerWidth / window.innerHeight;
    rig.camera.updateProjectionMatrix();
    // LineMaterial's screen-space thickness depends on viewport resolution.
    sharedLineMaterial.resolution.set(window.innerWidth, window.innerHeight);
  }
  window.addEventListener('resize', resize);
  resize();

  // ---- Input ----
  // registerProvider already starts the provider; do NOT call startAll() again
  // or every keydown listener would be attached twice.
  inputApi.registerProvider(keyboardProvider);
  inputApi.registerProvider(mouseProvider);
  inputApi.registerProvider(touchProvider);
  inputApi.registerProvider(gamepadProvider);
  armOnUserGesture();   // resume Web Audio on first click/keydown
  mountPaintUi();       // build (hidden) the paint-mode picker overlay
  // Wire the Import-JPEG button to raycast the crosshair and apply the saved
  // asset URL (paint-ui already wrote bytes to levels/<slug>/assets/jpegs/...).
  setImportJpegHandler((assetUrl) => {
    const hit = raycastPaintPlane(rig.camera);
    if (!hit) { console.warn('[paint] no face under crosshair for JPEG'); return; }
    applyJpegFromHit(hit, assetUrl, 'fixed');
  });
  stage(`preview: input bound`);

  // Paint handlers — left=paint, right=erase. Mousedown paints once, then
  // mousemove with a button held paints continuously (hold-to-paint). Active
  // only while paint mode is on. Suppress contextmenu so right-click works
  // for continuous erase without showing the browser menu.
  canvas.addEventListener('contextmenu', (ev) => { if (isPaintModeOn()) ev.preventDefault(); });
  canvas.addEventListener('mousedown', (ev) => {
    // Narration click first — paint goes THROUGH boxes (paintBlocked=false),
    // but click-to-advance the story takes priority for the player. The
    // raycaster is built from the centred camera view (crosshair-relative).
    if (ev.button === 0) {
      const ndc = new THREE.Vector2(0, 0);   // centre of canvas (crosshair)
      const rc  = new THREE.Raycaster();
      rc.setFromCamera(ndc, rig.camera);
      if (narration?.handleClick?.(rc)) return;
    }
    if (!isPaintModeOn()) return;
    const hit = raycastPaintPlane(rig.camera);
    if (!hit) return;
    const idx = (ev.button === 2) ? 0 : getActiveIndex();
    applyPaintHit(hit, idx, getBrushSize());
  });
  canvas.addEventListener('mousemove', (ev) => {
    if (!isPaintModeOn()) return;
    if (ev.buttons === 0) return;             // no button held → no paint
    const hit = raycastPaintPlane(rig.camera);
    if (!hit) return;
    const idx = (ev.buttons & 2) ? 0 : getActiveIndex();
    applyPaintHit(hit, idx, getBrushSize());
  });

  // ---- Opening drag-to-swing (preview interaction) ----
  //
  // Click and HOLD on a door or window in the preview, then drag — the
  // opening rotates around its hinge (defined by `op.swing`) by an
  // amount derived from the mouse movement. Releases commit the final
  // angle to state.
  //
  // - Paint mode steals priority (if paint is on, this handler skips).
  // - Locked openings (`op.locked === true`) ignore the drag.
  // - Horizontal-axis swings (top/bottom) follow vertical mouse drag;
  //   vertical-axis swings (left/right) follow horizontal mouse drag.
  // - Drag distance maps linearly: ~250 px = 90°. So a 100 px drag is
  //   ~36°. Feels natural without being twitchy.
  // - Rotation is applied LIVE to the opening's pivot group (no state
  //   write per frame, so no rebuildAll spam). Final angle commits to
  //   state on pointerup, which triggers one rebuild.
  let openingDrag = null;
  // Drag sensitivity: pixels of mouse movement that equal a 90°
  // rotation of the opening. Lower = more sensitive (less drag needed
  // for the full swing). 80 px ≈ a short flick to fully open a door.
  const PIXELS_PER_90DEG = 80;
  // Raycast from the CAMERA CENTRE (crosshair) rather than the cursor
  // position. Reason: the preview is usually in pointer-lock mode
  // where ev.clientX/Y is frozen at the last unlocked position. The
  // crosshair is the player's actual aim, so it's the right input
  // even when not locked.
  function raycastOpeningFromCrosshair() {
    const ndc = new THREE.Vector2(0, 0);
    const rc = new THREE.Raycaster();
    rc.setFromCamera(ndc, rig.camera);
    const hits = rc.intersectObject(rootOpenings, true);
    for (const h of hits) {
      let node = h.object;
      while (node && !node.userData?.openingId) node = node.parent;
      if (node) return { id: node.userData.openingId, group: node };
    }
    return null;
  }
  canvas.addEventListener('mousedown', (ev) => {
    if (isPaintModeOn()) return;
    if (ev.button !== 0) return;
    const hit = raycastOpeningFromCrosshair();
    if (!hit) return;
    const s = state.get();
    const op = (s.openings || []).find(o => o.id === hit.id);
    if (!op || op.locked) return;
    openingDrag = {
      id: hit.id,
      group: hit.group,
      accDx: 0,                 // accumulated movementX from pointer-lock
      accDy: 0,
      startAngle: op.openAngle || 0,
      swing: op.swing || 'left',
      swingMin: op.swingMin ?? 0,
      swingMax: op.swingMax ?? 85,
      swingReverse: !!op.swingReverse,
    };
  });
  // mousemove + mouseup on DOCUMENT (not canvas), so they fire while
  // pointer is locked. movementX/Y delivers per-event deltas in both
  // locked and unlocked modes.
  document.addEventListener('mousemove', (ev) => {
    if (!openingDrag) return;
    openingDrag.accDx += ev.movementX || 0;
    openingDrag.accDy += ev.movementY || 0;
    // Drag direction maps to "pull the swinging edge toward you."
    // For a left-hinged door, the swinging RIGHT edge moves LEFT
    // when the door opens toward you — so drag LEFT to open.
    let delta;
    switch (openingDrag.swing) {
      case 'left':   delta = -openingDrag.accDx; break;
      case 'right':  delta =  openingDrag.accDx; break;
      case 'top':    delta = -openingDrag.accDy; break;
      case 'bottom': delta =  openingDrag.accDy; break;
      default:       delta = -openingDrag.accDx;
    }
    // Clamp to the opening's swing range [swingMin, swingMax].
    // Defaults: 0 (closed) to 85 (almost-fully-open).
    const swingMin = openingDrag.swingMin ?? 0;
    const swingMax = openingDrag.swingMax ?? 85;
    const newAngle = Math.max(swingMin, Math.min(swingMax,
      openingDrag.startAngle + (delta / PIXELS_PER_90DEG) * 90));
    const rad = newAngle * Math.PI / 180;
    const pivot = openingDrag.group.userData.hingePivot;
    if (!pivot) { openingDrag = null; return; }
    // Mirror makeHingePivot's sign logic — swingReverse flips the
    // rotation direction so the live drag stays visually consistent
    // with what the next state-commit rebuild will produce.
    const sign = openingDrag.swingReverse ? -1 : 1;
    if (openingDrag.swing === 'left')        pivot.rotation.y = sign * -rad;
    else if (openingDrag.swing === 'right')  pivot.rotation.y = sign *  rad;
    else if (openingDrag.swing === 'top')    pivot.rotation.x = sign *  rad;
    else if (openingDrag.swing === 'bottom') pivot.rotation.x = sign * -rad;
    openingDrag.liveAngle = newAngle;
  });
  // Debounced swing commits — rapid drag-release-drag-release no longer
  // pays N×(structuredClone + broadcast + listener cascade). Each
  // opening keeps a single pending commit; new releases overwrite the
  // pending angle and reset the timer. After 1 s of no swing activity
  // for that opening, the pending angle commits to state (silent,
  // broadcast: false — the editor will pick it up the next time
  // anything else syncs).
  const pendingSwingCommits = new Map();   // id → { angle, timer }
  function flushSwingCommit(id) {
    const pending = pendingSwingCommits.get(id);
    if (!pending) return;
    clearTimeout(pending.timer);
    pendingSwingCommits.delete(id);
    state.update((s) => {
      const op = (s.openings || []).find(o => o.id === id);
      if (op) op.openAngle = pending.angle;
    }, { tag: 'opening-swing', broadcast: false });
  }
  function flushAllSwingCommits() {
    for (const id of [...pendingSwingCommits.keys()]) flushSwingCommit(id);
  }
  document.addEventListener('mouseup', () => {
    if (!openingDrag) return;
    const id = openingDrag.id;
    const final = openingDrag.liveAngle ?? openingDrag.startAngle;
    openingDrag = null;
    const existing = pendingSwingCommits.get(id);
    if (existing) clearTimeout(existing.timer);
    const timer = setTimeout(() => flushSwingCommit(id), 1000);
    pendingSwingCommits.set(id, { angle: final, timer });
  });
  // Safety: flush any pending swing commits if the user navigates
  // away — otherwise the angle wouldn't make it into the saved level.
  window.addEventListener('beforeunload', flushAllSwingCommits);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushAllSwingCommits();
  });

  $('btn-toggle-mode')?.addEventListener('click', () => {
    toggleMode(rig);
    $('btn-toggle-mode').textContent = rig.mode;
    mouseProvider.setMode(rig.mode);
  });

  // ↻ Redraw button: re-fetch the saved level from disk and overwrite the
  // in-memory state, which fires every subscriber (rebuildAll, paint
  // sidecar sync, AABB recompute) for a full scene rebuild. Use this when
  // the preview's geometry has drifted out of sync with what the editor
  // shows — e.g., walls visually missing their door cells after a stale
  // build.
  $('btn-redraw')?.addEventListener('click', async () => {
    const prevText = $('btn-redraw').textContent;
    $('btn-redraw').textContent = '…';
    try {
      const loaded = await storage.load(SLUG);
      const next = fillDefaults(loaded, SLUG) || defaultLevel(SLUG);
      state.init(seedEasterEgg(next));
      stage('preview: redrawn from disk');
    } catch (err) {
      console.error('[engine] redraw failed:', err);
      stage(`redraw error: ${err.message}`);
    } finally {
      $('btn-redraw').textContent = prevText;
    }
  });
  // Initial sync of mouse mode (leash by default; we set explicitly in case
  // a saved level chose first-person).
  mouseProvider.setMode(rig.mode);

  // ---- Physics body ----
  const body = createBody(state.get());
  body.pos.x = rig.targetGroup.position.x;
  body.pos.y = rig.targetGroup.position.y;
  body.pos.z = rig.targetGroup.position.z;
  {
    const s = state.get();
    setCrosshair(s.hud.crosshair.enabled, s.hud.crosshair.color, s.hud.crosshair.size);
  }

  // ---- State-driven scene rebuild ----
  let pendingObjectsRebuild = null;
  // Refs captured from buildGlobe + buildLights so the per-frame
  // day-cycle hook can mutate them in place (orbit positions, light
  // colors, dome gradient) instead of rebuilding the whole world
  // every animation frame.
  let cycleSkyRefs = null;
  let cycleLightRefs = null;

  function rebuildAll(s) {
    try {
      buildFloor(rootFloor, s);
      buildCeiling(rootCeiling, s);
      cycleSkyRefs   = buildGlobe(rootGlobe, s);
      buildStars(rootStars, s);
      // Atmosphere ring halos (golden / blue hour). Built once per
      // rebuild; per-frame opacities are mutated by
      // applyCycleAtmosphereRings inside runDayCycle.
      buildAtmosphereRings(rootGlobe, s);
      cycleLightRefs = buildLights(rootLights, s);
      buildWalls(rootWalls, s);
      buildPlates(rootPlates, s);
      buildOpenings(rootOpenings, s);
      buildTrims(rootTrims, s);
      // Alternative shadow system — independent of the depth-map
      // system on `renderer.shadowMap`. No-op when its world flag
      // is off.
      buildProjectedShadows(rootProjShad, s);
      pendingObjectsRebuild = buildObjects(rootObjects, s);
      // Refresh backing-mesh registry so the paint raycaster can hit the
      // freshly-rebuilt floor/ceiling planes. (buildWalls clears _planes via
      // clearPaintPlanes(); lazy floor/ceiling cell-planes are removed at
      // the same time so we don't accumulate orphans.)
      clearBackingMeshes();
      for (const child of rootFloor.children)   if (child.userData?.paintableSurface) registerBackingMesh(child);
      for (const child of rootCeiling.children) if (child.userData?.paintableSurface) registerBackingMesh(child);
      // Stair sub-meshes attach object-style paint overlays in walls.js
      // (treads / risers / posts / banister / runner / underside). Walk
      // rootWalls and register every overlay so the paint raycaster can
      // hit them. The atlas-slot clipping inside _applyObjectPaintHit
      // keeps a brush splat confined to whichever component (tread,
      // post face, etc.) was hit.
      rootWalls.traverse((n) => {
        if (n.userData?.paintableSurface === 'object') registerBackingMesh(n);
      });
      // Mesh objects load async — register their paintable Meshes once the
      // current buildObjects promise resolves. (registerBackingMesh is
      // idempotent within a build: clearBackingMeshes at the top of the
      // next rebuild flushes anything stale.)
      if (pendingObjectsRebuild) {
        pendingObjectsRebuild.then(() => {
          const shadowsOn = !!state.get().world?.shadows?.enabled;
          rootObjects.traverse((n) => {
            if (n.userData?.paintableSurface === 'object') registerBackingMesh(n);
            if (shadowsOn && n.isMesh) { n.castShadow = true; n.receiveShadow = true; }
          });
        });
      }
      // Rebuild the lazy floor/ceiling paint planes for every cell that was
      // painted earlier this session — clearPaintPlanes wiped the mesh but
      // the paint bytes survived in the sidecar.
      restoreLazyCellPlanes();
      // World-level atmospheric fog (off by default). When enabled, distant
      // walls fade toward the globe's horizon color. Edge strokes use
      // LineMaterial which is configured with `fog: false` so they stay crisp
      // at every distance — only the surface fills attenuate.
      const fog = s.world?.fog;
      if (fog?.enabled) {
        // Fog colour lifted toward a lighter, brighter grey than the
        // horizon's `#d8d8d8` so the atmospheric haze reads as bright
        // mist rather than dim overcast. Falls back to fog.color if a
        // saved level provides one, otherwise the new default.
        const horizon = fog.color || '#ececec';
        // Exponential fog (FogExp2) instead of linear. Linear fog has a
        // sharp "far" cliff and a wide thin region before it, so the
        // floor's outer edge stays partially visible even when fog is
        // "on." FogExp2 ramps faster with distance — by the time the
        // closest floor edge (~50 m from a centred player) enters the
        // view, it's already fully fogged. Density 0.06 ≈ full fog by
        // ~40 m, which hides the 100×100 m plane edges from any vantage
        // inside the grid.
        // Opacity is a density multiplier (FogExp2 doesn't expose a true
        // alpha clamp). At opacity 1.0 fog is at full density; at 0.35
        // (the default) it's a third density — visually a much lighter
        // haze. At 0 it's invisible.
        const opacity = fog.opacity ?? 0.35;
        const density = (fog.density ?? 0.025) * opacity;
        scene.fog = new THREE.FogExp2(horizon, density);
      } else {
        scene.fog = null;
      }
      // Hard-edged sun shadows. Independent of toonShading — either
      // can be on without the other; both on gives shadowed cel bands.
      // We enable the renderer's shadow pass and walk every mesh in
      // the world roots setting cast/receive flags. MeshBasicMaterial
      // ignores `receiveShadow` (no light path to multiply against)
      // but still respects `castShadow` since shadow casting reads
      // geometry only — so basic-material walls / openings / trims
      // still drop shadows onto Lambert/Toon receivers.
      const shadowsOn = !!s.world?.shadows?.enabled;
      renderer.shadowMap.enabled = shadowsOn;
      // PCFSoftShadowMap — 4×4 percentage-closer kernel that produces
      // a soft gradient at the shadow boundary instead of a hard line.
      // The width of the soft gradient is controlled by `shadow.radius`
      // on the light (set in lights.js). The visible mid-tone band
      // along the gradient reads like an inked shadow rim, which is
      // the closest single-pass approximation of the comic-book "edge
      // line + soft interior" look.
      renderer.shadowMap.type = THREE.PCFSoftShadowMap;
      if (shadowsOn) {
        for (const root of [rootFloor, rootCeiling, rootWalls, rootPlates, rootObjects, rootOpenings, rootTrims, rootPaint]) {
          root.traverse((n) => {
            if (!n.isMesh) return;
            // Skip cast on translucent glass / panel surfaces so light
            // passes through them like real glass. The frame/jamb/
            // mullion pieces stay opaque and still cast — only the
            // pane itself is excluded. `receiveShadow` stays on so a
            // shadow falling on the pane area still tints whatever's
            // behind it correctly.
            // Also skip cast on meshes explicitly opted out via
            // userData.noCastShadow (e.g. the stair runner — a paper-
            // thin overlay whose own shadow would read as a bug).
            // ALSO skip cast on paint overlay meshes (attachPaintOverlays
            // adds a UV-repacked CLONE of every base mesh — same
            // position, same geometry, but with polygonOffset = -2/-2
            // and side: DoubleSide. If we let those cast, they
            // submit duplicate depth values shifted toward the light,
            // creating phantom self-shadow contributions that look
            // like dark stripes / wrong-direction stair shadows. The
            // overlay is cosmetic painting geometry, not shadow
            // casting geometry).
            const mat = n.material;
            const isTransparent = !!(mat && mat.transparent === true && (mat.opacity ?? 1.0) < 0.95);
            // Paint planes / overlays now use `alphaTest: 0.5` on
            // their material — empty canvases discard every pixel in
            // the shadow pass (no rogue phantom shadow), painted
            // pixels survive and cast shadow correctly. So we let
            // these meshes back into the cast set; the material's
            // alphaTest does the gating naturally. Glass panes
            // STAY excluded via the isTransparent check below, since
            // their material is fully transparent with no alpha-test
            // gate, so light still passes through unpainted glass.
            const optedOut = n.userData?.noCastShadow === true;
            n.castShadow    = !isTransparent && !optedOut;
            n.receiveShadow = true;
          });
        }
      }
      // NOTE: crosshair visibility is mode-dependent and updated each frame
      // in the render tick — don't override it here.
    } catch (err) {
      console.error('[engine] rebuildAll failed:', err);
      stage(`rebuild error: ${err.message}`);
    }
  }
  // Keep the painting sidecar (paint + per-face JPEGs) in sync with state
  // edits arriving from the editor (e.g., base-JPEG assignment wipes
  // per-face JPEGs — that needs to flush from the sidecar too).
  // Subscribe BEFORE rebuildAll so the rebuild sees the post-sync sidecar.
  // Paint sidecar sync skipped for opening-swing commits — paint
  // doesn't change with door angles.
  state.subscribe((s, meta) => {
    if (meta?.tag === 'opening-swing') return;
    syncPaintFromLevel(s);
  });
  state.subscribe((s, meta) => {
    // Swing-commit shortcut: the drag handler has already rotated the
    // hinge pivot live; the commit is purely to persist the angle.
    // Skip the full rebuildAll (~100-300 ms) for this tag — the
    // visible scene is already correct. Lightweight subscribers
    // (AABBs, FOV sync) still run because they're cheap and the
    // collision footprint may have changed (frame eclipsed by an
    // open door, etc.).
    if (meta?.tag === 'opening-swing') return;
    rebuildAll(s);
  });

  // ---- Narration system (Phase 1) ----
  // Owns story fetching, trigger eval, 3D box rendering, click-to-
  // advance. Re-syncs on state change so newly-placed markers fetch
  // their stories.
  const narration = createNarrationSystem(scene, () => state.get());
  narration.syncStoriesFromState();
  state.subscribe((s, meta) => {
    if (meta?.tag === 'opening-swing') return;
    narration.syncStoriesFromState();
  });

  stage(`preview: ready  (${SLUG})`);

  // ---- Collision AABB cache (recomputed when state changes) ----
  //
  // Slice caches so swing commits can patch only the openings without
  // re-walking walls/plates/objects (the most expensive part).
  let aabbs = [];
  let cachedWallAABBs   = [];
  let cachedPlateAABBs  = [];
  let cachedObjectAABBs = [];
  let cachedTrimAABBs   = [];
  function recomputeAABBs() {
    aabbs = [...cachedWallAABBs, ...cachedPlateAABBs, ...cachedObjectAABBs, ...cachedTrimAABBs, ...openingAABBs(state.get())];
  }
  state.subscribe((s, meta) => {
    if (meta?.tag === 'opening-swing') {
      // Only the swinging opening's AABBs change; walls/plates/
      // objects/trims untouched. Use cached slices, only recompute openings.
      recomputeAABBs();
      return;
    }
    cachedWallAABBs  = wallAABBs(s);
    cachedPlateAABBs = plateAABBs(s);
    cachedTrimAABBs  = trimAABBs(s);
    cachedObjectAABBs = [];   // populated when object build resolves
    recomputeAABBs();
    pendingObjectsRebuild?.then(() => {
      cachedObjectAABBs = objectAABBs(scene, s);
      recomputeAABBs();
    }).catch((e) => console.warn('[engine] object AABB build:', e));
  });

  // ---- Camera FOV sync ----
  //
  // createRig builds the PerspectiveCamera once with s.camera.fov, then
  // never reads s.camera.fov again. Without this subscriber, editing
  // FOV in the World/View panel updates state but the camera keeps its
  // boot-time FOV. We sync per state-change (not per frame) since FOV
  // changes are rare and updateProjectionMatrix() is not free.
  state.subscribe((s) => {
    const nextFov = s.camera?.fov ?? 60;
    if (rig.camera && Math.abs(rig.camera.fov - nextFov) > 0.01) {
      rig.camera.fov = nextFov;
      rig.camera.updateProjectionMatrix();
    }
  });

  // ---- Debug globals (dev-only) ----
  // window.V3D.debug exposes the body + rig + scene so a session can inspect
  // positions from DevTools. Easter-egg layer 2 (V3D.summon) lives on the
  // same V3D namespace.
  window.V3D = window.V3D || {};
  window.V3D.debug = { body, rig, scene, state, input: inputApi };

  // Audio-event tracking
  let wasGrounded = true;
  let walkedDistance = 0;
  let lastPos = { x: body.pos.x, z: body.pos.z };

  // HUD readout — updated each frame with the current player state.
  const hudReadout = document.createElement('div');
  hudReadout.style.cssText = `
    position:absolute; top:38px; left:12px;
    font-family: var(--font-mono, monospace); font-size:11px;
    color: var(--c-fg-muted, #6b6f7a);
    background: rgba(255,255,255,0.55);
    padding: 3px 8px; border: 1px solid rgba(11,13,20,0.5);
    pointer-events: none;
    white-space: pre;`;
  document.body.appendChild(hudReadout);

  // ---- Day cycle (Phase 4) ----
  //
  // 15-minute increment system (96 buckets per real-time day). T is the
  // 0..1 position in the day — T=0 == midnight, T=0.25 == daybreak,
  // T=0.5 == noon, T=0.75 == dusk. The sun rides a great circle in
  // the X-Y plane:
  //   sun  = ( sin(2πT), -cos(2πT), 0 )    — peaks +Y at noon
  //   moon = -sun                          — peaks +Y at midnight
  // The directional light's TRAVEL vector is -sun (rays point down
  // when sun is overhead). To advance the wall-clock when the user
  // hasn't frozen it via override.time, we accumulate dt scaled by
  // speedMul / dayLengthHours_in_seconds.
  let cycleClockT = 0.5;        // running clock; replaced on first frame from state
  let cycleClockInitialized = false;
  // Cumulative star sphere rotation (radians). Increments per frame
  // at 1/12 the sun's angular rate, opposite direction, so the star
  // sphere completes one full revolution per 12 simulated days. Stored
  // outside of the day-cycle T (which wraps 0..1) so the angle keeps
  // growing across day boundaries instead of resetting at midnight.
  let starsCumulativeRot = 0;
  let lastSunAng = 0;

  function runDayCycle(now, dt) {
    const s = state.get();
    const dc = s?.world?.dayCycle;
    if (!dc || !dc.enabled) return;
    if (!cycleSkyRefs && !cycleLightRefs) return;

    // ---- Temporal: pick T ----
    //
    // Priority (highest first):
    //   override.time → frozen preview clock
    //   atmosphere.wallClockSync → local time of day
    //   otherwise → free-running cycleClockT driven by speedMul
    let T;
    if (dc.override?.time) {
      T = dc.previewTime ?? 0.5;
    } else if (dc.atmosphere?.wallClockSync) {
      const d = new Date();
      T = (d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds()) / 86400;
      // Mirror T into cycleClockT so when the user clicks 60×/1440×/⏸
      // (which flips wallClockSync off), simulated time picks up smoothly
      // from "right now" instead of jumping back to the seed timeOfDay.
      cycleClockT = T;
      cycleClockInitialized = true;
    } else {
      if (!cycleClockInitialized) {
        cycleClockT = dc.timeOfDay ?? 0.5;
        cycleClockInitialized = true;
      }
      const dayLenSec = (dc.dayLengthHours ?? 24) * 3600;
      // speedMul = 0 → frozen (⏸ button). Multiplying by 0 leaves
      // cycleClockT unchanged so the scene stays put until the user
      // clicks a non-zero speed.
      cycleClockT += (dt * (dc.speedMul ?? 1)) / dayLenSec;
      cycleClockT = cycleClockT - Math.floor(cycleClockT); // wrap 0..1
      T = cycleClockT;
    }

    // Snap to 1/96 (15-minute increments).
    const STEP = 1 / 96;
    T = Math.floor(T / STEP + 1e-6) * STEP;

    // ---- Find surrounding keyframes ----
    const kfs = dc.keyframes ?? [];
    if (kfs.length === 0) return;
    // Sort by t once per frame (cheap — typically 4 entries).
    const sorted = kfs.slice().sort((a, b) => a.t - b.t);
    let lo = sorted[sorted.length - 1];
    let hi = sorted[0];
    let loT = lo.t - 1;       // wrap-around: previous keyframe is "yesterday"
    let hiT = hi.t;
    for (let i = 0; i < sorted.length; i++) {
      if (sorted[i].t <= T) {
        lo  = sorted[i];
        loT = sorted[i].t;
        hi  = sorted[(i + 1) % sorted.length];
        hiT = sorted[(i + 1) % sorted.length].t;
        if (hiT <= loT) hiT += 1; // wrap
      }
    }
    const span = hiT - loT;
    const u = span > 1e-6 ? (T - loT) / span : 0;

    // ---- Lerp lighting ----
    const lerp = (a, b, t) => a + (b - a) * t;
    const lerpColor = (a, b, t) => {
      const ac = new THREE.Color(a), bc = new THREE.Color(b);
      return '#' + ac.lerp(bc, t).getHexString();
    };
    const sunIntensity = lerp(lo.sunIntensity, hi.sunIntensity, u);
    const ambIntensity = lerp(lo.ambIntensity, hi.ambIntensity, u);
    const ambColor     = lerpColor(lo.ambColor, hi.ambColor, u);
    const skyTop       = lerpColor(lo.skyTop, hi.skyTop, u);
    const skyHor       = lerpColor(lo.skyHor, hi.skyHor, u);

    // ---- Orbit geometry ----
    // Sun and moon trace a great circle on the celestial sphere.
    // The orbit is rotated around the X axis (east-west) by GLOBE_TILT
    // radians so the noon position arcs through the SOUTHERN sky
    // instead of straight overhead — the northern-hemisphere look.
    // The X axis is the east-west horizon line, so sunrise (ang=π/2)
    // and sunset (ang=3π/2) stay fixed at due east and due west.
    // Only the high-noon position (and its midnight antipode for the
    // moon) shift away from directly overhead.
    //
    // 30° (Math.PI / 6) corresponds to roughly mid-northern-latitude
    // (~30°N) sun behavior at equinox: sun max altitude ≈ 60° instead
    // of 90° straight up. Adjust higher for a more polar feel
    // (sun lower in the south), lower for tropical (sun closer to
    // overhead).
    const GLOBE_TILT = Math.PI / 6;
    const cosTilt = Math.cos(GLOBE_TILT);
    const sinTilt = Math.sin(GLOBE_TILT);
    const ang = 2 * Math.PI * T;
    const baseSunY = -Math.cos(ang);
    const sunPos  = [
      Math.sin(ang),
      baseSunY * cosTilt,
      baseSunY * sinTilt,
    ];

    // Moon position: opt-in calendar-driven phase. When
    // dc.atmosphere.moonPhases is false (the default), the moon sits
    // directly opposite the sun (the classic "full moon at midnight"
    // behavior). When the flag is on, the moon's orbital angle is
    // offset from the sun's by the real synodic phase fraction so
    // the moon visually drifts ahead of or behind the sun across
    // the lunar month. Material in globe.js also reads this flag and
    // chooses Lambert (phase silhouette) or Basic (uniformly bright)
    // accordingly.
    let moonPos;
    if (dc.atmosphere?.moonPhase) {
      const MOON_NEW_REF_MS = Date.UTC(2000, 0, 6, 18, 14, 0);
      const SYNODIC_DAYS = 29.530588853;
      const daysSinceRef = (Date.now() - MOON_NEW_REF_MS) / 86400000;
      const phaseFrac = ((daysSinceRef / SYNODIC_DAYS) % 1 + 1) % 1;
      const moonAng = ang + phaseFrac * 2 * Math.PI;
      const moonBaseY = -Math.cos(moonAng);
      moonPos = [
        Math.sin(moonAng),
        moonBaseY * cosTilt,
        moonBaseY * sinTilt,
      ];
    } else {
      moonPos = [-sunPos[0], -sunPos[1], -sunPos[2]];
    }
    // Light TRAVEL direction = from sun to ground = -sunPos.
    // No clamping needed any more — the floor no longer uses Lambert/
    // Toon (it's MeshBasicMaterial with cycle-driven color modulation
    // below), so horizontal-sun NdotL going to zero doesn't matter.
    // Walls keep proper Lambert/Toon directional shading.
    const dirVec = [-sunPos[0], -sunPos[1], -sunPos[2]];

    // ---- Horizon eclipse ----
    //
    // When the floor is enabled and the sun is below the horizon
    // (sunPos.y < 0), the ground plane physically occludes the sun's
    // directional light — light shouldn't reach the top of the world
    // when the sun is underneath the ground. Mask the directional
    // intensity by a horizon eclipse factor with a SLOW smoothstep so
    // sunrise/sunset are gradual rather than abrupt on/off:
    //   sunPos.y >=  0.2  → eclipse 1 (sun fully above, full light)
    //   sunPos.y <= -0.2  → eclipse 0 (sun fully below, no light)
    //   between           → smoothstep blend (~45 min fade each side of horizon)
    // Total transition: ~1.5 hours spanning sunrise / sunset. If
    // floor.enabled is false, no occluder exists, so light flows
    // through from any sun angle (eclipse always 1). The sun MESH
    // itself stays at its orbital position regardless — it keeps
    // "shining" visually, just its illumination of the world is gated
    // by whether anything is blocking it.
    let eclipseFactor = 1;
    if (s.floor?.enabled !== false) {
      const y = sunPos[1];
      const t = Math.max(0, Math.min(1, (y + 0.2) / 0.4));
      eclipseFactor = t * t * (3 - 2 * t);   // smoothstep
    }
    const effectiveSunIntensity = sunIntensity * eclipseFactor;

    // ---- Apply (skipping lighting if user has overridden manually) ----
    if (cycleLightRefs && !dc.override?.lighting) {
      applyCycleLighting(cycleLightRefs, dc.sunColor || '#ffeed4', effectiveSunIntensity, dirVec, ambColor, ambIntensity);
    }
    if (cycleSkyRefs) {
      applyCycleSky(cycleSkyRefs, skyTop, skyHor, dc.sunColor || '#ffeed4', sunPos, moonPos);
    }

    // ---- Atmosphere: golden hour ----
    //
    // The 1-hour window around dawn AND around dusk when the sun sits
    // low in the atmosphere and the light reads warm orange. Implemented
    // as a triangle-envelope tint on the directional light:
    //   - Window width = ~1 hr (~0.042 in normalized day-T)
    //   - Centered on dawn (T=0.25) and dusk (T=0.75)
    //   - At the peak, sun color lerps 70% toward warm-orange and
    //     intensity bumps +30% (sun feels lower but brighter-orange)
    //   - Outside the windows, no effect (env=0 → no lerp).
    // Skipped when override.lighting is on (user's manual lights win).
    if (dc.atmosphere?.goldenHour) {
      const W = 0.042;
      // Window envelope (0 outside, ramps to 1 at center, ramps back).
      // Compute for BOTH dawn and dusk centers; pick whichever is active.
      const triEnv = (t, c) => {
        const half = W / 2;
        if (t <= c - half || t >= c + half) return 0;
        if (t <= c) return (t - (c - half)) / half;
        return 1 - (t - c) / half;
      };
      const envG_dawn = triEnv(T, 0.25);
      const envG_dusk = triEnv(T, 0.75);
      const envG = Math.max(envG_dawn, envG_dusk);
      // ADDITIVE sun tint (not override). Scale tint by 0.25 instead
      // of 0.7 so the keyframe-driven sun color stays dominant and
      // golden hour just nudges warm. Intensity gets a smaller +10%
      // bump (was +30%) for the same reason. Skipped when override.
      if (envG > 0 && cycleLightRefs && !dc.override?.lighting) {
        const warm = new THREE.Color('#ffb070');
        cycleLightRefs.dir.color.lerp(warm, envG * 0.25);
        cycleLightRefs.dir.intensity *= (1 + envG * 0.10);
      }
      // Apply the atmosphere RINGS regardless of override.lighting —
      // they're a sky-side decoration that doesn't touch directional
      // light values. Compute windowT (position 0..1 within the active
      // half-window). The chosen center is whichever envelope is
      // currently active (dawn or dusk).
      const activeC = envG_dawn >= envG_dusk ? 0.25 : 0.75;
      const windowT = (T - (activeC - W / 2)) / W;
      applyCycleAtmosphereRings('golden', windowT, 0.45);
    } else {
      // Toggle off — make sure rings drop to invisible.
      applyCycleAtmosphereRings('golden', -1, 0);
    }

    // ---- Atmosphere: blue hour ----
    //
    // The ~30-min window JUST BEFORE sunrise and JUST AFTER sunset, when
    // the sun is below the horizon but the sky is still scatter-lit.
    // Implemented as a half-triangle envelope:
    //   - Pre-dawn: ramps from 0 at T=DAWN-W up to 1 at T≈DAWN, then
    //     cuts to 0 right at DAWN (golden hour takes over)
    //   - Post-dusk: 0 at T=DUSK rising to 1 at ~T=DUSK+W/2, falling
    //     to 0 at T=DUSK+W
    //   - Effect: kill directional intensity 90%, shift ambient toward
    //     deep blue-violet. Sky stays whatever the keyframe says (the
    //     midnight/daybreak Moments already cover the sky color).
    if (dc.atmosphere?.blueHour) {
      const W = 0.021;
      // Pre-dawn ramp: 0 at DAWN-W, 1 at DAWN
      const preDawn = (T > 0.25 - W && T <= 0.25) ? (T - (0.25 - W)) / W : 0;
      // Post-dusk ramp: 1 at DUSK, 0 at DUSK+W
      const postDusk = (T >= 0.75 && T < 0.75 + W) ? 1 - (T - 0.75) / W : 0;
      const envB = Math.max(preDawn, postDusk);
      // ADDITIVE blue tint — keep keyframe lights dominant, nudge
      // toward blue-violet rather than fully replacing. Was killing
      // 90% of intensity and lerping ambient 60%; now drops 25%
      // intensity and lerps ambient 25%, so blue hour is felt as a
      // tint rather than a blackout.
      if (envB > 0 && cycleLightRefs && !dc.override?.lighting) {
        const blueViolet = new THREE.Color('#2a3a6a');
        cycleLightRefs.dir.intensity *= (1 - envB * 0.25);
        cycleLightRefs.amb.color.lerp(blueViolet, envB * 0.25);
      }
      // Atmosphere RINGS for blue hour. The blue window spans
      // [DAWN-W..DAWN] and [DUSK..DUSK+W] — two half-windows. Map T
      // into the active half: pre-dawn 0..1 ramps from 0 to 1 then
      // back; we want the staggered ring envelope to play across the
      // full window. Treat each half as its own 0..1 window for ring
      // staggering.
      let bWindowT = -1;
      if (preDawn > 0) {
        // Pre-dawn window starts at T=0.25-W, ends at T=0.25.
        bWindowT = (T - (0.25 - W)) / W;
      } else if (postDusk > 0) {
        // Post-dusk window starts at T=0.75, ends at T=0.75+W.
        bWindowT = (T - 0.75) / W;
      }
      applyCycleAtmosphereRings('blue', bWindowT, 0.50);
    } else {
      applyCycleAtmosphereRings('blue', -1, 0);
    }

    // ---- Atmosphere: morning fog (cycle-driven, independent of world.fog.enabled) ----
    //
    // When dc.atmosphere.fogFades is on, the engine adds its own fog
    // during a 6-hour window that brackets the early morning:
    //   start (04:30, T=0.1875)    → density 0   (1.5 h before dawn)
    //   peak  (07:30, T=0.3125)    → density max (1.5 h after dawn)
    //   end   (10:30, T=0.4375)    → density 0   (1.5 h before noon)
    //   anywhere else              → no fog (from this system)
    // Shifted earlier than the obvious dawn→noon span so the fog has
    // peaked and begun clearing by the time the sun is high — matches
    // real-world morning mist, which thickens before sunrise and
    // burns off by mid-morning. "max" comes from world.fog density ×
    // opacity so the user controls intensity from one place. Works
    // even if world.fog.enabled is OFF — those values still serve as
    // the recipe. When fogFades is off, we don't touch scene.fog
    // (rebuildAll's world.fog handling wins).
    if (dc.atmosphere?.fogFades) {
      const DAWN = 0.1875, NOON = 8.5 / 24;   // 04:30 → 08:30 (4h window total)
      const PEAK = 0.3125;                    // 07:30 fixed (3h rise, 1h fall — sun burns the fog off fast once it's up)
      const worldFog = s.world?.fog || {};
      const maxDens = (worldFog.density ?? 0.025) * (worldFog.opacity ?? 0.35);
      let dens = 0;
      if (T >= DAWN && T <= NOON) {
        if (T <= PEAK) dens = maxDens * ((T - DAWN) / (PEAK - DAWN));
        else           dens = maxDens * (1 - (T - PEAK) / (NOON - PEAK));
      }
      // Use the world fog color or sane default. Always set scene.fog
      // — at density 0 it's invisible but cheap; keeps the active fog
      // object stable so the renderer doesn't churn.
      const horizon = worldFog.color || '#ececec';
      if (!(scene.fog instanceof THREE.FogExp2) || scene.fog.color.getHexString() !== horizon.replace('#','')) {
        scene.fog = new THREE.FogExp2(horizon, dens);
      } else {
        scene.fog.density = dens;
      }
    }

    // ---- Atmosphere: stars fade (cycle-driven, independent of World > Night) ----
    //
    // Stars appear when the sun is below the horizon and fade smoothly
    // around dusk/dawn. Opacity envelope is driven by sunPos.y:
    //   sunPos.y > 0 (sun above horizon)  → opacity 0 (daytime, no stars)
    //   sunPos.y < 0 (sun below horizon)  → opacity ramps up
    //   sunPos.y < -0.3 (sun deep down)   → opacity 1 (full night)
    // smoothstep gives a soft fade so dusk/dawn don't pop. The stars
    // mesh is built in buildStars whenever this flag is on (separately
    // from World > Night), so we just mutate the existing material's
    // opacity per-frame here.
    // Stars fade — opacity envelope tied to sun's vertical position.
    // Fade-in begins 2 hours AFTER dusk and fade-out completes 2 hours
    // BEFORE dawn — stars only visible in the deep middle of night,
    // peaking around midnight.
    //
    // With GLOBE_TILT applied, sunPos.y at:
    //   sunset (ang=3π/2)            =  0
    //   2 hours past sunset (5π/3)   = -0.5 × cosTilt   ← fade-in starts
    //   midnight (ang=0)             = -1   × cosTilt   ← full opacity
    //   2 hours before dawn (π/3)    = -0.5 × cosTilt   ← fade-out ends
    //   dawn (ang=π/2)               =  0
    // Smoothstep envelope: t=0 at edgeStart (2h past dusk / 2h before
    // dawn), t=1 at edgeFull (near midnight depth). Scales correctly
    // with the configured GLOBE_TILT — change the tilt and the fade
    // window stays anchored to "2 hours either side of horizon."
    // Dome opacity is the INVERSE so the dome fades out as stars fade
    // in. Without that, the opaque dome would occlude the stars even
    // at peak opacity.
    {
      const y = sunPos[1];
      const edgeStart = 0.5 * cosTilt;   // y = -0.5 × cosTilt
      const edgeFull  = 0.95 * cosTilt;  // y = -0.95 × cosTilt (near midnight)
      const t = Math.max(0, Math.min(1, (-y - edgeStart) / (edgeFull - edgeStart)));
      const opacity = t * t * (3 - 2 * t);   // smoothstep curve
      applyCycleStarsFade(opacity);
      applyCycleDomeOpacity(cycleSkyRefs, 1 - opacity);
    }

    // Stars counter-rotate at 1/12 the sun's angular rate so the
    // celestial sphere completes one full turn per 12 simulated days.
    // Cumulative angle is tracked outside the day-cycle T so it
    // doesn't reset when T wraps 0..1 at midnight. The frame-delta is
    // wrap-aware: when ang drops from ~2π back toward 0 at midnight
    // we reinterpret the negative delta as forward motion.
    let dAng = ang - lastSunAng;
    if (dAng < -Math.PI) dAng += 2 * Math.PI;
    if (dAng >  Math.PI) dAng -= 2 * Math.PI;
    starsCumulativeRot += -dAng / 12;   // opposite direction, 1/12 rate
    lastSunAng = ang;
    applyCycleStarsRotation(starsCumulativeRot);
  }

  // ---- Render loop ----
  let last = performance.now();
  function tick() {
    requestAnimationFrame(tick);
    const now = performance.now();
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;

    // ---- Day cycle (Phase 4) ----
    //
    // Read state.world.dayCycle. If enabled, compute current T (the
    // 0..1 position in the day) from either the preview override or
    // the cycle's running clock. Snap to 1/96 (15-minute increments)
    // so transitions feel like graphic-novel cels rather than
    // continuous video. Find the surrounding keyframes, lerp each
    // lighting value, and mutate the directional + ambient lights +
    // dome gradient + sun + moon positions in place. When
    // override.lighting is true, the keyframe interpolation is
    // computed but NOT applied to lights — the user's manual values
    // (whatever is in state.sun and state.globe) win.
    runDayCycle(now, dt);

    const snap = inputApi.getSnapshot();
    if (snap.toggleMode) {
      toggleMode(rig);
      $('btn-toggle-mode').textContent = rig.mode;
      mouseProvider.setMode(rig.mode);
    }
    if (snap.paintToggle) {
      const willBeOn = !isPaintModeOn();
      setPaintMode(willBeOn);
      if (willBeOn) {
        showPaintUi();
      } else {
        hidePaintUi();
        // Auto-save when exiting paint mode. Paint is now its own
        // sidecar (levels/<slug>/paint.json) — write directly via
        // storage.savePaint() with the serialized sidecar Maps.
        // We do NOT touch state.paint / state.jpegs anymore; the
        // broadcast loop no longer carries paint, and level.json
        // doesn't either.
        if (hasPaintData()) {
          const payload = serializePaintObject();
          storage.savePaint(SLUG, payload).then(
            () => console.log('[paint] sidecar saved'),
            (e) => console.warn('[paint] sidecar save failed:', e)
          );
        }
      }
    }
    if (snap.paintSwatch && isPaintModeOn()) {
      navSwatch(snap.paintSwatch);
    }
    if (snap.paintBrush && isPaintModeOn()) {
      nudgeBrushSize(snap.paintBrush);
      refreshBrushReadout();
    }
    if (snap.reset) {
      // Teleport to spawn + zero velocity + zero look angles. Escape hatch
      // when the player wedges into geometry or just wants to start over.
      const s2 = state.get();
      const sp = cellToWorld(s2.spawn.rowId, s2.spawn.col, s2.grid.cellSizeMeters);
      if (sp) {
        body.pos.x = sp.x; body.pos.y = 0; body.pos.z = sp.z;
        body.vel.x = 0;     body.vel.y = 0; body.vel.z = 0;
        body.grounded = true;
      }
      inputApi.resetLook();
    }

    rig.targetGroup.rotation.y = snap.yaw;
    rig.pitch = snap.pitch;

    // Smoothly dip the camera + shrink the body when crouch is held.
    updateEyeHeight(rig, snap.crouch, dt);

    const s = state.get();
    if (snap.jump && body.grounded) sfx.jump();

    physicsStep(body, s, {
      forward: snap.forward,
      right:   snap.right,
      yaw:     snap.yaw,
      jump:    snap.jump,
      crouch:  snap.crouch,
    }, dt, aabbs);
    rig.targetGroup.position.set(body.pos.x, body.pos.y, body.pos.z);

    // Audio events: land (false→true grounded), footsteps every ~1.5m walked.
    if (!wasGrounded && body.grounded) sfx.land();
    wasGrounded = body.grounded;
    const dxStep = body.pos.x - lastPos.x;
    const dzStep = body.pos.z - lastPos.z;
    walkedDistance += Math.hypot(dxStep, dzStep);
    lastPos = { x: body.pos.x, z: body.pos.z };
    tickFootsteps(walkedDistance, body.grounded);

    updateRig(rig);
    clipLeashCamera(rig, aabbs);   // keep the leash camera outside walls

    // Leash mode: the player's yaw is already changing (via the mouse rate
    // loop in mouse.js). On top of that, cursor position drives a CAMERA
    // offset so the view tilts as you move the cursor:
    //   Cursor X → camera yaw offset (flipped sign — corrects "opposite
    //              direction" feedback so the camera leans the same way the
    //              player is rotating, amplifying the dashbox drift).
    //   Cursor Y → camera pitch (max ±45° at top/bottom of canvas).
    if (rig.mode === 'leash') {
      const cf = getCursorFraction();
      let yawOff = 0, pitchOff = 0;
      if (cf) {
        const ox = (cf.x - 0.5) * 2;
        const oy = (cf.y - 0.5) * 2;
        const YAW_MAX   = Math.PI / 8;   // 22.5° — subtle camera pan
        const PITCH_MAX = Math.PI / 4;   // 45° — full vertical look range
        yawOff   = -ox * YAW_MAX;        // cursor right → dashbox drifts left of center
        pitchOff = -oy * PITCH_MAX;      // top cursor → look up
      }
      const lt = new THREE.Vector3(
        Math.sin(yawOff) * 100,
        rig.eyeY + Math.tan(pitchOff) * 100,
        Math.cos(yawOff) * 100,
      );
      rig.targetGroup.updateMatrixWorld(true);
      rig.targetGroup.localToWorld(lt);
      rig.camera.lookAt(lt);
    }

    tickEggRaycast(rig.camera, scene);

    // Player marker visible only in leash; crosshair visible only in first-person.
    // Small banking lean (~6° at full cursor offset) so the dashbox tilts
    // toward the direction it's turning. Pure visual flourish — physics
    // doesn't see the roll.
    let leanAngle = 0;
    if (rig.mode === 'leash') {
      const cf = getCursorFraction();
      if (cf) {
        const ox = (cf.x - 0.5) * 2;
        if (Math.abs(ox) > 0.06) leanAngle = ox * (Math.PI / 30);
      }
    }
    updatePlayerMarker(playerMarker, body, rig.mode, rig.targetGroup.rotation.y, leanAngle);
    {
      const sc = s.hud.crosshair;
      setCrosshair(sc.enabled && rig.mode === 'first-person', sc.color, sc.size);
    }

    // HUD update (~10 Hz is enough — text re-rendering)
    if ((performance.now() | 0) % 100 < 16) {
      hudReadout.textContent = [
        `pos  ${body.pos.x.toFixed(1)}, ${body.pos.y.toFixed(2)}, ${body.pos.z.toFixed(1)}`,
        `mode ${rig.mode}${snap.crouch ? ' · crouch' : ''}${body.grounded ? '' : ' · air'}`,
        `keys WASD walk · Space jump · V mode · C/Shift crouch · R reset`,
      ].join('\n');
    }

    // Star sphere follows the CHARACTER (player body) once the character
    // leaves the world globe; inside the globe it stays at the grid
    // centre. The leash camera trails the player by a few metres, so
    // using `body.pos` (the actual player position) is what the user
    // actually means by "the character" — not the camera vantage point.
    updateStars(body.pos);

    // Narration: tick trigger evaluation + frame timing + billboard
    // alignment. Called every render frame but throttles internally
    // to 10 Hz for the heavier trigger eval; billboards update every
    // frame for smooth rotation.
    narration.tick(body.pos, s.grid?.cellSizeMeters || 1);

    // Advance animated plane volumes (water / clouds) so their shader
    // noise & wave patterns drift over time.
    const tSec = performance.now() / 1000;
    // Reuse the per-frame state read for the animation uniforms. `snap`
    // is already declared earlier in this tick scope for input processing,
    // so we read state into a separate local here.
    const planeSnap = state.get();
    for (const m of getAnimatedPlaneMeshes()) {
      const u = m.userData?.volumeUniforms;
      if (u?.uTime) u.uTime.value = tSec;
      const planeKind = m.userData?.planeKind;   // 'floor' | 'ceiling'
      const plane = planeSnap[planeKind];
      if (u?.uSpeed) u.uSpeed.value = plane?.animSpeed ?? 2.0;
      // Cloud Design — live-scrub every knob from state. Note: changes
      // to the palette COLOURS still require a rebuild (DataTexture is
      // built at mesh-creation time), but the 7 numeric knobs scrub
      // smoothly here.
      if (planeKind === 'floor' && u?.uWdEnabled) {
        const wd = plane?.waterDesign;
        u.uWdEnabled.value      = wd?.enabled ? 1.0 : 0.0;
        u.uWdSpeed.value        = wd?.speed       ?? 0.5;
        u.uWdScale.value        = wd?.scale       ?? 0.3;
        u.uWdContrast.value     = wd?.contrast    ?? 0.4;
        u.uWdFlow.value         = wd?.flowAngle   ?? 0;
        u.uWdDepthShift.value   = wd?.depthShift  ?? 0.5;
        u.uWdIntensity.value    = wd?.intensity   ?? 1.0;
        u.uWdCohesion.value     = wd?.cohesion    ?? 0.3;
        u.uWdBubbleDensity.value= wd?.bubbleDensity ?? 0.5;
        u.uWdBubbleBlend.value  = wd?.bubbleBlend   ?? 0.0;
        const phPair = (k) => wd?.[k] || {};
        u.uPhCausticsEn.value  = phPair('caustics').enabled ? 1.0 : 0.0;
        u.uPhCausticsInt.value = phPair('caustics').intensity ?? 0.5;
        u.uPhFoamEn.value      = phPair('foam').enabled ? 1.0 : 0.0;
        u.uPhFoamInt.value     = phPair('foam').intensity ?? 0.5;
        u.uPhRaysEn.value      = phPair('godRays').enabled ? 1.0 : 0.0;
        u.uPhRaysInt.value     = phPair('godRays').intensity ?? 0.3;
        u.uPhRipplesEn.value   = phPair('ripples').enabled ? 1.0 : 0.0;
        u.uPhRipplesInt.value  = phPair('ripples').intensity ?? 0.5;
        u.uPhReflEn.value      = phPair('reflect').enabled ? 1.0 : 0.0;
        u.uPhReflInt.value     = phPair('reflect').intensity ?? 0.3;
        u.uPhDepthFogEn.value  = phPair('depthFog').enabled ? 1.0 : 0.0;
        u.uPhDepthFogInt.value = phPair('depthFog').intensity ?? 0.5;
        u.uPhOverlayEn.value   = phPair('overlay').enabled ? 1.0 : 0.0;
        u.uPhOverlayInt.value  = phPair('overlay').intensity ?? 0.3;
        u.uPhDotsEn.value      = phPair('schools').enabled ? 1.0 : 0.0;
        u.uPhDotsInt.value     = phPair('schools').intensity ?? 0.5;
      }
      if (planeKind === 'ceiling' && u?.uCdEnabled) {
        const cd = plane?.cloudDesign;
        const wantEnabled = cd?.enabled ? 1.0 : 0.0;
        u.uCdEnabled.value   = wantEnabled;
        u.uCdSpeed.value     = cd?.speed     ?? 0.5;
        u.uCdScale.value     = cd?.scale     ?? 0.15;
        u.uCdContrast.value  = cd?.contrast  ?? 0.4;
        u.uCdFlow.value      = cd?.flowAngle ?? 0;
        u.uCdIntensity.value = cd?.intensity ?? 1.0;
        u.uCdShimmer.value   = cd?.shimmer   ?? 0.0;
        u.uCdCohesion.value  = cd?.cohesion  ?? 0.3;
      }
    }

    renderer.render(scene, rig.camera);
  }
  tick();
} catch (err) {
  console.error('[engine] BOOT FAILED:', err);
  if (statusPill) {
    statusPill.style.color = '#a00';
    statusPill.textContent = `boot: ${err.message}`;
  }
}

})();
