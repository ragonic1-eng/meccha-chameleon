import * as THREE from "three";
import type { PaintStroke } from "@shared/types";

const TEX = 1024;
const BASE_COLOR = "#e9ece6";
const ATLAS = 4; // 4x4 UV atlas so each body part paints into its own region
const CELL = 1 / ATLAS;
const D = Math.PI / 180;

interface PoseDef {
  j?: Record<string, [number, number, number]>; // joint euler degrees
  rootRot?: [number, number, number];
  rootY?: number;
}

// Joint angles for the white-figure poses (calibrated to read at a glance).
const PRESETS: Record<string, PoseDef> = {
  stand: { j: { shR: [0, 0, 6], shL: [0, 0, -6] } },
  run: {
    j: { spine: [16, 0, 0], shR: [-45, 0, 8], elR: [-35, 0, 0], shL: [42, 0, -8], hpR: [38, 0, 0], knR: [-45, 0, 0], hpL: [-32, 0, 0], knL: [-20, 0, 0] },
  },
  point: { j: { shR: [0, 0, -92], shL: [0, 0, -8] } },
  pointup: { j: { shR: [-150, 0, -18], shL: [0, 0, -8] } },
  wave: { j: { shR: [0, 0, -150], elR: [-45, 0, 0], shL: [0, 0, -6] } },
  think: { j: { spine: [14, 0, 0], shR: [-95, 0, 14], elR: [-115, 0, 0], shL: [-20, 0, -10] } },
  cheer: { j: { shR: [-168, 0, -22], shL: [-168, 0, 22] } },
  lean: { j: { spine: [26, 0, 12], shR: [0, 0, -92], hpL: [-8, 0, 0] } },
  bow: { j: { spine: [74, 0, 0], shR: [14, 0, 6], shL: [14, 0, -6] } },
  panic: { j: { shR: [-150, 0, -28], elR: [-105, 0, 0], shL: [-150, 0, 28], elL: [-105, 0, 0] } },
  wide: { j: { shR: [0, 0, -96], shL: [0, 0, 96] } },
  lie: { rootRot: [-88 * D, 0, 0], rootY: 0.18, j: { shR: [0, 0, 18], shL: [0, 0, -18] } },
  sit: {
    rootY: -0.12,
    j: { spine: [40, 0, 0], hpR: [96, 0, 0], knR: [-125, 0, 0], hpL: [96, 0, 0], knL: [-125, 0, 0], shR: [-46, 0, 12], elR: [-95, 0, 0], shL: [-46, 0, -12], elL: [-95, 0, 0] },
  },
  // climbing (driven by the networked `surf`, not user-selectable). "wallclimb" = upright,
  // arms reaching overhead + legs spread (gecko on a wall). "ceilingcrawl" pitches the whole
  // figure forward 90° so it lies flat, face toward the floor, limbs splayed crawling.
  wallclimb: { j: { shR: [-150, 0, -16], shL: [-150, 0, 16], elR: [-26, 0, 0], elL: [-26, 0, 0], hpR: [0, 0, -20], hpL: [0, 0, 20], knR: [26, 0, 0], knL: [26, 0, 0] } },
  ceilingcrawl: { rootRot: [90 * D, 0, 0], j: { shR: [-120, 0, -18], shL: [-120, 0, 18], elR: [-20, 0, 0], elL: [-20, 0, 0], hpR: [0, 0, -24], hpL: [0, 0, 24], knR: [24, 0, 0], knL: [24, 0, 0] } },
};

/**
 * Posable white humanoid avatar whose skin is a paintable canvas (UV-atlased so each limb
 * paints independently). One mesh-set, shared material — local self-view and remote avatars
 * render identically. Replaces the earlier blob to match Meccha Chameleon's figure poses.
 */
export class PaintBody {
  readonly group = new THREE.Group();
  readonly figure = new THREE.Group();
  readonly parts: THREE.Mesh[] = [];
  readonly mat: THREE.MeshStandardMaterial;
  private joints: Record<string, THREE.Group> = {};
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private texture: THREE.CanvasTexture;

  constructor() {
    this.canvas = document.createElement("canvas");
    this.canvas.width = this.canvas.height = TEX;
    this.ctx = this.canvas.getContext("2d")!;
    this.clear();

    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.anisotropy = 4;
    this.mat = new THREE.MeshStandardMaterial({ map: this.texture, roughness: 0.82, metalness: 0 });

    this.build();
    this.group.add(this.figure);
    this.setPose("stand");
  }

