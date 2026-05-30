// core/schema.js
// level.json defaults, validation, migration.
//
// The schema is intentionally permissive — anything missing is filled with a
// sensible default. State that comes in from a future engine version with
// extra fields is preserved (not stripped) so forward-compat is free.

export const SCHEMA_VERSION = 1;

import { defaultPalette } from './palette.js';

export function defaultLevel(slug = 'untitled') {
  return {
    version: SCHEMA_VERSION,
    metadata: {
      name: slug,
      createdAt: new Date().toISOString(),
      modifiedAt: new Date().toISOString(),
    },
    grid:    { rows: 100, cols: 100, cellSizeMeters: 1.0 },
    // style: drives the plane's render path.
    //   floor:   'solid' | 'grate'    | 'invisible' | 'water'
    //   ceiling: 'solid' | 'skylight' | 'invisible' | 'clouds'
    // 'solid'      — flat color + optional baseTexture (the original look).
    // 'grate' / 'skylight' — wireframe grid; see-through between the lines.
    // 'invisible'  — fully transparent fill; PNG baseTexture's alpha shows
    //                through (transparent pixels = see-through holes).
    // 'water'      — wavy fog volume hanging below the floor.
    // 'clouds'     — cloudy fog volume floating above the ceiling.
    floor: {
      enabled: true, y: 0, color: '#fafaf7', style: 'solid',
      // Water Design — palette + creative knobs + 8 phenomenon toggles.
      // Master `enabled` gates the colour palette pass; each phenomenon
      // has its own enabled flag + intensity so they can be mixed freely.
      waterDesign: {
        enabled: false,
        colors: ['#1a5fa8', '#3a85d4', '#7a4ed4', '#d44e90', '#d4a04e', '#4ed4c8'],
        speed: 0.5,
        scale: 0.3,
        contrast: 0.4,
        flowAngle: 0,
        depthShift: 0.5,
        intensity: 1.0,
        cohesion: 0.3,
        bubbleDensity: 0.5,
        bubbleBlend: 0.0,
        // 8 phenomena. Each: { enabled, intensity }.
        caustics:    { enabled: false, intensity: 0.5 },
        foam:        { enabled: false, intensity: 0.5 },
        godRays:     { enabled: false, intensity: 0.3 },
        ripples:     { enabled: false, intensity: 0.5 },
        reflect:     { enabled: false, intensity: 0.3 },
        depthFog:    { enabled: false, intensity: 0.5 },
        overlay:     { enabled: false, intensity: 0.3 },
        schools:     { enabled: false, intensity: 0.5 },
      },
    },
    ceiling: {
      enabled: false, y: 3.0, color: '#fafaf7', style: 'solid',
      // Cloud Design — palette + 6 creative knobs that drive a shader
      // pass painting the cloud body with smoothly-blended colours.
      // `enabled: false` keeps the original solid-white-cloud look.
      // Colours = 1..6 hex; the shader builds a 1D ramp and samples it
      // per-fragment, so any visible patch of sky shows 3+ colours at
      // once like an aurora.
      cloudDesign: {
        enabled:   false,
        // Default palette: 6 colours so a fresh design starts at full
        // breadth (user asked for max 6, at least 3 visible at once).
        colors: ['#3a85d4', '#7a4ed4', '#d44e90', '#d4a04e', '#4ed46a', '#4ed4c8'],
        speed:     0.5,
        // 0.35 scale = noise frequency tuned so any visible patch of sky
        // (~30 m field of view across the cloud volume) spans roughly
        // 10 noise units of phase variation. With 6 palette colours,
        // that guarantees at least 3 colour bands across the view.
        scale:     0.35,
        contrast:  0.4,
        flowAngle: 0,
        intensity: 1.0,
        shimmer:   0.0,
        cohesion:  0.3,
      },
    },
    globe: {
      radius: 150,
      gradient: { top: '#fafaf7', horizon: '#d8d8d8' },
      rotationY: 0,
      sunSpot: { visible: true, color: '#ffffff' },
      // Moon — diametrically opposite the sun on the dome's interior.
      // Same shape as sunSpot; toggled via `visible`. Optional texture
      // wraps the moon sphere (equirect/spherical).
      //   texture: { url, ... } | null
      moon:    { visible: true, color: '#e8e8f0', texture: null },
      // Star sphere — a Points cloud at radius equal to the dome's
      // radius. Centre snaps to camera once the camera is outside the
      // grid centre's bounds so stars stay at "infinity" parallax.
      stars:   { visible: true, count: 3000, sizePx: 4 },
    },
    sun: {
      directional: { color: '#ffffff', intensity: 1.0, direction: [0.3, -1, 0.2] },
      ambient:     { color: '#ffffff', intensity: 0.3 },
    },
    walls:   [],
    objects: [],
    // Openings — doors and windows. Single entity type with `kind`
    // discriminator. Anchor on a cell-side (which face of the cell:
    // 'n'/'s'/'e'/'w'). When fitMode === 'auto', the opening snaps to an
    // existing wall hole at that cell-side; when 'manual', the wall
    // builder uses width/height to leave a gap in the wall. See
    // newOpening() factory.
    openings: [],
    // Trim — frames, battens, columns. ONE entity type whose mode
    // (hole-snap / batten / column) is auto-detected at build time
    // based on what's at the anchor cell. See newTrim() factory.
    trims:   [],
    stamps:  [],
    // Plates — thin axis-aligned slabs anchored to floor cells. Like
    // shallow walls (0.01 m default height) used as floor tiles, with
    // per-plate scale, colour, optional stroke outline, and full
    // wall-style baseTexture / paint support. See newPlate() below.
    plates:  [],
    // User-defined plate presets. Each preset = { id, name, scaleX,
    // scaleZ, height }. Built-in presets live in code (newPlatePresets)
    // — this list is for "+ Add preset" entries the user authors per
    // level. Persists with the level.
    platePresets: [],
    // Narration story markers — cell-anchored pointers to portable
    // story assets that live in `stories/<storyId>.json` (sibling to
    // levels/, not bundled with the scene). At runtime the preview
    // engine fetches each referenced story, evaluates its triggers
    // against player position, and renders the current frame's box as
    // a 3D billboard. The scene only stores the marker — story content
    // is scene-agnostic so the same story can be referenced by markers
    // in multiple scenes. See newStoryMarker() below.
    storyMarkers: [],
    spawn:   { rowId: 'E4', col: 50, yaw: 0 },
    camera:  { leashOffset: [0, 1.6, -2.5], fov: 60, focalDistance: 2.5 },
    physics: { gravity: -9.8, jumpHeight: 1.1, walkSpeed: 5.0, landingDamping: 0.4 },
    hud:     { crosshair: { enabled: true, color: '#ffffff', size: 12 } },
    mode:    'first-person',
    // World-level visual options. Both default OFF so the inked-comic look
    // stays flat + uniform unless the author opts in.
    //   fog: atmospheric perspective — distant walls fade toward the sky's
    //        horizon color while edge strokes remain crisp.
    //   toonShading: two-tone face shading driven by the directional sun —
    //        gives walls a subtle lit/unlit per-face look at all angles.
    world: {
      fog:         { enabled: false, near: 30, far: 200 },
      toonShading: { enabled: false },
      // Hard-edged sun shadows. Independent of toonShading — either
      // can be on without the other; both on gives shadowed cel bands
      // (the comic-book look). Off by default to keep the flat,
      // uniform inked-comic baseline unless the author opts in.
      shadows:     { enabled: false },
      // Projected polygon shadows — flat dark quads computed by
      // projecting each caster's top rectangle to the floor along
      // the sun direction. Artifact-free hard-edged shadows
      // independent of the depth-map system. Can stack with depth-
      // map shadows (multiplies darkening) or used alone.
      shadowsProjected: { enabled: false, opacity: 0.35 },
      // Night mode: the dome renders transparent so the star sphere
      // shows through. Sun spot hides, moon stays visible.
      night:       { enabled: false },
    },
    // Level-shared 256-color palette. Index 0 reserved for transparent
    // ("show JPEG / default surface"). Authors can swap any slot via the
    // inspector. Each slot is a 0xRRGGBB integer.
    palette: defaultPalette(),
    // Paint data, indexed by world cell-face: paint["<rowIdx>,<col>,<face>"]
    // = base64-encoded raw bytes of the lumel grid (100 per meter of face
    // surface). face ∈ {'n','s','e','w','t','b'} (north/south/east/west/top/bottom).
    paint:   {},
    // JPEG-per-face — image is drawn underneath the paint layer, tiled per
    // its natural meter dimensions. Storage: jpegs["<r>,<c>,<face>"] =
    //   { dataUrl: "data:image/jpeg;base64,...", widthMeters, heightMeters }
    jpegs:   {},
    // Per-level imported 3D models. Each entry:
    //   meshes["<slug>"] = { name, dataUrl: "data:model/gltf-binary;base64,...",
    //                        defaultScale?, yOffset? }
    // The mesh palette adds these to the built-in primitives + plant.
    meshes:  {},
  };
}

