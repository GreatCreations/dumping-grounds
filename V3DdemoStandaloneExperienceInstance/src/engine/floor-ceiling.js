// engine/floor-ceiling.js — bounded floor + optional ceiling planes.
//
// Both planes are 100×100 (NOT infinite) per the locked spec. Each gets an
// inked-comic edge stroke (thin black border) so it's distinguishable from
// the skydome behind it.
//
// `style` per plane chooses the render path:
//   solid                — flat color / baseTexture fill (the original look).
//   grate / skylight     — wireframe grid: 1 m lines, transparent between.
//   invisible            — fully transparent fill; PNG baseTexture alpha
//                          shows through (transparent pixels = holes).
//   water (floor only)   — translucent volume below the floor with wavy
//                          line modulation. Comic-book "deep water" look.
//   clouds (ceiling only)— translucent volume above the ceiling with cloudy
//                          blob modulation. Comic-book "stormy sky" look.

import * as THREE from 'three';
import * as BufferGeometryUtils from 'three/addons/utils/BufferGeometryUtils.js';
import { resolveAssetUrl } from '../core/asset-paths.js';
import { makeToonGradient } from './walls.js';

// Volume meshes that need per-frame animation. engine.js reads this list
// each frame to advance their shader time uniforms.
const _animated = [];
export function getAnimatedPlaneMeshes() { return _animated; }

export function buildFloor(root, s) {
  root.clear();
  if (!s.floor.enabled) return;
  const { rows, cols, cellSizeMeters } = s.grid;
  const w = cols * cellSizeMeters;
  const d = rows * cellSizeMeters;
  buildPlane(root, s.floor, w, d, 'floor', s);
}

export function buildCeiling(root, s) {
  root.clear();
  if (!s.ceiling.enabled) return;
  const { rows, cols, cellSizeMeters } = s.grid;
  const w = cols * cellSizeMeters;
  const d = rows * cellSizeMeters;
  buildPlane(root, s.ceiling, w, d, 'ceiling', s);
}

function buildPlane(root, planeState, w, d, kind, s) {
  // Strip any previously-registered animated meshes for this plane on a
  // rebuild. _animated is shared by floor + ceiling so filter by tag.
  for (let i = _animated.length - 1; i >= 0; i--) {
    if (_animated[i].userData?.planeKind === kind) _animated.splice(i, 1);
  }
  const style = planeState.style || 'solid';
  const wireframeStyles = (kind === 'floor') ? 'grate' : 'skylight';
  if (style === wireframeStyles) {
    buildWireframeGrid(root, planeState, w, d, kind);
    return;
  }
  if (style === 'invisible') {
    buildInvisible(root, planeState, w, d, kind);
    return;
  }
  if (kind === 'floor' && style === 'water') {
    buildFogVolume(root, planeState, w, d, kind, 'water', s);
    return;
  }
  if (kind === 'ceiling' && style === 'clouds') {
    buildFogVolume(root, planeState, w, d, kind, 'clouds', s);
    return;
  }
  buildSolid(root, planeState, w, d, kind, s);
}

// --- 'solid' (original behaviour) -----------------------------------------
function buildSolid(root, planeState, w, d, kind, s) {
  const geom = new THREE.PlaneGeometry(w, d);
  geom.rotateX(kind === 'floor' ? -Math.PI / 2 : Math.PI / 2);
  const mat = makeSolidMaterial(planeState, w, d, kind, s);
  const mesh = new THREE.Mesh(geom, mat);
  mesh.position.set(w / 2, planeState.y, d / 2);
  mesh.renderOrder = 0;
  mesh.userData.paintableSurface = kind;
  root.add(mesh);
  // Floor used to get a white edge stroke around its outer rectangle;
  // removed per user request so the floor sits as a clean rectangle
  // with no white border outline. Grate/wireframe floor variants keep
  // their own per-cell strokes (handled in their own builders).
}

function makeSolidMaterial(planeState, w, d, kind, s) {
  const doubleSide = kind === 'ceiling';
  const baseTex = planeState.baseTexture;
  const baseSrc = baseTex && (baseTex.url || baseTex.dataUrl);
  // Floor lighting: when planeState.lit is true (default), the floor
  // responds to the directional sun + ambient light. Toon-shading on
  // → MeshToonMaterial (matches walls' cel-shaded look). Toon off →
  // MeshLambertMaterial (smooth diffuse). Textures are still applied
  // via .map on Lambert/Toon (both expose .map and tint through with
  // material.color). When planeState.lit is false, MeshBasicMaterial
  // (flat, ignores lights). Ceilings always get MeshBasicMaterial.
  const wantsLighting = (kind === 'floor') && (planeState.lit !== false);
  let mat;
  if (wantsLighting) {
    const toonOn = !!s?.world?.toonShading?.enabled;
    if (toonOn) {
      mat = new THREE.MeshToonMaterial({
        color: baseSrc ? 0xffffff : planeState.color,
        gradientMap: makeToonGradient(s?.world?.toonShading?.levels),
        side: doubleSide ? THREE.DoubleSide : THREE.FrontSide,
        polygonOffset: true,
        polygonOffsetFactor: 1,
        polygonOffsetUnits: 1,
      });
    } else {
      mat = new THREE.MeshLambertMaterial({
        color: baseSrc ? 0xffffff : planeState.color,
        side: doubleSide ? THREE.DoubleSide : THREE.FrontSide,
        polygonOffset: true,
        polygonOffsetFactor: 1,
        polygonOffsetUnits: 1,
      });
    }
  } else {
    mat = new THREE.MeshBasicMaterial({
      color: baseSrc ? 0xffffff : planeState.color,
      side: doubleSide ? THREE.DoubleSide : THREE.FrontSide,
      polygonOffset: true,
      polygonOffsetFactor: 1,
      polygonOffsetUnits: 1,
    });
  }
  if (!baseSrc) return mat;
  attachPlaneTexture(mat, baseTex, w, d, /*transparent*/ false);
  return mat;
}

