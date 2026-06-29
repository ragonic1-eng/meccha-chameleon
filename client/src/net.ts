import { Client, Room } from "colyseus.js";
import { ROOM_NAME, C2S, S2C } from "@shared/types";

export interface NetCallbacks {
  onPing?: (rttMs: number) => void;
  onLeave?: (code: number) => void;
  onError?: (msg: string) => void;
  /** Fired while we're trying to rejoin the same room after an unexpected drop. */
  onReconnecting?: (attempt: number, max: number) => void;
  /** Fired when reconnection succeeds — hand the fresh Room back so the app re-binds it. */
  onReconnected?: (room: Room) => void;
}

// Optional explicit game-server URL (set VITE_GAME_SERVER at build time when the client is
// hosted separately from the server, e.g. front-end on Vercel + server on Railway/Render).
const GAME_SERVER = (import.meta.env.VITE_GAME_SERVER as string | undefined)?.replace(/\/$/, "");

/** True when a separate game server is configured (front-end-only hosts like Vercel need this). */
export function hasConfiguredServer(): boolean {
  return !!GAME_SERVER;
}

/** Colyseus websocket endpoint. */
export function serverEndpoint(): string {
  if (GAME_SERVER) return GAME_SERVER.replace(/^http/, "ws");
  const loc = window.location;
  const proto = loc.protocol === "https:" ? "wss" : "ws";
  if (loc.port === "5173") return `${proto}://${loc.hostname}:2567`;
  return `${proto}://${loc.host}`;
}

/** HTTP endpoint (code lookup, health). */
export function httpEndpoint(): string {
  if (GAME_SERVER) return GAME_SERVER.replace(/^ws/, "http");
  const loc = window.location;
  if (loc.port === "5173") return `${loc.protocol}//${loc.hostname}:2567`;
  return `${loc.protocol}//${loc.host}`;
}

// Delays (ms) BEFORE each reconnect attempt. The first wait lets the server finish registering
// allowReconnection() and the old socket fully close; the rest space retries across the server's
// ~30s reconnection window so attempts never race each other (rapid-fire retries fail).
const RECONNECT_DELAYS = [700, 1300, 2000, 3000, 4500, 6000, 8000];

export class Net {
  client: Client;
  room?: Room;
  private pingTimer?: number;
  private lastRtt = 0;
  private reconnectToken?: string;
  private intentionalLeave = false;
  private reconnecting = false;

  constructor(private cb: NetCallbacks = {}) {
    this.client = new Client(serverEndpoint());
    // Mobile browsers suspend the socket when backgrounded; nudge a reconnect on return.
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") this.startPingLoop();
    });
  }

  get rtt() {
    return this.lastRtt;
  }

  /** Host: create a fresh room and become its host. */
  async create(name: string): Promise<Room> {
    this.intentionalLeave = false;
    try {
      return this.bind(await this.client.create(ROOM_NAME, { name }));
    } catch {
      throw new Error("Can't reach the game server. Is it running?");
    }
  }

  /** Joiner: resolve a 6-char code to a roomId, then join it. */
  async joinByCode(name: string, code: string): Promise<Room> {
    this.intentionalLeave = false;
    let res: Response;
    try {
      res = await fetch(`${httpEndpoint()}/api/code/${encodeURIComponent(code.trim())}`);
    } catch {
      throw new Error("Can't reach the game server. Is it running?");
    }
    if (res.status === 404) throw new Error("Room not found — check the code.");
    if (!res.ok) throw new Error("Can't reach the game server. Is it running?");
    const { roomId } = (await res.json()) as { roomId: string };
    try {
      return this.bind(await this.client.joinById(roomId, { name }));
    } catch {
      throw new Error("Couldn't join — the room may have closed.");
    }
  }

  private bind(room: Room): Room {
    this.room = room;
    this.reconnectToken = room.reconnectionToken;
    room.onMessage(S2C.Pong, (clientTime: number) => {
      this.lastRtt = Math.max(0, performance.now() - clientTime);
      this.cb.onPing?.(this.lastRtt);
      room.send("c:rtt", this.lastRtt);
    });
    room.onError((code, message) => this.cb.onError?.(`${code}: ${message ?? "error"}`));
    // Ignore a late leave from a room we've already replaced (e.g. the old socket firing
    // after we reconnected) — only the active room's drop should drive reconnection.
    room.onLeave((code) => {
      if (room !== this.room) return;
      this.handleLeave(code);
    });
    this.startPingLoop();
    return room;
  }

  /**
   * A close on a live room is either a deliberate leave (go home) or an unexpected drop
   * (try to rejoin the SAME room so the room code is preserved). Codes 1000/1001 are normal
   * closures; everything else is treated as a recoverable drop.
   */
  private handleLeave(code: number) {
    this.stopPingLoop();
    if (this.intentionalLeave || code === 1000) {
      this.cb.onLeave?.(code);
      return;
    }
    void this.attemptReconnect(code);
  }

  /** Resolve once the room's state has synced (with a fallback) so the app re-binds against
   *  a populated state — reconnect() resolves before the first state patch arrives. */
  private waitForState(room: Room): Promise<void> {
    return new Promise((resolve) => {
      if ((room.state as any)?.players) return resolve();
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        resolve();
      };
      room.onStateChange.once(finish);
      setTimeout(finish, 2000);
    });
  }

  private async attemptReconnect(originalCode: number) {
    if (this.reconnecting) return;
    if (!this.reconnectToken) {
      this.cb.onLeave?.(originalCode);
      return;
    }
    this.reconnecting = true;
    const max = RECONNECT_DELAYS.length;
    for (let i = 0; i < max; i++) {
      if (this.intentionalLeave) {
        this.reconnecting = false;
        return;
      }
      this.cb.onReconnecting?.(i + 1, max);
      await new Promise((r) => setTimeout(r, RECONNECT_DELAYS[i]));
      if (this.intentionalLeave) {
        this.reconnecting = false;
        return;
      }
      try {
        const room = await this.client.reconnect(this.reconnectToken);
        await this.waitForState(room); // don't hand back a room whose state hasn't synced yet
        this.reconnecting = false;
        this.bind(room);
        this.cb.onReconnected?.(room);
        return;
      } catch {
        /* room may still be registering — wait for the next spaced attempt */
      }
    }
    this.reconnecting = false;
    this.cb.onLeave?.(originalCode);
  }

  send(type: string, payload?: unknown) {
    try {
      this.room?.send(type as any, payload);
    } catch {
      /* socket mid-drop; ignore — state re-syncs on reconnect */
    }
  }

  private startPingLoop() {
    if (!this.room || this.reconnecting) return;
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
    this.intentionalLeave = true;
    this.stopPingLoop();
    this.room?.leave();
  }
}
