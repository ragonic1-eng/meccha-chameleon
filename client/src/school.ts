import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import {
  ROOMS, WALLS, DOORS, FURNITURE, ROOM, WALL_T, WALL_H, DOOR_H,
  type RoomDef, type PropDef,
} from "@shared/classroom";

const BASE = "maps/classroom";

interface MatEntry { albedo: string | null; normal: string | null; }
interface Manifest { meshes: Record<string, { file: string; materials: Record<string, MatEntry> }>; }

// deterministic RNG so every client builds the identical (non-networked) decoration
function mulberry32(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Builds the multi-room school: structural shell (floor/ceiling/walls rendered from the
 * SAME WALLS array used for collision, so visuals and physics can't disagree), then the
 * authored blocking FURNITURE, then per-room "school" decoration — chalkboards, dirty
 * whiteboards, kids' crayon drawings, messy desks with scattered books, lockers, windows.
 */
export class SchoolBuilder {
  private gltf = new GLTFLoader();
  private texLoader = new THREE.TextureLoader();
  private texCache = new Map<string, THREE.Texture>();
  private protos = new Map<string, THREE.Group>();
  private meshScale = 1;
  private rng = mulberry32(0x5eed);

  private texture(file: string, srgb: boolean): THREE.Texture {
    let t = this.texCache.get(file);
    if (!t) {
      t = this.texLoader.load(`${BASE}/textures/${file}`);
      t.wrapS = t.wrapT = THREE.RepeatWrapping;
      t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
      t.anisotropy = 4;
      this.texCache.set(file, t);
    }
    return t;
  }

  private material(name: string, entry?: MatEntry): THREE.Material {
    if (/glass/i.test(name))
      return new THREE.MeshStandardMaterial({ color: 0xaecfe0, transparent: true, opacity: 0.25, roughness: 0.1 });
    const mat = new THREE.MeshStandardMaterial({ roughness: 0.85, metalness: 0 });
    if (entry?.albedo) mat.map = this.texture(entry.albedo, true);
    else if (/ceiling/i.test(name)) mat.color.set(0xeae6da);
    else mat.color.set(0xd8d2c4);
    if (entry?.normal) mat.normalMap = this.texture(entry.normal, false);
    return mat;
  }

  private async loadProto(name: string, m: Manifest["meshes"][string]): Promise<THREE.Group> {
    const g = await this.gltf.loadAsync(`${BASE}/${m.file}`);
    g.scene.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      mesh.castShadow = false;
      mesh.receiveShadow = true;
      const apply = (mat: THREE.Material) => this.material(mat.name, m.materials[mat.name]);
      mesh.material = Array.isArray(mesh.material) ? mesh.material.map(apply) : apply(mesh.material);
    });
    return g.scene;
  }

  /** Clone a loaded prototype, scaled to world units. */
  private clone(name: string): THREE.Object3D | null {
    const p = this.protos.get(name);
    if (!p) return null;
    const o = p.clone(true);
    o.scale.multiplyScalar(this.meshScale);
    return o;
  }

  /** Position a prop at (x,z) facing ry, then drop it so its base rests on `topY`. */
  private seat(o: THREE.Object3D, x: number, z: number, ry: number, topY = 0) {
    o.rotation.y = ry;
    o.position.set(x, 0, z);
    o.updateMatrixWorld(true);
    const b = new THREE.Box3().setFromObject(o);
    o.position.y = topY - b.min.y;
    return o;
  }

  async load(): Promise<THREE.Group> {
    const manifest: Manifest = await fetch(`${BASE}/manifest.json`).then((r) => r.json());
    const want = new Set<string>([
      "classroom01_8x10x3.5m", // (shell — measured for scale, not placed)
      ...FURNITURE.map((p) => p.mesh).filter(Boolean),
      "chair01", "book01_a1", "book01_b1", "book01_b2", "book02", "book03", "bag01_2", "bag01_3",
      "drink01", "broom01_1", "broom01_2", "dustpan01", "trashbox01",
      // decoration GLBs (props that dress the rooms beyond the blocking furniture)
      "projector01", "lamp01_1", "lamp02", "attendancebook01_1",
    ]);
    const names = [...want].filter((n) => manifest.meshes[n]);
    await Promise.all(names.map(async (n) => this.protos.set(n, await this.loadProto(n, manifest.meshes[n]))));

    // mesh unit scale: same convention as the original loader (shell long dim ≈ 10m)
    const shell = this.protos.get("classroom01_8x10x3.5m");
    if (shell) {
      const s = new THREE.Vector3();
      new THREE.Box3().setFromObject(shell).getSize(s);
      this.meshScale = 10 / Math.max(0.001, s.x, s.z);
    }

    const root = new THREE.Group();
    root.name = "school";
    this.buildShell(root);
    this.buildFurniture(root);
    for (const rm of ROOMS) this.decorateRoom(root, rm);
    this.decorateCorridor(root);
    this.renderDeco(root);
    console.log(`[school] built ${ROOMS.length} rooms, ${WALLS.length} walls, ${FURNITURE.length} props`);
    return root;
  }

  // ---- structural shell ----------------------------------------------------
  private buildShell(root: THREE.Group) {
    const W = ROOM.maxX - ROOM.minX, D = ROOM.maxZ - ROOM.minZ;

    const floorTex = this.texture("classroom_floor01_1.jpg", true);
    floorTex.repeat.set(W / 2, D / 2);
    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(W, D),
      new THREE.MeshStandardMaterial({ map: floorTex, roughness: 0.92 })
    );
    floor.rotation.x = -Math.PI / 2;
    floor.position.set((ROOM.minX + ROOM.maxX) / 2, 0, (ROOM.minZ + ROOM.maxZ) / 2);
    floor.receiveShadow = true;
    root.add(floor);

    const ceil = new THREE.Mesh(
      new THREE.PlaneGeometry(W, D),
      new THREE.MeshStandardMaterial({ color: 0xeae4d6, roughness: 1 })
    );
    ceil.rotation.x = Math.PI / 2;
    ceil.position.set(floor.position.x, WALL_H, floor.position.z);
    root.add(ceil);

    const wallMat = new THREE.MeshStandardMaterial({ map: this.texture("classroom_wall01_1.jpg", true), roughness: 1 });
    wallMat.color.set(0xf2ede1);
    for (const s of WALLS) {
      const len = Math.hypot(s.x2 - s.x1, s.z2 - s.z1);
      const horiz = Math.abs(s.x2 - s.x1) >= Math.abs(s.z2 - s.z1);
      const geo = new THREE.BoxGeometry(horiz ? len : WALL_T, WALL_H, horiz ? WALL_T : len);
      const wall = new THREE.Mesh(geo, wallMat);
      wall.position.set((s.x1 + s.x2) / 2, WALL_H / 2, (s.z1 + s.z2) / 2);
      wall.receiveShadow = true;
      root.add(wall);
    }
    // lintels over each doorway so it reads as a door, not a hole
    const lintelMat = new THREE.MeshStandardMaterial({ color: 0xe7e0d2, roughness: 1 });
    for (const d of DOORS) {
      const h = WALL_H - DOOR_H;
      const geo = new THREE.BoxGeometry(d.horizontal ? d.w + 0.1 : WALL_T, h, d.horizontal ? WALL_T : d.w + 0.1);
      const lintel = new THREE.Mesh(geo, lintelMat);
      lintel.position.set(d.x, DOOR_H + h / 2, d.z);
      root.add(lintel);
      // simple jamb posts so the opening reads as a doorway (no heavy glass door leaf)
      const jambMat = new THREE.MeshStandardMaterial({ color: 0xbfa988, roughness: 0.85 });
      for (const sgn of [-1, 1]) {
        const post = new THREE.Mesh(
          new THREE.BoxGeometry(d.horizontal ? 0.08 : WALL_T + 0.02, DOOR_H, d.horizontal ? WALL_T + 0.02 : 0.08),
          jambMat
        );
        post.position.set(d.x + (d.horizontal ? sgn * (d.w / 2) : 0), DOOR_H / 2, d.z + (d.horizontal ? 0 : sgn * (d.w / 2)));
        root.add(post);
      }
    }
  }

  // ---- furniture -----------------------------------------------------------
  private buildFurniture(root: THREE.Group) {
    for (const p of FURNITURE) {
      if (!p.mesh) continue; // collider-only
      const o = this.clone(p.mesh);
      if (!o) continue;
      if (p.kind === "chair-down") {
        // knocked over: lie it on its side on the floor
        this.seat(o, p.x, p.z, p.ry);
        o.rotation.x = Math.PI / 2;
        this.seat(o, p.x, p.z, p.ry); // re-seat after tipping
        o.rotation.x = Math.PI / 2;
        o.updateMatrixWorld(true);
        const b = new THREE.Box3().setFromObject(o);
        o.position.y += -b.min.y;
      } else {
        this.seat(o, p.x, p.z, p.ry, p.theme === "messy" && p.kind === "desk" ? 0 : 0);
        if (p.kind === "desk" && p.theme === "messy") o.rotation.z = (this.rng() - 0.5) * 0.12;
      }
      root.add(o);
    }
    // clutter on desks / tables
    const topY = this.surfaceTopY();
    for (const p of FURNITURE) {
      if (!["desk", "teacherdesk", "readdesk", "arttable"].includes(p.kind || "")) continue;
      const density = p.theme === "messy" || p.theme === "art" ? 0.85 : 0.4;
      if (this.rng() > density) continue;
      const item = this.pick(["book01_a1", "book01_b1", "book02", "book03", "bag01_2", "drink01"]);
      const o = this.clone(item);
      if (!o) continue;
      const jx = (this.rng() - 0.5) * 0.3, jz = (this.rng() - 0.5) * 0.25;
      this.seat(o, p.x + jx, p.z + jz, this.rng() * Math.PI * 2, topY);
      root.add(o);
    }
  }

  /** Approx. top height of a desk, used to rest clutter on tabletops. */
  private surfaceTopY(): number {
    const d = this.clone("desk01");
    if (!d) return 0.72;
    this.seat(d, 0, 0, 0);
    return new THREE.Box3().setFromObject(d).max.y;
  }

  // ---- per-room decoration -------------------------------------------------
  private decorateRoom(root: THREE.Group, rm: RoomDef) {
    const inDir = rm.side === "north" ? 1 : -1;          // interior direction (+z for north rooms)
    const faceYaw = rm.side === "north" ? 0 : Math.PI;   // yaw to face a board into the room
    const boardFace = rm.boardZ + inDir * (WALL_T / 2 + 0.03);
    const boardIsExterior = Math.abs(rm.boardZ) > ROOM.halfZ - 0.5;

    // --- front wall: board (chalk / white / sports) + a rolled projector screen ---
    const board = rm.theme === "classroom" ? this.chalkboard(rm.id)
      : rm.theme === "gym" ? this.sportsBoard(rm.id)
      : this.whiteboard(rm.id, rm.theme === "messy" || rm.theme === "lab");
    const bw = Math.min(rm.w * 0.6, 3.4);
    this.mountQuad(root, board, rm.cx, 1.55, boardFace, faceYaw, bw, 1.2, 0);
    if (rm.theme === "classroom" || rm.theme === "messy" || rm.theme === "lab")
      this.screen(root, rm.cx, boardFace + inDir * 0.03, faceYaw);
    this.clock(root, rm.cx + bw / 2 + 0.55, 2.3, boardFace, faceYaw);

    // --- windows (+ curtains) on the room's exterior wall ---
    const curtainCol = [0x8a3b3b, 0x3b5e8a, 0x3b7a4a, 0x8a7a3b][this.hash(rm.id) % 4];
    if (boardIsExterior) {
      for (const sx of [-1, 1]) {
        const wx = rm.cx + sx * (rm.w / 2 - 1.0);
        this.window(root, wx, boardFace, faceYaw);
        this.curtains(root, wx, boardFace, faceYaw, curtainCol);
        this.sillPlant(root, wx, 1.02, boardFace + inDir * 0.16); // a little greenery on the sill
      }
    } else {                                              // middle rooms: windows on the outer side wall
      const sideX = Math.sign(rm.cx) * (ROOM.halfX - WALL_T / 2 - 0.03);
      const yaw = rm.cx < 0 ? Math.PI / 2 : -Math.PI / 2;
      for (const dz of [-1.5, 1.5]) {
        this.window(root, sideX, rm.cz + dz, yaw);
        this.curtains(root, sideX, rm.cz + dz, yaw, curtainCol);
        this.sillPlant(root, sideX + (rm.cx < 0 ? 0.16 : -0.16), 1.02, rm.cz + dz);
      }
    }

    // --- side walls: subject posters, a framed class photo, kids' crayon drawings ---
    const posters = rm.theme === "gym" || rm.theme === "music" ? 2 : 3;
    for (let i = 0; i < posters; i++) this.wallArt(root, rm, this.posterTex(rm.theme, i), 0.62, 0.84, true, 0.05);
    this.wallArt(root, rm, this.photoTex(), 0.66, 0.48, true, 0.04);
    const drawings = rm.theme === "art" ? 6 : rm.theme === "messy" ? 5 : 3;
    for (let i = 0; i < drawings; i++) this.kidDrawing(root, rm);

    // --- fun, theme-specific ceiling lights (+ a projector over the teaching rooms) ---
    const lightStyle = ({ classroom: "tubes", messy: "tubes", art: "ring", library: "globe", lab: "panel", music: "lantern", gym: "globe" } as Record<string, string>)[rm.theme] || "panel";
    const lgScale = rm.theme === "gym" ? 1.4 : 1;
    for (const dz of [-2.0, 0.2, 2.0]) this.funLight(root, rm.cx, rm.cz + dz, lightStyle, lgScale);
    if (rm.theme === "classroom" || rm.theme === "messy" || rm.theme === "lab")
      this.projector(root, rm.cx, rm.cz + inDir * 1.3, faceYaw);

    // --- teacher-desk extras: a lamp + the attendance book ---
    if (rm.theme === "classroom" || rm.theme === "messy") {
      const tx = rm.cx + 1.4, tz = rm.boardZ + inDir * 1.0, top = this.teacherTopY();
      const lamp = this.clone("lamp01_1"); if (lamp) { this.seat(lamp, tx + 0.5, tz, this.rng() * 6.28, top); root.add(lamp); }
      const att = this.clone("attendancebook01_1"); if (att) { this.seat(att, tx - 0.4, tz, 0.3, top); root.add(att); }
    }

    // --- floor clutter: a little in every room, more in messy / art / music ---
    const litter = rm.theme === "messy" || rm.theme === "art" ? 5 : rm.theme === "music" || rm.theme === "gym" ? 3 : 2;
    for (let i = 0; i < litter; i++) {
      const item = this.pick(["book01_a1", "book01_b1", "book01_b2", "book02", "book03", "bag01_3", "drink01"]);
      const o = this.clone(item); if (!o) continue;
      const x = rm.cx + (this.rng() - 0.5) * (rm.w - 1.4);
      const z = rm.cz + (this.rng() - 0.5) * (rm.d - 2.4);
      this.seat(o, x, z, this.rng() * Math.PI * 2); root.add(o);
    }
    if (rm.theme === "messy" || rm.theme === "art") {
      const broom = this.clone(this.pick(["broom01_1", "broom01_2"]));
      if (broom) { this.seat(broom, rm.cx + rm.w / 2 - 0.4, rm.cz - rm.d / 2 + 0.6, 0.5); broom.rotation.z = 0.5; root.add(broom); }
    }
  }

  private decorateCorridor(root: THREE.Group) {
    const ends = [ROOM.minX + WALL_T / 2 + 0.03, ROOM.maxX - WALL_T / 2 - 0.03];
    // kids' art + notices along both hallway end walls (corridor A near z=-5, corridor B near z=5)
    const spots: [number, number][] = [[-5.7, 0], [-5.0, 1], [-4.3, 0], [5.7, 1], [5.0, 0], [4.3, 1]];
    for (const [z, e] of spots) {
      const tex = this.rng() > 0.5 ? this.kidDrawingTex() : this.noticeTex();
      this.mountQuad(root, tex, ends[e], 1.5 + (this.rng() - 0.5) * 0.3, z, e ? -Math.PI / 2 : Math.PI / 2, 0.72, 0.56, (this.rng() - 0.5) * 0.1);
    }
    // bulletin boards on the central spine walls, facing the junction
    for (const sgn of [-1, 1]) {
      const x = sgn * (1.5 - WALL_T / 2 - 0.03);
      this.mountQuad(root, this.noticeTex(), x, 1.55, 0, sgn < 0 ? Math.PI / 2 : -Math.PI / 2, 0.8, 0.62, 0);
      this.mountQuad(root, this.kidDrawingTex(), x, 1.5, sgn * 2.2, sgn < 0 ? Math.PI / 2 : -Math.PI / 2, 0.5, 0.4, (this.rng() - 0.5) * 0.12);
    }
    // ceiling lights down both corridors and the spine
    for (const z of [-5, 5]) for (const x of [-7, -3, 3, 7]) this.funLight(root, x, z, "tubes");
    for (const z of [-2.2, 0, 2.2]) this.funLight(root, 0, z, "panel");
    // a little floor clutter
    const dust = this.clone("dustpan01");
    if (dust) { this.seat(dust, ROOM.minX + 0.6, -5.0, 0.3); root.add(dust); }
    const bk = this.clone("book03");
    if (bk) { this.seat(bk, 0.7, 5.6, 1.0); root.add(bk); }
  }

  // ---- decoration primitives ----------------------------------------------
  /** Mount a textured quad flat on a wall. faceYaw rotates the +z-facing plane to the wall. */
  private mountQuad(root: THREE.Group, tex: THREE.Texture, x: number, y: number, z: number, faceYaw: number, w: number, h: number, tilt = 0, frame = true) {
    const g = new THREE.Group();
    g.position.set(x, y, z);
    g.rotation.y = faceYaw;
    if (frame) {
      const fr = new THREE.Mesh(new THREE.PlaneGeometry(w + 0.08, h + 0.08), new THREE.MeshStandardMaterial({ color: 0x6b4a2f, roughness: 0.9 }));
      fr.position.z = -0.012;
      fr.rotation.z = tilt;
      g.add(fr);
    }
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshStandardMaterial({ map: tex, roughness: 0.95 }));
    m.rotation.z = tilt;
    g.add(m);
    root.add(g);
  }

  private window(root: THREE.Group, x: number, z: number, faceYaw: number) {
    const g = new THREE.Group();
    g.position.set(x, 1.65, z);
    g.rotation.y = faceYaw;
    const pane = new THREE.Mesh(
      new THREE.PlaneGeometry(1.0, 1.3),
      new THREE.MeshBasicMaterial({ color: 0xcfe6f5 })
    );
    g.add(pane);
    const barMat = new THREE.MeshStandardMaterial({ color: 0xb8b0a0, roughness: 0.8 });
    const v = new THREE.Mesh(new THREE.PlaneGeometry(0.05, 1.3), barMat); g.add(v);
    const h = new THREE.Mesh(new THREE.PlaneGeometry(1.0, 0.05), barMat); g.add(h);
    const frame = new THREE.Mesh(new THREE.PlaneGeometry(1.12, 1.42), new THREE.MeshStandardMaterial({ color: 0x9a8f7a, roughness: 0.9 }));
    frame.position.z = -0.01; g.add(frame);
    root.add(g);
  }

  private clock(root: THREE.Group, x: number, y: number, z: number, faceYaw: number) {
    const g = new THREE.Group();
    g.position.set(x, y, z);
    g.rotation.y = faceYaw;
    g.add(new THREE.Mesh(new THREE.CircleGeometry(0.18, 24), new THREE.MeshStandardMaterial({ color: 0xfdfdf8, roughness: 0.6 })));
    const hands = new THREE.Mesh(new THREE.PlaneGeometry(0.02, 0.13), new THREE.MeshBasicMaterial({ color: 0x222222 }));
    hands.position.y = 0.04; hands.position.z = 0.002; g.add(hands);
    const hands2 = new THREE.Mesh(new THREE.PlaneGeometry(0.1, 0.02), new THREE.MeshBasicMaterial({ color: 0x222222 }));
    hands2.position.x = 0.03; hands2.position.z = 0.002; g.add(hands2);
    root.add(g);
  }

  /** Fun, varied ceiling light fixtures (glowing, no real light to stay mobile-cheap). */
  private funLight(root: THREE.Group, x: number, z: number, style: string, scale = 1) {
    const cool = 0xfff7e6, warm = 0xfff2cf;
    const g = new THREE.Group();
    g.position.set(x, WALL_H, z);
    if (style === "globe") {
      const rod = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.3, 6), new THREE.MeshStandardMaterial({ color: 0x444444 }));
      rod.position.y = -0.15; g.add(rod);
      const ball = new THREE.Mesh(new THREE.SphereGeometry(0.16 * scale, 16, 14), new THREE.MeshBasicMaterial({ color: warm }));
      ball.position.y = -0.34; g.add(ball);
    } else if (style === "ring") {
      const ring = new THREE.Mesh(new THREE.TorusGeometry(0.3 * scale, 0.045, 10, 28), new THREE.MeshBasicMaterial({ color: cool }));
      ring.rotation.x = Math.PI / 2; ring.position.y = -0.06; g.add(ring);
    } else if (style === "lantern") {
      const lan = new THREE.Mesh(new THREE.SphereGeometry(0.2 * scale, 14, 12), new THREE.MeshBasicMaterial({ color: 0xffd27a }));
      lan.scale.y = 1.3; lan.position.y = -0.3; g.add(lan);
    } else if (style === "tubes") {
      for (const dx of [-0.16, 0.16]) {
        const tube = new THREE.Mesh(new THREE.BoxGeometry(0.95 * scale, 0.06, 0.08), new THREE.MeshBasicMaterial({ color: cool }));
        tube.position.set(dx, -0.04, 0); g.add(tube);
      }
    } else { // flat panel
      const m = new THREE.Mesh(new THREE.PlaneGeometry(0.9 * scale, 0.34 * scale), new THREE.MeshBasicMaterial({ color: cool }));
      m.rotation.x = Math.PI / 2; m.position.y = -0.02; g.add(m);
    }
    root.add(g);
  }

  // ---- decorative floor models (rendered for the collidable `deco` FURNITURE) ----------
  private renderDeco(root: THREE.Group) {
    for (const p of FURNITURE) {
      switch (p.kind) {
        case "cabinet": this.cabinet(root, p, false); break;
        case "trophy": this.cabinet(root, p, true); break;
        case "plant": this.floorPlant(root, p.x, p.z); break;
        case "statue": this.sculpture(root, p.x, p.z); break;
        case "globe": this.globeModel(root, p.x, p.z); break;
        case "molecule": this.molecule(root, p.x, p.z); break;
      }
    }
  }

  private wood(tint = 0x8a5a2b): THREE.MeshStandardMaterial {
    return new THREE.MeshStandardMaterial({ color: tint, roughness: 0.78, metalness: 0.02 });
  }

  /** A wooden cabinet (two doors + handles); `trophy` adds a glass top with a gold cup. */
  private cabinet(root: THREE.Group, p: PropDef, trophy: boolean) {
    const g = new THREE.Group();
    g.position.set(p.x, 0, p.z); g.rotation.y = p.ry;
    const W = 0.84, H = trophy ? 1.35 : 1.18, Dp = 0.46;
    const tint = [0x8a5a2b, 0x6f4423, 0x9c6b3a][this.hash(`${p.x},${p.z}`) % 3];
    const body = new THREE.Mesh(new THREE.BoxGeometry(W, H, Dp), this.wood(tint));
    body.position.y = H / 2; body.castShadow = true; g.add(body);
    const doorMat = new THREE.MeshStandardMaterial({ color: tint, roughness: 0.7 });
    const handleMat = new THREE.MeshStandardMaterial({ color: 0x3a3a3a, metalness: 0.6, roughness: 0.4 });
    for (const sx of [-1, 1]) {
      const panel = new THREE.Mesh(new THREE.BoxGeometry(W / 2 - 0.06, H - 0.14, 0.03), doorMat);
      panel.position.set(sx * (W / 4), H / 2, Dp / 2 + 0.005); g.add(panel);
      const handle = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.12, 0.03), handleMat);
      handle.position.set(sx * 0.07, H / 2, Dp / 2 + 0.03); g.add(handle);
    }
    const top = new THREE.Mesh(new THREE.BoxGeometry(W + 0.06, 0.06, Dp + 0.06), this.wood(tint));
    top.position.y = H + 0.03; g.add(top);
    if (trophy) {
      const glass = new THREE.Mesh(new THREE.BoxGeometry(W - 0.1, 0.5, Dp - 0.1), new THREE.MeshStandardMaterial({ color: 0xaecfe0, transparent: true, opacity: 0.22, roughness: 0.1 }));
      glass.position.y = H + 0.31; g.add(glass);
      const gold = new THREE.MeshStandardMaterial({ color: 0xe8c14a, metalness: 0.7, roughness: 0.3 });
      const cup = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.05, 0.16, 16), gold); cup.position.y = H + 0.34; g.add(cup);
      const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 0.08, 8), gold); stem.position.y = H + 0.22; g.add(stem);
      const base = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 0.03, 12), gold); base.position.y = H + 0.17; g.add(base);
    }
    root.add(g);
  }

  private foliage(parent: THREE.Object3D, y: number, scale: number) {
    const greens = [0x3f7d3a, 0x4f9a44, 0x356b32];
    for (let i = 0; i < 5; i++) {
      const r = (0.13 + this.rng() * 0.09) * scale;
      const leaf = new THREE.Mesh(new THREE.SphereGeometry(r, 8, 7), new THREE.MeshStandardMaterial({ color: greens[i % 3], roughness: 0.85 }));
      leaf.position.set((this.rng() - 0.5) * 0.2 * scale, y + this.rng() * 0.18 * scale, (this.rng() - 0.5) * 0.2 * scale);
      leaf.castShadow = true; parent.add(leaf);
    }
  }

  /** A floor-standing potted plant. */
  private floorPlant(root: THREE.Group, x: number, z: number, scale = 1) {
    const g = new THREE.Group(); g.position.set(x, 0, z);
    const pot = new THREE.Mesh(new THREE.CylinderGeometry(0.16 * scale, 0.12 * scale, 0.26 * scale, 14), new THREE.MeshStandardMaterial({ color: 0xb5651d, roughness: 0.9 }));
    pot.position.y = 0.13 * scale; g.add(pot);
    const soil = new THREE.Mesh(new THREE.CylinderGeometry(0.15 * scale, 0.15 * scale, 0.02, 14), new THREE.MeshStandardMaterial({ color: 0x3b2a1a }));
    soil.position.y = 0.26 * scale; g.add(soil);
    this.foliage(g, 0.3 * scale, scale);
    root.add(g);
  }

  /** A small plant resting on a surface (windowsill / desk). */
  private sillPlant(root: THREE.Group, x: number, y: number, z: number) {
    const g = new THREE.Group(); g.position.set(x, y, z);
    const pot = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.055, 0.1, 12), new THREE.MeshStandardMaterial({ color: 0xc56a2c, roughness: 0.9 }));
    pot.position.y = 0.05; g.add(pot);
    this.foliage(g, 0.12, 0.5);
    root.add(g);
  }

  /** Abstract art-room sculpture on a stone pedestal. */
  private sculpture(root: THREE.Group, x: number, z: number) {
    const g = new THREE.Group(); g.position.set(x, 0, z);
    const ped = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.22, 0.7, 16), new THREE.MeshStandardMaterial({ color: 0xcfcabd, roughness: 0.9 }));
    ped.position.y = 0.35; g.add(ped);
    const clay = new THREE.MeshStandardMaterial({ color: 0xb98b6e, roughness: 0.8 });
    const torus = new THREE.Mesh(new THREE.TorusGeometry(0.16, 0.06, 10, 20), clay); torus.position.y = 0.86; torus.rotation.x = 0.7; g.add(torus);
    const ball = new THREE.Mesh(new THREE.SphereGeometry(0.13, 14, 12), clay); ball.position.y = 1.06; g.add(ball);
    const slab = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.22, 0.1), clay); slab.position.y = 1.26; slab.rotation.set(0.3, 0.5, 0.2); g.add(slab);
    root.add(g);
  }

  /** Classroom globe on a wooden stand. */
  private globeModel(root: THREE.Group, x: number, z: number) {
    const g = new THREE.Group(); g.position.set(x, 0, z);
    const base = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.16, 0.06, 16), this.wood(0x6f4423)); base.position.y = 0.5; g.add(base);
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 0.34, 8), this.wood(0x6f4423)); post.position.y = 0.7; g.add(post);
    const ball = new THREE.Mesh(new THREE.SphereGeometry(0.2, 18, 16), new THREE.MeshStandardMaterial({ map: this.globeTex(), roughness: 0.7 }));
    ball.position.y = 0.96; ball.rotation.z = 0.4; g.add(ball);
    const arc = new THREE.Mesh(new THREE.TorusGeometry(0.23, 0.012, 8, 24, Math.PI), new THREE.MeshStandardMaterial({ color: 0xb8a060, metalness: 0.5, roughness: 0.4 }));
    arc.position.y = 0.96; arc.rotation.y = Math.PI / 2; g.add(arc);
    root.add(g);
  }

  private globeTex(): THREE.CanvasTexture {
    return this.makeTex(128, 64, (c) => {
      c.fillStyle = "#2a6fb0"; c.fillRect(0, 0, 128, 64);
      c.fillStyle = "#5aa84f";
      for (let i = 0; i < 7; i++) { c.beginPath(); c.ellipse(this.rng() * 128, this.rng() * 64, 8 + this.rng() * 16, 6 + this.rng() * 10, this.rng() * 3, 0, 6.28); c.fill(); }
    });
  }

  /** Science-lab ball-and-stick molecule model. */
  private molecule(root: THREE.Group, x: number, z: number) {
    const g = new THREE.Group(); g.position.set(x, 0, z);
    const stand = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.05, 0.7, 8), new THREE.MeshStandardMaterial({ color: 0x6b6b6b, metalness: 0.3, roughness: 0.6 }));
    stand.position.y = 0.35; g.add(stand);
    const core = new THREE.Vector3(0, 0.95, 0);
    const center = new THREE.Mesh(new THREE.SphereGeometry(0.12, 16, 14), new THREE.MeshStandardMaterial({ color: 0xd23b3b, roughness: 0.5 }));
    center.position.copy(core); g.add(center);
    const atomCols = [0x3b6cd6, 0xffffff, 0x3b6cd6, 0x4f9a44];
    const dirs = [[0.26, 0.16, 0], [-0.24, 0.18, 0.1], [0.05, 0.3, 0.22], [-0.05, -0.2, -0.24]];
    dirs.forEach((d, i) => {
      const pos = core.clone().add(new THREE.Vector3(d[0], d[1], d[2]));
      const len = core.distanceTo(pos);
      const bond = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.018, len, 6), new THREE.MeshStandardMaterial({ color: 0xcccccc }));
      bond.position.copy(core.clone().lerp(pos, 0.5));
      bond.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), pos.clone().sub(core).normalize());
      g.add(bond);
      const atom = new THREE.Mesh(new THREE.SphereGeometry(0.08, 14, 12), new THREE.MeshStandardMaterial({ color: atomCols[i], roughness: 0.5 }));
      atom.position.copy(pos); g.add(atom);
    });
    root.add(g);
  }

  private kidDrawing(root: THREE.Group, rm: RoomDef) {
    // pick a side wall (left/right of the room) at a random height
    const left = this.rng() > 0.5;
    const x = left ? rm.cx - rm.w / 2 + WALL_T / 2 + 0.03 : rm.cx + rm.w / 2 - WALL_T / 2 - 0.03;
    const z = rm.cz + (this.rng() - 0.5) * (rm.d - 1.6);
    const y = 1.15 + this.rng() * 0.7;
    const s = 0.42 + this.rng() * 0.18;
    this.mountQuad(root, this.kidDrawingTex(), x, y, z, left ? Math.PI / 2 : -Math.PI / 2, s, s * 0.78, (this.rng() - 0.5) * 0.18);
  }

  // ---- procedural canvas textures -----------------------------------------
  private makeTex(w: number, h: number, draw: (c: CanvasRenderingContext2D) => void): THREE.CanvasTexture {
    const cv = document.createElement("canvas");
    cv.width = w; cv.height = h;
    draw(cv.getContext("2d")!);
    const t = new THREE.CanvasTexture(cv);
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 4;
    return t;
  }

  private chalkboard(seed: string): THREE.CanvasTexture {
    const r = mulberry32(this.hash(seed));
    return this.makeTex(512, 256, (c) => {
      c.fillStyle = "#22402c"; c.fillRect(0, 0, 512, 256);
      // chalk dust smears
      for (let i = 0; i < 18; i++) {
        c.strokeStyle = `rgba(220,225,210,${0.04 + r() * 0.06})`;
        c.lineWidth = 6 + r() * 16;
        c.beginPath(); c.moveTo(r() * 512, r() * 256); c.lineTo(r() * 512, r() * 256); c.stroke();
      }
      // faint chalk "writing" — scribbly lines + sums
      c.strokeStyle = "rgba(240,244,235,0.85)"; c.lineWidth = 2;
      for (let line = 0; line < 4; line++) {
        const y = 50 + line * 50; let x = 30;
        c.beginPath(); c.moveTo(x, y);
        while (x < 460) { x += 12 + r() * 22; c.lineTo(x, y + (r() - 0.5) * 16); }
        c.stroke();
      }
      c.fillStyle = "rgba(245,248,240,0.9)"; c.font = "bold 34px sans-serif";
      c.fillText("7 + 5 = 12", 40, 220); c.fillText("ABC", 330, 60);
    });
  }

  private whiteboard(seed: string, dirty: boolean): THREE.CanvasTexture {
    const r = mulberry32(this.hash(seed) ^ 0x99);
    return this.makeTex(512, 256, (c) => {
      c.fillStyle = "#f4f5f0"; c.fillRect(0, 0, 512, 256);
      // ghosted, half-erased marker swipes
      const n = dirty ? 26 : 12;
      for (let i = 0; i < n; i++) {
        const g = 0.05 + r() * 0.12;
        c.strokeStyle = `rgba(120,125,130,${g})`;
        c.lineWidth = 10 + r() * 28;
        c.beginPath(); c.moveTo(r() * 512, r() * 256);
        c.lineTo(r() * 512, r() * 256 + (r() - 0.5) * 40); c.stroke();
      }
      // leftover colored scribbles (partly wiped)
      const cols = ["#3b6cd6", "#cf3b3b", "#2f9e44", "#9b59b6"];
      for (let i = 0; i < 5; i++) {
        c.strokeStyle = cols[Math.floor(r() * cols.length)] + "cc";
        c.lineWidth = 2 + r() * 2;
        let x = 30 + r() * 400, y = 30 + r() * 180;
        c.beginPath(); c.moveTo(x, y);
        for (let k = 0; k < 6; k++) { x += (r() - 0.3) * 40; y += (r() - 0.5) * 30; c.lineTo(x, y); }
        c.stroke();
      }
      if (dirty) { // dried streaks from a bad eraser
        for (let i = 0; i < 6; i++) { c.fillStyle = `rgba(170,175,180,${0.05 + r() * 0.05})`; c.fillRect(r() * 512, r() * 256, 60 + r() * 120, 18 + r() * 30); }
      }
    });
  }

  private kidDrawingTex(): THREE.CanvasTexture {
    const r = this.rng;
    return this.makeTex(256, 200, (c) => {
      c.fillStyle = "#fdfaf0"; c.fillRect(0, 0, 256, 200);
      const crayon = (col: string, lw: number) => { c.strokeStyle = col; c.lineWidth = lw; c.lineCap = "round"; };
      // ground + sky
      c.fillStyle = "#cdeffd"; c.fillRect(0, 0, 256, 130);
      c.fillStyle = "#bfe6a6"; c.fillRect(0, 130, 256, 70);
      // sun with rays
      const sx = 30 + r() * 30, sy = 30 + r() * 20;
      crayon("#f5c20b", 6);
      c.beginPath(); c.arc(sx, sy, 16, 0, Math.PI * 2); c.stroke();
      for (let a = 0; a < 8; a++) { const an = (a / 8) * Math.PI * 2; c.beginPath(); c.moveTo(sx + Math.cos(an) * 20, sy + Math.sin(an) * 20); c.lineTo(sx + Math.cos(an) * 30, sy + Math.sin(an) * 30); c.stroke(); }
      // house
      const hx = 120 + r() * 60, hy = 95;
      crayon("#c0392b", 5); c.strokeRect(hx, hy, 60, 45);
      c.beginPath(); c.moveTo(hx - 4, hy); c.lineTo(hx + 30, hy - 28); c.lineTo(hx + 64, hy); c.stroke();
      crayon("#7a4a1e", 5); c.strokeRect(hx + 22, hy + 18, 16, 27);
      // a wobbly tree
      crayon("#5a3a16", 6); c.beginPath(); c.moveTo(60, 175); c.lineTo(60, 135); c.stroke();
      crayon("#2f9e44", 6); c.beginPath(); c.arc(60, 125, 18, 0, Math.PI * 2); c.stroke();
      // 1-2 stick figures
      const figs = 1 + Math.floor(r() * 2);
      for (let f = 0; f < figs; f++) {
        const fx = 200 + r() * 30, fy = 150;
        crayon(["#3b6cd6", "#cf3b3b", "#9b59b6"][f % 3], 4);
        c.beginPath(); c.arc(fx, fy - 22, 7, 0, Math.PI * 2); c.stroke();
        c.beginPath(); c.moveTo(fx, fy - 15); c.lineTo(fx, fy); c.moveTo(fx, fy); c.lineTo(fx - 8, fy + 12); c.moveTo(fx, fy); c.lineTo(fx + 8, fy + 12);
        c.moveTo(fx - 9, fy - 8); c.lineTo(fx + 9, fy - 8); c.stroke();
      }
    });
  }

  private noticeTex(): THREE.CanvasTexture {
    const r = this.rng;
    return this.makeTex(256, 200, (c) => {
      c.fillStyle = "#fffdf5"; c.fillRect(0, 0, 256, 200);
      c.fillStyle = "#2b5797"; c.fillRect(0, 0, 256, 34);
      c.fillStyle = "#fff"; c.font = "bold 20px sans-serif"; c.fillText("NOTICE", 14, 24);
      c.fillStyle = "#555"; c.font = "13px sans-serif";
      for (let i = 0; i < 6; i++) { const y = 56 + i * 22; c.fillRect(16, y, 60 + r() * 180, 6); }
    });
  }

  /** A gym scoreboard / banner instead of a board. */
  private sportsBoard(seed: string): THREE.CanvasTexture {
    const r = mulberry32(this.hash(seed) ^ 0x5a);
    return this.makeTex(512, 256, (c) => {
      c.fillStyle = "#16324a"; c.fillRect(0, 0, 512, 256);
      c.fillStyle = "#f4d03f"; c.font = "bold 44px sans-serif"; c.fillText("GYMNASIUM", 28, 56);
      c.fillStyle = "#fff"; c.font = "bold 26px sans-serif"; c.fillText("HOME", 50, 150); c.fillText("GUEST", 300, 150);
      c.font = "bold 70px monospace";
      c.fillStyle = "#ff5a5a"; c.fillText(String(Math.floor(r() * 40)).padStart(2, "0"), 60, 224);
      c.fillStyle = "#6cd0ff"; c.fillText(String(Math.floor(r() * 40)).padStart(2, "0"), 320, 224);
    });
  }

  /** A themed educational subject poster (alphabet, colour wheel, planets, music staff, …). */
  private posterTex(theme: RoomDef["theme"], idx: number): THREE.CanvasTexture {
    const styles: Record<string, string[]> = {
      classroom: ["alpha", "num", "shapes"], messy: ["num", "alpha", "shapes"],
      art: ["wheel", "shapes", "alpha"], library: ["map", "alpha", "num"],
      lab: ["planets", "num", "map"], music: ["staff", "alpha"], gym: ["rules", "num"],
    };
    const arr = styles[theme] || ["alpha"]; const style = arr[idx % arr.length];
    const bar: Record<string, string> = { classroom: "#2e7d32", messy: "#2e7d32", art: "#c2185b", library: "#1565c0", lab: "#00838f", music: "#6a1b9a", gym: "#ef6c00" };
    const titles: Record<string, string> = { alpha: "ABC", num: "123", shapes: "SHAPES", wheel: "COLOURS", map: "OUR WORLD", planets: "PLANETS", staff: "DO RE MI", rules: "GYM RULES" };
    const pal = ["#e53935", "#fb8c00", "#fdd835", "#43a047", "#1e88e5", "#8e24aa"];
    const r = mulberry32(this.hash(theme + style + idx) ^ 0xa1);
    return this.makeTex(256, 340, (c) => {
      c.fillStyle = "#fffef7"; c.fillRect(0, 0, 256, 340);
      c.fillStyle = bar[theme] || "#37474f"; c.fillRect(0, 0, 256, 44);
      c.fillStyle = "#fff"; c.font = "bold 26px sans-serif"; c.fillText(titles[style], 14, 32);
      if (style === "alpha" || style === "num") {
        const items = (style === "alpha" ? "ABCDEFGHIJKLMNOP" : "1234567890+-=?#").split("");
        c.font = "bold 30px monospace";
        for (let i = 0; i < items.length; i++) { c.fillStyle = pal[i % pal.length]; c.fillText(items[i], 24 + (i % 4) * 60, 92 + Math.floor(i / 4) * 58); }
      } else if (style === "shapes") {
        const sh = [(x: number, y: number) => c.fillRect(x - 20, y - 20, 40, 40),
          (x: number, y: number) => { c.beginPath(); c.arc(x, y, 22, 0, 6.28); c.fill(); },
          (x: number, y: number) => { c.beginPath(); c.moveTo(x, y - 24); c.lineTo(x + 24, y + 18); c.lineTo(x - 24, y + 18); c.closePath(); c.fill(); }];
        for (let i = 0; i < 6; i++) { c.fillStyle = pal[i % pal.length]; sh[i % 3](50 + (i % 3) * 78, 120 + Math.floor(i / 3) * 110); }
      } else if (style === "wheel") {
        for (let i = 0; i < 12; i++) { c.fillStyle = `hsl(${i * 30},70%,55%)`; c.beginPath(); c.moveTo(128, 200); c.arc(128, 200, 92, (i / 12) * 6.28, ((i + 1) / 12) * 6.28); c.closePath(); c.fill(); }
      } else if (style === "map") {
        c.fillStyle = "#9ec9e8"; c.fillRect(8, 60, 240, 264);
        c.fillStyle = "#6fae5e"; for (let i = 0; i < 5; i++) { c.beginPath(); c.ellipse(50 + r() * 150, 110 + r() * 170, 30 + r() * 30, 22 + r() * 24, r() * 3, 0, 6.28); c.fill(); }
      } else if (style === "planets") {
        c.fillStyle = "#fdd835"; c.beginPath(); c.arc(40, 130, 26, 0, 6.28); c.fill();
        for (let i = 0; i < 6; i++) { c.fillStyle = pal[i % pal.length]; c.beginPath(); c.arc(82 + i * 28, 130 + (i % 2 ? 34 : -8), 7 + (i % 3) * 4, 0, 6.28); c.fill(); }
      } else if (style === "staff") {
        c.strokeStyle = "#333"; c.lineWidth = 2;
        for (let l = 0; l < 5; l++) { const y = 120 + l * 22; c.beginPath(); c.moveTo(16, y); c.lineTo(240, y); c.stroke(); }
        c.fillStyle = "#222"; for (let i = 0; i < 7; i++) { const x = 44 + i * 28, y = 120 + (i % 5) * 22; c.beginPath(); c.ellipse(x, y, 8, 6, 0.4, 0, 6.28); c.fill(); c.fillRect(x + 6, y - 26, 2, 26); }
      } else { // rules
        c.fillStyle = "#444"; c.font = "16px sans-serif";
        ["1. Warm up first", "2. Wear sneakers", "3. No pushing", "4. Have fun!"].forEach((t, i) => c.fillText(t, 16, 92 + i * 42));
      }
    });
  }

  /** A framed "class photo": rows of little heads against a backdrop. */
  private photoTex(): THREE.CanvasTexture {
    const r = this.rng;
    const skin = ["#f0c8a0", "#e8b890", "#d8a070", "#c08858"];
    const cloth = ["#3b6cd6", "#cf3b3b", "#2f9e44", "#9b59b6", "#f5a623"];
    return this.makeTex(256, 184, (c) => {
      c.fillStyle = "#dfe6ea"; c.fillRect(0, 0, 256, 184);
      c.fillStyle = "#b9cdb0"; c.fillRect(0, 96, 256, 88);
      for (let row = 0; row < 2; row++) for (let i = 0; i < 7; i++) {
        const x = 24 + i * 30, y = 68 + row * 44;
        c.fillStyle = skin[Math.floor(r() * skin.length)]; c.beginPath(); c.arc(x, y, 9, 0, 6.28); c.fill();
        c.fillStyle = cloth[Math.floor(r() * cloth.length)]; c.fillRect(x - 9, y + 9, 18, 16);
      }
      c.fillStyle = "#333"; c.font = "12px sans-serif"; c.fillText("Class Photo", 90, 174);
    });
  }

  /** A retracted pull-down projector screen above the board. */
  private screen(root: THREE.Group, x: number, z: number, faceYaw: number) {
    const g = new THREE.Group(); g.position.set(x, 0, z); g.rotation.y = faceYaw;
    const house = new THREE.Mesh(new THREE.BoxGeometry(1.34, 0.1, 0.1), new THREE.MeshStandardMaterial({ color: 0x4a4d52, roughness: 0.7 }));
    house.position.y = 2.55; g.add(house);
    const flap = new THREE.Mesh(new THREE.PlaneGeometry(1.24, 0.55), new THREE.MeshStandardMaterial({ color: 0xf3f1e8, roughness: 0.95 }));
    flap.position.set(0, 2.25, 0.02); g.add(flap);
    root.add(g);
  }

  /** Cloth curtains (two side panels + a valance) framing a window. */
  private curtains(root: THREE.Group, x: number, z: number, faceYaw: number, color: number) {
    const g = new THREE.Group(); g.position.set(x, 1.65, z); g.rotation.y = faceYaw;
    const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.92, side: THREE.DoubleSide });
    for (const sgn of [-1, 1]) { const p = new THREE.Mesh(new THREE.PlaneGeometry(0.26, 1.5), mat); p.position.set(sgn * 0.62, 0, 0.05); g.add(p); }
    const val = new THREE.Mesh(new THREE.PlaneGeometry(1.42, 0.22), mat); val.position.set(0, 0.78, 0.05); g.add(val);
    root.add(g);
  }

  /** Hang a projector from the ceiling, pointing at the board. */
  private projector(root: THREE.Group, x: number, z: number, faceYaw: number) {
    const o = this.clone("projector01");
    if (!o) return;
    o.rotation.y = faceYaw;
    o.position.set(x, 0, z);
    o.updateMatrixWorld(true);
    const b = new THREE.Box3().setFromObject(o);
    o.position.y = WALL_H - 0.05 - (b.max.y - b.min.y);
    root.add(o);
  }

  /** Mount a framed picture on a random side wall of the room. */
  private wallArt(root: THREE.Group, rm: RoomDef, tex: THREE.Texture, w: number, h: number, frame: boolean, tiltAmt: number) {
    const left = this.rng() > 0.5;
    const x = left ? rm.cx - rm.w / 2 + WALL_T / 2 + 0.03 : rm.cx + rm.w / 2 - WALL_T / 2 - 0.03;
    const z = rm.cz + (this.rng() - 0.5) * (rm.d - 1.4);
    const y = 1.35 + this.rng() * 0.7;
    this.mountQuad(root, tex, x, y, z, left ? Math.PI / 2 : -Math.PI / 2, w, h, (this.rng() - 0.5) * tiltAmt, frame);
  }

  private teacherTop = -1;
  /** Cached top height of the teacher's desk, for resting a lamp / book on it. */
  private teacherTopY(): number {
    if (this.teacherTop < 0) {
      const d = this.clone("desk02");
      if (d) { this.seat(d, 0, 0, 0); this.teacherTop = new THREE.Box3().setFromObject(d).max.y; }
      else this.teacherTop = 0.78;
    }
    return this.teacherTop;
  }

  // ---- small utils ---------------------------------------------------------
  private pick<T>(arr: T[]): T { return arr[Math.floor(this.rng() * arr.length)]; }
  private hash(s: string): number { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
}
