import { POSES, POSE_LABELS, type GameMode } from "@shared/types";

// ---- lightweight read-only views of the synced state ----
export interface PlayerView {
  id: string;
  name: string;
  role: string;
  ready: boolean;
  connected: boolean;
  alive: boolean;
  isHost: boolean;
  isBot: boolean;
  ping: number;
  pose: string;
  pref: string;
}
export interface StateView {
  code: string;
  phase: string;
  mode: string;
  hostId: string;
  timer: number;
  hideSec: number;
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
  private prefBtns = new Map<string, HTMLButtonElement>();
  private hideBtns = new Map<number, HTMLButtonElement>();
  private hideInfo = el("div", "ctl-label hide-info");
  private addBotBtn = el("button", "btn mode", "🤖 Add bot");
  private removeBotBtn = el("button", "btn mode", "✖ Remove bot");
  private hint = el("div", "hint");

  constructor(
    private cb: {
      onStart: () => void;
      onToggleReady: (ready: boolean) => void;
      onSetMode: (m: GameMode) => void;
      onSetHideTime: (sec: number) => void;
      onSetRolePref: (pref: string) => void;
      onAddBot: () => void;
      onRemoveBot: () => void;
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

    // everyone: pick the role you want next match
    const prefRow = el("div", "mode-row pref-row");
    ([
      ["auto", "🎲 Auto"],
      ["hider", "🦎 Hider"],
      ["seeker", "🔦 Seeker"],
    ] as [string, string][]).forEach(([p, label]) => {
      const b = el("button", "btn mode", label);
      b.onclick = () => this.cb.onSetRolePref(p);
      this.prefBtns.set(p, b);
      prefRow.append(b);
    });
    card.append(el("div", "ctl-label", "I want to be"), prefRow);

    // host: mode selector
    const modeRow = el("div", "mode-row");
    (["normal", "infection", "double"] as GameMode[]).forEach((m) => {
      const b = el("button", "btn mode", m[0].toUpperCase() + m.slice(1));
      if (m !== "normal") b.classList.add("soon");
      b.onclick = () => this.cb.onSetMode(m);
      this.modeBtns.set(m, b);
      modeRow.append(b);
    });
    // host: hide (prep) time — 1 / 2 / 3 minutes
    const hideRow = el("div", "mode-row");
    ([[60, "1 min"], [120, "2 min"], [180, "3 min"]] as [number, string][]).forEach(([sec, label]) => {
      const b = el("button", "btn mode", label);
      b.onclick = () => this.cb.onSetHideTime(sec);
      this.hideBtns.set(sec, b);
      hideRow.append(b);
    });

    // host: add/remove AI hider bots
    const botRow = el("div", "mode-row");
    this.addBotBtn.onclick = () => this.cb.onAddBot();
    this.removeBotBtn.onclick = () => this.cb.onRemoveBot();
    botRow.append(this.addBotBtn, this.removeBotBtn);

    this.startBtn.onclick = () => this.cb.onStart();
    this.hostControls.append(
      el("div", "ctl-label", "Hide time"), hideRow,
      el("div", "ctl-label", "Bots (they hide & paint)"), botRow,
      el("div", "ctl-label", "Mode"), modeRow,
      this.startBtn
    );
    // guests see the chosen hide time read-only
    this.guestControls.append(this.hideInfo);

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
      if (p.isBot) nm.append(el("span", "bot-tag", " 🤖"));
      if (p.isHost) nm.append(el("span", "crown", " ★"));
      if (p.id === myId) nm.append(el("span", "you", " (you)"));
      const right = el("div", "prow-right");
      if (p.pref && p.pref !== "auto") right.append(el("span", `pref-badge ${p.pref}`, p.pref === "seeker" ? "🔦" : "🦎"));
      const ping = el("span", `ping-badge ${pingClass(p.ping)}`, p.ping ? `${p.ping}ms` : "—");
      right.append(ping);
      if (p.ready) right.append(el("span", "ready-tick", "✓ ready"));
      row.append(dot, nm, right);
      this.roster.append(row);
    });

    const me = s.players.find((p) => p.id === myId);
    const amHost = me?.isHost ?? false;
    // highlight my chosen role preference
    this.prefBtns.forEach((b, p) => b.classList.toggle("active", (me?.pref ?? "auto") === p));
    this.hostControls.style.display = amHost ? "" : "none";
    this.guestControls.style.display = amHost ? "none" : "";

