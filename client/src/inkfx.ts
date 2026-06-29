import * as THREE from "three";

/** Transient rainbow-ink effects: the blaster streak, impact splats, flying droplets,
 *  and the big splatter burst when a hider is hit. Pooled-ish; each item self-expires. */
interface FxItem { obj: THREE.Object3D; life: number; max: number; kind: "streak" | "splat" | "flash" | "drop"; vel?: THREE.Vector3; spin?: number; }

export class InkFx {
  private items: FxItem[] = [];
  private splatTex: THREE.Texture;

  constructor(private scene: THREE.Scene) {
    this.splatTex = makeSplatTexture();
  }

  /** A fired shot: bright streak from the nozzle to the impact + muzzle flash + splat + spray. */
  shot(from: THREE.Vector3, to: THREE.Vector3) {
    const hue = Math.random();
    const dir = new THREE.Vector3().subVectors(to, from);
    const len = Math.max(0.05, dir.length());
    const geo = new THREE.CylinderGeometry(0.035, 0.012, len, 6, 1, true);
    const mat = new THREE.MeshBasicMaterial({
      color: new THREE.Color().setHSL(hue, 1, 0.62),
      transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending, depthWrite: false,
    });
    const streak = new THREE.Mesh(geo, mat);
    streak.position.copy(from).addScaledVector(dir, 0.5);
    streak.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.clone().normalize());
    this.scene.add(streak);
    this.items.push({ obj: streak, life: 0, max: 0.13, kind: "streak" });

    this.flash(from, 0.3, hue);
    this.splat(to, 0.45 + Math.random() * 0.2);
    for (let i = 0; i < 7; i++) this.droplet(to, randUnit().multiplyScalar(1.6 + Math.random() * 1.5));
  }

  /** A bigger multi-colour splatter on the spot where a hider got caught. */
  bodySplat(pos: THREE.Vector3) {
    for (let i = 0; i < 4; i++) {
      const s = this.makeSprite(0.6 + Math.random() * 0.5);
      s.position.copy(pos).add(new THREE.Vector3((Math.random() - 0.5) * 0.5, 0.55 + Math.random() * 0.8, (Math.random() - 0.5) * 0.5));
      this.scene.add(s);
      this.items.push({ obj: s, life: 0, max: 2.6, kind: "splat" });
    }
    const top = pos.clone().add(new THREE.Vector3(0, 1.0, 0));
    for (let i = 0; i < 18; i++) this.droplet(top, randUnit().multiplyScalar(2.2 + Math.random() * 2.2));
  }

  private splat(pos: THREE.Vector3, size: number) {
    const s = this.makeSprite(size);
    s.position.copy(pos);
    this.scene.add(s);
    this.items.push({ obj: s, life: 0, max: 1.5, kind: "splat" });
  }

  private flash(pos: THREE.Vector3, size: number, hue: number) {
    const s = this.makeSprite(size);
    (s.material as THREE.SpriteMaterial).color = new THREE.Color().setHSL(hue, 1, 0.75);
    (s.material as THREE.SpriteMaterial).blending = THREE.AdditiveBlending;
    s.position.copy(pos);
    this.scene.add(s);
    this.items.push({ obj: s, life: 0, max: 0.12, kind: "flash" });
  }

  private droplet(pos: THREE.Vector3, vel: THREE.Vector3) {
    const m = new THREE.Mesh(
      new THREE.SphereGeometry(0.03, 5, 4),
      new THREE.MeshBasicMaterial({ color: new THREE.Color().setHSL(Math.random(), 1, 0.6), transparent: true, depthWrite: false })
    );
    m.position.copy(pos);
    this.scene.add(m);
    this.items.push({ obj: m, life: 0, max: 0.55 + Math.random() * 0.25, kind: "drop", vel });
  }

  private makeSprite(size: number): THREE.Sprite {
    const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.splatTex, transparent: true, depthWrite: false, rotation: Math.random() * Math.PI * 2 }));
    s.scale.set(size, size, size);
    return s;
  }

  update(dt: number) {
    for (let i = this.items.length - 1; i >= 0; i--) {
      const it = this.items[i];
      it.life += dt;
      const t = it.life / it.max;
      if (t >= 1) {
        this.scene.remove(it.obj);
        disposeObj(it.obj);
        this.items.splice(i, 1);
        continue;
      }
      const mat = (it.obj as any).material as THREE.Material & { opacity: number };
      if (it.kind === "drop") {
        it.vel!.y -= 11 * dt;
        it.obj.position.addScaledVector(it.vel!, dt);
        mat.opacity = 1 - t;
      } else if (it.kind === "splat") {
        const s = it.obj.scale.x;
        if (t < 0.12) it.obj.scale.setScalar(s * (1 + dt * 6)); // quick pop-in
        mat.opacity = t < 0.12 ? t / 0.12 : 1 - (t - 0.12) / 0.88;
      } else if (it.kind === "flash") {
        mat.opacity = 1 - t;
        it.obj.scale.setScalar(it.obj.scale.x * (1 + dt * 8));
      } else {
        mat.opacity = 0.95 * (1 - t);
      }
    }
  }
}

function randUnit(): THREE.Vector3 {
  return new THREE.Vector3(Math.random() - 0.5, Math.random() * 0.6 + 0.25, Math.random() - 0.5).normalize();
}

function disposeObj(o: THREE.Object3D) {
  const m = o as THREE.Mesh;
  if (m.geometry) m.geometry.dispose();
  const mat = (o as any).material;
  if (mat) (Array.isArray(mat) ? mat : [mat]).forEach((x: THREE.Material) => x.dispose());
}

/** A rainbow ink blotch on a transparent canvas — overlapping coloured blobs + spatter. */
function makeSplatTexture(): THREE.Texture {
  const cv = document.createElement("canvas");
  cv.width = cv.height = 128;
  const c = cv.getContext("2d")!;
  c.clearRect(0, 0, 128, 128);
  const cols = ["#ff2d6b", "#ff8a00", "#ffe600", "#2ecc40", "#1e90ff", "#9b30ff"];
  // central overlapping blobs
  for (let i = 0; i < 7; i++) {
    c.fillStyle = cols[i % cols.length];
    c.globalAlpha = 0.85;
    const a = (i / 7) * Math.PI * 2;
    const r = 18 + Math.random() * 14;
    const x = 64 + Math.cos(a) * (10 + Math.random() * 10);
    const y = 64 + Math.sin(a) * (10 + Math.random() * 10);
    c.beginPath(); c.arc(x, y, r, 0, Math.PI * 2); c.fill();
  }
  // outer spatter dots
  for (let i = 0; i < 22; i++) {
    c.fillStyle = cols[Math.floor(Math.random() * cols.length)];
    c.globalAlpha = 0.7 + Math.random() * 0.3;
    const a = Math.random() * Math.PI * 2, d = 34 + Math.random() * 26;
    c.beginPath(); c.arc(64 + Math.cos(a) * d, 64 + Math.sin(a) * d, 2 + Math.random() * 5, 0, Math.PI * 2); c.fill();
  }
  c.globalAlpha = 1;
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
