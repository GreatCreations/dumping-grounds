// engine/openings.js — doors + windows as parametric meshes.
//
// One entity type (s.openings[]) covers both. Each opening renders as:
//   - A 3D frame (4 box pieces forming a rectangular border, depth = thickness)
//   - N inner cells (panels for doors, panes for windows) arranged via the
//     odd-becomes-top-double-width grid rule:
//       1 = full         5 = top + 2×2
//       2 = 2 cols       6 = 2×3
//       3 = top + 2×1    7 = top + 2×3
//       4 = 2×2          8 = 2×4
//   - Divider strips between adjacent cells (paneSpacing wide).
//
// Positioning: anchor is (rowId, col, side). Opening's WIDTH lies along the
// wall, THICKNESS protrudes perpendicular to the wall. xOffset shifts along
// the wall direction; zOffset shifts perpendicular through the wall.
//
// Defaults: door panels = light grey, window panes = medium grey. Frame =
// inked-comic near-black. Color overrides via op.bodyColor + op.panelColor.

import * as THREE from 'three';
import * as BufferGeometryUtils from 'three/addons/utils/BufferGeometryUtils.js';
import { rowIdToIndex } from '../core/grid-addr.js';
import { chooseSurfaceMaterial } from './walls.js';

const DEFAULT_BODY_COLOR    = 0x0b0d14;   // near-black inked frame
const DEFAULT_PANEL_COLOR   = 0xd8d8d8;   // light grey door panel
// Cooler grey for window panes — neutral grey with the faintest hint
// of cool tint so it reads as "glass" against warm-toned walls. The
// vertex-gradient applied per pane provides the sheen / glare feel.
const DEFAULT_PANE_COLOR    = 0xc4c8d0;
const DEFAULT_FRAME_WIDTH   = 0.06;       // 6 cm — fallback if op.frameWidth absent

export function buildOpenings(root, s) {
  root.clear();
  if (!s.openings?.length) return;
  const cellSize = s.grid.cellSizeMeters;

  for (const op of s.openings) {
    const r = rowIdToIndex(op.rowId);
    if (r === null || op.col == null) continue;

    // Cell centre in world space, then walk to the requested cell-side.
    // Side determines BOTH position (which edge or cell centre) and
    // orientation (which way the opening's WIDTH axis runs).
    const cx = (op.col - 0.5) * cellSize;
    const cz = (r + 0.5) * cellSize;
    let x = cx, z = cz, yRot = 0;
    let centred = false;     // true → thickness grows symmetrically; false → inward only
    if (op.side === 'n')      { z = cz - cellSize / 2; yRot = 0; }
    else if (op.side === 's') { z = cz + cellSize / 2; yRot = Math.PI; }
    else if (op.side === 'w') { x = cx - cellSize / 2; yRot = Math.PI / 2; }
    else if (op.side === 'e') { x = cx + cellSize / 2; yRot = -Math.PI / 2; }
    // center-ew: opening's FACES look east + west (wall runs N-S);
    //            width runs along Z. yRot = π/2.
    // center-ns: opening's FACES look north + south (wall runs E-W);
    //            width runs along X. yRot = 0.
    else if (op.side === 'center-ew') { yRot = Math.PI / 2; centred = true; }
    else if (op.side === 'center-ns') { yRot = 0; centred = true; }

    const yBottom = op.yOffset ?? 0;
    const yTop    = yBottom + op.height;
    const yCentre = (yBottom + yTop) / 2;

    const inner = buildOpeningMesh(op, centred, s);
    // Three-level hierarchy:
    //   outer  ← positioned in world, rotated for side (yRot), holds id
    //     pivot ← hinge swing rotation (axis from op.swing)
    //       inner ← the actual frame/panels/knob/knocker contents
    // Always wrap in a pivot (even at openAngle=0) so the drag handler
    // can mutate `pivot.rotation` without disturbing the outer's side
    // rotation. Pivot also handles the offset math so the hinge
    // rotates around the correct edge.
    const pivot = makeHingePivot(inner, op);
    const group = new THREE.Group();
    group.add(pivot);
    group.position.set(x, yCentre, z);
    group.rotation.y = yRot;
    // xOffset + zOffset applied AFTER rotation. xOffset shifts along the
    // wall (local +X in the rotated frame). zOffset shifts through the
    // wall (local +Z).
    group.translateX(op.xOffset || 0);
    group.translateZ(op.zOffset || 0);
    group.userData.openingId = op.id;
    group.userData.hingePivot = pivot;
    root.add(group);
  }
}

// Vertical arrangement: cols-dominant. Odd N gets 3 cells in a middle
// row (L+C+R) with (N-3)/2 additional full-width rows above and
// (N-3)/2 below. Even N is a simple vertical stack of N rows. Mirrors
// the user's stated rule: "if there is an odd number it goes in the
// center with one on each side with additionals placed above and below".
function gridLayoutVertical(N, innerW, innerH, spacing) {
  N = Math.max(1, Math.min(8, N));
  if (N === 1) return [{ x: 0, y: 0, w: innerW, h: innerH }];

  const isOdd = (N % 2) === 1;
  if (!isOdd) {
    // Even N: stacked vertically (single column, N rows).
    const cellH = (innerH - spacing * (N - 1)) / N;
    const cells = [];
    for (let i = 0; i < N; i++) {
      const y = innerH / 2 - cellH / 2 - i * (cellH + spacing);
      cells.push({ x: 0, y, w: innerW, h: cellH });
    }
    return cells;
  }
  // Odd N ≥ 3: extras stack above + below the 3-column middle row.
  const extras = (N - 3) / 2;
  const totalRows = 1 + 2 * extras;
  const rowH = (innerH - spacing * (totalRows - 1)) / totalRows;
  const colW = (innerW - 2 * spacing) / 3;
  const cells = [];
  // Above (extras rows, full-width).
  for (let i = 0; i < extras; i++) {
    const y = innerH / 2 - rowH / 2 - i * (rowH + spacing);
    cells.push({ x: 0, y, w: innerW, h: rowH });
  }
  // Middle row: 3 columns (L, C, R).
  const middleY = innerH / 2 - rowH / 2 - extras * (rowH + spacing);
  cells.push({ x: -(colW + spacing), y: middleY, w: colW, h: rowH });
  cells.push({ x: 0,                  y: middleY, w: colW, h: rowH });
  cells.push({ x:  (colW + spacing),  y: middleY, w: colW, h: rowH });
  // Below (extras rows).
  for (let i = 0; i < extras; i++) {
    const y = middleY - (i + 1) * (rowH + spacing);
    cells.push({ x: 0, y, w: innerW, h: rowH });
  }
  return cells;
}

