// engine/plates.js — thin axis-aligned slabs anchored to floor cells.
//
// Single plate = a BoxGeometry slab at the plate's footprint. Plates marked
// `backfaceWhenMerged: true` (the default for newly-created plates) AND
// sharing a `groupId` get unioned: their XZ rectangles are merged into one
// (or more) outer-hull polygons via a per-cell rasterisation, then extruded
// as one continuous mesh — no internal face seams, stroke wraps only the
// outer polygon edges. Non-merged plates render independently.

import * as THREE from 'three';
import * as BufferGeometryUtils from 'three/addons/utils/BufferGeometryUtils.js';
import { rowIdToIndex } from '../core/grid-addr.js';
import { resolveAssetUrl } from '../core/asset-paths.js';
import { buildPaintPlanesForRect } from './painting.js';
import { makeToonGradient } from './walls.js';

// Rasterisation grid resolution for the union — 10 cells/m means each plate
// edge snaps to the 0.1 m UI step. Finer = smoother edges at sub-decimal
// scales, but quadratically more cells to walk.
const UNION_CELLS_PER_M = 10;

export function buildPlates(rootPlates, s) {
  rootPlates.clear();
  if (!s.plates?.length) return;
  const cellSize = s.grid.cellSizeMeters;

  // Bucket plates: merged groups vs. independents. A plate joins a group if
  // it has a `groupId` AND `backfaceWhenMerged` is true. Otherwise it
  // renders solo.
  const groups = new Map();   // groupId → [plates]
  const solos  = [];
  for (const p of s.plates) {
    if (p.groupId && p.backfaceWhenMerged) {
      if (!groups.has(p.groupId)) groups.set(p.groupId, []);
      groups.get(p.groupId).push(p);
    } else {
      solos.push(p);
    }
  }

  for (const p of solos) buildSoloPlate(rootPlates, p, s, cellSize);
  for (const [, members] of groups) buildMergedGroup(rootPlates, members, s, cellSize);
}

// Single-plate render path. Untouched from the original behaviour.
function buildSoloPlate(rootPlates, plate, s, cellSize) {
  const bounds = plateBounds(plate, cellSize);
  if (!bounds) return;
  const { xMin, xMax, zMin, zMax, yMin, yMax } = bounds;
  const w = xMax - xMin;
  const d = zMax - zMin;
  const h = yMax - yMin;
  if (w <= 0 || d <= 0 || h <= 0) return;
  const geom = new THREE.BoxGeometry(w, h, d);
  geom.translate((xMin + xMax) / 2, (yMin + yMax) / 2, (zMin + zMax) / 2);
  addPlateMesh(rootPlates, geom, plate, w, d, h, s);
  if (plate.stroke) addStrokeFromGeom(rootPlates, geom, plate.strokeColor);
  addPlatePaint(rootPlates, plate, s, bounds);
}

