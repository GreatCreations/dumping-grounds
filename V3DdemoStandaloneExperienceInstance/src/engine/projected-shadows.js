// engine/projected-shadows.js — flat polygon shadows projected onto
// the floor from each opaque caster, using the sun's direction.
//
// Produces artifact-free hard-edged shadows that match the comic-
// book aesthetic — no gradients, no resolution-related stair-steps,
// no shadow-acne dots. The shadow is just a geometric polygon
// rendered as a dark semi-transparent mesh, so what you see is
// exactly what gets drawn — no depth-buffer comparisons involved.
//
// How it works per wall cell:
//   1. The cell has 4 bottom corners on the floor (the wall's
//      footprint) and 4 top corners at the wall's height.
//   2. Project the top corners DOWN to the floor along the sun's
//      travel direction. The 4 projected points land somewhere
//      else on the floor (shifted by sun angle).
//   3. The shadow on the floor is the CONVEX HULL of the 4 bottom
//      points + 4 projected top points — a hexagon when the sun is
//      at an angle, a square when the sun is directly overhead.
//   4. Render the hexagon as two-sided triangles with a dark
//      semi-transparent material.
//
// Limitations:
//   - Shadows are flat on the FLOOR plane (y=0). Shadows don't
//     climb adjacent walls or other receivers — they only land on
//     the ground. Trade-off for cleanliness.
//   - Doesn't capture the hole in a window-cell's shadow — the
//     window-cell's full footprint casts as opaque. Trade-off for
//     simplicity.
//   - Updates on state rebuild only. Sun direction changes during
//     the day cycle won't move the shadows until next rebuild.

import * as THREE from 'three';
import { cellsOf } from '../core/schema.js';
import { rowIdToIndex } from '../core/grid-addr.js';

const KIND_HEIGHTS = {
  full:            3.0,
  'three-quarter': 2.25,
  half:            1.5,
  quarter:         0.75,
  'window-start':  3.0,
  'window-end':    3.0,
  'door-start':    3.0,
  'door-end':      3.0,
  windowed:        3.0,
  corner:          3.0,
  stairs:          3.0,
};

function wallHeight(w) {
  if (typeof w.customHeight === 'number' && w.customHeight > 0) return w.customHeight;
  return KIND_HEIGHTS[w.kind] ?? KIND_HEIGHTS.full;
}

// Hexagon vertex order for the convex hull of {bottom rect, projected
// top rect}. Returns vertices in CW or CCW (doesn't matter — material
// uses DoubleSide). Cases handled by quadrant of (offX, offZ).
function hexagonHull(x0, x1, z0, z1, offX, offZ) {
  const tx0 = x0 + offX, tz0 = z0 + offZ;
  const tx1 = x1 + offX, tz1 = z1 + offZ;
  // Quadrant-by-quadrant — each case is a 6-vertex polygon visiting
  // the convex-hull extremes once.
  if (offX >= 0 && offZ >= 0) {
    return [
      [x0,  z0],  [x1,  z0],  [tx1, tz0],
      [tx1, tz1], [tx0, tz1], [x0,  z1],
    ];
  }
  if (offX >= 0 && offZ <  0) {
    return [
      [x0,  z0],  [tx0, tz0], [tx1, tz0],
      [tx1, tz1], [x1,  z1],  [x0,  z1],
    ];
  }
  if (offX <  0 && offZ >= 0) {
    return [
      [x0,  z0],  [x1,  z0],  [x1,  z1],
      [tx1, tz1], [tx0, tz1], [tx0, tz0],
    ];
  }
  // offX < 0 && offZ < 0
  return [
    [tx0, tz0], [tx1, tz0], [x1,  z0],
    [x1,  z1],  [x0,  z1],  [tx0, tz1],
  ];
}

