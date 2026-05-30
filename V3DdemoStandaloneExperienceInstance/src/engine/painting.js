// engine/painting.js — paintable surfaces.
//
// Each wall rectangle (greedy-meshed by walls.js) gets 6 paint planes — one
// per face. Each plane has its own HTMLCanvas + THREE.CanvasTexture sized
// to the face's pixel dimensions (100 lumels per meter). Painting a lumel
// modifies the canvas and flags the texture for re-upload.
//
// The off-white base wall surface shows through transparent lumels. Painted
// lumels overlay it.
//
// Paint storage is global per (rowIdx, col, faceDir). When a wall is split
// or re-greedy-meshed, paint at the underlying cell-face positions survives.

import * as THREE from 'three';
import * as state from '../core/state.js';
import { hexToRgb } from '../core/palette.js';
import { resolveAssetUrl } from '../core/asset-paths.js';
import { gcDeleteIfOrphan } from '../core/asset-store.js';

// Face directions, with their plane orientation + extent rules.
//   'n' = -Z face,  's' = +Z face
//   'w' = -X face,  'e' = +X face
//   't' = +Y top,   'b' = -Y bottom
//
// Sub-region paint planes (window sills, lintels, door headers) carry a
// suffix like 'n-sill' / 's-lintel' / 'b-header' so their sidecar entries
// don't collide with a full-height wall plane on the same cell. The
// geometry/cell math only cares about the prefix; primaryDir() strips the
// suffix for those lookups while the sidecar key keeps the full dir.
const FACES = ['n', 's', 'w', 'e', 't', 'b'];
function primaryDir(dir) {
  const i = dir.indexOf('-');
  return i === -1 ? dir : dir.substring(0, i);
}

// All paint planes that currently exist in the scene. Cleared on rebuild.
let _planes = [];

// Backing meshes — the floor and ceiling planes (and any future paintable
// non-wall surface). These are NOT paint planes themselves; the raycaster
// uses them so the paint tool can hit floor/ceiling, then lazily creates a
// 1×1 m per-cell paint plane at the hit location and routes the hit to it.
const _backingMeshes = [];

// Lazy per-cell paint planes for floor / ceiling. Keyed "r,c,dir" so we can
// find or reuse an existing plane for a re-hit cell instead of stacking
// duplicates each frame. Parented to _paintRoot below.
const _cellPlaneIndex = new Map();
// Persistent record of every floor/ceiling cell that has been painted at
// least once this session. Survives clearPaintPlanes() so we can re-create
// the lazy planes after a wall rebuild wipes them — the paint DATA lives
// in the _paint sidecar, but the visual plane has to be re-built.
const _lazyPaintedCells = new Set();
let _paintRoot = null;

export function setPaintRoot(group) { _paintRoot = group; }
export function clearBackingMeshes() { _backingMeshes.length = 0; }
export function registerBackingMesh(mesh) { _backingMeshes.push(mesh); }

// Engine.js calls this after every rebuild so lazy paint planes for
// floor/ceiling cells re-appear with their painted bytes (the sidecar was
// preserved; only the mesh got torn down). Builds a plane for each cell
// previously painted via the lazy path.
export function restoreLazyCellPlanes() {
  if (!_paintRoot) return;
  const s = state.get();
  const cs = s.grid.cellSizeMeters;
  for (const key of _lazyPaintedCells) {
    if (_cellPlaneIndex.has(key)) continue;
    const [rs, cs2, dir] = key.split(',');
    const row = +rs, col = +cs2;
    if (dir !== 't' && dir !== 'b') continue;
    // Use ensureLazyCellPlane-style logic but synthesize the cell position
    // directly (no raycast hit needed here).
    const cx = (col - 0.5) * cs;
    const cz = (row + 0.5) * cs;
    const y  = (dir === 't') ? s.floor.y : s.ceiling.y;
    _createLazyCellPlane(row, col, dir, cx, y, cz, cs);
  }
}

// Active paint state — the engine sets this. Paint clicks check it.
let _paintModeOn = false;
let _activePaletteIndex = 1;
let _brushSize = 10;   // default 10×10 lumels; range 1..100

// Mesh-paint brush sizing mode:
//   true  (default) — world-square: draw a canvas parallelogram whose
//     world-space projection is a true N×N cm square at the hit face. Dot
//     stays a clean square on the surface regardless of mesh scale or skew,
//     and matches wall/floor/ceiling sizes in world cm.
//   false — area-isotropic: same average world size, but rasterized as a
//     plain canvas square; on non-uniformly scaled meshes the dot looks
//     elongated because the UV mapping stretches along one axis.
let _meshConstantDot = true;
export function getMeshConstantDot() { return _meshConstantDot; }
export function setMeshConstantDot(v) { _meshConstantDot = !!v; }

export function setPaintMode(on)             { _paintModeOn = on; }
export function isPaintModeOn()              { return _paintModeOn; }
export function setActiveIndex(i)             { _activePaletteIndex = Math.max(0, Math.min(255, i | 0)); }
export function getActiveIndex()              { return _activePaletteIndex; }
export function setBrushSize(n)               { _brushSize = Math.max(1, Math.min(100, n | 0)); }
export function getBrushSize()                { return _brushSize; }
let _brushChangedListeners = new Set();
export function onBrushSizeChanged(fn)        { _brushChangedListeners.add(fn); return () => _brushChangedListeners.delete(fn); }
export function nudgeBrushSize(dir)           {
  setBrushSize(_brushSize + (dir === 'up' ? 1 : -1));
  for (const fn of _brushChangedListeners) fn(_brushSize);
}

// Paint sidecar store. Lives outside the broadcast pub/sub state so a single
// lumel paint click doesn't trigger a full wall rebuild. Save/load happens
// via explicit serialization (saveToLevel / loadFromLevel).
const _paint = new Map();   // "r,c,dir" → Uint8Array
const _jpegs = new Map();   // "r,c,dir" → { dataUrl, image, widthMeters, heightMeters, loaded }
const _baseTextures = new Map();  // wallId → { dataUrl, image, widthMeters, heightMeters, loaded }
const _planeListeners = new Set();  // (key) => void — called when a face's paint/jpeg changes

