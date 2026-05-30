// core/asset-store.js — save binary assets to the level's folder.
//
// Hashes the bytes (first 16 hex chars of SHA-256) for filename to dedupe
// identical assets within a level. POSTs to /api/save-binary with X-Path.
// Returns the LEVEL-RELATIVE asset path (e.g., "assets/jpegs/abc.jpg") which
// is what gets stored in state.

import { buildAssetRel, buildAssetServerPath, resolveAssetUrl, getCurrentSlug } from './asset-paths.js';
import * as state from './state.js';

const SUBDIR_BY_EXT = {
  jpg: 'jpegs', jpeg: 'jpegs', png: 'jpegs', webp: 'jpegs', gif: 'jpegs',
  glb: 'models', gltf: 'models',
};

// File → { url: "assets/jpegs/<hash>.jpg", mime: "image/jpeg" }.
// `kindHint` (optional) forces the subdir; otherwise inferred from extension.
export async function saveFileAsset(file, kindHint = null) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  return saveBytesAsset(bytes, file.name, file.type, kindHint);
}

// Bytes + name → asset. Used when bytes come from a dataUrl or fetch.
export async function saveBytesAsset(bytes, filename, mime = null, kindHint = null) {
  const ext = (filename.split('.').pop() || 'bin').toLowerCase();
  const subdir = kindHint || SUBDIR_BY_EXT[ext] || 'misc';
  const hash = await sha256short(bytes);
  const targetName = `${hash}.${ext}`;
  const rel = buildAssetRel(subdir, targetName);
  const serverPath = buildAssetServerPath(subdir, targetName);
  await fetch('/api/save-binary', {
    method: 'POST',
    headers: { 'X-Path': serverPath, 'Content-Type': 'application/octet-stream' },
    body: bytes,
  });
  return { url: rel, mime: mime || guessMime(ext) };
}

// Convert a data URL (e.g., "data:image/jpeg;base64,...") to a file asset
// saved on disk. Used to migrate inline-base64 state entries to files at
// save-time or when transitioning legacy data.
export async function dataUrlToAsset(dataUrl, filename = 'asset.bin', kindHint = null) {
  const comma = dataUrl.indexOf(',');
  if (comma < 0) throw new Error('not a data URL');
  const meta = dataUrl.slice(5, comma);   // "image/jpeg;base64"
  const isB64 = meta.endsWith(';base64');
  const mime = isB64 ? meta.slice(0, -7) : meta;
  const bin = isB64 ? atob(dataUrl.slice(comma + 1)) : decodeURIComponent(dataUrl.slice(comma + 1));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  // Pick an extension from mime if filename doesn't have one.
  if (!filename.includes('.')) {
    const ext = MIME_TO_EXT[mime] || 'bin';
    filename = `asset.${ext}`;
  }
  return saveBytesAsset(bytes, filename, mime, kindHint);
}

// Copy an asset that lives in the current level's folder into the project-wide
// `stamps/assets/` folder so a stamp can reference it from any level. Returns
// an absolute project path (leading slash so the asset-paths resolver passes
// it through verbatim).
export async function copyAssetToStamps(levelRelativeUrl) {
  if (!levelRelativeUrl || levelRelativeUrl.startsWith('/') || levelRelativeUrl.startsWith('data:') || levelRelativeUrl.startsWith('http')) {
    // Already absolute, inline, or remote — nothing to copy.
    return levelRelativeUrl;
  }
  const fullUrl = resolveAssetUrl(levelRelativeUrl);
  const r = await fetch(fullUrl);
  if (!r.ok) throw new Error(`copyAssetToStamps: fetch ${fullUrl} -> ${r.status}`);
  const bytes = new Uint8Array(await r.arrayBuffer());
  const ext = (levelRelativeUrl.split('.').pop() || 'bin').toLowerCase();
  const subdir = SUBDIR_BY_EXT[ext] || 'misc';
  const hash = await sha256short(bytes);
  const filename = `${hash}.${ext}`;
  const path = `stamps/assets/${subdir}/${filename}`;
  await fetch('/api/save-binary', {
    method: 'POST',
    headers: { 'X-Path': path, 'Content-Type': 'application/octet-stream' },
    body: bytes,
  });
  return `/${path}`;   // absolute project path
}

