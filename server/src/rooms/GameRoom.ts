import { Room, Client } from "@colyseus/core";
import { GameState, PlayerState } from "./schema/GameState";
import {
  C2S,
  S2C,
  POSES,
  MAX_PLAYERS,
  TIMINGS,
  HIDE_SEC_MIN,
  HIDE_SEC_MAX,
  type GameMode,
  type Phase,
  type MoveInput,
  type PaintStroke,
  type ShootInput,
} from "@shared/types";
import { SPAWNS, resolveMovement, WALLS, WALL_H } from "@shared/classroom";
import { generateCode, registerCode, releaseCode } from "./codes";
import { planBot, fleeSpot, type BotBrain } from "./BotAI";

const BOT_SPEED = 2.6; // m/s — how fast hider bots walk to cover / flee
const BOT_FLEE_DIST = 3.6; // m — a bot bolts when a seeker gets this close
// The seeker CATCHES with a long-rod net swing (melee arc), not a ranged shot.
const NET_RANGE = 3.3; // m — reach of the net (long rod)
const NET_COS = Math.cos(0.8); // hider must be within this half-cone of the swing aim
const NET_COOLDOWN = 650; // ms between swings (the swing takes time)
const CLIMB_CEIL = WALL_H - 0.45; // body height when crawling on the ceiling

/** Torso-centre height for a floor pose — used for the catch test. */
function torsoY(pose: string): number {
  switch (pose) {
    case "lie": return 0.28;
    case "curl": case "sit": return 0.5;
    case "crouch": return 0.62;
    case "flatten": return 1.0;
    default: return 0.92;
  }
}

/** World-space height the net must reach to catch this hider (accounts for climbing). */
function catchY(p: PlayerState): number {
  if (p.surf === "wall") return p.y + 0.55;  // torso a little above the climb anchor
  if (p.surf === "ceiling") return p.y;       // body lies flat at the crawl height
  return torsoY(p.pose);
}

/** 2D proper segment intersection (x,z plane). */
function segCross(ox: number, oy: number, px: number, py: number, qx: number, qy: number) {
  return (px - ox) * (qy - oy) - (py - oy) * (qx - ox);
}
function segsIntersect(ax: number, ay: number, bx: number, by: number, cx: number, cy: number, dx: number, dy: number) {
  const d1 = segCross(cx, cy, dx, dy, ax, ay), d2 = segCross(cx, cy, dx, dy, bx, by);
  const d3 = segCross(ax, ay, bx, by, cx, cy), d4 = segCross(ax, ay, bx, by, dx, dy);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}
