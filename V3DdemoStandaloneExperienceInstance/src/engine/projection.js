// engine/projection.js — UV regeneration for the 4 texture projection modes.
//
// Shared by walls (engine/walls.js) and objects (engine/objects.js) so the
// math lives in one place. Mirrors the "UVW Map" modifier in 3DS Max / Maya:
// pick a mode and (for plane/cylinder) an axis, and the geometry's UVs are
// recomputed from each vertex's position relative to the bounding box.
//
// Box mode preserves the geometry's existing UVs (cube faces, equirect sphere,
// cylindrical, GLB authored — whatever was authored on the mesh).

import * as THREE from 'three';

export function regenerateUVsForProjection(geom, projection, axis = 'y') {
  if (!projection) return geom;

  // Cylinder and sphere projections wrap the U axis with atan2 (range
  // [-π, π], normalised to [0, 1]). Any triangle that straddles the seam
  // (one vertex at u≈0.99, one at u≈0.01) linearly interpolates *across*
  // the texture instead of *wrapping around* — the texture appears
  // squashed sideways on the seam triangles. To fix it we need per-triangle
  // UV control: de-index the geometry so each triangle has its own three
  // vertices, then shift the low-U vertex of any seam triangle by +1 so
  // the triangle's UVs stay continuous (running through, say, 0.99 → 1.01
  // instead of 0.99 → 0.01).
  const needsSeamFix = (projection === 'cylinder' || projection === 'sphere');
  if (needsSeamFix && geom.index) geom = geom.toNonIndexed();

  // Box mode now regenerates "world-space triplanar" UVs so a multi-box wall
  // (solid + sill + lintel) has continuous mapping across its sub-boxes. Each
  // vertex picks its UV from the world plane perpendicular to its dominant
  // normal axis. Native UVs only get preserved when there's no projection at all.
  geom.computeBoundingBox();
  const bb = geom.boundingBox;
  const size = new THREE.Vector3();   bb.getSize(size);
  const center = new THREE.Vector3(); bb.getCenter(center);

  const pos = geom.attributes.position;
  const uvArr = new Float32Array(pos.count * 2);

  const nrm = geom.attributes.normal;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    let u = 0, v = 0;

    if (projection === 'box') {
      // Triplanar: pick the plane perpendicular to this vertex's dominant
      // normal axis. Continuous across sub-boxes within the same shape.
      const nx = nrm ? Math.abs(nrm.getX(i)) : 0;
      const ny = nrm ? Math.abs(nrm.getY(i)) : 1;
      const nz = nrm ? Math.abs(nrm.getZ(i)) : 0;
      if (ny >= nx && ny >= nz)      { u = (x - bb.min.x) / (size.x || 1); v = (z - bb.min.z) / (size.z || 1); }
      else if (nx >= nz)             { u = (z - bb.min.z) / (size.z || 1); v = (y - bb.min.y) / (size.y || 1); }
      else                           { u = (x - bb.min.x) / (size.x || 1); v = (y - bb.min.y) / (size.y || 1); }
    } else if (projection === 'plane') {
      if (axis === 'x')      { u = (z - bb.min.z) / (size.z || 1); v = (y - bb.min.y) / (size.y || 1); }
      else if (axis === 'y') { u = (x - bb.min.x) / (size.x || 1); v = (z - bb.min.z) / (size.z || 1); }
      else /* z */           { u = (x - bb.min.x) / (size.x || 1); v = (y - bb.min.y) / (size.y || 1); }
    } else if (projection === 'sphere') {
      // Equirectangular UVs around a pole axis. Default pole is Y, but the
      // user can pick X or Z so the seam falls along a different axis (e.g.,
      // for a sideways planet or to align a face texture differently).
      const dx = x - center.x, dy = y - center.y, dz = z - center.z;
      const r = Math.hypot(dx, dy, dz) || 1;
      if (axis === 'x') {
        u = 0.5 + Math.atan2(dz / r, dy / r) / (2 * Math.PI);
        v = 0.5 - Math.asin(dx / r) / Math.PI;
      } else if (axis === 'z') {
        u = 0.5 + Math.atan2(dy / r, dx / r) / (2 * Math.PI);
        v = 0.5 - Math.asin(dz / r) / Math.PI;
      } else /* y */ {
        u = 0.5 + Math.atan2(dz / r, dx / r) / (2 * Math.PI);
        v = 0.5 - Math.asin(dy / r) / Math.PI;
      }
    } else if (projection === 'cylinder') {
      if (axis === 'x') {
        const dy = y - center.y, dz = z - center.z;
        u = 0.5 + Math.atan2(dz, dy) / (2 * Math.PI);
        v = (x - bb.min.x) / (size.x || 1);
      } else if (axis === 'y') {
        const dx = x - center.x, dz = z - center.z;
        u = 0.5 + Math.atan2(dz, dx) / (2 * Math.PI);
        v = (y - bb.min.y) / (size.y || 1);
      } else /* z */ {
        const dx = x - center.x, dy = y - center.y;
        u = 0.5 + Math.atan2(dy, dx) / (2 * Math.PI);
        v = (z - bb.min.z) / (size.z || 1);
      }
    }
    uvArr[i * 2]     = u;
    uvArr[i * 2 + 1] = v;
  }

  // Seam fix for cylinder + sphere. After UVs are written, walk triangles
  // and detect ones whose U range crosses the seam (max - min > 0.5).
  // For those, push any U < 0.5 by +1 so the triangle's three U values
  // sit in a contiguous band running past 1.0 — RepeatWrapping handles the
  // out-of-range sample. Sphere also needs the same fix for the same atan2
  // longitude seam.
  if (needsSeamFix) {
    const triCount = pos.count / 3;
    for (let t = 0; t < triCount; t++) {
      const i0 = t * 6, i1 = i0 + 2, i2 = i0 + 4;
      const u0 = uvArr[i0], u1 = uvArr[i1], u2 = uvArr[i2];
      const maxU = Math.max(u0, u1, u2);
      const minU = Math.min(u0, u1, u2);
      if (maxU - minU > 0.5) {
        if (u0 < 0.5) uvArr[i0] = u0 + 1;
        if (u1 < 0.5) uvArr[i1] = u1 + 1;
        if (u2 < 0.5) uvArr[i2] = u2 + 1;
      }
    }
    // Sphere-only: pole-singularity smoothing. At a sphere pole, V = 0
    // (top) or V = 1 (bottom) and the position is (0, ±r, 0), so
    // atan2(0, 0) returns 0 → U = 0.5. The triangle's two non-pole vertices
    // have correct longitudes, so the triangle interpolates U from 0.5 all
    // the way to those longitudes — showing a horizontal stripe of random
    // middle-of-image content at the pole. Setting the pole vertex's U to
    // the AVERAGE of the two ring vertices' U collapses the span so the
    // pole samples the texture's top/bottom row at the right longitude.
    if (projection === 'sphere') {
      const EPS = 0.001;
      for (let t = 0; t < triCount; t++) {
        const i0 = t * 6, i1 = i0 + 2, i2 = i0 + 4;
        const v0 = uvArr[i0 + 1], v1 = uvArr[i1 + 1], v2 = uvArr[i2 + 1];
        const isPole = (v) => v < EPS || v > 1 - EPS;
        const p0 = isPole(v0), p1 = isPole(v1), p2 = isPole(v2);
        // Exactly one pole vertex per triangle — typical of UV sphere caps.
        if (p0 && !p1 && !p2) uvArr[i0] = (uvArr[i1] + uvArr[i2]) / 2;
        else if (p1 && !p0 && !p2) uvArr[i1] = (uvArr[i0] + uvArr[i2]) / 2;
        else if (p2 && !p0 && !p1) uvArr[i2] = (uvArr[i0] + uvArr[i1]) / 2;
      }
    }
  }

  geom.setAttribute('uv', new THREE.Float32BufferAttribute(uvArr, 2));
  return geom;
}
