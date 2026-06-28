import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { ROOM, SPAWNS } from "@shared/classroom";

const BASE = "maps/classroom";

interface MatEntry {
  albedo: string | null;
  normal: string | null;
}
interface Manifest {
  meshes: Record<string, { file: string; materials: Record<string, MatEntry> }>;
}

interface LayoutFile {
  props: { mesh: string; p: [number, number, number]; ry: number; s: [number, number, number] }[];
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
    const layout: LayoutFile = await fetch(`${BASE}/layout.json`).then((r) => r.json());
    const names = Object.keys(manifest.meshes);
    const loaded = new Map<string, THREE.Group>();
    await Promise.all(names.map(async (n) => loaded.set(n, await this.loadMesh(n, manifest.meshes[n]))));

    // mesh unit scale: make the shell's longer floor dimension ~10m
    const shell = loaded.get("classroom01_8x10x3.5m")!;
    const ssize = new THREE.Vector3();
    new THREE.Box3().setFromObject(shell).getSize(ssize);
    const meshScale = 10 / Math.max(0.001, ssize.x, ssize.z);

    // --- Unity(LH, long axis X) -> engine(RH, long axis Z). Calibration constants: ---
    const SX = 1; // sign for engine-X (from Unity Z)
    const SZ = 1; // sign for engine-Z (from Unity X)
    const RY_SIGN = 1;
    const RY_OFF = 0;
    const ex = (uz: number) => uz * SX;
    const ez = (ux: number) => ux * SZ;

    const root = new THREE.Group();
    let shellInst: THREE.Object3D | null = null;
    for (const pr of layout.props) {
      if (pr.mesh === "classroom01_shadow") continue;
      const proto = loaded.get(pr.mesh);
      if (!proto) continue;
      const inst = proto.clone(true);
      inst.scale.multiplyScalar(meshScale * (pr.s?.[0] ?? 1));
      inst.position.set(ex(pr.p[2]), pr.p[1], ez(pr.p[0]));
      inst.rotation.y = RY_SIGN * pr.ry + RY_OFF;
      root.add(inst);
      if (pr.mesh.startsWith("classroom01_8x10")) shellInst = inst;
    }

    // recentre on origin + drop the floor to y=0, using the shell as reference
    if (shellInst) {
      const b = new THREE.Box3().setFromObject(shellInst);
      const c = new THREE.Vector3();
      b.getCenter(c);
      root.position.set(-c.x, -b.min.y, -c.z);
      console.log(`[map] shell center x=${c.x.toFixed(3)} z=${c.z.toFixed(3)} floorY=${b.min.y.toFixed(3)}`);
    }
    console.log(`[map] exact layout: ${layout.props.length} props, meshScale=${meshScale.toFixed(3)}`);

    return { group: root, bounds: { x: ROOM.halfX, z: ROOM.halfZ }, spawns: SPAWNS };
  }
}
