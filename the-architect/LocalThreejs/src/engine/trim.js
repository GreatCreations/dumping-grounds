// engine/trim.js — frames, battens, columns.
//
// One entity type (s.trims[]). Mode auto-detected at build time:
//   - opening at the anchor cell → 'hole-snap': frame around the
//     opening's outer rectangle, on the same wall face as the
//     opening's swinging body. Side toggles (top/bottom/left/right)
//     pick which rails/stiles are present; the FRAME IS A SINGLE
//     EXTRUDED POLYGON so corners are seamless (no internal joint
//     edges where rail meets stile — that was the old box-per-piece
//     behaviour, which left a visible horizontal line crossing the
//     corner on doors).
//   - wall at the anchor cell, no opening → 'batten': ONE vertical
//     strip on the wall surface, floor to top of wall. Like the
//     "batten" in board-and-batten siding — a single board, not a
//     boxed frame. Side toggles are not used.
//   - no wall at the anchor cell → 'column': free-standing square
//     pillar at the cell centre, floor to `totalHeight`.
//
// All three modes respect `xOffset / yOffset / zOffset` and a single
// `color` + `stroke` colour. Default colour is a comic-book medium
// grey (#9a9a9a); stroke colour is the project ink (#0b0d14).

import * as THREE from 'three';
import { rowIdToIndex } from '../core/grid-addr.js';
import { cellsOf } from '../core/schema.js';
import { chooseSurfaceMaterial } from './walls.js';

const DEFAULT_COLOR  = 0x9a9a9a;
const DEFAULT_STROKE = 0x0b0d14;
const WALL_HEIGHT_DEFAULT = 3.0;

export function buildTrims(root, s) {
  root.clear();
  if (!s.trims?.length) return;
  const cellSize = s.grid.cellSizeMeters;

  for (const tr of s.trims) {
    const r = rowIdToIndex(tr.rowId);
    if (r === null || tr.col == null) continue;

    // Resolve mode from context if 'auto'
    const mode = (tr.mode && tr.mode !== 'auto')
      ? tr.mode
      : resolveMode(s, r, tr.col);

    const ctx = {
      tr, r, col: tr.col, cellSize, s,
      colorHex: tr.color  ? new THREE.Color(tr.color).getHex()  : DEFAULT_COLOR,
      strokeHex: tr.strokeColor ? new THREE.Color(tr.strokeColor).getHex() : DEFAULT_STROKE,
    };

    if (mode === 'hole-snap') {
      buildHoleSnap(root, ctx);
    } else if (mode === 'batten') {
      buildBatten(root, ctx);
    } else {
      buildColumn(root, ctx);
    }
  }
}

// ---- Mode resolution ----

function resolveMode(s, r, col) {
  // 1. Opening present at this anchor?
  if ((s.openings || []).some(o => o.rowId && rowIdToIndex(o.rowId) === r && o.col === col)) {
    return 'hole-snap';
  }
  // 2. Wall covering this cell?
  for (const w of (s.walls || [])) {
    if (cellsOf(w).some(c => c.r === r && c.c === col)) return 'batten';
  }
  return 'column';
}

// ---- Helpers ----

// World position of cell centre.
function cellCentre(r, col, cellSize) {
  return new THREE.Vector3((col - 0.5) * cellSize, 0, (r + 0.5) * cellSize);
}

// Side rotation (radians around Y) for which cell-edge the trim sits on.
function sideRotation(side) {
  switch (side) {
    case 'n': return 0;
    case 's': return Math.PI;
    case 'w': return Math.PI / 2;
    case 'e': return -Math.PI / 2;
    default:  return 0;
  }
}

// Position on the cell-edge for the given side.
function sideAnchor(cx, cz, side, cellSize) {
  const h = cellSize / 2;
  switch (side) {
    case 'n': return { x: cx,     z: cz - h };
    case 's': return { x: cx,     z: cz + h };
    case 'w': return { x: cx - h, z: cz     };
    case 'e': return { x: cx + h, z: cz     };
    default:  return { x: cx,     z: cz - h };
  }
}

// Find an opening at (r, col). Returns first match or null.
function findOpening(s, r, col) {
  return (s.openings || []).find(o => rowIdToIndex(o.rowId) === r && o.col === col) || null;
}