/** Is the line of sight from (ax,az)→(bx,bz) blocked by an architectural wall? */
function losBlocked(ax: number, az: number, bx: number, bz: number) {
  for (const w of WALLS) if (segsIntersect(ax, az, bx, bz, w.x1, w.z1, w.x2, w.z2)) return true;
  return false;
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
  // Last shot time per seeker (ms) for fire-rate limiting.
  private lastShot = new Map<string, number>();
  // Hider-bot AI state, keyed by bot id (only the host can add/remove bots).
  private brains = new Map<string, BotBrain>();
  private botSeq = 0;

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

    // Host sets how long hiders get to hide (prep), 60..180s.
    this.onMessage(C2S.SetHideTime, (client, sec: number) => {
      if (client.sessionId !== this.state.hostId || this.state.phase !== "lobby") return;
      if (!Number.isFinite(sec)) return;
      this.state.hideSec = Math.max(HIDE_SEC_MIN, Math.min(HIDE_SEC_MAX, Math.round(sec)));
    });

    // each player picks which role they'd like next match (lobby only)
    this.onMessage(C2S.SetRolePref, (client, pref: string) => {
      if (this.state.phase !== "lobby") return;
      const p = this.state.players.get(client.sessionId);
      if (p && (pref === "auto" || pref === "seeker" || pref === "hider")) p.pref = pref;
    });

    this.onMessage(C2S.StartGame, (client) => {
      if (client.sessionId !== this.state.hostId) return;
      if (this.state.phase !== "lobby") return;
      if (this.state.players.size < 2) return;
      this.startMatch();
    });

    // Host adds an AI hider bot (so a 1-player game can still have things to find).
    this.onMessage(C2S.AddBot, (client) => {
      if (client.sessionId !== this.state.hostId || this.state.phase !== "lobby") return;
      if (this.state.players.size >= MAX_PLAYERS) return;
      const id = `bot_${++this.botSeq}`;
      const p = new PlayerState();
      p.id = id;
      p.name = `Bot ${this.countBots() + 1}`;
      p.isBot = true;
      p.connected = true;
      p.pref = "hider";
      this.state.players.set(id, p);
    });

    // Host removes the most-recently-added bot.
    this.onMessage(C2S.RemoveBot, (client) => {
      if (client.sessionId !== this.state.hostId || this.state.phase !== "lobby") return;
      let last: string | undefined;
      this.state.players.forEach((p, id) => { if (p.isBot) last = id; });
      if (last) { this.state.players.delete(last); this.brains.delete(last); }
    });

    // Hider-bot AI runs on the room's fixed simulation step (no-op outside prep/hunt).
    this.setSimulationInterval((dt) => this.tickBots(dt), 100);

    // Client-driven movement (relayed + bounds-clamped + rule-enforced by the server).
    this.onMessage(C2S.Move, (client, m: MoveInput) => {
      const p = this.state.players.get(client.sessionId);
      if (!p || !p.alive) return;
      if (this.state.phase !== "prep" && this.state.phase !== "hunt") return;
      // seekers are frozen at spawn during prep
      if (p.role === "seeker" && this.state.phase === "prep") return;
      if (!Number.isFinite(m.x) || !Number.isFinite(m.z) || !Number.isFinite(m.ry)) return;
      // x,z always go through the collision resolver — climbing only adds vertical height,
      // so a climber can never cross a wall (same no-ghost guarantee as the floor).
      const [rx, rz] = resolveMovement(m.x, m.z);
      p.x = rx;
      p.z = rz;
      p.ry = m.ry;
      // surface + elevation: only hiders may climb; seekers are always on the floor.
      const surf = p.role === "hider" && (m.surf === "wall" || m.surf === "ceiling") ? m.surf : "floor";
      p.surf = surf;
      if (surf === "wall") p.y = Math.max(0, Math.min(WALL_H - 0.25, Number.isFinite(m.y) ? m.y : 0));
      else if (surf === "ceiling") p.y = CLIMB_CEIL;
      else p.y = 0;
    });

    this.onMessage(C2S.SetPose, (client, pose: string) => {
      const p = this.state.players.get(client.sessionId);
      if (!p || p.role !== "hider") return;
      if ((POSES as readonly string[]).includes(pose)) p.pose = pose;
    });

    // Whistle to attract passing players — relayed to everyone else with the whistler's spot.
    this.onMessage(C2S.Whistle, (client) => {
      const p = this.state.players.get(client.sessionId);
      if (!p || !p.alive) return;
      if (this.state.phase !== "prep" && this.state.phase !== "hunt") return;
      this.broadcast(S2C.Whistle, { id: p.id, x: p.x, z: p.z }, { except: client });
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

    // Seeker SWINGS the rainbow net. Authoritative melee arc: catch the nearest alive hider
    // within NET_RANGE whose direction is inside the swing cone (NET_COS) and in clear sight.
    this.onMessage(C2S.Shoot, (client, m: ShootInput) => {
      const seeker = this.state.players.get(client.sessionId);
      if (!seeker || seeker.role !== "seeker" || !seeker.alive) return;
      if (this.state.phase !== "hunt") return;
      if (![m.ox, m.oy, m.oz, m.dx, m.dy, m.dz].every(Number.isFinite)) return;

      const now = Date.now();
      if (now - (this.lastShot.get(client.sessionId) || 0) < NET_COOLDOWN) return;
      this.lastShot.set(client.sessionId, now);

      const dl = Math.hypot(m.dx, m.dy, m.dz) || 1;
      const dx = m.dx / dl, dy = m.dy / dl, dz = m.dz / dl;

      // nearest hider within reach + inside the swing cone + clear LOS
      let victim: PlayerState | undefined;
      let bestDist = NET_RANGE;
      let hitY = 0;
      this.state.players.forEach((h) => {
        if (h.role !== "hider" || !h.alive || !h.connected) return;
        const cy = catchY(h); // accounts for wall/ceiling climbing
        const vx = h.x - m.ox, vy = cy - m.oy, vz = h.z - m.oz;
        const dist = Math.hypot(vx, vy, vz);
        if (dist > NET_RANGE || dist < 0.05) return;
        if ((vx * dx + vy * dy + vz * dz) / dist < NET_COS) return; // outside the swing arc
        if (losBlocked(m.ox, m.oz, h.x, h.z)) return;
        if (dist < bestDist) { bestDist = dist; victim = h; hitY = cy; }
      });

      const tip = Math.min(NET_RANGE, bestDist < NET_RANGE ? bestDist : NET_RANGE);
      const ev = {
        by: seeker.id, ox: m.ox, oy: m.oy, oz: m.oz, dx, dy, dz,
        hitId: victim ? victim.id : "",
        hx: victim ? victim.x : m.ox + dx * tip,
        hy: victim ? hitY : m.oy + dy * tip,
        hz: victim ? victim.z : m.oz + dz * tip,
      };
      this.broadcast(S2C.Shot, ev);

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
      // Hold the seat so a brief mobile drop (backgrounding to share the code, screen lock,
      // network blip) can rejoin the SAME room instead of forcing a new one.
      await this.allowReconnection(client, 30);
      const back = this.state.players.get(client.sessionId);
      if (back) back.connected = true;
    } catch {
      this.state.players.delete(client.sessionId);
      this.reassignHostIfNeeded();
      this.pruneBotsIfNoHumans();
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
    this.brains.clear();
    const ids = [...this.state.players.keys()];
    const player = (id: string) => this.state.players.get(id)!;
    const isBot = (id: string) => player(id).isBot;
    const pref = (id: string) => player(id).pref;
    const rand = (arr: string[]) => arr[Math.floor(Math.random() * arr.length)];
    // Seekers: honour EVERY human who chose "seeker" (two pick seeker → two seekers). With no
    // volunteers, one willing human (didn't ask to hide). If NOBODY human wants to seek (e.g.
    // you picked Hider to test solo), a BOT becomes the seeker so you can play as a hider.
    const humans = ids.filter((id) => !isBot(id));
    const botIds = ids.filter((id) => isBot(id));
    const volunteers = humans.filter((id) => pref(id) === "seeker");
    const willing = humans.filter((id) => pref(id) !== "hider");
    const seekers = new Set<string>(
      volunteers.length ? volunteers
        : willing.length ? [rand(willing)]
        : botIds.length ? [rand(botIds)]   // no human wants it → a bot hunts
        : humans.length ? [rand(humans)] : []
    );
    // DEV_SEEKER forces a single (human) seeker (testing only) — overrides preferences
    if (process.env.DEV_SEEKER === "host") { seekers.clear(); seekers.add(this.state.hostId); }
    else if (process.env.DEV_SEEKER === "guest" || process.env.DEV_SEEKER === "last") {
      const g = humans[humans.length - 1]; if (g) { seekers.clear(); seekers.add(g); }
    }
    if (seekers.size === 0) seekers.add(ids[0]); // always ≥1 seeker
    // guarantee ≥1 hider remains (else the match is unplayable): if literally everyone
    // ended up a seeker, demote one.
    if (ids.length > 1 && ids.every((id) => seekers.has(id))) seekers.delete([...seekers][seekers.size - 1]);

    // multiple seekers fan out around the central junction so they don't stack on one spot
    const seekerSpots: Spawn[] = [
      { x: 0, z: 0, ry: 0 }, { x: -1.1, z: 0.2, ry: 0 }, { x: 1.1, z: 0.2, ry: 0 },
      { x: -0.6, z: -1.1, ry: 0 }, { x: 0.6, z: -1.1, ry: 0 }, { x: 0, z: 1.2, ry: 0 },
    ];
    let hi = 0, si = 0, botRoom = 0;
    ids.forEach((id) => {
      const p = player(id);
      p.alive = true;
      p.ready = false;
      p.pose = "stand";
      p.surf = "floor";
      p.y = 0;
      if (seekers.has(id)) {
        p.role = "seeker";
        this.applySpawn(p, seekerSpots[si++ % seekerSpots.length]);
      } else {
        p.role = "hider";
        this.applySpawn(p, SPAWNS.hiders[hi++ % SPAWNS.hiders.length]);
        if (p.isBot) this.brains.set(p.id, planBot(botRoom++));
      }
    });
    this.state.winner = "";
    // hide (prep) length: env override for tests, else the host's choice, clamped 60..180
    const prepDur = Number(process.env.PREP_SECONDS) ||
      Math.max(HIDE_SEC_MIN, Math.min(HIDE_SEC_MAX, this.state.hideSec || TIMINGS.prep));
    this.setPhase("prep", prepDur);
    console.log(`[GameRoom ${this.roomId}] match started (${ids.length} players, ${seekers.size} seekers, ${this.brains.size} bots, hide ${prepDur}s)`);
  }

  private applySpawn(p: PlayerState, s: Spawn) {
    p.x = s.x;
    p.y = 0;
    p.z = s.z;
    p.ry = s.ry;
  }

  private countBots(): number {
    let n = 0;
    this.state.players.forEach((p) => { if (p.isBot) n++; });
    return n;
  }

  /** Per-tick hider-bot AI: navigate to cover + paint during prep; flee a near seeker in hunt. */
  private tickBots(dtMs: number) {
    const phase = this.state.phase as Phase;
    if (phase !== "prep" && phase !== "hunt") return;
    const dt = Math.min(0.25, dtMs / 1000);
    const now = Date.now();

    const seekers: PlayerState[] = [];
    if (phase === "hunt") this.state.players.forEach((p) => { if (p.role === "seeker" && p.alive) seekers.push(p); });

    // seeker bots hunt during the hunt phase (chase the nearest hider + swing the net)
    if (phase === "hunt") this.state.players.forEach((s) => { if (s.isBot && s.role === "seeker" && s.alive) this.tickSeekerBot(s, dt, now); });

    this.state.players.forEach((p) => {
      if (!p.isBot || p.role !== "hider" || !p.alive) return;
      const brain = this.brains.get(p.id);
      if (!brain) return;

      if (phase === "hunt") {
        // flee from the NEAREST seeker (there can be more than one)
        let near: PlayerState | undefined, sd = Infinity;
        for (const s of seekers) { const d = Math.hypot(s.x - p.x, s.z - p.z); if (d < sd) { sd = d; near = s; } }
        if (near && sd < BOT_FLEE_DIST) {
          if (now > brain.reposeAt) { brain.target = fleeSpot(p.x, p.z, near.x, near.z); brain.reposeAt = now + 650; }
          this.moveBotToward(p, brain, dt);
          p.pose = "run";
        } else {
          p.pose = brain.pose; // safe: hold the hiding pose
        }
        return;
      }

      // prep: walk to the hide spot, strike the pose, and paint over the first few seconds
      const d = this.moveBotToward(p, brain, dt);
      if (!brain.arrived && d < 0.35) { brain.arrived = true; p.pose = brain.pose; }
      if (brain.paintIdx < brain.paintQueue.length && now >= brain.nextPaintAt) {
        const stroke = brain.paintQueue[brain.paintIdx++];
        stroke.id = p.id;
        let list = this.paints.get(p.id);
        if (!list) this.paints.set(p.id, (list = []));
        list.push(stroke);
        this.broadcast(S2C.PaintStroke, stroke);
        brain.nextPaintAt = now + 320;
      }
    });
  }

  /** Seeker-bot AI (hunt only): chase the nearest alive hider and net them at close range. */
  private tickSeekerBot(s: PlayerState, dt: number, now: number) {
    let target: PlayerState | undefined, nd = Infinity;
    this.state.players.forEach((h) => {
      if (h.role !== "hider" || !h.alive || !h.connected) return;
      const d = Math.hypot(h.x - s.x, h.z - s.z);
      if (d < nd) { nd = d; target = h; }
    });
    if (!target) return;
    s.surf = "floor"; s.y = 0;
    // walk toward the target (stop a bit short so the net can reach)
    const dx = target.x - s.x, dz = target.z - s.z, d = Math.hypot(dx, dz) || 1;
    s.ry = Math.atan2(dx, dz);
    if (d > 1.0) {
      const step = BOT_SPEED * dt;
      const px0 = s.x, pz0 = s.z;
      let [nx, nz] = resolveMovement(s.x + (dx / d) * step, s.z + (dz / d) * step);
      // blocked by a wall? sidestep so it can route around toward a doorway (no full pathfinding)
      if (Math.hypot(nx - px0, nz - pz0) < step * 0.3) {
        const perp = Math.floor(now / 1500) % 2 ? 1 : -1;
        [nx, nz] = resolveMovement(px0 + (-dz / d) * perp * step, pz0 + (dx / d) * perp * step);
      }
      s.x = nx; s.z = nz;
    }
    // swing the net: target within reach (3D incl. climb height) + clear LOS + off cooldown
    const cy = catchY(target);
    const dist3 = Math.hypot(target.x - s.x, cy - 1.45, target.z - s.z);
    if (dist3 <= NET_RANGE && !losBlocked(s.x, s.z, target.x, target.z) && now - (this.lastShot.get(s.id) || 0) >= NET_COOLDOWN) {
      this.lastShot.set(s.id, now);
      const ox = s.x, oy = 1.45, oz = s.z;
      const ax = target.x - ox, ay = cy - oy, az = target.z - oz, al = Math.hypot(ax, ay, az) || 1;
      this.broadcast(S2C.Shot, { by: s.id, ox, oy, oz, dx: ax / al, dy: ay / al, dz: az / al, hitId: target.id, hx: target.x, hy: cy, hz: target.z });
      target.alive = false;
      this.broadcast(S2C.Eliminated, { id: target.id, by: s.id });
      this.checkWinDuringHunt();
    }
  }

  /** Step a bot toward its target with the shared collision resolver; returns the remaining dist. */
  private moveBotToward(p: PlayerState, brain: BotBrain, dt: number): number {
    const dx = brain.target.x - p.x, dz = brain.target.z - p.z;
    const d = Math.hypot(dx, dz);
    if (d > 0.08) {
      const step = Math.min(BOT_SPEED * dt, d);
      const [nx, nz] = resolveMovement(p.x + (dx / d) * step, p.z + (dz / d) * step);
      p.x = nx;
      p.z = nz;
      p.ry = Math.atan2(dx, dz);
    }
    return d;
  }

  /** Remove all bots if no human players remain, so the room can empty + auto-dispose. */
  private pruneBotsIfNoHumans() {
    let humans = 0;
    this.state.players.forEach((p) => { if (!p.isBot) humans++; });
    if (humans > 0) return;
    const bots: string[] = [];
    this.state.players.forEach((p, id) => { if (p.isBot) bots.push(id); });
    bots.forEach((id) => { this.state.players.delete(id); this.brains.delete(id); });
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
    this.brains.clear();
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
    const cur = this.state.players.get(this.state.hostId);
    if (cur && !cur.isBot) return;
    // hand the host to the first remaining HUMAN (bots can't host)
    let next: PlayerState | undefined;
    this.state.players.forEach((p) => { if (!next && !p.isBot) next = p; });
    if (next) {
      next.isHost = true;
      this.state.hostId = next.id;
    } else {
      this.state.hostId = "";
    }
  }
}
