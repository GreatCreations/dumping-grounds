// engine/globe.js — skydome sphere with vertical gradient, sun spot, moon
// (diametrically opposite the sun), and a Points cloud of stars on a sphere
// equal in radius to the dome.
//
// Camera-follow stars: the star Points object is exposed via `getStarsMesh`
// so the per-frame tick in engine.js can clamp its centre to the camera's
// world position whenever the camera moves outside the grid bounds. Inside
// the grid, the sphere stays at the world centre (parallax across a 100m
// grid against a 150m radius is small enough to read as infinity). Outside,
// it follows the camera so the apparent distance to every star stays
// exactly = sphere radius — the perfect "stars at infinity" illusion.

import * as THREE from 'three';
import { resolveAssetUrl } from '../core/asset-paths.js';

const _moonDeadUrls = new Set();

// Refs returned by buildGlobe so the per-frame day-cycle hook can
// move the sun + moon along their orbits and recompute the dome's
// vertex-color gradient without rebuilding the whole globe.
//   { domeMesh, domeGeom, sunMesh, moonMesh, center, radius }
export function buildGlobe(rootGlobe, s) {
  rootGlobe.clear();
  const center = gridCenter(s);
  const refs = { domeMesh: null, domeGeom: null, sunMesh: null, moonMesh: null, center: { x: center.x, z: center.z }, radius: s.globe.radius };

  // --- The dome itself ---
  // Always a full sphere. Earlier we tried clipping to a hemisphere when
  // the floor was set to invisible, but that left the lower viewport
  // reading as the renderer's default clear colour (black) — which made
  // the invisible floor look like a black void from any angle that saw
  // past it. Keeping the dome whole means the lower hemisphere shows
  // the horizon-colour sky, which composes correctly under an invisible
  // floor.
  const geom = new THREE.SphereGeometry(s.globe.radius, 48, 24);
  const colors = [];
  const top    = new THREE.Color(s.globe.gradient.top);
  const horiz  = new THREE.Color(s.globe.gradient.horizon);
  const pos = geom.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i) / s.globe.radius;       // -1..1
    // Bias the gradient so the lower hemisphere is mostly horizon color and
    // the top half blends smoothly to "top".
    const t = THREE.MathUtils.clamp((y + 0.2) / 1.2, 0, 1);
    const col = horiz.clone().lerp(top, t);
    colors.push(col.r, col.g, col.b);
  }
  geom.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  // Dome is ALWAYS transparent-capable so the day cycle can fade it
  // out at dusk and reveal the star sphere behind it. Opacity starts
  // at 1 (fully opaque) and is mutated per-frame by
  // applyCycleDomeOpacity from engine.js. When world.night.enabled is
  // true (independent static night), starts at 0 so the night-mode
  // stars show immediately.
  // depthWrite is keyed to whether the dome is currently opaque enough
  // to be considered solid: when opacity ≥ 0.99 the dome writes depth
  // so it correctly occludes the star sphere behind it (essential when
  // day cycle is OFF — dome must block stars). When dome is fading,
  // depthWrite drops to false so stars composite through. The per-
  // frame day-cycle hook (applyCycleDomeOpacity) keeps this in sync.
  const night = !!s.world?.night?.enabled;
  const mat = new THREE.MeshBasicMaterial({
    vertexColors: true,
    side: THREE.BackSide,
    transparent: true,
    opacity: night ? 0 : 1,
    depthWrite: !night,
  });
  const dome = new THREE.Mesh(geom, mat);
  dome.position.set(center.x, 0, center.z);
  dome.rotation.y = s.globe.rotationY ?? 0;
  dome.renderOrder = -10;     // always behind everything else
  rootGlobe.add(dome);
  refs.domeMesh = dome;
  refs.domeGeom = geom;

  // --- Sun spot (a soft disc on the inside of the dome at "top") ---
  // Hidden at night so the sky reads as nighttime.
  // Sun: build whenever sun is visible OR the day cycle is enabled (the
  // cycle needs to orbit + recolour an existing sun mesh). Static night
  // mode still hides it, but only when the cycle is off — with cycle on,
  // the sun's visibility is driven by its orbit position (above horizon
  // = visible, below = naturally hidden by the floor).
  const cycleOn = !!s.world?.dayCycle?.enabled;
  const sunRequested = s.globe.sunSpot?.visible !== false || cycleOn;
  const hideForNight = night && !cycleOn;
  if (sunRequested && !hideForNight) {
    const r = s.globe.radius * 0.06;
    // Sphere not disc — stays round at any orbit angle (a flat disc with
    // lookAt(center) goes edge-on at the horizon and reads as oval).
    const sun = new THREE.Mesh(
      new THREE.SphereGeometry(r, 24, 16),
      new THREE.MeshBasicMaterial({ color: s.globe.sunSpot?.color || '#ffeed4' }),
    );
    sun.position.set(center.x, s.globe.radius * 0.8, center.z);
    sun.renderOrder = -9;
    rootGlobe.add(sun);
    refs.sunMesh = sun;
  }

  // --- Moon — actual sphere, diametrically opposite the sun on the
  // Y axis. SphereGeometry instead of CircleGeometry so the moon
  // reads as a real 3D body that catches the dome's gradient lighting
  // (via vertex colours / shading) and shows volume from any vantage.
  if (s.globe.moon?.visible) {
    const r = s.globe.radius * 0.05;
    const moonTex = s.globe.moon.texture;
    const hasTex = !!(moonTex && (moonTex.url || moonTex.dataUrl));
    // Material picks Lambert vs Basic from the moonPhases atmosphere
    // flag. Lambert lets the directional sun light only the side of
    // the moon facing it, so phases emerge naturally from the
    // sun/moon/viewer geometry. Basic stays uniformly lit (the
    // classic moon-disc-against-sky look) for users who don't want
    // calendar-driven phase rendering.
    const phaseModeOn = !!s.world?.dayCycle?.atmosphere?.moonPhases;
    const moonColor = hasTex ? 0xffffff : (s.globe.moon.color || '#e8e8f0');
    const moonMat = phaseModeOn
      ? new THREE.MeshLambertMaterial({ color: moonColor })
      : new THREE.MeshBasicMaterial({ color: moonColor });
    // Build the moon with custom UVs that PROJECT the texture onto the
    // sphere as a flat disc from BELOW (looking up). Each vertex's UV
    // comes from its position projected onto the XZ plane through the
    // sphere's centre, then mapped to [0,1]. Result: the texture reads
    // as an unstretched flat-disc image when viewed from -Y (the player's
    // up-look angle), with equator/longitude pinching only on the back
    // (top) side which the player never sees.
    const moonGeom = new THREE.SphereGeometry(r, 32, 24);
    const pos = moonGeom.attributes.position;
    const uvs = new Float32Array(pos.count * 2);
    for (let i = 0; i < pos.count; i++) {
      const vx = pos.getX(i), vy = pos.getY(i), vz = pos.getZ(i);
      // Project onto a disc by ignoring Y and normalising X/Z to [0,1].
      // (vx, vz) / r is in [-1, 1] → map to [0, 1].
      uvs[i * 2 + 0] = (vx / r) * 0.5 + 0.5;
      uvs[i * 2 + 1] = (vz / r) * 0.5 + 0.5;
    }
    moonGeom.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    const moon = new THREE.Mesh(moonGeom, moonMat);
    // 50% down from world centre — inside the dome (radius R), pulled
    // in from the previous 80% perch so the moon feels closer overhead
    // rather than pinned to the dome's lower pole.
    moon.position.set(center.x, -s.globe.radius * 0.5, center.z);
    moon.renderOrder = -9;
    rootGlobe.add(moon);
    refs.moonMesh = moon;
    // Wrap the moon's surface with the texture as an equirectangular map
    // (SphereGeometry's built-in UVs already lay out that way: U around
    // longitude, V from south pole to north pole).
    if (hasTex) {
      const loader = new THREE.TextureLoader();
      const src = moonTex.url ? resolveAssetUrl(moonTex.url) : moonTex.dataUrl;
      if (_moonDeadUrls.has(src)) {
        // Skip — already 404'd. Moon stays as flat-colour sphere.
      } else loader.load(src, (texture) => {
        texture.colorSpace = THREE.SRGBColorSpace;
        texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
        // Moon texture sits in its natural orientation — no UV flips.
        // The tidal-lock orientation (lookAt(center) + rotateX(-π/2))
        // already lands the texture's source orientation correctly
        // against the player's upward gaze, so any axis mirror added
        // here reads as an off-by-180° rotation from the source image.
        moonMat.map = texture;
        moonMat.needsUpdate = true;
      }, undefined, () => { _moonDeadUrls.add(src); });
    }
    // No rotation needed — the custom XZ-disc UVs (built above) put the
    // texture's centre directly on the moon's underside, where the
    // player looks up at it from. Equator pinching is on the top side
    // (which the player can't see from below).
  }

  return refs;
}