// Merged-group render path. Rasterise every member plate's XZ rectangle
// into a per-cell occupancy grid (at UNION_CELLS_PER_M resolution), then
// extract outer-hull polygons + holes from that grid, then ExtrudeGeometry
// each polygon into one continuous slab. Stroke wraps the polygon
// perimeter via EdgesGeometry of the extrusion's TOP cap.
function buildMergedGroup(rootPlates, members, s, cellSize) {
  // Bounding box of all members in WORLD metres + the y-band each
  // member contributes to. The merge assumes a SHARED y-band (all
  // members in one group have the same yMin / yMax) — if they
  // differ we fall back to solo rendering for safety.
  const memberBounds = members.map(p => plateBounds(p, cellSize)).filter(Boolean);
  if (!memberBounds.length) return;
  const yMin = memberBounds[0].yMin;
  const yMax = memberBounds[0].yMax;
  for (const b of memberBounds) {
    if (b.yMin !== yMin || b.yMax !== yMax) {
      // Bail to solo if heights differ — union geometry must share y.
      for (const p of members) buildSoloPlate(rootPlates, p, s, cellSize);
      return;
    }
  }
  let xMin =  Infinity, xMax = -Infinity, zMin =  Infinity, zMax = -Infinity;
  for (const b of memberBounds) {
    if (b.xMin < xMin) xMin = b.xMin;
    if (b.xMax > xMax) xMax = b.xMax;
    if (b.zMin < zMin) zMin = b.zMin;
    if (b.zMax > zMax) zMax = b.zMax;
  }
  if (xMax <= xMin || zMax <= zMin) return;

  // Rasterise into TWO grids:
  //   occ     — boolean occupancy (any plate covers this cell)
  //   colorIdx — index into the colourPalette below for the WINNING
  //             colour at this cell. Last writer wins per cell: members
  //             are processed in array order, so a later plate's colour
  //             overrides any earlier plate's at the same cell. Cells
  //             with only one contributing plate just keep that plate's
  //             colour. This is the "inherit the latest color where
  //             they overlap" behaviour the user asked for.
  const W = Math.max(1, Math.ceil((xMax - xMin) * UNION_CELLS_PER_M));
  const D = Math.max(1, Math.ceil((zMax - zMin) * UNION_CELLS_PER_M));
  const occ = new Uint8Array(W * D);
  // colorIdx is 0 = unoccupied; 1..N = palette index + 1. Limited to 255
  // distinct colours per group (way more than realistic).
  const colorIdx = new Uint8Array(W * D);
  const colorPalette = [];   // unique hex strings, ordered by first sight
  const colorLookup = new Map();   // hex → 1-based index
  const idxFor = (hex) => {
    const key = hex || '#fafaf7';
    let idx = colorLookup.get(key);
    if (idx == null) {
      colorPalette.push(key);
      idx = colorPalette.length;
      colorLookup.set(key, idx);
    }
    return idx;
  };
  for (let i = 0; i < memberBounds.length; i++) {
    const b = memberBounds[i];
    const member = members[i];
    const idx = idxFor(member.color);
    const x0 = Math.max(0, Math.floor((b.xMin - xMin) * UNION_CELLS_PER_M));
    const x1 = Math.min(W, Math.ceil ((b.xMax - xMin) * UNION_CELLS_PER_M));
    const z0 = Math.max(0, Math.floor((b.zMin - zMin) * UNION_CELLS_PER_M));
    const z1 = Math.min(D, Math.ceil ((b.zMax - zMin) * UNION_CELLS_PER_M));
    for (let z = z0; z < z1; z++) {
      const row = z * W;
      for (let x = x0; x < x1; x++) {
        occ[row + x] = 1;
        colorIdx[row + x] = idx;   // last writer wins
      }
    }
  }

  // SIMPLE RELIABLE APPROACH: every occupied rasterised cell becomes a
  // tiny paper-thin BoxGeometry at its world position, tinted by the
  // cell's winning colour. Boxes batched per colour into one merged
  // geometry — never invisible, never transparent, every plate shape
  // is just a grid of small solid boxes. Stroke is the outer perimeter
  // of the connected component (computed from the same cell set via
  // boundary-edge traversal, same recipe walls use to suppress
  // intersection seams).
  const cellM = 1 / UNION_CELLS_PER_M;
  const cellH = yMax - yMin;
  // Group cells by colour.
  const cellsByColor = new Map();   // colorIdx → array of (x,z) pairs
  for (let z = 0; z < D; z++) {
    for (let x = 0; x < W; x++) {
      const i = z * W + x;
      if (!occ[i]) continue;
      const ci = colorIdx[i];
      if (!cellsByColor.has(ci)) cellsByColor.set(ci, []);
      cellsByColor.get(ci).push([x, z]);
    }
  }
  // Build merged geometry per colour.
  for (const [ci, cells] of cellsByColor) {
    if (!cells.length) continue;
    const colorHex = colorPalette[ci - 1];
    const geoms = [];
    for (const [x, z] of cells) {
      const wx0 = xMin + x * cellM;
      const wz0 = zMin + z * cellM;
      const box = new THREE.BoxGeometry(cellM, cellH, cellM);
      box.translate(wx0 + cellM / 2, yMin + cellH / 2, wz0 + cellM / 2);
      geoms.push(box);
    }
    const merged = BufferGeometryUtils.mergeGeometries(geoms, false);
    if (!merged) continue;
    const rep = members.find(m => (m.color || '#fafaf7') === colorHex) || members[0];
    const w = xMax - xMin, d = zMax - zMin;
    addPlateMesh(rootPlates, merged, { ...rep, color: colorHex }, w, d, cellH, s);
  }

  // Stroke — connected-component perimeter, drawn once per component
  // regardless of internal colour boundaries.
  const stroker = members.find(m => m.stroke) || members[0];
  if (stroker.stroke) {
    const visited = new Uint8Array(W * D);
    for (let z = 0; z < D; z++) {
      for (let x = 0; x < W; x++) {
        if (!occ[z * W + x] || visited[z * W + x]) continue;
        const comp = floodFill(occ, visited, W, D, x, z);
        addPerimeterStroke(rootPlates, comp, xMin, zMin, cellM, yMax, stroker.strokeColor);
      }
    }
  }

  // Paint planes per member (cell-rect addressing stays per-anchor so
  // paint state survives the union — same sidecar lookup either way).
  for (const p of members) {
    const b = plateBounds(p, cellSize);
    if (b) addPlatePaint(rootPlates, p, s, b);
  }
}