export function getPaintAt(rowIdx, col, faceDir) {
  return _paint.get(`${rowIdx},${col},${faceDir}`) || null;
}
function setPaintAt(rowIdx, col, faceDir, bytes) {
  _paint.set(`${rowIdx},${col},${faceDir}`, bytes);
}

export function getJpegAt(rowIdx, col, faceDir) {
  return _jpegs.get(`${rowIdx},${col},${faceDir}`) || null;
}

// Assign a JPEG to a cell-face. The image is loaded asynchronously; when it
// resolves, any paint planes covering this cell-face are re-composed so the
// JPEG appears immediately. Sizing-mode controls how widthMeters/heightMeters
// are derived if not provided.
//   src can be either an "url" (level-relative file path) or a "dataUrl"
//   (inline base64). New saves use url; old data may have dataUrl.
export function setJpegAt(rowIdx, col, faceDir, src, sizingMode = 'fixed', widthMeters = null, heightMeters = null) {
  const key = `${rowIdx},${col},${faceDir}`;
  const entry = { src, sizingMode, widthMeters, heightMeters, image: new Image(), loaded: false };
  entry.image.onload = () => {
    entry.loaded = true;
    if (sizingMode === 'fixed') {
      entry.widthMeters  = entry.image.naturalWidth  / 100;
      entry.heightMeters = entry.image.naturalHeight / 100;
    } else if (sizingMode === 'stretch') {
      entry.widthMeters  = 1;
      entry.heightMeters = 1;
    }
    notifyFaceChanged(key);
  };
  entry.image.crossOrigin = 'anonymous';
  entry.image.src = resolveAssetUrl(src);
  _jpegs.set(key, entry);
}

export function removeJpegAt(rowIdx, col, faceDir) {
  const key = `${rowIdx},${col},${faceDir}`;
  const prevUrl = _jpegs.get(key)?.src;
  if (_jpegs.delete(key)) {
    notifyFaceChanged(key);
    // GC the file from disk if nothing else references it. The sidecar src
    // may be a level-relative path or a data URL; gcDeleteIfOrphan ignores
    // data URLs safely.
    if (prevUrl) gcDeleteIfOrphan(prevUrl);
  }
}

// Remove every per-face JPEG within the given cell list. Used when assigning
// a new base JPEG to a wall — the spec is that base assignment wipes all
// other JPEGs for that shape.
export function clearJpegsForCells(cells) {
  if (!cells) return;
  const droppedUrls = [];
  for (const c of cells) {
    for (const dir of ['n','s','e','w','t','b']) {
      const key = `${c.r},${c.c},${dir}`;
      const prevUrl = _jpegs.get(key)?.src;
      if (_jpegs.delete(key)) {
        notifyFaceChanged(key);
        if (prevUrl) droppedUrls.push(prevUrl);
      }
    }
  }
  for (const u of droppedUrls) gcDeleteIfOrphan(u);
}

// Ensure a wall's baseTexture image is loaded into the sidecar. Returns the
// cached entry. Async — onload triggers face-change notifications so paint
// planes that include cells of this wall re-compose.
export function ensureBaseTexture(wall) {
  if (!wall?.baseTexture) return null;
  const src = wall.baseTexture.url || wall.baseTexture.dataUrl;
  if (!src) return null;
  const id = wall.id;
  const desc = wall.baseTexture;
  const existing = _baseTextures.get(id);
  if (existing && existing.src === src) return existing;

  const entry = {
    wallId: id,
    src,
    sizingMode: desc.sizingMode || 'fixed',
    widthMeters: desc.widthMeters || null,
    heightMeters: desc.heightMeters || null,
    image: new Image(),
    loaded: false,
  };
  entry.image.onload = () => {
    entry.loaded = true;
    if (entry.sizingMode === 'fixed' && (entry.widthMeters == null || entry.heightMeters == null)) {
      entry.widthMeters  = entry.image.naturalWidth  / 100;
      entry.heightMeters = entry.image.naturalHeight / 100;
    } else if (entry.sizingMode === 'stretch') {
      entry.widthMeters = 1; entry.heightMeters = 1;
    }
    for (const fn of _planeListeners) fn(`__base:${id}`);
  };
  entry.image.crossOrigin = 'anonymous';
  entry.image.src = resolveAssetUrl(src);
  _baseTextures.set(id, entry);
  return entry;
}

export function getBaseTexture(wallId) { return _baseTextures.get(wallId) || null; }
export function dropBaseTexture(wallId) { _baseTextures.delete(wallId); }

function notifyFaceChanged(key) {
  for (const fn of _planeListeners) fn(key);
}
export function onFaceChanged(fn) {
  _planeListeners.add(fn);
  return () => _planeListeners.delete(fn);
}

// Serialize paint + jpegs into the level. Called when saving.
// Kept for migration: legacy code paths that still write paint into
// level.json (state.paint + state.jpegs) call this. New code uses
// serializeToObject() below.
export function saveToLevel(s) {
  const out = serializeToObject();
  s.paint = out.paint;
  s.jpegs = out.jpegs;
}

// Populate sidecars from the level. Called on load.
export function loadFromLevel(s) {
  _paint.clear();
  _jpegs.clear();
  syncFromLevel(s);
}

// ---------------------------------------------------------------
// Paint sidecar (Phase B' refactor — paint persists separately
// from level.json, as levels/<slug>/paint.json).
//
//   serializeToObject() -> { paint: {key: base64}, jpegs: {key: {url,...}} }
//   loadFromObject(payload) — clears the sidecar Maps + repopulates
//     from the given payload. Mirrors loadFromLevel's semantics but
//     decoupled from the level state shape.
// ---------------------------------------------------------------
export function serializeToObject() {
  const paint = {};
  for (const [k, bytes] of _paint) {
    paint[k] = btoa(String.fromCharCode.apply(null, bytes));
  }
  const jpegs = {};
  for (const [k, e] of _jpegs) {
    jpegs[k] = {
      url: e.src,
      sizingMode: e.sizingMode,
      widthMeters: e.widthMeters,
      heightMeters: e.heightMeters,
    };
  }
  return { paint, jpegs };
}