// Compute the grid layout for an opening: returns an array of cell
// rectangles {x, y, w, h} in opening-local space (centred at origin).
// Implements the odd-becomes-top-double-width rule the user spec'd.
function gridLayout(N, innerW, innerH, spacing) {
  N = Math.max(1, Math.min(8, N));
  const cells = [];

  // 1 = single full-width pane.
  if (N === 1) {
    cells.push({ x: 0, y: 0, w: innerW, h: innerH });
    return cells;
  }
  // 2 = 2 columns side-by-side, 1 row.
  if (N === 2) {
    const cellW = (innerW - spacing) / 2;
    cells.push({ x: -(cellW + spacing) / 2, y: 0, w: cellW, h: innerH });
    cells.push({ x:  (cellW + spacing) / 2, y: 0, w: cellW, h: innerH });
    return cells;
  }

  const isOdd = (N % 2) === 1;
  const restN = isOdd ? N - 1 : N;       // count of grid cells below the top row
  const rows  = restN / 2;                // 2 cols × `rows` rows in the bottom block
  const totalRows = rows + (isOdd ? 1 : 0);

  // Row height accounts for spacing strips between every row.
  const rowH = (innerH - spacing * (totalRows - 1)) / totalRows;
  const colW = (innerW - spacing) / 2;

  // Top double-wide row (odd counts only).
  if (isOdd) {
    const yTop = innerH / 2 - rowH / 2;
    cells.push({ x: 0, y: yTop, w: innerW, h: rowH });
  }

  // Grid below: 2 cols × `rows` rows.
  for (let r = 0; r < rows; r++) {
    // r=0 is the row right under the top (or the topmost row if even count).
    const rowIndexFromTop = (isOdd ? 1 : 0) + r;
    const yC = innerH / 2 - rowH / 2 - rowIndexFromTop * (rowH + spacing);
    cells.push({ x: -(colW + spacing) / 2, y: yC, w: colW, h: rowH });
    cells.push({ x:  (colW + spacing) / 2, y: yC, w: colW, h: rowH });
  }
  return cells;
}

