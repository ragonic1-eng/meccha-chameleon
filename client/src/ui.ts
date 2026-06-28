import type { GameMode } from "@shared/types";

// ---- lightweight read-only views of the synced state ----
export interface PlayerView {
  id: string;
  name: string;
  role: string;
  ready: boolean;
  connected: boolean;
  alive: boolean;
  isHost: boolean;
  ping: number;
  pose: string;
}
export interface StateView {
  code: string;
  phase: string;
  mode: string;
  hostId: string;
  timer: number;
  winner: string;
  players: PlayerView[];
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls?: string,
  text?: string
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function pingClass(ms: number): string {
  if (ms >= 160) return "bad";
  if (ms >= 80) return "warn";
  return "good";
}

// ============================ Landing ============================
export class LandingScreen {
  root = el("div", "screen landing");
  private nameInput = el("input", "field");
  private codeInput = el("input", "field code-field");
  private err = el("div", "err");

  constructor(opts: {
    defaultName: string;
    onCreate: (name: string) => void;
    onJoin: (name: string, code: string) => void;
  }) {
    const card = el("div", "card");
    card.append(el("h1", "title", "Meccha Chameleon"));
    card.append(el("p", "subtitle", "Paint yourself. Vanish. Win."));

    this.nameInput.placeholder = "Your name";
    this.nameInput.value = opts.defaultName;
    this.nameInput.maxLength = 16;
    card.append(labeled("Name", this.nameInput));

    const createBtn = el("button", "btn primary big", "Create Room");
    createBtn.onclick = () => opts.onCreate(this.name());
    card.append(createBtn);

    card.append(el("div", "divider", "or join a game"));

    this.codeInput.placeholder = "CODE";
    this.codeInput.maxLength = 6;
    this.codeInput.autocapitalize = "characters";
    this.codeInput.oninput = () => {
      this.codeInput.value = this.codeInput.value.toUpperCase().replace(/[^A-Z0-9]/g, "");
    };
    const joinRow = el("div", "row");
    const joinBtn = el("button", "btn secondary", "Join");
    joinBtn.onclick = () => opts.onJoin(this.name(), this.codeInput.value);
    joinRow.append(this.codeInput, joinBtn);
    card.append(joinRow);

    card.append(this.err);
    this.root.append(card);
  }

  private name() {
    return this.nameInput.value.trim() || "Player";
  }
  setError(msg: string) {
    this.err.textContent = msg;
  }
  show(v: boolean) {
    this.root.style.display = v ? "" : "none";
  }
}

// ============================ Lobby ============================
export class LobbyScreen {
  root = el("div", "screen lobby");
  private codeEl = el("div", "code");
  private roster = el("div", "roster");
  private hostControls = el("div", "host-controls");
  private guestControls = el("div", "guest-controls");
  private startBtn = el("button", "btn primary big", "Start Match");
  private readyBtn = el("button", "btn primary big", "Ready");
  private modeBtns = new Map<GameMode, HTMLButtonElement>();
  private hint = el("div", "hint");

  constructor(
    private cb: {
      onStart: () => void;
      onToggleReady: (ready: boolean) => void;
      onSetMode: (m: GameMode) => void;
      onLeave: () => void;
      onCopy: (code: string) => void;
    }
  ) {
    const card = el("div", "card wide");

    const head = el("div", "lobby-head");
    const codeWrap = el("div", "code-wrap");
    codeWrap.append(el("span", "code-label", "ROOM CODE"), this.codeEl);
    const copyBtn = el("button", "btn ghost small", "Copy");
    copyBtn.onclick = () => this.cb.onCopy(this.codeEl.textContent || "");
    codeWrap.append(copyBtn);
    const leaveBtn = el("button", "btn ghost small", "Leave");
    leaveBtn.onclick = () => this.cb.onLeave();
    head.append(codeWrap, leaveBtn);
    card.append(head);

    card.append(this.roster);

    // host: mode selector
    const modeRow = el("div", "mode-row");
    (["normal", "infection", "double"] as GameMode[]).forEach((m) => {
      const b = el("button", "btn mode", m[0].toUpperCase() + m.slice(1));
      if (m !== "normal") b.classList.add("soon");
      b.onclick = () => this.cb.onSetMode(m);
      this.modeBtns.set(m, b);
      modeRow.append(b);
    });
    this.startBtn.onclick = () => this.cb.onStart();
    this.hostControls.append(el("div", "ctl-label", "Mode"), modeRow, this.startBtn);

    // guest: ready toggle
    this.readyBtn.onclick = () => {
      const nowReady = !this.readyBtn.classList.contains("on");
      this.cb.onToggleReady(nowReady);
    };
    this.guestControls.append(this.readyBtn);

    card.append(this.hostControls, this.guestControls, this.hint);
    this.root.append(card);
  }

