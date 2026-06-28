/**
 * Mobile-first input: left half of the screen is a floating virtual joystick (move),
 * right half is drag-to-look. Falls back to WASD + mouse-drag on desktop.
 */
export class Controls {
  /** movement vector, x = strafe, y = forward, each in -1..1 */
  readonly move = { x: 0, y: 0 };
  enabled = true;

  private look = { dx: 0, dy: 0 };
  private joyVec = { x: 0, y: 0 };
  private joyPointer = -1;
  private joyOrigin = { x: 0, y: 0 };
  private lookPointer = -1;
  private lookLast = { x: 0, y: 0 };
  private keys = new Set<string>();

  private joy = document.createElement("div");
  private knob = document.createElement("div");

  constructor(private surface: HTMLElement) {
    this.joy.className = "joystick";
    this.knob.className = "joy-knob";
    this.joy.appendChild(this.knob);
    this.joy.style.display = "none";
    document.body.appendChild(this.joy);

    surface.addEventListener("pointerdown", this.onDown, { passive: false });
    surface.addEventListener("pointermove", this.onMove, { passive: false });
    surface.addEventListener("pointerup", this.onUp);
    surface.addEventListener("pointercancel", this.onUp);

    window.addEventListener("keydown", (e) => this.keys.add(e.key.toLowerCase()));
    window.addEventListener("keyup", (e) => this.keys.delete(e.key.toLowerCase()));
  }

  private onDown = (e: PointerEvent) => {
    if (!this.enabled) return;
    const leftHalf = e.clientX < window.innerWidth * 0.5;
    if (leftHalf && this.joyPointer === -1) {
      this.joyPointer = e.pointerId;
      this.joyOrigin = { x: e.clientX, y: e.clientY };
      this.joy.style.left = `${e.clientX}px`;
      this.joy.style.top = `${e.clientY}px`;
      this.joy.style.display = "";
      this.knob.style.transform = "translate(-50%, -50%)";
    } else if (this.lookPointer === -1) {
      this.lookPointer = e.pointerId;
      this.lookLast = { x: e.clientX, y: e.clientY };
    }
  };

  private onMove = (e: PointerEvent) => {
    if (!this.enabled) return;
    if (e.pointerId === this.joyPointer) {
      const R = 56;
      let dx = e.clientX - this.joyOrigin.x;
      let dy = e.clientY - this.joyOrigin.y;
      const len = Math.hypot(dx, dy) || 1;
      const cl = Math.min(len, R);
      const nx = (dx / len) * cl;
      const ny = (dy / len) * cl;
      this.knob.style.transform = `translate(calc(-50% + ${nx}px), calc(-50% + ${ny}px))`;
      this.joyVec.x = (dx / len) * (cl / R);
      this.joyVec.y = -(dy / len) * (cl / R); // up = forward
    } else if (e.pointerId === this.lookPointer) {
      this.look.dx += e.clientX - this.lookLast.x;
      this.look.dy += e.clientY - this.lookLast.y;
      this.lookLast = { x: e.clientX, y: e.clientY };
    }
  };

  private onUp = (e: PointerEvent) => {
    if (e.pointerId === this.joyPointer) {
      this.joyPointer = -1;
      this.joyVec.x = 0;
      this.joyVec.y = 0;
      this.joy.style.display = "none";
    } else if (e.pointerId === this.lookPointer) {
      this.lookPointer = -1;
    }
  };

  /** call once per frame to refresh the combined movement vector */
  sample() {
    if (!this.enabled) {
      this.move.x = 0;
      this.move.y = 0;
      return;
    }
    let kx = 0;
    let ky = 0;
    if (this.keys.has("w") || this.keys.has("arrowup")) ky += 1;
    if (this.keys.has("s") || this.keys.has("arrowdown")) ky -= 1;
    if (this.keys.has("d") || this.keys.has("arrowright")) kx += 1;
    if (this.keys.has("a") || this.keys.has("arrowleft")) kx -= 1;
    if (kx || ky) {
      const l = Math.hypot(kx, ky) || 1;
      this.move.x = kx / l;
      this.move.y = ky / l;
    } else {
      this.move.x = this.joyVec.x;
      this.move.y = this.joyVec.y;
    }
  }

  /** returns accumulated look delta in pixels and clears it */
  consumeLook() {
    const l = { dx: this.look.dx, dy: this.look.dy };
    this.look.dx = 0;
    this.look.dy = 0;
    return l;
  }

  setEnabled(v: boolean) {
    this.enabled = v;
    if (!v) {
      this.joyPointer = -1;
      this.lookPointer = -1;
      this.joyVec.x = 0;
      this.joyVec.y = 0;
      this.joy.style.display = "none";
    }
  }
}
