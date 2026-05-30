// engine/objects.js — GLB mesh registry + per-cell object rendering.
//
// Mesh registry pattern: each entry knows its slug, GLB path, thumbnail, and
// default placement transforms. Adding a new mesh = one entry. The editor's
// mesh palette is built from this same registry — single source of truth.

import * as THREE from 'three';
import * as BufferGeometryUtils from 'three/addons/utils/BufferGeometryUtils.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { cellToWorld } from '../core/grid-addr.js';
import { MESHES } from '../core/mesh-registry.js';
import { regenerateUVsForProjection } from './projection.js';
import { resolveAssetUrl } from '../core/asset-paths.js';

const loader = new GLTFLoader();
const cache = new Map();  // slug → THREE.Group (the GLB scene)

// Re-export for engine consumers; the canonical definition lives in
// core/mesh-registry.js so the editor can consume it without pulling Three.
export { MESHES };

// Per-mesh paint overlay with a PER-COMPONENT canvas split.
//
// Goal: paint feels like real 3D paint — smooth, continuous on whatever
// face you aim at — but doesn't mirror onto the OTHER faces that share a
// UV island in the GLB (left/right legs, repeated panels, mirrored halves).
//
// How: group triangles by 3D-position connectivity (two triangles in the
// same component iff they share a vertex in WORLD-LOCAL position). Each
// component gets its own square slot in the 1024² overlay canvas, and
// inside its slot the component's NATIVE UVs are preserved (just translated
// and uniformly scaled to fit). Painting at hit.uv lands inside exactly
// one component's slot → no bleed to physically-separate parts that
// happened to share UVs in the original asset.
//
// Within a component, native UVs mean painting is as smooth as the original
// asset's unwrapping allows — no per-triangle grid. Brush-size math in
// painting.js compensates for the scale-into-tile factor so a 10 cm brush
// is 10 cm in WORLD on every face, matching walls/floor/ceiling.
//
// Caveat that remains: a component whose own UVs are mirrored against
// themselves (e.g., a single welded ring mesh authored with mirrored
// unwrapping) will still mirror within its slot — that's a UV-island
// authoring issue we can't fix without a proper unwrapper.
const PAINT_OVERLAY_RES = 1024;
export function attachPaintOverlays(root) {
  root.traverse((n) => {
    if (!n.isMesh) return;
    if (n.userData?.paintOverlay) return;
    if (!n.geometry?.attributes?.uv || !n.geometry?.attributes?.position) return;

    const baseGeom = n.geometry;
    const overlayGeom = baseGeom.index ? baseGeom.toNonIndexed() : baseGeom.clone();
    const posAttr = overlayGeom.attributes.position;
    const uvAttr  = overlayGeom.attributes.uv;
    const triCount = posAttr.count / 3;

    // Group triangles into components by SHARED-EDGE + SIMILAR-NORMAL.
    // Two triangles are in the same component iff they share an edge (= two
    // vertices at the same 3D position) AND their face normals agree within
    // ~18° (dot > 0.95). This correctly splits a welded primitive cube into
    // its 6 faces, while keeping smooth curved surfaces (sphere, plant) as
    // one continuous component because adjacent triangles have similar
    // normals.
    const posKey = (i) => `${posAttr.getX(i).toFixed(5)},${posAttr.getY(i).toFixed(5)},${posAttr.getZ(i).toFixed(5)}`;
    const normals = new Array(triCount);
    const _vA = new THREE.Vector3(), _vB = new THREE.Vector3(), _vC = new THREE.Vector3();
    for (let t = 0; t < triCount; t++) {
      _vA.set(posAttr.getX(t * 3),     posAttr.getY(t * 3),     posAttr.getZ(t * 3));
      _vB.set(posAttr.getX(t * 3 + 1), posAttr.getY(t * 3 + 1), posAttr.getZ(t * 3 + 1));
      _vC.set(posAttr.getX(t * 3 + 2), posAttr.getY(t * 3 + 2), posAttr.getZ(t * 3 + 2));
      const edge1x = _vB.x - _vA.x, edge1y = _vB.y - _vA.y, edge1z = _vB.z - _vA.z;
      const edge2x = _vC.x - _vA.x, edge2y = _vC.y - _vA.y, edge2z = _vC.z - _vA.z;
      const nx = edge1y * edge2z - edge1z * edge2y;
      const ny = edge1z * edge2x - edge1x * edge2z;
      const nz = edge1x * edge2y - edge1y * edge2x;
      const len = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
      normals[t] = [nx / len, ny / len, nz / len];
    }
    const edgeKey = (a, b) => a < b ? `${a}|${b}` : `${b}|${a}`;
    const edgeToTris = new Map();
    for (let t = 0; t < triCount; t++) {
      const k0 = posKey(t * 3 + 0);
      const k1 = posKey(t * 3 + 1);
      const k2 = posKey(t * 3 + 2);
      for (const e of [edgeKey(k0, k1), edgeKey(k1, k2), edgeKey(k2, k0)]) {
        if (!edgeToTris.has(e)) edgeToTris.set(e, []);
        edgeToTris.get(e).push(t);
      }
    }
    const parent = new Array(triCount).fill(0).map((_, i) => i);
    const find = (x) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
    const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent[ra] = rb; };
    for (const tris of edgeToTris.values()) {
      if (tris.length < 2) continue;
      for (let i = 0; i < tris.length; i++) {
        for (let j = i + 1; j < tris.length; j++) {
          const na = normals[tris[i]], nb = normals[tris[j]];
          const dot = na[0] * nb[0] + na[1] * nb[1] + na[2] * nb[2];
          if (dot > 0.95) union(tris[i], tris[j]);
        }
      }
    }
    const compMap = new Map();
    for (let t = 0; t < triCount; t++) {
      const r = find(t);
      if (!compMap.has(r)) compMap.set(r, []);
      compMap.get(r).push(t);
    }
    const components = Array.from(compMap.values());
    const N = Math.max(1, Math.ceil(Math.sqrt(components.length)));
    const tile = 1 / N;

    // Translate + STRETCH each component's native UVs into its slot
    // independently per axis. Uniform scale (the previous approach,
    // min(tile/uSpan, tile/vSpan)) preserves aspect ratio in canvas-
    // space, but for components with extreme aspect ratios (long-thin
    // banister sides, stair stringer sides, post faces) it squeezes
    // one axis into 1-10 canvas pixels. A world-aware brush parallelo-
    // gram then becomes sub-pixel thin in that axis and renders as a
    // 1-px stripe (vertical streak on a tall component, invisible on
    // a thin one). Stretching the island to fill both axes of the
    // slot keeps every component's canvas footprint non-degenerate.
    //
    // _drawWorldSquareOnMeshCanvas computes the per-triangle UV-to-
    // world basis from the new UVs at render time, so the brush stays
    // world-square on the visible surface regardless of stretch. The
    // canvas is paint-only (no authored textures sampled via these
    // UVs), so stretching doesn't distort any other content.
    const newUV = new Float32Array(uvAttr.count * 2);
    for (let i = 0; i < components.length; i++) {
      const tris = components[i];
      const col = i % N;
      const row = Math.floor(i / N);
      const u0 = col * tile;
      const v0 = row * tile;
      let uMin = Infinity, uMax = -Infinity, vMin = Infinity, vMax = -Infinity;
      for (const t of tris) {
        for (let k = 0; k < 3; k++) {
          const vi = t * 3 + k;
          const u = uvAttr.getX(vi);
          const v = uvAttr.getY(vi);
          if (u < uMin) uMin = u; if (u > uMax) uMax = u;
          if (v < vMin) vMin = v; if (v > vMax) vMax = v;
        }
      }
      const uSpan = Math.max(1e-6, uMax - uMin);
      const vSpan = Math.max(1e-6, vMax - vMin);
      const margin = 0.92;
      const scaleU = (tile / uSpan) * margin;
      const scaleV = (tile / vSpan) * margin;
      // Center the scaled island inside the slot. With stretch fit both
      // pads collapse to (tile * (1 - margin) / 2), the per-axis gutter.
      const padU = (tile - uSpan * scaleU) * 0.5;
      const padV = (tile - vSpan * scaleV) * 0.5;
      for (const t of tris) {
        for (let k = 0; k < 3; k++) {
          const vi = t * 3 + k;
          newUV[vi * 2 + 0] = u0 + padU + (uvAttr.getX(vi) - uMin) * scaleU;
          newUV[vi * 2 + 1] = v0 + padV + (uvAttr.getY(vi) - vMin) * scaleV;
        }
      }
    }
    overlayGeom.setAttribute('uv', new THREE.BufferAttribute(newUV, 2));

    const canvas = document.createElement('canvas');
    canvas.width = PAINT_OVERLAY_RES;
    canvas.height = PAINT_OVERLAY_RES;
    canvas.getContext('2d').clearRect(0, 0, canvas.width, canvas.height);
    const texture = new THREE.CanvasTexture(canvas);
    texture.minFilter = THREE.NearestFilter;
    texture.magFilter = THREE.NearestFilter;
    texture.generateMipmaps = false;
    const overlayMat = new THREE.MeshBasicMaterial({
      map: texture,
      transparent: true,
      // alphaTest: paintOverlay is a UV-repacked clone of the base
      // mesh. Empty canvas (cleared on creation) has alpha=0 →
      // discard pixel, no shadow. Painted areas have alpha=1 →
      // cast shadow like opaque geometry. Keeps the overlay from
      // contributing phantom shadow before any paint is applied
      // while still allowing painted areas to cast.
      alphaTest: 0.5,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits:  -2,
      side: THREE.DoubleSide,
    });
    const overlay = new THREE.Mesh(overlayGeom, overlayMat);
    overlay.renderOrder = 10;
    overlay.userData.paintOverlay = true;
    overlay.userData.paintableSurface = 'object';
    overlay.userData.paintCanvas = canvas;
    overlay.userData.paintTexture = texture;
    // Slot grid lets painting.js clip a brush to the component slot the
    // raycast landed on — prevents big-brush splats from streaking into the
    // neighbouring slot (which would be a physically different face).
    overlay.userData.slotsPerSide = N;
    n.add(overlay);
  });
}