  private remap(geo: THREE.BufferGeometry, cell: number) {
    const cx = (cell % ATLAS) * CELL;
    const cy = Math.floor(cell / ATLAS) * CELL;
    const uv = geo.attributes.uv as THREE.BufferAttribute;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, cx + uv.getX(i) * CELL, cy + uv.getY(i) * CELL);
    uv.needsUpdate = true;
  }

  private build() {
    let cell = 0;
    const cap = (r: number, len: number) => new THREE.CapsuleGeometry(r, len, 5, 12);
    const mk = (geo: THREE.BufferGeometry, parent: THREE.Object3D, y: number) => {
      this.remap(geo, cell++);
      const m = new THREE.Mesh(geo, this.mat);
      m.castShadow = true;
      m.position.y = y;
      parent.add(m);
      this.parts.push(m);
      return m;
    };
    const joint = (parent: THREE.Object3D, name: string, x: number, y: number) => {
      const g = new THREE.Group();
      g.position.set(x, y, 0);
      parent.add(g);
      this.joints[name] = g;
      return g;
    };

    const hips = joint(this.figure, "hips", 0, 0.5);
    const spine = joint(hips, "spine", 0, 0);
    mk(cap(0.14, 0.22), spine, 0.21); // torso
    mk(new THREE.SphereGeometry(0.145, 16, 14), spine, 0.5); // head

    for (const sgn of [1, -1] as const) {
      const s = sgn > 0 ? "R" : "L";
      const sh = joint(spine, "sh" + s, 0.17 * sgn, 0.4);
      mk(cap(0.052, 0.16), sh, -0.11); // upper arm
      const el = joint(sh, "el" + s, 0, -0.22);
      mk(cap(0.048, 0.15), el, -0.1); // lower arm
    }
    for (const sgn of [1, -1] as const) {
      const s = sgn > 0 ? "R" : "L";
      const hp = joint(hips, "hp" + s, 0.08 * sgn, 0);
      mk(cap(0.07, 0.16), hp, -0.12); // upper leg
      const kn = joint(hp, "kn" + s, 0, -0.24);
      mk(cap(0.064, 0.14), kn, -0.1); // lower leg
    }
  }

  setPose(name: string) {
    const p = PRESETS[name] || PRESETS.stand;
    for (const k in this.joints) this.joints[k].rotation.set(0, 0, 0);
    if (p.j) for (const k in p.j) { const a = p.j[k]; this.joints[k]?.rotation.set(a[0] * D, a[1] * D, a[2] * D); }
    this.figure.rotation.set(...(p.rootRot ?? [0, 0, 0]));
    this.figure.position.y = p.rootY ?? 0;
  }

  // ---- painting (operates on the shared atlas canvas in UV space) ----
  clear() {
    this.fillCanvas(BASE_COLOR);
  }

  /** Coat the whole body in one colour (a base layer to paint patterns on top of). */
  fillColor(color: string) {
    this.fillCanvas(color);
  }

  private fillCanvas(color: string) {
    this.ctx.globalAlpha = 1;
    this.ctx.fillStyle = color;
    this.ctx.fillRect(0, 0, TEX, TEX);
    if (this.texture) this.texture.needsUpdate = true;
  }

  private dab(u: number, v: number, color: string, radius: number, alpha: number) {
    const x = u * TEX;
    const y = (1 - v) * TEX;
    const r = Math.max(2, radius * TEX);
    const c = new THREE.Color(color);
    const hex = `${Math.round(c.r * 255)},${Math.round(c.g * 255)},${Math.round(c.b * 255)}`;
    const g = this.ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, `rgba(${hex},${alpha})`);
    g.addColorStop(0.7, `rgba(${hex},${alpha * 0.7})`);
    g.addColorStop(1, `rgba(${hex},0)`);
    this.ctx.fillStyle = g;
    this.ctx.beginPath();
    this.ctx.arc(x, y, r, 0, Math.PI * 2);
    this.ctx.fill();
  }

  segment(u0: number, v0: number, u1: number, v1: number, color: string, radius: number, alpha: number) {
    const len = Math.hypot(u1 - u0, v1 - v0);
    const n = Math.max(1, Math.ceil(len / Math.max(0.004, radius * 0.4)));
    for (let i = 0; i <= n; i++) this.dab(u0 + (u1 - u0) * (i / n), v0 + (v1 - v0) * (i / n), color, radius, alpha);
    this.texture.needsUpdate = true;
  }

  applyStroke(s: PaintStroke) {
    if (s.op === "fill") { this.fillColor(s.color); return; }
    const p = s.pts;
    if (p.length < 2) return;
    if (p.length === 2) this.dab(p[0], p[1], s.color, s.radius, s.alpha);
    else for (let i = 0; i < p.length - 2; i += 2) this.segment(p[i], p[i + 1], p[i + 2], p[i + 3], s.color, s.radius, s.alpha);
    this.texture.needsUpdate = true;
  }

  setOpacity(o: number) {
    this.mat.transparent = o < 1;
    this.mat.opacity = o;
  }

  dispose() {
    for (const m of this.parts) m.geometry.dispose();
    this.mat.dispose();
    this.texture.dispose();
  }
}