    // mode highlight
    this.modeBtns.forEach((b, m) => b.classList.toggle("active", s.mode === m));

    // hide-time highlight (host) + read-only display (guests)
    const hs = s.hideSec || 90;
    this.hideBtns.forEach((b, sec) => b.classList.toggle("active", sec === hs));
    this.hideInfo.textContent = `Hide time: ${Math.round(hs / 60 * 10) / 10} min`;

    // bot button gating (host)
    const botCount = s.players.filter((p) => p.isBot).length;
    this.addBotBtn.disabled = s.players.length >= 6;
    this.removeBotBtn.disabled = botCount === 0;

    // start gating
    const enough = s.players.length >= 2;
    this.startBtn.disabled = !enough;
    this.startBtn.textContent = enough ? "Start Match" : "Add a bot or a 2nd player";

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
  private caughtEl = el("div", "caught-hud");
  private quitBtn = el("button", "quit-btn", "✕ Quit");

  constructor(onQuit: () => void) {
    this.root.append(this.roleEl, this.phaseEl, this.timerEl);
    this.quitBtn.onclick = onQuit;
    document.body.append(this.root, this.banner, this.caughtEl, this.quitBtn);
    this.banner.style.display = "none";
    this.root.style.display = "none";
    this.caughtEl.style.display = "none";
    this.quitBtn.style.display = "none";
  }