// Walk every Mesh under a node and switch its material(s) to DoubleSide.
// Used after a negative-scale flip so the inverted-winding faces still draw
// (Three.js flips triangle winding on negative scale; default FrontSide
// culling otherwise drops the now-back-facing surfaces).
function forceDoubleSide(root) {
  root.traverse((n) => {
    if (!n.isMesh) return;
    const apply = (m) => { if (m && m.side !== undefined) m.side = THREE.DoubleSide; };
    if (Array.isArray(n.material)) n.material.forEach(apply);
    else apply(n.material);
  });
}

// Wrap a loaded mesh in an OUTER transform group whose origin sits at the
// inner content's bbox center. The user's position/rotation/scale apply to
// the outer group, so flips/rotations pivot around the visible center of the
// object regardless of how the inner mesh was authored (foot-anchored,
// center-anchored, etc.). Returns { wrapper, halfHeight } so the caller can
// position the wrapper such that the object's BOTTOM lands at yOffset.
function wrapWithCenteredPivot(innerMesh) {
  const wrapper = new THREE.Group();
  wrapper.add(innerMesh);
  wrapper.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(wrapper);
  if (box.isEmpty()) return { wrapper, halfHeight: 0 };
  const center = new THREE.Vector3();
  box.getCenter(center);
  // Shift the inner mesh so its content's bbox center lands at the wrapper's
  // origin. The wrapper's origin is now the rotation/flip pivot point.
  innerMesh.position.sub(center);
  return { wrapper, halfHeight: (box.max.y - box.min.y) / 2 };
}

