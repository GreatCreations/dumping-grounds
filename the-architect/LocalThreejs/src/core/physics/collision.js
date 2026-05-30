// core/physics/collision.js — capsule-vs-AABB with full 6-sided resolution.
//
// For each AABB:
//   1. If the capsule isn't intersecting (lateral AND vertical overlap both
//      required), skip.
//   2. Compute penetration depth along three resolution axes:
//        - latPen   : how far to push capsule out laterally (radial)
//        - upPen    : how far to push capsule up so its FOOT clears the top
//        - downPen  : how far to push capsule down so its HEAD clears the bottom
//   3. Resolve along the axis with the smallest penetration.
//      - "up"   resolution = land on top of the box (set grounded, zero vel.y)
//      - "down" resolution = head bonk against bottom (kill upward vel.y)
//      - "lat"  resolution = side push (kill velocity component into the face)
//
// This is what makes:
//   - Half-height walls into jump-on platforms (foot lands on top)
//   - Window sills into low platforms you can clamber onto
//   - Window lintels into overhangs that bonk your head if you jump under them
//   - Windowed walls into legitimate passages: the empty cell at the opening
//     has no AABB, so you walk through; only the sill/lintel boxes collide.
//
// Floor collision (the world floor) stays separate in physics.js because
// it's an infinite plane, not an AABB, and benefits from a simpler check.

export function capsuleVsAABBs(body, aabbs) {
  for (const box of aabbs) {
    resolveOne(body, box);
  }
}

function resolveOne(body, box) {
  const r = body.radius;
  const cx = body.pos.x;
  const cz = body.pos.z;
  const cyMin = body.pos.y;                  // capsule foot
  const cyMax = body.pos.y + body.height;    // capsule head

  // Lateral closest-point to capsule axis on box footprint.
  const px = clamp(cx, box.min.x, box.max.x);
  const pz = clamp(cz, box.min.z, box.max.z);
  const dx = cx - px;
  const dz = cz - pz;
  const latDist = Math.sqrt(dx * dx + dz * dz);

  const lateralOverlap  = latDist < r;
  const verticalOverlap = cyMin < box.max.y && cyMax > box.min.y;
  if (!lateralOverlap || !verticalOverlap) return;

  // Penetration along each candidate axis. Smaller = capsule entered through
  // that face → that's the face to push out through.
  const latPen  = r - latDist;
  const upPen   = box.max.y - cyMin;        // push capsule up by this so foot is at box top
  const downPen = cyMax - box.min.y;        // push capsule down by this so head is at box bottom

  // Bias: when the capsule's foot is very close to the top AND falling, prefer
  // top resolution — this stabilizes "standing on a wall" against jitter.
  const stickyTop = (Math.abs(upPen) < 0.05) && body.vel.y <= 0;

  // Step-up bias: if the box's top is within standard player step-height
  // (0.4 m) of the foot, ALWAYS prefer the up-resolution regardless of
  // lateral penetration. Without this, the smallest-pen rule picks
  // lateral push for short boxes the player is barely touching — and
  // the player can't climb stairs or low ledges they could obviously
  // step over in real life. With this, any short obstacle becomes
  // walkable: stairs, low sills, plates, knee-high walls all behave
  // like step-up surfaces.
  const STEP_UP = 0.4;
  const stepUp = upPen > 0 && upPen <= STEP_UP && body.vel.y <= 0.1;

  if (stickyTop || stepUp || (upPen <= latPen && upPen <= downPen)) {
    // Land on top of the box.
    body.pos.y = box.max.y;
    if (body.vel.y < 0) body.vel.y = 0;
    body.grounded = true;
  } else if (downPen <= latPen) {
    // Head-bonk: push the capsule down so head clears the box bottom.
    body.pos.y = box.min.y - body.height;
    if (body.vel.y > 0) body.vel.y = 0;
  } else {
    // Lateral push.
    if (latDist < 1e-5) {
      // Capsule center is exactly inside the box footprint — push to nearest face.
      const dToMaxX = box.max.x - cx;
      const dToMinX = cx - box.min.x;
      const dToMaxZ = box.max.z - cz;
      const dToMinZ = cz - box.min.z;
      const m = Math.min(dToMaxX, dToMinX, dToMaxZ, dToMinZ);
      if (m === dToMaxX) { body.pos.x = box.max.x + r; if (body.vel.x < 0) body.vel.x = 0; }
      else if (m === dToMinX) { body.pos.x = box.min.x - r; if (body.vel.x > 0) body.vel.x = 0; }
      else if (m === dToMaxZ) { body.pos.z = box.max.z + r; if (body.vel.z < 0) body.vel.z = 0; }
      else                    { body.pos.z = box.min.z - r; if (body.vel.z > 0) body.vel.z = 0; }
    } else {
      // Standard radial push-out.
      const nx = dx / latDist;
      const nz = dz / latDist;
      body.pos.x += nx * latPen;
      body.pos.z += nz * latPen;
      const into = body.vel.x * nx + body.vel.z * nz;
      if (into < 0) {
        body.vel.x -= into * nx;
        body.vel.z -= into * nz;
      }
    }
  }
}

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