// Merge defaults into a partial level object. Fills only what's missing; never
// overwrites the user's values. Used after disk load so old levels gain new
// fields without explicit migration scripts.
export function fillDefaults(level, slug = 'untitled') {
  const d = defaultLevel(slug);
  const out = deepDefault(level || {}, d);
  // Self-heal: assign fresh uids to any wall/object with a duplicate id so
  // selection (which is id-based) doesn't pick up multiple instances at once.
  // This catches both legacy levels and any future regression where stamps or
  // imports might reintroduce duplicates.
  if (Array.isArray(out.walls)) dedupeIds(out.walls, 'w');
  if (Array.isArray(out.objects)) dedupeIds(out.objects, 'o');
  if (Array.isArray(out.openings)) dedupeIds(out.openings, 'op');
  if (Array.isArray(out.trims)) dedupeIds(out.trims, 'tr');
  return out;
}

function dedupeIds(list, prefix) {
  const seen = new Set();
  for (const item of list) {
    if (!item.id || seen.has(item.id)) item.id = uid(prefix);
    seen.add(item.id);
  }
}

function deepDefault(actual, defaults) {
  if (actual === null || actual === undefined) return defaults;
  if (typeof actual !== 'object' || Array.isArray(actual)) return actual;
  // Guard against null defaults — `Object.keys(null)` throws. Treat null
  // defaults as "no further keys to merge" and just keep the actual value.
  if (defaults === null || defaults === undefined) return actual;
  if (typeof defaults !== 'object' || Array.isArray(defaults)) return actual;
  const out = { ...actual };
  for (const k of Object.keys(defaults)) {
    if (!(k in out)) {
      out[k] = defaults[k];
    } else if (defaults[k] !== null && typeof defaults[k] === 'object' && !Array.isArray(defaults[k])) {
      out[k] = deepDefault(out[k], defaults[k]);
    }
  }
  return out;
}

