import { Room, Client } from "@colyseus/core";
import { GameState, PlayerState } from "./schema/GameState";
import {
  C2S,
  S2C,
  MAX_PLAYERS,
  TIMINGS,
  type GameMode,
  type Phase,
  type MoveInput,
  type PaintStroke,
} from "@shared/types";
import { SPAWNS, resolveMovement } from "@shared/classroom";
import { generateCode, registerCode, releaseCode } from "./codes";

const TAG_RANGE = 1.7; // metres
const TAG_CONE = 1.1; // radians half-angle the seeker must be facing within

function angleDiff(a: number, b: number) {
  let d = a - b;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return Math.abs(d);
}

interface JoinOptions {
  name?: string;
}

interface Spawn {
  x: number;
  z: number;
  ry: number;
}

export class GameRoom extends Room<GameState> {
  maxClients = MAX_PLAYERS;
  private loop?: { clear: () => void };
  // Phase durations, overridable via env for fast testing.
  private prepSec = Number(process.env.PREP_SECONDS) || TIMINGS.prep;
  private huntSec = Number(process.env.HUNT_SECONDS) || TIMINGS.hunt;
  private resultsSec = Number(process.env.RESULTS_SECONDS) || TIMINGS.results;
  // Accumulated camouflage brush strokes per player (events, not synced schema).
  private paints = new Map<string, PaintStroke[]>();

  onCreate() {
    this.state = new GameState();
    this.state.code = generateCode();
    registerCode(this.state.code, this.roomId);
    this.autoDispose = true;

    // latency: bounce the client's timestamp straight back
    this.onMessage(C2S.Ping, (client, clientTime: number) => client.send("s:pong", clientTime));
    this.onMessage("c:rtt", (client, rtt: number) => {
      const p = this.state.players.get(client.sessionId);
      if (p) p.ping = Math.max(0, Math.round(rtt));
    });

    this.onMessage(C2S.SetName, (client, name: string) => {
      const p = this.state.players.get(client.sessionId);
      if (p && typeof name === "string") p.name = name.slice(0, 16).trim() || p.name;
    });

    this.onMessage(C2S.SetReady, (client, ready: boolean) => {
      const p = this.state.players.get(client.sessionId);
      if (p) p.ready = !!ready;
    });

    this.onMessage(C2S.SetMode, (client, mode: GameMode) => {
      if (client.sessionId !== this.state.hostId) return;
      if (mode === "normal" || mode === "infection" || mode === "double") this.state.mode = mode;
    });

    this.onMessage(C2S.StartGame, (client) => {
      if (client.sessionId !== this.state.hostId) return;
      if (this.state.phase !== "lobby") return;
      if (this.state.players.size < 2) return;
      this.startMatch();
    });

    // Client-driven movement (relayed + bounds-clamped + rule-enforced by the server).
    this.onMessage(C2S.Move, (client, m: MoveInput) => {
      const p = this.state.players.get(client.sessionId);
      if (!p || !p.alive) return;
      if (this.state.phase !== "prep" && this.state.phase !== "hunt") return;
      // seekers are frozen at spawn during prep
      if (p.role === "seeker" && this.state.phase === "prep") return;
      if (!Number.isFinite(m.x) || !Number.isFinite(m.z) || !Number.isFinite(m.ry)) return;
      const [rx, rz] = resolveMovement(m.x, m.z);
      p.x = rx;
      p.z = rz;
      p.ry = m.ry;
    });

    this.onMessage(C2S.SetPose, (client, pose: string) => {
      const p = this.state.players.get(client.sessionId);
      if (!p || p.role !== "hider") return;
      if (["stand", "crouch", "curl", "lie", "flatten"].includes(pose)) p.pose = pose;
    });

    // Camouflage painting: hiders paint during prep; strokes are relayed + stored.
    this.onMessage(C2S.PaintStroke, (client, stroke: PaintStroke) => {
      const p = this.state.players.get(client.sessionId);
      if (!p || p.role !== "hider" || this.state.phase !== "prep") return;
      if (!stroke || !Array.isArray(stroke.pts) || stroke.pts.length < 2) return;
      stroke.id = client.sessionId;
      let list = this.paints.get(client.sessionId);
      if (!list) this.paints.set(client.sessionId, (list = []));
      if (list.length < 4000) list.push(stroke); // safety cap
      this.broadcast(S2C.PaintStroke, stroke, { except: client });
    });

    this.onMessage(C2S.PaintClear, (client) => {
      const p = this.state.players.get(client.sessionId);
      if (!p || p.role !== "hider" || this.state.phase !== "prep") return;
      this.paints.set(client.sessionId, []);
      this.broadcast(S2C.PaintClear, { id: client.sessionId }, { except: client });
    });

    // A client (late joiner / reconnect) asks for the full paint history.
    this.onMessage(C2S.PaintSync, (client) => {
      this.paints.forEach((list) => {
        for (const s of list) client.send("s:paint", s);
      });
    });

    // Seeker attempts a tag; the server validates range + facing and resolves it.
    this.onMessage(C2S.Tag, (client) => {
      const seeker = this.state.players.get(client.sessionId);
      if (!seeker || seeker.role !== "seeker" || !seeker.alive) return;
      if (this.state.phase !== "hunt") return;

      let victim: PlayerState | undefined;
      let bestD = TAG_RANGE;
      this.state.players.forEach((h) => {
        if (h.role !== "hider" || !h.alive || !h.connected) return;
        const dx = h.x - seeker.x;
        const dz = h.z - seeker.z;
        const d = Math.hypot(dx, dz);
        if (d > bestD) return;
        const toTarget = Math.atan2(dx, dz);
        if (angleDiff(toTarget, seeker.ry) <= TAG_CONE) {
          bestD = d;
          victim = h;
        }
      });

      if (victim) {
        victim.alive = false;
        this.broadcast(S2C.Eliminated, { id: victim.id, by: seeker.id });
        this.checkWinDuringHunt();
      }
    });

    console.log(`[GameRoom ${this.roomId}] created — code ${this.state.code}`);
  }