async function loadMesh(slug) {
  const entry = MESHES[slug];
  if (!entry) return null;
  if (entry.primitive) return makePrimitive(entry.primitive);
  if (cache.has(slug)) return cache.get(slug).clone(true);
  // url (level-relative file path) > dataUrl (inline base64) > path (built-in)
  let url = null;
  if (entry.url) url = resolveAssetUrl(entry.url);
  else if (entry.dataUrl) url = entry.dataUrl;
  else if (entry.path) url = entry.path;
  if (!url) return makeStub();
  try {
    const gltf = await loader.loadAsync(url);
    const group = gltf.scene;
    cache.set(slug, group);
    return group.clone(true);
  } catch (e) {
    console.warn(`[objects] load failed for ${slug}:`, e.message);
    return makeStub();
  }
}

function makeStub() {
  const g = new THREE.Group();
  const cube = new THREE.Mesh(
    new THREE.BoxGeometry(0.5, 0.5, 0.5),
    new THREE.MeshBasicMaterial({ color: 0xee7967 }),  // coral, so it's still on-brand
  );
  cube.position.y = 0.25;
  g.add(cube);
  return g;
}

// Inked-comic primitive builder: off-white fill + black edge stroke, matching
// the wall + floor style. Footprint and y-offset chosen so the object sits on
// the floor when placed at yOffset=0.
function makePrimitive(kind) {
  if (kind === 'cage')  return makeCage();
  if (kind === 'rock')  return makeRock();
  if (kind === 'table') return makeTable();
  if (kind === 'stool') return makeStool();
  if (kind === 'bowl')  return makeBowl();
  if (kind === 'picture-frame') return makePictureFrame();
  if (kind === 'tree')  return makeTree();
  if (kind === 'bush')  return makeBush();

  const group = new THREE.Group();
  let geom;
  let yShift = 0;
  switch (kind) {
    case 'cube':     geom = new THREE.BoxGeometry(0.8, 0.8, 0.8);          yShift = 0.4; break;
    case 'sphere':   geom = new THREE.SphereGeometry(0.5, 24, 16);          yShift = 0.5; break;
    case 'cylinder': geom = new THREE.CylinderGeometry(0.4, 0.4, 1.0, 24);  yShift = 0.5; break;
    default:         return makeStub();
  }
  const mesh = new THREE.Mesh(geom, new THREE.MeshBasicMaterial({ color: 0xfafaf7 }));
  mesh.position.y = yShift;
  const edges = new THREE.LineSegments(
    new THREE.EdgesGeometry(geom, 30),
    new THREE.LineBasicMaterial({ color: 0x0b0d14 }),
  );
  edges.position.y = yShift;
  group.add(mesh);
  group.add(edges);
  return group;
}

