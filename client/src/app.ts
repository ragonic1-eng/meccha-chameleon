import * as THREE from "three";
import { getStateCallbacks, Room } from "colyseus.js";
import type { GameMode, MoveInput, ShootInput, ShotEvent } from "@shared/types";
import { C2S, S2C } from "@shared/types";
import { GameScene } from "./scene";
import { PingHud } from "./hud";
import { Net } from "./net";
import { Controls } from "./controls";
import { Avatars, type AvatarData } from "./avatars";
import { Painter } from "./painter";
import { InkFx } from "./inkfx";
import { SchoolBuilder } from "./school";
import { Audio } from "./audio";
import { resolveMovement, WALLS, PLAYER_RADIUS, WALL_T, WALL_H } from "@shared/classroom";
import { NetTool } from "./netfx";
import { LandingScreen, LobbyScreen, GameBar, ActionBar, PaintPalette, type StateView, type PlayerView } from "./ui";

const SPEED = 3.2; // m/s
const LOOK_SENS = 0.0034;
const POSE_EYE: Record<string, number> = { stand: 1.45, crouch: 0.95, curl: 0.6, lie: 0.4, flatten: 1.25 };
// climbing (must mirror the server): how the body moves on a wall / ceiling
const CLIMB_SPEED = 1.9;             // m/s up/down a wall
const CEIL_WALK_Y = WALL_H - 0.45;   // body height crawling on the ceiling (= server CLIMB_CEIL)
const WALL_TOP = CEIL_WALK_Y - 0.15; // climb above this while pushing up → step onto the ceiling

function toStateView(state: any): StateView {
  const players: PlayerView[] = [];
  state.players.forEach((p: any) =>
    players.push({
      id: p.id,
      name: p.name,
      role: p.role,
      ready: p.ready,
      connected: p.connected,
      alive: p.alive,
      isHost: p.isHost,
      isBot: p.isBot ?? false,
      ping: p.ping,
      pose: p.pose,
      pref: p.pref ?? "auto",
    })
  );
  return {
    code: state.code,
    phase: state.phase,
    mode: state.mode,
    hostId: state.hostId,
    timer: state.timer,
    hideSec: state.hideSec ?? 90,
    winner: state.winner,
    players,
  };
}

function toAvatars(state: any): AvatarData[] {
  const out: AvatarData[] = [];
  state.players.forEach((p: any) =>
    out.push({
      id: p.id,
      name: p.name,
      role: p.role,
      pose: p.pose,
      surf: p.surf ?? "floor",
      alive: p.alive,
      connected: p.connected,
      x: p.x,
      y: p.y,
      z: p.z,
      ry: p.ry,
    })
  );
  return out;
}

export class App {
  private scene: GameScene;
  private hud = new PingHud();
  private gamebar = new GameBar(() => this.quitToMenu());
  private actionbar: ActionBar;
  private landing: LandingScreen;
  private lobby: LobbyScreen;
  private net: Net;
  private controls: Controls;
  private avatars: Avatars;
  private painter: Painter;
  private palette: PaintPalette;
  private camoMode = false;
  private audio = new Audio();
  private ripples: { mesh: THREE.Mesh; t: number }[] = [];
  private room?: Room;
  private myId = "";
  private reconnectBanner?: HTMLDivElement;

  // local player
  private pos = new THREE.Vector3();
  private yaw = 0;
  private pitch = 0;
  private dir = new THREE.Vector3();

  // catching: rainbow net (first-person) + caught burst
  private inkfx!: InkFx;
  private nettool!: NetTool;
  private swingCd = 0; // seconds until the net can swing again
  private shootKick = 0; // decaying camera nudge on a swing

  // climbing
  private surf: "floor" | "wall" | "ceiling" = "floor";
  private climbY = 0;                  // height while on a wall
  private wallN = new THREE.Vector2(); // outward wall normal (xz), toward the room

  // spectating (after being caught) — free-fly camera
  private specPos = new THREE.Vector3();
  private prevAlive = true;

  // cached local view of self
  private phase = "lobby";
  private role = "unassigned";
  private alive = true;
  private pose = "stand";
  private prevPhase = "lobby";

  private idleT = 0;
  private sendAcc = 0;

