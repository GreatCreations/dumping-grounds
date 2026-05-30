// engine/inked.js — inked-comic edge rendering + render-mode registry.
//
// Strokes use LineSegments2 + LineMaterial from three/addons/lines/ instead
// of LineBasicMaterial — LineBasicMaterial's linewidth is locked at 1 px in
// WebGL2, so strokes alias to invisibility at oblique angles or distances.
// LineMaterial draws actual screen-space-thick segments via an instanced
// quad shader, which keeps strokes readable everywhere.
//
// Three render modes:
//   - all-edges  : EdgesGeometry with ~30° crease threshold (default look).
//   - silhouette : BackSide-rendered slightly-scaled mesh in black; cheap
//                  toon-outline. Composes with other passes.
//   - both       : both.

import * as THREE from 'three';
import * as BufferGeometryUtils from 'three/addons/utils/BufferGeometryUtils.js';
import { LineSegments2 }       from 'three/addons/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';
import { LineMaterial }        from 'three/addons/lines/LineMaterial.js';

const STROKE_COLOR = 0x0b0d14;
const EDGE_THRESHOLD_DEG = 30;
const JITTER_AMOUNT = 0.012;

// Single shared LineMaterial — engine.js updates `resolution` on resize so
// the on-screen pixel thickness stays correct.
export const sharedLineMaterial = new LineMaterial({
  color: STROKE_COLOR,
  linewidth: 1.6,            // pixels
  worldUnits: false,
  alphaToCoverage: false,
  // fog: true so the strokes fade with the scene fog. Originally false to
  // keep the inked-comic look crisp at all distances, but the user wants
  // distant edges to swallow into the atmospheric haze along with the
  // fills.
  fog: true,
  resolution: new THREE.Vector2(window.innerWidth, window.innerHeight),
});

const modes = new Map();
export function registerRenderMode(name, fn) { modes.set(name, fn); }
export function applyRenderMode(name, mesh, parent) {
  const fn = modes.get(name) || modes.get('all-edges');
  fn(mesh, parent);
}

// Build a LineSegments2 from a mesh's geometry by extracting its edges.
// Uses a custom edge extractor that excludes BOTH:
//   - coplanar edges  (angle ≤ 30° — same as default EdgesGeometry behavior)
//   - back-to-back edges (angle ≥ 170° — adjacent triangles facing opposite
//     ways, i.e. the internal seam where a sill meets a solid wall cell)
// This is the key seam-hiding mechanism around windows.
function buildEdgeLines(geometry, jitterAmount = JITTER_AMOUNT) {
  const positions = extractCleanEdges(geometry, EDGE_THRESHOLD_DEG, 170);
  // Apply hand-drawn jitter to each point in place.
  if (jitterAmount > 0) {
    for (let i = 0; i < positions.length; i++) {
      positions[i] += (Math.random() - 0.5) * jitterAmount;
    }
  }
  const lineGeom = new LineSegmentsGeometry();
  lineGeom.setPositions(positions);
  const line = new LineSegments2(lineGeom, sharedLineMaterial);
  line.computeLineDistances();
  return line;
}

