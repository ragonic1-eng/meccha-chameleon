import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { PROPS, ROOM, SPAWNS } from "@shared/classroom";

const BASE = "maps/classroom";

interface MatEntry {
  albedo: string | null;
  normal: string | null;
}
interface Manifest {
  meshes: Record<string, { file: string; materials: Record<string, MatEntry> }>;
}

export interface LoadedMap {
  group: THREE.Group;
  bounds: { x: number; z: number };
  spawns: { seeker: { x: number; z: number; ry: number }; hiders: { x: number; z: number; ry: number }[] };
}

export class MapLoader {
  private gltf = new GLTFLoader();
  private tex = new THREE.TextureLoader();
  private texCache = new Map<string, THREE.Texture>();

  private texture(file: string, srgb: boolean): THREE.Texture {
    let t = this.texCache.get(file);
    if (!t) {
      t = this.tex.load(`${BASE}/textures/${file}`);
      t.wrapS = t.wrapT = THREE.RepeatWrapping;
      t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
      t.anisotropy = 4;
      this.texCache.set(file, t);
    }
    return t;
  }

  /** Build a textured MeshStandardMaterial for a named material slot. */
  private material(name: string, entry?: MatEntry): THREE.Material {
    if (/glass/i.test(name)) {
      return new THREE.MeshStandardMaterial({ color: 0xaecfe0, transparent: true, opacity: 0.25, roughness: 0.1, metalness: 0 });
    }
    const mat = new THREE.MeshStandardMaterial({ roughness: 0.85, metalness: 0 });
    if (entry?.albedo) mat.map = this.texture(entry.albedo, true);
    else if (/ceiling/i.test(name)) mat.color.set(0xeae6da);
    else mat.color.set(0xd8d2c4);
    if (entry?.normal) mat.normalMap = this.texture(entry.normal, false);
    return mat;
  }

  private async loadMesh(name: string, m: Manifest["meshes"][string]): Promise<THREE.Group> {
    const g = await this.gltf.loadAsync(`${BASE}/${m.file}`);
    g.scene.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      const apply = (mat: THREE.Material) => this.material(mat.name, m.materials[mat.name]);
      mesh.material = Array.isArray(mesh.material) ? mesh.material.map(apply) : apply(mesh.material);
    });
    g.scene.name = name;
    return g.scene;
  }

  async load(): Promise<LoadedMap> {
    const manifest: Manifest = await fetch(`${BASE}/manifest.json`).then((r) => r.json());
    const names = Object.keys(manifest.meshes);
    const loaded = new Map<string, THREE.Group>();
    await Promise.all(names.map(async (n) => loaded.set(n, await this.loadMesh(n, manifest.meshes[n]))));

    const root = new THREE.Group();
    const shell = loaded.get("classroom01_8x10x3.5m")!;

    // normalize scale: fit the shell's longer floor dimension to ~10m (room is 8x10)
    const box = new THREE.Box3().setFromObject(shell);
    const size = new THREE.Vector3();
    box.getSize(size);
    const scale = 10 / Math.max(0.001, size.x, size.z);
    console.log(`[map] shell raw size x=${size.x.toFixed(2)} y=${size.y.toFixed(2)} z=${size.z.toFixed(2)} scale=${scale.toFixed(4)}`);

    const place = (proto: THREE.Group, x: number, z: number, ry = 0, s = 1) => {
      const inst = proto.clone(true);
      inst.scale.multiplyScalar(scale * s);
      // recompute footprint so we can sit it on the floor
      const b = new THREE.Box3().setFromObject(inst);
      inst.position.set(x, -b.min.y, z);
      inst.rotateY(ry);
      root.add(inst);
      return inst;
    };

    // shell: scale, orient long axis to Z, recentre on origin, floor at y=0
    shell.scale.multiplyScalar(scale);
    if (size.x > size.z) shell.rotateY(Math.PI / 2); // make the 10m side run along Z
    const sb = new THREE.Box3().setFromObject(shell);
    const sc = new THREE.Vector3();
    sb.getCenter(sc);
    shell.position.set(-sc.x, -sb.min.y, -sc.z);
    root.add(shell);

    const ssize = new THREE.Vector3();
    sb.getSize(ssize);
    console.log(`[map] room halfX=${(ssize.x / 2).toFixed(2)} halfZ=${(ssize.z / 2).toFixed(2)}`);

    // place every prop from the shared layout (single source of truth, also used for collision)
    for (const p of PROPS) {
      const proto = loaded.get(p.mesh);
      if (!proto) continue;
      place(proto, p.x, p.z, p.ry, p.s ?? 1);
    }

    return {
      group: root,
      bounds: { x: ROOM.halfX, z: ROOM.halfZ },
      spawns: SPAWNS,
    };
  }
}