// Find a wall covering (r, col). Returns first match or null.
function findWall(s, r, col) {
  return (s.walls || []).find(w => cellsOf(w).some(c => c.r === r && c.c === col)) || null;
}

// Get wall axis direction. 'row' = E-W oriented (n/s sides);
// 'col' = N-S oriented (w/e sides).
function wallAxis(w) {
  if (w.axis) return w.axis;
  const cells = cellsOf(w);
  if (cells.length >= 2 && cells[0].r === cells[1].r) return 'row';
  return 'col';
}

// Make a box mesh of size (w,h,d) at local centre (cx,cy,cz), with
// the trim's body material. Optionally add silhouette stroke.
function makeBoxPiece(parent, w, h, d, cx, cy, cz, mat, strokeMat) {
  const geom = new THREE.BoxGeometry(w, h, d);
  const mesh = new THREE.Mesh(geom, mat);
  mesh.position.set(cx, cy, cz);
  parent.add(mesh);
  if (strokeMat) {
    const edges = new THREE.LineSegments(
      new THREE.EdgesGeometry(geom, 60),
      strokeMat,
    );
    edges.position.copy(mesh.position);
    parent.add(edges);
  }
  return mesh;
}

// ---- Hole-snap mode ----
//
// Frame around an opening's outer rectangle. Sides are top/bot
// rails + L/R stiles. Corner-seamless: when both top + a side are on,
// the top rail extends past the side to include the corner.
function buildHoleSnap(root, ctx) {
  const { s, r, col, cellSize, tr } = ctx;
  const op = findOpening(s, r, col);
  if (!op) return;

  // Snap dimensions from the opening
  const W = op.width;
  const H = op.height;
  const yBottom = op.yOffset ?? 0;
  const yCentre = yBottom + H / 2;
  const opSide  = op.side || 'n';

  // Default-disable bottom when snapping to a door (no sill).
  const sides = { ...tr.sides };
  if (tr.autoDoorNoBottom !== false && op.kind === 'door') {
    if (sides.bottom === true && tr.sides.bottom === true) {
      // Only override if user hasn't explicitly toggled it
      // (we can't distinguish "user set true" from "default true"
      // without a tri-state — Phase A default is to follow autoDoor).
      sides.bottom = false;
    }
  }

  // Determine which side(s) to render on
  const side = tr.side;
  const sidesToRender = (side === 'both')
    ? ['_op', '_opp']
    : [(side === 'auto') ? '_op' : side];

  for (const tag of sidesToRender) {
    // Map _op / _opp / cardinal → actual rotation + position
    let placeSide;
    if (tag === '_op')      placeSide = opSide;
    else if (tag === '_opp') placeSide = oppositeSide(opSide);
    else                     placeSide = tag;
    placeOneHoleFrame(root, ctx, op, W, H, yCentre, placeSide, sides);
  }
}

function oppositeSide(side) {
  return { n: 's', s: 'n', e: 'w', w: 'e' }[side] || 'n';
}

function placeOneHoleFrame(root, ctx, op, W, H, yCentre, side, sides) {
  const { tr, r, col, cellSize } = ctx;
  const mat = chooseSurfaceMaterial(ctx.s, ctx.colorHex);
  const strokeMat = tr.stroke !== false
    ? new THREE.LineBasicMaterial({ color: ctx.strokeHex })
    : null;

  const cx = (col - 0.5) * cellSize;
  const cz = (r + 0.5) * cellSize;
  const anchor = sideAnchor(cx, cz, side, cellSize);
  const yRot = sideRotation(side);

  // Sub-group so we can rotate the local frame piece axes to match
  // the wall direction.
  const wrap = new THREE.Group();
  wrap.position.set(
    anchor.x + (tr.xOffset || 0) * Math.cos(yRot) + (tr.zOffset || 0) * Math.sin(yRot),
    yCentre + (tr.yOffset || 0),
    anchor.z - (tr.xOffset || 0) * Math.sin(yRot) + (tr.zOffset || 0) * Math.cos(yRot),
  );
  wrap.rotation.y = yRot;
  root.add(wrap);

  // Frame piece dimensions in opening-local space:
  // - thickness grows OUTWARD (away from hole) by T per active side
  // - depth is the protrusion from wall
  const T = tr.thickness ?? 0.06;
  const D = tr.depth     ?? 0.03;
  const shapes = buildFrameShapes(W, H, T, sides);
  if (!shapes.length) {
    wrap.userData.trimId = tr.id;
    return;
  }
  addExtrudedFrame(wrap, shapes, D, mat, strokeMat);

  // Window/door trim frames never cast shadows. With the trim
  // protruding 3 cm out from the wall face, their shadow extends
  // through the wall thickness onto the back face — producing a
  // ghost trim outline on the opposite side of the wall that
  // doesn't match what the trim is supposed to represent. Marking
  // the child meshes here lets the engine walker skip casting on
  // them while leaving everything else (frame jambs, door panels,
  // pane dividers — all separate meshes built in openings.js) to
  // cast normally. Columns and column-mode trim still cast (this
  // opt-out is hole-snap-only).
  wrap.traverse((n) => { if (n.isMesh) n.userData.noCastShadow = true; });

  // Tag the outer wrap so picking + AABB can find it
  wrap.userData.trimId = tr.id;
}

