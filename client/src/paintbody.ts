import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import type { PaintStroke } from "@shared/types";

const TEX = 512;
const BASE_COLOR = "#e9ece6"; // plain white-ish chameleon base

/**
 * A stylised chameleon merged into ONE geometry (body, head, eye turrets, snout, dorsal
 * crest, curled tail, four legs). Single mesh + single UV set = the whole silhouette is
 * paintable, so camouflage covers every part. Primitive UVs overlap, which only makes the
 * camo pattern repeat across parts — fine for blending.
 */
function buildChameleonGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const T = (x: number, y: number, z: number) => new THREE.Matrix4().makeTranslation(x, y, z);
  const add = (g: THREE.BufferGeometry, m: THREE.Matrix4) => {
    g.applyMatrix4(m);
    parts.push(g.toNonIndexed());
  };

  // body
  add(new THREE.CapsuleGeometry(0.24, 0.4, 8, 18), T(0, 0, 0));
  // head + snout
  add(new THREE.SphereGeometry(0.19, 18, 14), T(0, 0.42, 0.08));
  add(new THREE.ConeGeometry(0.1, 0.2, 14).applyMatrix4(new THREE.Matrix4().makeRotationX(Math.PI / 2)), T(0, 0.4, 0.28));
  // eye turrets
  add(new THREE.SphereGeometry(0.1, 12, 10), T(0.15, 0.5, 0.07));
  add(new THREE.SphereGeometry(0.1, 12, 10), T(-0.15, 0.5, 0.07));
  // dorsal crest
  for (let i = 0; i < 5; i++) add(new THREE.ConeGeometry(0.05, 0.13, 8), T(0, 0.52 - i * 0.17, -0.12));
  // curled tail
  add(
    new THREE.TorusGeometry(0.16, 0.06, 8, 18, Math.PI * 1.4).applyMatrix4(new THREE.Matrix4().makeRotationY(Math.PI / 2)),
    T(0, -0.42, -0.14)
  );
  // four legs (splayed)
  for (const [x, z] of [
    [0.2, 0.13],
    [-0.2, 0.13],
    [0.2, -0.13],
    [-0.2, -0.13],
  ] as const) {
    const leg = new THREE.CapsuleGeometry(0.05, 0.2, 4, 8).applyMatrix4(new THREE.Matrix4().makeRotationZ(x > 0 ? -0.5 : 0.5));
    add(leg, T(x, -0.24, z));
  }

  return mergeGeometries(parts, false)!;
}

/**
 * A chameleon body whose skin is a paintable canvas texture. Shared by the local
 * player (self-view painting) and every remote avatar (replays incoming strokes),
 * so local and remote renders stay pixel-identical.
 */
export class PaintBody {
  readonly group = new THREE.Group();
  readonly mesh: THREE.Mesh;
  readonly mat: THREE.MeshStandardMaterial;
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
    this.mat = new THREE.MeshStandardMaterial({ map: this.texture, roughness: 0.78, metalness: 0.0 });

    this.mesh = new THREE.Mesh(buildChameleonGeometry(), this.mat);
    this.mesh.castShadow = true;
    this.mesh.position.y = 0.65;
    this.group.add(this.mesh);

    // tiny dark pupils for character (eyes; minimal camo impact)
    const pupilMat = new THREE.MeshStandardMaterial({ color: 0x14110d, roughness: 0.4 });
    for (const x of [0.15, -0.15]) {
      const pupil = new THREE.Mesh(new THREE.SphereGeometry(0.04, 8, 8), pupilMat);
      pupil.position.set(x, 0.5, 0.15);
      this.mesh.add(pupil);
    }
  }

  clear() {
    this.ctx.globalAlpha = 1;
    this.ctx.fillStyle = BASE_COLOR;
    this.ctx.fillRect(0, 0, TEX, TEX);
    if (this.texture) this.texture.needsUpdate = true;
  }

  /** One soft brush dab at UV (0..1). */
  private dab(u: number, v: number, color: string, radius: number, alpha: number) {
    const x = u * TEX;
    const y = (1 - v) * TEX;
    const r = Math.max(2, radius * TEX);
    const g = this.ctx.createRadialGradient(x, y, 0, x, y, r);
    const c = new THREE.Color(color);
    const hex = `${Math.round(c.r * 255)},${Math.round(c.g * 255)},${Math.round(c.b * 255)}`;
    g.addColorStop(0, `rgba(${hex},${alpha})`);
    g.addColorStop(0.7, `rgba(${hex},${alpha * 0.7})`);
    g.addColorStop(1, `rgba(${hex},0)`);
    this.ctx.fillStyle = g;
    this.ctx.beginPath();
    this.ctx.arc(x, y, r, 0, Math.PI * 2);
    this.ctx.fill();
  }

  /** Paint dabs interpolated between two UV points for a continuous line. */
  segment(u0: number, v0: number, u1: number, v1: number, color: string, radius: number, alpha: number) {
    const du = u1 - u0;
    const dv = v1 - v0;
    const len = Math.hypot(du, dv);
    const step = Math.max(0.004, radius * 0.4);
    const n = Math.max(1, Math.ceil(len / step));
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      this.dab(u0 + du * t, v0 + dv * t, color, radius, alpha);
    }
    this.texture.needsUpdate = true;
  }

  /** Replay a whole stroke (used for remote players and resync). */
  applyStroke(s: PaintStroke) {
    const p = s.pts;
    if (p.length < 2) return;
    if (p.length === 2) {
      this.dab(p[0], p[1], s.color, s.radius, s.alpha);
    } else {
      for (let i = 0; i < p.length - 2; i += 2) {
        this.segment(p[i], p[i + 1], p[i + 2], p[i + 3], s.color, s.radius, s.alpha);
      }
    }
    this.texture.needsUpdate = true;
  }

  setPose(pose: string) {
    const b = this.mesh;
    b.rotation.set(0, 0, 0);
    switch (pose) {
      case "crouch":
        b.scale.set(1.05, 0.65, 1.05);
        b.position.y = 0.5;
        break;
      case "curl":
        b.scale.set(1.2, 0.75, 1.2);
        b.position.y = 0.46;
        break;
      case "lie":
        b.rotation.x = Math.PI / 2;
        b.scale.set(1, 1, 1);
        b.position.y = 0.32;
        break;
      case "flatten":
        b.scale.set(1.3, 1.1, 0.4);
        b.position.y = 0.65;
        break;
      default:
        b.scale.set(1, 1, 1);
        b.position.y = 0.65;
    }
  }

  setOpacity(o: number) {
    this.mat.transparent = o < 1;
    this.mat.opacity = o;
  }

  /** draw over scene geometry — used for the local self-view so furniture can't hide you */
  renderOnTop() {
    this.mat.depthTest = false;
    this.mat.depthWrite = false;
    this.mesh.renderOrder = 999;
  }

  dispose() {
    this.mesh.geometry.dispose();
    this.mat.dispose();
    this.texture.dispose();
  }
}