// 4-connectivity flood fill returning the cell coords of the component.
function floodFill(occ, visited, W, D, sx, sz) {
  const stack = [[sx, sz]];
  const cells = [];
  while (stack.length) {
    const [x, z] = stack.pop();
    if (x < 0 || x >= W || z < 0 || z >= D) continue;
    const i = z * W + x;
    if (!occ[i] || visited[i]) continue;
    visited[i] = 1;
    cells.push([x, z]);
    stack.push([x + 1, z], [x - 1, z], [x, z + 1], [x, z - 1]);
  }
  return cells;
}

// Build a 2D Shape from a component's cells via outline tracing on the
// half-cell edge graph. Each occupied cell contributes 4 edges; edges
// shared between two occupied cells cancel. The remaining edges form the
// outer boundary (+ any holes). We assemble them into closed loops and
// emit ONE Shape (largest loop) plus its holes (smaller loops inside).
function buildOutlineShape(cellList, xMin, zMin, cellM) {
  if (!cellList.length) return null;
  // Build cell set for O(1) neighbour test.
  const set = new Set();
  for (const [x, z] of cellList) set.add(`${x},${z}`);
  // Emit boundary edges: for each cell, each of its 4 sides that has NO
  // occupied neighbour is a boundary edge. Edges stored as
  // [(x0,z0) → (x1,z1)] in CELL units (we'll convert to metres later).
  const edges = [];
  for (const [x, z] of cellList) {
    if (!set.has(`${x},${z - 1}`)) edges.push([[x,     z    ], [x + 1, z    ]]); // top
    if (!set.has(`${x + 1},${z}`)) edges.push([[x + 1, z    ], [x + 1, z + 1]]); // right
    if (!set.has(`${x},${z + 1}`)) edges.push([[x + 1, z + 1], [x,     z + 1]]); // bottom
    if (!set.has(`${x - 1},${z}`)) edges.push([[x,     z + 1], [x,     z    ]]); // left
  }
  // Stitch edges into closed loops. Each edge's end-point matches exactly
  // one next-edge's start-point because edges are axis-aligned + boundary.
  const byStart = new Map();
  for (const e of edges) byStart.set(`${e[0][0]},${e[0][1]}`, e);
  const loops = [];
  while (byStart.size) {
    const first = byStart.values().next().value;
    const loop = [first[0]];
    let cur = first;
    while (true) {
      byStart.delete(`${cur[0][0]},${cur[0][1]}`);
      loop.push(cur[1]);
      const nextKey = `${cur[1][0]},${cur[1][1]}`;
      const next = byStart.get(nextKey);
      if (!next) break;
      cur = next;
    }
    loops.push(loop);
  }
  if (!loops.length) return null;
  // Loop area sign tells inside vs outside (CCW = outer, CW = hole).
  // For now: pick the loop with the largest absolute area as the outer
  // boundary; treat the rest as holes inside it.
  let outerIdx = 0, outerArea = 0;
  const areas = loops.map((loop, i) => {
    let a = 0;
    for (let k = 0; k < loop.length - 1; k++) {
      a += (loop[k][0] * loop[k + 1][1]) - (loop[k + 1][0] * loop[k][1]);
    }
    const abs = Math.abs(a);
    if (abs > outerArea) { outerArea = abs; outerIdx = i; }
    return a;
  });
  const toMeters = (pt) => [pt[0] * cellM + xMin, pt[1] * cellM + zMin];
  const outer = loops[outerIdx].map(toMeters);
  const holes = loops.filter((_, i) => i !== outerIdx).map(loop => loop.map(toMeters));
  const shape = new THREE.Shape();
  shape.moveTo(outer[0][0], outer[0][1]);
  for (let i = 1; i < outer.length; i++) shape.lineTo(outer[i][0], outer[i][1]);
  shape.closePath();
  for (const hole of holes) {
    const path = new THREE.Path();
    path.moveTo(hole[0][0], hole[0][1]);
    for (let i = 1; i < hole.length; i++) path.lineTo(hole[i][0], hole[i][1]);
    path.closePath();
    shape.holes.push(path);
  }
  return shape;
}