// Cage: 12 thin box "bars" tracing the edges of a unit cube. Hollow interior,
// stroke-rendered inked-comic style.
// Cage: 12 bar geometries merged into ONE BufferGeometry so the inked-comic
// edge extractor (EdgesGeometry with mergeVertices) deduplicates internal
// seams at the corner intersections. The previous version added 12 separate
// box meshes; their faces z-fought at the corners and their edges painted
// duplicate strokes where bars overlapped.
function makeCage() {
  const group = new THREE.Group();
  const S = 0.8;        // outer dimension
  const T = 0.06;       // bar thickness
  const half = S / 2;
  const geoms = [];
  function addBar(w, h, d, x, y, z) {
    const g = new THREE.BoxGeometry(w, h, d);
    g.translate(x, y + half, z);   // y+half so cage sits on the floor
    geoms.push(g);
  }
  // 4 vertical posts
  for (const sx of [-half, +half]) for (const sz of [-half, +half]) addBar(T, S, T, sx, 0, sz);
  // 4 horizontal X-axis bars (top + bottom × front + back)
  for (const sy of [-half + T/2, +half - T/2]) for (const sz of [-half, +half]) addBar(S, T, T, 0, sy, sz);
  // 4 horizontal Z-axis bars (top + bottom × left + right)
  for (const sy of [-half + T/2, +half - T/2]) for (const sx of [-half, +half]) addBar(T, T, S, sx, sy, 0);

  // Merge + weld so internal corner seams collapse into shared vertices.
  let merged = BufferGeometryUtils.mergeGeometries(geoms, false);
  merged = BufferGeometryUtils.mergeVertices(merged, 0.001);
  merged.computeVertexNormals();
  for (const g of geoms) g.dispose();

  const mesh = new THREE.Mesh(merged, new THREE.MeshBasicMaterial({ color: 0xfafaf7 }));
  group.add(mesh);
  const edges = new THREE.LineSegments(
    new THREE.EdgesGeometry(merged, 30),
    new THREE.LineBasicMaterial({ color: 0x0b0d14 }),
  );
  group.add(edges);
  return group;
}