// Day-cycle helpers — mutate the globe refs in-place per frame.
//
// applyCycleSky: recompute the dome's vertex-colour gradient from new
// top/horizon colours (same lerp the build path uses), update sun
// disc colour, and reposition sun + moon along their orbit. sunPos
// and moonPos are normalised vectors (length 1) on the great circle;
// they're scaled to the dome's radius and offset by the globe centre.
export function applyCycleSky(refs, skyTop, skyHorizon, sunDiscColor, sunPos, moonPos) {
  if (!refs?.domeGeom) return;
  // Recompute vertex colors. The pattern matches the build code: y
  // normalised to -1..1, biased so the horizon dominates the lower
  // hemisphere, lerped between horizon and top colours.
  const top   = new THREE.Color(skyTop);
  const horiz = new THREE.Color(skyHorizon);
  const pos   = refs.domeGeom.attributes.position;
  const colAttr = refs.domeGeom.attributes.color;
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i) / refs.radius;
    const t = Math.max(0, Math.min(1, (y + 0.2) / 1.2));
    const c = horiz.clone().lerp(top, t);
    colAttr.setXYZ(i, c.r, c.g, c.b);
  }
  colAttr.needsUpdate = true;
  // Sun colour + position (sphere — no orientation needed, round from any angle).
  if (refs.sunMesh) {
    refs.sunMesh.material.color.set(sunDiscColor);
    const r = refs.radius * 0.8;
    refs.sunMesh.position.set(
      refs.center.x + sunPos[0] * r,
      sunPos[1] * r,
      refs.center.z + sunPos[2] * r,
    );
  }
  if (refs.moonMesh) {
    const r = refs.radius * 0.5;
    refs.moonMesh.position.set(
      refs.center.x + moonPos[0] * r,
      moonPos[1] * r,
      refs.center.z + moonPos[2] * r,
    );
    // Tidal lock: keep the textured face (mapped onto local -Y by the
    // custom XZ-disc UVs at build time) pointed at the ground centre.
    // lookAt orients local -Z at the target; rotating -90° around X
    // then swings local -Y into where -Z was pointing — so the texture
    // hub stays aimed at (center, 0, center) regardless of orbit angle.
    refs.moonMesh.lookAt(refs.center.x, 0, refs.center.z);
    refs.moonMesh.rotateX(-Math.PI / 2);
  }
}