  constructor(canvas: HTMLCanvasElement) {
    this.scene = new GameScene(canvas);
    this.avatars = new Avatars(this.scene.scene);
    this.inkfx = new InkFx(this.scene.scene);
    this.nettool = new NetTool(this.scene.scene);
    this.controls = new Controls(canvas);
    this.controls.setEnabled(false);
    this.painter = new Painter(canvas, this.scene.camera, this.scene.scene, {
      onStroke: (s) => this.net.send(C2S.PaintStroke, s),
      onSample: (hex) => {
        this.palette.setColor(hex);
        this.palette.setEyedropper(false);
      },
      setOverlay: (o) => this.scene.setOverlay(o),
      sampleScreen: (x, y) => this.scene.sampleScreenColor(x, y),
    });
    this.palette = new PaintPalette({
      onColor: (hex) => (this.painter.brush.color = hex),
      onBrush: (r) => (this.painter.brush.radius = r),
      onEyedropper: () => {
        this.painter.eyedropper = true;
        this.palette.setEyedropper(true);
      },
      onClear: () => {
        this.painter.clear();
        this.net.send(C2S.PaintClear);
      },
      onFill: () => this.painter.fill(),
      onErase: (active) => this.painter.setEraser(active),
      onRotate: (dyaw) => this.painter.rotate(dyaw),
    });
    this.scene.setFrameCallback((dt) => this.onFrame(dt));
    this.scene.start();
    this.loadMap();

    this.net = new Net({
      onPing: (rtt) => this.hud.set(rtt),
      onLeave: () => {
        this.setReconnecting(null);
        this.backToLanding("Lost connection to the room.");
      },
      onError: (msg) => console.warn("[net]", msg),
      onReconnecting: (attempt, max) => this.setReconnecting(`Reconnecting… (${attempt}/${max})`),
      onReconnected: (room) => {
        this.setReconnecting(null);
        this.bindRoom(room);
      },
    });

    this.landing = new LandingScreen({
      defaultName: `Player-${Math.floor(Math.random() * 1000)}`,
      onCreate: (name) => this.create(name),
      onJoin: (name, code) => this.join(name, code),
    });
    this.lobby = new LobbyScreen({
      onStart: () => this.net.send(C2S.StartGame),
      onToggleReady: (r) => this.net.send(C2S.SetReady, r),
      onSetMode: (m: GameMode) => this.net.send(C2S.SetMode, m),
      onSetHideTime: (sec) => this.net.send(C2S.SetHideTime, sec),
      onSetRolePref: (pref) => this.net.send(C2S.SetRolePref, pref),
      onAddBot: () => this.net.send(C2S.AddBot),
      onRemoveBot: () => this.net.send(C2S.RemoveBot),
      onLeave: () => {
        this.net.dispose();
        this.backToLanding();
      },
      onCopy: (code) => navigator.clipboard?.writeText(code).catch(() => {}),
    });
    this.actionbar = new ActionBar({
      onFire: () => this.swing(),
      onPose: (p) => { this.pose = p; this.net.send(C2S.SetPose, p); if (this.camoMode) this.painter.setPose(p); },
      onCamo: () => this.toggleCamo(),
      onClimb: () => this.toggleClimb(),
    });
    // unlock audio on the first touch (browser autoplay policy)
    window.addEventListener("pointerdown", () => this.audio.unlock(), { once: true });
    // device/browser Back button leaves the room → main menu
    window.addEventListener("popstate", () => { if (this.room) this.quitToMenu(); });

    const app = document.getElementById("app")!;
    const banner = document.createElement("div");
    banner.className = "reconnect-banner";
    banner.hidden = true;
    this.reconnectBanner = banner;
    app.append(this.landing.root, this.lobby.root, this.gamebar.root, banner);
    this.lobby.show(false);
    if (import.meta.env.DEV) {
      (window as any).__painter = this.painter; // dev aid
      (window as any).__app = this;
      (window as any).__net = this.net;
    }
  }

  private async loadMap() {
    try {
      const group = await new SchoolBuilder().load();
      this.scene.setMap(group);
      console.log("[map] school loaded");
    } catch (e) {
      console.warn("[map] load failed, keeping placeholder room", e);
    }
  }

  private async create(name: string) {
    this.landing.setError("");
    try {
      this.bindRoom(await this.net.create(name));
    } catch (e) {
      this.landing.setError((e as Error).message || "Could not create room.");
    }
  }

  private async join(name: string, code: string) {
    this.landing.setError("");
    if (code.length < 6) return this.landing.setError("Enter the 6-character code.");
    try {
      this.bindRoom(await this.net.joinByCode(name, code));
    } catch (e) {
      this.landing.setError((e as Error).message || "Could not join room.");
    }
  }

