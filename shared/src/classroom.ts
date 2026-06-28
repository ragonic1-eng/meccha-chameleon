// Single source of truth for classroom collision + spawns, generated from the authored
// Unity scene by tools/parse_scene.py (engine coords: origin = room centre, floor y=0).
// Consumed by the client (movement) and the server (movement + spawns).
import data from "./classroom-data.json";

export const ROOM = { halfX: data.bounds.halfX, halfZ: data.bounds.halfZ, eyeStand: 1.45 };
export const PLAYER_RADIUS = data.playerRadius;
export const COLLIDERS: { x: number; z: number; r: number }[] = data.colliders;
export const SPAWNS: {
  seeker: { x: number; z: number; ry: number };
  hiders: { x: number; z: number; ry: number }[];
} = data.spawns;

/** Clamp to walls and push out of furniture colliders. Used by client + server. */
export function resolveMovement(x: number, z: number): [number, number] {
  const bx = ROOM.halfX - PLAYER_RADIUS - 0.05;
  const bz = ROOM.halfZ - PLAYER_RADIUS - 0.05;
  x = Math.max(-bx, Math.min(bx, x));
  z = Math.max(-bz, Math.min(bz, z));
  for (let pass = 0; pass < 2; pass++) {
    for (const c of COLLIDERS) {
      const dx = x - c.x;
      const dz = z - c.z;
      const d = Math.hypot(dx, dz);
      const min = c.r + PLAYER_RADIUS;
      if (d < min) {
        const nx = d > 1e-4 ? dx / d : 1;
        const nz = d > 1e-4 ? dz / d : 0;
        x = c.x + nx * min;
        z = c.z + nz * min;
      }
    }
  }
  return [Math.max(-bx, Math.min(bx, x)), Math.max(-bz, Math.min(bz, z))];
}
