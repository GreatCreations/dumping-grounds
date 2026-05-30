// engine/walls.js — cell-based wall rendering.
//
// Each wall is a connected set of cells. Each cell becomes a 1x1xH box
// (or a sill + lintel pair for window cells). All cells of all walls in a
// given render mode are merged into ONE geometry, then mergeVertices welds
// coincident vertices so internal seams between adjacent cells of the same
// wall disappear.
//
// Window placement is per-cell: any cell can have isWindow=true. The cell-
// based model lets a single wall have windows at arbitrary positions, and
// L-shaped / blob-shaped walls work just as well as straight spans.
//
// Legacy walls (axis/from/to span) are transparently handled by cellsOf()
// in core/schema.js — this renderer just consumes cells.

import * as THREE from 'three';
import * as BufferGeometryUtils from 'three/addons/utils/BufferGeometryUtils.js';
import {
  applyAllEdges, applyWireframeStrokes, applySilhouetteFill,
  sharedLineMaterial, silhouetteLineMaterial,
} from './inked.js';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js';
import { cellsOf, wallRenderModes } from '../core/schema.js';
import { buildPaintPlanesForRect, clearPaintPlanes } from './painting.js';
import { regenerateUVsForProjection } from './projection.js';
import { resolveAssetUrl } from '../core/asset-paths.js';
// Stair sub-meshes (treads, risers, posts, runner, underside, banister,
// stringer) are far too irregular for the cell-face paint-plane recipe
// walls use — the old code wrapped the entire staircase in an AABB
// cube of 6 paint planes that sat nowhere near the visible step
// surfaces. attachPaintOverlays gives each sub-mesh a connected-
// component atlas (same system as GLB objects), so every tread /
// riser / post face / runner segment / rail face becomes its own
// paint region routed through the object-paint codepath in painting.js.
//
// Stair sub-meshes ship without a UV attribute (built from positions +
// colors only). attachPaintOverlays bails on geometries without UVs
// because the component-atlas math measures each island's input-UV
// span to fit it into its slot. paintifyStair() runs a UV synthesis
// first.
//
// The synthesis MUST use per-triangle face normals, not the per-vertex
// normals that the built-in regenerateUVsForProjection('box') uses.
// On any beam-shaped sub-mesh (rail, stringer, post) each corner
// vertex is welded across 3 faces by mergeVertices, so the smoothed
// vertex normal averages to ~(0.577, 0.577, 0.577) and every vertex
// falls into the Y-dominant triplanar branch. That maps EVERY vertex
// to an X-Z plane UV: top + bottom triangles get sensible UV area
// (because they span X and Z), but inner / outer / end-cap triangles
// degenerate to zero UV area (their X or Z is constant). The brush
// rasterizer's UV-to-world basis then collapses to a 1-pixel-line
// parallelogram and paint renders as nothing — which is exactly the
// "only the top of the banister paints" symptom that motivated this.
//
// _genPerTriangleTriplanarUVs computes the face normal directly from
// the triangle's two edges and picks the projection plane (XZ / YZ /
// XY) per-triangle so each face's UVs span its actual world extent.
import { attachPaintOverlays } from './objects.js';
function _genPerTriangleTriplanarUVs(geom) {
  if (geom.index) geom = geom.toNonIndexed();
  geom.computeBoundingBox();
  const bb = geom.boundingBox;
  const size = { x: bb.max.x - bb.min.x || 1, y: bb.max.y - bb.min.y || 1, z: bb.max.z - bb.min.z || 1 };
  const pos = geom.attributes.position;
  const triCount = pos.count / 3;
  const uv = new Float32Array(pos.count * 2);
  for (let t = 0; t < triCount; t++) {
    const i0 = t * 3, i1 = i0 + 1, i2 = i0 + 2;
    const ax = pos.getX(i0), ay = pos.getY(i0), az = pos.getZ(i0);
    const bx = pos.getX(i1), by = pos.getY(i1), bz = pos.getZ(i1);
    const cx = pos.getX(i2), cy = pos.getY(i2), cz = pos.getZ(i2);
    const e1x = bx - ax, e1y = by - ay, e1z = bz - az;
    const e2x = cx - ax, e2y = cy - ay, e2z = cz - az;
    const nx = Math.abs(e1y * e2z - e1z * e2y);
    const ny = Math.abs(e1z * e2x - e1x * e2z);
    const nz = Math.abs(e1x * e2y - e1y * e2x);
    // pickXZ when face normal is dominantly Y (horizontal face);
    // pickYZ when dominantly X (perp-axis-facing side); else XY
    // (along-axis-facing end cap).
    const pickXZ = (ny >= nx && ny >= nz);
    const pickYZ = (!pickXZ && nx >= nz);
    for (const idx of [i0, i1, i2]) {
      const x = pos.getX(idx), y = pos.getY(idx), z = pos.getZ(idx);
      let u, v;
      if (pickXZ)      { u = (x - bb.min.x) / size.x; v = (z - bb.min.z) / size.z; }
      else if (pickYZ) { u = (z - bb.min.z) / size.z; v = (y - bb.min.y) / size.y; }
      else             { u = (x - bb.min.x) / size.x; v = (y - bb.min.y) / size.y; }
      uv[idx * 2]     = u;
      uv[idx * 2 + 1] = v;
    }
  }
  geom.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  return geom;
}
function paintifyStair(mesh) {
  if (!mesh?.geometry) return;
  if (!mesh.geometry.attributes.uv) {
    // toNonIndexed returns a new BufferGeometry; reassign the mesh.
    mesh.geometry = _genPerTriangleTriplanarUVs(mesh.geometry);
  }
  attachPaintOverlays(mesh);
}

const DEFAULT_WINDOW_HEIGHT = 1.0;
const DEFAULT_DOOR_HEIGHT = 2.5;        // height of door opening (= bottom of header)
const DEFAULT_HEADER_HEIGHT = 0.5;      // thickness of the header beam (top edge at doorH+headerH)

const HEIGHTS = {
  full:           3.0,
  'three-quarter':2.25,
  half:           1.5,
  quarter:        0.75,    // knee-height short wall
  'window-start': 3.0,
  'window-end':   3.0,
  'door-start':   3.0,    // door cell is a true gap — no geometry, no collision
  'door-end':     3.0,
  windowed:       3.0,    // generic windowed kind (windows are per-cell)
  corner:         3.0,    // L-shaped wall — same default height as full
  stairs:         3.0,    // stairs use customHeight (or rise×stepCount) — this default never reached for stairs
};

function wallHeight(w) {
  if (typeof w.customHeight === 'number' && w.customHeight > 0) return w.customHeight;
  return HEIGHTS[w.kind] ?? HEIGHTS.full;
}

// N-band gradient texture for MeshToonMaterial. Three.js samples the
// R channel of this texture with NEAREST filter to remap continuous
// directional-light intensity into N discrete bands — that's what
// produces the cel-shaded look. So the NUMBER of distinct sRGB
// values in the gradient = the visible number of shading levels.
// Range picked to keep the comic-book high-key aesthetic (everything
// sits in light grey) while being wide enough that bands are
// individually visible up to N=10. The previous hardcoded 2-band
// gradient was the bug the user was hitting: the inspector wrote
// world.toonShading.levels but no engine code ever read it.
export function makeToonGradient(levels) {
  const N = Math.max(2, Math.min(5, Math.round(levels) || 3));
  // Range chosen so individual bands are clearly readable through the
  // directional + ambient light blend on the off-white wall base. The
  // previous 0xa8–0xc8 range was too tight: bands ended up ~6 sRGB
  // units apart at the final pixel, which is at the perceptibility
  // floor. 0x80–0xe8 is a 104-unit range that survives the blend and
  // gives each level a distinct sRGB step.
  const minV = 0x80;   // darkest band (shadow side)
  const maxV = 0xe8;   // brightest band (lit side)
  const data = new Uint8Array(N * 4);
  for (let i = 0; i < N; i++) {
    const t = i / (N - 1);
    const v = Math.round(minV + (maxV - minV) * t);
    data[i * 4 + 0] = v;
    data[i * 4 + 1] = v;
    data[i * 4 + 2] = v;
    data[i * 4 + 3] = 0xff;
  }
  const tex = new THREE.DataTexture(data, N, 1, THREE.RGBAFormat);
  tex.minFilter = THREE.NearestFilter;
  tex.magFilter = THREE.NearestFilter;
  tex.needsUpdate = true;
  return tex;
}

// Pick the right surface material for a colored, opaque fill based on
// the world's lighting flags. Used by walls (the base surface), the
// stair runner, opening frames, and trim — anything whose role is "a
// painted surface that should participate in shading + shadows when
// those are on, and stay flat comic-book when they're off." Pass any
// extra MeshBasic-compatible options (side, vertexColors, depthWrite,
// etc.) and they're applied to whichever material type wins.
export function chooseSurfaceMaterial(s, color, extraOpts = {}) {
  const toonOn   = !!s?.world?.toonShading?.enabled;
  const shadowOn = !!s?.world?.shadows?.enabled;
  if (toonOn) {
    return new THREE.MeshToonMaterial({
      color,
      gradientMap: makeToonGradient(s.world.toonShading.levels),
      ...extraOpts,
    });
  }
  if (shadowOn) {
    // Lambert receives shadows; basic doesn't. So when shadows are on
    // but toon is off, Lambert is the minimum lit material that lets
    // the surface darken in shadow regions.
    return new THREE.MeshLambertMaterial({ color, ...extraOpts });
  }
  return new THREE.MeshBasicMaterial({ color, ...extraOpts });
}

// Cached toon material for walls — re-keyed by level count so a level
// change rebuilds the gradient texture. The single shared instance is
// reused across all toon-shaded walls (and stairs clone() it locally
// when they need vertex colours).
let _toonMaterial = null;
let _toonLevels = null;
function sharedToonMaterial(levels) {
  const N = Math.max(2, Math.min(5, Math.round(levels) || 3));
  if (_toonMaterial && _toonLevels === N) return _toonMaterial;
  const gradTex = makeToonGradient(N);
  if (_toonMaterial) {
    _toonMaterial.gradientMap?.dispose();
    _toonMaterial.gradientMap = gradTex;
    _toonMaterial.needsUpdate = true;
  } else {
    _toonMaterial = new THREE.MeshToonMaterial({
      color: 0xffffff,            // multiply through with the gradient
      gradientMap: gradTex,
    });
  }
  _toonLevels = N;
  return _toonMaterial;
}