// Validate a level — returns { ok, errors:[] }. Schema is small; this is
// mostly type checks + a couple of cross-field sanity checks.
export function validate(level) {
  const errors = [];
  if (!level || typeof level !== 'object') {
    errors.push('level must be an object');
    return { ok: false, errors };
  }
  if (level.version !== SCHEMA_VERSION) {
    errors.push(`unknown version: ${level.version} (expected ${SCHEMA_VERSION})`);
  }
  if (!level.grid || level.grid.rows !== 100 || level.grid.cols !== 100) {
    errors.push('grid must be 100x100 (v1 constraint)');
  }
  return { ok: errors.length === 0, errors };
}

// Wall + object factories — used by tools so all entities have a stable shape.
let _id = 0;
export const uid = (prefix) => `${prefix}-${Date.now().toString(36)}-${(_id++).toString(36)}`;

// Render modes helper: returns the wall's active render-pass list.
// Prefers the modern `renderModes` array; falls back to wrapping the legacy
// `renderMode` string; defaults to ['all-edges']. Empty array = invisible wall.
export function wallRenderModes(w) {
  if (Array.isArray(w.renderModes)) return w.renderModes;
  if (typeof w.renderMode === 'string' && w.renderMode) return [w.renderMode];
  return ['all-edges'];
}

// Cells helper: the authoritative way to list which cells a wall covers.
//
// New walls carry an explicit `cells` array, but old walls use the span model
// (axis + rowId/colId + from/to). This function returns a unified list of
// { r: rowIndex, c: colNumber1Based, isWindow: bool } so the renderer and
// editor can treat both shapes uniformly.
//
// For legacy walls: window-start → first cell isWindow; window-end → last cell.
// For new walls: cells[].isWindow is the source of truth.
export function cellsOf(wall) {
  // Wall-level windowHeight, propagated per-cell so the renderer can combine
  // touching walls with different window settings without losing per-cell info.
  const wallWH = (typeof wall.windowHeight === 'number' && wall.windowHeight > 0)
    ? wall.windowHeight : null;
  if (Array.isArray(wall.cells) && wall.cells.length) {
    return wall.cells.map(c => ({
      r: c.r, c: c.c,
      isWindow: !!c.isWindow,
      isDoor:   !!c.isDoor,
      windowHeight: (typeof c.windowHeight === 'number' && c.windowHeight > 0)
        ? c.windowHeight : wallWH,
    }));
  }
  const out = [];
  if (wall.axis === 'row') {
    const r = letterDigitToIndex(wall.rowId);
    if (r === null) return out;
    const f = Math.min(wall.from, wall.to);
    const t = Math.max(wall.from, wall.to);
    for (let c = f; c <= t; c++) {
      const isWindow = (wall.kind === 'window-start' && c === f) ||
                       (wall.kind === 'window-end'   && c === t);
      const isDoor = (wall.kind === 'door-start' && c === f) ||
                     (wall.kind === 'door-end'   && c === t);
      out.push({ r, c, isWindow, isDoor, windowHeight: isWindow ? wallWH : null });
    }
  } else {
    const c = wall.colId;
    const f = Math.min(wall.from, wall.to);
    const t = Math.max(wall.from, wall.to);
    for (let r = f; r <= t; r++) {
      const isWindow = (wall.kind === 'window-start' && r === f) ||
                       (wall.kind === 'window-end'   && r === t);
      const isDoor = (wall.kind === 'door-start' && r === f) ||
                     (wall.kind === 'door-end'   && r === t);
      out.push({ r, c, isWindow, isDoor, windowHeight: isWindow ? wallWH : null });
    }
  }
  return out;
}

// Local letter-digit row id → index (avoid importing grid-addr to keep core
// modules unidirectional).
const _LETTERS = ['A','B','C','D','E','F','G','H','I','J'];
export function letterDigitToIndex(id) {
  if (typeof id !== 'string' || id.length !== 2) return null;
  const i = _LETTERS.indexOf(id[0].toUpperCase());
  const d = parseInt(id[1], 10);
  if (i < 0 || isNaN(d)) return null;
  return i * 10 + d;
}
// Inverse: index 0..99 → 'A0'..'J9'. Clamps out-of-range to the valid edges.
export function indexToLetterDigit(idx) {
  if (typeof idx !== 'number' || !isFinite(idx)) return 'A0';
  const i = Math.max(0, Math.min(99, Math.round(idx)));
  return _LETTERS[Math.floor(i / 10)] + (i % 10);
}

// 4-connected adjacency check between two cell sets. Used by Merge to decide
// whether walls touch and by Erase's split-on-disconnect logic.
export function cellSetsTouch(cellsA, cellsB) {
  const setB = new Set(cellsB.map(c => `${c.r},${c.c}`));
  for (const c of cellsA) {
    if (setB.has(`${c.r-1},${c.c}`) || setB.has(`${c.r+1},${c.c}`)
     || setB.has(`${c.r},${c.c-1}`) || setB.has(`${c.r},${c.c+1}`)
     || setB.has(`${c.r},${c.c}`)) {
      return true;
    }
  }
  return false;
}

