// Shared contracts between client and server. Imported via the "@shared/*" path alias.

export type Phase = "lobby" | "prep" | "hunt" | "results";
export type Role = "unassigned" | "seeker" | "hider";
/** A player's lobby preference for which role they want next match. */
export type RolePref = "auto" | "seeker" | "hider";
export type GameMode = "normal" | "infection" | "double";

/** The avatar poses (white-figure poses from Meccha Chameleon). */
export const POSES = [
  "stand",
  "run",
  "point",
  "pointup",
  "wave",
  "think",
  "cheer",
  "lean",
  "bow",
  "panic",
  "wide",
  "lie",
  "sit",
] as const;
export type Pose = (typeof POSES)[number];
/** Friendly labels for the pose tray UI. */
export const POSE_LABELS: Record<Pose, string> = {
  stand: "Stand",
  run: "Run",
  point: "Point",
  pointup: "Point up",
  wave: "Wave",
  think: "Think",
  cheer: "Cheer",
  lean: "Lean",
  bow: "Bow",
  panic: "Panic",
  wide: "Arms wide",
  lie: "Lie down",
  sit: "Curl up",
};

export const DEFAULT_PORT = 2567;
export const MAX_PLAYERS = 6;
export const ROOM_NAME = "game";

/** Default match timings (seconds). Host-configurable later. */
export const TIMINGS = {
  prep: 45,
  hunt: 120,
  results: 8,
} as const;

/** Client -> Server message types. */
export const C2S = {
  Ping: "c:ping",
  SetName: "c:name",
  SetReady: "c:ready",
  SetMode: "c:mode",
  SetHideTime: "c:hidetime",
  SetRolePref: "c:rolepref",
  AddBot: "c:addbot",
  RemoveBot: "c:removebot",
  StartGame: "c:start",
  Move: "c:move",
  Tag: "c:tag",
  Shoot: "c:shoot",
  PaintStroke: "c:paint",
  PaintClear: "c:paintClear",
  PaintSync: "c:paintSync",
  SetPose: "c:pose",
  Whistle: "c:whistle",
} as const;

/** Server -> Client message types. */
export const S2C = {
  Pong: "s:pong",
  PaintStroke: "s:paint",
  PaintClear: "s:paintClear",
  Tagged: "s:tagged",
  Shot: "s:shot",
  Eliminated: "s:eliminated",
  GameOver: "s:gameover",
  Whistle: "s:whistle",
  Error: "s:error",
} as const;

/** A single brush-stroke segment painted onto a hider's body texture (UV space 0..1). */
export interface PaintStroke {
  /** painter session id */
  id: string;
  /** points along the stroke in UV space, flattened [u0,v0,u1,v1,...] */
  pts: number[];
  /** hex color, e.g. "#3a7d2c" */
  color: string;
  /** brush radius in UV units (0..1) */
  radius: number;
  /** 0..1 opacity */
  alpha: number;
  /** optional op: "fill" coats the whole body in `color` (a base layer). Omitted = normal brush. */
  op?: "fill";
}

export interface MoveInput {
  x: number;
  y: number;
  z: number;
  ry: number; // yaw
  pose?: Pose;
  surf?: string; // climbing surface: "floor" | "wall" | "ceiling"
}

/** Host-configurable hide (prep) duration bounds, seconds. */
export const HIDE_SEC_MIN = 60;
export const HIDE_SEC_MAX = 180;
export const HIDE_SEC_DEFAULT = 90;

/** Seeker fires the ink blaster: a ray from the eye (o) along a normalized direction (d). */
export interface ShootInput {
  ox: number; oy: number; oz: number;
  dx: number; dy: number; dz: number;
}

/** Broadcast of a fired shot so every client can render the rainbow-ink streak + splat.
 *  hitId is "" on a miss; (hx,hy,hz) is the impact point. */
export interface ShotEvent {
  by: string;
  ox: number; oy: number; oz: number;
  dx: number; dy: number; dz: number;
  hitId: string;
  hx: number; hy: number; hz: number;
}