// Stroke the merged-component perimeter directly from the cell set. For
// each cell in the component, emit each of its 4 sides only when the
// neighbour cell in that direction is NOT in the component. Interior
// shared edges cancel naturally. Drawn at y = yTop (the top cap level).
// Robust: doesn't depend on loop-stitching or polygon triangulation.
function addPerimeterStroke(rootPlates, cellList, xMin, zMin, cellM, yTop, strokeColor) {
  const set = new Set(cellList.map(([x, z]) => `${x},${z}`));
  const positions = [];
  for (const [x, z] of cellList) {
    const wx0 = xMin + x * cellM, wx1 = wx0 + cellM;
    const wz0 = zMin + z * cellM, wz1 = wz0 + cellM;
    if (!set.has(`${x},${z - 1}`)) positions.push(wx0, yTop, wz0, wx1, yTop, wz0);   // top edge
    if (!set.has(`${x + 1},${z}`)) positions.push(wx1, yTop, wz0, wx1, yTop, wz1);   // right edge
    if (!set.has(`${x},${z + 1}`)) positions.push(wx0, yTop, wz1, wx1, yTop, wz1);   // bottom edge
    if (!set.has(`${x - 1},${z}`)) positions.push(wx0, yTop, wz0, wx0, yTop, wz1);   // left edge
  }
  if (!positions.length) return;
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  const lines = new THREE.LineSegments(geom,
    new THREE.LineBasicMaterial({ color: strokeColor || 0x0b0d14 }));
  lines.renderOrder = 3;
  rootPlates.add(lines);
}

// (legacy from polygon-Shape approach, kept in case something else calls it)
function addStrokeFromTopOutline(rootPlates, shape, yTop, strokeColor) {
  const positions = [];
  const emit = (loop) => {
    for (let i = 0; i < loop.length - 1; i++) {
      positions.push(loop[i].x, yTop, loop[i].y,  loop[i + 1].x, yTop, loop[i + 1].y);
    }
  };
  emit(shape.getPoints(1));
  for (const hole of shape.holes) emit(hole.getPoints(1));
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  const lines = new THREE.LineSegments(
    geom,
    new THREE.LineBasicMaterial({ color: strokeColor || 0x0b0d14 }),
  );
  lines.renderOrder = 1;
  rootPlates.add(lines);
}

// Build the fill mesh for a plate (single or merged). Reuses the same
// material recipe so colour / baseTexture path is identical. Plates
// receive lighting like the floor — Lambert by default, Toon when
// world.toonShading is on. This makes plates respond to the day
// cycle (darken at night with horizon-eclipsed sun, brighten under
// noon sun) instead of staying flat-bright 24/7.
function addPlateMesh(rootPlates, geom, plate, w, d, h, s) {
  const baseSrc = plate.baseTexture && (plate.baseTexture.url || plate.baseTexture.dataUrl);
  const color = baseSrc ? 0xffffff : (plate.color || '#fafaf7');
  // DoubleSide handles the winding-flip from the merged extrusion path
  // (which rotates -PI/2 around X) AND keeps single plates rendering
  // correctly. Paper-thin slabs have no inside-out hazard.
  // No polygonOffset — that was pushing plates AWAY from camera which
  // let the floor (also offset) draw on top, making merged plates
  // look transparent. Plates rely on their physical Y position above
  // the floor for depth sorting.
  const toonOn = !!s?.world?.toonShading?.enabled;
  const mat = toonOn
    ? new THREE.MeshToonMaterial({
        color,
        side: THREE.DoubleSide,
        gradientMap: makeToonGradient(s?.world?.toonShading?.levels),
      })
    : new THREE.MeshLambertMaterial({ color, side: THREE.DoubleSide });
  if (baseSrc) attachPlateTexture(mat, plate.baseTexture, w, d);
  const mesh = new THREE.Mesh(geom, mat);
  mesh.userData.plateId = plate.id;
  // Render after the floor so plates always sit on top visually.
  mesh.renderOrder = 2;
  rootPlates.add(mesh);
}

