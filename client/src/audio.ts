/** Tiny procedural SFX (no audio assets). A whistle is a quick high two-tone sweep. */
export class Audio {
  private ctx?: AudioContext;

  /** Create/resume the context — must be triggered by a user gesture (autoplay policy). */
  unlock() {
    if (!this.ctx) {
      const Ctor = window.AudioContext || (window as any).webkitAudioContext;
      if (Ctor) this.ctx = new Ctor();
    }
    if (this.ctx?.state === "suspended") this.ctx.resume().catch(() => {});
  }

  /** Whistle to attract attention. volume 0..1 (use distance falloff for remote whistles). */
  whistle(volume = 1) {
    this.unlock();
    const ctx = this.ctx;
    if (!ctx) return;
    const t = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.setValueAtTime(1700, t);
    osc.frequency.exponentialRampToValueAtTime(2600, t + 0.12);
    osc.frequency.exponentialRampToValueAtTime(2050, t + 0.3);
    const v = Math.max(0.0001, Math.min(1, volume) * 0.22);
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(v, t + 0.03);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.42);
    osc.connect(gain).connect(ctx.destination);
    osc.start(t);
    osc.stop(t + 0.45);
  }
}