export function loadFromObject(payload) {
  _paint.clear();
  _jpegs.clear();
  // syncFromLevel reads s.paint and s.jpegs — we hand it a
  // synthetic state-shaped object so the same parse path is reused.
  syncFromLevel({ paint: payload?.paint || {}, jpegs: payload?.jpegs || {} });
}

// True when the sidecar holds any paint OR any JPEG mapping. Used
// by the editor to decide whether the "Include paint in saves"
// toggle is meaningful + whether to write the sidecar at all.
export function hasPaintData() {
  return _paint.size > 0 || _jpegs.size > 0;
}

// Reconcile sidecars with the level state without destroying loaded images.
//
// Phase B' note: paint + jpegs no longer live in level.json. State
// broadcasts therefore stop carrying paint data. To prevent this
// function from silently wiping the sidecar Maps every time state
// changes (which would erase paint loaded from the sidecar at boot),
// each section here is GATED on the state object actually carrying
// that key. If `s.paint` is undefined, paint sync is skipped
// entirely. Same for `s.jpegs`. Only an EXPLICIT `s.paint = {}`
// (legacy code intending "clear all paint") triggers the clear path.
export function syncFromLevel(s) {
  const hasPaintKey = s && Object.prototype.hasOwnProperty.call(s, 'paint');
  const hasJpegsKey = s && Object.prototype.hasOwnProperty.call(s, 'jpegs');
  if (hasPaintKey) {
    const statePaint = s.paint || {};
    for (const k of Object.keys(statePaint)) {
      const v = statePaint[k];
      if (typeof v !== 'string') continue;
      const bin = atob(v);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      _paint.set(k, bytes);
    }
    for (const k of [..._paint.keys()]) if (!(k in statePaint)) _paint.delete(k);
  }
  if (hasJpegsKey) {
    const stateJpegs = s.jpegs || {};
    for (const k of Object.keys(stateJpegs)) {
      const e = stateJpegs[k];
      const src = e?.url || e?.dataUrl;
      if (!src) continue;
      const existing = _jpegs.get(k);
      if (existing?.src === src) continue;
      const [rs, cs, dir] = k.split(',');
      setJpegAt(+rs, +cs, dir, src, e.sizingMode || 'fixed', e.widthMeters, e.heightMeters);
    }
    for (const k of [..._jpegs.keys()]) {
      if (!(k in stateJpegs)) {
        _jpegs.delete(k);
        notifyFaceChanged(k);
      }
    }
  }
}