export function buildWalls(rootWalls, s) {
  rootWalls.clear();
  clearPaintPlanes();   // reset the painting layer's plane registry
  if (!s.walls?.length) return;
  const cellSize = s.grid.cellSizeMeters;


  // Group walls. Walls with a per-shape baseTexture each get their own
  // group so the rect/paint-plane build can carry the wall reference for
  // base-JPEG composition. Walls without textures group by (mode, height)
  // for performance (greedy meshing across them, seams welded away).
  const groups = new Map();
  for (const w of s.walls) {
    // Stairs render via a dedicated pipeline (stepped boxes) — handled
    // BEFORE the standard wall grouping so they don't accidentally get
    // merged into a regular wall greedy-mesh group.
    if (w.kind === 'stairs') {
      buildStairs(rootWalls, w, cellSize, s);
      continue;
    }
    // Each wall gets its OWN group — we always need `wallRef = w` available
    // downstream so per-wall fields (doorHeight, windowHeight, customHeight,
    // baseTexture, etc.) flow into geometry. Cross-wall greedy-merging is
    // explicitly the user's "shift-select + Merge" workflow, not implicit.
    const modes = wallRenderModes(w).slice().sort();
    const h = wallHeight(w);
    const key = `w|${w.id}`;
    if (!groups.has(key)) groups.set(key, {
      modes, h, cellMap: new Map(), wallRef: w,
    });
    const cm = groups.get(key).cellMap;
    for (const c of cellsOf(w)) {
      const ck = `${c.r},${c.c}`;
      if (!cm.has(ck)) cm.set(ck, { r: c.r, c: c.c, isWindow: !!c.isWindow, isDoor: !!c.isDoor, windowHeight: c.windowHeight ?? null });
      else {
        const existing = cm.get(ck);
        if (c.isWindow) existing.isWindow = true;
        if (existing.windowHeight == null && c.windowHeight != null) existing.windowHeight = c.windowHeight;
      }
    }
  }

  for (const { modes, h, cellMap, wallRef } of groups.values()) {
    // Doors are openings WITH a header above (like a real door frame). They
    // contribute a top "header" slab but no sill — the opening goes from the
    // floor to doorHeight, then wall material from doorHeight to wallHeight.
    // Door cells flow through here so greedy-mesh + strip-build see them and
    // process them as a special run type.
    const cells = [...cellMap.values()];
    if (!cells.length) continue;

    const { rects, windows, doors } = greedyMesh(cells);
    const doorH = (wallRef && typeof wallRef.doorHeight === 'number' && wallRef.doorHeight > 0)
      ? wallRef.doorHeight : DEFAULT_DOOR_HEIGHT;
    const geomList = [];
    for (const rect of rects) {
      const bw = (rect.c1 - rect.c0 + 1) * cellSize;
      const bd = (rect.r1 - rect.r0 + 1) * cellSize;
      const cx = (rect.c0 - 1 + (rect.c1 - rect.c0 + 1) / 2) * cellSize;
      const cz = (rect.r0       + (rect.r1 - rect.r0 + 1) / 2) * cellSize;
      geomList.push(makeBox(bw, h, bd, cx, h / 2, cz));
    }
    // Greedy-mesh window cells too — adjacent windows in a row (or column)
    // with the same windowHeight become ONE sill rectangle and ONE lintel
    // rectangle instead of N pairs of unit boxes. Without this, the box
    // path drops in a seam line between every pair of adjacent windows
    // (the strip path handles 1D walls cleanly, but L-shapes / multi-row
    // walls fall back here and were showing the seams).
    const windowGroups = new Map();   // wh value → list of window cells
    for (const wc of windows) {
      const wh = (typeof wc.windowHeight === 'number' && wc.windowHeight > 0)
        ? wc.windowHeight : DEFAULT_WINDOW_HEIGHT;
      if (!windowGroups.has(wh)) windowGroups.set(wh, []);
      windowGroups.get(wh).push(wc);
    }
    for (const [wh, group] of windowGroups) {
      const sillH = Math.max(0, (h - wh) / 2);
      if (sillH <= 0) continue;
      const wrects = greedyRectsFromCells(group);
      for (const rect of wrects) {
        const bw = (rect.c1 - rect.c0 + 1) * cellSize;
        const bd = (rect.r1 - rect.r0 + 1) * cellSize;
        const cx = (rect.c0 - 1 + (rect.c1 - rect.c0 + 1) / 2) * cellSize;
        const cz = (rect.r0       + (rect.r1 - rect.r0 + 1) / 2) * cellSize;
        geomList.push(makeBox(bw, sillH, bd, cx, sillH / 2, cz));
        geomList.push(makeBox(bw, sillH, bd, cx, h - sillH / 2, cz));
      }
    }
    // Greedy-mesh door header beams. Adjacent door cells with the same
    // header geometry collapse into one long beam instead of N unit boxes,
    // killing the seam line between merged doors in the box path.
    if (doors.length) {
      const headerOffset = Math.max(0, wallRef?.windowHeight || 0);
      const beamBottom   = doorH + headerOffset;
      const beamTop      = Math.min(h, beamBottom + DEFAULT_HEADER_HEIGHT);
      const beamH        = Math.max(0, beamTop - beamBottom);
      if (beamH > 0) {
        const drects = greedyRectsFromCells(doors);
        for (const rect of drects) {
          const bw = (rect.c1 - rect.c0 + 1) * cellSize;
          const bd = (rect.r1 - rect.r0 + 1) * cellSize;
          const cx = (rect.c0 - 1 + (rect.c1 - rect.c0 + 1) / 2) * cellSize;
          const cz = (rect.r0       + (rect.r1 - rect.r0 + 1) / 2) * cellSize;
          geomList.push(makeBox(bw, beamH, bd, cx, beamBottom + beamH / 2, cz));
        }
      }
    }
    if (!geomList.length) continue;

    // 1D-strip walls (all cells share one row OR one column) get rebuilt via
    // ExtrudeGeometry with the window as a HOLE in a single continuous outline.
    // This eliminates the internal vertical stroke that used to appear where
    // the windowed run met its solid neighbor — there's no separate corner
    // anymore because there are no separate boxes.
    const cellsArr = [...cellMap.values()];
    const stripGeom = tryBuildStripGeometry(cellsArr, h, cellSize, wallRef);
    let merged;
    if (stripGeom) {
      merged = stripGeom;
      merged.computeVertexNormals();
    } else if (wallRef?.backfaceWhenMerged) {
      // Opt-in voxel-mesh path. Emits each cell × y-slice face only when
      // the neighbour in that direction is EMPTY, so internal touching
      // faces between adjacent cells of the same wall are never created.
      // Corners, sill/lintel/header boundaries, and wall-to-wall touches
      // (within this wall) are seam-free. Trade-off: there are no
      // internal-side faces, which can look "see-through" from certain
      // angles on legacy meshes — kept opt-in until that's smoothed.
      merged = buildVoxelMesh(cells, h, cellSize, wallRef, doorH);
      merged = BufferGeometryUtils.mergeVertices(merged, 0.001);
      merged.computeVertexNormals();
    } else {
      // Default box-path. Greedy-meshed boxes per cell type, then
      // mergeVertices + removeCoincidentTriangles to cancel matching
      // internal faces between adjacent boxes. Leaves a small seam at
      // partial-overlap boundaries (L corners, wall-to-window heights)
      // but every face is double-sided so the wall reads correctly from
      // any angle. This is what "default new wall" behaves like.
      merged = BufferGeometryUtils.mergeGeometries(geomList, false);
      merged = BufferGeometryUtils.mergeVertices(merged, 0.001);
      merged = removeCoincidentTriangles(merged);
      merged.computeVertexNormals();
    }

    // For textured walls, regenerate UVs based on the chosen projection mode
    // (box keeps default cube UVs). Apply the texture as the wall's material.
    const baseSrc = wallRef?.baseTexture && (wallRef.baseTexture.url || wallRef.baseTexture.dataUrl);
    let fillMat;
    if (baseSrc) {
      const proj = wallRef.baseTexture.projection || 'box';
      const axis = wallRef.baseTexture.axis || 'y';
      // projection may de-index for cylinder/sphere to fix seam triangles.
      merged = regenerateUVsForProjection(merged, proj, axis);
      fillMat = makeWallTextureMaterial(merged, wallRef.baseTexture);
    } else if (s.world?.toonShading?.enabled) {
      // N-band face shading: faces lit by the directional sun fall into
      // one of `levels` discrete bands. Subtle enough not to break the
      // monochrome rule but adds 3D readability.
      fillMat = sharedToonMaterial(s.world.toonShading.levels);
    } else if (s.world?.shadows?.enabled) {
      // Shadows on (without toon): Lambert so face-direction lighting
      // darkens back faces naturally. Shadows landing on already-dark
      // back faces blend in instead of standing out as discrete dark
      // patches on a flat-bright surface.
      fillMat = new THREE.MeshLambertMaterial({ color: 0xfafaf7 });
    } else {
      // Neither: stay flat MeshBasicMaterial for the inked-comic
      // baseline (every face uniformly bright, edges + silhouette
      // carry the shape).
      fillMat = new THREE.MeshBasicMaterial({ color: 0xfafaf7 });
    }
    const mesh = new THREE.Mesh(merged, fillMat);
    rootWalls.add(mesh);
    // Combination logic — body visibility belongs to the "fill" question;
    // stroke overlays are independent of it:
    //   silhouette ON          → body visible, material = solid stroke color.
    //   else if edges ON       → body visible with its default fill (so the
    //                            user always sees the FACES when edges is on,
    //                            even when wireframe strokes are added too).
    //   else if wireframe ON   → body HIDDEN — the strokes ARE the wall
    //                            (pure see-through wireframe).
    //   nothing on             → invisible.
    // After fill is decided, layer thin edges and/or thick wireframe lines.
    const hasEdges    = modes.includes('all-edges');
    const hasWire     = modes.includes('wireframe');
    const hasSilh     = modes.includes('silhouette');
    const hasBackface = modes.includes('backface');
    if (!hasEdges && !hasWire && !hasSilh && !hasBackface) {
      mesh.visible = false;
    } else {
      if (hasSilh) {
        applySilhouetteFill(mesh);
      } else if (!hasEdges && hasWire && !hasBackface) {
        mesh.visible = false;
      }
      // Backface mode REPLACES the wall's material side with BackSide so
      // only the far-side faces draw — looking at the wall from outside,
      // you see THROUGH the near face to the back of the opposite face.
      // Done as a material mutation (clone first so we don't poison shared
      // materials), not a second mesh, so the front-face fill no longer
      // hides what backface is supposed to show.
      if (hasBackface) {
        mesh.material = mesh.material.clone();
        mesh.material.side = THREE.BackSide;
      }
      if (hasEdges) applyAllEdges(mesh, rootWalls);
      if (hasWire)  applyWireframeStrokes(mesh, rootWalls);
      // Backface mode is "solid backface + stroke" by definition — if the
      // user didn't also tick another stroke layer, add the thin edge
      // stroke automatically so the wall outline reads.
      if (hasBackface && !hasEdges && !hasWire && !hasSilh) {
        applyAllEdges(mesh, rootWalls);
      }
    }

    // Emit a paint plane per face of each greedy-meshed rectangle. For
    // base-textured walls, wallRef is the originating wall — paint planes
    // use it to draw the base JPEG as the background composition layer.
    for (const rect of rects) {
      const rectInfo = { r0: rect.r0, c0: rect.c0, r1: rect.r1, c1: rect.c1, cellSize };
      const planes = buildPaintPlanesForRect(rectInfo, h, s.palette, wallRef);
      for (const p of planes) rootWalls.add(p);
    }
    // Sub-region paint planes for window sills, window lintels, and door
    // headers. Without these the raycast passes through the filled regions
    // of door/window cells because rect-based planes only cover the SOLID
    // rectangles. Each gets its own dirSuffix so its sidecar entries don't
    // collide with the full-wall plane at the same cell (relevant if a
    // wall's geometry changes between cell types over time).
    for (const wc of windows) {
      const wh = (typeof wc.windowHeight === 'number' && wc.windowHeight > 0)
        ? wc.windowHeight : DEFAULT_WINDOW_HEIGHT;
      const sillH = Math.max(0, (h - wh) / 2);
      if (sillH <= 0) continue;
      const cellRect = { r0: wc.r, c0: wc.c, r1: wc.r, c1: wc.c, cellSize };
      const sillPlanes = buildPaintPlanesForRect(cellRect, h, s.palette, wallRef, null,
        { yMin: 0, yMax: sillH, dirSuffix: '-sill' });
      for (const p of sillPlanes) rootWalls.add(p);
      const lintelPlanes = buildPaintPlanesForRect(cellRect, h, s.palette, wallRef, null,
        { yMin: h - sillH, yMax: h, dirSuffix: '-lintel' });
      for (const p of lintelPlanes) rootWalls.add(p);
    }
    for (const dc of doors) {
      const headerOffset = Math.max(0, wallRef?.windowHeight || 0);
      const beamBottom = doorH + headerOffset;
      const beamTop = Math.min(h, beamBottom + DEFAULT_HEADER_HEIGHT);
      if (beamTop <= beamBottom) continue;
      const cellRect = { r0: dc.r, c0: dc.c, r1: dc.r, c1: dc.c, cellSize };
      const headerPlanes = buildPaintPlanesForRect(cellRect, h, s.palette, wallRef, null,
        { yMin: beamBottom, yMax: beamTop, dirSuffix: '-header' });
      for (const p of headerPlanes) rootWalls.add(p);
    }
  }

}

// One wall → 1-N boxes. Greedy meshing collapses contiguous solid cells into
// the largest rectangle possible so a straight 20-cell wall is one box, not
// 20. Window cells become their own sill+lintel pair (they're skipped by the
// solid-rectangle pass).
function wallToBoxes(wall, cellSize) {
  const h = wallHeight(wall);
  const windowH = (typeof wall.windowHeight === 'number' && wall.windowHeight > 0)
    ? wall.windowHeight : DEFAULT_WINDOW_HEIGHT;
  const cw = (typeof wall.customWidth === 'number' && wall.customWidth > 0 && wall.customWidth <= 1)
    ? wall.customWidth : 1;
  const cells = cellsOf(wall);
  if (!cells.length) return [];

  const doorH = (typeof wall.doorHeight === 'number' && wall.doorHeight > 0)
    ? wall.doorHeight : DEFAULT_DOOR_HEIGHT;
  const { rects, windows, doors } = greedyMesh(cells);
  const out = [];

  for (const rect of rects) {
    const cellsX = rect.c1 - rect.c0 + 1;
    const cellsZ = rect.r1 - rect.r0 + 1;
    let w = cellsX * cellSize;
    let d = cellsZ * cellSize;
    // customWidth shrinks the wall's MINOR axis (a thin centered strip).
    if (cellsZ === 1 && cellsX > 1) d = cw * cellSize;
    else if (cellsX === 1 && cellsZ > 1) w = cw * cellSize;
    else if (cellsX === 1 && cellsZ === 1) { w = cw * cellSize; d = cw * cellSize; }
    const cx = (rect.c0 - 1 + cellsX / 2) * cellSize;
    const cz = (rect.r0       + cellsZ / 2) * cellSize;
    out.push(makeBox(w, h, d, cx, h / 2, cz));
  }

  for (const wc of windows) {
    const cx = (wc.c - 1 + 0.5) * cellSize;
    const cz = (wc.r + 0.5)     * cellSize;
    const sillH   = Math.max(0, (h - windowH) / 2);
    const lintelH = Math.max(0, (h - windowH) / 2);
    const ww = cw * cellSize;   // sill/lintel match the wall's customWidth
    if (sillH   > 0) out.push(makeBox(ww, sillH,   ww, cx, sillH   / 2, cz));
    if (lintelH > 0) out.push(makeBox(ww, lintelH, ww, cx, h - lintelH / 2, cz));
  }
  for (const dc of doors) {
    // Door geometry = a single header beam at variable Y.
    //   doorH (wall.doorHeight)       = where the opening ends / header bottom
    //   headerThickness (windowHeight) = thickness of the header beam
    // Header spans [doorH, doorH+headerThickness], clamped to wallHeight.
    // Above the header within the door cell is empty (the wall is open there).
    const cx = (dc.c - 1 + 0.5) * cellSize;
    const cz = (dc.r + 0.5)     * cellSize;
    const headerThickness = (typeof wall.windowHeight === 'number' && wall.windowHeight > 0)
      ? wall.windowHeight : DEFAULT_HEADER_HEIGHT;
    const headerTop = Math.min(h, doorH + headerThickness);
    const headerH = Math.max(0, headerTop - doorH);
    const ww = cw * cellSize;
    if (headerH > 0) out.push(makeBox(ww, headerH, ww, cx, doorH + headerH / 2, cz));
  }
  return out;
}

// Greedy mesh: cover the solid cells of a wall with the fewest axis-aligned
// rectangles. Window cells are returned separately. Algorithm:
//   1. Sort solid cells by (r, c).
//   2. For each unused solid cell (r0, c0): extend right along the row until
//      a window/missing cell stops it (c1). Then extend down: as long as the
//      full row [c0..c1] is solid+unused at r+1, advance.
//   3. Mark the rectangle [r0..r1, c0..c1] as used. Emit it.
function greedyMesh(cells) {
  const cellMap = new Map();
  for (const c of cells) cellMap.set(`${c.r},${c.c}`, c);
  const used = new Set();
  const rects = [];
  const sorted = cells.slice().sort((a, b) => (a.r - b.r) || (a.c - b.c));

  for (const start of sorted) {
    if (start.isWindow || start.isDoor) continue;   // openings split the rect
    const startKey = `${start.r},${start.c}`;
    if (used.has(startKey)) continue;

    // Extend right
    let c1 = start.c;
    while (true) {
      const next = cellMap.get(`${start.r},${c1 + 1}`);
      if (!next || next.isWindow || next.isDoor || used.has(`${start.r},${c1 + 1}`)) break;
      c1++;
    }
    // Extend down — every cell in [c0..c1] at next row must be solid+unused
    let r1 = start.r;
    outer:
    while (true) {
      const tryR = r1 + 1;
      for (let cc = start.c; cc <= c1; cc++) {
        const nk = `${tryR},${cc}`;
        const cell = cellMap.get(nk);
        if (!cell || cell.isWindow || cell.isDoor || used.has(nk)) break outer;
      }
      r1 = tryR;
    }
    // Mark used
    for (let rr = start.r; rr <= r1; rr++) {
      for (let cc = start.c; cc <= c1; cc++) used.add(`${rr},${cc}`);
    }
    rects.push({ r0: start.r, c0: start.c, r1, c1 });
  }

  const windows = cells.filter(c => c.isWindow && !c.isDoor);
  const doors   = cells.filter(c => c.isDoor);
  return { rects, windows, doors };
}