  update(s: StateView, myId: string) {
    const inMatch = s.phase !== "lobby";
    this.root.style.display = inMatch ? "" : "none";
    this.quitBtn.style.display = inMatch ? "" : "none"; // leave to menu during a match

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

    // caught counter — how many hiders the seekers have netted
    const hiders = s.players.filter((p) => p.role === "hider");
    const caught = hiders.filter((p) => !p.alive).length;
    this.caughtEl.style.display = (s.phase === "hunt" || s.phase === "prep") && hiders.length ? "" : "none";
    this.caughtEl.textContent = `🥅 ${caught} / ${hiders.length} caught`;

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
export class ActionBar {
  root = el("div", "actionbar");
  private fireBtn = el("button", "fire-btn", "🥅");
  private reticle = el("div", "reticle");
  private poseTray = el("div", "pose-tray");
  private poseBtns = new Map<string, HTMLButtonElement>();
  private caught = el("div", "caught-overlay", "Caught! Spectating…");
  private camoBtn = el("button", "btn secondary camo-toggle", "🎨 Camouflage");
  private climbBtn = el("button", "btn secondary climb-toggle", "🧗 Climb");
  // seeker's "listen" meter — fills + heats up as the nearest hider gets closer
  private proxMeter = el("div", "prox-meter");
  private proxFill = el("div", "prox-fill");
  private proxText = el("span", "prox-text", "listen…");

  constructor(cb: { onFire: () => void; onPose: (p: string) => void; onCamo: () => void; onClimb: () => void }) {
    this.fireBtn.onclick = () => cb.onFire();
    this.camoBtn.onclick = () => cb.onCamo();
    this.climbBtn.onclick = () => cb.onClimb();
    POSES.forEach((p) => {
      const b = el("button", "pose-btn", POSE_LABELS[p]);
      b.onclick = () => cb.onPose(p);
      this.poseBtns.set(p, b);
      this.poseTray.append(b);
    });
    // all action buttons live in a RIGHT-side column so the bottom-left stays clear for the
    // movement joystick (which can appear anywhere in the left half).
    const right = el("div", "ab-right");
    right.append(this.climbBtn, this.camoBtn, this.fireBtn);
    this.root.append(this.poseTray, right);
    const bar = el("div", "prox-bar");
    bar.append(this.proxFill);
    this.proxMeter.append(el("span", "prox-ear", "👂"), bar, this.proxText);
    document.body.append(this.root, this.caught, this.proxMeter, this.reticle);
    this.caught.style.display = "none";
    this.root.style.display = "none";
    this.proxMeter.style.display = "none";
    this.reticle.style.display = "none";
  }

  update(role: string, phase: string, alive: boolean, pose: string, camoActive: boolean, climbing = false) {
    const inMatch = phase === "prep" || phase === "hunt";
    this.root.style.display = inMatch ? "" : "none";

    const showFire = role === "seeker" && phase === "hunt" && alive;
    this.fireBtn.style.display = showFire ? "" : "none";
    this.reticle.style.display = showFire ? "" : "none";

    const isHiderPrep = role === "hider" && phase === "prep" && alive;
    // poses live in the camouflage self-view (where you can see the figure strike them)
    this.poseTray.style.display = isHiderPrep && camoActive ? "" : "none";
    this.poseBtns.forEach((b, p) => b.classList.toggle("active", p === pose));
    this.camoBtn.style.display = isHiderPrep ? "" : "none";
    this.camoBtn.textContent = camoActive ? "🚶 Move" : "🎨 Camouflage";

    // climb: hiders can stick to a wall and walk up onto the ceiling (when not in the paint view)
    const canClimb = role === "hider" && alive && inMatch && !camoActive;
    this.climbBtn.style.display = canClimb ? "" : "none";
    this.climbBtn.textContent = climbing ? "⬇ Drop" : "🧗 Climb";
    this.climbBtn.classList.toggle("active", climbing);

    // the seeker hunts hiders by sound — show the listen meter during the hunt
    this.proxMeter.style.display = role === "seeker" && phase === "hunt" && alive ? "" : "none";

    this.caught.style.display = inMatch && !alive ? "" : "none";
  }

  /** seeker proximity to the nearest hider: 0 (none near) .. 1 (right on top of one) */
  setProximity(intensity: number) {
    const i = Math.max(0, Math.min(1, intensity));
    this.proxFill.style.width = Math.round(i * 100) + "%";
    this.proxFill.style.background = i > 0.66 ? "var(--bad)" : i > 0.33 ? "var(--warn)" : "var(--accent)";
    this.proxText.textContent = i > 0.66 ? "very close!" : i > 0.33 ? "getting warmer" : i > 0.05 ? "faint…" : "listen…";
  }

  /** Visually gray the fire button while the blaster is recharging. */
  setFireReady(ready: boolean) {
    this.fireBtn.classList.toggle("cooling", !ready);
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

// Quick-pick camouflage colours (earthy camo first, then a few brights) — the primary
// mobile colour picker. Fine HSL sliders live behind the "Mix" toggle for custom shades.
const SWATCHES = [
  "#4a5d3a", "#6f8f4d", "#37502a", "#7a5a36", "#b3895a", "#d8c9a8",
  "#8d9096", "#5b5e62", "#cdd0cb", "#2f3b46", "#cc4444", "#f0c020",
];
const SIZES: [string, number][] = [["S", 0.035], ["M", 0.06], ["L", 0.095]];

interface PaletteCb {
  onColor: (hex: string) => void;
  onBrush: (radius: number) => void;
  onEyedropper: () => void;
  onClear: () => void;
  onFill: () => void;
  onErase: (active: boolean) => void;
  onRotate: (dyaw: number) => void;
}

/** Mobile-first camouflage palette: tap a swatch, tap a tool, big touch targets. */
export class PaintPalette {
  root = el("div", "palette");
  private swatch = el("div", "swatch");
  private chips = new Map<string, HTMLButtonElement>();
  private sizeBtns = new Map<number, HTMLButtonElement>();
  private eyeBtn = toolBtn("💧", "Pick");
  private fillBtn = toolBtn("🪣", "Fill");
  private eraseBtn = toolBtn("🧽", "Erase");
  private clearBtn = toolBtn("🗑️", "Clear");
  private mixBtn = toolBtn("🎚️", "Mix");
  private hue = sliderEl(0, 360, 110);
  private sat = sliderEl(0, 100, 55);
  private light = sliderEl(0, 100, 45);
  private sliders = el("div", "pal-sliders");
  private palBody = el("div", "pal-body");
  private collapseBtn = el("button", "pal-collapse", "▾ hide tools");
  private erasing = false;
  private collapsed = false;

  constructor(private cb: PaletteCb) {
    // --- tools row ---
    const tools = el("div", "pal-tools");
    this.eyeBtn.onclick = () => { if (this.erasing) this.setErasing(false); cb.onEyedropper(); };
    this.fillBtn.onclick = () => { this.setErasing(false); cb.onFill(); };
    this.eraseBtn.onclick = () => this.setErasing(!this.erasing);
    this.clearBtn.onclick = () => cb.onClear();
    this.mixBtn.onclick = () => this.sliders.classList.toggle("open");
    tools.append(this.eyeBtn, this.fillBtn, this.eraseBtn, this.clearBtn, this.mixBtn);

    // --- swatches grid ---
    const grid = el("div", "pal-swatches");
    for (const hex of SWATCHES) {
      const c = el("button", "swatch-chip");
      c.style.background = hex;
      c.onclick = () => this.pick(hex, true);
      this.chips.set(hex, c);
      grid.append(c);
    }

    // --- size + rotate row ---
    const row = el("div", "pal-row");
    const sizes = el("div", "pal-sizes");
    for (const [label, r] of SIZES) {
      const b = el("button", "size-btn");
      b.append(el("span", `size-dot s-${label.toLowerCase()}`), el("span", "size-lbl", label));
      b.onclick = () => this.pickSize(r);
      this.sizeBtns.set(r, b);
      sizes.append(b);
    }
    const rot = el("div", "pal-rotate");
    const rl = el("button", "rot-btn", "⟲");
    const rr = el("button", "rot-btn", "⟳");
    rl.onclick = () => cb.onRotate(0.6);
    rr.onclick = () => cb.onRotate(-0.6);
    rot.append(rl, this.swatch, rr);
    row.append(sizes, rot);

    // --- collapsible fine-tune sliders ---
    const onHsl = () => this.pick(hslToHex(+this.hue.value, +this.sat.value, +this.light.value), false);
    [this.hue, this.sat, this.light].forEach((s) => (s.oninput = onHsl));
    this.sliders.append(
      labeledSlider("Hue", this.hue),
      labeledSlider("Saturation", this.sat),
      labeledSlider("Light / shade", this.light)
    );

    // collapse toggle — lets the player hide the whole palette to see the full character
    this.collapseBtn.onclick = () => this.setCollapsed(!this.collapsed);
    this.palBody.append(tools, grid, row, this.sliders);
    this.root.append(this.collapseBtn, this.palBody);
    document.body.append(this.root);
    this.root.style.display = "none";

    this.pickSize(0.06);
    this.pick("#6f8f4d", true);
  }

  private setCollapsed(v: boolean) {
    this.collapsed = v;
    this.root.classList.toggle("collapsed", v);
    this.collapseBtn.textContent = v ? "🎨 paint tools" : "▾ hide tools";
  }

  /** select a colour; `fromChip` also syncs the fine-tune sliders to it */
  private pick(hex: string, fromChip: boolean) {
    this.swatch.style.background = hex;
    this.chips.forEach((c, col) => c.classList.toggle("active", col.toLowerCase() === hex.toLowerCase()));
    if (fromChip) {
      const { h, s, l } = hexToHsl(hex);
      this.hue.value = String(Math.round(h));
      this.sat.value = String(Math.round(s));
      this.light.value = String(Math.round(l));
    }
    if (this.erasing) this.setErasing(false);
    this.cb.onColor(hex);
  }

  private pickSize(r: number) {
    this.sizeBtns.forEach((b, rr) => b.classList.toggle("active", rr === r));
    this.cb.onBrush(r);
  }

  private setErasing(v: boolean) {
    this.erasing = v;
    this.eraseBtn.classList.toggle("active", v);
    if (v) this.setEyedropper(false);
    this.cb.onErase(v);
  }

  show(v: boolean) {
    this.root.style.display = v ? "" : "none";
    if (v) this.setCollapsed(false);
  }
  /** reflect a colour sampled by the eyedropper back into the swatch + sliders */
  setColor(hex: string) {
    this.swatch.style.background = hex;
    const { h, s, l } = hexToHsl(hex);
    this.hue.value = String(Math.round(h));
    this.sat.value = String(Math.round(s));
    this.light.value = String(Math.round(l));
    this.chips.forEach((c, col) => c.classList.toggle("active", col.toLowerCase() === hex.toLowerCase()));
    if (this.erasing) this.setErasing(false);
  }
  setEyedropper(active: boolean) {
    this.eyeBtn.classList.toggle("active", active);
  }
}

function toolBtn(icon: string, label: string): HTMLButtonElement {
  const b = el("button", "tool-btn");
  b.append(el("span", "tl-ico", icon), el("span", "tl-txt", label));
  return b;
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