// Build paint planes for the given wall rectangle at the given height.
// rect = { r0, c0, r1, c1, cellSize }. `wallRef` (optional) gives access to
// the wall's baseTexture so the plane composes it as a background layer.
//
// opts.yMin / opts.yMax  — restrict vertical faces to a sub-Y range. Used
//                          to build paint planes for window sills/lintels
//                          and door headers (sub-regions of the wall that
//                          aren't full-height). Default 0..h covers the
//                          whole wall like before.
// opts.dirSuffix         — appended to each face's dir (e.g. '-sill'). The
//                          suffix differentiates sub-region sidecar entries
//                          from full-region entries on the same cell so
//                          paint on a sill doesn't bleed into a lintel
//                          stored under the same key.
//
// Returns array of Mesh.
export function buildPaintPlanesForRect(rect, h, palette, wallRef = null, skipFaces = null, opts = {}) {
  const yMin = opts.yMin ?? 0;
  const yMax = opts.yMax ?? h;
  const dirSuffix = opts.dirSuffix ?? '';
  const cs = rect.cellSize;
  const cellsX = rect.c1 - rect.c0 + 1;
  const cellsZ = rect.r1 - rect.r0 + 1;
  // customWidth shrinks the wall's MINOR axis. Match the box-union build
  // logic in walls.js so paint planes sit on the actual wall surface, not
  // at the cell perimeter (which would float thin walls in air).
  const cw = (wallRef?.customWidth && wallRef.customWidth > 0 && wallRef.customWidth <= 1)
    ? wallRef.customWidth : 1;
  let xExtent = cellsX * cs;
  let zExtent = cellsZ * cs;
  let xOffset = 0;
  let zOffset = 0;
  if (cellsZ === 1 && cellsX > 1) {
    zExtent = cw * cs;
    zOffset = (1 - cw) / 2 * cs;
  } else if (cellsX === 1 && cellsZ > 1) {
    xExtent = cw * cs;
    xOffset = (1 - cw) / 2 * cs;
  } else if (cellsX === 1 && cellsZ === 1) {
    xExtent = cw * cs; zExtent = cw * cs;
    xOffset = (1 - cw) / 2 * cs; zOffset = (1 - cw) / 2 * cs;
  }
  const xMin = (rect.c0 - 1) * cs + xOffset;
  const xMax = xMin + xExtent;
  const zMin = rect.r0 * cs + zOffset;
  const zMax = zMin + zExtent;
  const cx = (xMin + xMax) / 2;
  const cz = (zMin + zMax) / 2;
  const w = xExtent;
  const d = zExtent;

  const out = [];
  // Vertical-face geometry restricted to [yMin, yMax] for sub-region planes
  // (sills/lintels/headers). Default is the full wall height [0, h].
  const yh = yMax - yMin;
  const yc = (yMin + yMax) / 2;
  // Each face entry: { dir, planeW, planeH, pos, rot }
  const faceList = [
    { dir: 'n' + dirSuffix, planeW: w, planeH: yh, pos: [cx, yc,   zMin], rot: [0, Math.PI,    0] },
    { dir: 's' + dirSuffix, planeW: w, planeH: yh, pos: [cx, yc,   zMax], rot: [0, 0,          0] },
    { dir: 'w' + dirSuffix, planeW: d, planeH: yh, pos: [xMin, yc, cz],   rot: [0, -Math.PI/2, 0] },
    { dir: 'e' + dirSuffix, planeW: d, planeH: yh, pos: [xMax, yc, cz],   rot: [0,  Math.PI/2, 0] },
    { dir: 't' + dirSuffix, planeW: w, planeH: d,  pos: [cx, yMax, cz],   rot: [-Math.PI/2, 0, 0] },
    { dir: 'b' + dirSuffix, planeW: w, planeH: d,  pos: [cx, yMin, cz],   rot: [ Math.PI/2, 0, 0] },
  ];

  for (const f of faceList) {
    // Skip faces whose adjacent cell is a window in the same group (caller's
    // determination) — those faces sit inside the open window space.
    // Match skip entries against either the full suffixed dir
    // ('w-stair') OR the bare primary letter ('w'). Callers that
    // pass a dirSuffix (stairs use '-stair') typically build their
    // skip set with bare letters since the suffix is a per-call
    // detail — checking both forms keeps both styles working.
    if (skipFaces && (skipFaces.has(f.dir) || skipFaces.has(primaryDir(f.dir)))) continue;
    const canvas = document.createElement('canvas');
    canvas.width  = Math.max(1, Math.round(f.planeW * 100));
    canvas.height = Math.max(1, Math.round(f.planeH * 100));
    // Start blank (fully transparent). Painted lumels will show as opaque pixels.
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const texture = new THREE.CanvasTexture(canvas);
    texture.minFilter = THREE.NearestFilter;
    texture.magFilter = THREE.NearestFilter;
    texture.generateMipmaps = false;

    const mat = new THREE.MeshBasicMaterial({
      map: texture,
      transparent: true,
      // alphaTest: discard pixels with canvas alpha below 0.5. Empty
      // (unpainted) canvases have alpha=0 everywhere, so they don't
      // render OR cast shadow — keeps the rogue "invisible staircase"
      // shadow from coming back when paint planes are added to
      // surfaces with no paint yet. Painted pixels (alpha=1 from
      // brush strokes) DO cast shadow, so paint on a glass pane
      // throws its silhouette onto the floor like any opaque decal.
      alphaTest: 0.5,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits:  -2,
      side: THREE.DoubleSide,
    });
    const geom = new THREE.PlaneGeometry(f.planeW, f.planeH);
    const mesh = new THREE.Mesh(geom, mat);
    mesh.position.set(f.pos[0], f.pos[1], f.pos[2]);
    mesh.rotation.set(f.rot[0], f.rot[1], f.rot[2]);
    mesh.renderOrder = 10;
    mesh.userData = {
      paintPlane: true,
      rect,
      // For vertical faces (n/s/w/e), h is the on-canvas Y meters; for
      // sub-region planes (sill/lintel/header) that's the sub-height, not
      // the full wall height. Top/bottom faces ignore h (they hardcode
      // 100x100 lumels), so storing yh works for all six faces.
      h: yh,
      dir: f.dir,
      canvas, texture,
      planeW: f.planeW, planeH: f.planeH,
      wallId: wallRef?.id || null,
    };
    // Kick off base-texture loading if this wall has one.
    if (wallRef?.baseTexture?.dataUrl) ensureBaseTexture(wallRef);

    // Populate canvas with existing paint + jpeg data for any cells the rect covers.
    composeRectFaceCanvas(mesh);
    // Subscribe to face-change events so async JPEG loads (and future
    // out-of-band updates) refresh this plane's canvas.
    const off = onFaceChanged((key) => {
      // Base-texture load signal: "__base:<wallId>"
      if (key.startsWith('__base:')) {
        const wId = key.slice(7);
        if (mesh.userData.wallId === wId) composeRectFaceCanvas(mesh);
        return;
      }
      const [rs, cs, kdir] = key.split(',');
      const kr = +rs, kc = +cs;
      if (kdir !== f.dir) return;
      if (kr < rect.r0 || kr > rect.r1 || kc < rect.c0 || kc > rect.c1) return;
      composeRectFaceCanvas(mesh);
    });
    mesh.userData._unsubscribe = off;
    out.push(mesh);
    _planes.push(mesh);
  }
  return out;
}

export function clearPaintPlanes() {
  // Tear down any per-plane face-change subscriptions.
  for (const p of _planes) p.userData._unsubscribe?.();
  _planes = [];
  // Lazy per-cell paint planes for floor/ceiling were parented to
  // _paintRoot. Remove them from the scene too so old detached meshes don't
  // accumulate every time the wall/floor system rebuilds — paint DATA lives
  // in the sidecar (_paint Map), so the next paint hit will re-create the
  // cell plane and compose the existing bytes into it.
  if (_paintRoot) {
    while (_paintRoot.children.length) _paintRoot.remove(_paintRoot.children[0]);
  }
  _cellPlaneIndex.clear();
}

// Re-render a rect's face canvas. Layer order (top to bottom by rendering):
//   1. Per-face JPEGs (per-cell, tiled per cell-face)
//   2. Paint lumels (per-cell-face palette indices)
// The wall's BASE JPEG is rendered directly on the wall geometry via UV-based
// projection (see walls.js makeWallTextureMaterial). The paint plane sits on
// top of the wall and is transparent where unpainted, so the base shows
// through naturally.
function composeRectFaceCanvas(planeMesh) {
  const { rect, h, dir, canvas } = planeMesh.userData;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  // Per-face JPEGs
  for (let r = rect.r0; r <= rect.r1; r++) {
    for (let c = rect.c0; c <= rect.c1; c++) {
      const jpeg = getJpegAt(r, c, dir);
      if (jpeg && jpeg.loaded) drawJpegIntoCanvas(ctx, jpeg, dir, rect, r, c, h);
    }
  }
  // Paint lumels
  for (let r = rect.r0; r <= rect.r1; r++) {
    for (let c = rect.c0; c <= rect.c1; c++) {
      const bytes = getPaintAt(r, c, dir);
      if (bytes) drawCellIntoCanvas(ctx, bytes, dir, rect, r, c, h);
    }
  }
  planeMesh.userData.texture.needsUpdate = true;
}