  private bindRoom(room: Room) {
    this.room = room;
    this.myId = room.sessionId;
    this.landing.show(false);
    // push a history entry so the device/browser Back button leaves the room (see popstate handler)
    try { history.pushState({ inRoom: true }, ""); } catch { /* ignore */ }

    const $ = getStateCallbacks(room);
    $(room.state).onChange(() => this.render());
    $(room.state).players.onAdd((p: any) => {
      $(p).onChange(() => this.render());
      this.render();
    });
    $(room.state).players.onRemove(() => this.render());

    room.onMessage(S2C.Shot, (ev: ShotEvent) => {
      if (ev.by !== this.myId) this.renderRemoteShot(ev);
    });
    room.onMessage(S2C.Eliminated, (msg: { id: string; by: string }) => {
      const victim: any = this.room?.state.players.get(msg.id);
      if (victim) this.inkfx.bodySplat(new THREE.Vector3(victim.x, (victim.y || 0) + 0.6, victim.z));
      this.audio.splat();
      if (msg.id === this.myId) {
        this.controls.setEnabled(false);
        this.exitCamo();
      }
    });
    room.onMessage(S2C.PaintStroke, (s: any) => this.avatars.applyStroke(s.id, s));
    room.onMessage(S2C.PaintClear, (m: { id: string }) => this.avatars.clearPaint(m.id));
    // pull any camouflage painted before we tuned in (late join / reconnect)
    this.net.send(C2S.PaintSync);
    this.render();
  }

  private render() {
    if (!this.room) return;
    // a freshly reconnected room can fire a render before its state has synced
    if (!(this.room.state as any)?.players) return;
    const s = toStateView(this.room.state);
    const me = s.players.find((p) => p.id === this.myId);
    this.phase = s.phase;
    this.role = me?.role ?? "unassigned";
    this.alive = me?.alive ?? true;
    this.pose = me?.pose ?? "stand";
    // never stay stuck on a wall outside active play (dead, results, lobby)
    if (!this.alive || (s.phase !== "prep" && s.phase !== "hunt")) { this.surf = "floor"; this.climbY = 0; }
    // on being caught, drop into a free-fly spectator camera at the last spot (raised to eye level)
    if (this.prevAlive && !this.alive) this.specPos.set(this.pos.x, 1.6, this.pos.z);
    this.prevAlive = this.alive;

    // camouflage is only available to a living hider during prep
    const camoEligible = this.role === "hider" && s.phase === "prep" && this.alive;
    if (this.camoMode && !camoEligible) this.exitCamo();
    if (this.camoMode) this.painter.setPose(this.pose);

    const inLobby = s.phase === "lobby";
    this.lobby.show(inLobby);
    this.lobby.update(s, this.myId);
    this.gamebar.update(s, this.myId);
    this.actionbar.update(this.role, this.phase, this.alive, this.pose, this.camoMode, this.surf !== "floor");

    // initialize local transform when the match begins
    if (this.prevPhase === "lobby" && s.phase === "prep" && me) {
      const mp: any = this.room.state.players.get(this.myId);
      this.pos.set(mp.x, 0, mp.z);
      // ry uses atan2(dir.x, dir.z); camera yaw (YXZ, -Z forward) relates by ry = yaw + π
      this.yaw = mp.ry - Math.PI;
      this.pitch = 0;
      this.surf = "floor"; this.climbY = 0;
    }
    this.prevPhase = s.phase;

    // controls enabled while alive in an active phase, OR while spectating (free-fly after caught)
    const spectating = !this.alive && s.phase !== "lobby";
    const canAct = (this.alive && (s.phase === "prep" || s.phase === "hunt")) || spectating;
    this.controls.setEnabled(canAct);

    this.avatars.sync(toAvatars(this.room.state), this.myId, this.role);
  }

