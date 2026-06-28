import * as THREE from "three";
import type { PaintStroke } from "@shared/types";
import { PaintBody } from "./paintbody";

const MAX_STROKE_PTS = 48; // flush long strokes so remotes update mid-drag

interface PainterOpts {
  onStroke: (s: PaintStroke) => void;
  onSample: (color: string) => void;
  setOverlay: (obj: THREE.Object3D | null) => void;
}

/** Local hider's camouflage tool: self-view orbit + raycast brush + eyedropper. */
export class Painter {
  readonly body = new PaintBody();
  brush = { color: "#6f8f4d", radius: 0.05, alpha: 0.95 };
  eyedropper = false;
  active = false;

  private orbitYaw = 0;
  private orbitPitch = 0.22;
  private radius = 2.1;
  private center = new THREE.Vector3();
  private lookT = new THREE.Vector3();

  private ray = new THREE.Raycaster();
  private ndc = new THREE.Vector2();
  private pointerId = -1;
  private mode: "none" | "paint" | "orbit" = "none";
  private last = new THREE.Vector2();
  private lastUV: THREE.Vector2 | null = null;
  private cur: number[] = [];
  private sampleCache = new WeakMap<THREE.Texture, ImageData>();

  constructor(
    private canvas: HTMLCanvasElement,
    private camera: THREE.PerspectiveCamera,
    private scene: THREE.Scene,
    private opts: PainterOpts
  ) {}

  setActive(v: boolean, center?: THREE.Vector3) {
    if (v === this.active) {
      if (v && center) this.center.copy(center).add(new THREE.Vector3(0, 0.65, 0));
      return;
    }
    this.active = v;
    if (v) {
      if (center) this.center.copy(center).add(new THREE.Vector3(0, 0.65, 0));
      this.body.group.position.copy(this.center).setY(0);
      this.opts.setOverlay(this.body.group);
      this.canvas.addEventListener("pointerdown", this.onDown);
      this.canvas.addEventListener("pointermove", this.onMove);
      this.canvas.addEventListener("pointerup", this.onUp);
      this.canvas.addEventListener("pointercancel", this.onUp);
    } else {
      this.opts.setOverlay(null);
      this.canvas.removeEventListener("pointerdown", this.onDown);
      this.canvas.removeEventListener("pointermove", this.onMove);
      this.canvas.removeEventListener("pointerup", this.onUp);
      this.canvas.removeEventListener("pointercancel", this.onUp);
      this.pointerId = -1;
      this.mode = "none";
    }
  }

  setPose(pose: string) {
    this.body.setPose(pose);
  }

  clear() {
    this.body.clear();
  }

  /** position the self-view camera each frame */
  update() {
    if (!this.active) return;
    const cp = this.orbitPitch;
    const x = this.center.x + this.radius * Math.cos(cp) * Math.sin(this.orbitYaw);
    const y = this.center.y + this.radius * Math.sin(cp);
    const z = this.center.z + this.radius * Math.cos(cp) * Math.cos(this.orbitYaw);
    this.camera.position.set(x, y, z);
    // look below the body so it frames in the upper half, clear of the bottom palette
    this.lookT.copy(this.center).setY(this.center.y - 0.45);
    this.camera.lookAt(this.lookT);
  }

  private setNDC(e: PointerEvent) {
    const r = this.canvas.getBoundingClientRect();
    this.ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  }

  private hitBody(): THREE.Intersection | null {
    this.ray.setFromCamera(this.ndc, this.camera);
    const hits = this.ray.intersectObjects(this.body.parts, false);
    return hits[0] ?? null;
  }

  private onDown = (e: PointerEvent) => {
    if (this.pointerId !== -1) return;
    this.pointerId = e.pointerId;
    this.setNDC(e);

    if (this.eyedropper) {
      this.ray.setFromCamera(this.ndc, this.camera);
      const hits = this.ray.intersectObjects(this.scene.children, true);
      const hit = hits.find((h) => (h.object as THREE.Mesh).isMesh);
      if (hit) {
        const col = this.sampleColor(hit);
        if (col) {
          this.brush.color = col;
          this.opts.onSample(col);
        }
      }
      this.eyedropper = false;
      this.mode = "none";
      return;
    }

    const hit = this.hitBody();
    if (hit && hit.uv) {
      this.mode = "paint";
      this.lastUV = hit.uv.clone();
      this.cur = [hit.uv.x, hit.uv.y];
      this.body.segment(hit.uv.x, hit.uv.y, hit.uv.x, hit.uv.y, this.brush.color, this.brush.radius, this.brush.alpha);
    } else {
      this.mode = "orbit";
      this.last.set(e.clientX, e.clientY);
    }
  };