  onJoin(client: Client, options: JoinOptions = {}) {
    // Once a match is underway, late joiners would unbalance roles — block for now.
    const p = new PlayerState();
    p.id = client.sessionId;
    p.name = (options.name || "").slice(0, 16).trim() || `Player ${this.state.players.size + 1}`;

    if (this.state.players.size === 0) {
      p.isHost = true;
      this.state.hostId = client.sessionId;
    }
    this.state.players.set(client.sessionId, p);
    console.log(`[GameRoom ${this.roomId}] ${p.name} joined (${this.state.players.size}/${MAX_PLAYERS})`);
  }

  async onLeave(client: Client, consented: boolean) {
    const p = this.state.players.get(client.sessionId);
    if (p) p.connected = false;
    try {
      if (consented) throw new Error("consented");
      await this.allowReconnection(client, 20);
      const back = this.state.players.get(client.sessionId);
      if (back) back.connected = true;
    } catch {
      this.state.players.delete(client.sessionId);
      this.reassignHostIfNeeded();
      this.checkWinDuringHunt();
    }
  }

  onDispose() {
    this.loop?.clear();
    releaseCode(this.state.code);
  }

  // ---- match flow ----

  private startMatch() {
    this.paints.clear();
    const ids = [...this.state.players.keys()];
    // one random seeker (Normal mode); everyone else hides
    let seekerIdx = Math.floor(Math.random() * ids.length);
    // DEV_SEEKER=host|guest forces who seeks (testing only)
    if (process.env.DEV_SEEKER === "host") seekerIdx = Math.max(0, ids.indexOf(this.state.hostId));
    else if (process.env.DEV_SEEKER === "guest" || process.env.DEV_SEEKER === "last") seekerIdx = ids.length - 1;
    let hi = 0;
    ids.forEach((id, i) => {
      const p = this.state.players.get(id)!;
      p.alive = true;
      p.ready = false;
      p.pose = "stand";
      if (i === seekerIdx) {
        p.role = "seeker";
        this.applySpawn(p, SPAWNS.seeker);
      } else {
        p.role = "hider";
        this.applySpawn(p, SPAWNS.hiders[hi % SPAWNS.hiders.length]);
        hi++;
      }
    });
    this.state.winner = "";
    this.setPhase("prep", this.prepSec);
    console.log(`[GameRoom ${this.roomId}] match started (${ids.length} players)`);
  }

  private applySpawn(p: PlayerState, s: Spawn) {
    p.x = s.x;
    p.y = 0;
    p.z = s.z;
    p.ry = s.ry;
  }

  private setPhase(phase: Phase, seconds: number) {
    this.state.phase = phase;
    this.state.timer = seconds;
    this.loop?.clear();
    this.loop = this.clock.setInterval(() => {
      this.state.timer = Math.max(0, this.state.timer - 1);
      if (this.state.timer <= 0) this.advancePhase();
    }, 1000);
  }

  private advancePhase() {
    switch (this.state.phase as Phase) {
      case "prep":
        this.setPhase("hunt", this.huntSec);
        break;
      case "hunt":
        // timer expired with survivors → hiders win
        this.endMatch("hiders");
        break;
      case "results":
        this.resetToLobby();
        break;
    }
  }

  private endMatch(winner: "hiders" | "seekers") {
    this.state.winner = winner;
    this.setPhase("results", this.resultsSec);
    console.log(`[GameRoom ${this.roomId}] match over — ${winner} win`);
  }

  /** Called when a hider is eliminated or leaves: seekers win if no hiders remain alive. */
  checkWinDuringHunt() {
    if (this.state.phase !== "hunt") return;
    let aliveHiders = 0;
    this.state.players.forEach((p) => {
      if (p.role === "hider" && p.alive && p.connected) aliveHiders++;
    });
    if (aliveHiders === 0) this.endMatch("seekers");
  }

  private resetToLobby() {
    this.loop?.clear();
    this.loop = undefined;
    this.paints.clear();
    this.state.phase = "lobby";
    this.state.timer = 0;
    this.state.winner = "";
    this.state.players.forEach((p) => {
      p.role = "unassigned";
      p.alive = true;
      p.ready = false;
      p.pose = "stand";
    });
  }

  private reassignHostIfNeeded() {
    if (this.state.players.has(this.state.hostId)) return;
    const next = this.state.players.values().next().value as PlayerState | undefined;
    if (next) {
      next.isHost = true;
      this.state.hostId = next.id;
    } else {
      this.state.hostId = "";
    }
  }
}