// Draw a tiled JPEG into a cell-face's sub-region of the canvas.
function drawJpegIntoCanvas(ctx, jpegEntry, dir, rect, r, c, h) {
  const bdir = primaryDir(dir);
  let cw, ch;
  if (bdir === 't' || bdir === 'b') { cw = 100; ch = 100; }
  else                              { cw = 100; ch = Math.round(h * 100); }

  let pixelX, pixelY;
  if (bdir === 'n')      { pixelX = (rect.c1 - c) * cw;     pixelY = 0; }
  else if (bdir === 's') { pixelX = (c - rect.c0) * cw;     pixelY = 0; }
  else if (bdir === 'w') { pixelX = (r - rect.r0) * cw;     pixelY = 0; }
  else if (bdir === 'e') { pixelX = (rect.r1 - r) * cw;     pixelY = 0; }
  else if (bdir === 't') { pixelX = (c - rect.c0) * cw;     pixelY = (r - rect.r0) * ch; }
  else /* 'b' */         { pixelX = (c - rect.c0) * cw;     pixelY = (rect.r1 - r) * ch; }

  // JPEG natural pixel dimensions at 100 px / meter.
  const jpegPxW = Math.max(1, Math.round(jpegEntry.widthMeters  * 100));
  const jpegPxH = Math.max(1, Math.round(jpegEntry.heightMeters * 100));

  // Tile the JPEG over the cell-face region.
  ctx.save();
  ctx.beginPath();
  ctx.rect(pixelX, pixelY, cw, ch);
  ctx.clip();
  for (let ty = 0; ty < ch; ty += jpegPxH) {
    for (let tx = 0; tx < cw; tx += jpegPxW) {
      ctx.drawImage(jpegEntry.image, pixelX + tx, pixelY + ty, jpegPxW, jpegPxH);
    }
  }
  ctx.restore();
}

// Draw one cell's paint bytes into the canvas at the correct sub-rectangle.
function drawCellIntoCanvas(ctx, bytes, dir, rect, r, c, h) {
  const bdir = primaryDir(dir);
  // Determine the cell-face lumel dimensions based on face orientation + h.
  let cw, ch;
  if (bdir === 't' || bdir === 'b') { cw = 100; ch = 100; }                  // 1m x 1m
  else                              { cw = 100; ch = Math.round(h * 100); }   // 1m x h meters

  // Determine position in the rect's canvas. For each face dir, the rect's
  // U axis maps to either col-direction or row-direction; V axis is the
  // wall height (for vertical faces) or the other horizontal axis (for top/bottom).
  let pixelX, pixelY;
  if (bdir === 'n')      { pixelX = (rect.c1 - c) * cw;     pixelY = 0; }     // -Z face: mirror X so order matches
  else if (bdir === 's') { pixelX = (c - rect.c0) * cw;     pixelY = 0; }
  else if (bdir === 'w') { pixelX = (r - rect.r0) * cw;     pixelY = 0; }
  else if (bdir === 'e') { pixelX = (rect.r1 - r) * cw;     pixelY = 0; }
  else if (bdir === 't') { pixelX = (c - rect.c0) * cw;     pixelY = (r - rect.r0) * ch; }
  else /* 'b' */         { pixelX = (c - rect.c0) * cw;     pixelY = (rect.r1 - r) * ch; }

  // Decode bytes and paint per-lumel. Index 0 = transparent (skip).
  const palette = state.get().palette || [];
  for (let py = 0; py < ch; py++) {
    for (let px = 0; px < cw; px++) {
      const idx = bytes[py * cw + px];
      if (!idx) continue;
      const hex = palette[idx] || 0;
      const { r: rr, g: gg, b: bb } = hexToRgb(hex);
      ctx.fillStyle = `rgb(${rr},${gg},${bb})`;
      ctx.fillRect(pixelX + px, pixelY + py, 1, 1);
    }
  }
}

// Apply a paint hit at a world-space raycast result. Paints an N×N block
// around the hit pixel (N = brush size). Returns true if anything was
// painted.
//   hit: THREE.Raycaster hit (with .object, .uv, .point).
//   paletteIndex: 0..255 (0 = erase).
//   brushSize: integer 1..100 (number of lumels on each side of the square).
export function applyPaintHit(hit, paletteIndex, brushSize = _brushSize) {
  if (!hit) return false;
  // Object-surface paint: splat a square brush onto the mesh's paint
  // overlay canvas at the UV coords reported by Three's raycaster. The
  // overlay sits in front of the mesh's base material via polygonOffset,
  // so paint shows up regardless of what the original material is.
  if (hit.object?.userData?.paintableSurface === 'object') {
    return _applyObjectPaintHit(hit, paletteIndex, brushSize);
  }
  if (!hit.object?.userData?.paintPlane) return false;
  const plane = hit.object;
  const { canvas } = plane.userData;

  const u = hit.uv.x;
  const v = 1 - hit.uv.y;
  const centerX = Math.floor(u * canvas.width);
  const centerY = Math.floor(v * canvas.height);

  const size = Math.max(1, Math.min(100, brushSize | 0));
  const half = Math.floor(size / 2);
  let touched = false;
  let didErase = false;

  for (let dy = -half; dy < size - half; dy++) {
    for (let dx = -half; dx < size - half; dx++) {
      const px = centerX + dx;
      const py = centerY + dy;
      if (px < 0 || px >= canvas.width || py < 0 || py >= canvas.height) continue;
      const ok = paintLumelOnPlane(plane, px, py, paletteIndex);
      if (ok) touched = true;
      if (ok && paletteIndex === 0) didErase = true;
    }
  }

  // Erase needs a re-compose so any JPEG underneath comes back. Pure-paint
  // just needs the texture flagged for re-upload (per-pixel writes already done).
  if (didErase) composeRectFaceCanvas(plane);
  else plane.userData.texture.needsUpdate = true;
  return touched;
}