// Star sphere — completely independent from the dome / rootGlobe. Built
// by engine.js (it owns the parent group + per-frame update) so the star
// sphere can be freely re-parented and re-centred without touching the
// dome's transform hierarchy.
let _starsMesh = null;
let _starsDomeRadius = 0;
let _starsGridCenter = new THREE.Vector3();

export function buildStars(parentGroup, s) {
  // Remove old.
  if (_starsMesh) {
    if (_starsMesh.parent) _starsMesh.parent.remove(_starsMesh);
    _starsMesh.geometry?.dispose();
    _starsMesh.material?.dispose();
    _starsMesh = null;
  }
  // Build stars when either World > Night ticks them OR when the day
  // cycle's starsFade atmosphere flag is on (independent of Night —
  // the cycle drives opacity per-frame via applyCycleStarsFade).
  const cycleWantsStars = !!s.world?.dayCycle?.atmosphere?.starsFade;
  if (!s.globe.stars?.visible && !cycleWantsStars) return;

  const center = gridCenter(s);
  _starsGridCenter.set(center.x, 0, center.z);
  _starsDomeRadius = s.globe.radius;
  const N      = Math.max(0, Math.min(20000, s.globe.stars.count ?? 3000));
  const sizePx = s.globe.stars.sizePx ?? 4;
  const sphereRadius = s.globe.radius * 1.5;   // bigger than dome so it always encloses

  const positions = new Float32Array(N * 3);
  for (let i = 0; i < N; i++) {
    const z   = Math.random() * 2 - 1;
    const phi = Math.random() * 2 * Math.PI;
    const rxy = Math.sqrt(1 - z * z);
    positions[i * 3 + 0] = Math.cos(phi) * rxy * sphereRadius;
    positions[i * 3 + 1] = z * sphereRadius;
    positions[i * 3 + 2] = Math.sin(phi) * rxy * sphereRadius;
  }
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  const mat = new THREE.PointsMaterial({
    color: 0xffffff,
    size: sizePx,
    sizeAttenuation: false,   // fixed on-screen pixel size = infinite distance
    transparent: true,
    depthWrite: false,
    // depthTest stays ON so other geometry (walls, plates, objects)
    // correctly occludes the stars when between camera and the sphere
    // surface. Stars sit "behind everything" because they're physically
    // far out at 1.5× the dome radius.
    depthTest: true,
  });
  const stars = new THREE.Points(geom, mat);
  stars.frustumCulled = false;   // don't drop when "outside" the camera frustum
  stars.position.copy(_starsGridCenter);
  stars.renderOrder = -8;
  parentGroup.add(stars);
  _starsMesh = stars;
}