// ---- Frame shape construction ----
//
// Builds the 2D outline of the frame as one or more THREE.Shape
// polygons. The frame material region is the set of 8 cells in a
// 3x3 grid (centre is the opening) that are "on": 4 edge cells
// directly on the sides, and 4 corner cells that are on iff their
// two adjacent sides are both on. Returns the OUTLINE polygons so
// that a single ExtrudeGeometry per polygon yields a manifold mesh
// — no internal joint lines where rail meets stile.
function buildFrameShapes(W, H, T, sides) {
  const L  = !!sides.left,  R = !!sides.right;
  const Tp = !!sides.top,   B = !!sides.bottom;
  if (!L && !R && !Tp && !B) return [];

  const xL = -W / 2 - (L  ? T : 0);   // outer-left x
  const xR =  W / 2 + (R  ? T : 0);   // outer-right x
  const yB = -H / 2 - (B  ? T : 0);   // outer-bottom y
  const yT =  H / 2 + (Tp ? T : 0);   // outer-top y
  const iL = -W / 2, iR = W / 2;      // inner (hole) bounds
  const iB = -H / 2, iT = H / 2;

  // All 4 sides: window-style rectangle with hole.
  if (L && R && Tp && B) {
    const s = new THREE.Shape();
    s.moveTo(xL, yB); s.lineTo(xR, yB); s.lineTo(xR, yT); s.lineTo(xL, yT); s.closePath();
    const h = new THREE.Path();
    h.moveTo(iL, iB); h.lineTo(iL, iT); h.lineTo(iR, iT); h.lineTo(iR, iB); h.closePath();
    s.holes.push(h);
    return [s];
  }

  // 3-sided U-shapes (door = top+L+R, etc.). Single CCW polygon, no hole.
  if (Tp && L && R && !B) {  // DOOR
    const s = new THREE.Shape();
    s.moveTo(xL, iB); s.lineTo(iL, iB); s.lineTo(iL, iT); s.lineTo(iR, iT);
    s.lineTo(iR, iB); s.lineTo(xR, iB); s.lineTo(xR, yT); s.lineTo(xL, yT);
    s.closePath();
    return [s];
  }
  if (B && L && R && !Tp) {
    const s = new THREE.Shape();
    s.moveTo(xL, yB); s.lineTo(xR, yB); s.lineTo(xR, iT); s.lineTo(iR, iT);
    s.lineTo(iR, iB); s.lineTo(iL, iB); s.lineTo(iL, iT); s.lineTo(xL, iT);
    s.closePath();
    return [s];
  }
  if (Tp && B && L && !R) {
    const s = new THREE.Shape();
    s.moveTo(xL, yB); s.lineTo(iR, yB); s.lineTo(iR, iB); s.lineTo(iL, iB);
    s.lineTo(iL, iT); s.lineTo(iR, iT); s.lineTo(iR, yT); s.lineTo(xL, yT);
    s.closePath();
    return [s];
  }
  if (Tp && B && R && !L) {
    const s = new THREE.Shape();
    s.moveTo(iL, yB); s.lineTo(xR, yB); s.lineTo(xR, yT); s.lineTo(iL, yT);
    s.lineTo(iL, iT); s.lineTo(iR, iT); s.lineTo(iR, iB); s.lineTo(iL, iB);
    s.closePath();
    return [s];
  }

  // 2-sided adjacent (L-shapes). Single CCW polygon, no hole.
  if (Tp && L && !R && !B) {
    const s = new THREE.Shape();
    s.moveTo(xL, iB); s.lineTo(iL, iB); s.lineTo(iL, iT); s.lineTo(iR, iT);
    s.lineTo(iR, yT); s.lineTo(xL, yT);
    s.closePath();
    return [s];
  }
  if (Tp && R && !L && !B) {
    const s = new THREE.Shape();
    s.moveTo(iL, iT); s.lineTo(iL, yT); s.lineTo(xR, yT); s.lineTo(xR, iB);
    s.lineTo(iR, iB); s.lineTo(iR, iT);
    s.closePath();
    return [s];
  }
  if (B && L && !R && !Tp) {
    const s = new THREE.Shape();
    s.moveTo(xL, yB); s.lineTo(iR, yB); s.lineTo(iR, iB); s.lineTo(iL, iB);
    s.lineTo(iL, iT); s.lineTo(xL, iT);
    s.closePath();
    return [s];
  }
  if (B && R && !L && !Tp) {
    const s = new THREE.Shape();
    s.moveTo(iL, yB); s.lineTo(xR, yB); s.lineTo(xR, iT); s.lineTo(iR, iT);
    s.lineTo(iR, iB); s.lineTo(iL, iB);
    s.closePath();
    return [s];
  }

  // Remaining: 1 side, or 2 opposite sides. Disconnected bars; each
  // is its own simple rectangle polygon.
  const out = [];
  if (Tp) out.push(rectShape(iL, iT, iR, yT));
  if (B)  out.push(rectShape(iL, yB, iR, iB));
  if (L)  out.push(rectShape(xL, iB, iL, iT));
  if (R)  out.push(rectShape(iR, iB, xR, iT));
  return out;
}