// --- 'grate' / 'skylight' --------------------------------------------------
// Comic-book grate: build the slab as ONE filled outer plane minus per-hole
// rectangular cut-outs (drawn as 4 inked sides per gap), with the inked
// outline produced PER HOLE so each crossing's interior is a clean square
// hole and no two bars share overlapping geometry that would seam at the
// intersection. Drawn entirely from manual triangle lists — no
// ExtrudeGeometry triangulator, no per-bar bars.
function buildWireframeGrid(root, planeState, w, d, kind) {
  const THICK = 0.12;       // bar thickness in the plane
  const halfBar = THICK / 2;
  const yMid = planeState.y;
  const W = Math.round(w);
  const D = Math.round(d);

  // Build the slab fill as one rectangle per cell-edge frame:
  // each grid cell (1×1m) contributes a single inset "frame" geometry —
  // outer rect == the cell, inner rect == the cell minus halfBar margin.
  // Each frame is 8 triangles (2 per side). N×M cells → N×M*8 triangles.
  // No two cell-frames overlap in 3D, so there is NO seam to clean up at
  // any intersection: cells abut along their edges and share the inked
  // crosshair as a single bar-width strip belonging to one cell.
  //
  // For 100×100 = 80k triangles total — well within budget.
  const positions = [];
  const pushQuad = (x0, z0, x1, z1) => {
    positions.push(
      x0, yMid, z0,  x1, yMid, z0,  x1, yMid, z1,
      x0, yMid, z0,  x1, yMid, z1,  x0, yMid, z1,
    );
  };
  for (let z = 0; z < D; z++) {
    for (let x = 0; x < W; x++) {
      const x0 = x, x1 = x + 1, z0 = z, z1 = z + 1;
      const ix0 = x0 + halfBar, ix1 = x1 - halfBar;
      const iz0 = z0 + halfBar, iz1 = z1 - halfBar;
      // 4 quads making up the cell's frame (top / bottom / left / right
      // strips around the inset hole).
      pushQuad(x0,  z0,  x1,  iz0);   // top strip
      pushQuad(x0,  iz1, x1,  z1);    // bottom strip
      pushQuad(x0,  iz0, ix0, iz1);   // left strip
      pushQuad(ix1, iz0, x1,  iz1);   // right strip
    }
  }

  // Grate / skylight body — uniform OFF-WHITE silhouette material with
  // no stroke overlay. Bars read as paper-white rectangles on the page;
  // overlapping bars at intersections paint over each other in the same
  // colour (white-on-white) so there's no double-line seam mechanism.
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  const matFill = new THREE.MeshBasicMaterial({
    color: 0xfafaf7,                 // off-white — matches scene fill
    side: THREE.DoubleSide,
    polygonOffset: true,
    polygonOffsetFactor: 1,
    polygonOffsetUnits: 1,
  });
  const fillMesh = new THREE.Mesh(geom, matFill);
  fillMesh.renderOrder = 0;
  root.add(fillMesh);

  // Invisible flat plane behind the bars so the paint tool still has a
  // raycast target on the gaps.
  const hitGeom = new THREE.PlaneGeometry(w, d);
  hitGeom.rotateX(kind === 'floor' ? -Math.PI / 2 : Math.PI / 2);
  const hitMat = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false });
  const hit = new THREE.Mesh(hitGeom, hitMat);
  hit.position.set(w / 2, yMid, d / 2);
  hit.userData.paintableSurface = kind;
  root.add(hit);
}

// Same coincident-triangle stripper walls.js uses — after mergeVertices
// welds shared boundary vertices, intersection-internal triangles end up
// with identical sorted vertex index triples (two copies, opposite
// winding). Removing pairs that share a sorted triple kills the seam
// without affecting external faces.
function removeCoincidentTriangles(geom) {
  if (!geom.index) return geom;
  const idx = geom.index.array;
  const triCount = idx.length / 3;
  const buckets = new Map();
  for (let t = 0; t < triCount; t++) {
    let a = idx[t * 3], b = idx[t * 3 + 1], c = idx[t * 3 + 2];
    if (a > b) { const x = a; a = b; b = x; }
    if (b > c) { const x = b; b = c; c = x; }
    if (a > b) { const x = a; a = b; b = x; }
    const key = `${a},${b},${c}`;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(t);
  }
  const remove = new Set();
  for (const tris of buckets.values()) {
    if (tris.length >= 2) for (const t of tris) remove.add(t);
  }
  if (!remove.size) return geom;
  const keptIdx = [];
  for (let t = 0; t < triCount; t++) {
    if (remove.has(t)) continue;
    keptIdx.push(idx[t * 3], idx[t * 3 + 1], idx[t * 3 + 2]);
  }
  geom.setIndex(keptIdx);
  return geom;
}