// Table: flat top slab on 4 thin legs. Sits at y=0 (legs touch the floor).
function makeTable() {
  const group = new THREE.Group();
  const W = 0.9, D = 0.6, TT = 0.05;       // width, depth, top thickness
  const LH = 0.7, LW = 0.04;                // leg height, leg side
  const matFill = new THREE.MeshBasicMaterial({ color: 0xfafaf7 });
  const matStroke = new THREE.LineBasicMaterial({ color: 0x0b0d14 });
  function addPart(geom, x, y, z) {
    geom.translate(x, y, z);
    const m = new THREE.Mesh(geom, matFill);
    group.add(m);
    group.add(new THREE.LineSegments(new THREE.EdgesGeometry(geom, 30), matStroke));
  }
  addPart(new THREE.BoxGeometry(W, TT, D), 0, LH + TT/2, 0);
  for (const sx of [-1, +1]) for (const sz of [-1, +1]) {
    addPart(new THREE.BoxGeometry(LW, LH, LW),
            sx * (W/2 - LW/2), LH/2, sz * (D/2 - LW/2));
  }
  return group;
}

// Round stool: short cylinder seat on a single thinner cylinder leg.
function makeStool() {
  const group = new THREE.Group();
  const SH = 0.45;   // seat top height
  const SR = 0.18;   // seat radius
  const ST = 0.04;   // seat thickness
  const LR = 0.035;  // leg radius
  const matFill = new THREE.MeshBasicMaterial({ color: 0xfafaf7 });
  const matStroke = new THREE.LineBasicMaterial({ color: 0x0b0d14 });
  function addPart(geom, y) {
    geom.translate(0, y, 0);
    const m = new THREE.Mesh(geom, matFill);
    group.add(m);
    group.add(new THREE.LineSegments(new THREE.EdgesGeometry(geom, 30), matStroke));
  }
  addPart(new THREE.CylinderGeometry(SR, SR, ST, 24), SH);             // seat
  addPart(new THREE.CylinderGeometry(LR, LR, SH - ST/2, 12), (SH - ST/2) / 2);   // leg
  return group;
}

// Rock: asymmetric blob with no symmetry. Built from an icosahedron then
// each vertex displaced via a position-deterministic pseudo-noise function so
// the same "rock" is identical between renders. Bottom flattened to sit flat.
function makeRock() {
  const group = new THREE.Group();
  const geom = new THREE.IcosahedronGeometry(0.45, 2);
  const pos = geom.attributes.position;
  function noise3(x, y, z) {
    // Deterministic small-amplitude wobble; offsets break symmetry.
    return Math.sin(x * 7.31 + 1.7) * 0.07
         + Math.cos(y * 5.13 - 2.3) * 0.06
         + Math.sin(z * 9.27 + 0.8) * 0.05
         + Math.cos((x + z) * 11.0) * 0.04;
  }
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    const r = Math.hypot(x, y, z) || 1;
    const k = 1 + noise3(x, y, z);
    pos.setXYZ(i, x * k, y * k, z * k);
  }
  // Flatten the bottom — push any vertex below y=-0.25 up to that plane and
  // squash slightly so the bottom reads as a flat seating surface.
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i);
    if (y < -0.25) pos.setY(i, -0.25 + (y + 0.25) * 0.15);
  }
  geom.computeVertexNormals();
  const mesh = new THREE.Mesh(geom, new THREE.MeshBasicMaterial({ color: 0xfafaf7 }));
  mesh.position.y = 0.3;
  const edges = new THREE.LineSegments(
    new THREE.EdgesGeometry(geom, 25),
    new THREE.LineBasicMaterial({ color: 0x0b0d14 }),
  );
  edges.position.y = 0.3;
  group.add(mesh);
  group.add(edges);
  return group;
}

// Bowl: bottom hemisphere of a sphere, sitting flat, open toward the sky.
// DoubleSide material so you see the inner concave surface from above.
function makeBowl() {
  const group = new THREE.Group();
  const r = 0.35;
  // SphereGeometry(radius, wSeg, hSeg, phiStart, phiLength, thetaStart, thetaLength).
  // thetaStart=PI/2 (equator) to thetaLength=PI/2 (south pole) = bottom half.
  const geom = new THREE.SphereGeometry(r, 24, 12, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2);
  geom.translate(0, r, 0);   // south pole sits on floor, equator opens at y=r
  const mesh = new THREE.Mesh(geom, new THREE.MeshBasicMaterial({ color: 0xfafaf7, side: THREE.DoubleSide }));
  group.add(mesh);
  group.add(new THREE.LineSegments(
    new THREE.EdgesGeometry(geom, 25),
    new THREE.LineBasicMaterial({ color: 0x0b0d14 }),
  ));
  return group;
}

