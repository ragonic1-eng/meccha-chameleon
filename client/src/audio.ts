/** Tiny procedural SFX (no audio assets). A whistle is a quick high two-tone sweep;
 *  the proximity whisper is a soft breathy loop the seeker hears louder as a hider nears. */
export class Audio {
  private ctx?: AudioContext;
  private wGain?: GainNode;
  private wPan?: StereoPannerNode;

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

  /** Wet "splat" for firing the ink blaster: a short noise burst + a quick downward blip. */
  splat() {
    this.unlock();
    const ctx = this.ctx;
    if (!ctx) return;
    const t = ctx.currentTime;
    // noise burst through a lowpass that closes quickly = a wet splat
    const len = Math.floor(ctx.sampleRate * 0.18);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.setValueAtTime(2400, t);
    lp.frequency.exponentialRampToValueAtTime(300, t + 0.16);
    const ng = ctx.createGain();
    ng.gain.setValueAtTime(0.35, t);
    ng.gain.exponentialRampToValueAtTime(0.0001, t + 0.18);
    src.connect(lp).connect(ng).connect(ctx.destination);
    src.start(t); src.stop(t + 0.2);
    // a little pitch blip for "pop"
    const osc = ctx.createOscillator();
    const og = ctx.createGain();
    osc.type = "triangle";
    osc.frequency.setValueAtTime(520, t);
    osc.frequency.exponentialRampToValueAtTime(140, t + 0.12);
    og.gain.setValueAtTime(0.12, t);
    og.gain.exponentialRampToValueAtTime(0.0001, t + 0.14);
    osc.connect(og).connect(ctx.destination);
    osc.start(t); osc.stop(t + 0.16);
  }

  /** Lazily build the looping whisper graph (filtered noise + breathy tremolo + panner). */
  private ensureWhisper() {
    const ctx = this.ctx;
    if (!ctx || this.wGain) return;
    const len = Math.floor(ctx.sampleRate * 2);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.value = 1300;
    bp.Q.value = 0.9;
    const trem = ctx.createGain();
    trem.gain.value = 0.55;
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 5.5; // ~breath rate
    const lfoG = ctx.createGain();
    lfoG.gain.value = 0.4;
    lfo.connect(lfoG).connect(trem.gain);
    const gain = ctx.createGain();
    gain.gain.value = 0;
    src.connect(bp);
    bp.connect(trem);
    trem.connect(gain);
    const pan = (ctx as any).createStereoPanner ? ctx.createStereoPanner() : null;
    if (pan) {
      gain.connect(pan);
      pan.connect(ctx.destination);
      this.wPan = pan;
    } else {
      gain.connect(ctx.destination);
    }
    src.start();
    lfo.start();
    this.wGain = gain;
  }

  /** Seeker's proximity cue. intensity 0..1 (closer = louder), pan -1..1 (hider's bearing). */
  whisper(intensity: number, pan = 0) {
    this.unlock();
    this.ensureWhisper();
    const ctx = this.ctx;
    if (!ctx || !this.wGain) return;
    this.wGain.gain.setTargetAtTime(Math.max(0, Math.min(1, intensity)) * 0.3, ctx.currentTime, 0.07);
    if (this.wPan) this.wPan.pan.setTargetAtTime(Math.max(-1, Math.min(1, pan)), ctx.currentTime, 0.1);
  }

  /** Silence the whisper (leaves the graph alive, just muted). */
  stopWhisper() {
    const ctx = this.ctx;
    if (ctx && this.wGain) this.wGain.gain.setTargetAtTime(0, ctx.currentTime, 0.12);
  }
}