// --- 'invisible' -----------------------------------------------------------
// Plane mesh with `transparent: true` and color/opacity 0 when no texture.
// With a PNG baseTexture, transparent pixels in the PNG stay transparent
// (so the user sees through), opaque pixels render in space.
function buildInvisible(root, planeState, w, d, kind) {
  const baseTex = planeState.baseTexture;
  const baseSrc = baseTex && (baseTex.url || baseTex.dataUrl);
  // No texture = nothing renders at all for this plane. Don't add a mesh,
  // don't add an edge stroke, don't add a paintable hit target. The
  // floor / ceiling is GONE from the scene.
  if (!baseSrc) return;
  // With a PNG texture: render the visible bits, let transparent PNG
  // pixels become real see-through holes.
  const geom = new THREE.PlaneGeometry(w, d);
  geom.rotateX(kind === 'floor' ? -Math.PI / 2 : Math.PI / 2);
  const mat = new THREE.MeshBasicMaterial({
    transparent: true,
    opacity: 1,
    depthWrite: false,
    side: THREE.DoubleSide,
    color: 0xffffff,
    alphaTest: 0.01,
  });
  attachPlaneTexture(mat, baseTex, w, d, /*transparent*/ true);
  const mesh = new THREE.Mesh(geom, mat);
  mesh.position.set(w / 2, planeState.y, d / 2);
  mesh.userData.paintableSurface = kind;
  root.add(mesh);
  if (kind !== 'ceiling') addEdgeStroke(root, geom, mesh.position);
}

