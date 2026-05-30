// engine/lights.js — directional sun + ambient fill.
// MeshBasicMaterial ignores lights, but lights still matter for any glTF
// content we import (plant.glb) which uses MeshStandard by default.

import * as THREE from 'three';

// Three.js r0.155+ applies a physical 1/π BRDF normalization in lit materials
// (Lambert, Toon, Standard). Without compensation, an "intensity 1.0"
// directional light only lands at ~32% perceived brightness on a Lambertian
// surface — which is why toon-shaded walls read as dark grey instead of
// white. We multiply the DIRECTIONAL intensity by π here so that intensity
// 1.0 in the level state means "full brightness." Ambient stays unscaled so
// shadowed faces keep their current dimmer level — only the lit side gets
// the boost. MeshBasicMaterial content (default walls, floor, ceiling,
// primitives) ignores lights, so this only affects toon-shaded walls and
// imported GLBs.
const BRDF_NORMALISATION = Math.PI;

// Returns { dir, amb } refs so the caller (engine.js) can keep them
// and mutate per frame when the day cycle is active. The lights are
// recreated each time buildLights runs (rebuild on state change); the
// returned refs are valid only until the next call.
export function buildLights(rootLights, s) {
  rootLights.clear();
  const d = s.sun.directional.direction;
  const dir = new THREE.DirectionalLight(
    s.sun.directional.color,
    s.sun.directional.intensity * BRDF_NORMALISATION,
  );
  // Light position needs to be on the sun's side of the world centre,
  // not at the absolute world point (-d * 100). Previous formula
  // missed the target offset, so the actual shine direction differed
  // from the configured `d` and shadows landed in a direction that
  // didn't match the visible sun on the dome — most obvious after
  // the orbit tilt was introduced. Position the light relative to
  // the world-centre target so (position → target) lines up with d
  // exactly.
  const CX = 50, CY = 0, CZ = 50;
  const LIGHT_DIST = 100;
  dir.position.set(
    CX - d[0] * LIGHT_DIST,
    CY - d[1] * LIGHT_DIST,
    CZ - d[2] * LIGHT_DIST,
  );
  dir.target.position.set(CX, CY, CZ);

  // Shadow setup — independent of toon shading. Only the sun casts
  // shadows; ambient is global and direction-less so it doesn't.
  // Frustum sized to comfortably cover the 100×100 grid (50m radius
  // around the world centre at 50,0,50) with margin. 2048² map gives
  // crisp edges across that span; BasicShadowMap matches the inked
  // hard-edge aesthetic (PCF would soften too much). Negative bias
  // pulls the shadow comparison slightly toward the light so
  // self-shadow acne on lit faces doesn't speckle.
  if (s.world?.shadows?.enabled) {
    dir.castShadow = true;
    // 8192² shadow map over a ±60m frustum → ~1.5 cm per texel. At
    // this resolution PCF's one-texel anti-alias is sub-millimetre
    // in screen space at any normal viewing distance, so edges read
    // as truly sharp lines instead of pixelated stair-steps. ~256 MB
    // of GPU memory, fine on any modern desktop GPU but borderline
    // on integrated graphics. This is the resolution ceiling of a
    // single-map directional shadow — beyond this you need cascaded
    // shadow maps (multi-tier resolution).
    dir.shadow.mapSize.set(8192, 8192);
    const camS = dir.shadow.camera;
    camS.left = -60; camS.right = 60;
    camS.top = 60;   camS.bottom = -60;
    camS.near = 0.5; camS.far = 250;
    camS.updateProjectionMatrix();
    // bias = flat depth offset (anti-acne on faces angled away from
    // the sun). normalBias = depth offset along the surface normal —
    // when this is too high, shadows DETACH from the caster's base
    // ("Peter Panning"), leaving a visible gap between an object and
    // its own shadow on the ground. Values tuned for the 8192² map
    // at this ±60m frustum: smaller bias since the higher resolution
    // doesn't need as much offset to avoid acne, and a normalBias
    // small enough that shadows still touch their caster's base.
    // Bias values zeroed out to fully attach shadows to their
    // casters' bases. Peter Panning gap was still visible at
    // bias=-0.00002 / normalBias=0.005, so we go further. At 8192²
    // shadow map resolution with a ±60m frustum (~1.5 cm per texel),
    // depth precision is high enough that bias=0 + normalBias=0
    // shouldn't introduce visible shadow acne. If a dot-speckle
    // pattern appears on lit floors, bump normalBias back up to
    // ~0.002 (the minimum that still attaches shadows for this map).
    // Small POSITIVE bias keeps the shadow attached to the caster's
    // base in this engine. The conventional Three.js direction
    // (negative bias = closer to caster) read the wrong way for what
    // the user was seeing — going more negative widened the gap
    // rather than closing it. Positive bias closes it instead.
    // At 8192² resolution the precision is high enough to accept a
    // small positive bias without re-introducing Peter Panning at
    // any meaningful distance.
    dir.shadow.bias = 0.00001;
    dir.shadow.normalBias = 0;
    // PCFSoftShadowMap kernel width multiplier. 1 = the default 4×4
    // sample spread (~half a shadow texel of softness). 4 widens the
    // soft-falloff zone to ~2 texels of gradient, which reads as a
    // gentle inked rim at the shadow boundary instead of a thin line.
    // Larger values smear the gradient over more pixels; smaller
    // values tighten it back toward a hard edge. Tunable target if
    // the rim doesn't read as enough of an "edge line."
    dir.shadow.radius = 4;
  }

  rootLights.add(dir);
  rootLights.add(dir.target);
  const amb = new THREE.AmbientLight(
    s.sun.ambient.color,
    s.sun.ambient.intensity,
  );
  rootLights.add(amb);
  return { dir, amb };
}

// Day-cycle helper used by the tick loop. Mutates the existing light
// objects in place so we don't churn Three.js objects every frame.
// `dirVec` is the directional light's TRAVEL direction (where rays
// point); the light's POSITION goes in the opposite direction at
// distance 100.
export function applyCycleLighting(lights, sunColor, sunIntensity, dirVec, ambColor, ambIntensity) {
  if (!lights?.dir || !lights?.amb) return;
  lights.dir.color.set(sunColor);
  lights.dir.intensity = sunIntensity * BRDF_NORMALISATION;
  // Match the same target-relative formula buildLights uses so the
  // day-cycle hook keeps light direction aligned with the visible
  // sun every frame.
  lights.dir.position.set(
    50 - dirVec[0] * 100,
    0  - dirVec[1] * 100,
    50 - dirVec[2] * 100,
  );
  lights.amb.color.set(ambColor);
  lights.amb.intensity = ambIntensity;
}