function rectShape(x0, y0, x1, y1) {
  const s = new THREE.Shape();
  s.moveTo(x0, y0); s.lineTo(x1, y0); s.lineTo(x1, y1); s.lineTo(x0, y1); s.closePath();
  return s;
}

// Extrude each shape by D into a mesh that protrudes in -Z (away
// from the wall in trim-local space), then add the fill mesh + a
// single EdgesGeometry stroke per shape.
function addExtrudedFrame(parent, shapes, D, mat, strokeMat) {
  const settings = { depth: D, bevelEnabled: false, steps: 1 };
  for (const shape of shapes) {
    const geom = new THREE.ExtrudeGeometry(shape, settings);
    // ExtrudeGeometry runs z=0 (back cap) → z=+D (front cap). The
    // wall surface is at local z=0 and the frame should protrude in
    // -Z, so translate so front cap sits at z=0 and back cap at z=-D.
    geom.translate(0, 0, -D);
    const mesh = new THREE.Mesh(geom, mat);
    parent.add(mesh);
    if (strokeMat) {
      const edges = new THREE.LineSegments(
        new THREE.EdgesGeometry(geom, 30),
        strokeMat,
      );
      parent.add(edges);
    }
  }
}

// ---- Batten mode ----
//
// ONE vertical strip on the wall surface, floor to top of wall. Like
// the "batten" in board-and-batten siding — a single board, not a
// boxed frame. No top/bottom/left/right toggles — `sides` is ignored
// in this mode. Width = thickness × 2 (visible board width); depth =
// trim depth (protrusion from wall).
function buildBatten(root, ctx) {
  const { s, r, col, tr } = ctx;
  const w = findWall(s, r, col);
  if (!w) return;
  const axis = wallAxis(w);
  // Auto side: pick the cardinal aligned to the wall's "facing" axis.
  // axis='row' walls run E-W → faces look N/S → default side='n'
  // axis='col' walls run N-S → faces look E/W → default side='w'
  const autoSide = (axis === 'row') ? 'n' : 'w';
  const side = tr.side;
  const sidesToRender = (side === 'both')
    ? [autoSide, oppositeSide(autoSide)]
    : [(side === 'auto') ? autoSide : side];

  for (const placeSide of sidesToRender) {
    placeOneBatten(root, ctx, placeSide);
  }
}