// Split a cell list into connected components (4-connected).
// Used by Erase to detect when removing a cell disconnects a wall.
export function connectedComponents(cells) {
  const map = new Map();
  for (const c of cells) map.set(`${c.r},${c.c}`, c);
  const seen = new Set();
  const components = [];
  for (const c of cells) {
    const key = `${c.r},${c.c}`;
    if (seen.has(key)) continue;
    const comp = [];
    const queue = [c];
    seen.add(key);
    while (queue.length) {
      const cur = queue.shift();
      comp.push(cur);
      for (const [dr, dc] of [[-1,0],[1,0],[0,-1],[0,1]]) {
        const nKey = `${cur.r + dr},${cur.c + dc}`;
        if (!seen.has(nKey) && map.has(nKey)) {
          seen.add(nKey);
          queue.push(map.get(nKey));
        }
      }
    }
    components.push(comp);
  }
  return components;
}

export function newWall(partial) {
  return {
    id: uid('w'),
    cells: null,
    // 'full' | 'three-quarter' | 'half' | 'quarter' | 'window-start'
    //   | 'window-end' | 'door-start' | 'door-end' | 'corner' | 'stairs'
    kind: 'full',
    // Stairs-specific fields (ignored when kind != 'stairs'):
    //   rise  — height of each step in metres (default 0.18)
    //   run   — depth of each step along the run axis (default 0.28)
    //   stairDir — 'forward' (low end = first cell) or 'backward'
    //   material — reserved for future audio (no impl yet); persisted so
    //              future audio hooks don't need a migration.
    //   stepHeight    — optional per-step rise override. null = derive
    //                   from CLIMB_PER_CELL. When set ≥ cellSize/2 the
    //                   step count drops so each cell becomes one flat
    //                   tread.
    //   landingHeight — optional ceiling on stair rise. null = no
    //                   landing. When set, any tread that would sit above
    //                   this height is collapsed into a single flat
    //                   landing at this height (cuts the stair short).
    //   collideSides  — sides (perpA + perpB) block the player.
    //                   Default ON: stops the player walking through the
    //                   staircase from the side regardless of render
    //                   mode (silhouette / wireframe / all-edges).
    //   collideBack   — back wall (at runMaxW) blocks the player. OFF
    //                   by default — usually the high end abuts another
    //                   wall.
    //   insideFloor   — adds a walkable floor AABB at y=0 across the
    //                   stair footprint, useful if you carve into the
    //                   staircase volume or no-clip in. OFF by default.
    rise: 0.1,
    run:  0.3,
    stairDir: 'forward',
    material: 'wood',
    stepHeight: null,
    landingHeight: null,
    collideSides: true,
    collideBack: false,
    insideFloor: false,
    // Banisters: optional rail beams along the perpA / perpB sides at
    // hand height (centered around 0.9 m above the floor, sloping with
    // the staircase). Currently visual-only (no collision).
    banisterLeft:  false,
    banisterRight: false,
    // Per-step alternating tread colors (up to 6). Empty = treads inherit
    // main wall colour. When set, treads cycle through these colours by
    // step index modulo length.
    stepColors: [],
    // Step nosing: when on, each tread extends ~2.5 cm forward toward
    // the LOW end, overhanging the riser below. Architectural detail.
    stepNosing: false,
    // Open back: when on, hide every riser AND emit two diagonal
    // stringer beams underneath the treads (one per perp side). Reads
    // as a modern "open-tread" staircase with visible structural
    // beams.
    openBack: false,
    // Open sides: when on, hide the side silhouette polygons AND emit
    // diagonal stringer beams along each perp side. Reads as a
    // residential staircase with exposed sides.
    openSides: false,
    // Carpet runner — a strip down the centre of the staircase,
    // narrower than the staircase width. When enabled, each tread gets
    // a coloured/textured strip on top. Use color OR texture (texture
    // wins when both set).
    runnerEnabled: false,
    runnerWidth:   0.5,        // metres, centered on perp axis
    runnerColor:   '#c0392b',  // crimson default; classic carpet red
    runnerTexture: null,       // { url, dataUrl?, ... } same shape as baseTexture
    // Underside finish — separate colour/texture for the bottom-of-tread
    // faces (visible from below when openBack/openSides is on or you
    // no-clip under the staircase). Off by default; treads inherit the
    // main fill from above.
    undersideEnabled: false,
    undersideColor:   '#a08c6e',  // warm wood-toned default
    undersideTexture: null,
    axis: 'row',
    rowId: 'A0',
    colId: 1,
    from: 1,
    to:   10,
    color: '#fafaf7',
    stroke: '#000000',
    collide: true,
    // renderModes: array of render-pass names to layer on this wall. Default
    // is just 'all-edges' (the thin-line surface look). Each entry adds an
    // independent visual pass; an empty array makes the wall invisible.
    //   - 'all-edges'  — thin edge strokes on the surface fill
    //   - 'wireframe'  — thick edges + x-ray body (see-through)
    //   - 'silhouette' — solid stroke-color shape, no internal detail
    //   - 'backface'   — second fill pass rendered with BackSide so the
    //                    far-side faces draw THROUGH the near-side ones
    // The legacy single-string `renderMode` is still read for backwards-compat
    // (older saves are wrapped into `[renderMode]` at consume time).
    renderModes: ['all-edges'],
    renderMode: undefined,
    customHeight: null,
    windowHeight: null,
    // Door height in meters (used by door-start/door-end wall kinds). null
    // falls back to the engine default (≈2.1 m, typical interior-door clearance).
    doorHeight: null,
    // Wall thickness along the wall's perpendicular axis, in meters.
    // null = 1m (full cell). Smaller values squish to a thin centered strip.
    // Useful for fences / dividers / decorative bars.
    customWidth: null,
    // Shape-wide base JPEG, applied to the wall geometry via UV projection.
    // 4 projection modes (matching 3DS Max UVW Map):
    //   'box'      — image on every face (default cube UVs)
    //   'plane'    — flat projection along `axis` (x/y/z) — faces parallel
    //                to the axis stretch; faces perpendicular show 1:1
    //   'sphere'   — equirectangular wrap from the shape's bounding-box center
    //   'cylinder' — wraps around `axis` (x/y/z)
    // Sizing-mode controls texture.repeat (fixed / meters / stretch).
    // Assigning a new base JPEG in the editor WIPES per-face JPEGs within
    // this wall's cells.
    //   baseTexture: { dataUrl,
    //                  projection: 'box'|'plane'|'sphere'|'cylinder',
    //                  axis: 'x'|'y'|'z',
    //                  sizingMode: 'fixed'|'meters'|'stretch',
    //                  widthMeters?, heightMeters? } | null
    baseTexture: null,
    // New walls default to the voxel-mesh build path. Existing walls
    // that didn't have the flag will still render through the box-path
    // (since they predate this default). Voxel-mesh handles corner / sill
    // / lintel boundaries seamlessly.
    backfaceWhenMerged: true,
    ...partial,
  };
}

