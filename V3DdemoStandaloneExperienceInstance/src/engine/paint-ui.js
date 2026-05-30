// engine/paint-ui.js — paint mode picker overlay.
//
// Mounted once at boot. Hidden when paint mode is off. When on, shows:
//   - 16×16 grid of 256 swatches (level palette)
//   - Selection cursor (highlighted swatch)
//   - Spectrum bar (full RGB; click to update a swatch)
//   - Active color: hex (#RRGGBB) + RGB (R, G, B 0-255)
//   - Instruction line: keys + click semantics
//
// Keyboard nav (handled by engine.js + paint-toggle key map): = up, ' down,
// [ left, ] right step the cursor through the swatch grid.

import * as state from '../core/state.js';
import { hexToCss, hexToRgb, rgbToHex } from '../core/palette.js';
import { getActiveIndex, setActiveIndex, getBrushSize, setBrushSize, getMeshConstantDot, setMeshConstantDot } from './painting.js';
import { saveFileAsset } from '../core/asset-store.js';

// Set by engine.js so the Import-JPEG button can hand off to raycast + apply.
let _onImportJpeg = null;
export function setImportJpegHandler(fn) { _onImportJpeg = fn; }
let _brushReadoutEl = null;
let _brushSliderEl  = null;

const GRID_COLS = 16;
const GRID_ROWS = 16;

let _root = null;
let _swatchEls = [];
let _hexEl = null;
let _rgbEl = null;

export function mountPaintUi() {
  if (_root) return _root;
  _root = document.createElement('div');
  _root.id = 'paint-ui';
  _root.style.cssText = `
    position: fixed; right: 10px; top: 50px;
    background: rgba(255,255,255,0.92);
    border: 1px solid #0b0d14;
    padding: 8px;
    font-family: 'JetBrains Mono', monospace; font-size: 11px;
    color: #0b0d14;
    user-select: none;
    z-index: 50;
    display: none;`;

  const title = document.createElement('div');
  title.textContent = 'PAINT MODE';
  title.style.cssText = 'font-weight: 700; margin-bottom: 6px; letter-spacing: 0.12em;';
  _root.appendChild(title);

  // Swatch grid
  const grid = document.createElement('div');
  grid.style.cssText = `
    display: grid;
    grid-template-columns: repeat(${GRID_COLS}, 14px);
    grid-gap: 1px;
    margin-bottom: 8px;`;
  for (let i = 0; i < GRID_COLS * GRID_ROWS; i++) {
    const sw = document.createElement('div');
    sw.dataset.index = i;
    sw.style.cssText = `
      width: 14px; height: 14px;
      border: 1px solid transparent;
      box-sizing: border-box;
      cursor: pointer;`;
    sw.addEventListener('click', () => {
      setActiveIndex(i);
      refresh();
    });
    grid.appendChild(sw);
    _swatchEls.push(sw);
  }
  _root.appendChild(grid);

  // Brush size: slider + readout (default 10×10, range 1..100).
  const brushRow = document.createElement('div');
  brushRow.style.cssText = 'margin-bottom: 8px;';
  _brushReadoutEl = document.createElement('div');
  _brushReadoutEl.style.cssText = 'color: #6b6f7a; margin-bottom: 2px;';
  _brushSliderEl = document.createElement('input');
  _brushSliderEl.type = 'range';
  _brushSliderEl.min = '1';
  _brushSliderEl.max = '100';
  _brushSliderEl.value = String(getBrushSize());
  _brushSliderEl.style.cssText = 'width: 100%;';
  _brushSliderEl.addEventListener('input', () => {
    setBrushSize(parseInt(_brushSliderEl.value, 10));
    refreshBrushReadout();
  });
  brushRow.appendChild(_brushReadoutEl);
  brushRow.appendChild(_brushSliderEl);

  // "Stay same dot" toggle — when ON, mesh paint ignores the world-scale
  // correction and uses raw overlay pixels, so every dot looks the same
  // shape on the mesh's UV surface regardless of how the mesh is scaled
  // or distorted. OFF (default) keeps dots world-uniform across all
  // surfaces — see _meshConstantDot in painting.js.
  const stableRow = document.createElement('label');
  stableRow.style.cssText = 'display:flex; align-items:center; gap:6px; font-size:11px; color:#6b6f7a; margin-top:4px; cursor:pointer;';
  const stableChk = document.createElement('input');
  stableChk.type = 'checkbox';
  stableChk.checked = getMeshConstantDot();
  stableChk.addEventListener('change', () => setMeshConstantDot(stableChk.checked));
  const stableTxt = document.createElement('span');
  stableTxt.textContent = 'stay same dot (mesh)';
  stableTxt.title = 'Mesh paint dots stay the same size on the surface even when the mesh is scaled or skewed';
  stableRow.appendChild(stableChk);
  stableRow.appendChild(stableTxt);
  brushRow.appendChild(stableRow);

  _root.appendChild(brushRow);

  // Active-color readout
  const readout = document.createElement('div');
  readout.style.cssText = 'margin-bottom: 6px; line-height: 1.6;';
  _hexEl = document.createElement('div');
  _rgbEl = document.createElement('div');
  readout.appendChild(_hexEl);
  readout.appendChild(_rgbEl);
  _root.appendChild(readout);

  // Spectrum (HTML color input — full RGB)
  const spec = document.createElement('div');
  spec.style.cssText = 'margin-bottom: 6px;';
  const specLabel = document.createElement('div');
  specLabel.textContent = 'spectrum: pick → assign to slot';
  specLabel.style.cssText = 'margin-bottom: 2px; color: #6b6f7a;';
  const colorInput = document.createElement('input');
  colorInput.type = 'color';
  colorInput.style.cssText = 'width: 100%; height: 24px; border: 1px solid #0b0d14;';
  colorInput.addEventListener('input', () => {
    const css = colorInput.value;
    const r = parseInt(css.substr(1, 2), 16);
    const g = parseInt(css.substr(3, 2), 16);
    const b = parseInt(css.substr(5, 2), 16);
    state.update((s) => {
      s.palette = s.palette ? s.palette.slice() : [];
      s.palette[getActiveIndex()] = rgbToHex(r, g, b);
    });
    refresh();
  });
  spec.appendChild(specLabel);
  spec.appendChild(colorInput);
  _root.appendChild(spec);

  // Import JPEG — reads a file as data URL, hands off to the engine which
  // raycasts the crosshair and assigns it to the hit face.
  const jpegRow = document.createElement('div');
  jpegRow.style.cssText = 'margin-bottom: 6px;';
  const fileLabel = document.createElement('div');
  fileLabel.textContent = 'JPEG: import → apply to face under crosshair';
  fileLabel.style.cssText = 'margin-bottom: 2px; color: #6b6f7a;';
  const fileBtn = document.createElement('input');
  fileBtn.type = 'file';
  fileBtn.accept = 'image/jpeg,image/png,image/webp';
  fileBtn.style.cssText = 'width: 100%; font-size: 10px;';
  fileBtn.addEventListener('change', async () => {
    const file = fileBtn.files?.[0];
    if (!file) return;
    // Save to file → pass the level-relative URL to the engine handler.
    const asset = await saveFileAsset(file, 'jpegs');
    if (_onImportJpeg) _onImportJpeg(asset.url);
    fileBtn.value = '';
  });
  jpegRow.appendChild(fileLabel);
  jpegRow.appendChild(fileBtn);
  _root.appendChild(jpegRow);

  // Instruction line
  const help = document.createElement('div');
  help.style.cssText = 'color: #6b6f7a; font-size: 10px; line-height: 1.5; margin-top: 4px;';
  help.innerHTML = [
    '<b>P</b> exit paint',
    "<b>=</b>/<b>'</b> swatch up/down · <b>[</b>/<b>]</b> swatch left/right",
    '<b>,</b>/<b>.</b> brush size down/up',
    '<b>L-drag</b> paint · <b>R-drag</b> erase',
    '<b>slot 0</b> = transparent (erase)',
  ].join('<br>');
  _root.appendChild(help);

  document.body.appendChild(_root);
  return _root;
}