// Build the local-space group for one opening, centred at (0, 0, 0).
// `centred` controls thickness direction:
//   false → outer face at local Z=0, thickness grows inward (+Z)
//   true  → centre of frame at local Z=0, thickness grows symmetrically
function buildOpeningMesh(op, centred, s) {
  const W = op.width;
  const H = op.height;
  const T = op.thickness ?? 0.04;
  const N = Math.max(1, Math.min(8, op.numDivisions || 2));
  const spacing = op.paneSpacing ?? 0.02;
  const isDoor = op.kind === 'door';

  // Resolve colors: explicit override wins; otherwise kind default.
  const bodyHex     = op.bodyColor  ?? DEFAULT_BODY_COLOR;
  let panelHex      = op.panelColor ?? (isDoor ? DEFAULT_PANEL_COLOR : DEFAULT_PANE_COLOR);

  // Opacity 0..100. null = kind default (window 55, door 100).
  let opacity100 = (typeof op.opacity === 'number') ? op.opacity
                                                    : (isDoor ? 100 : 55);
  opacity100 = Math.max(0, Math.min(100, opacity100));
  // Frosted = WARPED glass: wavy front-face displacement applied
  // per-pane below. Visual reads as "looking through textured /
  // rippled glass" — what's behind shows through, but along
  // wavy distortion lines. Doesn't override the user's colour or
  // opacity (they still control transparency); only modifies the
  // pane's surface geometry.
  const opacity = opacity100 / 100;

  const group = new THREE.Group();

  // ---- Frame (4 box pieces) ----
  // Anchor the FRONT face of every box at local Z = 0 (the wall plane).
  // Thickness extends INWARD into the cell (positive local Z is always
  // "into the cell" because of the side rotation applied by the caller).
  // So increasing thickness makes the opening deeper INTO the hole,
  // never pokes out of the wall face.
  // Frame (jambs + head + sill + the inner-frame divider between panes)
  // uses the lit-or-flat chooser so it responds to shadows/shading the
  // same way wall faces do. These pieces are always opaque — the
  // transparent pane mesh further down stays MeshBasicMaterial and
  // is explicitly excluded from shadow casting by the engine walker.
  const frameMat = chooseSurfaceMaterial(s, bodyHex);
  // Per-opening frame width with sane bounds: minimum 1cm so geometry
  // doesn't degenerate; max half of the smaller of width/height so
  // the inner area can't go negative.
  const FW = Math.max(0.01, Math.min(
    (op.frameWidth ?? DEFAULT_FRAME_WIDTH),
    Math.min(W, H) / 2 - 0.01,
  ));
  // Depth-centre of every box. Inward modes anchor the front face at
  // local Z=0 (centre at T/2); centred modes put the centre at Z=0
  // (extending equally to both sides of the wall plane).
  const zC = centred ? 0 : (T / 2);
  const top = new THREE.Mesh(new THREE.BoxGeometry(W, FW, T), frameMat);
  top.position.set(0, (H - FW) / 2, zC);
  group.add(top);
  const bot = new THREE.Mesh(new THREE.BoxGeometry(W, FW, T), frameMat);
  bot.position.set(0, -(H - FW) / 2, zC);
  group.add(bot);
  const innerH = H - 2 * FW;
  const left = new THREE.Mesh(new THREE.BoxGeometry(FW, innerH, T), frameMat);
  left.position.set(-(W - FW) / 2, 0, zC);
  group.add(left);
  const right = new THREE.Mesh(new THREE.BoxGeometry(FW, innerH, T), frameMat);
  right.position.set((W - FW) / 2, 0, zC);
  group.add(right);

  // ---- Inner cells (panels/panes) per arrangement ----
  // CELL_MARGIN: 2 mm inset on every edge of the cell-layout area.
  // Without this, the bottom/top/leftmost/rightmost cells touch the
  // inner-frame's outer boundary exactly. The shape triangulator
  // (earcut, called by ExtrudeGeometry) does not handle holes
  // coincident with the outer contour cleanly — the result is
  // malformed geometry at those edges (visible as glitches /
  // missing geometry / flicker on the bottom of doors). Insetting
  // the entire layout by a tiny amount leaves a 2 mm strip of
  // inner-frame all around so holes stay strictly inside the shape.
  const CELL_MARGIN = 0.002;
  const innerW = W - 2 * FW;
  const layoutW = Math.max(0.01, innerW - 2 * CELL_MARGIN);
  const layoutH = Math.max(0.01, innerH - 2 * CELL_MARGIN);
  const cells = (op.arrangement === 'vertical')
    ? gridLayoutVertical(N, layoutW, layoutH, spacing)
    : gridLayout(N, layoutW, layoutH, spacing);
  // Inner-frame with cell-shaped holes. The frame fills the spacing
  // gaps between cells with solid body colour (so dividers and the
  // area between panes is opaque), but each cell location is a hole
  // in the shape — translucent panes can still see through to
  // whatever is behind the opening. Uses ShapeGeometry with holes
  // to produce a flat triangle mesh that includes only the gap area.
  // Extruded a tiny bit along Z for thickness so it can't z-fight
  // with the panes sitting in front.
  if (N >= 1) {
    const shape = new THREE.Shape();
    shape.moveTo(-innerW / 2, -innerH / 2);
    shape.lineTo( innerW / 2, -innerH / 2);
    shape.lineTo( innerW / 2,  innerH / 2);
    shape.lineTo(-innerW / 2,  innerH / 2);
    shape.lineTo(-innerW / 2, -innerH / 2);
    for (const c of cells) {
      const hole = new THREE.Path();
      hole.moveTo(c.x - c.w / 2, c.y - c.h / 2);
      hole.lineTo(c.x + c.w / 2, c.y - c.h / 2);
      hole.lineTo(c.x + c.w / 2, c.y + c.h / 2);
      hole.lineTo(c.x - c.w / 2, c.y + c.h / 2);
      hole.lineTo(c.x - c.w / 2, c.y - c.h / 2);
      shape.holes.push(hole);
    }
    // Match the inner-frame's depth to the cells' depth and centre
    // them at the same z so the inner-frame and the cells form a
    // puzzle-piece fit. The cells slot exactly into the holes, and
    // from either viewing side the same arrangement is visible —
    // frame colour in spacing gaps, panel colour in cell positions.
    // Previously the inner-frame extruded behind the cells which
    // looked correct from the front but had the inner-frame mesh
    // occluding cell back faces when viewed from the door's back.
    const innerFrameDepth = T * 0.5;
    const innerFrameGeom = new THREE.ExtrudeGeometry(shape, {
      depth: innerFrameDepth,
      bevelEnabled: false,
    });
    const innerFrame = new THREE.Mesh(innerFrameGeom, frameMat);
    innerFrame.position.set(0, 0, zC - innerFrameDepth / 2);
    group.add(innerFrame);
  }

  // Translucent panes get a vertex gradient — top vertices brighter,
  // bottom slightly darker — so they read as glass with a soft sheen.
  // Solid panels skip the gradient (no need to fake glass on opaque
  // material). Implemented via vertex colors so we stay on
  // MeshBasicMaterial.
  const wantSheen = opacity < 1.0;
  const sheenTopMix = 0.18;
  const sheenBotMix = 0.08;
  for (const c of cells) {
    // Pane stays a plain 1×1×1 box. The frosted film is added as a
    // separate overlay of ripple tubes after the pane mesh below.
    const geom = new THREE.BoxGeometry(c.w, c.h, T * 0.5);
    if (wantSheen) {
      const baseColor = new THREE.Color(panelHex);
      const topColor  = baseColor.clone().lerp(new THREE.Color(0xffffff), sheenTopMix);
      const botColor  = baseColor.clone().lerp(new THREE.Color(0x000000), sheenBotMix);
      const pos = geom.attributes.position;
      const colors = new Float32Array(pos.count * 3);
      for (let i = 0; i < pos.count; i++) {
        const y = pos.getY(i);
        const t = THREE.MathUtils.clamp((y / c.h) + 0.5, 0, 1);
        const col = botColor.clone().lerp(topColor, t);
        colors[i * 3 + 0] = col.r;
        colors[i * 3 + 1] = col.g;
        colors[i * 3 + 2] = col.b;
      }
      geom.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    }
    const mat = new THREE.MeshBasicMaterial({
      color: wantSheen ? 0xffffff : panelHex,
      transparent: opacity < 1.0,
      opacity,
      vertexColors: wantSheen,
      // For transparent panes, don't write depth — otherwise the
      // pane's front face would occlude anything we want to show
      // INSIDE the pane (e.g., the frosted ripple film at zC).
      depthWrite: opacity >= 1.0,
    });
    const m = new THREE.Mesh(geom, mat);
    m.position.set(c.x, c.y, zC);
    group.add(m);

    // Frosted = many tiny worm-like curves scattered across the pane
    // in offset rows + columns (sand-ripple distribution). Each
    // curve is a SINGLE short wavy mark with random angle, color,
    // and opacity. None reach the pane edges. Layers of mixed greys
    // build up a "decorative frosted glass / rippled sand" texture.
    if (op.frosted) {
      // Centre the ripple film inside the pane (at zC, not in front).
      // Reads as "film embedded in the glass" — the pane's front
      // surface is in FRONT of the ripples, so looking through the
      // pane shows the ripples sandwiched within.
      const rippleZ = zC;
      // Greyscale palette — mid-to-light range. The top two slots
      // (previously e0e0e0 and ffffff) were too bright and washed
      // out against light backgrounds; pulled both down so the
      // palette stays cohesively grey rather than spiking to near-
      // white at the top end.
      const palette = [0x707070, 0x808080, 0x909090, 0xa0a0a0, 0xb0b0b0, 0xb8b8b8, 0xc8c8c8];
      // Very dense grid covering essentially the whole pane.
      // Rows spaced tightly so curve amplitudes spill into adjacent
      // rows = vertical overlap. Even rows shifted half-cell for the
      // sand-ripple offset pattern.
      const COLS = 50;
      const ROWS = 42;
      const innerW = c.w * 0.98;
      const innerH = c.h * 0.98;
      const cellW = innerW / COLS;
      const cellH = innerH / ROWS;
      // Actual semicircle arcs (not half-sine). Width = 2 × radius;
      // height = radius. Wider than a cell so adjacent curves
      // overlap. Tubes ~4× thicker than the previous pass for
      // visibly chunky strokes.
      const arcRadius = cellW * 1.0;
      const tubeRBase = Math.max(0.0008, cellW * 0.22);
      const tubeGeoms = [];     // collected per-tube geometries; merged below
      for (let row = 0; row < ROWS; row++) {
        for (let col = 0; col < COLS; col++) {
          if (Math.random() < 0.03) continue;
          const xOff = (row % 2 === 1) ? cellW * 0.5 : 0;
          const baseX = -innerW / 2 + (col + 0.5) * cellW + xOff;
          const baseY = -innerH / 2 + (row + 0.5) * cellH;
          if (Math.abs(baseX) > innerW / 2 - cellW * 0.1) continue;
          const jx = (Math.random() - 0.5) * cellW * 0.3;
          const jy = (Math.random() - 0.5) * cellH * 0.3;
          const cx = baseX + jx;
          const cy = baseY + jy;
          const rotAngle = Math.random() * Math.PI * 2;
          const N_PTS = 14;
          const points = [];
          for (let i = 0; i <= N_PTS; i++) {
            const t = i / N_PTS;
            const theta = Math.PI - t * Math.PI;
            const lx = Math.cos(theta) * arcRadius;
            const ly = Math.sin(theta) * arcRadius;
            const rx = lx * Math.cos(rotAngle) - ly * Math.sin(rotAngle);
            const ry = lx * Math.sin(rotAngle) + ly * Math.cos(rotAngle);
            points.push(new THREE.Vector3(cx + rx, cy + ry, 0));
          }
          const curve   = new THREE.CatmullRomCurve3(points);
          const tubeR   = tubeRBase * (0.6 + Math.random() * 0.6);
          const tubeGeom = new THREE.TubeGeometry(curve, 20, tubeR, 4, false);
          // Per-vertex colour bakes the random palette pick into the
          // geometry. Mid-grey opacity baked in: simulate per-ripple
          // opacity by mixing the colour toward mid-grey (#a8a8a8).
          // 100% opaque ripple at colour C → C. Less opaque → mixed
          // toward mid-grey. After merging, one material with one
          // opacity renders all ripples in deterministic order.
          const colorHex = palette[Math.floor(Math.random() * palette.length)];
          const opVal   = 0.55 + Math.random() * 0.35;
          const baseCol = new THREE.Color(colorHex);
          const blendCol = baseCol.clone().lerp(new THREE.Color(0xa8a8a8), 1 - opVal);
          const vCount = tubeGeom.attributes.position.count;
          const colors = new Float32Array(vCount * 3);
          for (let v = 0; v < vCount; v++) {
            colors[v * 3 + 0] = blendCol.r;
            colors[v * 3 + 1] = blendCol.g;
            colors[v * 3 + 2] = blendCol.b;
          }
          tubeGeom.setAttribute('color', new THREE.BufferAttribute(colors, 3));
          tubeGeoms.push(tubeGeom);
        }
      }
      if (tubeGeoms.length) {
        // ONE merged mesh per pane — no per-ripple sort artefacts,
        // one draw call per pane (was ~2000 draw calls before).
        const merged = BufferGeometryUtils.mergeGeometries(tubeGeoms, false);
        if (merged) {
          const rippleMesh = new THREE.Mesh(
            merged,
            new THREE.MeshBasicMaterial({
              vertexColors: true,
              transparent: true,
              opacity: 0.75,
              depthWrite: false,
            }),
          );
          rippleMesh.position.set(c.x, c.y, rippleZ);
          // CRITICAL: force the ripples to render AFTER the pane.
          // Both meshes share the same world position, so Three.js's
          // depth-based transparent sort is a coin-flip — pane
          // sometimes drew on top, hiding the ripples (the "only at
          // certain angles" symptom). renderOrder = 1 overrides the
          // sort and guarantees ripples always layer over the pane.
          rippleMesh.renderOrder = 1;
          group.add(rippleMesh);
        }
        for (const g of tubeGeoms) g.dispose();
      }
    }
  }

  // ---- Knob (door handle) ----
  // A small sphere protruding from the FRONT face (local Z = 0 for
  // inward-extending openings, or local Z = -T/2 for centred ones).
  // Knob sits IN FRONT of the front face by ~knobR so it reads as a
  // protruding handle, not a recessed dimple.
  // Helper: add a silhouette stroke around `mesh` to `group`. Uses
  // EdgesGeometry with a high angle threshold (60°) so only the
  // outline / sharp creases emit — cylinder/torus subdivisions stay
  // off, giving a clean inked-comic outline rather than a wireframe.
  function addStroke(mesh, strokeColor) {
    const strokeMat = new THREE.LineBasicMaterial({ color: strokeColor });
    const edges = new THREE.LineSegments(
      new THREE.EdgesGeometry(mesh.geometry, 60),
      strokeMat,
    );
    edges.position.copy(mesh.position);
    edges.rotation.copy(mesh.rotation);
    edges.scale.copy(mesh.scale);
    group.add(edges);
  }
  // Helper: silhouette outline SHELL for smooth shapes (torus, sphere)
  // where EdgesGeometry doesn't help. Renders a slightly-larger copy
  // with BackSide so only the silhouette pokes out around the
  // colored mesh — classic outlining trick. `scale` controls how
  // far the shell sticks past the original silhouette.
  function addSilhouetteShell(mesh, strokeColor, scale = 1.12) {
    const outlineMat = new THREE.MeshBasicMaterial({
      color: strokeColor,
      side: THREE.BackSide,
    });
    const outline = new THREE.Mesh(mesh.geometry, outlineMat);
    outline.position.copy(mesh.position);
    outline.rotation.copy(mesh.rotation);
    outline.scale.copy(mesh.scale).multiplyScalar(scale);
    outline.renderOrder = (mesh.renderOrder || 0) - 1;
    group.add(outline);
  }

  if (op.knob?.enabled) {
    const knobR = Math.max(0.01, op.knob.size ?? 0.04);
    const knobColor = op.knob.color ?? 0xffffff;   // default white
    const knobMat = new THREE.MeshBasicMaterial({ color: knobColor });
    // Base x-position: centred on the FRAME STILE (the outer frame's
    // vertical side member). For a 0.9 m door with 0.2 m frame, the
    // stile centre is at ±0.35 m — the knob sits ON the frame, not
    // floating in the panel area. xOffset adjusts from this base
    // position. Positive xOffset pushes toward the outer edge,
    // negative pulls toward the door centre.
    const xEdge = W / 2 - FW / 2;
    let baseX = 0;
    if (op.knob.side === 'left')         baseX = -xEdge;
    else if (op.knob.side === 'right')   baseX =  xEdge;
    else if (op.knob.side === 'center')  baseX =  0;
    else {
      // 'auto': place opposite the swing hinge. For non-auto sides,
      // user explicitly chose the side. xOffset is direction-aware:
      // positive shifts TOWARD the frame edge (away from center),
      // negative shifts TOWARD center. So we flip the sign for left.
      baseX = (op.swing === 'right') ? -xEdge : xEdge;
    }
    const knobOff = op.knob.xOffset ?? 0;
    const knobX = baseX + (baseX < 0 ? -knobOff : knobOff);
    // Y offset = vertical shift from the door's vertical CENTRE.
    // 0 (default) places the knob exactly at the centre regardless of
    // door height. Positive lifts it up, negative drops it down.
    const knobY = (op.knob.yOffset ?? 0);
    const frontZ = zC - T / 2;
    const knobType = op.knob.type || 'sphere';
    const sideSign = baseX < 0 ? -1 : 1;   // for lever direction on panel type
    const knobStroke = op.knob.stroke !== false;
    const knobStrokeColor = op.knob.strokeColor ?? 0x0b0d14;

    // Helper to add a knob sub-mesh + (optional) stroke around it.
    const knobAdd = (mesh) => {
      group.add(mesh);
      if (knobStroke) addStroke(mesh, knobStrokeColor);
    };

    if (knobType === 'u-handle') {
      const handleH    = knobR * 8;
      const protrude   = knobR * 1.4;
      const barR       = knobR * 0.35;
      const halfH      = handleH / 2;
      const mountGeom  = new THREE.CylinderGeometry(barR, barR, protrude, 10);
      // Mounts get NO stroke — their circle-end rims would draw as
      // full circles facing the camera, which reads as noisy "donut"
      // outlines on what should be subtle perpendicular pegs.
      const mountTop   = new THREE.Mesh(mountGeom, knobMat);
      mountTop.rotation.x = Math.PI / 2;
      mountTop.position.set(knobX, knobY + halfH - barR, frontZ - protrude / 2);
      group.add(mountTop);   // no knobAdd → no stroke
      const mountBot   = new THREE.Mesh(mountGeom, knobMat);
      mountBot.rotation.x = Math.PI / 2;
      mountBot.position.set(knobX, knobY - halfH + barR, frontZ - protrude / 2);
      group.add(mountBot);
      // The bar gets stroke as normal — its circle ends are hidden
      // inside the mounts, so the bar's outline reads as a clean
      // vertical line silhouette.
      const bar = new THREE.Mesh(
        new THREE.CylinderGeometry(barR, barR, handleH - barR * 2, 10),
        knobMat,
      );
      bar.position.set(knobX, knobY, frontZ - protrude + barR);
      knobAdd(bar);
    } else if (knobType === 'panel') {
      const plateW = knobR * 3;
      const plateH = knobR * 4;
      const plateT = knobR * 0.15;
      const plate = new THREE.Mesh(
        new THREE.BoxGeometry(plateW, plateH, plateT),
        knobMat,
      );
      plate.position.set(knobX, knobY, frontZ - plateT / 2);
      knobAdd(plate);
      const leverL = knobR * 2.5;
      const leverR = knobR * 0.22;
      const lever = new THREE.Mesh(
        new THREE.CylinderGeometry(leverR, leverR, leverL, 8),
        knobMat,
      );
      lever.rotation.z = Math.PI / 2;
      lever.position.set(knobX - sideSign * leverL / 2, knobY, frontZ - plateT - leverR);
      knobAdd(lever);
      const cap = new THREE.Mesh(
        new THREE.SphereGeometry(leverR * 1.2, 10, 8),
        knobMat,
      );
      cap.position.set(knobX - sideSign * leverL, knobY, frontZ - plateT - leverR);
      knobAdd(cap);
    } else if (knobType === 'keypad') {
      // Passcode keypad: a flat backing box on the door face with a
      // 3-column × 4-row grid of recessed button cubes. Numbers
      // aren't painted on (no procedural text in MeshBasicMaterial);
      // visual reads as "10-key entry pad" by the grid alone.
      const padW = knobR * 3.5;
      const padH = knobR * 5;
      const padT = knobR * 0.25;
      const padBack = new THREE.Mesh(
        new THREE.BoxGeometry(padW, padH, padT),
        knobMat,
      );
      padBack.position.set(knobX, knobY, frontZ - padT / 2);
      knobAdd(padBack);
      // 3×4 grid of buttons (12 keys: 0-9 + 2 special). Each button is
      // a tiny cube protruding from the front of the back panel.
      const COLS = 3, ROWS = 4;
      const btnGap = knobR * 0.15;
      const btnW = (padW - btnGap * (COLS + 1)) / COLS;
      const btnH = (padH - btnGap * (ROWS + 1)) / ROWS;
      const btnT = knobR * 0.15;
      const btnGeom = new THREE.BoxGeometry(btnW * 0.85, btnH * 0.85, btnT);
      for (let row = 0; row < ROWS; row++) {
        for (let col = 0; col < COLS; col++) {
          const bx = knobX - padW / 2 + btnGap + btnW * (col + 0.5) + btnGap * col;
          const by = knobY + padH / 2 - btnGap - btnH * (row + 0.5) - btnGap * row;
          const btn = new THREE.Mesh(btnGeom, knobMat);
          btn.position.set(bx, by, frontZ - padT - btnT / 2);
          knobAdd(btn);
        }
      }
    } else {
      // Default 'sphere' type — classic round doorknob with shank.
      // Slightly SMALLER ball than `knobR` (0.85× scale) and further
      // OUT from the door so it reads as a proper protruding knob
      // rather than a half-embedded bead. Shank lengthens to span
      // the wider gap between door face and ball.
      const ballR = knobR * 0.85;
      const ballZ = frontZ - knobR * 1.1;
      const knob = new THREE.Mesh(new THREE.SphereGeometry(ballR, 14, 10), knobMat);
      knob.position.set(knobX, knobY, ballZ);
      knobAdd(knob);
      const shankLen = knobR * 0.9;
      const shank = new THREE.Mesh(
        new THREE.CylinderGeometry(knobR * 0.32, knobR * 0.32, shankLen, 8),
        knobMat,
      );
      shank.rotation.x = Math.PI / 2;
      // Sits between door face (frontZ) and ball back (ballZ + ballR).
      shank.position.set(knobX, knobY, frontZ - shankLen / 2);
      knobAdd(shank);
    }
  }

  // ---- Knocker (ring + backing plate on door face) ----
  if (op.knocker?.enabled) {
    const knkR = Math.max(0.015, op.knocker.size ?? 0.06);
    const knkColor = op.knocker.color ?? 0x6a6a6a;  // default cast-iron grey
    const knkMat = new THREE.MeshBasicMaterial({ color: knkColor });
    const knkY = -H / 2 + (op.knocker.yOffset ?? 1.6);
    const frontZ = zC - T / 2;
    const knkType = op.knocker.type || 'classic';
    const knkStroke = op.knocker.stroke !== false;
    const knkStrokeColor = op.knocker.strokeColor ?? 0x0b0d14;
    const knkAdd = (mesh) => {
      group.add(mesh);
      if (knkStroke) addStroke(mesh, knkStrokeColor);
    };

    if (knkType === 'wreath') {
      // Chunky decorative torus, no backing plate.
      const wreathR    = knkR * 1.0;
      const tubeR      = knkR * 0.18;
      const wreath = new THREE.Mesh(
        new THREE.TorusGeometry(wreathR, tubeR, 10, 24),
        knkMat,
      );
      wreath.position.set(0, knkY, frontZ - tubeR);
      group.add(wreath);
      if (knkStroke) {
        // Flat annulus outlines, drawn slightly in FRONT of the
        // wreath's centre plane (camera-closer = smaller Z). Two
        // rings give BOTH inner and outer outlines without sharing
        // volume with the wreath (no z-fight, no "all stroke" failure
        // mode). Annulus thickness scales with knocker size with a
        // 3 mm floor so it's always visible.
        const strokeThick = Math.max(0.003, knkR * 0.015);
        const outlineMat = new THREE.MeshBasicMaterial({
          color: knkStrokeColor,
          side: THREE.DoubleSide,
        });
        const outlineZ = wreath.position.z - 0.0008;
        // Outer outline
        const outer = new THREE.Mesh(
          new THREE.RingGeometry(
            wreathR + tubeR - strokeThick / 2,
            wreathR + tubeR + strokeThick / 2,
            32,
          ),
          outlineMat,
        );
        outer.position.set(wreath.position.x, wreath.position.y, outlineZ);
        group.add(outer);
        // Inner outline
        const inner = new THREE.Mesh(
          new THREE.RingGeometry(
            wreathR - tubeR - strokeThick / 2,
            wreathR - tubeR + strokeThick / 2,
            32,
          ),
          outlineMat,
        );
        inner.position.set(wreath.position.x, wreath.position.y, outlineZ);
        group.add(inner);
      }
    } else if (knkType === 'gargoyle') {
      // Gargoyle face: UPSIDE-DOWN TEARDROP head (wide rounded top,
      // tapering to a point at the chin), with a PIG-NOSE snout
      // (flat disc with two nostril holes), ears, brow ridge, and
      // nose ring through the snout.
      const headR = knkR * 0.95;

      // Build the head as a SphereGeometry whose lower vertices are
      // pulled inward toward the Y axis, tapering the bottom into a
      // point while leaving the top round. Flattened along Z so it
      // sits against the door rather than ballooning forward.
      const headGeom = new THREE.SphereGeometry(headR, 18, 14);
      const pos = headGeom.attributes.position;
      for (let i = 0; i < pos.count; i++) {
        const y = pos.getY(i);
        // ratio = 0 at sphere bottom, 1 at top
        const ratio = (y + headR) / (2 * headR);
        // Squeeze: bottom 60% tapers (exponential curve); top stays full
        let squeeze;
        if (ratio < 0.6) {
          squeeze = Math.pow(ratio / 0.6, 1.4) * 0.85 + 0.12;
        } else {
          squeeze = 1.0;
        }
        pos.setX(i, pos.getX(i) * squeeze);
        pos.setZ(i, pos.getZ(i) * squeeze * 0.7);   // flatten along Z too
      }
      pos.needsUpdate = true;
      headGeom.computeVertexNormals();
      const head = new THREE.Mesh(headGeom, knkMat);
      head.position.set(0, knkY, frontZ - headR * 0.5);
      knkAdd(head);

      // Pointed ears at the head's wide top, splayed outward.
      const earH = headR * 0.5;
      const earR = headR * 0.18;
      const earGeom = new THREE.ConeGeometry(earR, earH, 6);
      const earL = new THREE.Mesh(earGeom, knkMat);
      earL.position.set(-headR * 0.7, knkY + headR * 0.95, frontZ - headR * 0.5);
      earL.rotation.z = -0.3;
      knkAdd(earL);
      const earRight = new THREE.Mesh(earGeom, knkMat);
      earRight.position.set(headR * 0.7, knkY + headR * 0.95, frontZ - headR * 0.5);
      earRight.rotation.z = 0.3;
      knkAdd(earRight);

      // (Removed legacy brow-ridge box — eyebrows below carry the
      // glare expression now, so the rectangular ridge isn't needed.)

      // Eyes — round 2D circles (flattened spheres) in dark inked
      // colour. Separate EYEBROWS above each eye carry the "evil"
      // expression via their inward-pointing tilt, leaving the eyes
      // themselves as clean round shapes.
      // The head is flattened along Z by ×0.7 — its front surface at
      // eye height sits at ~frontZ - headR*1.17. Eyes need to be
      // BEYOND that toward the camera (smaller Z) to be visible.
      // Evil squinty eyes — narrow horizontal almonds (wide X, very
      // flat Y). Inner corner DOWN, outer corner UP gives the classic
      // angry-glare slant. Positioned just in front of the head
      // surface (not floating far out), at the wider apart X
      // spacing the user prefers.
      const eyeR_size = knkR * 0.11;
      const eyeMat = new THREE.MeshBasicMaterial({ color: 0x0b0d14 });
      const eyeOffsetX = headR * 0.34;
      const eyeY = knkY + headR * 0.26;
      // Head front surface at eye Y sits at ~frontZ - headR * 1.17.
      // Eyes sit just 1 mm forward of that — hugs the head, no hover.
      const eyeZ = frontZ - headR * 1.18;
      const eyeL = new THREE.Mesh(new THREE.SphereGeometry(eyeR_size, 12, 8), eyeMat);
      eyeL.position.set(-eyeOffsetX, eyeY, eyeZ);
      eyeL.scale.set(1.7, 0.4, 0.3);
      eyeL.rotation.z = -0.45;
      knkAdd(eyeL);
      const eyeRight = new THREE.Mesh(new THREE.SphereGeometry(eyeR_size, 12, 8), eyeMat);
      eyeRight.position.set(eyeOffsetX, eyeY, eyeZ);
      eyeRight.scale.set(1.7, 0.4, 0.3);
      eyeRight.rotation.z = 0.45;
      knkAdd(eyeRight);

      // Eyebrows — angled bars above each eye. Hug the head too —
      // only 1.5 mm forward of eyes so they don't hover.
      const browW_b = knkR * 0.45;
      const browH_b = knkR * 0.08;
      const browD_b = knkR * 0.05;
      const browY = eyeY + headR * 0.22;
      const browZ = eyeZ - knkR * 0.015;
      const browGeomB = new THREE.BoxGeometry(browW_b, browH_b, browD_b);
      const browL_b = new THREE.Mesh(browGeomB, knkMat);
      browL_b.position.set(-eyeOffsetX, browY, browZ);
      browL_b.rotation.z = -0.4;
      knkAdd(browL_b);
      const browR_b = new THREE.Mesh(browGeomB, knkMat);
      browR_b.position.set(eyeOffsetX, browY, browZ);
      browR_b.rotation.z = 0.4;
      knkAdd(browR_b);

      // PIG-NOSE SNOUT: a SQUISHED OVAL (wider than tall) when
      // viewed from the front. Built from a base cylinder, then
      // scaled non-uniformly: X stretched (wider), Z compressed
      // (shorter in world Y after the rotation), Y unchanged
      // (depth preserved). The mesh's local axes after the X
      // rotation map as: scale.x → world X (horizontal),
      // scale.y → world Z (depth), scale.z → world Y (height).
      const snoutFrontR = headR * 0.28;
      const snoutBackR  = headR * 0.33;
      const snoutD      = headR * 0.18;
      const snoutGeom = new THREE.CylinderGeometry(snoutFrontR, snoutBackR, snoutD, 16);
      const snout = new THREE.Mesh(snoutGeom, knkMat);
      snout.rotation.x = Math.PI / 2;
      snout.scale.set(1.25, 1, 0.65);   // moderate widen, slight flatten
      snout.position.set(0, knkY - headR * 0.1, frontZ - headR * 1.05);
      knkAdd(snout);

      // Nostrils — two small dark vertical-oval discs on the front
      // face of the snout. Implemented as small flattened spheres.
      const nostrilR = knkR * 0.08;
      const nostrilMat = new THREE.MeshBasicMaterial({ color: 0x0b0d14 });
      const nostrilOffsetX = snoutFrontR * 0.45;
      const nostrilZ = frontZ - headR * 1.18;
      const nostrilL = new THREE.Mesh(
        new THREE.SphereGeometry(nostrilR, 8, 6),
        nostrilMat,
      );
      nostrilL.scale.set(0.6, 1.2, 0.6);   // vertical oval like a pig's nostril
      nostrilL.position.set(-nostrilOffsetX, knkY - headR * 0.1, nostrilZ);
      knkAdd(nostrilL);
      const nostrilRight = new THREE.Mesh(
        new THREE.SphereGeometry(nostrilR, 8, 6),
        nostrilMat,
      );
      nostrilRight.scale.set(0.6, 1.2, 0.6);
      nostrilRight.position.set(nostrilOffsetX, knkY - headR * 0.1, nostrilZ);
      knkAdd(nostrilRight);

      // Nose ring — 3D hoop hung below the nostril plane.
      const nrR = headR * 0.2;
      const nrTubeR = knkR * 0.04;
      const noseRing = new THREE.Mesh(
        new THREE.TorusGeometry(nrR, nrTubeR, 8, 20),
        knkMat,
      );
      const nrPos = new THREE.Vector3(0, knkY - headR * 0.35, frontZ - headR * 1.22);
      noseRing.position.copy(nrPos);
      group.add(noseRing);
      if (knkStroke) {
        // Stroke thickness sized RELATIVE to the nose-ring's tube,
        // not to knkR. The flat 3 mm floor used for the wreath
        // (which has a thick tube) would be larger than this small
        // ring's tube itself — way too thick. Scale stroke to 35%
        // of the tube radius with a 0.8 mm floor.
        const strokeThick = Math.max(0.0008, nrTubeR * 0.35);
        const outlineMat = new THREE.MeshBasicMaterial({
          color: knkStrokeColor,
          side: THREE.DoubleSide,
        });
        const outlineZ = nrPos.z - 0.0008;
        const outer = new THREE.Mesh(
          new THREE.RingGeometry(
            nrR + nrTubeR - strokeThick / 2,
            nrR + nrTubeR + strokeThick / 2,
            28,
          ),
          outlineMat,
        );
        outer.position.set(nrPos.x, nrPos.y, outlineZ);
        group.add(outer);
        const inner = new THREE.Mesh(
          new THREE.RingGeometry(
            nrR - nrTubeR - strokeThick / 2,
            nrR - nrTubeR + strokeThick / 2,
            28,
          ),
          outlineMat,
        );
        inner.position.set(nrPos.x, nrPos.y, outlineZ);
        group.add(inner);
      }
    } else if (knkType === 'bell') {
      // Hanging bell — truncated cone (narrower at top, wider at
      // bottom). Bell hangs from an L-shaped HOOK that mounts to
      // the door, extends forward, and drops vertically with its
      // bottom touching the bell's top. Reads as "bell hung off a
      // door hook" rather than a freely floating bell.
      const bellH    = knkR * 1.4;
      const bellTopR = knkR * 0.45;
      const bellBotR = knkR * 0.95;
      // Hook geometry: forward arm comes out of door, vertical drop
      // extends down. Layout planned around the bell's top position.
      const hookThick = knkR * 0.05;
      const hookArmLen  = knkR * 0.5;       // forward extension from door
      const hookDropLen = knkR * 0.4;       // vertical drop to bell top
      // Y position of where the hook attaches to the door (top of hook).
      const hookMountY = knkY + bellH * 0.35;
      // Where the vertical drop ends — this is the bell top point.
      const bellTopY = hookMountY - hookDropLen;
      // Bell sits with its top exactly at bellTopY (so the hook's
      // lower end visually rests on / passes into the bell's top).
      const bellMidY = bellTopY - bellH / 2;
      const bellZ    = frontZ - hookArmLen;

      // Bell body
      const bell = new THREE.Mesh(
        new THREE.CylinderGeometry(bellTopR, bellBotR, bellH, 16, 1, false),
        knkMat,
      );
      bell.position.set(0, bellMidY, bellZ);
      knkAdd(bell);

      // Hook horizontal arm — cylinder from door face going forward.
      const hookArm = new THREE.Mesh(
        new THREE.CylinderGeometry(hookThick, hookThick, hookArmLen, 8),
        knkMat,
      );
      hookArm.rotation.x = Math.PI / 2;
      hookArm.position.set(0, hookMountY, frontZ - hookArmLen / 2);
      knkAdd(hookArm);

      // Hook vertical drop — cylinder from end of arm down to bell top.
      const hookDrop = new THREE.Mesh(
        new THREE.CylinderGeometry(hookThick, hookThick, hookDropLen, 8),
        knkMat,
      );
      hookDrop.position.set(0, hookMountY - hookDropLen / 2, bellZ);
      knkAdd(hookDrop);

      // Small clapper inside / under the bell — tiny sphere visible
      // at the bell's lower rim.
      const clapper = new THREE.Mesh(
        new THREE.SphereGeometry(knkR * 0.14, 8, 6),
        knkMat,
      );
      clapper.position.set(0, bellMidY - bellH * 0.55, bellZ);
      knkAdd(clapper);
    } else {
      // Default 'classic' — backing plate + hanging ring.
      const plate = new THREE.Mesh(
        new THREE.CylinderGeometry(knkR, knkR, 0.012, 16),
        knkMat,
      );
      plate.rotation.x = Math.PI / 2;
      plate.position.set(0, knkY, frontZ - 0.006);
      knkAdd(plate);   // plate is a cylinder with caps → EdgesGeometry works
      // Ring: protrudes ~0.5*knkR from the plate so it reads as a
      // hanging ring rather than flat-mounted.
      const ringR     = knkR * 0.65;
      const ringTubeR = knkR * 0.12;
      const ring = new THREE.Mesh(
        new THREE.TorusGeometry(ringR, ringTubeR, 8, 16),
        knkMat,
      );
      ring.position.set(0, knkY - knkR * 0.55, frontZ - knkR * 0.5);
      group.add(ring);
      if (knkStroke) {
        // Same flat-annulus outline pattern as the wreath — gives
        // both inner and outer outlines without z-fighting.
        const strokeThick = Math.max(0.003, knkR * 0.015);
        const outlineMat = new THREE.MeshBasicMaterial({
          color: knkStrokeColor,
          side: THREE.DoubleSide,
        });
        const outlineZ = ring.position.z - 0.0008;
        const outer = new THREE.Mesh(
          new THREE.RingGeometry(
            ringR + ringTubeR - strokeThick / 2,
            ringR + ringTubeR + strokeThick / 2,
            32,
          ),
          outlineMat,
        );
        outer.position.set(ring.position.x, ring.position.y, outlineZ);
        group.add(outer);
        const inner = new THREE.Mesh(
          new THREE.RingGeometry(
            ringR - ringTubeR - strokeThick / 2,
            ringR - ringTubeR + strokeThick / 2,
            32,
          ),
          outlineMat,
        );
        inner.position.set(ring.position.x, ring.position.y, outlineZ);
        group.add(inner);
      }
    }
  }

  return group;
}

