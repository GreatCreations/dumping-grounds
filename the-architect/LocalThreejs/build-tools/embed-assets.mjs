// Inlines all binary assets the architect level references as base64
// data URLs, then rewrites both:
//   - embedded-level.js (the level's JPEG references)
//   - core/mesh-registry.js (plant.glb path)
// to point at the data URLs instead of file paths. This makes the
// game truly file:// double-clickable — browsers block fetch from
// file:// for binary resources, but data: URLs always work.
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const LEVEL_PATH = '../levels/the-architect/level.json';
const ROOT       = '../';

function dataUrl(filePath, mime) {
  const buf = readFileSync(filePath);
  return `data:${mime};base64,${buf.toString('base64')}`;
}

// ---- Rewrite level.json's JPEG references ----
const level = JSON.parse(readFileSync(LEVEL_PATH, 'utf-8'));

// Walk the level recursively and replace any object with {url: 'assets/jpegs/...'}
// to {dataUrl: '<base64>'}.
function walk(obj) {
  if (Array.isArray(obj)) { for (const v of obj) walk(v); return; }
  if (obj && typeof obj === 'object') {
    if (typeof obj.url === 'string' && obj.url.startsWith('assets/jpegs/')) {
      const full = resolve(ROOT, 'levels/the-architect', obj.url);
      const mime = obj.url.endsWith('.png') ? 'image/png' : 'image/jpeg';
      obj.dataUrl = dataUrl(full, mime);
      delete obj.url;
    }
    for (const k of Object.keys(obj)) walk(obj[k]);
  }
}
walk(level);

// Re-write embedded-level.js with the inlined level.
const embedded = JSON.stringify(level);
const stringLiteral = JSON.stringify(embedded);
const levelOut = `// src/core/embedded-level.js — the architect level, baked into
// the bundle with binary assets inlined as data URLs.
export const GAME_SLUG = 'the-architect';
export const GAME_LEVEL = JSON.parse(${stringLiteral});
`;
writeFileSync('../src/core/embedded-level.js', levelOut);
console.log('Rewrote embedded-level.js with inlined JPEGs.');

// ---- Inline plant.glb into the mesh registry ----
const plantData = dataUrl('../assets/meshes/plant.glb', 'model/gltf-binary');
let registry = readFileSync('../src/core/mesh-registry.js', 'utf-8');
// Replace `path: 'assets/meshes/plant.glb'` → `path: '<data:...>'`
registry = registry.replace(
  /path:\s*['"]assets\/meshes\/plant\.glb['"]/g,
  `path: ${JSON.stringify(plantData)}`
);
writeFileSync('../src/core/mesh-registry.js', registry);
console.log('Rewrote mesh-registry.js with inlined plant.glb (', plantData.length, 'chars).');
