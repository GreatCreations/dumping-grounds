// core/physics/physics.js — gravity, jump, walk integration. Platform-agnostic.
//
// The physics body is a vertical capsule (player). Each frame:
//   1. Apply gravity to vertical velocity
//   2. Apply WASD-driven horizontal velocity (instantly, no inertia for now —
//      "graceful but tight" was the directive)
//   3. Step position by velocity * dt
//   4. Collision step (see collision.js): push the capsule out of any AABB
//      overlap, zero vertical velocity if grounded
//   5. Jump impulse if requested AND grounded

import { capsuleVsAABBs } from './collision.js';

export function createBody(s) {
  return {
    pos: { x: 0, y: 0, z: 0 },
    vel: { x: 0, y: 0, z: 0 },
    grounded: false,
    radius: 0.3,            // capsule half-width
    height: 1.7,             // CURRENT capsule total height — lerped toward target
    standingHeight: 1.7,
    crouchHeight:  0.85,     // half-height crouch fits under most lintels
    landingTimer: 0,         // for graceful landing damp
  };
}

// `input` carries the per-frame intent: { forward, right, jump, yaw, crouch }
// forward/right: -1..1 axes (keyboard + analog already mixed),
// yaw: target heading in radians (mouse/look already mixed),
// jump: rising-edge boolean,
// crouch: held boolean — when true, body shrinks toward crouchHeight and walk
//   speed scales with stance (so crawling is slower than standing).
export function step(body, s, input, dt, aabbs) {
  const phys = s.physics;
  // Lerp body height toward the target stance. ~150 ms feel is k≈0.12 at 60fps.
  const targetH = input.crouch ? body.crouchHeight : body.standingHeight;
  body.height += (targetH - body.height) * Math.min(1, dt * 8);
  // Walk speed scales linearly with stance fraction: full speed standing,
  // half-ish speed crouched. Feels right for a stealthy crawl.
  const stanceFrac = body.height / body.standingHeight;
  const speed = phys.walkSpeed * stanceFrac;

  // Horizontal velocity = walk speed * input vector rotated by yaw.
  //
  // Convention:
  //   - Camera faces +Z when yaw=0 (because lookAt put it there).
  //   - Camera's "right" in world is therefore -X at yaw=0
  //     (cross product forward×up = (0,0,1)×(0,1,0) = (-1,0,0)).
  // So: world_forward = (sin yaw, _, cos yaw),  world_right = (-cos yaw, _, sin yaw)
  const cos = Math.cos(input.yaw);
  const sin = Math.sin(input.yaw);
  const fx =  input.forward * sin - input.right * cos;
  const fz =  input.forward * cos + input.right * sin;
  const mag = Math.hypot(fx, fz) || 1;
  body.vel.x = (fx / mag) * speed * clamp01(Math.hypot(input.forward, input.right));
  body.vel.z = (fz / mag) * speed * clamp01(Math.hypot(input.forward, input.right));

  // Gravity
  body.vel.y += phys.gravity * dt;

  // Jump (only if grounded; rising-edge filtered by input layer)
  if (input.jump && body.grounded) {
    // v = sqrt(2 * |g| * h)  → reach exactly jumpHeight at apex
    body.vel.y = Math.sqrt(2 * Math.abs(phys.gravity) * phys.jumpHeight);
    body.grounded = false;
  }

  // Integrate
  body.pos.x += body.vel.x * dt;
  body.pos.y += body.vel.y * dt;
  body.pos.z += body.vel.z * dt;

  // Floor
  const floorY = s.floor.enabled ? s.floor.y : -Infinity;
  if (body.pos.y < floorY) {
    if (!body.grounded) {
      // Graceful landing: dampen any remaining XY motion
      body.landingTimer = phys.landingDamping || 0;
    }
    body.pos.y = floorY;
    body.vel.y = 0;
    body.grounded = true;
  } else if (body.pos.y > floorY + 0.001) {
    body.grounded = false;
  }

  // Landing-timer dampens speed briefly for "graceful" landing feel
  if (body.landingTimer > 0) {
    body.vel.x *= 0.6;
    body.vel.z *= 0.6;
    body.landingTimer -= dt;
  }

  // Wall + object collision
  capsuleVsAABBs(body, aabbs);
}

function clamp01(x) { return Math.max(0, Math.min(1, x)); }