// Picture frame: vertical square frame with a rectangular hole through it.
// Drawn as a 2D shape in the XY plane and extruded along Z so it stands
// upright in the cell. The hole is a sub-Path on the outer Shape. The
// frame is placed flush against the back EDGE of its cell (z = -0.5 in
// local cell-centred space). Combined with pivotMode 'cell-center' in
// MESHES, the wrapper pivot stays at the cell centre, so Y-rotation
// orbits the frame around the cell rather than around itself.
function makePictureFrame() {
  const outerHalf = 0.4;
  const innerHalfX = 0.28;
  const innerHalfY = 0.28;
  const yTop = outerHalf * 2;
  const outer = new THREE.Shape();
  outer.moveTo(-outerHalf, 0);
  outer.lineTo(outerHalf, 0);
  outer.lineTo(outerHalf, yTop);
  outer.lineTo(-outerHalf, yTop);
  outer.closePath();
  const hole = new THREE.Path();
  hole.moveTo(-innerHalfX, outerHalf - innerHalfY);
  hole.lineTo(innerHalfX,  outerHalf - innerHalfY);
  hole.lineTo(innerHalfX,  outerHalf + innerHalfY);
  hole.lineTo(-innerHalfX, outerHalf + innerHalfY);
  hole.closePath();
  outer.holes.push(hole);
  const depth = 0.04;
  const geom = new THREE.ExtrudeGeometry(outer, { depth, bevelEnabled: false });
  // Place the frame's back face at z = -0.5 (the cell's far edge) so the
  // frame sits flush against that wall. Front face ends up at z = -0.46.
  geom.translate(0, 0, -0.5);
  const group = new THREE.Group();
  group.add(new THREE.Mesh(geom, new THREE.MeshBasicMaterial({ color: 0xfafaf7 })));
  group.add(new THREE.LineSegments(
    new THREE.EdgesGeometry(geom, 30),
    new THREE.LineBasicMaterial({ color: 0x0b0d14 }),
  ));
  return group;
}

// Tree: tapered cylinder trunk with a sphere of foliage perched on top.
function makeTree() {
  const group = new THREE.Group();
  const matFill   = new THREE.MeshBasicMaterial({ color: 0xfafaf7 });
  const matStroke = new THREE.LineBasicMaterial({ color: 0x0b0d14 });
  function addPart(geom, y) {
    geom.translate(0, y, 0);
    group.add(new THREE.Mesh(geom, matFill));
    group.add(new THREE.LineSegments(new THREE.EdgesGeometry(geom, 30), matStroke));
  }
  addPart(new THREE.CylinderGeometry(0.06, 0.09, 0.6, 12), 0.3);   // trunk
  addPart(new THREE.SphereGeometry(0.32, 16, 12),          0.85);  // foliage
  return group;
}

// Bush: low cluster of overlapping spheres — wider than it is tall.
function makeBush() {
  const group = new THREE.Group();
  const matFill   = new THREE.MeshBasicMaterial({ color: 0xfafaf7 });
  const matStroke = new THREE.LineBasicMaterial({ color: 0x0b0d14 });
  // [x, y_center, z, radius]
  const blobs = [
    [ 0.00, 0.24,  0.00, 0.26],
    [ 0.18, 0.18,  0.04, 0.20],
    [-0.16, 0.20, -0.08, 0.22],
    [ 0.04, 0.16, -0.20, 0.18],
  ];
  for (const [x, y, z, r] of blobs) {
    const geom = new THREE.SphereGeometry(r, 14, 10);
    geom.translate(x, y, z);
    group.add(new THREE.Mesh(geom, matFill));
    group.add(new THREE.LineSegments(new THREE.EdgesGeometry(geom, 30), matStroke));
  }
  return group;
}