// Paint onto the mesh's overlay canvas at the hit's UV coords. Both modes
// target a brush of brushSize cm in WORLD space — matching walls/floor/
// ceiling. The difference is how the brush is rasterized when the mesh is
// non-uniformly scaled or skewed:
//
//   OFF (default) — area-isotropic square: draw a canvas square sized by
//     the average uv-per-meter at the face. On distorted meshes the dot
//     looks elongated because the UV mapping stretches along one axis.
//   ON  ("stay same dot") — anisotropic parallelogram: draw a parallelogram
//     on the canvas whose WORLD projection is a true N×N cm square. Dot
//     stays a clean square on the surface no matter how the mesh is scaled
//     or skewed.
function _applyObjectPaintHit(hit, paletteIndex, brushSize) {
  const mesh = hit.object;
  const canvas = mesh.userData?.paintCanvas;
  const texture = mesh.userData?.paintTexture;
  if (!canvas || !texture || !hit.uv) return false;
  const cx = hit.uv.x * canvas.width;
  const cy = (1 - hit.uv.y) * canvas.height;
  const sizeWorldMeters = brushSize * 0.01;
  const ctx = canvas.getContext('2d');
  const palette = state.get().palette || [];
  const hex = palette[paletteIndex] || 0;
  const { r, g, b } = paletteIndex === 0 ? { r: 0, g: 0, b: 0 } : hexToRgb(hex);

  // Clip to the hit triangle's COMPONENT SLOT in the atlas. attachPaintOverlays
  // gave each connected component its own 1/N × 1/N slot — without clipping,
  // a brush splat near a slot edge could leak into the neighbouring slot
  // (which is a physically different face on the mesh) and look like a
  // streak on the wrong face.
  const N = mesh.userData?.slotsPerSide || 1;
  if (N > 1) {
    const tilePx = canvas.width / N;
    const col = Math.min(N - 1, Math.max(0, Math.floor(hit.uv.x * N)));
    // canvas Y is top-down; atlas-UV V grows bottom-up → flip row index
    const canvasRow = Math.min(N - 1, Math.max(0, N - 1 - Math.floor(hit.uv.y * N)));
    ctx.save();
    ctx.beginPath();
    ctx.rect(col * tilePx, canvasRow * tilePx, tilePx, tilePx);
    ctx.clip();
  }

  let ok;
  if (_meshConstantDot) {
    ok = _drawWorldSquareOnMeshCanvas(ctx, canvas, hit, cx, cy, sizeWorldMeters, paletteIndex, r, g, b);
  } else {
    const scalePx = _canvasPixelsPerMeterAtHit(hit, canvas);
    const size = Math.max(1, Math.round(sizeWorldMeters * scalePx));
    const half = Math.floor(size / 2);
    const px = Math.floor(cx), py = Math.floor(cy);
    if (paletteIndex === 0) {
      ctx.clearRect(px - half, py - half, size, size);
    } else {
      ctx.fillStyle = `rgb(${r},${g},${b})`;
      ctx.fillRect(px - half, py - half, size, size);
    }
    ok = true;
  }
  if (N > 1) ctx.restore();
  if (ok) texture.needsUpdate = true;
  return ok;
}

// Rasterize a brush whose world-space footprint is a square of `worldMeters`
// at the hit face. Builds a 2D tangent basis in the face plane, expresses
// 1 m of world motion along each tangent axis as a (du, dv) UV gradient,
// converts that to canvas pixels, then fills the 4-corner canvas
// parallelogram that maps to the world square.
function _drawWorldSquareOnMeshCanvas(ctx, canvas, hit, cx, cy, worldMeters, paletteIndex, r, g, b) {
  const mesh = hit.object;
  const face = hit.face;
  if (!face) return false;
  const pos = mesh.geometry?.attributes?.position;
  const uv  = mesh.geometry?.attributes?.uv;
  if (!pos || !uv) return false;

  const vA = new THREE.Vector3().fromBufferAttribute(pos, face.a).applyMatrix4(mesh.matrixWorld);
  const vB = new THREE.Vector3().fromBufferAttribute(pos, face.b).applyMatrix4(mesh.matrixWorld);
  const vC = new THREE.Vector3().fromBufferAttribute(pos, face.c).applyMatrix4(mesh.matrixWorld);
  const e1 = vB.clone().sub(vA);
  const e2 = vC.clone().sub(vA);
  const normal = e1.clone().cross(e2);
  if (normal.lengthSq() < 1e-12) return false;
  normal.normalize();
  const u1 = e1.clone().normalize();              // tangent along e1
  const u2 = normal.clone().cross(u1).normalize(); // perp to u1, in plane

  const uvAx = uv.getX(face.a), uvAy = uv.getY(face.a);
  const uvBx = uv.getX(face.b), uvBy = uv.getY(face.b);
  const uvCx = uv.getX(face.c), uvCy = uv.getY(face.c);
  const eUVx = uvBx - uvAx, eUVy = uvBy - uvAy;          // uvB - uvA
  const fUVx = uvCx - uvAx, fUVy = uvCy - uvAy;          // uvC - uvA

  // Express u1, u2 in the (e1, e2) basis. e1·u1 = |e1|, e1·u2 = 0
  // (by construction). So the basis matrix M = [[|e1|, e2·u1],[0, e2·u2]].
  const e1u1 = e1.dot(u1);
  const e2u1 = e2.dot(u1);
  const e2u2 = e2.dot(u2);
  const det = e1u1 * e2u2;
  if (Math.abs(det) < 1e-12) return false;
  // M^-1 · (1,0) → (alpha1, beta1) = (1/|e1|, 0)
  // M^-1 · (0,1) → (alpha2, beta2) = (-e2u1/(|e1|·e2u2), 1/e2u2)
  const alpha1 = 1 / e1u1;
  const alpha2 = -e2u1 / (e1u1 * e2u2);
  const beta2  = 1 / e2u2;
  // UV gradient per 1 m of world motion along u1 and u2
  const duvU1_u = alpha1 * eUVx;
  const duvU1_v = alpha1 * eUVy;
  const duvU2_u = alpha2 * eUVx + beta2 * fUVx;
  const duvU2_v = alpha2 * eUVy + beta2 * fUVy;
  // Canvas vectors per 1 m of world along u1, u2. Canvas Y is top-down so
  // negate the V component to stay consistent with the cy flip above.
  const c1x = duvU1_u * canvas.width,  c1y = -duvU1_v * canvas.height;
  const c2x = duvU2_u * canvas.width,  c2y = -duvU2_v * canvas.height;

  const half = worldMeters / 2;
  const corners = [
    [-half, -half], [+half, -half], [+half, +half], [-half, +half],
  ];
  ctx.save();
  ctx.beginPath();
  for (let i = 0; i < 4; i++) {
    const [oa, ob] = corners[i];
    const dx = oa * c1x + ob * c2x;
    const dy = oa * c1y + ob * c2y;
    if (i === 0) ctx.moveTo(cx + dx, cy + dy);
    else         ctx.lineTo(cx + dx, cy + dy);
  }
  ctx.closePath();
  if (paletteIndex === 0) {
    ctx.globalCompositeOperation = 'destination-out';
    ctx.fillStyle = 'rgba(0,0,0,1)';
    ctx.fill();
  } else {
    ctx.fillStyle = `rgb(${r},${g},${b})`;
    ctx.fill();
  }
  ctx.restore();
  return true;
}