// Build a hinge pivot wrapper around the opening's contents. ALWAYS
// returns a pivot Group, even when openAngle = 0, so the hierarchy is
// consistent regardless of the current angle — the drag handler in
// engine.js can always find and mutate the pivot's rotation.
//
// Pivot point depends on `swing`: left/right hinge around a vertical
// axis at that edge; top/bottom hinge around a horizontal axis at
// that edge. Contents shift so the hinge edge sits at the pivot's
// origin; the pivot itself offsets back so world position at
// openAngle=0 is identical to a no-hinge build.
function makeHingePivot(contentGroup, op) {
  const angleRad = (op.openAngle || 0) * Math.PI / 180;
  const W = op.width;
  const H = op.height;
  const pivot = new THREE.Group();
  let dx = 0, dy = 0;
  switch (op.swing || 'left') {
    case 'right':  dx =  W / 2; break;
    case 'top':    dy =  H / 2; break;
    case 'bottom': dy = -H / 2; break;
    case 'left':
    default:       dx = -W / 2; break;
  }
  contentGroup.position.set(-dx, -dy, 0);
  pivot.add(contentGroup);
  pivot.position.set(dx, dy, 0);
  const swing = op.swing || 'left';
  // swingReverse: flip rotation direction on the swing axis. e.g.,
  // a left-hinged door normally rotates -Y (swings one way); reversed
  // it rotates +Y (swings the other way).
  const sign = op.swingReverse ? -1 : 1;
  if (swing === 'left')        pivot.rotation.y = sign * -angleRad;
  else if (swing === 'right')  pivot.rotation.y = sign *  angleRad;
  else if (swing === 'top')    pivot.rotation.x = sign *  angleRad;
  else if (swing === 'bottom') pivot.rotation.x = sign * -angleRad;
  return pivot;
}

