import * as THREE from "three";

/**
 * Placeholder 3D world for Phase 0/2 — a simple room with desks, replaced by the
 * converted Japanese-classroom GLB in Phase 4. Owns the renderer + render loop.
 */
export class GameScene {
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly renderer: THREE.WebGLRenderer;
  private clock = new THREE.Clock();
  private raf = 0;
  private onFrame?: (dt: number) => void;
  private placeholder = new THREE.Group();
  private mapGroup?: THREE.Group;
  private sun!: THREE.DirectionalLight;
  private hemi!: THREE.HemisphereLight;
  // a second scene drawn on top (depth cleared) for the camouflage self-view figure,
  // so furniture never occludes it while self-occlusion stays correct
  private overlay = new THREE.Scene();
  private overlayObj?: THREE.Object3D;

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
    this.renderer.setClearColor(0x10141a, 1);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    this.camera = new THREE.PerspectiveCamera(70, 1, 0.05, 100);
    this.camera.position.set(0, 1.6, 4.5);
    this.camera.lookAt(0, 1, 0);

    this.buildPlaceholderRoom();
    this.overlay.add(new THREE.HemisphereLight(0xffffff, 0x556055, 1.15));
    const od = new THREE.DirectionalLight(0xfff2d6, 1.0);
    od.position.set(2, 4, 3);
    this.overlay.add(od);

    this.resize();
    window.addEventListener("resize", () => this.resize());
  }

  /** Object rendered on top of the world (depth-cleared) — used for the paint self-view. */
  setOverlay(obj: THREE.Object3D | null) {
    if (this.overlayObj) this.overlay.remove(this.overlayObj);
    this.overlayObj = obj ?? undefined;
    if (obj) this.overlay.add(obj);
  }

  /** Room dimensions roughly match the asset's classroom01_8x10x3.5m shell. */
  private buildPlaceholderRoom() {
    const W = 8,
      D = 10,
      H = 3.5;
    const s = this.scene;
    const room = this.placeholder;
    s.fog = new THREE.Fog(0x10141a, 14, 30);

    this.hemi = new THREE.HemisphereLight(0xfdf6e3, 0x33352f, 0.9);
    s.add(this.hemi);
    this.sun = new THREE.DirectionalLight(0xfff2d6, 1.1);
    this.sun.position.set(4, 6, 3);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.camera.left = -8;
    this.sun.shadow.camera.right = 8;
    this.sun.shadow.camera.top = 8;
    this.sun.shadow.camera.bottom = -8;
    this.sun.shadow.bias = -0.0004;
    s.add(this.sun);
    s.add(room);

    const floorMat = new THREE.MeshStandardMaterial({ color: 0xb08a5a, roughness: 0.9 });
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(W, D), floorMat);
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    room.add(floor);

    const wallMat = new THREE.MeshStandardMaterial({ color: 0xd8d2c0, roughness: 1 });
    const mkWall = (w: number, h: number, x: number, y: number, z: number, ry: number) => {
      const wall = new THREE.Mesh(new THREE.PlaneGeometry(w, h), wallMat);
      wall.position.set(x, y, z);
      wall.rotation.y = ry;
      wall.receiveShadow = true;
      room.add(wall);
    };
    mkWall(W, H, 0, H / 2, -D / 2, 0); // back (blackboard wall)
    mkWall(W, H, 0, H / 2, D / 2, Math.PI); // front
    mkWall(D, H, -W / 2, H / 2, 0, Math.PI / 2); // left (windows)
    mkWall(D, H, W / 2, H / 2, 0, -Math.PI / 2); // right

    // blackboard
    const board = new THREE.Mesh(
      new THREE.PlaneGeometry(4, 1.4),
      new THREE.MeshStandardMaterial({ color: 0x21402c, roughness: 0.8 })
    );
    board.position.set(0, 1.5, -D / 2 + 0.02);
    room.add(board);

    // a 3x4 grid of placeholder desks
    const deskMat = new THREE.MeshStandardMaterial({ color: 0xc8a36a, roughness: 0.7 });
    const legMat = new THREE.MeshStandardMaterial({ color: 0x9aa0a6, roughness: 0.5, metalness: 0.4 });
    for (let cx = 0; cx < 3; cx++) {
      for (let cz = 0; cz < 4; cz++) {
        const g = new THREE.Group();
        const top = new THREE.Mesh(new THREE.BoxGeometry(0.65, 0.05, 0.45), deskMat);
        top.position.y = 0.72;
        top.castShadow = true;
        top.receiveShadow = true;
        g.add(top);
        for (const [lx, lz] of [
          [-0.28, -0.18],
          [0.28, -0.18],
          [-0.28, 0.18],
          [0.28, 0.18],
        ]) {
          const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 0.72), legMat);
          leg.position.set(lx, 0.36, lz);
          g.add(leg);
        }
        g.position.set(-2 + cx * 1.6, 0, -2.6 + cz * 1.4);
        room.add(g);
      }
    }
  }

  /** Swap the placeholder room for the loaded classroom map. */
  setMap(group: THREE.Group) {
    this.scene.remove(this.placeholder);
    if (this.mapGroup) this.scene.remove(this.mapGroup);
    this.mapGroup = group;
    this.scene.add(group);
    // brighter, cooler interior lighting for the textured room
    this.hemi.intensity = 1.05;
    this.sun.intensity = 1.25;
    this.scene.fog = new THREE.Fog(0x12161a, 16, 36);
  }

  setFrameCallback(cb: (dt: number) => void) {
    this.onFrame = cb;
  }

  start() {
    const loop = () => {
      this.raf = requestAnimationFrame(loop);
      const dt = this.clock.getDelta();
      this.onFrame?.(dt);
      this.renderer.render(this.scene, this.camera);
      if (this.overlayObj) {
        this.renderer.autoClear = false;
        this.renderer.clearDepth();
        this.renderer.render(this.overlay, this.camera);
        this.renderer.autoClear = true;
      }
    };
    loop();
  }

  stop() {
    cancelAnimationFrame(this.raf);
  }

  private resize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }
}