function makeBox(w, h, d, cx, cy, cz) {
  const g = new THREE.BoxGeometry(w, h, d);
  g.translate(cx, cy, cz);
  return g;
}

// Stairs — a stepped stack of thin boxes along the cell-list axis. Each
// step is rise tall × run deep × customWidth wide. The cells array
// determines the axis + length; rise/run determine step count; stairDir
// chooses which end is the bottom. Paint planes + edge strokes reuse
// the standard wall infrastructure: each step is added to a merged
// geometry, then mergeVertices + removeCoincidentTriangles cleans
// internal seams, then the standard wall material / edge / silhouette
// passes run on the result.
function buildStairs(rootWalls, wall, cellSize, s) {
  const cells = cellsOf(wall);
  if (!cells.length) return;
  // Footprint bbox. Cells were stored by the tool as a full grid
  // (run × width). Run axis = longer side of bbox. Drag direction is
  // preserved by the FIRST cell in the list being the LOW end.
  const rs = cells.map(c => c.r);
  const cs = cells.map(c => c.c);
  const rMin = Math.min(...rs), rMax = Math.max(...rs);
  const cMin = Math.min(...cs), cMax = Math.max(...cs);
  const rSpan = rMax - rMin + 1;
  const cSpan = cMax - cMin + 1;
  const axis = (cSpan >= rSpan) ? 'col' : 'row';
  // Low end (= first step at y=0) is whichever bbox corner is closest
  // to cells[0] (the user's drag start). stairDir 'backward' flips it.
  const first = cells[0];
  let lowIsMin;   // true if low end is at the smaller coordinate
  if (axis === 'col') lowIsMin = first.c === cMin;
  else                lowIsMin = first.r === rMin;
  if (wall.stairDir === 'backward') lowIsMin = !lowIsMin;
  const runLength = (axis === 'col' ? cSpan : rSpan) * cellSize;
  const perpExtent = (axis === 'col' ? rSpan : cSpan) * cellSize;
  const cellCountAlong = (axis === 'col' ? cSpan : rSpan);
  const run  = Math.max(0.01, wall.run  ?? 0.3);
  // Width: customWidth (metres) overrides the bbox-derived perp extent
  // when set. Default = derived from cells.
  const widthM = (wall.customWidth != null && wall.customWidth > 0)
    ? wall.customWidth : perpExtent;
  // Per-step rise: the user-set `wall.rise` directly controls how tall
  // each step is. Total staircase height = stepCount × rise. Larger
  // rise = taller staircase. stepCount derives from horizontal run / run
  // depth so step count follows the cell footprint.
  const rise = Math.max(0.01, wall.rise ?? 0.1);
  let stepCount = Math.max(1, Math.floor(runLength / run));
  let totalRise = stepCount * rise;
  // Landing h: caps the total stair climb. Any steps above this height
  // are dropped; the LAST kept step absorbs the remaining horizontal
  // run as a flat landing (via stepAlong's last-step extension).
  if (wall.landingHeight != null && wall.landingHeight > 0 && wall.landingHeight < totalRise) {
    stepCount = Math.max(1, Math.floor(wall.landingHeight / rise));
    totalRise = stepCount * rise;
  }
  // Perpendicular axis world centre.
  // For axis='col' (stair runs along X, perp along Z = row): rows are
  // 0-indexed, cell r spans z ∈ [r, r+1]·cellSize, so midpoint between
  // top of rMin and bottom of rMax is (rMin + rMax + 1)/2 · cellSize. ✓
  // For axis='row' (stair runs along Z, perp along X = col): cols are
  // 1-INDEXED (per core/grid-addr.js), cell c spans x ∈ [c-1, c]·cellSize.
  // Midpoint between LEFT of cMin and RIGHT of cMax is therefore
  // (cMin - 1 + cMax)/2 · cellSize = (cMin + cMax - 1)/2 · cellSize.
  // Old formula `((cMin + cMax)/2 + 0.5) * cellSize` used a 0-indexed
  // assumption and placed the stair one cell east of where it was
  // dragged on the map.
  const perpAxisCentre = (axis === 'col')
    ? ((rMin + rMax + 1) / 2) * cellSize
    : ((cMin + cMax - 1) / 2) * cellSize;
  // World coords for the low / high ends along the run axis.
  const runMinW = (axis === 'col') ? (cMin - 1) * cellSize : rMin * cellSize;
  const runMaxW = runMinW + runLength;

  // Build the outer-hull geometry directly — no internal faces, no
  // seams to clean up. Each step contributes: TREAD (top) + RISER
  // (front face going up to next step). The two perpendicular SIDES
  // are emitted as one stepped silhouette polygon each. BACK wall is
  // one tall rectangle. BOTTOM is one flat rectangle.
  const positions = [];
  // Perp world coords.
  const perpHalf = widthM / 2;
  const perpA = perpAxisCentre - perpHalf;   // "negative" perp side
  const perpB = perpAxisCentre + perpHalf;
  // Along-axis world coord helper: for step i, returns [near, far]
  // where near = closer to LOW end, far = closer to HIGH end. The LAST
  // step absorbs any leftover (runLength - stepCount*run) so the
  // staircase fully fills its cell footprint — no air gap between the
  // top step and the back wall.
  const stepAlong = (i) => {
    const isLast = (i === stepCount - 1);
    const beforeMe = i * run;
    const myRun = isLast ? (runLength - beforeMe) : run;
    if (lowIsMin) return [runMinW + beforeMe, runMinW + beforeMe + myRun];
    else          return [runMaxW - beforeMe - myRun, runMaxW - beforeMe];
  };
  // Convert (along, y, perp) to world (x, y, z) per axis.
  const worldXZ = (along, perp) => (axis === 'col')
    ? [along, perp]
    : [perp,  along];
  // Per-vertex colours, parallel to positions. DEFAULT_COL applies to
  // every face that doesn't supply an explicit colour (= everything
  // except optionally-colored treads). Vertex colors with material
  // `vertexColors: true` and `color: 0xffffff` mean each face renders
  // at its assigned tint, unaltered.
  const colors = [];
  const DEFAULT_COL = new THREE.Color(0xfafaf7);
  const stepCols = (wall.stepColors && wall.stepColors.length)
    ? wall.stepColors.map(c => new THREE.Color(c))
    : null;
  // Emit-target indirection. pushTri writes to `target.positions /
  // target.colors`; the banister + stringer blocks below swap `target`
  // so their geometry lands in dedicated buffers, which then become
  // their own Meshes after the main fill mesh is built. Splitting
  // them out lets each sub-mesh get its own paint atlas overlay —
  // banister rail / open-sides stringers / open-back centre stringer
  // are otherwise stuck inside the merged main mesh, which we no
  // longer atlas (paintifyStair on main was the streak source).
  const targetMain      = { positions, colors };
  const targetBanister  = { positions: [], colors: [] };
  const targetStringer  = { positions: [], colors: [] };
  let target = targetMain;
  const pushTri = (a, b, c, col = DEFAULT_COL) => {
    target.positions.push(a[0],a[1],a[2], b[0],b[1],b[2], c[0],c[1],c[2]);
    target.colors.push(col.r, col.g, col.b, col.r, col.g, col.b, col.r, col.g, col.b);
  };
  const pushQuad = (a, b, c, d, col = DEFAULT_COL) => { pushTri(a, b, c, col); pushTri(a, c, d, col); };

  for (let i = 0; i < stepCount; i++) {
    const [nearA, farA] = stepAlong(i);
    const stepBottom = i * rise;
    const stepTop    = stepBottom + rise;
    // Tread (top face of step). Outward normal +Y. Winding CCW from +Y view.
    // With nosing, the tread's FRONT edge (the edge facing the LOW end
    // direction) is extended by NOSING metres so it overhangs the riser
    // below. For forward (lowIsMin=true) the front is the smaller-along
    // coord = nearA; for backward it's the larger-along coord = farA.
    // We ALSO emit a vertical NOSE FACE quad hanging down by NOSING_H
    // from the tread's front edge so the nose reads as a real slab,
    // not a paper-thin overhang.
    {
      const NOSING = wall.stepNosing ? 0.025 : 0;
      const NOSING_H = wall.stepNosing ? 0.025 : 0;
      const aFront = lowIsMin ? (nearA - NOSING) : (farA + NOSING);
      const aBack  = lowIsMin ? farA : nearA;
      const p0 = worldXZ(aFront, perpA);  // front edge, side A
      const p1 = worldXZ(aBack,  perpA);
      const p2 = worldXZ(aBack,  perpB);
      const p3 = worldXZ(aFront, perpB);
      const treadCol = stepCols ? stepCols[i % stepCols.length] : DEFAULT_COL;
      pushQuad(
        [p0[0], stepTop, p0[1]],
        [p1[0], stepTop, p1[1]],
        [p2[0], stepTop, p2[1]],
        [p3[0], stepTop, p3[1]],
        treadCol,
      );
      // Nose front face — vertical slab at the tread's front edge,
      // hanging down by NOSING_H. Skipped when nosing is off.
      if (NOSING_H > 0) {
        pushQuad(
          [p0[0], stepTop - NOSING_H, p0[1]],
          [p3[0], stepTop - NOSING_H, p3[1]],
          [p3[0], stepTop,            p3[1]],
          [p0[0], stepTop,            p0[1]],
          treadCol,
        );
        // Nose underside — small horizontal quad at y = stepTop - NOSING_H
        // spanning along from the nose front (aFront) back to the riser
        // at the step's own near edge (= stepStart(k)). Closes the L-shape
        // so the silhouette's TIN→TRT edge and the nose-face's bottom
        // edge both share endpoints with this underside quad — no extra
        // boundary strokes get drawn at the nose underside.
        const aL_under = lowIsMin ? nearA : farA;
        const u0 = p0;  // aFront, perpA  (already computed above)
        const u3 = p3;  // aFront, perpB
        const ubA = worldXZ(aL_under, perpA);
        const ubB = worldXZ(aL_under, perpB);
        pushQuad(
          [u0[0], stepTop - NOSING_H, u0[1]],
          [u3[0], stepTop - NOSING_H, u3[1]],
          [ubB[0], stepTop - NOSING_H, ubB[1]],
          [ubA[0], stepTop - NOSING_H, ubA[1]],
          treadCol,
        );
      }
    }
    // Riser (vertical wall filling the gap BETWEEN this step's tread
    // and the next step's tread). The riser sits at the BOUNDARY
    // between adjacent steps along the run axis — that's `farA` when
    // the low end is at runMinW (forward), and `nearA` when the low
    // end is at runMaxW (backward), because stepAlong keeps
    // near < far in world coords regardless of stair direction. The
    // TOP step has no "next tread" so its riser is skipped.
    // Cap riser top at the NEXT step's nose-underside Y when nosing is
    // on, so the riser's top edge meets the nose underside back edge
    // endpoint-for-endpoint. Without this cap the riser passes through
    // y=yNoseInner with no vertex there, leaving the underside back as
    // a doubled boundary stroke.
    const NOSING_H_CAP = wall.stepNosing ? 0.025 : 0;
    const riserBottom = stepBottom + rise;
    const riserTop    = stepTop    + rise - NOSING_H_CAP;
    const riserAlong  = lowIsMin ? farA : nearA;
    if (!wall.openBack && i < stepCount - 1) {
      const p0 = worldXZ(riserAlong, perpA);
      const p1 = worldXZ(riserAlong, perpB);
      if (lowIsMin) {
        pushQuad(
          [p1[0], riserBottom, p1[1]],
          [p0[0], riserBottom, p0[1]],
          [p0[0], riserTop,    p0[1]],
          [p1[0], riserTop,    p1[1]],
        );
      } else {
        pushQuad(
          [p0[0], riserBottom, p0[1]],
          [p1[0], riserBottom, p1[1]],
          [p1[0], riserTop,    p1[1]],
          [p0[0], riserTop,    p0[1]],
        );
      }
    }
  }
  // GROUND riser — at the very LOW end of the staircase, y=[0, rise].
  // Bridges the floor to the first tread. Sits at the LOW end position
  // (runMinW for forward, runMaxW for backward), outward-facing the
  // approach direction. Skipped in open-back mode (no risers at all).
  if (!wall.openBack) {
    const groundAlong = lowIsMin ? runMinW : runMaxW;
    // Cap ground riser top at step 0's nose underside y when nosing is
    // on, so the ground riser top edge meets step 0's nose underside
    // back edge endpoint-for-endpoint.
    const NOSING_H_GROUND = wall.stepNosing ? 0.025 : 0;
    const groundTop = rise - NOSING_H_GROUND;
    const p0 = worldXZ(groundAlong, perpA);
    const p1 = worldXZ(groundAlong, perpB);
    if (lowIsMin) {
      pushQuad(
        [p1[0], 0,         p1[1]],
        [p0[0], 0,         p0[1]],
        [p0[0], groundTop, p0[1]],
        [p1[0], groundTop, p1[1]],
      );
    } else {
      pushQuad(
        [p0[0], 0,         p0[1]],
        [p1[0], 0,         p1[1]],
        [p1[0], groundTop, p1[1]],
        [p0[0], groundTop, p0[1]],
      );
    }
  }
  // BACK wall — tall vertical at the HIGH end, from y=0 to topmost step.
  {
    const highAlong = lowIsMin ? runMaxW : runMinW;
    const topY = stepCount * rise;
    const p0 = worldXZ(highAlong, perpA);
    const p1 = worldXZ(highAlong, perpB);
    if (lowIsMin) {
      // Back wall outward normal = +along
      pushQuad(
        [p0[0], 0,    p0[1]],
        [p1[0], 0,    p1[1]],
        [p1[0], topY, p1[1]],
        [p0[0], topY, p0[1]],
      );
    } else {
      // Back wall outward normal = -along
      pushQuad(
        [p1[0], 0,    p1[1]],
        [p0[0], 0,    p0[1]],
        [p0[0], topY, p0[1]],
        [p1[0], topY, p1[1]],
      );
    }
  }
  // BOTTOM face — REMOVED. Previously a y=0 quad that sealed the
  // staircase underside; now the world floor seals it from above
  // (player can't go below y=0 in normal play). The old quad
  // z-fought with the world floor and read as a stray "inside floor"
  // even when insideFloor was off.
  // Inside floor — opt-in walkable plane covering the staircase footprint.
  // Lifted 1 cm above world floor (y = 0.01) to avoid z-fighting with the
  // floor plane that draws at y=0. Collision AABB top in stairAABBs uses
  // the SAME y so the player's feet match the visible surface.
  if (wall.insideFloor) {
    const F = 0.01;
    const p0 = worldXZ(runMinW, perpA);
    const p1 = worldXZ(runMaxW, perpA);
    const p2 = worldXZ(runMaxW, perpB);
    const p3 = worldXZ(runMinW, perpB);
    // Top face: +Y outward normal (visible from above) — CCW from +Y.
    pushQuad(
      [p0[0], F, p0[1]],
      [p3[0], F, p3[1]],
      [p2[0], F, p2[1]],
      [p1[0], F, p1[1]],
    );
  }
  // SIDE walls — manual band triangulation. Each step k contributes ONE
  // band spanning y=[k*rise, (k+1)*rise]. For k < stepCount-1 the band
  // is a pentagon (its top edge is split at the next step's start so
  // band k's top-right segment exactly matches band k+1's bottom edge,
  // endpoint-for-endpoint). For k == stepCount-1 the band is a plain
  // rectangle. Every shared edge between adjacent bands / treads /
  // risers / back wall / bottom quad now has matching endpoints, so
  // mergeVertices welds them and extractCleanEdges drops the interior
  // diagonals as coplanar (dihedral 0°) — no spurious slope strokes.
  const lowEndA  = lowIsMin ? runMinW : runMaxW;
  const highEndA = lowIsMin ? runMaxW : runMinW;
  const stepStart = (k) => lowIsMin ? (lowEndA + k * run) : (lowEndA - k * run);
  // Nose-aware silhouette band triangulation. When nosing is OFF, each
  // band is a pentagon (BL, BR, TR, mid_top, TL) — a simple step-wise
  // staircase profile. When nosing is ON, the band becomes a HEPTAGON
  // (BL, BR, TR, mid_top, TL_top, TL_inner, TL_riser_top): the band's
  // upper-left corner has an L-notch matching the nose's underside +
  // front face. Fan from TL_riser_top (which can see every other
  // vertex from inside the heptagon). Each shared edge with the tread,
  // nose-face, and nose-underside geometry matches endpoint-for-
  // endpoint, so EdgesGeometry/extractCleanEdges resolves every seam
  // to a single stroke.
  const NOSING_B = wall.stepNosing ? 0.025 : 0;
  const NOSING_H = wall.stepNosing ? 0.025 : 0;
  const frontShiftB = lowIsMin ? -NOSING_B : NOSING_B;
  if (!wall.openSides) for (const sidePerp of [perpA, perpB]) {
    for (let k = 0; k < stepCount; k++) {
      const yBot = k * rise;
      const yTop = (k + 1) * rise;
      const aL = stepStart(k);
      const aR = highEndA;
      const blW = worldXZ(aL, sidePerp);
      const brW = worldXZ(aR, sidePerp);
      const BL = [blW[0], yBot, blW[1]];
      const BR = [brW[0], yBot, brW[1]];
      const TR = [brW[0], yTop, brW[1]];
      if (wall.stepNosing) {
        const yNoseInner = yTop - NOSING_H;
        const aLshifted  = aL + frontShiftB;
        const trtW = worldXZ(aL,        sidePerp);
        const tinW = worldXZ(aLshifted, sidePerp);
        const ttopW = worldXZ(aLshifted, sidePerp);
        const TRT = [trtW[0], yNoseInner, trtW[1]];
        const TIN = [tinW[0], yNoseInner, tinW[1]];
        const TLT = [ttopW[0], yTop,      ttopW[1]];
        if (k === stepCount - 1) {
          // Top band heptagon (no mid_top; TR → TL_top directly).
          pushTri(TRT, BL, BR);
          pushTri(TRT, BR, TR);
          pushTri(TRT, TR, TLT);
          pushTri(TRT, TLT, TIN);
        } else {
          const aMid = stepStart(k + 1);
          const midW = worldXZ(aMid, sidePerp);
          const MID = [midW[0], yTop, midW[1]];
          pushTri(TRT, BL, BR);
          pushTri(TRT, BR, TR);
          pushTri(TRT, TR, MID);
          pushTri(TRT, MID, TLT);
          pushTri(TRT, TLT, TIN);
        }
      } else {
        // No nosing — original pentagon (fan from BL).
        const tlW = worldXZ(aL, sidePerp);
        const TL = [tlW[0], yTop, tlW[1]];
        if (k === stepCount - 1) {
          pushTri(BL, BR, TR);
          pushTri(BL, TR, TL);
        } else {
          const aMid = stepStart(k + 1);
          const midW = worldXZ(aMid, sidePerp);
          const MID = [midW[0], yTop, midW[1]];
          pushTri(BL, BR, TR);
          pushTri(BL, TR, MID);
          pushTri(BL, MID, TL);
        }
      }
    }
  }
  // Stringer/banister helpers — declared up here so both the banister
  // block AND the stringer block below can use them. _emitBeam emits
  // a rectangular box defined by along-axis endpoints + perp + Y
  // centres; _emitStringerWithLanding wraps it to split a single beam
  // into sloped + horizontal segments when landing is in effect.
  const _emitBeam = (perpInner, perpOuter, aLow, aHigh, yLowCenter, yHighCenter, halfH) => {
    const yLowBot  = yLowCenter  - halfH;
    const yLowTop  = yLowCenter  + halfH;
    const yHighBot = yHighCenter - halfH;
    const yHighTop = yHighCenter + halfH;
    const cLBI = worldXZ(aLow,  perpInner);
    const cLBO = worldXZ(aLow,  perpOuter);
    const cHBI = worldXZ(aHigh, perpInner);
    const cHBO = worldXZ(aHigh, perpOuter);
    const LBI = [cLBI[0], yLowBot,  cLBI[1]];
    const LBO = [cLBO[0], yLowBot,  cLBO[1]];
    const LTI = [cLBI[0], yLowTop,  cLBI[1]];
    const LTO = [cLBO[0], yLowTop,  cLBO[1]];
    const HBI = [cHBI[0], yHighBot, cHBI[1]];
    const HBO = [cHBO[0], yHighBot, cHBO[1]];
    const HTI = [cHBI[0], yHighTop, cHBI[1]];
    const HTO = [cHBO[0], yHighTop, cHBO[1]];
    pushQuad(LTI, LTO, HTO, HTI);
    pushQuad(LBO, LBI, HBI, HBO);
    pushQuad(LBI, LTI, HTI, HBI);
    pushQuad(LBO, HBO, HTO, LTO);
    pushQuad(LBI, LBO, LTO, LTI);
    pushQuad(HBI, HTI, HTO, HBO);
  };
  const walkDirS   = lowIsMin ? 1 : -1;
  const stairsEndA = lowEndA + stepCount * run * walkDirS;
  const hasLanding = Math.abs(stairsEndA - highEndA) > 0.001;
  // Landing-aware staircase profile: linear from 0 at lowEndA up to
  // totalRise at stairsEndA, then flat at totalRise from stairsEndA to
  // highEndA. Used by both posts (for yMin and rail-reach yMax) and
  // for any consumer that needs the local staircase surface Y.
  const profileYAt = (a) => {
    if (!hasLanding) return ((a - lowEndA) / (highEndA - lowEndA)) * totalRise;
    const walked    = (a - lowEndA) * walkDirS;
    const stairsLen = (stairsEndA - lowEndA) * walkDirS;
    if (walked <= stairsLen) return (walked / stairsLen) * totalRise;
    return totalRise;
  };
  const _emitStringerWithLanding = (perpInner, perpOuter, halfH, lowCenter, highCenter) => {
    _emitBeam(perpInner, perpOuter, lowEndA, stairsEndA, lowCenter, highCenter, halfH);
    if (hasLanding) {
      _emitBeam(perpInner, perpOuter, stairsEndA, highEndA, highCenter, highCenter, halfH);
    }
  };
  // BANISTERS — opt-in rail beams along perpA/perpB sides at hand
  // height. Rail centreline = 0.9 m above the local staircase profile;
  // routes through the same _emitStringerWithLanding helper so the rail
  // traces the stepped portion then the landing horizontal portion when
  // landing is in effect.
  const _emitBanister = (perpCoord) => {
    const RH = 0.9;       // rail centerline height above local floor
    const RX = 0.02;      // rail half-thickness in Y
    const RW = 0.02;      // rail half-thickness in perp
    const isPerpA = (perpCoord === perpA);
    // Rail shifted INWARD by RW so the outer face sits exactly at the
    // staircase perp edge — the rail is fully ON the step, not
    // straddling the edge.
    const outerPerp = perpCoord;
    const innerPerp = isPerpA ? perpCoord + 2 * RW : perpCoord - 2 * RW;
    _emitStringerWithLanding(innerPerp, outerPerp, RX, RH, totalRise + RH);
  };
  target = targetBanister;
  if (wall.banisterLeft)  _emitBanister(perpA);
  if (wall.banisterRight) _emitBanister(perpB);
  target = targetMain;

  // BANISTER POSTS — emitted to a SEPARATE mesh (postPositions /
  // postColors) so the standard EdgesGeometry pass doesn't process
  // them. Custom edge geometry below emits ONLY the 4 visible vertical
  // corner edges (upper 90% of post height). No strokes on top or
  // bottom of post. No strokes on the bottom 10% of side corners.
  const postPositions = [];
  const postColors = [];
  const postCornerData = [];
  const _emitPost = (perpCoord, alongX, yMin) => {
    const PH = 0.025;
    const yMax = profileYAt(alongX) + 0.9;
    const aMin = alongX - PH;
    const aMax = alongX + PH;
    const pMin = perpCoord - PH;
    const pMax = perpCoord + PH;
    const c1 = worldXZ(aMin, pMin);
    const c2 = worldXZ(aMax, pMin);
    const c3 = worldXZ(aMax, pMax);
    const c4 = worldXZ(aMin, pMax);
    const v000 = [c1[0], yMin, c1[1]];
    const v100 = [c2[0], yMin, c2[1]];
    const v110 = [c3[0], yMin, c3[1]];
    const v010 = [c4[0], yMin, c4[1]];
    const v001 = [c1[0], yMax, c1[1]];
    const v101 = [c2[0], yMax, c2[1]];
    const v111 = [c3[0], yMax, c3[1]];
    const v011 = [c4[0], yMax, c4[1]];
    const pushPostTri = (a, b, c) => {
      postPositions.push(a[0],a[1],a[2], b[0],b[1],b[2], c[0],c[1],c[2]);
      postColors.push(DEFAULT_COL.r, DEFAULT_COL.g, DEFAULT_COL.b,
                       DEFAULT_COL.r, DEFAULT_COL.g, DEFAULT_COL.b,
                       DEFAULT_COL.r, DEFAULT_COL.g, DEFAULT_COL.b);
    };
    const pushPostQuad = (a, b, c, d) => { pushPostTri(a, b, c); pushPostTri(a, c, d); };
    pushPostQuad(v001, v011, v111, v101);
    pushPostQuad(v000, v100, v110, v010);
    pushPostQuad(v000, v010, v011, v001);
    pushPostQuad(v100, v101, v111, v110);
    pushPostQuad(v000, v001, v101, v100);
    pushPostQuad(v010, v110, v111, v011);
    // Record corner data so we can build custom edge geometry below.
    postCornerData.push({ corners: [c1, c2, c3, c4], yMin, yMax });
  };
  const _emitPosts = (perpCoord) => {
    // Five posts per banister, evenly spaced (bottom, lower-mid,
    // centre, upper-mid, top). With landing in effect, the TOP post
    // anchors at the END of the landing (highEndA at landingHeight),
    // not at the end of the stepped portion. Intermediate posts read
    // their Y from the landing-aware profile: linear up to stairsEndA,
    // flat at totalRise from stairsEndA to highEndA.
    const PH = 0.025;
    const walkDir = walkDirS;
    const insideFront = (k) => stepStart(k) + PH * walkDir;
    const insideBack  = (k) => stepStart(k + 1) - PH * walkDir;
    const treadY      = (k) => (k + 1) * rise;
    // Posts shifted INWARD by PH so their outer face sits exactly at
    // the staircase perp edge — the post is fully ON the step.
    const isPerpA = (perpCoord === perpA);
    const shiftedPerp = isPerpA ? perpCoord + PH : perpCoord - PH;
    // Shift all posts BACK (toward the high end of the staircase) by
    // one post width (2 × PH). walkDir handles direction flip so
    // backward stairs shift the opposite world-direction.
    const POST_SHIFT = 2 * PH * walkDir;
    // Tread Y at a given alongX — returns the step's tread top if in
    // the stepped portion, otherwise the landing height.
    const treadYAt = (a) => {
      if (hasLanding) {
        const walked    = (a - lowEndA) * walkDir;
        const stairsLen = (stairsEndA - lowEndA) * walkDir;
        if (walked >= stairsLen) return totalRise;
      }
      const walked = (a - lowEndA) * walkDir;
      const idx = Math.max(0, Math.min(stepCount - 1, Math.floor(walked / run)));
      return (idx + 1) * rise;
    };
    const bottomA = insideBack(0)                + POST_SHIFT;
    const topA    = (hasLanding
                       ? (highEndA - PH * walkDir)
                       : insideFront(stepCount - 1)) + POST_SHIFT;
    const topYMin = hasLanding ? totalRise : treadY(stepCount - 1);
    const centreA = (bottomA + topA) / 2;
    const lowMidA = (bottomA + centreA) / 2;
    const upMidA  = (centreA + topA)    / 2;
    _emitPost(shiftedPerp, bottomA, treadYAt(bottomA));
    _emitPost(shiftedPerp, lowMidA, treadYAt(lowMidA));
    _emitPost(shiftedPerp, centreA, treadYAt(centreA));
    _emitPost(shiftedPerp, upMidA,  treadYAt(upMidA));
    _emitPost(shiftedPerp, topA,    topYMin);
    if (hasLanding) {
      const bendA           = stairsEndA - PH * walkDir + POST_SHIFT;
      const halfBendBottomA = (bottomA + bendA) / 2;
      _emitPost(shiftedPerp, halfBendBottomA, treadYAt(halfBendBottomA));
      _emitPost(shiftedPerp, bendA,           treadYAt(bendA));
    }
  };
  if (wall.banisterLeft)  _emitPosts(perpA);
  if (wall.banisterRight) _emitPosts(perpB);

  // STRINGERS — opt-in diagonal beams. openSides emits two beams at
  // perpA/perpB; openBack emits one central beam at perpAxisCentre.
  // Both route through _emitStringerWithLanding (hoisted above the
  // banister block) so they get landing-aware two-segment treatment.
  // Stringer geometry diverts into targetStringer so the dedicated
  // stringer mesh built below catches paint via its own atlas.
  target = targetStringer;
  if (wall.openSides) {
    const HALF_H = 0.20;       // 40 cm tall
    const OUT    = 0.04;       // 4 cm outside perpA / perpB
    const IN     = 0.04;       // 4 cm inside (covers tread edges)
    const OFFSET = -0.05;
    _emitStringerWithLanding(perpA + IN, perpA - OUT, HALF_H, OFFSET, totalRise + OFFSET);
    _emitStringerWithLanding(perpB - IN, perpB + OUT, HALF_H, OFFSET, totalRise + OFFSET);
  }
  if (wall.openBack) {
    // Central stringer down the perp midline. Top edge parallel to the
    // staircase slope, offset DOWN by DROP metres below the slope.
    const HT = 0.08;
    const DROP = 0.02;
    const HALF_W = 0.04;
    const halfH = HT / 2;
    const innerPerp = perpAxisCentre + HALF_W;
    const outerPerp = perpAxisCentre - HALF_W;
    const lowCenter  = -halfH - DROP;
    const highCenter = totalRise - halfH - DROP;
    _emitStringerWithLanding(innerPerp, outerPerp, halfH, lowCenter, highCenter);
  }
  target = targetMain;

  let merged = new THREE.BufferGeometry();
  merged.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  merged.setAttribute('color',    new THREE.Float32BufferAttribute(colors, 3));
  merged = BufferGeometryUtils.mergeVertices(merged, 0.001);
  merged.computeVertexNormals();

  // Stair fill material. Same rules as walls: if a baseTexture is set, run
  // UV regeneration for the chosen projection mode and wrap the geometry
  // with a textured material. Otherwise solid white tinted by vertex
  // colours (per-step tints + main DEFAULT_COL elsewhere).
  // DoubleSide regardless — stairs are solid bodies the player can't
  // enter, and DoubleSide guarantees the geometry reads correctly
  // regardless of which way each face's winding produces a normal.
  const stairBaseSrc = wall.baseTexture && (wall.baseTexture.url || wall.baseTexture.dataUrl);
  let fillMat;
  if (stairBaseSrc) {
    const proj = wall.baseTexture.projection || 'box';
    const axis = wall.baseTexture.axis || 'y';
    merged = regenerateUVsForProjection(merged, proj, axis);
    fillMat = makeWallTextureMaterial(merged, wall.baseTexture);
    fillMat.side = THREE.DoubleSide;
    fillMat.vertexColors = true;
  } else if (s.world?.toonShading?.enabled) {
    // Toon shading: clone the shared toon material so we can enable
    // vertex colors (per-step stair colors) without affecting walls
    // that don't have a colour attribute.
    fillMat = sharedToonMaterial(s.world.toonShading.levels).clone();
    fillMat.vertexColors = true;
    fillMat.side = THREE.DoubleSide;
  } else {
    fillMat = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      vertexColors: true,
      side: THREE.DoubleSide,
    });
  }
  const mesh = new THREE.Mesh(merged, fillMat);
  rootWalls.add(mesh);
  // Render modes — reuse the same passes walls do.
  const modes = wallRenderModes(wall).slice().sort();
  const hasEdges = modes.includes('all-edges');
  const hasWire  = modes.includes('wireframe');
  const hasSilh  = modes.includes('silhouette');
  const _applyStairRenderModes = (m) => {
    if (!hasEdges && !hasWire && !hasSilh) { m.visible = false; return; }
    if (hasSilh) applySilhouetteFill(m);
    else if (!hasEdges && hasWire) m.visible = false;
    if (hasEdges) applyAllEdges(m, rootWalls);
    if (hasWire)  applyWireframeStrokes(m, rootWalls);
  };
  _applyStairRenderModes(mesh);

  // BANISTER + STRINGER SUB-MESHES — split out of the main merged
  // geometry so each can carry its own atlas paint overlay. Both
  // accumulate into their own target buffers above (targetBanister /
  // targetStringer); now we build a Mesh per non-empty buffer, share
  // fillMat with the main stair, and run the same render-mode passes
  // so edge / silhouette / wireframe strokes still appear on these
  // features. paintifyStair attaches a stretch-fit component atlas so
  // every rail / beam face becomes an individually paintable region.
  const _buildStairSubMesh = (buf, name) => {
    if (!buf.positions.length) return null;
    let g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(buf.positions, 3));
    g.setAttribute('color',    new THREE.Float32BufferAttribute(buf.colors, 3));
    g = BufferGeometryUtils.mergeVertices(g, 0.001);
    g.computeVertexNormals();
    const sm = new THREE.Mesh(g, fillMat);
    sm.name = name;
    rootWalls.add(sm);
    return sm;
  };
  const banisterMesh = _buildStairSubMesh(targetBanister, 'stair-banister');
  if (banisterMesh) { _applyStairRenderModes(banisterMesh); paintifyStair(banisterMesh); }
  const stringerMesh = _buildStairSubMesh(targetStringer, 'stair-stringer');
  if (stringerMesh) { _applyStairRenderModes(stringerMesh); paintifyStair(stringerMesh); }

  // POST FILL MESH — separate from main stair so the standard edge
  // pass doesn't process posts. Custom edge geometry below emits only
  // the upper-90% of each post's vertical corners.
  if (postPositions.length > 0) {
    let postGeom = new THREE.BufferGeometry();
    postGeom.setAttribute('position', new THREE.Float32BufferAttribute(postPositions, 3));
    postGeom.setAttribute('color',    new THREE.Float32BufferAttribute(postColors, 3));
    postGeom = BufferGeometryUtils.mergeVertices(postGeom, 0.001);
    postGeom.computeVertexNormals();
    const postMesh = new THREE.Mesh(postGeom, fillMat);
    rootWalls.add(postMesh);
    paintifyStair(postMesh);
    if (hasSilh) applySilhouetteFill(postMesh);
    if (!hasEdges && !hasWire && !hasSilh) postMesh.visible = false;
    else if (!hasEdges && hasWire && !hasSilh) postMesh.visible = false;
    // Custom edges: 4 vertical corner segments per post, from
    // yMin + 1% of post height up to yMax - 3% of post height.
    // No top/bottom face strokes; no bottom 1% of side strokes; no
    // top 3% of side strokes.
    if (hasEdges || hasWire) {
      const edgePos = [];
      for (const data of postCornerData) {
        const h = data.yMax - data.yMin;
        const yVisStart = data.yMin + 0.01 * h;
        const yVisEnd   = data.yMax - 0.03 * h;
        for (const c of data.corners) {
          edgePos.push(c[0], yVisStart, c[1],  c[0], yVisEnd, c[1]);
        }
      }
      if (edgePos.length > 0) {
        const lineGeom = new LineSegmentsGeometry();
        lineGeom.setPositions(edgePos);
        const lineMat = hasWire ? silhouetteLineMaterial : sharedLineMaterial;
        const lines = new LineSegments2(lineGeom, lineMat);
        lines.computeLineDistances();
        rootWalls.add(lines);
      }
    }
  }
  // Paint: per-cell quads (tread tops + stringer outer sides) on the
  // main mesh PLUS an atlas overlay on the main mesh (catches the
  // step risers between sub-step cells, the back wall when no per-
  // cell back plane was emitted, and any other in-main-mesh feature
  // not covered by a cell-face plane). Risers in particular have no
  // cell-face plane equivalent — they sit at intermediate Y between
  // tread Ys and aren't aligned to any cell boundary, so only the
  // atlas can catch them.
  //
  // The atlas overlay on the main mesh USED to streak at long-thin
  // banister rail sides and stringer side beams. Both of those have
  // since been split into their own dedicated sub-meshes (built
  // above, each with its own atlas), so the main mesh atlas now
  // contains only treads / risers / back wall / step caps — none of
  // them extreme-aspect — and the stretch-fit slot scaling change
  // in attachPaintOverlays keeps any remaining anisotropy from
  // producing sub-pixel brush parallelograms.
  //
  // dirSuffix '-stair' keeps these paint keys separate from any
  // regular wall paint on the same cell — paint sidecar is
  // `${r},${c},${dir}` so the suffix prevents collision.
  paintifyStair(mesh);
  {
    const cellsAlongRun = (axis === 'row')
      ? Array.from({ length: rMax - rMin + 1 }, (_, i) => rMin + i)
      : Array.from({ length: cMax - cMin + 1 }, (_, i) => cMin + i);
    const cellsPerpRun  = (axis === 'row')
      ? Array.from({ length: cMax - cMin + 1 }, (_, i) => cMin + i)
      : Array.from({ length: rMax - rMin + 1 }, (_, i) => rMin + i);

    // For axis='row' the run direction is along Z (n/s); perp is X (w/e).
    // Stringer sides live on 'w' (perpA at -X) and 'e' (perpB at +X) of
    // the perp-extent cells. Ground riser + back wall live on 'n' / 's'.
    // For axis='col' swap: run is along X (w/e), perp is Z (n/s). Stringer
    // sides on 'n' / 's', ground riser + back wall on 'w' / 'e'.
    const runDirLowFace  = (axis === 'row')
      ? (lowIsMin ? 'n' : 's')          // ground riser face of the low-end cell
      : (lowIsMin ? 'w' : 'e');
    const runDirHighFace = (axis === 'row')
      ? (lowIsMin ? 's' : 'n')          // back wall face of the high-end cell
      : (lowIsMin ? 'e' : 'w');
    const perpFaceMinus  = (axis === 'row') ? 'w' : 'n';   // stringer at perpA
    const perpFacePlus   = (axis === 'row') ? 'e' : 's';   // stringer at perpB

    for (const aIdx of cellsAlongRun) {
      // Cell's high-toward-stair-top axis world coord. For 'row' axis
      // and lowIsMin, the stair climbs as r increases, so cell r's high
      // end is (r+1)*cellSize. For lowIsMin=false the stair climbs as r
      // decreases, so cell r's high end is r*cellSize. Same logic for
      // 'col' axis with c.
      const aLow  = aIdx * cellSize;
      const aHigh = (aIdx + 1) * cellSize;
      const aTopEnd = lowIsMin ? aHigh : aLow;
      const walked = (aTopEnd - lowEndA) * (lowIsMin ? 1 : -1);
      const topStep = Math.max(0, Math.min(stepCount, Math.ceil(walked / run)));
      const cellTopY = topStep * rise;
      if (cellTopY <= 0) continue;   // cell entirely before the stair's first step

      for (const pIdx of cellsPerpRun) {
        const r0 = (axis === 'row') ? aIdx : pIdx;
        const c0 = (axis === 'row') ? pIdx : aIdx;
        const skipFaces = new Set(['b', runDirLowFace, runDirHighFace]);
        // Drop the perp-side faces that face an interior cell of a
        // multi-cell-wide stair so painting only lands on the outer
        // stringer surfaces. For single-cell-wide stairs (perp count =
        // 1) both perp faces are exterior and both are kept.
        if (pIdx !== cellsPerpRun[0])                       skipFaces.add(perpFaceMinus);
        if (pIdx !== cellsPerpRun[cellsPerpRun.length - 1]) skipFaces.add(perpFacePlus);
        // openSides hides the solid side walls in favour of diagonal
        // stringer beams. Without this skip the per-cell perp-face
        // quads stay alive and catch paint in mid-air where the side
        // wall used to be. The stringer beams themselves are painted
        // through the main mesh's atlas overlay (separate mechanism).
        if (wall.openSides) {
          skipFaces.add(perpFaceMinus);
          skipFaces.add(perpFacePlus);
        }

        const rectInfo = { r0, r1: r0, c0, c1: c0, cellSize };
        const planes = buildPaintPlanesForRect(
          rectInfo, cellTopY, s.palette, wall, skipFaces,
          { dirSuffix: '-stair' },
        );
        for (const p of planes) rootWalls.add(p);
      }
    }

    // Ground riser face — single plane at the low-end cell, spanning
    // y=[0, rise]. Sits in front of the actual ground riser geometry.
    // Mirrors the visible geometry's own gate at line ~732 ("Skipped
    // in open-back mode (no risers at all)") — if the ground riser
    // isn't drawn, neither is its paint plane, otherwise the player
    // sees paint floating where a now-invisible riser used to be.
    if (stepCount >= 1 && !wall.openBack) {
      const lowAIdx = lowIsMin ? cellsAlongRun[0] : cellsAlongRun[cellsAlongRun.length - 1];
      for (const pIdx of cellsPerpRun) {
        const r0 = (axis === 'row') ? lowAIdx : pIdx;
        const c0 = (axis === 'row') ? pIdx : lowAIdx;
        const skipFaces = new Set(['b', 't', perpFaceMinus, perpFacePlus, runDirHighFace]);
        const rectInfo = { r0, r1: r0, c0, c1: c0, cellSize };
        const planes = buildPaintPlanesForRect(
          rectInfo, rise, s.palette, wall, skipFaces,
          { dirSuffix: '-stair-low' },
        );
        for (const p of planes) rootWalls.add(p);
      }
    }

    // Back wall face — single plane at the high-end cell spanning the
    // staircase's full Y extent. Skipped when openBack is on (the
    // back wall is replaced with a central beam in that mode and the
    // back face is empty air; a paint plane there would catch hits in
    // a region the player can see straight through).
    if (!wall.openBack) {
      const highAIdx = lowIsMin ? cellsAlongRun[cellsAlongRun.length - 1] : cellsAlongRun[0];
      for (const pIdx of cellsPerpRun) {
        const r0 = (axis === 'row') ? highAIdx : pIdx;
        const c0 = (axis === 'row') ? pIdx : highAIdx;
        const skipFaces = new Set(['b', 't', perpFaceMinus, perpFacePlus, runDirLowFace]);
        const rectInfo = { r0, r1: r0, c0, c1: c0, cellSize };
        const planes = buildPaintPlanesForRect(
          rectInfo, totalRise, s.palette, wall, skipFaces,
          { dirSuffix: '-stair-high' },
        );
        for (const p of planes) rootWalls.add(p);
      }
    }
  }
  // CARPET RUNNER — opt-in coloured/textured strip down the centre of
  // each tread. Separate mesh layered 5 mm above the tread + 5 mm in
  // front of each riser/nose so it doesn't z-fight. Wraps over the
  // riser fronts and (if nosing is on) over the nose face so the
  // runner appears to continuously flow down the staircase.
  if (wall.runnerEnabled) {
    const runnerWidth = Math.max(0.05, wall.runnerWidth ?? 0.5);
    const runnerHalfW = runnerWidth / 2;
    const runnerPerpLow  = perpAxisCentre - runnerHalfW;
    const runnerPerpHigh = perpAxisCentre + runnerHalfW;
    const RUNNER_LIFT = 0.005;
    const NOSING_R = wall.stepNosing ? 0.025 : 0;
    const frontShiftR = lowIsMin ? -NOSING_R : NOSING_R;
    const rPositions = [];
    const rUVs = [];
    for (let i = 0; i < stepCount; i++) {
      const isLast = (i === stepCount - 1);
      const beforeMe = i * run;
      const myRun = isLast ? (runLength - beforeMe) : run;
      const sNearA = lowIsMin ? runMinW + beforeMe : runMaxW - beforeMe - myRun;
      const sFarA  = lowIsMin ? runMinW + beforeMe + myRun : runMaxW - beforeMe;
      const yR = (i + 1) * rise + RUNNER_LIFT;
      // Tread runner — front edge respects nosing so the tread runner
      // extends over the nose just like the tread does.
      const aFrontR = (lowIsMin ? sNearA : sFarA) + frontShiftR;
      const aBackR  = (lowIsMin ? sFarA  : sNearA);
      const tF_lo = worldXZ(aFrontR, runnerPerpLow);
      const tB_lo = worldXZ(aBackR,  runnerPerpLow);
      const tB_hi = worldXZ(aBackR,  runnerPerpHigh);
      const tF_hi = worldXZ(aFrontR, runnerPerpHigh);
      rPositions.push(
        tF_lo[0], yR, tF_lo[1],  tB_lo[0], yR, tB_lo[1],  tB_hi[0], yR, tB_hi[1],
        tF_lo[0], yR, tF_lo[1],  tB_hi[0], yR, tB_hi[1],  tF_hi[0], yR, tF_hi[1],
      );
      rUVs.push(0, 0,  1, 0,  1, 1,  0, 0,  1, 1,  0, 1);
      // Nose front runner — vertical strip on the nose face when nosing
      // is on. Hangs from the tread top down by NOSING_H at the nose
      // front edge. Pushed 5 mm forward (toward LOW end) of the nose
      // face so it sits in front without z-fight.
      if (NOSING_R > 0) {
        const noseFrontA = aFrontR + (lowIsMin ? -RUNNER_LIFT : RUNNER_LIFT);
        const yNoseBot = (i + 1) * rise - 0.025;
        const yNoseTop = (i + 1) * rise;
        const nLowA  = worldXZ(noseFrontA, runnerPerpLow);
        const nHighA = worldXZ(noseFrontA, runnerPerpHigh);
        rPositions.push(
          nLowA[0],  yNoseBot, nLowA[1],   nHighA[0], yNoseBot, nHighA[1],   nHighA[0], yNoseTop, nHighA[1],
          nLowA[0],  yNoseBot, nLowA[1],   nHighA[0], yNoseTop, nHighA[1],   nLowA[0],  yNoseTop, nLowA[1],
        );
        rUVs.push(0, 0,  1, 0,  1, 1,  0, 0,  1, 1,  0, 1);
      }
      // Riser runner — vertical strip on the riser between THIS tread
      // and the NEXT tread. Skipped for the topmost step (no next tread).
      // Pushed 5 mm in the LOW-end direction so it sits in front of
      // the riser face without z-fight.
      if (i < stepCount - 1) {
        const riserAlongR = (lowIsMin ? sFarA : sNearA);
        const aR = riserAlongR + (lowIsMin ? -RUNNER_LIFT : RUNNER_LIFT);
        const yBot = (i + 1) * rise;
        const yTop = (i + 2) * rise;
        const rLowA  = worldXZ(aR, runnerPerpLow);
        const rHighA = worldXZ(aR, runnerPerpHigh);
        rPositions.push(
          rLowA[0],  yBot, rLowA[1],   rHighA[0], yBot, rHighA[1],   rHighA[0], yTop, rHighA[1],
          rLowA[0],  yBot, rLowA[1],   rHighA[0], yTop, rHighA[1],   rLowA[0],  yTop, rLowA[1],
        );
        rUVs.push(0, 0,  1, 0,  1, 1,  0, 0,  1, 1,  0, 1);
      }
    }
    // Ground riser runner — vertical strip in FRONT of the first step,
    // from floor (y=0) up to the first tread (y=rise) at the LOW end.
    {
      const groundAlongR = lowEndA + (lowIsMin ? -RUNNER_LIFT : RUNNER_LIFT);
      const gLowA  = worldXZ(groundAlongR, runnerPerpLow);
      const gHighA = worldXZ(groundAlongR, runnerPerpHigh);
      rPositions.push(
        gLowA[0],  0,    gLowA[1],   gHighA[0], 0,    gHighA[1],   gHighA[0], rise, gHighA[1],
        gLowA[0],  0,    gLowA[1],   gHighA[0], rise, gHighA[1],   gLowA[0],  rise, gLowA[1],
      );
      rUVs.push(0, 0,  1, 0,  1, 1,  0, 0,  1, 1,  0, 1);
    }
    const runnerGeom = new THREE.BufferGeometry();
    runnerGeom.setAttribute('position', new THREE.Float32BufferAttribute(rPositions, 3));
    runnerGeom.setAttribute('uv',       new THREE.Float32BufferAttribute(rUVs, 2));
    runnerGeom.computeVertexNormals();
    const runnerColor = new THREE.Color(wall.runnerColor || '#c0392b');
    const runnerMat = new THREE.MeshBasicMaterial({ color: runnerColor, side: THREE.DoubleSide });
    const runnerTexSrc = wall.runnerTexture && (wall.runnerTexture.url || wall.runnerTexture.dataUrl);
    if (runnerTexSrc) {
      const src = wall.runnerTexture.url ? resolveAssetUrl(wall.runnerTexture.url) : wall.runnerTexture.dataUrl;
      if (!_wallDeadUrls.has(src)) {
        const loader = new THREE.TextureLoader();
        loader.load(src, (texture) => {
          texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
          texture.colorSpace = THREE.SRGBColorSpace;
          runnerMat.map = texture;
          runnerMat.color.set(0xffffff);
          runnerMat.needsUpdate = true;
        }, undefined, () => { _wallDeadUrls.add(src); });
      }
    }
    const runnerMesh = new THREE.Mesh(runnerGeom, runnerMat);
    rootWalls.add(runnerMesh);
    paintifyStair(runnerMesh);
  }
  // UNDERSIDE FINISH — opt-in separate fill for the bottom-of-tread
  // faces. Layered 5 mm BELOW each tread so it reads as the underside
  // when viewed from below (openBack / no-clip). Reversed winding so
  // the front-face is -Y.
  if (wall.undersideEnabled) {
    const UND_DROP = -0.005;
    const undPositions = [];
    const undUVs = [];
    for (let i = 0; i < stepCount; i++) {
      const isLast = (i === stepCount - 1);
      const beforeMe = i * run;
      const myRun = isLast ? (runLength - beforeMe) : run;
      const sNearA = lowIsMin ? runMinW + beforeMe : runMaxW - beforeMe - myRun;
      const sFarA  = lowIsMin ? runMinW + beforeMe + myRun : runMaxW - beforeMe;
      const yU = (i + 1) * rise + UND_DROP;
      const p0 = worldXZ(sNearA, perpA);
      const p1 = worldXZ(sFarA,  perpA);
      const p2 = worldXZ(sFarA,  perpB);
      const p3 = worldXZ(sNearA, perpB);
      // Reverse the quad winding so the visible face points -Y.
      undPositions.push(
        p0[0], yU, p0[1],  p3[0], yU, p3[1],  p2[0], yU, p2[1],
        p0[0], yU, p0[1],  p2[0], yU, p2[1],  p1[0], yU, p1[1],
      );
      undUVs.push(0, 0,  0, 1,  1, 1,  0, 0,  1, 1,  1, 0);
    }
    const undGeom = new THREE.BufferGeometry();
    undGeom.setAttribute('position', new THREE.Float32BufferAttribute(undPositions, 3));
    undGeom.setAttribute('uv',       new THREE.Float32BufferAttribute(undUVs, 2));
    undGeom.computeVertexNormals();
    const undMat = new THREE.MeshBasicMaterial({
      color: new THREE.Color(wall.undersideColor || '#a08c6e'),
      side: THREE.DoubleSide,
    });
    const undTexSrc = wall.undersideTexture && (wall.undersideTexture.url || wall.undersideTexture.dataUrl);
    if (undTexSrc) {
      const src = wall.undersideTexture.url ? resolveAssetUrl(wall.undersideTexture.url) : wall.undersideTexture.dataUrl;
      if (!_wallDeadUrls.has(src)) {
        const loader = new THREE.TextureLoader();
        loader.load(src, (texture) => {
          texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
          texture.colorSpace = THREE.SRGBColorSpace;
          undMat.map = texture;
          undMat.color.set(0xffffff);
          undMat.needsUpdate = true;
        }, undefined, () => { _wallDeadUrls.add(src); });
      }
    }
    const undMesh = new THREE.Mesh(undGeom, undMat);
    rootWalls.add(undMesh);
    paintifyStair(undMesh);
  }
}