export function showPaintUi() {
  if (!_root) mountPaintUi();
  _root.style.display = 'block';
  refresh();
  refreshBrushReadout();
}
export function hidePaintUi() {
  if (_root) _root.style.display = 'none';
}

// Sync the brush slider + readout to the painting module's current value.
// Called by engine.js after keyboard nudges (,/.) so the UI tracks them.
export function refreshBrushReadout() {
  const n = getBrushSize();
  if (_brushReadoutEl) _brushReadoutEl.textContent = `brush: ${n} × ${n}`;
  if (_brushSliderEl && _brushSliderEl.value !== String(n)) _brushSliderEl.value = String(n);
}

function refresh() {
  const s = state.get();
  const palette = s.palette || [];
  const active = getActiveIndex();
  for (let i = 0; i < _swatchEls.length; i++) {
    const sw = _swatchEls[i];
    const hex = palette[i] || 0;
    if (i === 0) {
      // Slot 0 is "transparent" — render a checkerboard so it's visually distinct.
      sw.style.background = 'repeating-conic-gradient(#bbb 0 25%, #fff 0 50%) 50% / 6px 6px';
    } else {
      sw.style.background = hexToCss(hex);
    }
    sw.style.border = (i === active) ? '1px solid #0b0d14' : '1px solid transparent';
    sw.style.outline = (i === active) ? '2px solid #ee7967' : 'none';
  }
  const activeHex = palette[active] || 0;
  if (_hexEl) _hexEl.innerHTML = `slot <b>${active}</b> · ${active === 0 ? '<i>transparent</i>' : hexToCss(activeHex)}`;
  if (_rgbEl) {
    if (active === 0) _rgbEl.textContent = '—';
    else {
      const { r, g, b } = hexToRgb(activeHex);
      _rgbEl.textContent = `R:${r} G:${g} B:${b}`;
    }
  }
}

// Move the active swatch by 1 in a compass direction. Called by engine.js
// when paint-mode keyboard navigation keys fire.
export function navSwatch(dir) {
  let i = getActiveIndex();
  const col = i % GRID_COLS;
  const row = Math.floor(i / GRID_COLS);
  if (dir === 'up')    setActiveIndex(((row - 1 + GRID_ROWS) % GRID_ROWS) * GRID_COLS + col);
  if (dir === 'down')  setActiveIndex(((row + 1) % GRID_ROWS) * GRID_COLS + col);
  if (dir === 'left')  setActiveIndex(row * GRID_COLS + ((col - 1 + GRID_COLS) % GRID_COLS));
  if (dir === 'right') setActiveIndex(row * GRID_COLS + ((col + 1) % GRID_COLS));
  refresh();
}