  private onMove = (e: PointerEvent) => {
    if (e.pointerId !== this.pointerId) return;
    this.setNDC(e);
    if (this.mode === "paint") {
      const hit = this.hitBody();
      if (hit && hit.uv && this.lastUV) {
        this.body.segment(this.lastUV.x, this.lastUV.y, hit.uv.x, hit.uv.y, this.brush.color, this.brush.radius, this.brush.alpha);
        this.cur.push(hit.uv.x, hit.uv.y);
        this.lastUV.copy(hit.uv);
        if (this.cur.length >= MAX_STROKE_PTS * 2) this.flush(true);
      }
    } else if (this.mode === "orbit") {
      const dx = e.clientX - this.last.x;
      const dy = e.clientY - this.last.y;
      this.orbitYaw -= dx * 0.008;
      this.orbitPitch = Math.max(-0.4, Math.min(1.2, this.orbitPitch + dy * 0.006));
      this.last.set(e.clientX, e.clientY);
    }
  };

  private onUp = (e: PointerEvent) => {
    if (e.pointerId !== this.pointerId) return;
    if (this.mode === "paint") this.flush(false);
    this.pointerId = -1;
    this.mode = "none";
    this.lastUV = null;
  };

  private flush(continuing: boolean) {
    if (this.cur.length >= 2) {
      this.opts.onStroke({ id: "", pts: this.cur.slice(), color: this.brush.color, radius: this.brush.radius, alpha: this.brush.alpha });
    }
    // keep painting from the last point if this was a mid-stroke flush
    this.cur = continuing && this.lastUV ? [this.lastUV.x, this.lastUV.y] : [];
  }

  /** dev aid: where the body projects on screen, and whether a screen point hits it */
  debug(clientX?: number, clientY?: number) {
    const r = this.canvas.getBoundingClientRect();
    const cen = this.center.clone();
    cen.project(this.camera);
    const sx = ((cen.x + 1) / 2) * r.width;
    const sy = ((1 - cen.y) / 2) * r.height;
    let hit: any = null;
    if (clientX !== undefined && clientY !== undefined) {
      this.ndc.set(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
      const h = this.hitBody();
      hit = h ? { uv: h.uv && { u: h.uv.x, v: h.uv.y } } : null;
    }
    return { active: this.active, bodyScreen: { x: Math.round(sx), y: Math.round(sy) }, hit, rect: { w: r.width, h: r.height } };
  }

  private sampleColor(hit: THREE.Intersection): string | null {
    const mat = (hit.object as THREE.Mesh).material as THREE.MeshStandardMaterial;
    if (!mat) return null;
    if (mat.map && mat.map.image && hit.uv) {
      const data = this.imageData(mat.map);
      if (data) {
        const ix = Math.min(data.width - 1, Math.max(0, Math.floor(hit.uv.x * data.width)));
        const iy = Math.min(data.height - 1, Math.max(0, Math.floor((1 - hit.uv.y) * data.height)));
        const o = (iy * data.width + ix) * 4;
        const c = new THREE.Color(data.data[o] / 255, data.data[o + 1] / 255, data.data[o + 2] / 255);
        return `#${c.getHexString()}`;
      }
    }
    if (mat.color) return `#${mat.color.getHexString()}`;
    return null;
  }

  private imageData(tex: THREE.Texture): ImageData | null {
    let d = this.sampleCache.get(tex);
    if (d) return d;
    const img = tex.image as HTMLImageElement | HTMLCanvasElement | ImageBitmap;
    const w = (img as any).width;
    const h = (img as any).height;
    if (!w || !h) return null;
    const cvs = document.createElement("canvas");
    cvs.width = w;
    cvs.height = h;
    const ctx = cvs.getContext("2d", { willReadFrequently: true })!;
    try {
      ctx.drawImage(img as CanvasImageSource, 0, 0);
      d = ctx.getImageData(0, 0, w, h);
      this.sampleCache.set(tex, d);
      return d;
    } catch {
      return null;
    }
  }
}
