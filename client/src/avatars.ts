import * as THREE from "three";
import type { PaintStroke } from "@shared/types";
import { PaintBody } from "./paintbody";

export interface AvatarData {
  id: string;
  name: string;
  role: string;
  pose: string;
  surf: string; // floor | wall | ceiling — climbing orientation
  alive: boolean;
  connected: boolean;
  x: number;
  y: number;
  z: number;
  ry: number;
}

interface Avatar {
  body: PaintBody;
  target: THREE.Vector3;
  targetRy: number;
  label: THREE.Sprite;
  labelName: string;
}

/** Manages meshes for *other* players (the local player paints in a self-view). */
export class Avatars {
  private map = new Map<string, Avatar>();

  constructor(private scene: THREE.Scene) {}

  /** `localRole` = the viewer's team; teammates get a floating name label, enemies never do. */
  sync(players: AvatarData[], localId: string, localRole: string) {
    const seen = new Set<string>();
    for (const p of players) {
      if (p.id === localId) continue;
      seen.add(p.id);
      let a = this.map.get(p.id);
      if (!a) a = this.create(p);
      a.body.setOpacity(p.alive ? 1 : 0.35);
      a.body.group.visible = p.connected;
      a.target.set(p.x, p.y, p.z);
      a.targetRy = p.ry;
      // climbing overrides the chosen hide pose with a surface-oriented body
      a.body.setPose(p.surf === "wall" ? "wallclimb" : p.surf === "ceiling" ? "ceilingcrawl" : p.pose);
      // name label: ONLY for living teammates (same team) — never reveal the other team
      const showLabel = p.connected && p.alive && p.role === localRole && (localRole === "seeker" || localRole === "hider");
      if (showLabel && a.labelName !== p.name) { this.setLabel(a, p.name, p.role); a.labelName = p.name; }
      a.label.visible = showLabel;
    }
    for (const [id, a] of this.map) {
      if (!seen.has(id)) {
        this.scene.remove(a.body.group);
        a.body.dispose();
        this.disposeLabel(a.label);
        this.map.delete(id);
      }
    }
  }

  private create(p: AvatarData): Avatar {
    const body = new PaintBody();
    body.group.position.set(p.x, p.y, p.z);
    const label = new THREE.Sprite(new THREE.SpriteMaterial({ transparent: true, depthTest: false }));
    label.scale.set(0.95, 0.24, 1);
    label.position.y = 1.25;
    label.renderOrder = 50;
    label.visible = false;
    body.group.add(label);
    this.scene.add(body.group);
    const a: Avatar = { body, target: new THREE.Vector3(p.x, p.y, p.z), targetRy: p.ry, label, labelName: "" };
    this.map.set(p.id, a);
    return a;
  }

  /** Paint the name into the label sprite's texture (teal for seekers, green for hiders). */
  private setLabel(a: Avatar, name: string, role: string) {
    const cv = document.createElement("canvas");
    cv.width = 256; cv.height = 64;
    const c = cv.getContext("2d")!;
    c.font = "bold 32px system-ui, -apple-system, sans-serif";
    c.textAlign = "center"; c.textBaseline = "middle";
    const tw = Math.min(244, c.measureText(name).width + 34);
    const x0 = (256 - tw) / 2;
    c.fillStyle = "rgba(8,12,16,0.72)";
    c.beginPath(); (c as any).roundRect ? (c as any).roundRect(x0, 12, tw, 40, 14) : c.rect(x0, 12, tw, 40); c.fill();
    c.fillStyle = role === "seeker" ? "#ff9a9a" : "#9fe6b4";
    c.fillText(name, 128, 33);
    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    const mat = a.label.material as THREE.SpriteMaterial;
    mat.map?.dispose();
    mat.map = tex;
    mat.needsUpdate = true;
  }

  private disposeLabel(label: THREE.Sprite) {
    const mat = label.material as THREE.SpriteMaterial;
    mat.map?.dispose();
    mat.dispose();
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
      this.disposeLabel(a.label);
    }
    this.map.clear();
  }
}
