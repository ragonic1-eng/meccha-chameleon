// Single source of truth for the classroom layout — consumed by the client (rendering +
// collision) and the server (collision + spawns). Positions are final metres in the game's
// coordinate space (origin = room centre, floor at y=0, board on the -Z wall).

export interface Prop {
  mesh: string;
  x: number;
  z: number;
  ry: number; // yaw radians
  s?: number; // extra uniform scale
  collide?: number; // collider radius (omitted = walk-through)
}

export const ROOM = { halfX: 4, halfZ: 5, eyeStand: 1.45 };
export const PLAYER_RADIUS = 0.26;

const BOARD_Z = -ROOM.halfZ + 0.05;

function deskGrid(): Prop[] {
  const cols = [-2.6, -1.3, 0, 1.3, 2.6];
  const rows = [-1.2, 0.4, 2.0, 3.4];
  const out: Prop[] = [];
  for (const x of cols) {
    for (const z of rows) {
      out.push({ mesh: "desk01", x, z, ry: Math.PI, collide: 0.3 });
      out.push({ mesh: "chair01", x, z: z + 0.55, ry: 0 });
    }
  }
  return out;
}

export const PROPS: Prop[] = [
  { mesh: "blackboard01_1", x: 0, z: BOARD_Z, ry: 0 },
  { mesh: "board01_long", x: -2.6, z: BOARD_Z, ry: 0 },
  { mesh: "clock01", x: 2.9, z: BOARD_Z + 0.1, ry: 0 },
  { mesh: "platform01", x: 0, z: -ROOM.halfZ + 1.4, ry: 0, s: 1.2 },
  ...deskGrid(),
  { mesh: "locker01_close", x: -1.0, z: ROOM.halfZ - 0.4, ry: Math.PI, collide: 0.5 },
  { mesh: "locker01_close", x: 0.0, z: ROOM.halfZ - 0.4, ry: Math.PI, collide: 0.5 },
  { mesh: "locker01_close", x: 1.0, z: ROOM.halfZ - 0.4, ry: Math.PI, collide: 0.5 },
  { mesh: "door01_A", x: ROOM.halfX - 0.1, z: ROOM.halfZ - 1.5, ry: -Math.PI / 2 },
  { mesh: "window01", x: -ROOM.halfX + 0.1, z: -1, ry: Math.PI / 2 },
  { mesh: "window01", x: -ROOM.halfX + 0.1, z: 2, ry: Math.PI / 2 },
];

export const COLLIDERS: { x: number; z: number; r: number }[] = PROPS.filter((p) => p.collide).map((p) => ({
  x: p.x,
  z: p.z,
  r: p.collide!,
}));

export const SPAWNS = {
  seeker: { x: 0, z: ROOM.halfZ - 1, ry: Math.PI },
  hiders: [
    { x: -3.4, z: -3.4, ry: 0 },
    { x: 3.4, z: -3.4, ry: 0 },
    { x: -3.4, z: 1, ry: Math.PI / 2 },
    { x: 3.4, z: 1, ry: -Math.PI / 2 },
    { x: -3.4, z: 4, ry: 0 },
    { x: 3.4, z: 4, ry: 0 },
  ],
};

/** Clamp to walls and push out of furniture colliders. Used by client + server. */
export function resolveMovement(x: number, z: number): [number, number] {
  const bx = ROOM.halfX - PLAYER_RADIUS - 0.05;
  const bz = ROOM.halfZ - PLAYER_RADIUS - 0.05;
  x = Math.max(-bx, Math.min(bx, x));
  z = Math.max(-bz, Math.min(bz, z));
  // two passes so pushing out of one collider doesn't leave you inside its neighbour
  for (let pass = 0; pass < 2; pass++) {
    for (const c of COLLIDERS) {
      const dx = x - c.x;
      const dz = z - c.z;
      const d = Math.hypot(dx, dz);
      const min = c.r + PLAYER_RADIUS;
      if (d < min) {
        const nx = d > 1e-4 ? dx / d : 1; // degenerate (exactly centred) → push along +X
        const nz = d > 1e-4 ? dz / d : 0;
        x = c.x + nx * min;
        z = c.z + nz * min;
      }
    }
  }
  return [Math.max(-bx, Math.min(bx, x)), Math.max(-bz, Math.min(bz, z))];
}