// --- 'water' / 'clouds' (animated fog volume) ------------------------------
// A thick translucent box below the floor (water) or above the ceiling
// (clouds). The fragment shader fades opacity with depth into the volume
// AND modulates it with stylized noise — wavy stripes for water, blobby
// pseudo-clouds for sky. Always pure inked-comic palette (off-white +
// horizon-cool for water, off-white + horizon-warm for clouds), no
// realistic shading.
const VOLUME_DEPTH = 8;       // metres of fog volume thickness
function buildFogVolume(root, planeState, w, d, kind, mode, s) {
  // Geometry — a thin box ABOVE (clouds) or BELOW (water) the plane.
  const yBottom = (kind === 'floor')
    ? planeState.y - VOLUME_DEPTH
    : planeState.y;
  const yTop = yBottom + VOLUME_DEPTH;
  // 3× sky stretch applies to CLOUDS only (the user's "sky plane").
  // X + Z (NSEW) scaled, Y untouched — clouds stretch out to the
  // horizon without raising the cloud layer's altitude. Water keeps
  // its 1× sizing (it's a floor-aligned playable surface, not sky).
  // Setting lives on ceiling state (s.ceiling.skyExtend3x) since the
  // toggle is in the Ceiling inspector and only shows when clouds are
  // the active ceiling style.
  const scale = (mode === 'clouds' && s?.ceiling?.skyExtend3x !== false) ? 3 : 1;
  const xWidth = w * scale;
  const zDepth = d * scale;
  const geom = new THREE.BoxGeometry(xWidth, VOLUME_DEPTH, zDepth);
  // Centre on the grid centre, NOT on the stretched box's own centre —
  // the cloud layer must stay symmetric around the level, so a 3×
  // expansion grows equally NSEW from the grid centre.
  geom.translate(w / 2, (yBottom + yTop) / 2, d / 2);

  // For CLOUDS, strip the 4 vertical side faces so the cloud puffs
  // only render on the top + bottom planes of the slab. Without this,
  // a camera that can see the box from outside the room sees puffs
  // stuck to the side faces, which reads as "clouds on the wall of a
  // ceiling-shaped invisible cube." BoxGeometry materialIndex map:
  //   0 = +X (right), 1 = -X (left), 2 = +Y (top), 3 = -Y (bottom),
  //   4 = +Z (front), 5 = -Z (back).  Keeping only groups 2 + 3 (top
  //   + bottom) — the shader's depth-based puff fade still works
  //   because vWorldPos.y on top = yTop (depth = 1, full puff) and
  //   on bottom = yBottom (depth = 0, fully transparent). Water keeps
  //   all 6 faces — bubbles + caustics need the volumetric box read.
  if (mode === 'clouds' && geom.index) {
    const srcIdx = geom.index.array;
    const kept = [];
    for (const g of geom.groups) {
      if (g.materialIndex === 2 || g.materialIndex === 3) {
        for (let i = g.start; i < g.start + g.count; i++) kept.push(srcIdx[i]);
      }
    }
    geom.setIndex(kept);
    geom.clearGroups();
    geom.addGroup(0, kept.length, 0);
  }

  // Custom shader — sample world position in fragment, modulate opacity
  // with noise of the chosen flavour. Kept inside MeshBasicMaterial via
  // onBeforeCompile so we don't lose the polygonOffset / transparency
  // toolchain Three's standard material wiring already gives us.
  // Water base tint = the original pale wash (0xd8e2eb). The dark second
  // tone in the shader provides the depth contrast — base stays bright.
  // Clouds = pure off-white so the puffs are paper-white cumulus against
  // whatever skydome shows through the gaps.
  const tint = (mode === 'water') ? new THREE.Color(0xd8e2eb) : new THREE.Color(0xfafaf7);
  const mat = new THREE.MeshBasicMaterial({
    color: tint,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  // uSpeed scales the per-pattern time multiplier so the inspector dial
  // can dial the animation rate up/down. Default 2.0 — double the
  // shader's "1.0" baseline; inspector clamps to 0..3.
  const speed = planeState.animSpeed ?? 2.0;
  // Cloud Design uniforms — populated below from planeState.cloudDesign.
  // For non-clouds (water) the design block is a no-op but the uniforms
  // are still declared so the shader compiles in one path.
  const design = (mode === 'clouds') ? (planeState.cloudDesign || {}) : {};
  const cdEnabled = mode === 'clouds' && !!design.enabled;
  const colorList = (design.colors && design.colors.length)
    ? design.colors.slice(0, 6)
    : ['#ffffff'];
  const colorTex = makeColorRampTexture(colorList);
  // Water Design uniforms — same shape, water-only fields.
  const wDesign = (mode === 'water') ? (planeState.waterDesign || {}) : {};
  const wdEnabled = mode === 'water' && !!wDesign.enabled;
  const wColorList = (wDesign.colors && wDesign.colors.length)
    ? wDesign.colors.slice(0, 6)
    : ['#1a5fa8'];
  const wColorTex = makeColorRampTexture(wColorList);
  const phen = (k) => wDesign[k] || {};
  const uniforms = {
    uTime:      { value: 0 },
    uYBottom:   { value: yBottom },
    uYTop:      { value: yTop },
    uIsWater:   { value: mode === 'water' ? 1.0 : 0.0 },
    uSpeed:     { value: speed },
    uCdEnabled: { value: cdEnabled ? 1.0 : 0.0 },
    uCdColors:    { value: colorTex },
    uColorCount:{ value: colorList.length },
    uCdSpeed:   { value: design.speed     ?? 0.5  },
    uCdScale:   { value: design.scale     ?? 0.15 },
    uCdContrast:{ value: design.contrast  ?? 0.4  },
    uCdFlow:    { value: design.flowAngle ?? 0    },
    uCdIntensity:{value: design.intensity ?? 1.0  },
    uCdShimmer: { value: design.shimmer   ?? 0.0  },
    uCdCohesion:{ value: design.cohesion  ?? 0.3  },
    uCdEdge:    { value: design.edgeStrength ?? 0.6 },
    // Water Design uniforms
    uWdEnabled:  { value: wdEnabled ? 1.0 : 0.0 },
    uWdColors:   { value: wColorTex },
    uWdColorCount:{ value: wColorList.length },
    uWdSpeed:    { value: wDesign.speed      ?? 0.5 },
    uWdScale:    { value: wDesign.scale      ?? 0.3 },
    uWdContrast: { value: wDesign.contrast   ?? 0.4 },
    uWdFlow:     { value: wDesign.flowAngle  ?? 0   },
    uWdDepthShift:{value: wDesign.depthShift ?? 0.5 },
    uWdIntensity:{ value: wDesign.intensity  ?? 1.0 },
    uWdCohesion: { value: wDesign.cohesion   ?? 0.3 },
    uWdBubbleDensity:{ value: wDesign.bubbleDensity ?? 0.5 },
    uWdBubbleBlend:  { value: wDesign.bubbleBlend   ?? 0.0 },
    // Phenomena: 8 (enabled, intensity) pairs.
    uPhCausticsEn:  { value: phen('caustics').enabled ? 1.0 : 0.0 },
    uPhCausticsInt: { value: phen('caustics').intensity ?? 0.5 },
    uPhFoamEn:      { value: phen('foam').enabled ? 1.0 : 0.0 },
    uPhFoamInt:     { value: phen('foam').intensity ?? 0.5 },
    uPhRaysEn:      { value: phen('godRays').enabled ? 1.0 : 0.0 },
    uPhRaysInt:     { value: phen('godRays').intensity ?? 0.3 },
    uPhRipplesEn:   { value: phen('ripples').enabled ? 1.0 : 0.0 },
    uPhRipplesInt:  { value: phen('ripples').intensity ?? 0.5 },
    uPhReflEn:      { value: phen('reflect').enabled ? 1.0 : 0.0 },
    uPhReflInt:     { value: phen('reflect').intensity ?? 0.3 },
    uPhDepthFogEn:  { value: phen('depthFog').enabled ? 1.0 : 0.0 },
    uPhDepthFogInt: { value: phen('depthFog').intensity ?? 0.5 },
    uPhOverlayEn:   { value: phen('overlay').enabled ? 1.0 : 0.0 },
    uPhOverlayInt:  { value: phen('overlay').intensity ?? 0.3 },
    uPhDotsEn:      { value: phen('schools').enabled ? 1.0 : 0.0 },
    uPhDotsInt:     { value: phen('schools').intensity ?? 0.5 },
  };
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uTime    = uniforms.uTime;
    shader.uniforms.uYBottom = uniforms.uYBottom;
    shader.uniforms.uYTop    = uniforms.uYTop;
    shader.uniforms.uIsWater = uniforms.uIsWater;
    shader.uniforms.uSpeed   = uniforms.uSpeed;
    shader.uniforms.uCdEnabled  = uniforms.uCdEnabled;
    shader.uniforms.uCdColors     = uniforms.uCdColors;
    shader.uniforms.uColorCount = uniforms.uColorCount;
    shader.uniforms.uCdSpeed    = uniforms.uCdSpeed;
    shader.uniforms.uCdScale    = uniforms.uCdScale;
    shader.uniforms.uCdContrast = uniforms.uCdContrast;
    shader.uniforms.uCdFlow     = uniforms.uCdFlow;
    shader.uniforms.uCdIntensity= uniforms.uCdIntensity;
    shader.uniforms.uCdShimmer  = uniforms.uCdShimmer;
    shader.uniforms.uCdCohesion = uniforms.uCdCohesion;
    shader.uniforms.uCdEdge     = uniforms.uCdEdge;
    shader.uniforms.uWdEnabled    = uniforms.uWdEnabled;
    shader.uniforms.uWdColors     = uniforms.uWdColors;
    shader.uniforms.uWdColorCount = uniforms.uWdColorCount;
    shader.uniforms.uWdSpeed      = uniforms.uWdSpeed;
    shader.uniforms.uWdScale      = uniforms.uWdScale;
    shader.uniforms.uWdContrast   = uniforms.uWdContrast;
    shader.uniforms.uWdFlow       = uniforms.uWdFlow;
    shader.uniforms.uWdDepthShift = uniforms.uWdDepthShift;
    shader.uniforms.uWdIntensity  = uniforms.uWdIntensity;
    shader.uniforms.uWdCohesion   = uniforms.uWdCohesion;
    shader.uniforms.uWdBubbleDensity = uniforms.uWdBubbleDensity;
    shader.uniforms.uWdBubbleBlend   = uniforms.uWdBubbleBlend;
    shader.uniforms.uPhCausticsEn  = uniforms.uPhCausticsEn;
    shader.uniforms.uPhCausticsInt = uniforms.uPhCausticsInt;
    shader.uniforms.uPhFoamEn      = uniforms.uPhFoamEn;
    shader.uniforms.uPhFoamInt     = uniforms.uPhFoamInt;
    shader.uniforms.uPhRaysEn      = uniforms.uPhRaysEn;
    shader.uniforms.uPhRaysInt     = uniforms.uPhRaysInt;
    shader.uniforms.uPhRipplesEn   = uniforms.uPhRipplesEn;
    shader.uniforms.uPhRipplesInt  = uniforms.uPhRipplesInt;
    shader.uniforms.uPhReflEn      = uniforms.uPhReflEn;
    shader.uniforms.uPhReflInt     = uniforms.uPhReflInt;
    shader.uniforms.uPhDepthFogEn  = uniforms.uPhDepthFogEn;
    shader.uniforms.uPhDepthFogInt = uniforms.uPhDepthFogInt;
    shader.uniforms.uPhOverlayEn   = uniforms.uPhOverlayEn;
    shader.uniforms.uPhOverlayInt  = uniforms.uPhOverlayInt;
    shader.uniforms.uPhDotsEn      = uniforms.uPhDotsEn;
    shader.uniforms.uPhDotsInt     = uniforms.uPhDotsInt;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `
        #include <common>
        varying vec3 vWorldPos;
      `)
      .replace('#include <fog_vertex>', `
        #include <fog_vertex>
        vWorldPos = (modelMatrix * vec4(position, 1.0)).xyz;
      `);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `
        #include <common>
        varying vec3 vWorldPos;
        uniform float uTime;
        uniform float uYBottom;
        uniform float uYTop;
        uniform float uIsWater;
        uniform float uSpeed;
        uniform float uCdEnabled;
        uniform sampler2D uCdColors;
        uniform float uColorCount;
        uniform float uCdSpeed;
        uniform float uCdScale;
        uniform float uCdContrast;
        uniform float uCdFlow;
        uniform float uCdIntensity;
        uniform float uCdShimmer;
        uniform float uCdCohesion;
        uniform float uCdEdge;
        uniform float uWdEnabled;
        uniform sampler2D uWdColors;
        uniform float uWdColorCount;
        uniform float uWdSpeed;
        uniform float uWdScale;
        uniform float uWdContrast;
        uniform float uWdFlow;
        uniform float uWdDepthShift;
        uniform float uWdIntensity;
        uniform float uWdCohesion;
        uniform float uWdBubbleDensity;
        uniform float uWdBubbleBlend;
        uniform float uPhCausticsEn;
        uniform float uPhCausticsInt;
        uniform float uPhFoamEn;
        uniform float uPhFoamInt;
        uniform float uPhRaysEn;
        uniform float uPhRaysInt;
        uniform float uPhRipplesEn;
        uniform float uPhRipplesInt;
        uniform float uPhReflEn;
        uniform float uPhReflInt;
        uniform float uPhDepthFogEn;
        uniform float uPhDepthFogInt;
        uniform float uPhOverlayEn;
        uniform float uPhOverlayInt;
        uniform float uPhDotsEn;
        uniform float uPhDotsInt;
        // 2D hash → smooth value noise.
        float vhash(vec2 p) {
          p = fract(p * vec2(123.34, 456.21));
          p += dot(p, p + 45.32);
          return fract(p.x * p.y);
        }
        float vnoise(vec2 p) {
          vec2 i = floor(p), f = fract(p);
          float a = vhash(i);
          float b = vhash(i + vec2(1.0, 0.0));
          float c = vhash(i + vec2(0.0, 1.0));
          float d = vhash(i + vec2(1.0, 1.0));
          vec2 u = f * f * (3.0 - 2.0 * f);
          return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
        }
      `)
      .replace('#include <opaque_fragment>', `
        // Distance-from-surface fade. For WATER, the "surface" is the
        // TOP of the slab (where waves and bubbles concentrate) — depth
        // = 1 there, 0 at the slab's bottom. For CLOUDS, the surface
        // is the TOP of the slab (the sky side, far from the ceiling),
        // so depth = 1 at the slab's top, 0 at the ceiling-touching
        // face. Both branches now read the same way, but the meaning
        // is the same: depth=1 is "where the visible interface lives."
        float depth = (vWorldPos.y - uYBottom) / (uYTop - uYBottom);
        depth = clamp(depth, 0.0, 1.0);

        float pattern;
        // Track waves + bubble separately so the water-design colour pass
        // and the per-phenomenon overlays can reference them independently
        // of the combined pattern.
        float waveAmount = 0.0;
        float bubbleAmount = 0.0;
        if (uIsWater > 0.5) {
          float t = uTime * uSpeed;
          float waves = 0.5
            + 0.5 * sin(vWorldPos.x * 1.4 + t * 1.35 + vWorldPos.z * 0.3)
                  * sin(vWorldPos.z * 1.1 - t * 1.125);
          waves = pow(waves, 4.0);
          waveAmount = waves;

          // Bubble density scales how many cells produce a bubble; the
          // threshold drifts from 0.78 (default ~22% of cells) down with
          // uWdBubbleDensity. 0 disables; 1 ≈ carbonated water.
          float bubbleThresh = mix(1.01, 0.55, clamp(uWdBubbleDensity, 0.0, 1.0));
          vec2 bGridScale = vec2(2.5);
          vec2 bgPos = vWorldPos.xz * bGridScale + vec2(0.0, -t * 0.6);
          vec2 cell = floor(bgPos);
          float hasBubble = step(bubbleThresh, vhash(cell));
          vec2 jitter = vec2(vhash(cell + 1.7), vhash(cell - 2.3)) * 0.6 + 0.2;
          vec2 local = fract(bgPos) - jitter;
          float distToCentre = length(local);
          float bubbleRadius = 0.18;
          float ringWidth = 0.06;
          float ring = smoothstep(bubbleRadius + ringWidth, bubbleRadius, distToCentre)
                     * smoothstep(bubbleRadius - ringWidth, bubbleRadius, distToCentre);
          float bubble = hasBubble * ring;
          bubbleAmount = bubble;

          float surfacePattern = waves  * depth;
          float bottomPattern  = bubble * (1.0 - depth);
          pattern = max(surfacePattern, bottomPattern);
        } else {
          // Cloud puffs — blobby low-frequency noise that drifts. uSpeed
          // (from the inspector dial) scales drift speed uniformly so
          // the two bands stay phase-coherent.
          float t = uTime * uSpeed;
          float clouds = vnoise(vWorldPos.xz * 0.18 + vec2(t * 0.09, 0.0));
          clouds += 0.5 * vnoise(vWorldPos.xz * 0.45 - vec2(t * 0.15, t * 0.0675));
          clouds = smoothstep(0.4, 1.1, clouds);
          pattern = clouds;
        }

        float alpha;
        vec3 col;
        if (uIsWater > 0.5) {
          alpha = mix(0.25, 0.95, pattern);

          // --- Water palette sampling. Always computed; uWdEnabled mixes
          // at the end so the shader graph stays alive even when off.
          float wt = uTime * uWdSpeed;
          vec2 wFlowDir = vec2(cos(uWdFlow), sin(uWdFlow));
          float wPhase = vnoise(vWorldPos.xz * uWdScale + wFlowDir * wt);
          // Stratify the palette vertically by depth so deeper water can
          // sit in a different palette region from the surface.
          wPhase += (1.0 - depth) * uWdDepthShift;
          wPhase = mix(wPhase, pattern, uWdCohesion);
          float wSharp = smoothstep(0.5 - uWdContrast * 0.5,
                                    0.5 + uWdContrast * 0.5,
                                    fract(wPhase * uWdColorCount));
          float wBandIdx = floor(wPhase * uWdColorCount);
          float wUSamp = (wBandIdx + wSharp) / uWdColorCount;
          vec3 wSampledBase = texture2D(uWdColors, vec2(wUSamp, 0.5)).rgb;
          // Sample one band ahead for the wave-peak / bubble palette mix.
          float wPeakBand = mod(wBandIdx + 1.0, uWdColorCount);
          float wPeakUSamp = (wPeakBand + wSharp) / uWdColorCount;
          vec3 wSampledPeak = texture2D(uWdColors, vec2(wPeakUSamp, 0.5)).rgb;

          // Base + wave-peak colours. uWdEnabled gates the design override.
          vec3 baseFill = mix(diffuse, wSampledBase, uWdEnabled * uWdIntensity);
          vec3 peakFill = mix(vec3(0.04, 0.16, 0.35), wSampledPeak, uWdEnabled * uWdIntensity);
          col = mix(baseFill, peakFill, waveAmount * depth);

          // Bubble layer: charcoal-ink by default, palette-tinted by
          // uWdBubbleBlend. Bubbles stay where they originate (bottom).
          vec3 bubInk = vec3(0.04, 0.16, 0.35);
          vec3 bubColor = mix(bubInk, wSampledPeak, uWdBubbleBlend * uWdEnabled);
          float bubbleVis = bubbleAmount * (1.0 - depth);
          col = mix(col, bubColor, bubbleVis);

          // --- Phenomena overlays. Each gated by its own enabled flag
          // multiplied by its intensity. All branches always taken; the
          // enabled flag turns the contribution to zero when off.
          // (A) Caustics — criss-cross light pattern at the surface.
          {
            vec2 cp = vWorldPos.xz * 1.5 + vec2(wt * 0.3, wt * 0.4);
            float c1 = sin(cp.x * 1.3 + sin(cp.y * 0.9)) * 0.5 + 0.5;
            float c2 = sin(cp.y * 1.7 - cos(cp.x * 1.1)) * 0.5 + 0.5;
            float caustic = pow(c1 * c2, 4.0);
            col = mix(col, vec3(1.0), caustic * uPhCausticsInt * uPhCausticsEn * depth);
          }
          // (B) Foam — thin bright fringe at wave-peak edges.
          {
            float foamMask = smoothstep(0.75, 0.95, waveAmount) * depth;
            col = mix(col, vec3(1.0), foamMask * uPhFoamInt * uPhFoamEn);
          }
          // (C) God rays — vertical light shafts; densest near the surface.
          {
            float ray = vnoise(vec2(vWorldPos.x * 0.6 + wt * 0.05, vWorldPos.z * 0.6));
            ray = smoothstep(0.6, 0.95, ray);
            col = mix(col, vec3(1.0), ray * uPhRaysInt * uPhRaysEn * depth * 0.4);
          }
          // (D) Ripples — animated concentric rings at the surface.
          {
            float r1 = length(vWorldPos.xz - vec2(50.0, 50.0));
            float ripple = sin(r1 - wt * 2.0) * 0.5 + 0.5;
            ripple = pow(ripple, 8.0);
            col = mix(col, vec3(1.0), ripple * uPhRipplesInt * uPhRipplesEn * depth * 0.6);
          }
          // (E) Reflectivity tint — pull toward sky-blue at the surface.
          {
            vec3 skyTint = vec3(0.7, 0.85, 1.0);
            col = mix(col, skyTint, uPhReflInt * uPhReflEn * depth * 0.35);
          }
          // (F) Depth fog — darken / colour-shift with depth.
          {
            vec3 deepCol = vec3(0.0, 0.05, 0.15);
            col = mix(col, deepCol, (1.0 - depth) * uPhDepthFogInt * uPhDepthFogEn);
          }
          // (G) Surface overlay — sin-pattern displacement read at surface.
          {
            float ov = sin(vWorldPos.x * 0.8 + wt * 0.5) * sin(vWorldPos.z * 0.8 - wt * 0.5);
            ov = ov * 0.5 + 0.5;
            col = mix(col, vec3(0.85, 0.95, 1.0), ov * uPhOverlayInt * uPhOverlayEn * depth * 0.4);
          }
          // (H) Schools of dots — tiny dark clusters drifting at depth.
          {
            vec2 dgp = vWorldPos.xz * 6.0 + vec2(wt * 0.2, 0.0);
            vec2 cellD = floor(dgp);
            float hasDot = step(0.95, vhash(cellD));
            vec2 jD = vec2(vhash(cellD + 5.7), vhash(cellD - 3.1)) * 0.6 + 0.2;
            vec2 localD = fract(dgp) - jD;
            float distD = length(localD);
            float ringDot = smoothstep(0.10, 0.06, distD);
            float dotMask = hasDot * ringDot;
            col = mix(col, vec3(0.04, 0.06, 0.18), dotMask * uPhDotsInt * uPhDotsEn * (1.0 - depth));
          }
        } else {
          // Clouds — OPAQUE off-white where the puff noise is bright,
          // and 100% transparent in the gaps so the dome / stars /
          // skydome behind read through cleanly. With cloud-design mode
          // enabled, the cloud BODY samples an aurora-style colour ramp
          // that flows across the sky over space + time; without it the
          // clouds stay paper-white. Ink edge always present.
          float puff = pattern * depth;
          float cloudAlpha = smoothstep(0.05, 0.7, puff);
          float skyAlpha = 0.0;          // gaps fully transparent
          alpha = cloudAlpha;
          float edge = smoothstep(0.15, 0.35, puff) * (1.0 - smoothstep(0.35, 0.55, puff));

          // Default white cloud body. Edge ink is true-neutral near-black
          // (not the codebase's #0b0d14 navy) — clouds are large soft
          // shapes where the eye averages edge tint into body tint, so a
          // cool-near-black reads as a blue body cast. Walls don't have
          // that problem; they get the navy ink elsewhere.
          vec3 inkCol = vec3(0.05, 0.05, 0.05);
          vec3 baseCloudCol = mix(diffuse, inkCol, edge * uCdEdge);
          vec3 skyCol = vec3(0.45, 0.68, 0.92);

          // --- Cloud Design colour pass ---
          // The branch is ALWAYS taken (no if-gate) so GLSL drivers can't
          // dead-strip it when uCdEnabled is 0 at compile time. uCdEnabled
          // mixes the result back to baseCloudCol when off, so visual
          // behaviour matches the "if-gated" version exactly — but the
          // shader graph stays alive and the uniform flip works at runtime.
          vec2 flowDir = vec2(cos(uCdFlow), sin(uCdFlow));
          float ct = uTime * uCdSpeed;
          float phase = vnoise(vWorldPos.xz * uCdScale + flowDir * ct);
          phase = mix(phase, pattern, uCdCohesion);
          float sharp = smoothstep(0.5 - uCdContrast * 0.5,
                                   0.5 + uCdContrast * 0.5,
                                   fract(phase * uColorCount));
          float bandIdx = floor(phase * uColorCount);
          float uSamp = (bandIdx + sharp) / uColorCount;
          vec3 sampled = texture2D(uCdColors, vec2(uSamp, 0.5)).rgb;
          float sh = 1.0 + uCdShimmer * (vnoise(vWorldPos.xz * 0.6 + ct * 0.3) - 0.5);
          sampled *= sh;
          vec3 colouredCloud = mix(baseCloudCol, sampled, uCdIntensity);
          colouredCloud = mix(colouredCloud, inkCol, edge * uCdEdge);
          // Final mix: when uCdEnabled = 0 we fall back to plain
          // baseCloudCol; when 1 we use the fully designed colour.
          vec3 designCloudCol = mix(baseCloudCol, colouredCloud, uCdEnabled);
          col = (designCloudCol * cloudAlpha + skyCol * skyAlpha) / max(alpha, 0.0001);
        }
        // Write both diffuseColor AND outgoingLight. The base material
        // chain set outgoingLight = diffuseColor.rgb earlier in the
        // pipeline; just overwriting diffuseColor here doesn't reach the
        // final colour write inside opaque_fragment.
        diffuseColor = vec4(col, alpha);
        outgoingLight = col;
        #include <opaque_fragment>
      `);
    mat.userData.shader = shader;
  };
  const mesh = new THREE.Mesh(geom, mat);
  mesh.renderOrder = (kind === 'floor') ? -1 : 2;
  mesh.userData.planeKind = kind;
  mesh.userData.volumeUniforms = uniforms;
  _animated.push(mesh);
  root.add(mesh);

  // For WATER specifically AND only at NIGHT: surround the volume with
  // an open-topped black box (sides + bottom, no top). At day the
  // surrounding world reads as bright, and a black tub would visually
  // clash; at night the world goes dark so the black box reads as
  // "depth of the water at night" and frames the volume cleanly.
  if (mode === 'water' && s.world?.night?.enabled) {
    const boxW = w;
    const boxH = yTop - yBottom;
    const boxD = d;
    const boxGeom = new THREE.BoxGeometry(boxW, boxH, boxD);
    boxGeom.translate(w / 2, (yBottom + yTop) / 2, d / 2);
    // BoxGeometry's faces order: 0=+X, 1=-X, 2=+Y, 3=-Y, 4=+Z, 5=-Z.
    // Each face has 2 triangles (6 indices). To remove the TOP (+Y, face
    // index 2), splice indices [12..18] from the index buffer.
    const idx = Array.from(boxGeom.index.array);
    idx.splice(12, 6);
    boxGeom.setIndex(idx);
    const boxMat = new THREE.MeshBasicMaterial({
      color: 0x000000,
      side: THREE.BackSide,   // camera looking IN at the inner walls
      depthWrite: true,
    });
    const boxMesh = new THREE.Mesh(boxGeom, boxMat);
    boxMesh.renderOrder = (kind === 'floor') ? -2 : 1;   // behind the water slab
    root.add(boxMesh);
  }

  // Still emit the original plane edge stroke so the user sees the boundary
  // of the floor/ceiling within the volume.
  const edgeGeom = new THREE.PlaneGeometry(w, d);
  edgeGeom.rotateX(kind === 'floor' ? -Math.PI / 2 : Math.PI / 2);
  const edgePos = new THREE.Vector3(w / 2, planeState.y, d / 2);
  if (kind !== 'ceiling') addEdgeStroke(root, edgeGeom, edgePos);
}

