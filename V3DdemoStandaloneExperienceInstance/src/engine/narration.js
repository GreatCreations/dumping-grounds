// engine/narration.js — Narration story system (Phase 1 minimum).
//
// Responsibilities:
//   - Fetch stories from /api/story-load on preview load + when the
//     marker set in state changes.
//   - Evaluate triggers at ~10 Hz against the player's cell position.
//     Phase 1 supports `distance` (cells) and `always`.
//   - Maintain the playingStories list: which stories are currently
//     showing, on which frame, since when. Replay state is in-memory
//     only (no localStorage / IndexedDB) — resets every preview load.
//   - Render the currently-visible box for each playing story as a 3D
//     billboard quad in the scene, with placeholder text painted to a
//     CanvasTexture. World-up rotation so text doesn't tilt with
//     camera pitch.
//   - Handle clicks (raycast against box meshes) to advance.
//
// What's NOT here (Phase 2+): seamless border merging across grouped
// boxes, attached-story parallel play, per-character rich text editor,
// buttons (CYOA branching), time-based advance, library import/export,
// pop-out modal storyboard editor.

import * as THREE from 'three';
import { rowIdToIndex } from '../core/grid-addr.js';
import { NARRATION_FONTS } from '../core/narration-fonts.js';

const TICK_HZ = 10;
const TICK_MS = 1000 / TICK_HZ;

// Preload every narration font so the first box rendered after preview
// load actually uses the requested font instead of Canvas's silent
// default-font fallback. Google Fonts are async — the <link> CSS tells
// the browser to fetch them, but Canvas2D won't WAIT for them when
// drawText runs; it just uses whatever's available right now. Without
// this preload, a fresh narration box renders in sans-serif and stays
// that way (the texture is cached) until the user re-edits text, which
// invalidates the cache and the second render gets the loaded font.
//
// We resolve a promise per font via document.fonts.load() (which both
// triggers the load AND resolves when ready). When all preload promises
// settle we set _fontsLoaded so freshly-rendered boxes go through with
// the right font, and we flush the texture cache + ping every active
// narration system to rebuild its live boxes so already-rendered boxes
// pick up the loaded fonts retroactively.
let _fontsLoaded = false;
const _fontReadyHooks = new Set();
if (typeof document !== 'undefined' && document.fonts) {
  Promise.all(
    NARRATION_FONTS
      // Comic Sans MS is OS-installed and always "loaded" — skip.
      .filter(f => f !== 'Comic Sans MS')
      // load("14px FontName") triggers load + resolves on ready.
      .map(f => document.fonts.load(`14px "${f}"`).catch(() => null))
  ).then(() => {
    _fontsLoaded = true;
    for (const fn of _fontReadyHooks) { try { fn(); } catch {} }
  });
}