// Voxel-mesh extraction. For each (cell, y-slice) that's FILLED, emit each
// of its six faces only when the neighbour in that direction is EMPTY.
// Internal faces never get created → no need for coincident-triangle
// cleanup, and EdgesGeometry naturally produces only the outer hull's
// edges. Handles all the cases that previously left seams:
//   - L / T / + walls (corner cells have neighbours on multiple sides,
//     internal touching faces never emitted)
//   - Wall ↔ window sill / lintel (the cells fill different y-intervals;
//     within the sill slice both cells are filled, so the boundary face is
//     skipped; outside the sill slice the solid cell sees an empty
//     neighbour and emits the face that bounds the window opening)
//   - Wall ↔ door header (same logic, header is filled only between
//     beamBottom and beamTop)
function buildVoxelMesh(cells, h, cellSize, wallRef, doorH) {
  const cellIntervals = new Map();   // key=`${r},${c}` → [(y0, y1), …]
  const yBoundariesSet = new Set([0, h]);
  for (const c of cells) {
    const key = `${c.r},${c.c}`;
    const intervals = [];
    if (c.isDoor) {
      const headerOffset = Math.max(0, wallRef?.windowHeight || 0);
      const beamBottom = doorH + headerOffset;
      const beamTop = Math.min(h, beamBottom + DEFAULT_HEADER_HEIGHT);
      if (beamTop > beamBottom) {
        intervals.push([beamBottom, beamTop]);
        yBoundariesSet.add(beamBottom);
        yBoundariesSet.add(beamTop);
      }
    } else if (c.isWindow) {
      const wh = (typeof c.windowHeight === 'number' && c.windowHeight > 0)
        ? c.windowHeight : DEFAULT_WINDOW_HEIGHT;
      const sillH = Math.max(0, (h - wh) / 2);
      if (sillH > 0) {
        intervals.push([0, sillH]);
        intervals.push([h - sillH, h]);
        yBoundariesSet.add(sillH);
        yBoundariesSet.add(h - sillH);
      }
    } else {
      intervals.push([0, h]);
    }
    cellIntervals.set(key, intervals);
  }
  const ys = [...yBoundariesSet].sort((a, b) => a - b);

  const isFilledAt = (key, y) => {
    const intervals = cellIntervals.get(key);
    if (!intervals) return false;
    for (const [y0, y1] of intervals) {
      if (y >= y0 - 1e-9 && y < y1 - 1e-9) return true;
    }
    return false;
  };

  const positions = [];
  const tri = (a, b, c) => { positions.push(a[0],a[1],a[2], b[0],b[1],b[2], c[0],c[1],c[2]); };
  const quad = (a, b, c, d) => { tri(a, b, c); tri(a, c, d); };

  for (let s = 0; s < ys.length - 1; s++) {
    const yBot = ys[s];
    const yTop = ys[s + 1];
    const yMid = (yBot + yTop) / 2;
    for (const [key] of cellIntervals) {
      if (!isFilledAt(key, yMid)) continue;
      const [r, c] = key.split(',').map(Number);
      const xMin = (c - 1) * cellSize;
      const xMax = xMin + cellSize;
      const zMin = r * cellSize;
      const zMax = zMin + cellSize;

      // 4 side faces — skip where the neighbour is filled at this slice.
      // Each quad is wound so its CCW order produces an OUTWARD normal
      // (verified via cross-product). With FrontSide culling this means
      // the face renders from outside the wall, not from inside — which
      // is what made the previous voxel-mesh walls look hollow/backfaced.
      if (!isFilledAt(`${r},${c + 1}`, yMid))   // +X face → normal +X
        quad([xMax, yBot, zMax], [xMax, yBot, zMin], [xMax, yTop, zMin], [xMax, yTop, zMax]);
      if (!isFilledAt(`${r},${c - 1}`, yMid))   // -X face → normal -X
        quad([xMin, yBot, zMin], [xMin, yBot, zMax], [xMin, yTop, zMax], [xMin, yTop, zMin]);
      if (!isFilledAt(`${r + 1},${c}`, yMid))   // +Z face → normal +Z
        quad([xMin, yBot, zMax], [xMax, yBot, zMax], [xMax, yTop, zMax], [xMin, yTop, zMax]);
      if (!isFilledAt(`${r - 1},${c}`, yMid))   // -Z face → normal -Z
        quad([xMax, yBot, zMin], [xMin, yBot, zMin], [xMin, yTop, zMin], [xMax, yTop, zMin]);

      // Top / bottom caps — skip where same cell is filled in the adjacent slice.
      const aboveFilled = (s + 1 < ys.length - 1)
        && isFilledAt(key, (ys[s + 1] + ys[s + 2]) / 2);
      if (!aboveFilled)                          // +Y face → normal +Y
        quad([xMin, yTop, zMin], [xMin, yTop, zMax], [xMax, yTop, zMax], [xMax, yTop, zMin]);
      const belowFilled = (s > 0)
        && isFilledAt(key, (ys[s - 1] + ys[s]) / 2);
      if (!belowFilled)                          // -Y face → normal -Y
        quad([xMin, yBot, zMin], [xMax, yBot, zMin], [xMax, yBot, zMax], [xMin, yBot, zMax]);
    }
  }

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  return g;
}