  /** Seeker hunts by sound: feed the whisper cue + listen meter from the nearest hider. */
  private updateSeekerSense() {
    if (!this.actionbar) return; // render loop can tick before the constructor finishes wiring UI
    if (!this.room || this.role !== "seeker" || this.phase !== "hunt" || !this.alive) {
      this.audio.stopWhisper();
      this.actionbar.setProximity(0);
      return;
    }
    let nearest = Infinity, bearing = 0;
    (this.room.state as any).players.forEach((p: any) => {
      if (p.role !== "hider" || !p.alive || !p.connected) return;
      const dx = p.x - this.pos.x, dz = p.z - this.pos.z;
      const d = Math.hypot(dx, dz);
      if (d < nearest) {
        nearest = d;
        // bearing relative to where the seeker is facing (yaw), -1 = left .. +1 = right
        const world = Math.atan2(dx, dz);
        let rel = world - (this.yaw + Math.PI);
        rel = Math.atan2(Math.sin(rel), Math.cos(rel));
        bearing = Math.max(-1, Math.min(1, rel / (Math.PI / 2)));
      }
    });
    // closeness 0 (far/none) .. 1 (right on top) — audible within ~7m
    const intensity = nearest === Infinity ? 0 : Math.max(0, Math.min(1, 1 - nearest / 7)) ** 1.4;
    this.audio.whisper(intensity, bearing);
    this.actionbar.setProximity(intensity);
    this.actionbar.setFireReady(this.swingCd <= 0);
  }

  /** Seeker swings the rainbow net: send the aim to the server + play the swing animation. */
  private swing() {
    if (this.role !== "seeker" || this.phase !== "hunt" || !this.alive || this.camoMode) return;
    if (this.swingCd > 0) return;
    this.swingCd = 0.65;
    this.shootKick = 0.035;
    this.audio.splat();
    const o = this.scene.camera.position;
    const d = this.dir.clone().normalize();
    const shot: ShootInput = { ox: o.x, oy: o.y, oz: o.z, dx: d.x, dy: d.y, dz: d.z };
    this.net.send(C2S.Shoot, shot);
    this.nettool.swing();
  }

  /** Another seeker swung — the catch itself shows a rainbow burst via S2C.Eliminated, so nothing here. */
  private renderRemoteShot(_ev: ShotEvent) { /* remote swings need no first-person VFX */ }

  private updateRipples(dt: number) {
    for (let i = this.ripples.length - 1; i >= 0; i--) {
      const r = this.ripples[i];
      r.t += dt;
      const k = r.t / 1.1;
      r.mesh.scale.setScalar(1 + k * 9);
      (r.mesh.material as THREE.MeshBasicMaterial).opacity = Math.max(0, 0.85 * (1 - k));
      if (r.t >= 1.1) {
        this.scene.scene.remove(r.mesh);
        r.mesh.geometry.dispose();
        (r.mesh.material as THREE.Material).dispose();
        this.ripples.splice(i, 1);
      }
    }
  }

  /** Toggle climbing: near a wall → stick to it; otherwise (already climbing) drop to the floor. */
  private toggleClimb() {
    if (!(this.role === "hider" && this.alive) || this.camoMode) return;
    if (this.phase !== "prep" && this.phase !== "hunt") return;
    if (this.surf !== "floor") { this.surf = "floor"; this.climbY = 0; this.sendMove(); return; }
    const w = this.nearestWall(1.7);
    if (!w) { this.flashHint("Get next to a wall to climb 🧗"); return; }
    this.pos.x = w.x; this.pos.z = w.z;
    this.wallN.set(w.nx, w.nz);
    this.yaw = Math.atan2(-w.nx, -w.nz) - Math.PI; // camera faces the wall you're on
    this.surf = "wall";
    this.climbY = 0.25;
    this.sendMove();
  }

  /** Nearest wall flush-standing spot within `reach` m; returns the spot + outward normal (xz). */
  private nearestWall(reach: number): { x: number; z: number; nx: number; nz: number } | null {
    const px = this.pos.x, pz = this.pos.z;
    let best: { x: number; z: number; nx: number; nz: number } | null = null, bestD = reach;
    const off = PLAYER_RADIUS + WALL_T / 2 + 0.04;
    for (const s of WALLS) {
      const cx = Math.max(Math.min(s.x1, s.x2), Math.min(Math.max(s.x1, s.x2), px));
      const cz = Math.max(Math.min(s.z1, s.z2), Math.min(Math.max(s.z1, s.z2), pz));
      const dx = px - cx, dz = pz - cz, d = Math.hypot(dx, dz);
      if (d >= bestD) continue;
      let nx = dx, nz = dz;
      if (d < 1e-3) { if (s.z1 === s.z2) { nx = 0; nz = pz >= s.z1 ? 1 : -1; } else { nx = px >= s.x1 ? 1 : -1; nz = 0; } }
      else { nx /= d; nz /= d; }
      const [rx, rz] = resolveMovement(cx + nx * off, cz + nz * off);
      bestD = d;
      best = { x: rx, z: rz, nx, nz };
    }
    return best;
  }

