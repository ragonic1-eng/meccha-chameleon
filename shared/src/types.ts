// Shared contracts between client and server. Imported via the "@shared/*" path alias.

export type Phase = "lobby" | "prep" | "hunt" | "results";
export type Role = "unassigned" | "seeker" | "hider";
export type GameMode = "normal" | "infection" | "double";
export type Pose = "stand" | "crouch" | "curl" | "lie" | "flatten";

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
  StartGame: "c:start",
  Move: "c:move",
  Tag: "c:tag",
  PaintStroke: "c:paint",
  PaintClear: "c:paintClear",
  PaintSync: "c:paintSync",
  SetPose: "c:pose",
} as const;

/** Server -> Client message types. */
export const S2C = {
  Pong: "s:pong",
  PaintStroke: "s:paint",
  PaintClear: "s:paintClear",
  Tagged: "s:tagged",
  Eliminated: "s:eliminated",
  GameOver: "s:gameover",
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
}

export interface MoveInput {
  x: number;
  y: number;
  z: number;
  ry: number; // yaw
  pose?: Pose;
}