// Strip triangles that share a sorted vertex-index triple. After
// mergeVertices welds duplicate boundary vertices, two adjacent boxes'
// shared face becomes FOUR triangles using the same four vertices — two
// from each box, opposite winding. Removing all triples that appear more
// than once leaves only the boundary-of-the-union triangles, which kills
// internal seams between greedy-meshed boxes (the L-corner case being the
// main offender).
function removeCoincidentTriangles(geom) {
  if (!geom.index) return geom;
  const idx = geom.index.array;
  const triCount = idx.length / 3;
  const buckets = new Map();   // "a,b,c" (sorted) → [triIdx, …]
  for (let t = 0; t < triCount; t++) {
    let a = idx[t * 3], b = idx[t * 3 + 1], c = idx[t * 3 + 2];
    // Sort the triple inline; faster than .sort() on a tiny array.
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

// Stair collision AABBs. Computes the same step layout buildStairs uses,
// but emits AABBs at each step's TOP-face level for landing. A SHORT
// (≤0.3 m) AABB just BELOW each step's top is added as the climbable
// "step-up" — small enough that any standard player step-height check
// passes. Result: stairs are always walkable regardless of rise.
function stairAABBs(wall, cellSize) {
  const cells = cellsOf(wall);
  if (!cells.length) return [];
  const rs = cells.map(c => c.r);
  const cs = cells.map(c => c.c);
  const rMin = Math.min(...rs), rMax = Math.max(...rs);
  const cMin = Math.min(...cs), cMax = Math.max(...cs);
  const rSpan = rMax - rMin + 1;
  const cSpan = cMax - cMin + 1;
  const axis = (cSpan >= rSpan) ? 'col' : 'row';
  const first = cells[0];
  let lowIsMin = (axis === 'col') ? (first.c === cMin) : (first.r === rMin);
  if (wall.stairDir === 'backward') lowIsMin = !lowIsMin;
  const runLength = (axis === 'col' ? cSpan : rSpan) * cellSize;
  const perpExtent = (axis === 'col' ? rSpan : cSpan) * cellSize;
  const cellCountAlong = (axis === 'col' ? cSpan : rSpan);
  const run  = Math.max(0.01, wall.run  ?? 0.3);
  const widthM = (wall.customWidth != null && wall.customWidth > 0)
    ? wall.customWidth : perpExtent;
  // MUST match buildStairs: total = stepCount × rise, capped by landing.
  const rise = Math.max(0.01, wall.rise ?? 0.1);
  let stepCount = Math.max(1, Math.floor(runLength / run));
  let totalRise = stepCount * rise;
  if (wall.landingHeight != null && wall.landingHeight > 0 && wall.landingHeight < totalRise) {
    stepCount = Math.max(1, Math.floor(wall.landingHeight / rise));
    totalRise = stepCount * rise;
  }
  const perpAxisCentre = (axis === 'col')
    ? ((rMin + rMax + 1) / 2) * cellSize
    : ((cMin + cMax) / 2 + 0.5) * cellSize;
  const runMinW = (axis === 'col') ? (cMin - 1) * cellSize : rMin * cellSize;
  const runMaxW = runMinW + runLength;
  const perpA = perpAxisCentre - widthM / 2;
  const perpB = perpAxisCentre + widthM / 2;
  const aabbs = [];
  // Player step-up tolerance: the collision resolver picks the smallest
  // penetration axis. Any AABB taller than this against a player at
  // floor level would resolve LATERAL (push back) instead of UP (lift).
  // To guarantee any rise is climbable, subdivide each step's vertical
  // extent into sub-AABBs of at most MAX_STEP_RISE metres each.
  const MAX_STEP_RISE = 0.18;
  for (let i = 0; i < stepCount; i++) {
    // Last step absorbs the leftover so collision matches geometry.
    const isLast = (i === stepCount - 1);
    const beforeMe = i * run;
    const myRun = isLast ? (runLength - beforeMe) : run;
    const nearA = lowIsMin ? runMinW + beforeMe : runMaxW - beforeMe - myRun;
    const farA  = lowIsMin ? runMinW + beforeMe + myRun : runMaxW - beforeMe;
    const yBottom = i * rise;
    const yTop    = (i + 1) * rise;
    const subCount = Math.max(1, Math.ceil(rise / MAX_STEP_RISE));
    const subH = rise / subCount;
    for (let j = 0; j < subCount; j++) {
      const subMinY = yBottom + j * subH;
      const subMaxY = subMinY + subH;
      const min = (axis === 'col')
        ? new THREE.Vector3(nearA, subMinY, perpA)
        : new THREE.Vector3(perpA, subMinY, nearA);
      const max = (axis === 'col')
        ? new THREE.Vector3(farA, subMaxY, perpB)
        : new THREE.Vector3(perpB, subMaxY, farA);
      aabbs.push(new THREE.Box3(min, max));
    }
  }
  // Stair-specific opt-in collision: sides (perpA + perpB walls),
  // back (high-end wall), and inside floor (walkable y=0 plane). These
  // are independent of the standard step-climb AABBs above. Each
  // adds a thin (0.1m thick) AABB acting as a solid wall / floor.
  const topY = stepCount * rise;
  const collideSides = wall.collideSides !== false;   // default ON
  const collideBack  = !!wall.collideBack;
  const insideFloor  = !!wall.insideFloor;
  const SLAB = 0.05;
  if (collideSides) {
    // One AABB per step per side, capped at each step's tread height.
    // This makes the side collision follow the stepped silhouette
    // instead of acting like a tall invisible handrail across the
    // whole staircase — you can walk off / jump off the side from any
    // step at that step's height, not just from the top.
    for (let i = 0; i < stepCount; i++) {
      const isLast = (i === stepCount - 1);
      const beforeMe = i * run;
      const myRun = isLast ? (runLength - beforeMe) : run;
      const sNearA = lowIsMin ? runMinW + beforeMe : runMaxW - beforeMe - myRun;
      const sFarA  = lowIsMin ? runMinW + beforeMe + myRun : runMaxW - beforeMe;
      const sTopY  = (i + 1) * rise;
      const minA = (axis === 'col')
        ? new THREE.Vector3(sNearA, 0, perpA - SLAB)
        : new THREE.Vector3(perpA - SLAB, 0, sNearA);
      const maxA = (axis === 'col')
        ? new THREE.Vector3(sFarA, sTopY, perpA + SLAB)
        : new THREE.Vector3(perpA + SLAB, sTopY, sFarA);
      aabbs.push(new THREE.Box3(minA, maxA));
      const minB = (axis === 'col')
        ? new THREE.Vector3(sNearA, 0, perpB - SLAB)
        : new THREE.Vector3(perpB - SLAB, 0, sNearA);
      const maxB = (axis === 'col')
        ? new THREE.Vector3(sFarA, sTopY, perpB + SLAB)
        : new THREE.Vector3(perpB + SLAB, sTopY, sFarA);
      aabbs.push(new THREE.Box3(minB, maxB));
    }
  }
  if (collideBack) {
    const backAlong = lowIsMin ? runMaxW : runMinW;
    const min = (axis === 'col')
      ? new THREE.Vector3(backAlong - SLAB, 0, perpA)
      : new THREE.Vector3(perpA, 0, backAlong - SLAB);
    const max = (axis === 'col')
      ? new THREE.Vector3(backAlong + SLAB, topY, perpB)
      : new THREE.Vector3(perpB, topY, backAlong + SLAB);
    aabbs.push(new THREE.Box3(min, max));
  }
  if (insideFloor) {
    // Top at y=0.01 to match the rendered inside-floor quad in buildStairs.
    // Bottom dips below the world floor so the AABB has volume — the
    // collision resolver's step-up bias lifts the player onto the top face.
    const FLOOR_Y = 0.01;
    const min = (axis === 'col')
      ? new THREE.Vector3(runMinW, -SLAB,   perpA)
      : new THREE.Vector3(perpA, -SLAB,   runMinW);
    const max = (axis === 'col')
      ? new THREE.Vector3(runMaxW, FLOOR_Y, perpB)
      : new THREE.Vector3(perpB, FLOOR_Y, runMaxW);
    aabbs.push(new THREE.Box3(min, max));
  }
  // BANISTER collision — stepped AABB approximation of the sloping rail.
  // Split each rail into stepCount segments along the run axis; each
  // segment's AABB matches the rail's height at that span so the
  // staircase climb still works (player walks UP the stair next to the
  // rail; rail blocks lateral pass-through, not the climb).
  const wantBanLeft  = !!wall.banisterLeft;
  const wantBanRight = !!wall.banisterRight;
  if (wantBanLeft || wantBanRight) {
    const RH = 0.9;
    const RX = 0.02;  // rail half-height in Y
    const RW = 0.02;  // rail half-thickness in perp
    const lowEndAL  = lowIsMin ? runMinW : runMaxW;
    const highEndAL = lowIsMin ? runMaxW : runMinW;
    const totalRiseL = stepCount * rise;
    const railY = (alongCoord) => {
      const t = (alongCoord - lowEndAL) / (highEndAL - lowEndAL);
      return RH + t * totalRiseL;
    };
    const emitRailAABBs = (perpCoord) => {
      for (let i = 0; i < stepCount; i++) {
        const isLast = (i === stepCount - 1);
        const beforeMe = i * run;
        const myRun = isLast ? (runLength - beforeMe) : run;
        const sNearA = lowIsMin ? runMinW + beforeMe : runMaxW - beforeMe - myRun;
        const sFarA  = lowIsMin ? runMinW + beforeMe + myRun : runMaxW - beforeMe;
        const yStart = railY(sNearA);
        const yEnd   = railY(sFarA);
        const yMin = Math.min(yStart, yEnd) - RX;
        const yMax = Math.max(yStart, yEnd) + RX;
        const min = (axis === 'col')
          ? new THREE.Vector3(sNearA, yMin, perpCoord - RW)
          : new THREE.Vector3(perpCoord - RW, yMin, sNearA);
        const max = (axis === 'col')
          ? new THREE.Vector3(sFarA, yMax, perpCoord + RW)
          : new THREE.Vector3(perpCoord + RW, yMax, sFarA);
        aabbs.push(new THREE.Box3(min, max));
      }
    };
    if (wantBanLeft)  emitRailAABBs(perpA);
    if (wantBanRight) emitRailAABBs(perpB);
  }
  return aabbs;
}

// Greedy rectangle merge for an arbitrary cell list. Used to coalesce
// adjacent window or door cells into the largest possible rectangle so
// they emit one sill/lintel/header box instead of N — eliminates the
// internal seam line between merged cells in the box-path. Returns
// [{ r0, r1, c0, c1 }]. Independent of greedyMesh() above (which is the
// solid-cell version with its own cell shape contract).
function greedyRectsFromCells(cells) {
  if (!cells.length) return [];
  const remain = new Map();
  for (const c of cells) remain.set(`${c.r},${c.c}`, c);
  const rects = [];
  // Sort by row then column so we extend rightward then downward.
  const sorted = [...cells].sort((a, b) => a.r - b.r || a.c - b.c);
  for (const seed of sorted) {
    const key = `${seed.r},${seed.c}`;
    if (!remain.has(key)) continue;
    let c1 = seed.c;
    while (remain.has(`${seed.r},${c1 + 1}`)) c1++;
    // Extend downward as long as every column from seed.c..c1 exists in
    // the candidate row.
    let r1 = seed.r;
    grow: while (true) {
      const nextRow = r1 + 1;
      for (let cc = seed.c; cc <= c1; cc++) {
        if (!remain.has(`${nextRow},${cc}`)) break grow;
      }
      r1 = nextRow;
    }
    for (let rr = seed.r; rr <= r1; rr++) {
      for (let cc = seed.c; cc <= c1; cc++) remain.delete(`${rr},${cc}`);
    }
    rects.push({ r0: seed.r, r1, c0: seed.c, c1 });
  }
  return rects;
}

// Try to build a 1D-strip wall as a single ExtrudeGeometry with window holes.
// Returns null if cells aren't all on a single row or single column (i.e., 2D
// wall — caller falls back to the box-union path).
function tryBuildStripGeometry(cells, h, cellSize, wallRef) {
  if (!cells.length) return null;
  const r0 = cells[0].r, c0 = cells[0].c;
  const isRow = cells.every(c => c.r === r0);
  const isCol = !isRow && cells.every(c => c.c === c0);
  if (!isRow && !isCol) return null;

  const cw = (wallRef && typeof wallRef.customWidth === 'number'
              && wallRef.customWidth > 0 && wallRef.customWidth <= 1)
    ? wallRef.customWidth : 1;
  // For doors, windowHeight is interpreted as the HEADER THICKNESS (since the
  // UI label is "Header h" for door walls). For windows, it's the opening height.
  const defaultWH = wallRef?.windowHeight || DEFAULT_WINDOW_HEIGHT;
  const defaultDH = wallRef?.doorHeight  || DEFAULT_DOOR_HEIGHT;
  const defaultHeaderThickness = wallRef?.windowHeight || DEFAULT_HEADER_HEIGHT;

  // Sort along the strip axis.
  const sorted = cells.slice().sort(isRow ? (a, b) => a.c - b.c : (a, b) => a.r - b.r);
  const axisKey = isRow ? 'c' : 'r';
  const stripMin = sorted[0][axisKey];
  const stripMax = sorted[sorted.length - 1][axisKey];
  const stripLen = (stripMax - stripMin + 1) * cellSize;

  // Outline rectangle.
  const shape = new THREE.Shape();
  shape.moveTo(0, 0);
  shape.lineTo(stripLen, 0);
  shape.lineTo(stripLen, h);
  shape.lineTo(0, h);
  shape.closePath();

  // Coalesce consecutive opening cells (windows OR doors) into runs. A door
  // run uses sillTop=0 (floor) and lintelBottom=doorHeight so the opening
  // reaches the ground. Mixing door + window in a single run isn't a thing
  // — doors and windows are split into separate runs.
  const runs = [];
  let cur = null;
  for (const c of sorted) {
    const kind = c.isDoor ? 'door' : (c.isWindow ? 'window' : 'solid');
    if (kind === 'solid') { cur = null; continue; }
    let sillTop, lintelBottom, lintelTop;
    if (kind === 'door') {
      // Door notch = the door opening PLUS the gap between the door top and
      // the header beam. The beam itself sits at (doorH + headerOffset) and
      // is a fixed-thickness slab. Above the beam is another gap up to h.
      // Moving headerOffset shifts the entire beam up or down.
      const headerOffset = Math.max(0, wallRef?.windowHeight || 0);
      sillTop      = 0;
      lintelBottom = defaultDH + headerOffset;                          // door + below-beam gap top
      lintelTop    = Math.min(h, lintelBottom + DEFAULT_HEADER_HEIGHT);  // beam top
    } else {
      const wh = (typeof c.windowHeight === 'number' && c.windowHeight > 0) ? c.windowHeight : defaultWH;
      sillTop      = (h - wh) / 2;
      lintelBottom = (h + wh) / 2;
      lintelTop    = h;   // window header extends to the wall top
    }
    if (sillTop >= lintelBottom) { cur = null; continue; }
    const pos = c[axisKey];
    if (cur && cur.kind === kind && pos === cur.end + 1) {
      cur.end = pos;
      cur.sillTop = Math.min(cur.sillTop, sillTop);
      cur.lintelBottom = Math.max(cur.lintelBottom, lintelBottom);
      cur.lintelTop = Math.max(cur.lintelTop, lintelTop);
    } else {
      cur = { kind, start: pos, end: pos, sillTop, lintelBottom, lintelTop };
      runs.push(cur);
    }
  }

  // Classify each run:
  //   leftNotch  — touches stripMin: notch the outer shape's left edge.
  //   rightNotch — touches stripMax: notch the outer shape's right edge.
  //   fullSpan   — covers the whole strip: wall becomes sill+lintel strips only.
  //   middle     — interior: an enclosed hole in the shape.
  // The notch approach makes the OPEN SIDE of the window look open (no wall
  // material at the wall's end where the opening lives).
  let leftNotch = null, rightNotch = null, fullSpan = null;
  const middle = [];
  for (const r of runs) {
    if (r.start === stripMin && r.end === stripMax)       fullSpan = r;
    else if (r.start === stripMin)                         leftNotch = r;
    else if (r.end === stripMax)                           rightNotch = r;
    else {
      // Defensive: a "middle" hole must not touch either perimeter end. If
      // the categorization above missed it (numeric edge case), skip rather
      // than emit a malformed hole that ExtrudeGeometry can't handle.
      if (r.start <= stripMin || r.end >= stripMax) continue;
      middle.push(r);
    }
  }

  // Rebuild the outer outline taking notches into account, plus any holes.
  // The default rectangle was already added to `shape`; we'll discard it.
  const shapes = [];
  if (fullSpan) {
    // Sill strip (if any) below the opening + lintel strip (if any) above.
    if (fullSpan.sillTop > 0) {
      const s = new THREE.Shape();
      s.moveTo(0, 0); s.lineTo(stripLen, 0);
      s.lineTo(stripLen, fullSpan.sillTop); s.lineTo(0, fullSpan.sillTop);
      s.closePath();
      shapes.push(s);
    }
    if (fullSpan.lintelBottom < h) {
      const s = new THREE.Shape();
      s.moveTo(0, fullSpan.lintelBottom); s.lineTo(stripLen, fullSpan.lintelBottom);
      s.lineTo(stripLen, h); s.lineTo(0, h);
      s.closePath();
      shapes.push(s);
    }
  } else {
    const s = new THREE.Shape();
    const leftCutX  = leftNotch  ? (leftNotch.end  - stripMin + 1) * cellSize : 0;
    const rightCutX = rightNotch ? (rightNotch.start - stripMin)   * cellSize : stripLen;
    // Counterclockwise outline starting at the bottom-left.
    // Door notches: sillTop = 0 (opening reaches floor) AND lintelTop may be
    // < h (the header is a fixed-thickness beam that doesn't necessarily
    // extend to the ceiling — the area above the header is empty).
    const isDoorLeft  = !!leftNotch  && leftNotch.kind === 'door';
    const isDoorRight = !!rightNotch && rightNotch.kind === 'door';
    const leftHeaderGap  = isDoorLeft  && leftNotch.lintelTop  < h - 0.001;
    const rightHeaderGap = isDoorRight && rightNotch.lintelTop < h - 0.001;
    const bottomStartX = isDoorLeft  ? leftCutX  : 0;
    const bottomEndX   = isDoorRight ? rightCutX : stripLen;

    // Middle openings come in two flavours. Windows are enclosed (sill below,
    // lintel above) so they stay as closed-path holes after the outline is
    // built. DOORS reach the floor — if we hole them, ExtrudeGeometry caps
    // the hole's bottom edge at y=0 and you get a "threshold plane" face
    // spanning the door width on the floor. Instead we notch the outer
    // outline upward around each middle door, so the door opening is OPEN
    // at the bottom and no threshold face is generated.
    const middleDoors   = middle.filter(r => r.kind === 'door')
      .filter(r => {
        const x0 = (r.start - stripMin) * cellSize;
        const x1 = (r.end   - stripMin + 1) * cellSize;
        return x1 > bottomStartX && x0 < bottomEndX;
      })
      .sort((a, b) => a.start - b.start);
    const middleWindows = middle.filter(r => r.kind === 'window');

    s.moveTo(bottomStartX, 0);
    for (const r of middleDoors) {
      const x0 = (r.start - stripMin) * cellSize;
      const x1 = (r.end   - stripMin + 1) * cellSize;
      s.lineTo(x0, 0);                       // walk along floor to door
      s.lineTo(x0, r.lintelBottom);          // up the door's left side
      s.lineTo(x1, r.lintelBottom);          // across the header bottom
      s.lineTo(x1, 0);                       // back down to floor
    }
    s.lineTo(bottomEndX, 0);
    if (rightNotch) {
      if (isDoorRight) {
        // Up to header bottom, right under it, up the right side of header.
        s.lineTo(rightCutX, rightNotch.lintelBottom);
        s.lineTo(stripLen, rightNotch.lintelBottom);
        s.lineTo(stripLen, rightNotch.lintelTop);
        if (rightHeaderGap) {
          // Trace around the top of the header beam back to the solid wall.
          s.lineTo(rightCutX, rightNotch.lintelTop);
          s.lineTo(rightCutX, h);
        }
        // else: header reaches ceiling; current position is (stripLen, h).
      } else {
        s.lineTo(stripLen, rightNotch.sillTop);
        s.lineTo(rightCutX, rightNotch.sillTop);
        s.lineTo(rightCutX, rightNotch.lintelBottom);
        s.lineTo(stripLen, rightNotch.lintelBottom);
      }
    }
    // Top-right corner — only emit (stripLen, h) if the door header-gap
    // tracing didn't already bring us up to (rightCutX, h).
    if (!rightHeaderGap) s.lineTo(stripLen, h);
    // Top edge — to (leftCutX, h) if door-left header gap, else to (0, h).
    if (leftHeaderGap) s.lineTo(leftCutX, h);
    else               s.lineTo(0, h);
    if (leftNotch) {
      if (isDoorLeft) {
        if (leftHeaderGap) {
          // From (leftCutX, h) go down inside-of-solid-wall edge to header top,
          // then around the header to bottom, then closePath returns to (leftCutX, 0).
          s.lineTo(leftCutX, leftNotch.lintelTop);
          s.lineTo(0, leftNotch.lintelTop);
          s.lineTo(0, leftNotch.lintelBottom);
          s.lineTo(leftCutX, leftNotch.lintelBottom);
        } else {
          s.lineTo(0, leftNotch.lintelBottom);
          s.lineTo(leftCutX, leftNotch.lintelBottom);
        }
      } else {
        s.lineTo(0, leftNotch.lintelBottom);
        s.lineTo(leftCutX, leftNotch.lintelBottom);
        s.lineTo(leftCutX, leftNotch.sillTop);
        s.lineTo(0, leftNotch.sillTop);
      }
    }
    s.closePath();
    // Interior holes for middle windows only — middle doors were already
    // notched into the outer outline above, so they don't get a hole here
    // (would re-introduce the threshold face).
    for (const r of middleWindows) {
      const x0 = (r.start - stripMin) * cellSize;
      const x1 = (r.end   - stripMin + 1) * cellSize;
      const hole = new THREE.Path();
      hole.moveTo(x0, r.sillTop);
      hole.lineTo(x1, r.sillTop);
      hole.lineTo(x1, r.lintelBottom);
      hole.lineTo(x0, r.lintelBottom);
      hole.closePath();
      s.holes.push(hole);
    }
    shapes.push(s);
  }
  if (!shapes.length) return null;   // wall is entirely opening with no sill/lintel

  const depth = cw * cellSize;
  const geom = new THREE.ExtrudeGeometry(shapes, { depth, bevelEnabled: false });
  // ExtrudeGeometry places the shape on the XY plane (back face z=0, front
  // face z=depth). Position it in world space.
  if (isRow) {
    // Row strip: extrude direction = world +Z. Translate so the wall's z
    // range straddles the cell row r, centered per customWidth.
    const zMin = r0 * cellSize + (1 - cw) / 2 * cellSize;
    geom.translate((stripMin - 1) * cellSize, 0, zMin);
  } else {
    // Col strip: rotate so the extrude direction becomes world -X. Translate
    // so the wall's x range straddles col c, centered per customWidth.
    geom.rotateY(-Math.PI / 2);
    const xMax = (c0 - 1) * cellSize + (1 + cw) / 2 * cellSize;
    geom.translate(xMax, 0, stripMin * cellSize);
  }
  return geom;
}

// Create a wall material with the base JPEG applied, computing texture.repeat
// from the sizing mode and the merged wall's bounding-box dimensions.
const _wallDeadUrls = new Set();
function makeWallTextureMaterial(mergedGeom, baseTex) {
  const mat = new THREE.MeshBasicMaterial({ color: 0xffffff });
  const loader = new THREE.TextureLoader();
  const src = baseTex.url ? resolveAssetUrl(baseTex.url) : baseTex.dataUrl;
  if (_wallDeadUrls.has(src)) return mat;
  loader.load(src, (texture) => {
    texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
    texture.colorSpace = THREE.SRGBColorSpace;
    mergedGeom.computeBoundingBox();
    const size = new THREE.Vector3();
    mergedGeom.boundingBox.getSize(size);
    const mode = baseTex.sizingMode || 'fixed';
    let repU = 1, repV = 1;
    if (mode === 'fixed') {
      const wM = texture.image.naturalWidth  / 100;
      const hM = texture.image.naturalHeight / 100;
      repU = Math.max(0.01, size.x / wM);
      repV = Math.max(0.01, size.y / hM);
    } else if (mode === 'meters' && baseTex.widthMeters && baseTex.heightMeters) {
      repU = Math.max(0.01, size.x / baseTex.widthMeters);
      repV = Math.max(0.01, size.y / baseTex.heightMeters);
    }
    texture.repeat.set(repU, repV);
    // Mirror on U / V axis by negating the corresponding repeat component
    // and bumping the offset by 1 so the sampler walks backwards through
    // the [0,1] range instead of sliding off-frame.
    if (baseTex.flipU) { texture.repeat.x = -texture.repeat.x; texture.offset.x = 1 + (texture.offset.x || 0); }
    if (baseTex.flipV) { texture.repeat.y = -texture.repeat.y; texture.offset.y = 1 + (texture.offset.y || 0); }
    // Only set centre when actually rotating. The texture matrix composes
    // scale around centre, so setting centre on a tiled (repeat > 1)
    // texture shifts every tile by half a tile and the image looks offset.
    const rotRad = (Number(baseTex.rotation) || 0) * Math.PI / 180;
    if (rotRad !== 0) texture.center.set(0.5, 0.5);
    else              texture.center.set(0, 0);
    texture.rotation = rotRad;
    mat.map = texture;
    mat.needsUpdate = true;
  }, undefined, () => { _wallDeadUrls.add(src); });
  return mat;
}

// AABB list for collision — uses the SAME greedy-meshed boxes as the renderer.
export function wallAABBs(s) {
  const aabbs = [];
  if (!s.walls?.length) return aabbs;
  const cellSize = s.grid.cellSizeMeters;
  for (const w of s.walls) {
    if (!w.collide) continue;
    if (w.kind === 'stairs') {
      // Stairs: emit one AABB per step at the step's own y level.
      // Each step's TOP face becomes a walkable platform. The player
      // walks INTO a riser, gets blocked, then can step up onto the
      // next tread. Rise heights ≤ player step-up tolerance let the
      // player climb naturally; for high rises we subdivide the riser
      // into multiple SHORT colliders so each one is climbable.
      for (const box of stairAABBs(w, cellSize)) aabbs.push(box);
      continue;
    }
    for (const g of wallToBoxes(w, cellSize)) {
      g.computeBoundingBox();
      aabbs.push(g.boundingBox.clone());
      g.dispose();
    }
  }
  return aabbs;
}