export function buildProjectedShadows(root, s) {
  root.clear();
  if (!s.world?.shadowsProjected?.enabled) return;
  if (!s.sun?.directional?.direction) return;

  const d = s.sun.directional.direction;
  // Sun below horizon — no projected shadow possible (would go
  // upward through walls). Bail.
  if (d[1] >= 0) return;

  const cellSize = s.grid.cellSizeMeters;
  // Projection: point at height h on floor offsets by (h * dx / -dy,
  // h * dz / -dy). Cache the per-height-1 offsets for speed.
  const invNegDy = 1 / -d[1];
  const sxPerH   = d[0] * invNegDy;
  const szPerH   = d[2] * invNegDy;

  const positions = [];
  const indices = [];
  let vidx = 0;

  const emitHex = (hex) => {
    // Push 6 vertices, all at y=0.01 to sit just above the floor
    // and avoid z-fighting with the floor plane.
    const base = vidx;
    for (const [hx, hz] of hex) positions.push(hx, 0.01, hz);
    // Fan triangulation from vertex 0: triangles (0,1,2), (0,2,3),
    // (0,3,4), (0,4,5).
    indices.push(base, base + 1, base + 2);
    indices.push(base, base + 2, base + 3);
    indices.push(base, base + 3, base + 4);
    indices.push(base, base + 4, base + 5);
    vidx += 6;
  };

  // ---- Walls ----
  // Emit ONE hexagon per WALL using its overall bounding-box, not
  // one per cell. Per-cell hexagons overlap massively when a wall
  // spans multiple cells — most of each cell's hexagon hides inside
  // the wall's own footprint and only the tiny tip projects past
  // the wall edge, which read visually as "just triangles." A
  // bounding-box hexagon gives one continuous shadow shape for the
  // entire wall that extends cleanly past its edges in the sun's
  // projection direction. For non-rectangular (corner / L-shape)
  // walls the bbox slightly overhangs into the empty L interior;
  // acceptable for v1.
  for (const w of s.walls || []) {
    if (w.kind === 'stairs') continue;   // stair geometry is complex; skip
    const h = wallHeight(w);
    if (h <= 0.01) continue;
    const cells = cellsOf(w);
    if (!cells.length) continue;
    let cMin = Infinity, cMax = -Infinity, rMin = Infinity, rMax = -Infinity;
    for (const cell of cells) {
      if (cell.isDoor) continue;
      if (cell.c < cMin) cMin = cell.c;
      if (cell.c > cMax) cMax = cell.c;
      if (cell.r < rMin) rMin = cell.r;
      if (cell.r > rMax) rMax = cell.r;
    }
    if (cMin === Infinity) continue;   // wall was all door cells
    const offX = h * sxPerH;
    const offZ = h * szPerH;
    const x0 = (cMin - 1) * cellSize;
    const x1 = cMax       * cellSize;
    const z0 = rMin       * cellSize;
    const z1 = (rMax + 1) * cellSize;
    emitHex(hexagonHull(x0, x1, z0, z1, offX, offZ));
  }

  // ---- Objects (GLB meshes placed in cells) ----
  // Approximate each object as a unit cube scaled by its `scale`
  // field. The exact GLB geometry can vary wildly, but the
  // bounding-box projection gives a recognisable shadow shape.
  for (const o of s.objects || []) {
    if (o._egg) continue;
    const r = rowIdToIndex(o.rowId);
    if (r === null) continue;
    const sc = Math.max(0.05, o.scale ?? 1);
    const h = cellSize * sc;
    if (h <= 0.01) continue;
    const offX = h * sxPerH;
    const offZ = h * szPerH;
    const cx = (o.col - 0.5) * cellSize;
    const cz = (r + 0.5) * cellSize;
    const half = (cellSize * sc) * 0.5;
    const x0 = cx - half, x1 = cx + half;
    const z0 = cz - half, z1 = cz + half;
    emitHex(hexagonHull(x0, x1, z0, z1, offX, offZ));
  }

  // ---- Trim columns (free-standing pillars at cell centres) ----
  // Frame trim and battens are pinned to walls — their shadows
  // would overlap the wall's own and don't add useful information.
  // Columns are the only trim type that warrants its own caster.
  for (const t of s.trims || []) {
    if (t.mode !== 'column') continue;
    const r = rowIdToIndex(t.rowId);
    if (r === null) continue;
    const h = t.totalHeight ?? 3.0;
    if (h <= 0.01) continue;
    const offX = h * sxPerH;
    const offZ = h * szPerH;
    const size = t.columnSize ?? 0.4;
    const half = size * 0.5;
    const cx = (t.col - 0.5) * cellSize + (t.xOffset ?? 0);
    const cz = (r + 0.5)     * cellSize + (t.zOffset ?? 0);
    const x0 = cx - half, x1 = cx + half;
    const z0 = cz - half, z1 = cz + half;
    emitHex(hexagonHull(x0, x1, z0, z1, offX, offZ));
  }

  if (!positions.length) return;

  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geom.setIndex(indices);

  const opacity = s.world.shadowsProjected.opacity ?? 0.35;
  const mat = new THREE.MeshBasicMaterial({
    color: 0x000000,
    transparent: true,
    opacity,
    depthWrite: false,
    side: THREE.DoubleSide,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -1,
  });

  const mesh = new THREE.Mesh(geom, mat);
  // Render after floor (so it composites on top) but before
  // dome / sky (-10) and walls (default 0 +). renderOrder = 1.
  mesh.renderOrder = 1;
  root.add(mesh);
}