function addStrokeFromGeom(rootPlates, geom, strokeColor) {
  const edges = new THREE.LineSegments(
    new THREE.EdgesGeometry(geom, 30),
    new THREE.LineBasicMaterial({ color: strokeColor || 0x0b0d14 }),
  );
  edges.renderOrder = 1;
  rootPlates.add(edges);
}

function addPlatePaint(rootPlates, plate, s, bounds) {
  const cellSize = s.grid.cellSizeMeters;
  const { xMin, xMax, zMin, zMax, yMin, yMax } = bounds;
  const h = yMax - yMin;
  const r0 = Math.floor(zMin / cellSize);
  const r1 = Math.floor((zMax - 1e-6) / cellSize);
  const c0 = Math.floor(xMin / cellSize) + 1;
  const c1 = Math.floor((xMax - 1e-6) / cellSize) + 1;
  const rect = { r0, r1, c0, c1, cellSize };
  const planes = buildPaintPlanesForRect(rect, h, s.palette, plate);
  for (const p of planes) {
    p.position.add(new THREE.Vector3(0, yMin, 0));
    rootPlates.add(p);
  }
}

// AABB list for collision. Plates collide as 6-sided boxes like walls.
export function plateAABBs(s) {
  const aabbs = [];
  if (!s.plates?.length) return aabbs;
  const cellSize = s.grid.cellSizeMeters;
  for (const plate of s.plates) {
    if (!plate.collide) continue;
    const b = plateBounds(plate, cellSize);
    if (!b) continue;
    aabbs.push(new THREE.Box3(
      new THREE.Vector3(b.xMin, b.yMin, b.zMin),
      new THREE.Vector3(b.xMax, b.yMax, b.zMax),
    ));
  }
  return aabbs;
}

// World-space bounds of a plate (handles symmetric scale + directional
// per-side offsets).
function plateBounds(plate, cellSize) {
  const r = rowIdToIndex(plate.rowId);
  if (r === null || plate.col == null) return null;
  const cx = (plate.col - 0.5) * cellSize;
  const cz = (r + 0.5) * cellSize;
  let xMin, xMax, zMin, zMax;
  if (plate.directional) {
    xMin = cx - (plate.offsetW ?? 0.5);
    xMax = cx + (plate.offsetE ?? 0.5);
    zMin = cz - (plate.offsetN ?? 0.5);
    zMax = cz + (plate.offsetS ?? 0.5);
  } else if (plate.snapMode === 'grid') {
    // 'grid' mode: round scale to integer cells, place so edges land
    // on grid lines. Odd cell counts extend symmetrically (= same as
    // 'center'); even cell counts bias one extra cell to east + south
    // of the anchor (Math.ceil for the +X / +Z half, Math.floor for
    // the -X / -Z half). Result: plate always covers N full cells
    // with edges on grid lines, regardless of N.
    const cellsX = Math.max(1, Math.round((plate.scaleX ?? 1) / cellSize));
    const cellsZ = Math.max(1, Math.round((plate.scaleZ ?? 1) / cellSize));
    const wX = Math.floor((cellsX - 1) / 2);   // cells extending west of anchor
    const eX = Math.ceil ((cellsX - 1) / 2);   // cells extending east of anchor
    const wZ = Math.floor((cellsZ - 1) / 2);   // cells extending north of anchor
    const eZ = Math.ceil ((cellsZ - 1) / 2);   // cells extending south of anchor
    xMin = (plate.col - 1 - wX) * cellSize;
    xMax = (plate.col + eX)     * cellSize;
    zMin = (r - wZ) * cellSize;
    zMax = (r + 1 + eZ) * cellSize;
  } else {
    const halfX = (plate.scaleX ?? 1) / 2;
    const halfZ = (plate.scaleZ ?? 1) / 2;
    xMin = cx - halfX; xMax = cx + halfX;
    zMin = cz - halfZ; zMax = cz + halfZ;
  }
  const yMin = plate.y ?? 0;
  const yMax = yMin + (plate.scaleY ?? 0.01);
  return { xMin, xMax, zMin, zMax, yMin, yMax };
}

// Apply a plate's baseTexture (same recipe as walls).
const _plateDeadUrls = new Set();
function attachPlateTexture(mat, baseTex, w, d) {
  const loader = new THREE.TextureLoader();
  const src = baseTex.url ? resolveAssetUrl(baseTex.url) : baseTex.dataUrl;
  if (_plateDeadUrls.has(src)) return;
  loader.load(src, (texture) => {
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
  }, undefined, () => { _plateDeadUrls.add(src); });
}