// 6 built-in plate presets. Each = { id, name, scaleX, scaleZ, height }
// where scaleX/scaleZ are in metres and height is the y thickness.
export const BUILT_IN_PLATE_PRESETS = [
  { id: 'plate-1x1',    name: '1×1',     scaleX: 1,   scaleZ: 1,   height: 0.01 },
  { id: 'plate-3x3',    name: '3×3',     scaleX: 3,   scaleZ: 3,   height: 0.01 },
  { id: 'plate-5x5',    name: '5×5',     scaleX: 5,   scaleZ: 5,   height: 0.01 },
  { id: 'plate-9x9',    name: '9×9',     scaleX: 9,   scaleZ: 9,   height: 0.01 },
  { id: 'plate-25x25',  name: '25×25',   scaleX: 25,  scaleZ: 25,  height: 0.01 },
  { id: 'plate-49x49',  name: '49×49',   scaleX: 49,  scaleZ: 49,  height: 0.01 },
];

// A plate is a thin axis-aligned slab anchored to one floor cell. Its
// XZ footprint comes from `scaleX × scaleZ` (in metres), height from
// `scaleY`, all extending symmetrically out from the anchor cell's
// centre by default. `directional` flips to per-side offsets (N/S/E/W)
// so the user can extend asymmetrically.
export function newPlate(partial) {
  return {
    id: uid('p'),
    // Anchor cell — plate centres on this cell unless `directional` is on.
    rowId: 'A0',
    col: 1,
    // Snap mode (non-directional path only):
    //   'center' — symmetric expansion from the anchor cell's center.
    //              For odd scale the edges land on grid lines; for even
    //              scale the edges land at half-cells but the center
    //              stays on the cell center. (Default.)
    //   'grid'   — round the scale to integer cells, then place so the
    //              edges land on grid lines. For odd-cell scales this
    //              matches 'center'; for even-cell scales the plate
    //              shifts to cover N full cells biased east+south of
    //              the anchor (center moves to a cell boundary).
    snapMode: 'center',
    // Bottom of the plate slab in world Y (sits ON the floor at 0).
    y: 0,
    // Scale dimensions in metres. Default = 1×1 cell footprint, 0.01 m
    // thick — a "floor tile."
    scaleX: 1,
    scaleZ: 1,
    scaleY: 0.01,
    // Per-side offsets (in metres). Only used when `directional` is true;
    // override the symmetric scaleX/scaleZ spread.
    directional: false,
    offsetN: 0.5, offsetS: 0.5, offsetE: 0.5, offsetW: 0.5,
    // Fill colour. White by default; per-plate user override available.
    color: '#fafaf7',
    // Stroke (outline) toggle + colour. Off by default; when on, the
    // plate's silhouette gets a perimeter LineSegments in `strokeColor`.
    stroke: false,
    strokeColor: '#0b0d14',
    // Collide as a 6-sided AABB like walls.
    collide: true,
    // Voxel-mesh build path on by default (seamless when merged).
    backfaceWhenMerged: true,
    // Same baseTexture shape walls use — full JPEG kit.
    baseTexture: null,
    ...partial,
  };
}

export function newObject(partial) {
  return {
    id: uid('o'),
    meshSlug: 'plant',
    rowId: 'A0',
    col: 1,
    // Per-axis rotation in DEGREES (converted to radians at render time).
    rotation: [0, 0, 0],
    // Per-axis scale — negative values flip on that axis.
    scale: [1, 1, 1],
    // Per-axis offsets from the cell centre (metres). yOffset
    // historically existed; xOffset and zOffset added so the user
    // can nudge an imported mesh OFF its cell anchor without
    // changing the anchor cell itself.
    xOffset: 0,
    yOffset: 0,
    zOffset: 0,
    collide: true,
    texture: null,
    ...partial,
  };
}

