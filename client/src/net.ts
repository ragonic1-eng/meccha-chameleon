import { Client, Room } from "colyseus.js";
import { ROOM_NAME, C2S, S2C } from "@shared/types";

export interface NetCallbacks {
  onPing?: (rttMs: number) => void;
  onLeave?: (code: number) => void;
  onError?: (msg: string) => void;
}

/** Colyseus websocket endpoint for dev (Vite :5173 → server :2567) and prod (same origin). */
export function serverEndpoint(): string {
  const loc = window.location;
  const proto = loc.protocol === "https:" ? "wss" : "ws";
  if (loc.port === "5173") return `${proto}://${loc.hostname}:2567`;
  return `${proto}://${loc.host}`;
}

/** HTTP endpoint (code lookup, health) — same host as the server. */
export function httpEndpoint(): string {
  const loc = window.location;
  if (loc.port === "5173") return `${loc.protocol}//${loc.hostname}:2567`;
  return `${loc.protocol}//${loc.host}`;
}

export class Net {
  client: Client;
  room?: Room;
  private pingTimer?: number;
  private lastRtt = 0;

  constructor(private cb: NetCallbacks = {}) {
    this.client = new Client(serverEndpoint());
  }

  get rtt() {
    return this.lastRtt;
  }

  /** Host: create a fresh room and become its host. */
  async create(name: string): Promise<Room> {
    return this.bind(await this.client.create(ROOM_NAME, { name }));
  }

  /** Joiner: resolve a 6-char code to a roomId, then join it. */
  async joinByCode(name: string, code: string): Promise<Room> {
    const res = await fetch(`${httpEndpoint()}/api/code/${encodeURIComponent(code.trim())}`);
    if (!res.ok) throw new Error("Room not found — check the code.");
    const { roomId } = (await res.json()) as { roomId: string };
    return this.bind(await this.client.joinById(roomId, { name }));
  }

  private bind(room: Room): Room {
    this.room = room;
    room.onMessage(S2C.Pong, (clientTime: number) => {
      this.lastRtt = Math.max(0, performance.now() - clientTime);
      this.cb.onPing?.(this.lastRtt);
      room.send("c:rtt", this.lastRtt);
    });
    room.onError((code, message) => this.cb.onError?.(`${code}: ${message ?? "error"}`));
    room.onLeave((code) => {
      this.stopPingLoop();
      this.cb.onLeave?.(code);
    });
    this.startPingLoop();
    return room;
  }

  send(type: string, payload?: unknown) {
    this.room?.send(type as any, payload);
  }

  private startPingLoop() {
    this.stopPingLoop();
    const tick = () => this.room?.send(C2S.Ping, performance.now());
    tick();
    this.pingTimer = window.setInterval(tick, 1000);
  }

  stopPingLoop() {
    if (this.pingTimer) window.clearInterval(this.pingTimer);
    this.pingTimer = undefined;
  }

  dispose() {
    this.stopPingLoop();
    this.room?.leave();
  }
}