  update(s: StateView, myId: string) {
    this.codeEl.textContent = s.code;

    // roster
    this.roster.replaceChildren();
    s.players.forEach((p) => {
      const row = el("div", "player-row");
      const dot = el("span", `pdot ${p.connected ? "online" : "offline"}`);
      const nm = el("span", "pname", p.name);
      if (p.isHost) nm.append(el("span", "crown", " ★"));
      if (p.id === myId) nm.append(el("span", "you", " (you)"));
      const right = el("div", "prow-right");
      const ping = el("span", `ping-badge ${pingClass(p.ping)}`, p.ping ? `${p.ping}ms` : "—");
      right.append(ping);
      if (p.ready) right.append(el("span", "ready-tick", "✓ ready"));
      row.append(dot, nm, right);
      this.roster.append(row);
    });

    const me = s.players.find((p) => p.id === myId);
    const amHost = me?.isHost ?? false;
    this.hostControls.style.display = amHost ? "" : "none";
    this.guestControls.style.display = amHost ? "none" : "";

    // mode highlight
    this.modeBtns.forEach((b, m) => b.classList.toggle("active", s.mode === m));

    // start gating
    const enough = s.players.length >= 2;
    this.startBtn.disabled = !enough;
    this.startBtn.textContent = enough ? "Start Match" : "Need 2+ players";

    // ready button state
    if (me) {
      this.readyBtn.classList.toggle("on", me.ready);
      this.readyBtn.textContent = me.ready ? "Ready ✓" : "Ready?";
    }
    this.hint.textContent = amHost
      ? "Share the code. Press Start when everyone's in."
      : "Waiting for the host to start…";
  }

  show(v: boolean) {
    this.root.style.display = v ? "" : "none";
  }
}

// ============================ In-match top bar ============================
export class GameBar {
  root = el("div", "gamebar");
  private phaseEl = el("span", "gb-phase");
  private timerEl = el("span", "gb-timer");
  private roleEl = el("span", "gb-role");
  private banner = el("div", "result-banner");

  constructor() {
    this.root.append(this.roleEl, this.phaseEl, this.timerEl);
    document.body.append(this.banner);
    this.banner.style.display = "none";
    this.root.style.display = "none";
  }

  update(s: StateView, myId: string) {
    const inMatch = s.phase !== "lobby";
    this.root.style.display = inMatch ? "" : "none";

    const me = s.players.find((p) => p.id === myId);
    const role = me?.role ?? "";
    this.roleEl.textContent = role === "seeker" ? "SEEKER" : role === "hider" ? "HIDER" : "";
    this.roleEl.className = `gb-role ${role}`;

    const label =
      s.phase === "prep" ? "HIDE & PAINT" : s.phase === "hunt" ? "HUNT" : s.phase === "results" ? "RESULTS" : "";
    this.phaseEl.textContent = label;
    const m = Math.floor(s.timer / 60);
    const sec = s.timer % 60;
    this.timerEl.textContent = `${m}:${sec.toString().padStart(2, "0")}`;

    // results banner
    if (s.phase === "results" && s.winner) {
      const iWon =
        (s.winner === "seekers" && role === "seeker") || (s.winner === "hiders" && role === "hider");
      this.banner.textContent = `${s.winner === "hiders" ? "Hiders" : "Seekers"} win!  ${iWon ? "🎉 You won" : "You lost"}`;
      this.banner.className = `result-banner ${iWon ? "win" : "lose"}`;
      this.banner.style.display = "";
    } else {
      this.banner.style.display = "none";
    }
  }
}

// ============================ Action bar (in-match) ============================
const POSES = ["stand", "crouch", "curl", "lie", "flatten"] as const;

export class ActionBar {
  root = el("div", "actionbar");
  private tagBtn = el("button", "tag-btn", "TAG");
  private poseBar = el("div", "pose-bar");
  private poseBtns = new Map<string, HTMLButtonElement>();
  private caught = el("div", "caught-overlay", "Caught! Spectating…");

  private camoBtn = el("button", "btn secondary camo-toggle", "🎨 Camouflage");