// ─────────────────────────────────────────────────────────────────
// NARRATION SYSTEM
// ─────────────────────────────────────────────────────────────────
// Two-tier model:
//   storyMarker (lives in level.json) — cell-anchored pointer to a
//     story asset. Holds JUST the placement + a `storyId` reference.
//   story (lives in stories/<id>.json — separate file, scene-agnostic)
//     — holds frames, triggers, box geometry, text content. Reusable
//     across scenes by referencing the same id from any marker.
//
// Why split: stories are portable assets. Same tutorial story can be
// dropped into multiple scenes by placing a marker that references
// the same storyId. Scene only owns WHERE the story plays, not WHAT.
//
// Trigger / replay model lives in marker (replay) + story (triggers)
// so different markers of the same story can play once vs always.

export function newStoryMarker(partial) {
  return {
    id: uid('sm'),
    // Cell placement on the editor map.
    rowId: 'A0',
    col: 1,
    // Reference to a portable story asset in stories/<storyId>.json.
    // Place-marker tool generates a fresh empty story file and links
    // it here automatically.
    storyId: null,
    // Optional grouping for trigger inheritance + visual border merge.
    // All markers with the same groupId share trigger conditions and,
    // when their currently-playing boxes overlap in POV, render a
    // single merged outline polygon around the union.
    groupId: null,
    // When the story is allowed to replay after reaching its end:
    //   'once-per-load'  — fires at most once per preview load (engine
    //                      memory only; no localStorage / IndexedDB).
    //                      Once the story ends, this marker is dead
    //                      for the rest of the session.
    //   'restart'        — re-plays from frame 1 each time the trigger
    //                      becomes true AFTER going false. Reaching
    //                      the end does NOT immediately restart while
    //                      the player is still in the trigger zone —
    //                      the player must leave the zone first.
    // The legacy value 'always' (renamed to 'restart' on 2026-05-25)
    // is accepted on load and treated as 'restart'.
    replay: 'once-per-load',
    ...partial,
  };
}