export function createNarrationSystem(scene, getStateFn) {
  const root = new THREE.Group();
  root.name = 'narration-root';
  scene.add(root);

  const storyCache = new Map();   // storyId → story object
  // playingStories: { storyId, currentFrameId, frameStartTime, hasPlayed, markerId }
  const playingStories = [];
  // hasPlayed per markerId — story has ENDED for this marker AND the
  // marker's replay mode is 'once-per-load'. Permanent for the session.
  const hasPlayedSet = new Set();
  // endedInZoneSet per markerId — story has ENDED for this marker
  // AND replay mode is 'restart'. The story stops showing, but
  // does NOT immediately re-fire while the player remains inside
  // the trigger zone. The flag clears when the player walks out,
  // re-arming the marker for the next entry. This is what
  // distinguishes the two replay modes: 'once-per-load' is final;
  // 'restart' is paused-until-leave-and-return.
  const endedInZoneSet = new Set();

  let lastTickMs = 0;

  // Box meshes are keyed by `${storyId}:${frameId}` so click handlers
  // know which story+frame they hit. mesh.userData.storyId/frameId set.
  const liveBoxes = new Map();

  // Texture cache so the same text isn't re-rasterized each rebuild.
  const textureCache = new Map();  // textKey → CanvasTexture
  // When fonts finish loading post-init, drop any textures that were
  // rasterized BEFORE the load (they used the canvas default font
  // fallback) and rebuild the live boxes so they re-render with the
  // proper font. Without this, the first batch of boxes rendered at
  // preview start looks like sans-serif until the player triggers
  // them again with an edit.
  _fontReadyHooks.add(() => {
    textureCache.clear();
    refreshLiveBoxes();
  });

  // Measure a multi-run text array's rendered bounds at the current
  // font metrics. Returns { width, height } in metres so buildBoxMesh
  // can size 'auto' boxes around their content. Same word-wrap +
  // line-height math as buildTextTexture, but offscreen — no canvas
  // texture allocated.
  function measureText(text, opts) {
    const runs = Array.isArray(text) && text.length ? text : [];
    if (!runs.length) return { width: 0.6, height: 0.3 };
    const pxPerM = 256;
    const fontScale = pxPerM / 100;
    const pad = 0.06 * pxPerM;
    const maxWidthM = opts?.maxWidth ?? 4.0;
    const maxWidthPx = Math.max(120, Math.round(maxWidthM * pxPerM));
    // Use a tiny offscreen canvas just for measureText calls.
    const measureCv = document.createElement('canvas');
    measureCv.width = 8; measureCv.height = 8;
    const mctx = measureCv.getContext('2d');
    const fontStr = (style) => {
      const weight = style.weight === 'bold' ? 'bold ' : '';
      const italic = style.italic ? 'italic ' : '';
      const size = (style.size || 14) * fontScale;
      const family = style.font || 'Permanent Marker';
      return `${italic}${weight}${size}px "${family}", sans-serif`;
    };
    // Tokenize runs into words + spaces.
    const tokens = [];
    for (const run of runs) {
      const chars = run.chars || '';
      const style = run.style || {};
      for (const p of chars.split(/(\s+)/)) {
        if (!p) continue;
        tokens.push({ chars: p, style, isSpace: /^\s+$/.test(p) });
      }
    }
    // Lay out lines with the same wrap rule buildTextTexture uses.
    const maxW = maxWidthPx - 2 * pad;
    const lines = [];
    let curLine = [], curW = 0;
    for (const tok of tokens) {
      mctx.font = fontStr(tok.style);
      const tw = mctx.measureText(tok.chars).width;
      if (tok.isSpace) {
        if (!curLine.length) continue;
        curLine.push({ ...tok, w: tw }); curW += tw;
        continue;
      }
      if (curW + tw > maxW && curLine.length) {
        while (curLine.length && curLine[curLine.length - 1].isSpace) curLine.pop();
        lines.push(curLine); curLine = []; curW = 0;
      }
      curLine.push({ ...tok, w: tw }); curW += tw;
    }
    if (curLine.length) {
      while (curLine.length && curLine[curLine.length - 1].isSpace) curLine.pop();
      lines.push(curLine);
    }
    // Pixel bounds = max line width + line heights summed.
    let usedW = 0;
    let totalH = 0;
    for (const line of lines) {
      const lineW = line.reduce((a, t) => a + t.w, 0);
      if (lineW > usedW) usedW = lineW;
      totalH += Math.max(...line.map(t => (t.style.size || 14) * fontScale * 1.2));
    }
    return {
      width:  (usedW   + 2 * pad) / pxPerM,
      height: (totalH  + 2 * pad) / pxPerM,
    };
  }

  // Group anchors + strokes for the union-polygon border merging.
  // groupAnchors[gid] = THREE.Group at the group's centroid, yawed
  // toward the camera. groupStrokes[gid] = LineSegments child whose
  // geometry is rebuilt each frame as the camera's POV changes.
  const groupAnchors = new Map();
  const groupStrokes = new Map();

  // Build a CanvasTexture for a multi-run text array. Runs flow into
  // each other (not on separate lines). Word-wrap respects each word's
  // own style metrics. Line height = max font size on the current line.
  // opts.noStroke   — omit the bordered rect (used for grouped boxes
  //                   whose unified outline is drawn separately).
  // opts.width/height — world-meter dimensions of the parent quad.
  //                   The canvas resolution scales accordingly so px
  //                   density stays constant regardless of box size,
  //                   keeping text sharp on big boxes.
  // opts.border     — { stroke, weight, shape } from box.border.
  // opts.fill       — { color, opacity } from box.fill.
  function buildTextTexture(text, opts) {
    const runs = Array.isArray(text) && text.length
      ? text
      : [{ chars: '', style: { font: 'Permanent Marker', size: 14, color: '#000', weight: 'normal' } }];
    const noStroke   = !!opts?.noStroke;
    const worldW     = opts?.width  ?? 1.6;
    const worldH     = opts?.height ?? 0.8;
    const border     = opts?.border || { stroke: '#0b0d14', weight: 2 };
    const fill       = opts?.fill   || { color: '#ffffff', opacity: 1 };
    const key = JSON.stringify(runs)
              + `|${noStroke ? 'ns' : 'st'}|${worldW.toFixed(2)}x${worldH.toFixed(2)}`
              + `|${border.stroke}|${border.weight}|${fill.color}|${fill.opacity}`;
    if (textureCache.has(key)) return textureCache.get(key);
    // 256 px per metre keeps text crisp at typical reading distances
    // and scales naturally with box size. Cap at 2048 max edge so a
    // giant box doesn't allocate a gargantuan canvas.
    const pxPerM = 256;
    const W = Math.min(2048, Math.max(64, Math.round(worldW * pxPerM)));
    const H = Math.min(2048, Math.max(64, Math.round(worldH * pxPerM)));
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const ctx = c.getContext('2d');
    ctx.fillStyle = fill.color || '#ffffff';
    ctx.fillRect(0, 0, W, H);
    if (!noStroke) {
      ctx.strokeStyle = border.stroke || '#0b0d14';
      // Scale stroke weight by pxPerM/100 to keep visual line width
      // consistent across box sizes. 'weight' is a unitless number
      // (1-5 typical).
      const sw = (border.weight ?? 2) * pxPerM / 100;
      ctx.lineWidth = sw;
      ctx.strokeRect(sw / 2, sw / 2, W - sw, H - sw);
    }
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';

    // Flatten runs into a sequence of styled tokens: words + the spaces
    // between them. Preserves source ordering across runs so text from
    // run A wraps naturally into the next line with run B's style.
    const tokens = [];   // { chars, style, isSpace }
    for (const run of runs) {
      const chars = run.chars || '';
      const style = run.style || {};
      // Split into words + whitespace runs.
      const parts = chars.split(/(\s+)/);
      for (const p of parts) {
        if (!p) continue;
        tokens.push({ chars: p, style, isSpace: /^\s+$/.test(p) });
      }
    }

    // Font-size scale: style.size is given in "design units" (~14 = a
    // readable narration size). Convert to canvas pixels by multiplying
    // by pxPerM/100 so the visual reading size stays constant across
    // box dimensions. Previously hardcoded 2× was correct only for the
    // old fixed 512×256 canvas; now the canvas size grows with the box.
    const fontScale = pxPerM / 100;
    const pad = Math.round(0.06 * pxPerM);   // 6 cm padding inside the border
    function fontStr(style) {
      const weight = style.weight === 'bold' ? 'bold ' : (style.weight === 'normal' ? '' : (style.weight ? style.weight + ' ' : ''));
      const italic = style.italic ? 'italic ' : '';
      const size = (style.size || 14) * fontScale;
      const family = style.font || 'Permanent Marker';
      return `${italic}${weight}${size}px "${family}", sans-serif`;
    }
    function measure(tok) {
      ctx.font = fontStr(tok.style);
      return ctx.measureText(tok.chars).width;
    }

    // Lay out tokens into lines. Drop leading-whitespace tokens of a
    // new line. Wrap when adding a non-space token would overflow.
    const maxW = W - 2 * pad;
    const lines = [];
    let curLine = [];
    let curW = 0;
    for (const tok of tokens) {
      const tw = measure(tok);
      if (tok.isSpace) {
        if (!curLine.length) continue;  // skip leading whitespace
        curLine.push({ ...tok, w: tw });
        curW += tw;
        continue;
      }
      // Non-space token. If adding it overflows, wrap.
      if (curW + tw > maxW && curLine.length) {
        // Strip trailing space tokens from current line.
        while (curLine.length && curLine[curLine.length - 1].isSpace) curLine.pop();
        lines.push(curLine);
        curLine = [];
        curW = 0;
      }
      curLine.push({ ...tok, w: tw });
      curW += tw;
    }
    if (curLine.length) {
      while (curLine.length && curLine[curLine.length - 1].isSpace) curLine.pop();
      lines.push(curLine);
    }

    // Render lines.
    let y = pad;
    for (const line of lines) {
      const lineH = Math.max(...line.map(t => (t.style.size || 14) * fontScale * 1.2));
      if (y > H - lineH) break;
      let x = pad;
      for (const tok of line) {
        ctx.font = fontStr(tok.style);
        ctx.fillStyle = tok.style.color || '#000000';
        ctx.fillText(tok.chars, x, y);
        x += tok.w;
      }
      y += lineH;
    }

    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.minFilter = THREE.LinearFilter;
    tex.needsUpdate = true;
    textureCache.set(key, tex);
    return tex;
  }

  function buildBoxMesh(story, frameId, box, boxIdx, marker, cellSize) {
    // Width/height in metres. When either dimension is 'auto', measure
    // the laid-out text and size the box to fit (with padding). When
    // a fixed metre value is set, that value wins regardless of
    // content. Min and max clamps keep auto-sized boxes from being
    // too tiny (illegible) or absurdly wide (off-screen).
    const isAutoW = (box.width  === 'auto' || box.width  == null);
    const isAutoH = (box.height === 'auto' || box.height == null);
    let w, h;
    if (isAutoW || isAutoH) {
      const m = measureText(box.text, {
        // Cap measurement width at 4m so long unbroken paragraphs
        // wrap rather than producing a 20-metre-wide box.
        maxWidth: isAutoW ? 4.0 : Number(box.width),
      });
      w = isAutoW ? Math.max(0.6, Math.min(4.0, m.width  + 0.16)) : Number(box.width);
      h = isAutoH ? Math.max(0.3, Math.min(3.0, m.height + 0.16)) : Number(box.height);
    } else {
      w = Number(box.width);
      h = Number(box.height);
    }
    const geom = new THREE.PlaneGeometry(w, h);
    const tex  = buildTextTexture(box.text, { width: w, height: h, border: box.border, fill: box.fill });
    const mat  = new THREE.MeshBasicMaterial({ map: tex, side: THREE.DoubleSide, transparent: false });
    const mesh = new THREE.Mesh(geom, mat);
    // Position = marker's world cell centre + box.cellOffset.
    const rIdx = rowIdToIndex(marker.rowId);
    const x = (marker.col - 1 + 0.5) * cellSize + (box.cellOffset?.dx || 0);
    const y = (box.cellOffset?.dy ?? 1.5);
    const z = (rIdx + 0.5) * cellSize + (box.cellOffset?.dz || 0);
    mesh.position.set(x, y, z);
    mesh.userData.narration = true;
    mesh.userData.storyId   = story.id;
    mesh.userData.frameId   = frameId;
    mesh.userData.markerId  = marker.id;
    mesh.userData.boxId     = box.id;
    mesh.userData.boxIdx    = boxIdx;
    mesh.userData.kind      = 'box';
    mesh.userData.boxW      = w;
    mesh.userData.boxH      = h;
    // Cached for P2-F: lets updateBillboards rebuild the texture
    // with noStroke=true when this box joins a group (the per-box
    // border is suppressed in favour of a single union outline
    // drawn around the whole group).
    mesh.userData.boxText   = box.text;
    mesh.userData.boxBorder = box.border;
    mesh.userData.boxFill   = box.fill;
    mesh.userData.inGroup   = false;
    return mesh;
  }

  // Compute the OUTLINE of the union of axis-aligned rectangles using
  // a critical-line sweep: collect every distinct x and y edge, then
  // for each candidate edge segment between consecutive critical lines
  // sample just above/below (or left/right) — keep the segment only
  // when exactly one side is inside any rectangle. Handles overlapping,
  // touching, and disjoint rectangles correctly. O(R²) but R is small
  // (a single marker group typically holds 2-5 boxes), so the cost is
  // a few hundred microseconds per frame.
  function unionBoundarySegments(rects) {
    if (!rects.length) return [];
    const EPS = 1e-4;
    const xs = [...new Set(rects.flatMap(r => [r.x1, r.x2]))].sort((a, b) => a - b);
    const ys = [...new Set(rects.flatMap(r => [r.y1, r.y2]))].sort((a, b) => a - b);
    const isInside = (x, y) => {
      for (const r of rects) {
        if (x > r.x1 && x < r.x2 && y > r.y1 && y < r.y2) return true;
      }
      return false;
    };
    const segs = [];
    // Horizontal edges at each critical y.
    for (const y of ys) {
      for (let i = 0; i < xs.length - 1; i++) {
        const xa = xs[i], xb = xs[i + 1];
        const mx = (xa + xb) / 2;
        if (isInside(mx, y + EPS) !== isInside(mx, y - EPS)) {
          segs.push({ x1: xa, y1: y, x2: xb, y2: y });
        }
      }
    }
    // Vertical edges at each critical x.
    for (const x of xs) {
      for (let i = 0; i < ys.length - 1; i++) {
        const ya = ys[i], yb = ys[i + 1];
        const my = (ya + yb) / 2;
        if (isInside(x + EPS, my) !== isInside(x - EPS, my)) {
          segs.push({ x1: x, y1: ya, x2: x, y2: yb });
        }
      }
    }
    return segs;
  }

  // Rebuild a box's texture with the opposite noStroke value. Used when
  // a box joins/leaves a group: the per-box stroke is baked into the
  // canvas, so swapping needs a fresh raster. The texture cache keys
  // on the noStroke flag too, so the two variants are cached separately
  // and the swap is O(1) on the second toggle.
  function rebuildBoxTextureForGroup(mesh, noStroke) {
    const ud = mesh.userData;
    const tex = buildTextTexture(ud.boxText, {
      width: ud.boxW, height: ud.boxH,
      border: ud.boxBorder, fill: ud.boxFill,
      noStroke,
    });
    mesh.material.map = tex;
    mesh.material.needsUpdate = true;
  }

  // Button meshes per BOX (not per frame). Each box's buttons are
  // laid out below that box, flowing into rows of N (box.buttonsPerRow)
  // before wrapping. Buttons render at a FIXED size — text scales to
  // fit inside; no auto-resize that would change the layout when
  // content changes. The same stroke recipe as the box itself is used
  // so visual weight matches.
  function buildButtonMeshes(story, frameId, box, marker, cellSize, mainMesh) {
    if (!box.buttons?.length) return [];
    const list = [];
    // Fixed button geometry. Width/height are constant so layout is
    // predictable. Per-button label rendering scales the text down to
    // fit; the QUAD itself never changes size from button to button.
    const BTN_W = 0.55;
    const BTN_H = 0.24;
    const BTN_GAP_X = 0.06;
    const BTN_GAP_Y = 0.06;
    const mainH = mainMesh.userData.boxH;
    const perRow = Math.max(1, box.buttonsPerRow || 3);
    const rowCount = Math.ceil(box.buttons.length / perRow);
    // Stroke recipe matches the box's stroke weight at the box-canvas
    // scale; both end up the same world-line thickness because both
    // textures share the same px-per-meter density (~256 px per metre
    // at the new texture resolution).
    const strokeWeight = box.border?.weight ?? 2;
    const strokeColor  = box.border?.stroke ?? '#0b0d14';
    const fillColor    = box.fill?.color    ?? '#ffffff';
    for (let i = 0; i < box.buttons.length; i++) {
      const btn = box.buttons[i];
      const row = Math.floor(i / perRow);
      const col = i % perRow;
      const cellsInThisRow = (row === rowCount - 1)
        ? (box.buttons.length - row * perRow)
        : perRow;
      const rowWidth = cellsInThisRow * BTN_W + (cellsInThisRow - 1) * BTN_GAP_X;
      const rowStartX = -rowWidth / 2;
      const localX = rowStartX + col * (BTN_W + BTN_GAP_X) + BTN_W / 2;
      const localY = -mainH / 2 - BTN_GAP_Y - row * (BTN_H + BTN_GAP_Y) - BTN_H / 2;
      const tex = buildButtonTexture(btn.label || '?', strokeWeight, strokeColor, fillColor);
      const geom = new THREE.PlaneGeometry(BTN_W, BTN_H);
      const mat  = new THREE.MeshBasicMaterial({ map: tex, side: THREE.DoubleSide, transparent: false });
      const mesh = new THREE.Mesh(geom, mat);
      mesh.position.set(localX, localY, 0);
      mesh.userData.narration = true;
      mesh.userData.kind      = 'button';
      mesh.userData.storyId   = story.id;
      mesh.userData.frameId   = frameId;
      mesh.userData.markerId  = marker.id;
      mesh.userData.boxId     = box.id;
      mesh.userData.target    = btn.target;
      list.push(mesh);
    }
    return list;
  }

  // Dedicated button-texture builder — fixed canvas resolution sized
  // for crisp text at the button's world dimensions. Uses the same
  // fill/stroke recipe as the parent box so visual weight matches.
  // Text auto-shrinks to fit the button width (single-line, ellipsis
  // never applied — strings designed for buttons stay short).
  function buildButtonTexture(label, strokeWeight, strokeColor, fillColor) {
    const key = `btn|${label}|${strokeWeight}|${strokeColor}|${fillColor}`;
    if (textureCache.has(key)) return textureCache.get(key);
    const W = 256, H = 112;
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const ctx = c.getContext('2d');
    ctx.fillStyle = fillColor;
    ctx.fillRect(0, 0, W, H);
    // Stroke at 4× the world weight (canvas pixels are ~4× tighter
    // than 1 metre × 1 metre at this size) so it visually matches
    // the box's stroke.
    ctx.strokeStyle = strokeColor;
    ctx.lineWidth   = strokeWeight * 2;
    ctx.strokeRect(strokeWeight, strokeWeight, W - 2 * strokeWeight, H - 2 * strokeWeight);
    // Text auto-fit: start at 36 px, shrink until measuredWidth < W*0.85.
    ctx.fillStyle = strokeColor;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    let fontPx = 36;
    while (fontPx > 12) {
      ctx.font = `bold ${fontPx}px "Permanent Marker", sans-serif`;
      if (ctx.measureText(label).width < W * 0.85) break;
      fontPx -= 2;
    }
    ctx.fillText(label, W / 2, H / 2);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.minFilter = THREE.LinearFilter;
    tex.needsUpdate = true;
    textureCache.set(key, tex);
    return tex;
  }

  function clearLiveBoxes() {
    for (const [, mesh] of liveBoxes) {
      root.remove(mesh);
      mesh.geometry.dispose();
      // Don't dispose materials/textures — they're cached by text.
    }
    liveBoxes.clear();
  }

  // Start a story playing at frame '1' and recursively start any
  // attached stories at the marker's same cell (each gets its own
  // playingStory entry). Attached stories cascade further if their
  // first frame attaches even more.
  function startPlayingStory(storyId, markerId, now) {
    if (!storyId) return;
    // Don't double-start.
    if (playingStories.some(p => p.storyId === storyId)) return;
    playingStories.push({
      storyId, markerId, currentFrameId: '1', frameStartTime: now,
    });
    const story = storyCache.get(storyId);
    const f1 = story?.frames?.['1'];
    if (f1?.attaches?.length) {
      for (const childId of f1.attaches) {
        startPlayingStory(childId, markerId, now);
      }
    }
  }

  // When a story advances to a new frame, kick off any attached stories
  // that frame declares (if not already playing).
  function fireFrameAttaches(storyId, frameId, now) {
    const story = storyCache.get(storyId);
    const frame = story?.frames?.[frameId];
    if (!frame?.attaches?.length) return;
    for (const childId of frame.attaches) {
      const playing = playingStories.find(p => p.storyId === childId);
      if (!playing) {
        // Use the parent marker's id as anchor for the attached story.
        const parent = playingStories.find(p => p.storyId === storyId);
        startPlayingStory(childId, parent?.markerId, now);
      }
    }
  }

  function refreshLiveBoxes() {
    clearLiveBoxes();
    const s = getStateFn();
    const cellSize = s.grid?.cellSizeMeters || 1;
    for (const playing of playingStories) {
      const story = storyCache.get(playing.storyId);
      if (!story) continue;
      const marker = (s.storyMarkers || []).find(m => m.id === playing.markerId);
      if (!marker) continue;
      const frame = story.frames?.[playing.currentFrameId];
      if (!frame) continue;
      // Migrate any legacy single-box frame on read so the renderer
      // only ever sees the boxes[] form.
      const boxes = Array.isArray(frame.boxes) && frame.boxes.length
        ? frame.boxes
        : (frame.box ? [frame.box] : []);
      for (let bi = 0; bi < boxes.length; bi++) {
        const box = boxes[bi];
        const mesh = buildBoxMesh(story, playing.currentFrameId, box, bi, marker, cellSize);
        if (!mesh) continue;
        root.add(mesh);
        // Each box's mesh is keyed `${storyId}:${frameId}:${boxId/idx}`
        // so multiple boxes per frame each get their own live entry
        // and click handler routing finds the right one.
        const liveKey = `${playing.storyId}:${playing.currentFrameId}:${box.id || bi}`;
        liveBoxes.set(liveKey, mesh);
        // Buttons live PER BOX now (not per frame). Attached as
        // children so they inherit the box's billboard rotation and
        // raycaster.intersectObjects(..., true) propagates clicks.
        const btnMeshes = buildButtonMeshes(story, playing.currentFrameId, box, marker, cellSize, mesh);
        for (const bm of btnMeshes) mesh.add(bm);
      }
    }
  }

  async function loadStoryById(storyId) {
    if (storyCache.has(storyId)) return storyCache.get(storyId);
    // GAME-MODE patch: stories are baked into the bundle as a
    // dictionary keyed by storyId. No fetch — file:// has no server.
    try {
      const mod = await import('../core/embedded-stories.js');
      const story = mod.GAME_STORIES?.[storyId];
      if (!story) {
        console.warn(`[narration] story ${storyId} not in bundle`);
        return null;
      }
      storyCache.set(storyId, story);
      return story;
    } catch (err) {
      console.warn(`[narration] story load ${storyId} failed:`, err);
      return null;
    }
  }

  async function syncStoriesFromState() {
    const s = getStateFn();
    const wanted = new Set((s.storyMarkers || []).map(m => m.storyId).filter(Boolean));
    // Drop cached stories no longer referenced.
    for (const id of Array.from(storyCache.keys())) {
      if (!wanted.has(id)) storyCache.delete(id);
    }
    // Fetch missing.
    for (const id of wanted) {
      if (!storyCache.has(id)) await loadStoryById(id);
    }
    // Drop any playing stories whose marker disappeared.
    const valid = new Set((s.storyMarkers || []).map(m => m.id));
    for (let i = playingStories.length - 1; i >= 0; i--) {
      if (!valid.has(playingStories[i].markerId)) playingStories.splice(i, 1);
    }
    refreshLiveBoxes();
  }

  // Listen for editor-side story edits. Inspector posts a
  // { type:'story-changed', storyId } message on v3d-stories whenever
  // saveStory() fires (= any frame add / edit / text change). We
  // refetch the named story and refresh any currently-displayed boxes
  // so the new frame data is live without a preview reload.
  async function refetchStory(storyId) {
    storyCache.delete(storyId);
    await loadStoryById(storyId);
    // If any currently-playing story has its `currentFrameId` no
    // longer present in the refetched story, snap it back to '1'.
    const story = storyCache.get(storyId);
    if (story) {
      for (const p of playingStories) {
        if (p.storyId === storyId && !story.frames?.[p.currentFrameId]) {
          p.currentFrameId = '1';
          p.frameStartTime = performance.now();
        }
      }
    }
    refreshLiveBoxes();
  }
  if (typeof BroadcastChannel !== 'undefined') {
    const storyBus = new BroadcastChannel('v3d-stories');
    storyBus.addEventListener('message', (ev) => {
      const m = ev.data;
      // 'story-deleted' — the editor removed a story file. Drop the
      // cached copy + any currently-playing instances so the preview
      // doesn't keep rendering boxes for a story that no longer exists
      // on disk. The state-sync broadcast separately removes the
      // marker(s) referencing the story; this handler only needs to
      // clean up the story-side cache + live boxes.
      if (m?.type === 'story-deleted' && m.storyId) {
        storyCache.delete(m.storyId);
        for (let i = playingStories.length - 1; i >= 0; i--) {
          if (playingStories[i].storyId === m.storyId) playingStories.splice(i, 1);
        }
        refreshLiveBoxes();
        return;
      }
      if (m?.type !== 'story-changed' || !m.storyId) return;
      // Editor inlines the full story payload — adopt it directly
      // and skip the /api/story-load round-trip. This is what makes
      // live edits land in the preview on the next frame instead of
      // after a network fetch. If `story` is absent (older editor
      // version, or external trigger), fall back to refetching.
      if (m.story) {
        storyCache.set(m.storyId, m.story);
        // Same frame-existence guard as refetchStory: if the live
        // frame id is no longer present in the refreshed story, snap
        // back to '1' so we don't render against a stale frame ref.
        for (const p of playingStories) {
          if (p.storyId === m.storyId && !m.story.frames?.[p.currentFrameId]) {
            p.currentFrameId = '1';
            p.frameStartTime = performance.now();
          }
        }
        refreshLiveBoxes();
      } else {
        refetchStory(m.storyId);
      }
    });
  }

  function evaluateTrigger(trigger, marker, playerCell) {
    if (trigger.type === 'always') return true;
    if (trigger.type === 'distance') {
      const cells = Math.max(1, trigger.cells || 5);
      const mr = rowIdToIndex(marker.rowId);
      const pr = playerCell.r;
      const pc = playerCell.c;
      // Manhattan distance in cells.
      const dist = Math.abs(mr - pr) + Math.abs(marker.col - pc);
      return dist <= cells;
    }
    return false;
  }

  function tick(playerBodyPos, cellSize) {
    const now = performance.now();
    if (now - lastTickMs < TICK_MS) {
      // Even on non-tick frames, update billboards.
      updateBillboards(playerBodyPos);
      return;
    }
    lastTickMs = now;

    const s = getStateFn();
    const playerCell = {
      r: Math.floor(playerBodyPos.z / cellSize),
      c: Math.floor(playerBodyPos.x / cellSize) + 1,
    };

    // 0) Re-arm any 'restart' markers whose player has now left the
    // trigger zone. endedInZoneSet only blocks re-fire WHILE the
    // player is still inside the zone. Once they walk out, the
    // marker becomes eligible again.
    for (const markerId of Array.from(endedInZoneSet)) {
      const marker = (s.storyMarkers || []).find(m => m.id === markerId);
      if (!marker) { endedInZoneSet.delete(markerId); continue; }
      const story = storyCache.get(marker.storyId);
      if (!story) continue;
      // Check if any trigger is still firing for this player position.
      // If none fire, the player is outside — re-arm.
      const stillInside = (story.triggers || []).some(t => evaluateTrigger(t, marker, playerCell));
      if (!stillInside) endedInZoneSet.delete(markerId);
    }

    // 1) For each marker not currently playing, evaluate triggers.
    for (const marker of (s.storyMarkers || [])) {
      if (!marker.storyId) continue;
      const alreadyPlaying = playingStories.some(p => p.markerId === marker.id);
      if (alreadyPlaying) continue;
      // Gate on BOTH sets. 'once-per-load' = dead for the session;
      // 'restart' marker still in zone post-end = not yet re-armed.
      // Treat legacy 'always' as 'restart' on read.
      const replay = (marker.replay === 'always') ? 'restart' : (marker.replay || 'once-per-load');
      if (replay === 'once-per-load' && hasPlayedSet.has(marker.id)) continue;
      if (replay === 'restart'        && endedInZoneSet.has(marker.id)) continue;
      const story = storyCache.get(marker.storyId);
      if (!story) continue;
      const triggers = story.triggers || [];
      const fired = triggers.some(t => evaluateTrigger(t, marker, playerCell));
      if (fired) {
        startPlayingStory(marker.storyId, marker.id, now);
        refreshLiveBoxes();
      }
    }

    // 2) Walk currently-playing stories. Handle time-based advance.
    let dirty = false;
    for (let i = playingStories.length - 1; i >= 0; i--) {
      const p = playingStories[i];
      const story = storyCache.get(p.storyId);
      if (!story) { playingStories.splice(i, 1); dirty = true; continue; }
      const frame = story.frames?.[p.currentFrameId];
      if (!frame) { playingStories.splice(i, 1); dirty = true; continue; }
      if (frame.advance === 'time') {
        const dur = (frame.duration || 3) * 1000;
        if (now - p.frameStartTime >= dur) {
          const nxt = frame.next;
          if (nxt && story.frames[nxt]) {
            p.currentFrameId = nxt;
            p.frameStartTime = now;
            fireFrameAttaches(p.storyId, nxt, now);
            dirty = true;
          } else {
            // End of story by reaching a frame with no `next`.
            // Mark per replay mode so the trigger pass at top of the
            // next tick decides what to do.
            markEnded(p.markerId, s);
            playingStories.splice(i, 1);
            dirty = true;
          }
        }
      }
      // If the player walked out of the trigger zone mid-story, the
      // story stops showing. For 'once-per-load' it's also marked
      // permanently played; for 'restart' it just stops (no flag set
      // since leaving zone IS the re-arm condition).
      if (marker_outside_distance(p, s, playerCell)) {
        const marker = (s.storyMarkers || []).find(m => m.id === p.markerId);
        const replay = (marker?.replay === 'always') ? 'restart' : (marker?.replay || 'once-per-load');
        if (replay === 'once-per-load') hasPlayedSet.add(p.markerId);
        // Note: NO endedInZoneSet update here because the player
        // walking out IS exactly the re-arm condition for 'restart'.
        playingStories.splice(i, 1);
        dirty = true;
      }
    }
    if (dirty) refreshLiveBoxes();
    updateBillboards(playerBodyPos);
  }

  // Mark a marker as having reached the natural END of its story.
  //   once-per-load → dead for the session (hasPlayedSet)
  //   restart       → paused-in-zone (endedInZoneSet); clears when
  //                   the player leaves the trigger zone
  function markEnded(markerId, sNow) {
    const s = sNow || getStateFn();
    const marker = (s.storyMarkers || []).find(m => m.id === markerId);
    if (!marker) return;
    const replay = (marker.replay === 'always') ? 'restart' : (marker.replay || 'once-per-load');
    if (replay === 'once-per-load') hasPlayedSet.add(markerId);
    else                            endedInZoneSet.add(markerId);
  }

  function marker_outside_distance(playing, s, playerCell) {
    const marker = (s.storyMarkers || []).find(m => m.id === playing.markerId);
    if (!marker) return true;
    const story = storyCache.get(playing.storyId);
    if (!story) return true;
    const dist = (story.triggers || []).find(t => t.type === 'distance');
    if (!dist) return false;  // no distance trigger → can't be "outside"
    const cells = Math.max(1, dist.cells || 5);
    const mr = rowIdToIndex(marker.rowId);
    const d = Math.abs(mr - playerCell.r) + Math.abs(marker.col - playerCell.c);
    return d > cells;
  }

  function updateBillboards(playerBodyPos) {
    const s = getStateFn();

    // ----- P2-F: gather live group membership -----
    //
    // A marker is "in a group" only when 2+ live boxes share its
    // groupId. A group of one is just a normal box. We rebuild this
    // map every tick because membership tracks the CURRENTLY-PLAYING
    // stories — a marker that's grouped in state but not currently
    // playing doesn't count.
    const memberByGroup = new Map();   // gid → [{ mesh, marker }]
    for (const [, mesh] of liveBoxes) {
      const marker = (s.storyMarkers || []).find(m => m.id === mesh.userData.markerId);
      const gid = marker?.groupId;
      if (!gid) continue;
      if (!memberByGroup.has(gid)) memberByGroup.set(gid, []);
      memberByGroup.get(gid).push({ mesh, marker });
    }
    const activeGroups = new Map();
    for (const [gid, members] of memberByGroup) {
      if (members.length >= 2) activeGroups.set(gid, members);
    }

    // ----- Drop strokes for groups that disbanded this tick -----
    for (const gid of Array.from(groupStrokes.keys())) {
      if (activeGroups.has(gid)) continue;
      const stroke = groupStrokes.get(gid);
      stroke?.geometry?.dispose();
      const anchor = groupAnchors.get(gid);
      if (anchor) root.remove(anchor);
      groupStrokes.delete(gid);
      groupAnchors.delete(gid);
    }

    // ----- Process each active group: co-plane + union outline -----
    //
    // All group members share a single billboard yaw (centroid →
    // camera). Each member's mesh sits at its own world position but
    // rotates to the SHARED yaw — that makes every member's quad
    // coplanar in screen space, which is the precondition for the 2D
    // union-polygon math. The anchor group sits at the centroid and
    // is rotated by the same yaw so the union stroke geometry can be
    // computed in the anchor's local 2D space.
    const groupedMeshIds = new Set();
    for (const [gid, members] of activeGroups) {
      let cx = 0, cy = 0, cz = 0;
      for (const m of members) {
        cx += m.mesh.position.x;
        cy += m.mesh.position.y;
        cz += m.mesh.position.z;
      }
      cx /= members.length; cy /= members.length; cz /= members.length;
      const dx = playerBodyPos.x - cx;
      const dz = playerBodyPos.z - cz;
      const sharedYaw = Math.atan2(dx, dz);
      const cosY = Math.cos(sharedYaw);
      const sinY = Math.sin(sharedYaw);

      // For each member: apply shared yaw + compute local 2D rect in
      // the anchor's frame. The anchor's local X axis (after rotation
      // sharedYaw around Y) is world (cos(yaw), 0, -sin(yaw)); the
      // anchor's local Y is world up; local Z faces the camera.
      const rects = [];
      for (const m of members) {
        m.mesh.rotation.set(0, sharedYaw, 0);
        const wx = m.mesh.position.x - cx;
        const wz = m.mesh.position.z - cz;
        const lx = wx * cosY - wz * sinY;
        const ly = m.mesh.position.y - cy;
        const w = m.mesh.userData.boxW;
        const h = m.mesh.userData.boxH;
        rects.push({ x1: lx - w / 2, x2: lx + w / 2, y1: ly - h / 2, y2: ly + h / 2 });
        groupedMeshIds.add(m.mesh.uuid);

        // First time this box enters a group → rebake without stroke.
        if (!m.mesh.userData.inGroup) {
          m.mesh.userData.inGroup = true;
          rebuildBoxTextureForGroup(m.mesh, true);
        }
      }

      // Get / create the group's stroke mesh.
      let anchor = groupAnchors.get(gid);
      if (!anchor) {
        anchor = new THREE.Group();
        anchor.name = 'narration-group-' + gid;
        root.add(anchor);
        groupAnchors.set(gid, anchor);
      }
      let stroke = groupStrokes.get(gid);
      if (!stroke) {
        stroke = new THREE.LineSegments(
          new THREE.BufferGeometry(),
          new THREE.LineBasicMaterial({ color: 0x0b0d14, linewidth: 2 }),
        );
        stroke.renderOrder = 11;
        anchor.add(stroke);
        groupStrokes.set(gid, stroke);
      }
      anchor.position.set(cx, cy, cz);
      anchor.rotation.set(0, sharedYaw, 0);

      // Build LineSegments from the union polygon edges. The stroke
      // sits at local z = +0.012 m so it floats just in front of the
      // box quads (which live at z = 0 in this local frame), avoiding
      // z-fight with the textured faces.
      const segs = unionBoundarySegments(rects);
      const positions = new Float32Array(segs.length * 6);
      for (let i = 0; i < segs.length; i++) {
        const sg = segs[i];
        positions[i * 6 + 0] = sg.x1; positions[i * 6 + 1] = sg.y1; positions[i * 6 + 2] = 0.012;
        positions[i * 6 + 3] = sg.x2; positions[i * 6 + 4] = sg.y2; positions[i * 6 + 5] = 0.012;
      }
      stroke.geometry.dispose();
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(positions, 3));
      stroke.geometry = g;
    }

    // ----- Ungrouped boxes: individual billboard + restore stroke -----
    for (const [, mesh] of liveBoxes) {
      if (groupedMeshIds.has(mesh.uuid)) continue;
      const dx = playerBodyPos.x - mesh.position.x;
      const dz = playerBodyPos.z - mesh.position.z;
      mesh.rotation.set(0, Math.atan2(dx, dz), 0);

      // Just left a group → restore the per-box stroke.
      if (mesh.userData.inGroup) {
        mesh.userData.inGroup = false;
        rebuildBoxTextureForGroup(mesh, false);
      }
    }
  }

  // Click handler — invoked by the engine with a Raycaster set up from
  // the camera. Recursive intersect picks up button hits on box
  // children. Routes:
  //   - button hit  → jump to that button's target frame
  //   - box hit AND that box has no buttons → advance frame.next
  //   - box hit AND that box has buttons → ignored (buttons are the
  //     intended click target; clicking empty box area is a no-op)
  //   - any other hit → no-op
  function handleClick(raycaster) {
    const meshes = Array.from(liveBoxes.values());
    if (!meshes.length) return false;
    const hits = raycaster.intersectObjects(meshes, true);
    if (!hits.length) return false;
    const hit = hits[0];
    const ud = hit.object.userData;
    const playing = playingStories.find(p =>
      p.storyId === ud.storyId && p.currentFrameId === ud.frameId);
    if (!playing) return false;
    const story = storyCache.get(playing.storyId);
    const frame = story?.frames?.[playing.currentFrameId];
    if (!frame) return false;
    const now = performance.now();
    const endStory = () => {
      // Natural end (no `next` to jump to OR button target missing).
      // Mark per replay mode so the trigger pass at top of the next
      // tick decides whether to re-fire (only 'restart' AND only
      // once the player leaves and re-enters).
      markEnded(playing.markerId);
      const idx = playingStories.indexOf(playing);
      if (idx >= 0) playingStories.splice(idx, 1);
    };
    const jumpTo = (nextId) => {
      if (nextId && story.frames[nextId]) {
        playing.currentFrameId = nextId;
        playing.frameStartTime = now;
        fireFrameAttaches(playing.storyId, nextId, now);
      } else {
        endStory();
      }
    };

    if (ud.kind === 'button' && ud.target) {
      jumpTo(ud.target);
      refreshLiveBoxes();
      return true;
    }
    if (ud.kind === 'box') {
      // Find this box in the (possibly multi-box) frame to check its
      // buttons. If it has buttons, the box itself isn't a click
      // target — only the buttons are.
      const boxes = Array.isArray(frame.boxes) && frame.boxes.length
        ? frame.boxes
        : (frame.box ? [frame.box] : []);
      const hitBox = boxes.find(b => (b.id || null) === (ud.boxId || null))
                  || boxes[ud.boxIdx || 0];
      if (hitBox?.buttons && hitBox.buttons.length) return false;
      jumpTo(frame.next);
      refreshLiveBoxes();
      return true;
    }
    return false;
  }

  // Public API.
  return {
    syncStoriesFromState,
    tick,
    handleClick,
    // For debugging / future phases.
    _debug: { storyCache, playingStories, hasPlayedSet, liveBoxes },
  };
}