function placeOneBatten(root, ctx, side) {
  const { tr, r, col, cellSize } = ctx;
  const mat = chooseSurfaceMaterial(ctx.s, ctx.colorHex);
  const strokeMat = tr.stroke !== false
    ? new THREE.LineBasicMaterial({ color: ctx.strokeHex })
    : null;

  const cx = (col - 0.5) * cellSize;
  const cz = (r + 0.5) * cellSize;
  const anchor = sideAnchor(cx, cz, side, cellSize);
  const yRot = sideRotation(side);

  const T = tr.thickness ?? 0.06;
  const D = tr.depth     ?? 0.03;
  const battenW = T * 2;                              // visible board width
  const battenH = tr.totalHeight ?? WALL_HEIGHT_DEFAULT;
  const yBase   = tr.startHeight ?? 0;
  const yCentre = yBase + battenH / 2;

  const wrap = new THREE.Group();
  wrap.position.set(
    anchor.x + (tr.xOffset || 0) * Math.cos(yRot) + (tr.zOffset || 0) * Math.sin(yRot),
    yCentre + (tr.yOffset || 0),
    anchor.z - (tr.xOffset || 0) * Math.sin(yRot) + (tr.zOffset || 0) * Math.cos(yRot),
  );
  wrap.rotation.y = yRot;
  root.add(wrap);

  // Single strip — one box, centred at the wrap origin, protruding -Z.
  makeBoxPiece(wrap, battenW, battenH, D, 0, 0, -D / 2, mat, strokeMat);

  // Battens never cast shadows. Like window trim, the batten
  // protrudes ~3 cm out from the wall surface, so its shadow would
  // extend through the wall thickness and appear on the back face
  // as a phantom vertical-strip outline. Battens are decorative —
  // the wall behind them already throws the dominant shadow on the
  // ground. Skip cast at the mesh level.
  wrap.traverse((n) => { if (n.isMesh) n.userData.noCastShadow = true; });

  wrap.userData.trimId = tr.id;
}

// ---- Column mode ----
//
// Solid square box at the cell centre, floor to totalHeight. Side
// toggles map to 4 vertical faces (left=west, right=east, top=cap,
// bottom=cap). Phase A: render as a single BoxGeometry; toggles will
// be implemented as per-face when we have time. For now top/bottom
// toggle just enables/disables the box (so user can have a "no top
// cap" effect by extending box past totalHeight).
function buildColumn(root, ctx) {
  const { tr, r, col, cellSize } = ctx;
  const mat = chooseSurfaceMaterial(ctx.s, ctx.colorHex);
  const strokeMat = tr.stroke !== false
    ? new THREE.LineBasicMaterial({ color: ctx.strokeHex })
    : null;

  const size = tr.columnSize ?? 0.4;
  const h = tr.totalHeight ?? WALL_HEIGHT_DEFAULT;
  const yBase = tr.startHeight ?? 0;

  const cx = (col - 0.5) * cellSize + (tr.xOffset || 0);
  const cz = (r + 0.5) * cellSize + (tr.zOffset || 0);
  const cy = yBase + h / 2 + (tr.yOffset || 0);

  const wrap = new THREE.Group();
  wrap.position.set(cx, cy, cz);
  root.add(wrap);
  makeBoxPiece(wrap, size, h, size, 0, 0, 0, mat, strokeMat);
  wrap.userData.trimId = tr.id;
}

// ---- Collision AABBs ----
//
// Each trim emits a single AABB for the bounding box of its outermost
// piece. Hole-snap frames don't normally need collision (they sit on
// a wall that already collides), so emit only when collide flag.
// Phase A: simple bbox-of-everything per trim. Refinement later.
export function trimAABBs(s) {
  const aabbs = [];
  if (!s.trims?.length) return aabbs;
  // Build a scratch scene and re-use buildTrims, then compute world
  // bounding boxes from the result. Heavier than computing in-place
  // but mirrors the geometry exactly without code duplication.
  const scratch = new THREE.Group();
  buildTrims(scratch, s);
  scratch.traverse((obj) => {
    if (obj.isMesh && obj.userData.trimId !== undefined) {
      // Skip wrap groups; only meshes
    }
    if (obj.isMesh && obj.geometry) {
      obj.updateMatrixWorld(true);
      const cloned = obj.geometry.clone();
      cloned.applyMatrix4(obj.matrixWorld);
      cloned.computeBoundingBox();
      aabbs.push(cloned.boundingBox.clone());
      cloned.dispose();
    }
  });
  // Dispose all scratch meshes
  scratch.traverse((obj) => {
    if (obj.isMesh) obj.geometry?.dispose();
  });
  return aabbs;
}