// Estimate "canvas pixels per world meter" at the raycast hit. We take the
// hit triangle, compute its area in world space (after applying the mesh's
// world matrix) and its area in UV space (0..1²), then sqrt the ratio to
// get a uv-units-per-meter scale. Multiplying by canvas.width yields canvas
// pixels per meter — the conversion factor that makes a paint brush the
// same visible size as on flat lumel surfaces.
const _v3a = new THREE.Vector3();
const _v3b = new THREE.Vector3();
const _v3c = new THREE.Vector3();
function _canvasPixelsPerMeterAtHit(hit, canvas) {
  const mesh = hit.object;
  const face = hit.face;
  if (!face) return canvas.width;
  const pos = mesh.geometry?.attributes?.position;
  const uv  = mesh.geometry?.attributes?.uv;
  if (!pos || !uv) return canvas.width;
  _v3a.fromBufferAttribute(pos, face.a).applyMatrix4(mesh.matrixWorld);
  _v3b.fromBufferAttribute(pos, face.b).applyMatrix4(mesh.matrixWorld);
  _v3c.fromBufferAttribute(pos, face.c).applyMatrix4(mesh.matrixWorld);
  const e1x = _v3b.x - _v3a.x, e1y = _v3b.y - _v3a.y, e1z = _v3b.z - _v3a.z;
  const e2x = _v3c.x - _v3a.x, e2y = _v3c.y - _v3a.y, e2z = _v3c.z - _v3a.z;
  // |cross| = area * 2
  const cx = e1y * e2z - e1z * e2y;
  const cy = e1z * e2x - e1x * e2z;
  const cz = e1x * e2y - e1y * e2x;
  const worldArea = 0.5 * Math.sqrt(cx * cx + cy * cy + cz * cz);
  const ua = uv.getX(face.a), va = uv.getY(face.a);
  const ub = uv.getX(face.b), vb = uv.getY(face.b);
  const uc = uv.getX(face.c), vc = uv.getY(face.c);
  const uvArea = 0.5 * Math.abs((ub - ua) * (vc - va) - (vb - va) * (uc - ua));
  if (worldArea < 1e-9 || uvArea < 1e-12) return canvas.width;
  const uvPerMeter = Math.sqrt(uvArea / worldArea);
  return uvPerMeter * canvas.width;
}

// Paint a single lumel at canvas pixel (px, py) on the given paint plane.
// Returns true if the pixel was within a valid cell-face slot.
function paintLumelOnPlane(plane, px, py, paletteIndex) {
  const { rect, h, dir, canvas } = plane.userData;
  const bdir = primaryDir(dir);

  let cw, ch;
  if (bdir === 't' || bdir === 'b') { cw = 100; ch = 100; }
  else                              { cw = 100; ch = Math.round(h * 100); }

  let cellOffsetX, cellOffsetY = 0;
  let r, c;
  if (bdir === 'n')      { cellOffsetX = Math.floor(px / cw); c = rect.c1 - cellOffsetX; r = rect.r0; }
  else if (bdir === 's') { cellOffsetX = Math.floor(px / cw); c = rect.c0 + cellOffsetX; r = rect.r1; }
  else if (bdir === 'w') { cellOffsetX = Math.floor(px / cw); r = rect.r0 + cellOffsetX; c = rect.c0; }
  else if (bdir === 'e') { cellOffsetX = Math.floor(px / cw); r = rect.r1 - cellOffsetX; c = rect.c1; }
  else if (bdir === 't') { cellOffsetX = Math.floor(px / cw); cellOffsetY = Math.floor(py / ch); c = rect.c0 + cellOffsetX; r = rect.r0 + cellOffsetY; }
  else                   { cellOffsetX = Math.floor(px / cw); cellOffsetY = Math.floor(py / ch); c = rect.c0 + cellOffsetX; r = rect.r1 - cellOffsetY; }

  const localX = px - cellOffsetX * cw;
  const localY = (bdir === 't' || bdir === 'b') ? (py - cellOffsetY * ch) : py;
  if (localX < 0 || localX >= cw || localY < 0 || localY >= ch) return false;

  let bytes = getPaintAt(r, c, dir);
  if (!bytes || bytes.length !== cw * ch) bytes = new Uint8Array(cw * ch);
  bytes[localY * cw + localX] = paletteIndex & 0xff;
  setPaintAt(r, c, dir, bytes);

  // Update the canvas pixel directly for paint; erase is handled by the
  // caller via a full recompose (so the JPEG underneath re-appears).
  if (paletteIndex !== 0) {
    const ctx = canvas.getContext('2d');
    const palette = state.get().palette || [];
    const hex = palette[paletteIndex] || 0;
    const { r: rr, g: gg, b: bb } = hexToRgb(hex);
    ctx.fillStyle = `rgb(${rr},${gg},${bb})`;
    ctx.fillRect(px, py, 1, 1);
  }
  return true;
}

