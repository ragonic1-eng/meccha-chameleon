import * as THREE from "three";
import type { PaintStroke } from "@shared/types";
import { PaintBody } from "./paintbody";

export interface AvatarData {
  id: string;
  name: string;
  role: string;
  pose: string;
  alive: boolean;
  connected: boolean;
  x: number;
  y: number;
  z: number;
  ry: number;
}

interface Avatar {
  body: PaintBody;
  label: THREE.Sprite;
  target: THREE.Vector3;
  targetRy: number;
}

function makeLabel(text: string): THREE.Sprite {
  const cvs = document.createElement("canvas");
  cvs.width = 256;
  cvs.height = 64;
  const ctx = cvs.getContext("2d")!;
  ctx.fillStyle = "rgba(0,0,0,0.55)";
  ctx.roundRect(8, 8, 240, 48, 12);
  ctx.fill();
  ctx.fillStyle = "#fff";
  ctx.font = "bold 30px system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text.slice(0, 12), 128, 33);
  const tex = new THREE.CanvasTexture(cvs);
  tex.anisotropy = 4;
  const spr = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true }));
  spr.scale.set(0.9, 0.225, 1);
  spr.position.y = 1.45;
  return spr;
}

/** Manages meshes for *other* players (the local player paints in a self-view). */
export class Avatars {
  private map = new Map<string, Avatar>();

  constructor(private scene: THREE.Scene) {}

  sync(players: AvatarData[], localId: string) {
    const seen = new Set<string>();
    for (const p of players) {
      if (p.id === localId) continue;
      seen.add(p.id);
      let a = this.map.get(p.id);
      if (!a) a = this.create(p);
      a.label.material.opacity = p.alive ? 1 : 0.3;
      a.body.setOpacity(p.alive ? 1 : 0.35);
      a.body.group.visible = p.connected;
      a.target.set(p.x, p.y, p.z);
      a.targetRy = p.ry;
      a.body.setPose(p.pose);
    }
    for (const [id, a] of this.map) {
      if (!seen.has(id)) {
        this.scene.remove(a.body.group);
        a.body.dispose();
        this.map.delete(id);
      }
    }
  }

  private create(p: AvatarData): Avatar {
    const body = new PaintBody();
    const label = makeLabel(p.name);
    body.group.add(label);
    body.group.position.set(p.x, p.y, p.z);
    this.scene.add(body.group);
    const a: Avatar = { body, label, target: new THREE.Vector3(p.x, p.y, p.z), targetRy: p.ry };
    this.map.set(p.id, a);
    return a;
  }

  applyStroke(id: string, stroke: PaintStroke) {
    this.map.get(id)?.body.applyStroke(stroke);
  }

  clearPaint(id: string) {
    this.map.get(id)?.body.clear();
  }

  update(dt: number) {
    const k = 1 - Math.pow(0.001, dt);
    for (const a of this.map.values()) {
      a.body.group.position.lerp(a.target, k);
      let d = a.targetRy - a.body.group.rotation.y;
      while (d > Math.PI) d -= Math.PI * 2;
      while (d < -Math.PI) d += Math.PI * 2;
      a.body.group.rotation.y += d * k;
    }
  }

  clear() {
    for (const a of this.map.values()) {
      this.scene.remove(a.body.group);
      a.body.dispose();
    }
    this.map.clear();
  }
}