// Day-cycle fade hook. opacity in [0,1]. Sets the star material's
// opacity in-place each frame — no rebuild needed. If stars weren't
// built (no World > Night and no atmosphere.starsFade), this is a
// no-op. When called with opacity 0 the stars are still drawn but
// fully transparent (cheap; no per-frame branching needed).
export function applyCycleStarsFade(opacity) {
  if (!_starsMesh) return;
  _starsMesh.material.opacity = Math.max(0, Math.min(1, opacity));
}

// Day-cycle rotation hook. Spins the star sphere around the world's
// vertical axis. Called every frame with an angle in radians; the
// caller (engine.js runDayCycle) passes the NEGATIVE of the sun's
// orbital angle so the stars counter-rotate against the sun and moon —
// the celestial sphere drifting opposite the day cycle's prograde.
// No-op when stars weren't built (no _starsMesh).
export function applyCycleStarsRotation(yRot) {
  if (!_starsMesh) return;
  _starsMesh.rotation.y = yRot;
}

// ---- Atmosphere rings (golden / blue hour halos) ----
//
// Horizontal bands wrapping the dome at the horizon and rising to ~45°
// elevation. Thickest at the horizon, tapering thinner as they rise —
// a stack of semi-transparent bands that look like comic-book retro
// heat-waves / light gradient stripes. Used during golden hour (warm
// gold) and blue hour (cool sky blue) to ADD a tinted horizon halo
// without altering the keyframe-driven sun color.
//
// Per-frame the engine calls `applyCycleAtmosphereRings(refs, t, color,
// active)` to set each ring's opacity. The bands fade in sequentially
// from the horizon up (one band at a time) during the first half of
// the active window, then reverse-fade (highest first, horizon last)
// during the second half. When the window's `active` flag is false,
// all rings drop to opacity 0 and the materials are invisible.

