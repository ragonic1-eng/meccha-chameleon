// Server-side hider-bot "brains": pick a cover spot in a room, a hiding pose, and a queue of
// camouflage paint strokes (a base coat + scribbles) that the room dispatches over prep. Pure
// data/helpers — GameRoom owns the per-tick movement, painting and fleeing.
import type { PaintStroke } from "@shared/types";
import { ROOMS, resolveMovement } from "@shared/classroom";

export interface BotBrain {
  target: { x: number; z: number };
  pose: string;
  paintQueue: PaintStroke[];
  paintIdx: number;
  nextPaintAt: number; // ms
  arrived: boolean;
  reposeAt: number; // ms — when the flee target may be re-picked
}

const HIDE_POSES = ["lie", "sit", "wide", "stand", "bow", "crouch"];
// muted, environment-ish camo bases (greens / wood / cream / grey)
const CAMO_BASES = ["#5a6e44", "#6f8f4d", "#4a5d3a", "#7a5a36", "#9a7b4f", "#8d8472", "#cdc6b4"];

const rnd = () => Math.random();
const pick = <T,>(a: T[]): T => a[Math.floor(Math.random() * a.length)];
const clampUV = (x: number) => Math.max(0.02, Math.min(0.98, x));

function shade(hex: string, f: number): string {
  const c = (i: number) => Math.max(0, Math.min(255, Math.round(parseInt(hex.slice(i, i + 2), 16) * f)));
  return "#" + [c(1), c(3), c(5)].map((x) => x.toString(16).padStart(2, "0")).join("");
}

/** A short scribbled stroke clustered around a random body region (UV space). */
function scribble(color: string): PaintStroke {
  let u = 0.15 + rnd() * 0.7, v = 0.15 + rnd() * 0.7;
  const pts = [u, v];
  const n = 5 + Math.floor(rnd() * 7);
  for (let i = 0; i < n; i++) {
    u = clampUV(u + (rnd() - 0.5) * 0.14);
    v = clampUV(v + (rnd() - 0.5) * 0.14);
    pts.push(u, v);
  }
  return { id: "", pts, color, radius: 0.04 + rnd() * 0.03, alpha: 0.9 };
}

/** Plan a bot's hide: a cover corner in room `roomIdx`, a pose, and a camo paint queue. */
export function planBot(roomIdx: number): BotBrain {
  const rm = ROOMS[roomIdx % ROOMS.length];
  // a back corner of the room (near the board wall) with some jitter = decent cover
  const side = rnd() < 0.5 ? -1 : 1;
  const cornerX = rm.cx + side * (rm.w / 2 - 0.9);
  const inward = rm.side === "north" ? 1 : -1; // interior direction from the board wall
  const cornerZ = rm.boardZ + inward * (1.0 + rnd() * 2.0);
  const [tx, tz] = resolveMovement(cornerX, cornerZ);

  const base = pick(CAMO_BASES);
  const queue: PaintStroke[] = [{ id: "", op: "fill", pts: [0, 0], color: base, radius: 0.05, alpha: 1 }];
  const n = 7 + Math.floor(rnd() * 5);
  for (let i = 0; i < n; i++) queue.push(scribble(rnd() < 0.5 ? shade(base, 0.6) : shade(base, 1.3)));

  return { target: { x: tx, z: tz }, pose: pick(HIDE_POSES), paintQueue: queue, paintIdx: 0, nextPaintAt: 0, arrived: false, reposeAt: 0 };
}

/** A flee target ~4m away from (sx,sz), clamped to the level (used during the hunt). */
export function fleeSpot(px: number, pz: number, sx: number, sz: number): { x: number; z: number } {
  const ax = px - sx, az = pz - sz, al = Math.hypot(ax, az) || 1;
  const [fx, fz] = resolveMovement(px + (ax / al) * 4, pz + (az / al) * 4);
  return { x: fx, z: fz };
}