  constructor(cb: { onTag: () => void; onPose: (p: string) => void; onCamo: () => void }) {
    this.tagBtn.onclick = () => cb.onTag();
    this.camoBtn.onclick = () => cb.onCamo();
    POSES.forEach((p) => {
      const b = el("button", "pose-btn", p);
      b.onclick = () => cb.onPose(p);
      this.poseBtns.set(p, b);
      this.poseBar.append(b);
    });
    const left = el("div", "ab-left");
    left.append(this.poseBar, this.camoBtn);
    this.root.append(left, this.tagBtn);
    document.body.append(this.root, this.caught);
    this.caught.style.display = "none";
    this.root.style.display = "none";
  }

  update(role: string, phase: string, alive: boolean, pose: string, camoActive: boolean) {
    const inMatch = phase === "prep" || phase === "hunt";
    this.root.style.display = inMatch ? "" : "none";

    const showTag = role === "seeker" && phase === "hunt" && alive;
    this.tagBtn.style.display = showTag ? "" : "none";

    const isHiderPrep = role === "hider" && phase === "prep" && alive;
    this.poseBar.style.display = isHiderPrep ? "" : "none";
    this.poseBtns.forEach((b, p) => b.classList.toggle("active", p === pose));
    this.camoBtn.style.display = isHiderPrep ? "" : "none";
    this.camoBtn.textContent = camoActive ? "🚶 Move" : "🎨 Camouflage";

    this.caught.style.display = inMatch && !alive ? "" : "none";
  }
}

// ============================ Paint palette ============================
function hslToHex(h: number, s: number, l: number): string {
  s /= 100;
  l /= 100;
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => {
    const c = l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
    return Math.round(255 * c)
      .toString(16)
      .padStart(2, "0");
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}

export class PaintPalette {
  root = el("div", "palette");
  private swatch = el("div", "swatch");
  private hue = sliderEl(0, 360, 110);
  private sat = sliderEl(0, 100, 55);
  private light = sliderEl(0, 100, 45);
  private size = sliderEl(2, 12, 5);
  private eyeBtn = el("button", "btn ghost eye-btn", "💧 Eyedropper");

  constructor(
    private cb: { onColor: (hex: string) => void; onBrush: (radius: number) => void; onEyedropper: () => void; onClear: () => void }
  ) {
    const top = el("div", "pal-top");
    top.append(this.swatch, this.eyeBtn);

    this.eyeBtn.onclick = () => cb.onEyedropper();
    const onHsl = () => {
      const hex = hslToHex(+this.hue.value, +this.sat.value, +this.light.value);
      this.swatch.style.background = hex;
      cb.onColor(hex);
    };
    [this.hue, this.sat, this.light].forEach((s) => (s.oninput = onHsl));
    this.size.oninput = () => cb.onBrush(+this.size.value / 100);

    const clearBtn = el("button", "btn ghost small", "Clear");
    clearBtn.onclick = () => cb.onClear();

    this.root.append(
      top,
      labeledSlider("Hue", this.hue),
      labeledSlider("Saturation", this.sat),
      labeledSlider("Light / shade", this.light),
      labeledSlider("Brush size", this.size),
      clearBtn
    );
    document.body.append(this.root);
    this.root.style.display = "none";
    onHsl();
    cb.onBrush(+this.size.value / 100);
  }

  show(v: boolean) {
    this.root.style.display = v ? "" : "none";
  }
  /** reflect a color sampled by the eyedropper back into the sliders + swatch */
  setColor(hex: string) {
    this.swatch.style.background = hex;
    const { h, s, l } = hexToHsl(hex);
    this.hue.value = String(Math.round(h));
    this.sat.value = String(Math.round(s));
    this.light.value = String(Math.round(l));
  }
  setEyedropper(active: boolean) {
    this.eyeBtn.classList.toggle("active", active);
  }
}

function sliderEl(min: number, max: number, val: number): HTMLInputElement {
  const s = el("input", "slider") as HTMLInputElement;
  s.type = "range";
  s.min = String(min);
  s.max = String(max);
  s.value = String(val);
  return s;
}
function labeledSlider(label: string, s: HTMLInputElement): HTMLElement {
  const w = el("div", "slider-row");
  w.append(el("span", "slider-label", label), s);
  return w;
}
function hexToHsl(hex: string): { h: number; s: number; l: number } {
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  let h = 0;
  const l = (max + min) / 2;
  const d = max - min;
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  if (d !== 0) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return { h, s: s * 100, l: l * 100 };
}

function labeled(label: string, field: HTMLElement): HTMLElement {
  const w = el("label", "labeled");
  w.append(el("span", "lbl", label), field);
  return w;
}