const _RING_COUNT = 5;
// Elevation (radians) of each ring's centre above the horizon.
// 0 = horizon, π/4 = 45°. Evenly spaced.
const _RING_ELEVATIONS = (() => {
  const out = [];
  for (let i = 0; i < _RING_COUNT; i++) {
    out.push((i / (_RING_COUNT - 1)) * (Math.PI / 4));
  }
  return out;
})();
// Half-thickness (radians) per ring. Thickest at horizon, tapering
// linearly to thinnest at the top of the stack.
const _RING_HALF_THICKNESS = (() => {
  const out = [];
  // 5° at horizon → 1° at top, linearly tapering.
  for (let i = 0; i < _RING_COUNT; i++) {
    const deg = 5 - (i / (_RING_COUNT - 1)) * 4;
    out.push(deg * Math.PI / 180);
  }
  return out;
})();

// Mesh pair for each color tier. Built once at scene init and reused
// every frame via opacity mutation. The two sets share the same
// geometry parameters but live as separate scene-graph entries so
// gold and blue can be active simultaneously during the overlap
// window without one masking the other.
let _goldenRingMeshes = [];
let _blueRingMeshes   = [];

export function buildAtmosphereRings(parentGroup, s) {
  // Tear down any previous build.
  for (const m of _goldenRingMeshes) {
    if (m.parent) m.parent.remove(m);
    m.geometry?.dispose();
    m.material?.dispose();
  }
  for (const m of _blueRingMeshes) {
    if (m.parent) m.parent.remove(m);
    m.geometry?.dispose();
    m.material?.dispose();
  }
  _goldenRingMeshes = [];
  _blueRingMeshes   = [];

  const dc = s?.world?.dayCycle;
  if (!dc) return;
  const goldenOn = !!dc.atmosphere?.goldenHour;
  const blueOn   = !!dc.atmosphere?.blueHour;
  if (!goldenOn && !blueOn) return;

  const center = gridCenter(s);
  // Place rings JUST INSIDE the dome so they composite over the sky
  // gradient and behind the sun/moon meshes (which live further in).
  const r = s.globe.radius * 0.985;

  const makeRing = (color, elevation, halfThickness) => {
    // Three.js sphere theta: 0 at +Y north pole, π at -Y south pole.
    // Equator (horizon) is at π/2. For a ring at elevation θe ABOVE
    // the horizon, the band's central theta = π/2 − θe, with the band
    // spanning ±halfThickness around that.
    const thetaCentre = (Math.PI / 2) - elevation;
    const thetaStart  = thetaCentre - halfThickness;
    const thetaLength = halfThickness * 2;
    const geom = new THREE.SphereGeometry(
      r, 64, 8,
      0, Math.PI * 2,        // phi span (full circle around vertical)
      thetaStart, thetaLength,
    );
    const mat = new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: 0,            // mutated per-frame by applyCycleAtmosphereRings
      side: THREE.BackSide,  // visible from inside the dome
      depthWrite: false,     // don't occlude the star sphere behind
    });
    const mesh = new THREE.Mesh(geom, mat);
    mesh.position.set(center.x, 0, center.z);
    mesh.renderOrder = -9;   // after dome (-10), before sun/moon (-9 too — order by build order)
    parentGroup.add(mesh);
    return mesh;
  };

  if (goldenOn) {
    const GOLD = 0xffc070;
    for (let i = 0; i < _RING_COUNT; i++) {
      _goldenRingMeshes.push(
        makeRing(GOLD, _RING_ELEVATIONS[i], _RING_HALF_THICKNESS[i])
      );
    }
  }
  if (blueOn) {
    const BLUE = 0x7090c0;
    for (let i = 0; i < _RING_COUNT; i++) {
      _blueRingMeshes.push(
        makeRing(BLUE, _RING_ELEVATIONS[i], _RING_HALF_THICKNESS[i])
      );
    }
  }
}