// Custom edge extractor. Returns a flat Float32Array of positions in line-pair
// order (start, end, start, end, ...). Edges are kept where the dihedral
// angle between adjacent triangle normals is in (minAngleDeg, maxAngleDeg).
//   minAngleDeg ≈ 30  — discard coplanar edges (standard inked-comic behavior)
//   maxAngleDeg ≈ 170 — discard back-to-back edges (eliminates internal seams)
function extractCleanEdges(geometry, minAngleDeg, maxAngleDeg) {
  const minDot = Math.cos(minAngleDeg * Math.PI / 180);  // ~  0.866
  const maxDot = Math.cos(maxAngleDeg * Math.PI / 180);  // ~ -0.985

  const positions = geometry.attributes.position.array;
  const idxAttr = geometry.index;
  const idx = idxAttr ? idxAttr.array : null;
  const triCount = idx ? (idx.length / 3) : (positions.length / 9);

  // Map edge → list of face normals sharing it. Key by sorted (a, b) vertex hashes.
  const edgeMap = new Map();
  const hashFor = new Map();   // index -> position-hash (to merge coincident verts)
  function hash(i) {
    if (hashFor.has(i)) return hashFor.get(i);
    const x = positions[i * 3].toFixed(4);
    const y = positions[i * 3 + 1].toFixed(4);
    const z = positions[i * 3 + 2].toFixed(4);
    const h = `${x},${y},${z}`;
    hashFor.set(i, h);
    return h;
  }
  function edgeKey(a, b) {
    const ha = hash(a), hb = hash(b);
    return ha < hb ? `${ha}|${hb}` : `${hb}|${ha}`;
  }
  function faceNormal(a, b, c) {
    const ax = positions[a*3], ay = positions[a*3+1], az = positions[a*3+2];
    const bx = positions[b*3], by = positions[b*3+1], bz = positions[b*3+2];
    const cx = positions[c*3], cy = positions[c*3+1], cz = positions[c*3+2];
    const ex = bx - ax, ey = by - ay, ez = bz - az;
    const fx = cx - ax, fy = cy - ay, fz = cz - az;
    let nx = ey * fz - ez * fy;
    let ny = ez * fx - ex * fz;
    let nz = ex * fy - ey * fx;
    const len = Math.hypot(nx, ny, nz) || 1;
    return [nx/len, ny/len, nz/len];
  }

  for (let t = 0; t < triCount; t++) {
    const a = idx ? idx[t * 3]     : t * 3;
    const b = idx ? idx[t * 3 + 1] : t * 3 + 1;
    const c = idx ? idx[t * 3 + 2] : t * 3 + 2;
    const n = faceNormal(a, b, c);
    for (const [p, q] of [[a, b], [b, c], [c, a]]) {
      const k = edgeKey(p, q);
      let rec = edgeMap.get(k);
      if (!rec) { rec = { v: [p, q], normals: [] }; edgeMap.set(k, rec); }
      rec.normals.push(n);
    }
  }

  const out = [];
  for (const { v, normals } of edgeMap.values()) {
    let keep = false;
    if (normals.length === 1) {
      keep = true;  // boundary edge — always draw
    } else if (normals.length >= 2) {
      // Check EVERY pair of adjacent-triangle normals around this edge.
      // The original code only inspected the first two, which made the
      // outcome depend on triangle iteration order — so refreshes (or
      // rebuilds after a merge) could flip the seam state. Touching walls
      // routinely produce 3+ normals at the touching edge (2 from each
      // wall's face); the only way to correctly classify such an edge is
      // to consider all pairs. Keep the edge if ANY pair sits in the
      // "sharp angle" range; if every pair is either coplanar (~0°) or
      // back-to-back (~180°), the edge is internal and gets dropped.
      outer:
      for (let i = 0; i < normals.length; i++) {
        const ni = normals[i];
        for (let j = i + 1; j < normals.length; j++) {
          const nj = normals[j];
          const dot = ni[0]*nj[0] + ni[1]*nj[1] + ni[2]*nj[2];
          if (dot < minDot && dot > maxDot) { keep = true; break outer; }
        }
      }
    }
    if (!keep) continue;
    const [a, b] = v;
    out.push(positions[a*3], positions[a*3+1], positions[a*3+2]);
    out.push(positions[b*3], positions[b*3+1], positions[b*3+2]);
  }
  return out;
}

// --- Mode primitives (each does ONE thing; walls.js composes them) ---

// Thin-line edge overlay. Adds a LineSegments2 on top of the mesh; doesn't
// touch the mesh's material or visibility.
export function applyAllEdges(mesh, parent) {
  const line = buildEdgeLines(mesh.geometry);
  line.position.copy(mesh.position);
  line.rotation.copy(mesh.rotation);
  line.scale.copy(mesh.scale);
  line.renderOrder = (mesh.renderOrder ?? 0) + 1;
  parent.add(line);
}

// Thick-line wireframe overlay (strokes only). Doesn't touch the mesh —
// walls.js is responsible for deciding whether the body shows beneath these
// lines (silhouette ON → black body, otherwise wireframe alone → hidden body).
export function applyWireframeStrokes(mesh, parent) {
  if (!mesh.geometry) return;
  const edgeGeom = new THREE.EdgesGeometry(mesh.geometry, EDGE_THRESHOLD_DEG);
  const positions = new Float32Array(edgeGeom.attributes.position.array);
  const lineGeom = new LineSegmentsGeometry();
  lineGeom.setPositions(positions);
  const lines = new LineSegments2(lineGeom, silhouetteLineMaterial);
  lines.computeLineDistances();
  lines.position.copy(mesh.position);
  lines.rotation.copy(mesh.rotation);
  lines.scale.copy(mesh.scale);
  parent.add(lines);
  edgeGeom.dispose();
}

// Solid-shape silhouette: REPLACE the mesh's material with stroke-color
// MeshBasicMaterial. FrontSide only, so the mesh reads as a closed cut-paper
// shape from outside. (No overlay — silhouette IS the shape.)
const _silhouetteFillMaterial = new THREE.MeshBasicMaterial({
  color: STROKE_COLOR,
  side: THREE.FrontSide,
  // 90% semi-transparent so the silhouette reads as a tinted shape rather
  // than a solid block — other geometry, paint, and JPEGs behind it stay
  // visible. depthWrite off so transparent overlap with painted/textured
  // surfaces composites correctly instead of z-fighting.
  transparent: true,
  opacity: 0.1,
  depthWrite: false,
});
export function applySilhouetteFill(mesh) {
  if (!mesh.geometry) return;
  mesh.material = _silhouetteFillMaterial;
}