// Raycast from camera through screen center; returns the closest hit on a
// paint plane OR a backing surface (floor/ceiling). Backing-surface hits are
// routed through ensureLazyCellPlane() so the caller receives a hit on a
// proper paint plane (with correct uv) regardless of where it landed.
const _raycaster = new THREE.Raycaster();
const _origin = new THREE.Vector2(0, 0);
export function raycastPaintPlane(camera) {
  _raycaster.setFromCamera(_origin, camera);
  // Raycast paint planes + backing meshes together so the closest surface
  // wins (a paint plane sitting in front of the floor occludes the floor hit
  // because it's closer along the ray).
  const targets = _backingMeshes.length
    ? _planes.concat(_backingMeshes)
    : _planes;
  const hits = _raycaster.intersectObjects(targets, false);
  if (!hits.length) return null;
  const hit = hits[0];

  // Direct paint-plane hit — return as-is.
  if (hit.object?.userData?.paintPlane) return hit;

  // Backing-surface hit. 'floor' / 'ceiling' route through the lazy
  // per-cell paint plane builder + re-raycast. 'object' (meshes) pass
  // through with their geometry-UV intact so applyPaintHit can splat onto
  // the mesh's paint overlay canvas directly.
  const kind = hit.object?.userData?.paintableSurface;
  if (kind === 'object') return hit;
  if (kind !== 'floor' && kind !== 'ceiling') return null;
  const plane = ensureLazyCellPlane(hit, kind);
  if (!plane) return null;
  const planeHits = _raycaster.intersectObject(plane, false);
  return planeHits.length ? planeHits[0] : null;
}

// Find or create a 1×1 m paint plane for the cell under the hit point on a
// backing surface. dir = 't' for floor (face up), 'b' for ceiling (face
// down). The plane is parented to _paintRoot (must be set via setPaintRoot
// at engine init) so it survives floor/ceiling rebuilds.
function ensureLazyCellPlane(hit, kind) {
  if (!_paintRoot) return null;
  const s = state.get();
  const cs = s.grid.cellSizeMeters;
  const col = Math.floor(hit.point.x / cs) + 1;     // 1-based
  const row = Math.floor(hit.point.z / cs);          // 0-based
  if (col < 1 || col > s.grid.cols || row < 0 || row >= s.grid.rows) return null;
  const dir = (kind === 'ceiling') ? 'b' : 't';
  const key = `${row},${col},${dir}`;
  if (_cellPlaneIndex.has(key)) return _cellPlaneIndex.get(key);
  const cx = (col - 0.5) * cs;
  const cz = (row + 0.5) * cs;
  const y  = (dir === 't') ? s.floor.y : s.ceiling.y;
  return _createLazyCellPlane(row, col, dir, cx, y, cz, cs);
}

// Construct the per-cell paint plane. Lumel density matches the wall system
// (100 lumels/m → 100×100 canvas for 1 m cells) so paint feels consistent
// across surfaces. Used by both the lazy raycast path and the post-rebuild
// restoration path.
function _createLazyCellPlane(row, col, dir, cx, y, cz, cs) {
  const w = cs, h = cs;
  const canvas = document.createElement('canvas');
  canvas.width  = Math.max(1, Math.round(w * 100));
  canvas.height = Math.max(1, Math.round(h * 100));
  canvas.getContext('2d').clearRect(0, 0, canvas.width, canvas.height);
  const texture = new THREE.CanvasTexture(canvas);
  texture.minFilter = THREE.NearestFilter;
  texture.magFilter = THREE.NearestFilter;
  texture.generateMipmaps = false;
  const mat = new THREE.MeshBasicMaterial({
    map: texture,
    transparent: true,
    // Same alpha-test rationale as the buildPaintPlanesForRect path
    // above: discard unpainted pixels so empty canvases don't cast
    // phantom shadows, painted pixels cast like opaque decals.
    alphaTest: 0.5,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits:  -2,
    side: THREE.DoubleSide,
  });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat);
  mesh.position.set(cx, y, cz);
  // 't' face faces +Y (rotate -PI/2 around X); 'b' face faces -Y (+PI/2).
  mesh.rotation.x = (dir === 't') ? -Math.PI / 2 : Math.PI / 2;
  mesh.renderOrder = 10;
  const rect = { r0: row, r1: row, c0: col, c1: col, cellSize: cs };
  mesh.userData = {
    paintPlane: true,
    rect, h: cs,
    dir,
    canvas, texture,
    planeW: w, planeH: h,
    wallId: null,
  };
  _paintRoot.add(mesh);
  _planes.push(mesh);
  _cellPlaneIndex.set(`${row},${col},${dir}`, mesh);
  _lazyPaintedCells.add(`${row},${col},${dir}`);

  // If paint or JPEG already exists for this cell (re-loaded level, prior
  // session, or sidecar bytes from before the rebuild), compose so it shows
  // up immediately.
  composeRectFaceCanvas(mesh);
  return mesh;
}

// Apply a JPEG to whichever cell-face the raycast hit. `src` can be a level-
// relative asset url (preferred) or an inline dataUrl. Sizing mode determines
// how widthMeters/heightMeters are derived.
export function applyJpegFromHit(hit, src, sizingMode = 'fixed') {
  if (!hit?.object?.userData?.paintPlane) return false;
  const plane = hit.object;
  const { rect, h, dir, canvas } = plane.userData;
  const bdir = primaryDir(dir);
  const u = hit.uv.x;
  const v = 1 - hit.uv.y;
  const px = Math.floor(u * canvas.width);
  const py = Math.floor(v * canvas.height);

  let cw, ch;
  if (bdir === 't' || bdir === 'b') { cw = 100; ch = 100; }
  else                              { cw = 100; ch = Math.round(h * 100); }

  let cellOffsetX, cellOffsetY = 0;
  let r, c;
  if (bdir === 'n')      { cellOffsetX = Math.floor(px / cw); c = rect.c1 - cellOffsetX; r = rect.r0; }
  else if (bdir === 's') { cellOffsetX = Math.floor(px / cw); c = rect.c0 + cellOffsetX; r = rect.r1; }
  else if (bdir === 'w') { cellOffsetX = Math.floor(px / cw); r = rect.r0 + cellOffsetX; c = rect.c0; }
  else if (bdir === 'e') { cellOffsetX = Math.floor(px / cw); r = rect.r1 - cellOffsetX; c = rect.c1; }
  else if (bdir === 't') { cellOffsetX = Math.floor(px / cw); cellOffsetY = Math.floor(py / ch); c = rect.c0 + cellOffsetX; r = rect.r0 + cellOffsetY; }
  else                   { cellOffsetX = Math.floor(px / cw); cellOffsetY = Math.floor(py / ch); c = rect.c0 + cellOffsetX; r = rect.r1 - cellOffsetY; }

  setJpegAt(r, c, dir, src, sizingMode);
  return true;
}