// Per-ring opacity envelope. The window time `t` is normalized 0..1
// across the active window. Each ring i has a fade-in slot earlier in
// the window (i=0 first, i=N-1 last) and a fade-out slot LATER in the
// second half mirrored so the topmost ring fades out first and the
// horizon ring fades out last. All rings hit peak opacity briefly at
// t=0.5 (the centre of the window). Multiplied by `peakOpacity` so
// the actual maximum semi-transparency can be tuned per call.
function _ringEnvelope(t, ringIndex) {
  if (t <= 0 || t >= 1) return 0;
  const N = _RING_COUNT;
  const slotW = 0.5 / N;
  const fadeInStart  = ringIndex * slotW;
  const fadeInEnd    = fadeInStart + slotW;
  const fadeOutStart = 0.5 + (N - 1 - ringIndex) * slotW;
  const fadeOutEnd   = fadeOutStart + slotW;
  if (t < fadeInStart)  return 0;
  if (t < fadeInEnd)    return (t - fadeInStart) / slotW;
  if (t < fadeOutStart) return 1;
  if (t < fadeOutEnd)   return 1 - (t - fadeOutStart) / slotW;
  return 0;
}

// Per-frame opacity update. windowT is the normalized 0..1 position
// within the active hour-window; peakOpacity caps the maximum
// opacity per ring (typically 0.4–0.5 for semi-transparent halos).
export function applyCycleAtmosphereRings(kind, windowT, peakOpacity) {
  const meshes = kind === 'golden' ? _goldenRingMeshes
              :  kind === 'blue'   ? _blueRingMeshes
              :  null;
  if (!meshes || !meshes.length) return;
  for (let i = 0; i < meshes.length; i++) {
    const env = _ringEnvelope(windowT, i);
    meshes[i].material.opacity = env * peakOpacity;
  }
}

// Day-cycle dome opacity hook. The dome (sky gradient) is now always
// rendered with `transparent: true`; this lets the cycle fade the
// dome OUT during night hours so the star sphere behind it shows.
// opacity = 1 means fully opaque (clear daytime sky, no stars showing);
// opacity = 0 means fully transparent (night, stars fully visible).
// Caller derives opacity from sun position (typically 1 - starsOpacity).
export function applyCycleDomeOpacity(refs, opacity) {
  if (!refs?.domeMesh) return;
  const mat = refs.domeMesh.material;
  const o = Math.max(0, Math.min(1, opacity));
  mat.opacity = o;
  // Toggle depthWrite based on opacity so a fully-opaque dome still
  // occludes the star sphere behind it (critical when day cycle is off
  // and night is off — dome must read as a solid sky, not a see-
  // through shell). When fading below near-1 opacity, depthWrite drops
  // off so the stars composite through correctly.
  const wantDepth = o >= 0.99;
  if (mat.depthWrite !== wantDepth) {
    mat.depthWrite = wantDepth;
    mat.needsUpdate = true;
  }
}

// Per-frame camera-follow. When camera is INSIDE the dome, stars stay at
// the grid centre. When OUTSIDE, the sphere centre snaps to camera — so
// from any viewpoint, every star is exactly sphereRadius away (perfect
// "infinity" parallax). 3D distance includes Y so falling out of the world
// triggers the follow too.
export function updateStars(cameraPos) {
  if (!_starsMesh) return;
  const dx = cameraPos.x - _starsGridCenter.x;
  const dy = cameraPos.y - _starsGridCenter.y;
  const dz = cameraPos.z - _starsGridCenter.z;
  const dist = Math.hypot(dx, dy, dz);
  if (dist <= _starsDomeRadius) {
    _starsMesh.position.copy(_starsGridCenter);
  } else {
    _starsMesh.position.set(cameraPos.x, cameraPos.y, cameraPos.z);
  }
}

function gridCenter(s) {
  const { rows, cols, cellSizeMeters } = s.grid;
  return { x: (cols * cellSizeMeters) / 2, z: (rows * cellSizeMeters) / 2 };
}