// Frame-only collision AABBs. Each opening emits up to 4 axis-aligned
// world bounding boxes — one per frame piece (top rail, bottom rail,
// left stile, right stile). The interior hole (where panels sit)
// stays walk-through.
//
// Gated by `op.collide`: when false, no AABBs emitted (opening is
// purely cosmetic, e.g., a doorway that the level designer doesn't
// want to physically block). When true (default), the frame blocks.
//
// Frame pieces are computed at the door's CURRENT pose — closed,
// swung partially open, or fully open. We mirror the exact group
// hierarchy buildOpenings uses (outer for side rotation, pivot for
// hinge rotation) so the AABBs land where the rendered frame is.
// Note: a rotated box's axis-aligned bounding box is slightly larger
// than the box itself; at 45° open a frame piece's AABB is ~1.4× the
// piece's dimensions. Acceptable for collision (frame still blocks
// where it should, walk-through gaps still walk-through).
export function openingAABBs(s) {
  const aabbs = [];
  if (!s.openings?.length) return aabbs;
  const cellSize = s.grid.cellSizeMeters;
  // Scratch hierarchy: outer (world position + side rotation +
  // x/zOffset) → pivot (hinge edge position + swing angle).
  const tmpOuter = new THREE.Group();
  const tmpPivot = new THREE.Group();
  tmpOuter.add(tmpPivot);

  for (const op of s.openings) {
    if (op.collide === false) continue;

    const r = rowIdToIndex(op.rowId);
    if (r === null || op.col == null) continue;

    // Mirror the placement logic from buildOpenings.
    const cx = (op.col - 0.5) * cellSize;
    const cz = (r + 0.5) * cellSize;
    let x = cx, z = cz, yRot = 0;
    let centred = false;
    if (op.side === 'n')      { z = cz - cellSize / 2; yRot = 0; }
    else if (op.side === 's') { z = cz + cellSize / 2; yRot = Math.PI; }
    else if (op.side === 'w') { x = cx - cellSize / 2; yRot = Math.PI / 2; }
    else if (op.side === 'e') { x = cx + cellSize / 2; yRot = -Math.PI / 2; }
    else if (op.side === 'center-ew') { yRot = Math.PI / 2; centred = true; }
    else if (op.side === 'center-ns') { yRot = 0; centred = true; }

    const yBottom = op.yOffset ?? 0;
    const yCentre = yBottom + op.height / 2;

    const W = op.width;
    const H = op.height;
    const T = op.thickness ?? 0.04;
    const FW = Math.max(0.01, Math.min(
      op.frameWidth ?? 0.06,
      Math.min(W, H) / 2 - 0.01,
    ));
    const zC = centred ? 0 : (T / 2);

    // Outer: position + side rotation + offsets.
    tmpOuter.position.set(x, yCentre, z);
    tmpOuter.rotation.set(0, yRot, 0);
    tmpOuter.scale.set(1, 1, 1);
    tmpOuter.translateX(op.xOffset || 0);
    tmpOuter.translateZ(op.zOffset || 0);

    // Pivot: hinge edge position + hinge rotation.
    let dx = 0, dy = 0;
    switch (op.swing || 'left') {
      case 'right':  dx =  W / 2; break;
      case 'top':    dy =  H / 2; break;
      case 'bottom': dy = -H / 2; break;
      case 'left':
      default:       dx = -W / 2; break;
    }
    tmpPivot.position.set(dx, dy, 0);
    const angleRad = (op.openAngle || 0) * Math.PI / 180;
    const swingSign = op.swingReverse ? -1 : 1;
    tmpPivot.rotation.set(0, 0, 0);
    if      (op.swing === 'left')   tmpPivot.rotation.y = swingSign * -angleRad;
    else if (op.swing === 'right')  tmpPivot.rotation.y = swingSign *  angleRad;
    else if (op.swing === 'top')    tmpPivot.rotation.x = swingSign *  angleRad;
    else if (op.swing === 'bottom') tmpPivot.rotation.x = swingSign * -angleRad;

    tmpOuter.updateMatrixWorld(true);

    // 4 frame pieces (top/bottom rails + left/right stiles), each
    // transformed through pivot's world matrix. The (-dx, -dy)
    // shift on each piece's local position mirrors makeHingePivot's
    // contentGroup offset so pieces land at their proper world
    // positions after the pivot transform.
    const pieces = [
      { lx: 0,                 ly:  (H - FW) / 2, w: W,           h: FW,        d: T },   // top rail
      { lx: 0,                 ly: -(H - FW) / 2, w: W,           h: FW,        d: T },   // bottom rail
      { lx: -(W - FW) / 2,     ly: 0,             w: FW,          h: H - 2*FW,  d: T },   // left stile
      { lx:  (W - FW) / 2,     ly: 0,             w: FW,          h: H - 2*FW,  d: T },   // right stile
    ];
    for (const p of pieces) {
      const geom = new THREE.BoxGeometry(p.w, p.h, p.d);
      geom.translate(p.lx - dx, p.ly - dy, zC);
      geom.applyMatrix4(tmpPivot.matrixWorld);
      geom.computeBoundingBox();
      aabbs.push(geom.boundingBox.clone());
      geom.dispose();
    }

    // Panel / pane cells. The inner area between the frame contains
    // N cells (1..8) arranged horizontally or vertically. Each cell
    // is also a solid mesh in the rendered opening and should block
    // the player just like the frame does — without this, an open
    // door's PANELS are walk-through even though the frame around
    // them isn't, which reads as "the panels are missing." Re-uses
    // the same gridLayout / gridLayoutVertical functions as the
    // renderer so the collision exactly matches the visible shape.
    const N = Math.max(1, Math.min(8, op.numDivisions || 2));
    const spacing = op.paneSpacing ?? 0.02;
    const CELL_MARGIN = 0.002;   // matches buildOpeningMesh
    const innerW_aabb = W - 2 * FW;
    const innerH_aabb = H - 2 * FW;
    const layoutW = Math.max(0.01, innerW_aabb - 2 * CELL_MARGIN);
    const layoutH = Math.max(0.01, innerH_aabb - 2 * CELL_MARGIN);
    const cells = (op.arrangement === 'vertical')
      ? gridLayoutVertical(N, layoutW, layoutH, spacing)
      : gridLayout(N, layoutW, layoutH, spacing);
    // Cell depth matches the rendered panel/pane thickness (T * 0.5).
    for (const c of cells) {
      const geom = new THREE.BoxGeometry(c.w, c.h, T * 0.5);
      geom.translate(c.x - dx, c.y - dy, zC);
      geom.applyMatrix4(tmpPivot.matrixWorld);
      geom.computeBoundingBox();
      aabbs.push(geom.boundingBox.clone());
      geom.dispose();
    }
  }
  return aabbs;
}