// --- helpers ---------------------------------------------------------------
// The plane perimeter stroke is the boundary marker at the floor/ceiling
// edge. Pure white so it disappears into the off-white page tone — there
// when needed for raycast / debug, but visually invisible against the
// scene fill.
const PLANE_EDGE_COLOR = 0xffffff;
// Build a 1×N DataTexture from a list of hex colour strings. The cloud-
// design shader samples this via texture2D(uCdColors, vec2(u, 0.5)) where
// u maps a phase value to the colour ramp. LinearFilter so the ramp
// reads as a smooth blend between palette entries; the contrast knob
// in the shader sharpens it back into ribbons when desired.
function makeColorRampTexture(colorHexList) {
  const N = Math.max(1, Math.min(6, colorHexList.length));
  const data = new Uint8Array(N * 4);
  for (let i = 0; i < N; i++) {
    const c = new THREE.Color(colorHexList[i] || '#ffffff');
    data[i * 4 + 0] = Math.round(c.r * 255);
    data[i * 4 + 1] = Math.round(c.g * 255);
    data[i * 4 + 2] = Math.round(c.b * 255);
    data[i * 4 + 3] = 255;
  }
  const tex = new THREE.DataTexture(data, N, 1, THREE.RGBAFormat);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearFilter;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

function addEdgeStroke(root, geom, position) {
  const edge = new THREE.LineSegments(
    new THREE.EdgesGeometry(geom),
    new THREE.LineBasicMaterial({ color: PLANE_EDGE_COLOR }),
  );
  edge.position.copy(position);
  edge.renderOrder = 1;
  root.add(edge);
}

// URLs that 404'd on a previous attempt — skipped on subsequent rebuilds
// so a stale state.url doesn't spam the network every time anything
// triggers a state.subscribe → rebuild pass.
const _deadTextureUrls = new Set();
function attachPlaneTexture(mat, baseTex, w, d, transparent) {
  const loader = new THREE.TextureLoader();
  const src = baseTex.url ? resolveAssetUrl(baseTex.url) : baseTex.dataUrl;
  if (_deadTextureUrls.has(src)) return;
  loader.load(
    src,
    (texture) => {
      texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
      texture.colorSpace = THREE.SRGBColorSpace;
      const mode = baseTex.sizingMode || 'fixed';
      let repU = 1, repV = 1;
      if (mode === 'fixed') {
        const wM = texture.image.naturalWidth  / 100;
        const hM = texture.image.naturalHeight / 100;
        repU = Math.max(0.01, w / wM);
        repV = Math.max(0.01, d / hM);
      } else if (mode === 'meters' && baseTex.widthMeters && baseTex.heightMeters) {
        repU = Math.max(0.01, w / baseTex.widthMeters);
        repV = Math.max(0.01, d / baseTex.heightMeters);
      }
      texture.repeat.set(repU, repV);
      if (baseTex.flipU) { texture.repeat.x = -texture.repeat.x; texture.offset.x = 1 + (texture.offset.x || 0); }
      if (baseTex.flipV) { texture.repeat.y = -texture.repeat.y; texture.offset.y = 1 + (texture.offset.y || 0); }
      const rotRad = (Number(baseTex.rotation) || 0) * Math.PI / 180;
      if (rotRad !== 0) texture.center.set(0.5, 0.5);
      else              texture.center.set(0, 0);
      texture.rotation = rotRad;
      mat.map = texture;
      mat.needsUpdate = true;
    },
    undefined,
    // 404 / network error — remember the dead URL so subsequent
    // rebuilds skip it entirely. Mesh stays as flat-colour fill until
    // a valid texture is reassigned by the user.
    () => { _deadTextureUrls.add(src); },
  );
}