  /** Replicate the local transform (incl. climb surface + height) to the server. */
  private sendMove() {
    const ry = this.surf === "wall" ? Math.atan2(-this.wallN.x, -this.wallN.y) : Math.atan2(this.dir.x, this.dir.z);
    const y = this.surf === "wall" ? this.climbY : this.surf === "ceiling" ? CEIL_WALK_Y : 0;
    const move: MoveInput = { x: this.pos.x, y, z: this.pos.z, ry, surf: this.surf };
    this.net.send(C2S.Move, move);
  }

  private hintEl?: HTMLDivElement;
  private hintTimer = 0;
  private flashHint(text: string) {
    if (!this.hintEl) {
      const d = document.createElement("div");
      d.style.cssText = "position:fixed;left:50%;top:16%;transform:translateX(-50%);z-index:60;background:rgba(20,24,28,.85);color:#fff;padding:8px 14px;border-radius:10px;font:600 14px/1.2 system-ui,sans-serif;pointer-events:none;transition:opacity .25s;";
      document.body.appendChild(d);
      this.hintEl = d;
    }
    this.hintEl.textContent = text;
    this.hintEl.style.opacity = "1";
    window.clearTimeout(this.hintTimer);
    this.hintTimer = window.setTimeout(() => { if (this.hintEl) this.hintEl.style.opacity = "0"; }, 1600);
  }

  private toggleCamo() {
    if (this.camoMode) this.exitCamo();
    else this.enterCamo();
  }

  private enterCamo() {
    if (!(this.role === "hider" && this.phase === "prep" && this.alive)) return;
    if (this.surf !== "floor") { this.surf = "floor"; this.climbY = 0; this.sendMove(); } // drop off any wall first
    this.camoMode = true;
    document.body.classList.add("camo-mode");
    this.controls.setEnabled(false);
    this.painter.setActive(true, this.pos);
    this.painter.setPose(this.pose);
    this.palette.show(true);
    this.render();
  }

  private exitCamo() {
    if (!this.camoMode) return;
    this.camoMode = false;
    document.body.classList.remove("camo-mode");
    this.painter.setActive(false);
    this.palette.show(false);
    const canAct = this.alive && (this.phase === "prep" || this.phase === "hunt");
    this.controls.setEnabled(canAct);
    this.render();
  }

  /** Show/hide the "Reconnecting…" banner. Pass null to hide. */
  private setReconnecting(text: string | null) {
    const b = this.reconnectBanner;
    if (!b) return;
    if (text) {
      b.textContent = text;
      b.hidden = false;
    } else {
      b.hidden = true;
    }
  }

  /** Leave the current room and return to the main menu (Quit button / Back button). */
  private quitToMenu() {
    if (this.room) this.net.dispose();
    this.backToLanding();
  }

  private backToLanding(msg = "") {
    this.room = undefined;
    this.camoMode = false;
    document.body.classList.remove("camo-mode");
    this.painter.setActive(false);
    this.palette.show(false);
    this.avatars.clear();
    this.controls.setEnabled(false);
    this.lobby.show(false);
    const empty: StateView = { code: "", phase: "lobby", mode: "normal", hostId: "", timer: 0, hideSec: 90, winner: "", players: [] };
    this.gamebar.update(empty, this.myId);
    this.actionbar.update("unassigned", "lobby", true, "stand", false);
    this.landing.show(true);
    if (msg) this.landing.setError(msg);
  }