// Build every object in the level into rootObjects. Async — returns when all
// GLBs have resolved (or stubbed). Subsequent rebuilds are fast (cache hit).
export async function buildObjects(rootObjects, s) {
  rootObjects.clear();
  if (!s.objects?.length) return;
  const cell = s.grid.cellSizeMeters;
  for (const o of s.objects) {
    const inner = await loadMesh(o.meshSlug);
    if (!inner) continue;
    const pos = cellToWorld(o.rowId, o.col, cell);
    if (!pos) continue;

    // Apply optional JPEG texture to the inner content BEFORE wrapping —
    // texture application traverses the mesh hierarchy and is independent
    // of the wrapper.
    if (o.texture && (o.texture.url || o.texture.dataUrl)) applyObjectTexture(inner, o.texture);

    // Attach paint overlays so each Mesh in the object can be painted in
    // first-person preview. Must run BEFORE wrap (overlays add as children
    // and inherit the wrapper's transform automatically).
    attachPaintOverlays(inner);

    // Two pivot modes:
    //   default — wrapWithCenteredPivot. Wrapper origin = inner mesh's
    //     bbox centre, so flips and rotations pivot around the object's
    //     visible centre regardless of where its geometry sits.
    //   'cell-center' — skip the bbox shift. Wrapper origin = local
    //     (0, 0, 0) which IS the cell centre. The inner mesh can be
    //     authored OFF-centre (e.g. on the back edge of the cell) and
    //     it'll stay on that edge while still rotating around the cell
    //     centre. Used by picture-frame which sits on the back edge.
    const entry = MESHES[o.meshSlug];
    let wrapper, halfHeight;
    if (entry?.pivotMode === 'cell-center') {
      wrapper = new THREE.Group();
      wrapper.add(inner);
      halfHeight = 0;
    } else {
      ({ wrapper, halfHeight } = wrapWithCenteredPivot(inner));
    }

    // Place the wrapper. For default pivot mode the inner content's BOTTOM
    // sits at yOffset (foot stays on the floor regardless of flip
    // orientation). For 'cell-center' mode halfHeight is 0 so wrapper sits
    // directly at yOffset — the geometry is responsible for placing itself
    // at y=0 ground level.
    // xOffset / zOffset added so the mesh can be nudged off its
    // cell anchor without changing the anchor itself. yOffset has
    // historically existed for vertical placement (+halfHeight so
    // the foot of the mesh sits at yOffset on the floor).
    wrapper.position.set(
      pos.x + (o.xOffset || 0),
      (o.yOffset || 0) + halfHeight,
      pos.z + (o.zOffset || 0),
    );

    // Rotation stored in DEGREES per axis — convert to radians.
    if (Array.isArray(o.rotation)) {
      const D2R = Math.PI / 180;
      wrapper.rotation.set(o.rotation[0] * D2R, o.rotation[1] * D2R, o.rotation[2] * D2R);
    }

    // Scale is [sx, sy, sz]; negative values flip around the wrapper origin
    // = bbox center → centered flips on all three axes.
    let sx = 1, sy = 1, sz = 1;
    if (Array.isArray(o.scale)) {
      sx = o.scale[0] || 1; sy = o.scale[1] || 1; sz = o.scale[2] || 1;
    } else {
      const s1 = (o.scale ?? 1);
      sx = s1; sy = s1; sz = s1;
    }
    wrapper.scale.set(sx, sy, sz);
    // Negative scale inverts triangle winding → default FrontSide culling
    // hides the now-back-facing surfaces. DoubleSide on every material keeps
    // both windings visible so the flipped object reads correctly.
    if (sx < 0 || sy < 0 || sz < 0) forceDoubleSide(wrapper);

    wrapper.userData.v3dObjectId = o.id;
    if (o._egg) {
      wrapper.userData.v3dEgg = true;
      wrapper.traverse((n) => { n.userData.v3dEgg = true; });
    }
    rootObjects.add(wrapper);
  }
}

