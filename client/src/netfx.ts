import * as THREE from "three";

const SWING_DUR = 0.42; // seconds for one net swing

function rainbowTex(): THREE.CanvasTexture {
  const cv = document.createElement("canvas");
  cv.width = 64; cv.height = 8;
  const c = cv.getContext("2d")!;
  const g = c.createLinearGradient(0, 0, 64, 0);
  for (let i = 0; i <= 6; i++) g.addColorStop(i / 6, `hsl(${i * 60},85%,55%)`);
  c.fillStyle = g; c.fillRect(0, 0, 64, 8);
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

/**
 * First-person "rainbow long-rod net" the seeker swings to catch hiders. Drawn on top of the
 * world (depthTest off, like a weapon viewmodel) and animated through a downward arc on swing.
 */
export class NetTool {
  readonly group = new THREE.Group();
  private rig = new THREE.Group();
  private swingT = 0;

  constructor(scene: THREE.Scene) {
    const tex = rainbowTex();
    const onTop = (m: THREE.Material) => { m.depthTest = false; m.depthWrite = false; return m; };

    const rodMat = onTop(new THREE.MeshBasicMaterial({ map: tex })) as THREE.MeshBasicMaterial;
    const rod = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.024, 0.92, 10), rodMat);
    rod.rotation.x = Math.PI / 2; rod.position.z = -0.46;

    const hoopMat = onTop(new THREE.MeshBasicMaterial({ map: tex })) as THREE.MeshBasicMaterial;
    const hoop = new THREE.Mesh(new THREE.TorusGeometry(0.17, 0.03, 10, 28), hoopMat);
    hoop.position.z = -0.96;

    const netMat = onTop(new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.26, side: THREE.DoubleSide })) as THREE.MeshBasicMaterial;
    const net = new THREE.Mesh(new THREE.ConeGeometry(0.165, 0.34, 14, 1, true), netMat);
    net.rotation.x = Math.PI / 2; net.position.z = -0.79;

    this.rig.add(rod, hoop, net);
    this.rig.position.set(0.27, -0.3, 0); // lower-right of the view
    this.rig.rotation.x = -0.32;          // idle: net points up-forward
    this.group.add(this.rig);
    this.group.renderOrder = 999;
    this.group.visible = false;
    scene.add(this.group);
  }

  setVisible(v: boolean) { this.group.visible = v; }
  swing() { this.swingT = SWING_DUR; }

  /** Anchor the tool to the camera and play the swing arc. */
  update(camera: THREE.Camera, dt: number) {
    if (!this.group.visible) return;
    this.group.position.copy(camera.position);
    this.group.quaternion.copy(camera.quaternion);
    if (this.swingT > 0) this.swingT = Math.max(0, this.swingT - dt);
    const p = 1 - this.swingT / SWING_DUR;           // 0 → 1 across the swing
    const arc = this.swingT > 0 ? Math.sin(p * Math.PI) : 0;
    this.rig.rotation.x = -0.32 + arc * 1.3;          // sweep down…
    this.rig.rotation.z = arc * -0.55;                // …and across
  }
}