// Openings — doors and windows. Single entity type with `kind`
// discriminator. Lives in s.openings[]. Renders parametric frame +
// inner panels/panes; auto-fits an existing wall hole or creates one
// manually based on fitMode.
export function newOpening(partial) {
  return {
    id: uid('op'),
    kind: 'door',         // 'door' | 'window'
    rowId: 'A0',
    col: 1,
    // Which face of the cell the opening sits on:
    //   'n'/'s'/'e'/'w'   = flush with that cell edge; thickness
    //                       extends INWARD into the cell.
    //   'center-ew'       = centred in the cell, opening's WIDTH
    //                       runs E-W (along X). Thickness grows
    //                       symmetrically from centre.
    //   'center-ns'       = centred in the cell, WIDTH runs N-S.
    //                       Thickness grows symmetrically.
    side: 'n',
    // 'auto'  = snap to an existing wall hole at this cell-side. If no
    //           hole exists, placement is refused by the tool.
    // 'manual' = use width/height verbatim, wall builder creates the
    //           hole to match.
    fitMode: 'auto',
    // Dimensions in metres. Defaults tuned to typical home sizes:
    //   door  = 0.9 m wide × 2.0 m tall, anchored to floor (yOffset 0)
    //   window = 1.2 m wide × 1.0 m tall, anchored mid-wall (yOffset 1.0)
    width:  0.9,
    height: 2.0,
    // Vertical offset from floor to the bottom edge of the opening
    // (= sill height for windows). 0 for doors (floor-anchored).
    yOffset: 0,
    // Lateral shift along the wall direction (the side's axis). +X
    // moves the opening "right" along the wall as seen looking from
    // outside the cell toward its side.
    xOffset: 0,
    // Depth shift perpendicular to the wall. 0 = centred in the wall
    // thickness. Positive pushes toward the cell interior, negative
    // toward the exterior. Use for "place on interior face / center /
    // exterior face" without a discrete selector.
    zOffset: 0,
    // Frame thickness — how far the opening's frame protrudes from
    // the wall face on each side. 0.04 = 4 cm, reads as a typical
    // door/window casing.
    thickness: 0.04,
    // Spacing between adjacent panels/panes (the divider strip width).
    // 0.02 = 2 cm. Larger values give a more pronounced grid look.
    paneSpacing: 0.02,
    // Outer frame thickness — how wide the body/frame border is on
    // each edge of the opening. 0.06 = 6 cm casing. Larger values
    // shrink the inner area (and therefore the panes) accordingly,
    // so frame and panes always sum to width/height exactly.
    frameWidth: 0.06,
    // Number of subdivisions: panels for doors, panes for windows.
    // 1..8. Odd counts (3/5/7) get a top double-width row + grid below.
    // Even counts use a clean 2-column grid (or single column for 2).
    numDivisions: 2,
    // Color overrides. null = use kind default. Body = the frame ink,
    // panel = the panel/pane fill.
    bodyColor:  null,
    panelColor: null,
    // Opacity 0..100 of the panels/panes. 100 = fully solid; 0 =
    // fully transparent. Values between alpha-blend. null = use the
    // kind default (window: 55, door: 100). Replaces the older
    // `translucent` boolean which was a binary on/off.
    opacity: null,
    // Frosted glass effect: lightens the panel/pane colour toward
    // off-white and drops opacity ~20%, mimicking the soft milky
    // look of frosted glass. Works on both doors and windows.
    frosted: false,
    // Collision toggle. When true, the opening's MESH has collision
    // (frame perimeter blocks the player). The opening still has a
    // walk-through hole — collision is FRAME-ONLY, never blocks the
    // gap. Useful for swinging doors/windows where the door body
    // moves but the player can still pass through the cell when
    // it's open. AABB implementation pending Phase E (open/close).
    collide: true,
    // Panel/pane arrangement.
    //   'horizontal' (default) = rows-dominant; odd N gets a top
    //                            double-wide row + 2-col grid below
    //   'vertical'             = cols-dominant; odd N gets 3 columns
    //                            (L+C+R) in the middle with (N-3)/2
    //                            additional full-width rows above and
    //                            (N-3)/2 below. Even N stacks vertically.
    arrangement: 'horizontal',
    // Swing direction — which side the door/window is hinged on.
    // 'left'  = hinge on left edge,  pivots around vertical axis
    // 'right' = hinge on right edge, pivots around vertical axis
    // 'top'   = hinge on top edge,   pivots around horizontal axis (awning)
    // 'bottom'= hinge on bottom edge,pivots around horizontal axis (hopper)
    swing: 'left',
    // Locked state. When true, the opening can't be swung (preview
    // ignores click-and-drag on it). When false (default), the user
    // can click + hold the opening in the preview to swing it open.
    locked: false,
    // Current open angle in degrees. Clamped to [swingMin, swingMax]
    // during interactive drag. Persists with state so an opening can
    // be authored "ajar" or "wide open" without runtime interaction.
    openAngle: 0,
    // Swing range — the angles the opening can rotate between. Drag
    // can't push the openAngle outside this range. Allowed 0-360.
    //   swingMin: angle at "fully closed" (default 0 = flat in wall)
    //   swingMax: angle at "fully open"   (default 85 = nearly open)
    // Setting swingMin > 0 means the opening NEVER closes flat (always
    // ajar by at least that much). Setting swingMax > 90 lets a door
    // open more than a right angle (e.g., 120° for a fully-pushed-back
    // door against a wall). Works for any swing axis (left/right/top/
    // bottom) — the range is the same number system regardless.
    swingMin: 0,
    swingMax: 85,
    // Reverse the rotation direction on the swing axis. Useful when
    // the default swing direction is the wrong way for a particular
    // door — e.g., a left-hinged door that should swing AWAY from the
    // player (into the room behind) instead of toward them. Affects
    // both the visual rotation and the drag handler's sign mapping
    // so dragging in the same direction still opens the door.
    swingReverse: false,
    // Door knob: a small protruding handle on the front face.
    //   enabled: shown only when true (defaults off; doors typically
    //            want one, windows usually don't).
    //   side: 'left' | 'right' | 'center' | 'auto'. 'auto' picks the
    //         side opposite the hinge (e.g., swing='left' → knob on right).
    //   yOffset: vertical position from the BOTTOM of the opening (m).
    //   xOffset: horizontal shift from the side-derived base position.
    //            0 = default base position (more inboard, away from the
    //            frame edge); positive shifts toward the frame edge,
    //            negative toward the door center.
    //   size: knob radius in metres.
    //   color: hex string, null = default white.
    // type: 'sphere'   = classic round knob with shank (default)
    //       'u-handle' = vertical pull bar (modern handle on cabinets / doors)
    //       'panel'    = backing plate + horizontal lever (residential lever)
    knob: {
      enabled: false, side: 'auto', yOffset: 0, xOffset: 0,
      size: 0.04, color: null, type: 'sphere',
      // Stroke = inked outline drawn around the knob's silhouette.
      // stroke: true/false toggles it; strokeColor overrides default.
      stroke: true, strokeColor: null,
    },
    // Door knocker: a ring/plate on the upper portion of the front face.
    //   enabled: shown only when true.
    //   yOffset: vertical position from the BOTTOM of the opening (m).
    //   size: knocker overall radius in metres.
    //   color: hex string, null = default cast-iron-grey.
    knocker: {
      enabled: false, yOffset: 1.6, size: 0.05, color: null,
      // type: 'classic'  = plate + hanging ring (default)
      //       'wreath'   = chunky decorative torus, no plate
      //       'gargoyle' = small head with two eyes + nose ring
      //       'bell'     = hanging bell (truncated cone + hanger)
      type: 'classic',
      stroke: true, strokeColor: null,
    },
    // Reserved for later phases:
    //   knob, knocker: sub-mesh position + size + texture (door only)
    //   paneMaterial: solid / translucent / glare / dirty / stained
    //   bodyTexture, panelTexture: per-section JPEGs
    //   swingDir, swingAxis, openAngle: open/close mechanics
    //   borderThickness, borderColor: frame border styling
    ...partial,
  };
}