// Legacy single-mode dispatch (for callers that still use applyRenderMode).
// The new walls.js bypasses this and composes the primitives directly.
registerRenderMode('all-edges', applyAllEdges);

// Outline width in WORLD-SPACE meters. Each vertex of the silhouette copy is
// pushed outward along its normal by this distance, so thickness is uniform
// everywhere on the mesh (independent of vertex distance from geometry origin).
const OUTLINE_WIDTH_METERS = 0.028;
// Silhouette mode's OUTER rim displacement — pushes the rim outward beyond
// the object's actual surface. The silhouette body itself sits at the
// object's true size; the rim adds the "thick walls outward" appearance.
const SILHOUETTE_RIM_METERS = 0.08;

const outlineMaterial = new THREE.ShaderMaterial({
  uniforms: {
    outlineColor: { value: new THREE.Color(STROKE_COLOR) },
    outlineWidth: { value: OUTLINE_WIDTH_METERS },
  },
  vertexShader: `
    uniform float outlineWidth;
    void main() {
      vec3 displaced = position + normalize(normal) * outlineWidth;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(displaced, 1.0);
    }
  `,
  fragmentShader: `
    uniform vec3 outlineColor;
    void main() {
      gl_FragColor = vec4(outlineColor, 1.0);
    }
  `,
  side: THREE.BackSide,
});

// Build and attach the normal-displaced back-side outline mesh. Used by
// 'both' mode (and previously by silhouette before its redesign).
function addOutlineMesh(mesh, parent) {
  if (!mesh.geometry?.attributes?.normal) {
    mesh.geometry?.computeVertexNormals?.();
  }
  const outline = new THREE.Mesh(mesh.geometry, outlineMaterial);
  outline.position.copy(mesh.position);
  outline.rotation.copy(mesh.rotation);
  outline.scale.copy(mesh.scale);
  outline.renderOrder = (mesh.renderOrder ?? 0) - 1;
  parent.add(outline);
}

// Silhouette body — object's exact geometry rendered in black, front-faced,
// no normal displacement (sits at the object's true size). depthWrite off
// so other scene objects render through (the "portal" effect).
const silhouetteBodyMaterial = new THREE.MeshBasicMaterial({
  color: STROKE_COLOR,
  side: THREE.FrontSide,
  depthWrite: false,
  depthTest:  true,
});

// Silhouette = THICK WIREFRAME of the object's edges. The interior is empty
// (no fill mesh), so other scene objects are naturally visible through it —
// no portal tricks, no depth-write hacks, just hollow line geometry. The
// line material is shared across all silhouettes and is updated for screen
// resolution from engine.js the same way sharedLineMaterial is.
// Wireframe-mode thick line color. Charcoal grey (NOT the inky black of the
// thin all-edges strokes) so the wireframe reads as a structural overlay
// rather than competing with the thin edges in intensity.
const WIREFRAME_STROKE_COLOR = 0x4a4a4a;
export const silhouetteLineMaterial = new LineMaterial({
  color: WIREFRAME_STROKE_COLOR,
  linewidth: 5,             // thick pixels — distinct from the 1.6px all-edges
  worldUnits: false,
  alphaToCoverage: false,
  fog: true,                // fades with scene fog like sharedLineMaterial
  resolution: new THREE.Vector2(window.innerWidth, window.innerHeight),
});

// Cache welded geometries per source — mergeVertices is O(n), no point
// running it every render-mode reapplication on the same geometry.
const _weldedCache = new WeakMap();
function weldedGeometry(source) {
  let welded = _weldedCache.get(source);
  if (welded) return welded;
  welded = BufferGeometryUtils.mergeVertices(source, 0.001);
  welded.computeVertexNormals();   // averaged normals point diagonally outward
  _weldedCache.set(source, welded);
  return welded;
}

// Legacy single-mode dispatchers for 'wireframe' and 'silhouette'. When called
// individually (no combination), each does the "complete" version of its mode:
//   wireframe  → hide the body + add thick stroke overlay (pure wireframe)
//   silhouette → replace body material with solid stroke color
// walls.js's combo logic bypasses these so it can mix the primitives.
registerRenderMode('wireframe', (mesh, parent) => {
  mesh.visible = false;                 // pure wireframe — no body
  applyWireframeStrokes(mesh, parent);
});
registerRenderMode('silhouette', (mesh /*, parent */) => {
  applySilhouetteFill(mesh);
});

registerRenderMode('both', (mesh, parent) => {
  // 'both' = outline + edges with the OBJECT STAYING OPAQUE. We deliberately
  // bypass the silhouette registration (which makes the mesh translucent)
  // and add the outline mesh directly, then layer all-edges on top.
  addOutlineMesh(mesh, parent);
  modes.get('all-edges')(mesh, parent);
});