// Delete an asset file from disk. `rel` is the level-relative URL stored in
// state (e.g., "assets/jpegs/<hash>.jpg"). Returns true if the file was
// deleted (or didn't exist), false on error. Never deletes inline data URLs
// or external http(s) URLs.
export async function deleteAsset(rel) {
  if (!rel) return false;
  if (rel.startsWith('data:') || rel.startsWith('http')) return false;
  // Build the server path. Absolute paths (leading slash) like "/stamps/..."
  // get the leading slash stripped; level-relative URLs get prefixed with the
  // current level's folder.
  let serverPath;
  if (rel.startsWith('/')) {
    serverPath = rel.slice(1);
  } else {
    const slug = getCurrentSlug();
    if (!slug) return false;
    serverPath = `levels/${slug}/${rel}`;
  }
  try {
    const r = await fetch('/api/delete-binary', {
      method: 'POST',
      headers: { 'X-Path': serverPath },
    });
    return r.ok;
  } catch (_) {
    return false;
  }
}

// Garbage-collect an asset URL: delete the file ONLY if no other reference in
// the current level's state points at it. Call this after dropping a single
// reference (e.g., unassigning a wall's base JPEG) to ensure the file lingers
// only as long as something still uses it.
export async function gcDeleteIfOrphan(url) {
  if (!url) return false;
  if (url.startsWith('data:') || url.startsWith('http')) return false;
  const s = state.get();
  if (collectAssetUrls(s).has(url)) return false;   // still referenced
  return deleteAsset(url);
}

// Walk the current level state and collect every URL that references an
// asset file. Includes wall base textures, object textures, per-face JPEGs,
// and imported mesh URLs.
export function collectAssetUrls(s) {
  const refs = new Set();
  const add = (u) => { if (u && !u.startsWith('data:') && !u.startsWith('http')) refs.add(u); };
  for (const w of s.walls || []) add(w.baseTexture?.url);
  for (const o of s.objects || []) add(o.texture?.url);
  const jp = s.jpegs || {};
  for (const k of Object.keys(jp)) add(jp[k]?.url);
  const meshes = s.meshes || {};
  for (const k of Object.keys(meshes)) add(meshes[k]?.url);
  // Stamps store inline definitions that can reference textures + meshes.
  // Include them so GC doesn't delete a file a stamp will need at place-time.
  for (const stamp of s.stamps || []) {
    const def = stamp?.definition;
    if (!def) continue;
    for (const w of def.walls || []) add(w.baseTexture?.url);
    for (const o of def.objects || []) add(o.texture?.url);
  }
  return refs;
}

// Sweep orphaned files in the current level's assets folder. Lists files via
// the server, compares to collectAssetUrls(state), and deletes any file not
// referenced. Returns the count of files removed.
export async function sweepOrphanAssets() {
  const slug = getCurrentSlug();
  if (!slug) return { removed: 0, scanned: 0 };
  const dir = `levels/${slug}/assets`;
  const r = await fetch('/api/list-assets', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ dir }),
  });
  if (!r.ok) return { removed: 0, scanned: 0 };
  const { files = [] } = await r.json();
  const refs = collectAssetUrls(state.get());
  let removed = 0;
  for (const f of files) {
    // Asset state stores URLs like "assets/jpegs/<hash>.jpg" — match against
    // server-returned paths which are relative to the assets dir.
    const rel = `assets/${f}`;
    if (refs.has(rel)) continue;
    const ok = await deleteAsset(rel);
    if (ok) removed++;
  }
  return { removed, scanned: files.length };
}

async function sha256short(bytes) {
  if (typeof crypto?.subtle?.digest === 'function') {
    const hashBuf = await crypto.subtle.digest('SHA-256', bytes);
    const arr = Array.from(new Uint8Array(hashBuf));
    return arr.map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 16);
  }
  // Fallback: timestamp + random (used in non-secure contexts where
  // crypto.subtle isn't available). Always 16 hex chars.
  const t = Date.now().toString(16).padStart(12, '0');
  const r = Math.floor(Math.random() * 0xffff).toString(16).padStart(4, '0');
  return (t + r).slice(0, 16);
}

const MIME_TO_EXT = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif',
  'model/gltf-binary': 'glb', 'model/gltf+json': 'gltf',
};
function guessMime(ext) {
  return Object.entries(MIME_TO_EXT).find(([_, e]) => e === ext)?.[0] || 'application/octet-stream';
}