// Trim — frames around hole openings, vertical battens on walls,
// columns in empty cells. One entity type whose visible geometry
// depends on the `mode` (auto-detected from cell context at build
// time, or explicitly forced). Anchor at (rowId, col) like openings.
export function newTrim(partial) {
  return {
    id: uid('tr'),
    rowId: 'A0',
    col: 1,
    // Mode resolution:
    //   'auto'      = decided at build: opening at cell → hole-snap;
    //                 wall at cell → batten; else → column.
    //   'hole-snap' = force frame around any opening (skip auto check)
    //   'batten'    = force batten on a wall
    //   'column'    = force column at cell centre
    mode: 'auto',
    // Side selection for hole-snap / batten:
    //   'auto'      = same side the opening/wall sits on
    //   'both'      = render on BOTH sides of the wall
    //   'n'|'s'|'e'|'w' = explicit override
    side: 'auto',
    // Per-side toggles. For frame mode: top/bot rails, L/R stiles.
    // For batten: top/bot caps + L/R sides of the vertical strip.
    // For column: top cap + bot cap + the 4 vertical faces are
    // toggleable. Corners join seamlessly when neighbours are on.
    sides: { top: true, bottom: true, left: true, right: true },
    // Dimensions
    thickness:    0.06,   // strip width (visible "wood width")
    depth:        0.03,   // protrusion from wall surface
    columnSize:   0.4,    // square cross-section for column mode
    startHeight:  0,      // floor offset (batten/column bottom)
    totalHeight:  3.0,    // total height (batten/column)
    // Offsets (all three modes)
    xOffset: 0,
    yOffset: 0,
    zOffset: 0,
    // Color / stroke
    color: null,          // null = default greyscale (#9a9a9a)
    stroke: true,
    strokeColor: null,    // null = default ink #0b0d14
    // Auto bottom-off when frame snaps to a door (matches real-world
    // door casings — no sill at the floor). The hole-snap builder
    // checks this AND the opening's kind to decide bottom default.
    autoDoorNoBottom: true,
    ...partial,
  };
}

// Portable story asset. Saved as stories/<id>.json. The narration
// engine fetches these on preview load + on marker changes. NOT
// embedded in scene state — keep them separate for library reuse.
//
// Frames are keyed by string IDs that follow a dotted-path tree:
//   '1', '2', '3'   linear flow
//   '3-1', '3-2'    branches off frame '3'
//   '3-1-1'         a branch off '3-1'
// IDs are author-meaningful — the storyboard editor displays them
// indented to show the tree shape.
export function newStory(partial) {
  return {
    id: uid('story'),
    name: 'Untitled story',
    // Trigger array. OR'd: any matching trigger fires the story.
    // Phase 1 supports: { type: 'distance', cells: <n> } and
    // { type: 'always' }. IFTTT types planned later.
    triggers: [{ type: 'distance', cells: 5 }],
    // Frame map. Phase 1 ships with a single placeholder frame '1'.
    // See newStoryFrame() for the per-frame shape.
    frames: { '1': newStoryFrame() },
    ...partial,
  };
}

// One frame of a story. Holds the boxes + how to advance. Each frame
// can contain MULTIPLE boxes, each individually positioned and
// styled — used for grouping panels (a narration box + a side
// thought-bubble, etc.). The 'attaches' system on top of that lets
// OTHER stories play in parallel, but in-frame boxes share the same
// trigger/advance/replay lifecycle.
//
// Buttons live PER BOX, not per frame: a frame can have one box with
// CYOA buttons + another silent box of narration, and only the
// button box is clickable.
export function newStoryFrame(partial) {
  const f = {
    // Frame ID is assigned by the caller (string, e.g. '1' or '3-1').
    // Not auto-uid'd because IDs encode the tree structure.
    advance: 'click',         // 'click' | 'time'
    duration: 3,              // seconds, used when advance === 'time'
    next: null,               // next frame id (or null for end)
    // Other storyIds to ALSO start playing when this frame fires.
    // The attached stories play their OWN frames in parallel from
    // their first frame. Branching simultaneity primitive.
    attaches: [],
    boxes: [newStoryBox()],
    ...partial,
  };
  // Back-compat: saved levels from before the multi-box refactor
  // stored a single `box` plus a frame-level `buttons` array. Lift
  // both into the new boxes[0] so the renderer + inspector don't
  // need to fork on schema version.
  if (f.box && !partial?.boxes) {
    const migrated = { ...f.box };
    if (Array.isArray(f.buttons) && f.buttons.length) {
      migrated.buttons = f.buttons;
    }
    f.boxes = [migrated];
    delete f.box;
    delete f.buttons;
  }
  return f;
}

// One box within a frame. Cell-offset is in metres relative to the
// marker's world position. Width/height in metres; 'auto' fits to
// text content. Each box carries its own buttons array — when
// present, the box itself isn't clickable for `next` advance and the
// buttons handle branching.
export function newStoryBox(partial) {
  return {
    id: uid('box'),
    // World-space offset from the marker's cell centre.
    cellOffset: { dx: 0, dy: 1.5, dz: 0 },
    width: 'auto',
    height: 'auto',
    // Anchor point for resize stability across frames.
    anchor: 'center',
    border: { shape: 'rect', stroke: '#0b0d14', weight: 2 },
    fill:   { color: '#ffffff', opacity: 1 },
    // Text content — array of runs. Each run = { chars, style }.
    text: [
      {
        chars: 'Placeholder paragraph for narration box. Replace this with your story text.',
        style: { font: 'Permanent Marker', size: 14, color: '#000000', weight: 'normal' },
      },
    ],
    // CYOA buttons. null = box itself is clickable; non-empty array =
    // each button branches to a frame id within the same story.
    buttons: null,
    // How many buttons sit on a single row before wrapping to the
    // next row. Default 3 — typical comic CYOA layout.
    buttonsPerRow: 3,
    ...partial,
  };
}
