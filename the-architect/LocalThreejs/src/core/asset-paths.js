// src/core/asset-paths.js — game-mode shim.
// Uses RELATIVE paths so it works from file:// double-click.

let _currentSlug = 'the-architect';

export function setCurrentSlug(slug) { _currentSlug = slug; }
export function getCurrentSlug()      { return _currentSlug; }

export function resolveAssetUrl(rel) {
  if (!rel) return rel;
  if (rel.startsWith('data:') || rel.startsWith('http')) return rel;
  // Strip leading slash if present — we always want RELATIVE so file:// works.
  if (rel.startsWith('/')) rel = rel.slice(1);
  return `levels/${_currentSlug}/${rel}`;
}

export function buildAssetRel(subdir, filename) {
  return `assets/${subdir}/${filename}`;
}

export function buildAssetServerPath(subdir, filename) {
  return `levels/${_currentSlug}/assets/${subdir}/${filename}`;
}