  private onFrame(dt: number) {
    this.updateRipples(dt);
    this.inkfx.update(dt);
    this.nettool.setVisible(this.role === "seeker" && this.phase === "hunt" && this.alive && !this.camoMode);
    this.nettool.update(this.scene.camera, dt);
    if (this.swingCd > 0) this.swingCd = Math.max(0, this.swingCd - dt);
    this.shootKick += (0 - this.shootKick) * Math.min(1, dt * 14);
    this.updateSeekerSense();
    if (this.camoMode) {
      this.avatars.update(dt);
      this.painter.update();
      return;
    }
    if (this.phase === "lobby" || !this.room) {
      this.idleCamera(dt);
      return;
    }
    this.avatars.update(dt);

    // ----- look -----
    const look = this.controls.consumeLook();
    this.yaw -= look.dx * LOOK_SENS;
    this.pitch -= look.dy * LOOK_SENS;
    this.pitch = Math.max(-1.2, Math.min(1.2, this.pitch));

    const cam = this.scene.camera;
    cam.rotation.set(this.pitch + this.shootKick, this.yaw, 0, "YXZ");
    cam.getWorldDirection(this.dir);

    // ----- spectator free-fly (after being caught: roam + watch friends, no collision) -----
    if (!this.alive) {
      this.controls.sample();
      const sm = this.controls.move;
      const f = this.dir; // full 3D forward incl. pitch → look up + push to fly up
      const rx = -f.z, rz = f.x, rl = Math.hypot(rx, rz) || 1;
      const SPEC = 5;
      this.specPos.addScaledVector(f, sm.y * SPEC * dt);
      this.specPos.x += (rx / rl) * sm.x * SPEC * dt;
      this.specPos.z += (rz / rl) * sm.x * SPEC * dt;
      this.specPos.y = Math.max(0.3, Math.min(WALL_H + 5, this.specPos.y));
      cam.position.copy(this.specPos);
      return;
    }

    // ----- move / climb -----
    const canMove = this.alive && !(this.role === "seeker" && this.phase === "prep");
    this.controls.sample();
    const m = this.controls.move;

    if (this.surf === "wall") {
      // climb up/down (forward/back); strafe a little along the wall (left/right)
      if (canMove) {
        this.climbY += m.y * CLIMB_SPEED * dt;
        if (m.x) {
          const tx = -this.wallN.y, tz = this.wallN.x; // tangent along the wall in xz
          const [cx, cz] = resolveMovement(this.pos.x + tx * m.x * SPEED * 0.6 * dt, this.pos.z + tz * m.x * SPEED * 0.6 * dt);
          this.pos.x = cx; this.pos.z = cz;
        }
        if (this.climbY >= WALL_TOP && m.y > 0.15) {
          // reached the top → step onto the ceiling (move inward off the wall)
          this.surf = "ceiling"; this.climbY = CEIL_WALK_Y;
          const [cx, cz] = resolveMovement(this.pos.x + this.wallN.x * 0.7, this.pos.z + this.wallN.y * 0.7);
          this.pos.x = cx; this.pos.z = cz;
        } else if (this.climbY <= 0.05 && m.y < -0.15) {
          this.surf = "floor"; this.climbY = 0; // climbed back down to the floor
        } else {
          this.climbY = Math.max(0, Math.min(WALL_TOP, this.climbY));
        }
      }
      cam.position.set(this.pos.x, this.climbY + 0.6, this.pos.z);
    } else if (this.surf === "ceiling") {
      if (canMove && (m.x || m.y)) {
        const fhx = -Math.sin(this.yaw), fhz = -Math.cos(this.yaw); // horizontal facing from yaw
        const vx = fhx * m.y - fhz * m.x;
        const vz = fhz * m.y + fhx * m.x;
        const [cx, cz] = resolveMovement(this.pos.x + vx * SPEED * 0.85 * dt, this.pos.z + vz * SPEED * 0.85 * dt);
        this.pos.x = cx; this.pos.z = cz;
      }
      cam.position.set(this.pos.x, CEIL_WALK_Y - 0.1, this.pos.z);
    } else {
      // floor (normal walking)
      if (canMove && (m.x || m.y)) {
        const fx = this.dir.x, fz = this.dir.z;
        const fl = Math.hypot(fx, fz) || 1;
        const nfx = fx / fl, nfz = fz / fl;
        const rx = -nfz, rz = nfx; // right = forward rotated -90° around Y
        const vx = nfx * m.y + rx * m.x, vz = nfz * m.y + rz * m.x;
        const [cx, cz] = resolveMovement(this.pos.x + vx * SPEED * dt, this.pos.z + vz * SPEED * dt);
        this.pos.x = cx; this.pos.z = cz;
      }
      cam.position.set(this.pos.x, POSE_EYE[this.pose] ?? 1.45, this.pos.z);
    }

    // ----- replicate transform to server (~12 Hz) -----
    this.sendAcc += dt;
    if (this.sendAcc >= 0.08 && canMove) {
      this.sendAcc = 0;
      this.sendMove();
    }
  }

  private idleCamera(dt: number) {
    this.idleT += dt;
    const cam = this.scene.camera;
    cam.rotation.set(0, 0, 0, "YXZ");
    const a = this.idleT * 0.12;
    cam.position.set(Math.sin(a) * 3.6, 2.5, Math.cos(a) * 3.6);
    cam.lookAt(0, 0.9, 0);
  }
}