// Apply a JPEG texture to every visible Mesh in an object's hierarchy.
//
// Projection modes (controls UV generation):
//   'box'      — use mesh's native UVs as-is (cube faces / equirect / cylindrical / GLB authored)
//   'plane'    — flat projection onto a plane perpendicular to `axis` (x/y/z)
//   'sphere'   — equirectangular projection from the mesh's bounding-box center
//   'cylinder' — cylindrical wrap around `axis` (x/y/z)
// For non-box modes, the mesh's geometry is CLONED and given new UVs so cached
// primitive geometries aren't mutated for other objects.
//
// Sizing modes (control texture.repeat):
//   'fixed'  : 100 px/m natural-size; repeat = object_size / image_meters
//   'meters' : author-specified widthMeters/heightMeters
//   'stretch': repeat = (1, 1) — image fills the UV space
function applyObjectTexture(rootMesh, tex) {
  const projection = tex.projection || 'box';
  const axis = tex.axis || 'y';
  if (projection !== 'box') {
    // Regenerate UVs on each visible mesh of the object hierarchy.
    rootMesh.traverse((n) => {
      if (!n.isMesh) return;
      const g = n.geometry.clone();
      // regenerateUVsForProjection may de-index the geometry for cylinder/
      // sphere (to give seam triangles unique UVs), so it returns the
      // possibly-new geometry to assign back to the mesh.
      n.geometry = regenerateUVsForProjection(g, projection, axis);
    });
  }

  const loader = new THREE.TextureLoader();
  const texSrc = tex.url ? resolveAssetUrl(tex.url) : tex.dataUrl;
  // Skip URLs that 404'd previously so a single bad reference in state
  // doesn't spam the network on every state-rebuild.
  if (_objectDeadUrls?.has?.(texSrc)) return;
  loader.load(texSrc, (texture) => {
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
    texture.colorSpace = THREE.SRGBColorSpace;
    rootMesh.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(rootMesh);
    const size = new THREE.Vector3();
    box.getSize(size);
    let repU = 1, repV = 1;
    const mode = tex.sizingMode || 'fixed';
    if (mode === 'fixed') {
      const wM = texture.image.naturalWidth  / 100;
      const hM = texture.image.naturalHeight / 100;
      repU = Math.max(0.01, size.x / wM);
      repV = Math.max(0.01, size.y / hM);
    } else if (mode === 'meters' && tex.widthMeters && tex.heightMeters) {
      repU = Math.max(0.01, size.x / tex.widthMeters);
      repV = Math.max(0.01, size.y / tex.heightMeters);
    }
    texture.repeat.set(repU, repV);
    // Optional projection flips. Three.js mirrors a texture by negating the
    // `repeat` component on that axis; the texture then starts at offset = 1
    // and walks backwards. Without the offset bump the image would slide
    // one unit out of the [0,1] sample range and appear shifted instead of
    // mirrored. Honoured for every projection mode (box/plane/sphere/cyl).
    if (tex.flipU) { texture.repeat.x = -texture.repeat.x; texture.offset.x = 1 + (texture.offset.x || 0); }
    if (tex.flipV) { texture.repeat.y = -texture.repeat.y; texture.offset.y = 1 + (texture.offset.y || 0); }
    // Rotation in degrees, around the texture's centre. Only move the
    // centre to (0.5, 0.5) when we ACTUALLY rotate — Three's texture
    // matrix composes scale around centre too, so setting centre while
    // repeat > 1 (tiled) shifts every tile by half a tile and the texture
    // appears offset (top showing mid-image, etc.). With rotation = 0 we
    // want the default centre (0, 0) so tiling starts at the origin.
    const rotRadO = (Number(tex.rotation) || 0) * Math.PI / 180;
    if (rotRadO !== 0) texture.center.set(0.5, 0.5);
    else               texture.center.set(0, 0);
    texture.rotation = rotRadO;
    rootMesh.traverse((n) => {
      if (n.isMesh) {
        const oldMat = n.material;
        const newMat = (oldMat?.isMeshBasicMaterial)
          ? oldMat.clone()
          : new THREE.MeshBasicMaterial({ color: 0xffffff });
        newMat.map = texture;
        newMat.color.set(0xffffff);
        n.material = newMat;
        n.material.needsUpdate = true;
      }
    });
  }, undefined, () => { _objectDeadUrls.add(texSrc); });
}
const _objectDeadUrls = new Set();


// AABBs for collision — uses each object's bounding box scaled to placement.
export function objectAABBs(scene, s) {
  const aabbs = [];
  if (!s.objects?.length) return aabbs;
  scene.traverse((node) => {
    if (node.userData?.v3dObjectId) {
      const box = new THREE.Box3().setFromObject(node);
      const entry = s.objects.find((o) => o.id === node.userData.v3dObjectId);
      if (entry && entry.collide !== false) aabbs.push(box);
    }
  });
  return aabbs;
}
