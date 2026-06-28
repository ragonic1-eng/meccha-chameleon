import * as THREE from "three";
import { getStateCallbacks, Room } from "colyseus.js";
import type { GameMode, MoveInput } from "@shared/types";
import { C2S, S2C } from "@shared/types";
import { GameScene } from "./scene";
import { PingHud } from "./hud";
import { Net } from "./net";
import { Controls } from "./controls";
import { Avatars, type AvatarData } from "./avatars";
import { Painter } from "./painter";
import { MapLoader } from "./maploader";
import { resolveMovement } from "@shared/classroom";
import { LandingScreen, LobbyScreen, GameBar, ActionBar, PaintPalette, type StateView, type PlayerView } from "./ui";

const SPEED = 3.2; // m/s
const LOOK_SENS = 0.0034;
const POSE_EYE: Record<string, number> = { stand: 1.45, crouch: 0.95, curl: 0.6, lie: 0.4, flatten: 1.25 };

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
      ping: p.ping,
      pose: p.pose,
    })
  );
  return {
    code: state.code,
    phase: state.phase,
    mode: state.mode,
    hostId: state.hostId,
    timer: state.timer,
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
  private gamebar = new GameBar();
  private actionbar: ActionBar;
  private landing: LandingScreen;
  private lobby: LobbyScreen;
  private net: Net;
  private controls: Controls;
  private avatars: Avatars;
  private painter: Painter;
  private palette: PaintPalette;
  private camoMode = false;
  private room?: Room;
  private myId = "";

  // local player
  private pos = new THREE.Vector3();
  private yaw = 0;
  private pitch = 0;
  private dir = new THREE.Vector3();

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
    this.controls = new Controls(canvas);
    this.controls.setEnabled(false);
    this.painter = new Painter(canvas, this.scene.camera, this.scene.scene, {
      onStroke: (s) => this.net.send(C2S.PaintStroke, s),
      onSample: (hex) => {
        this.palette.setColor(hex);
        this.palette.setEyedropper(false);
      },
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
    });
    this.scene.setFrameCallback((dt) => this.onFrame(dt));
    this.scene.start();
    this.loadMap();

    this.net = new Net({
      onPing: (rtt) => this.hud.set(rtt),
      onLeave: () => this.backToLanding("Disconnected from room."),
      onError: (msg) => console.warn("[net]", msg),
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
      onLeave: () => {
        this.net.dispose();
        this.backToLanding();
      },
      onCopy: (code) => navigator.clipboard?.writeText(code).catch(() => {}),
    });
    this.actionbar = new ActionBar({
      onTag: () => this.net.send(C2S.Tag),
      onPose: (p) => this.net.send(C2S.SetPose, p),
      onCamo: () => this.toggleCamo(),
    });

    const app = document.getElementById("app")!;
    app.append(this.landing.root, this.lobby.root, this.gamebar.root);
    this.lobby.show(false);
    if (import.meta.env.DEV) (window as any).__painter = this.painter; // dev aid
  }

  private async loadMap() {
    try {
      const map = await new MapLoader().load();
      this.scene.setMap(map.group);
      console.log("[map] classroom loaded");
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

    const $ = getStateCallbacks(room);
    $(room.state).onChange(() => this.render());
    $(room.state).players.onAdd((p: any) => {
      $(p).onChange(() => this.render());
      this.render();
    });
    $(room.state).players.onRemove(() => this.render());

    room.onMessage(S2C.Eliminated, (msg: { id: string; by: string }) => {
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
    const s = toStateView(this.room.state);
    const me = s.players.find((p) => p.id === this.myId);
    this.phase = s.phase;
    this.role = me?.role ?? "unassigned";
    this.alive = me?.alive ?? true;
    this.pose = me?.pose ?? "stand";

    // camouflage is only available to a living hider during prep
    const camoEligible = this.role === "hider" && s.phase === "prep" && this.alive;
    if (this.camoMode && !camoEligible) this.exitCamo();
    if (this.camoMode) this.painter.setPose(this.pose);

    const inLobby = s.phase === "lobby";
    this.lobby.show(inLobby);
    this.lobby.update(s, this.myId);
    this.gamebar.update(s, this.myId);
    this.actionbar.update(this.role, this.phase, this.alive, this.pose, this.camoMode);

    // initialize local transform when the match begins
    if (this.prevPhase === "lobby" && s.phase === "prep" && me) {
      const mp: any = this.room.state.players.get(this.myId);
      this.pos.set(mp.x, 0, mp.z);
      // ry uses atan2(dir.x, dir.z); camera yaw (YXZ, -Z forward) relates by ry = yaw + π
      this.yaw = mp.ry - Math.PI;
      this.pitch = 0;
    }
    this.prevPhase = s.phase;

    // input enabled only while alive and in an active phase
    const canAct = this.alive && (s.phase === "prep" || s.phase === "hunt");
    this.controls.setEnabled(canAct);

    this.avatars.sync(toAvatars(this.room.state), this.myId);
  }

  private toggleCamo() {
    if (this.camoMode) this.exitCamo();
    else this.enterCamo();
  }

  private enterCamo() {
    if (!(this.role === "hider" && this.phase === "prep" && this.alive)) return;
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

  private backToLanding(msg = "") {
    this.room = undefined;
    this.camoMode = false;
    document.body.classList.remove("camo-mode");
    this.painter.setActive(false);
    this.palette.show(false);
    this.avatars.clear();
    this.controls.setEnabled(false);
    this.lobby.show(false);
    const empty: StateView = { code: "", phase: "lobby", mode: "normal", hostId: "", timer: 0, winner: "", players: [] };
    this.gamebar.update(empty, this.myId);
    this.actionbar.update("unassigned", "lobby", true, "stand", false);
    this.landing.show(true);
    if (msg) this.landing.setError(msg);
  }

  private onFrame(dt: number) {
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
    cam.rotation.set(this.pitch, this.yaw, 0, "YXZ");
    cam.getWorldDirection(this.dir);

    // ----- move (frozen for seekers during prep, and for spectators) -----
    const frozen = !this.alive || (this.role === "seeker" && this.phase === "prep");
    if (!frozen) {
      this.controls.sample();
      const m = this.controls.move;
      if (m.x || m.y) {
        const fx = this.dir.x,
          fz = this.dir.z;
        const fl = Math.hypot(fx, fz) || 1;
        const nfx = fx / fl,
          nfz = fz / fl;
        // right = forward rotated -90° around Y
        const rx = -nfz,
          rz = nfx;
        const vx = nfx * m.y + rx * m.x;
        const vz = nfz * m.y + rz * m.x;
        const [cx, cz] = resolveMovement(this.pos.x + vx * SPEED * dt, this.pos.z + vz * SPEED * dt);
        this.pos.x = cx;
        this.pos.z = cz;
      }
    }

    const eye = POSE_EYE[this.pose] ?? 1.45;
    cam.position.set(this.pos.x, eye, this.pos.z);

    // ----- replicate transform to server (~12 Hz) -----
    this.sendAcc += dt;
    if (this.sendAcc >= 0.08 && !frozen) {
      this.sendAcc = 0;
      const ry = Math.atan2(this.dir.x, this.dir.z);
      const move: MoveInput = { x: this.pos.x, y: 0, z: this.pos.z, ry };
      this.net.send(C2S.Move, move);
    }
  }

  private idleCamera(dt: number) {
    this.idleT += dt;
    const cam = this.scene.camera;
    cam.rotation.set(0, 0, 0, "YXZ");
    cam.position.set(Math.sin(this.idleT * 0.18) * 1.3, 1.6, 4.2);
    cam.lookAt(0, 1, -1);
  }
}
