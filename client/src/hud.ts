/** Always-visible ping indicator (top-left). Color-coded by latency. */
export class PingHud {
  private el: HTMLDivElement;
  private dot: HTMLSpanElement;
  private value: HTMLSpanElement;

  constructor(parent: HTMLElement = document.body) {
    this.el = document.createElement("div");
    this.el.className = "hud";

    this.dot = document.createElement("span");
    this.dot.className = "ping-dot";

    const label = document.createElement("span");
    label.className = "label";
    label.textContent = "ping";

    this.value = document.createElement("span");
    this.value.textContent = "—";

    this.el.append(this.dot, label, this.value);
    parent.appendChild(this.el);
  }

  set(rttMs: number) {
    const ms = Math.round(rttMs);
    this.value.textContent = `${ms} ms`;
    this.dot.classList.toggle("warn", ms >= 80 && ms < 160);
    this.dot.classList.toggle("bad", ms >= 160);
  }

  setDisconnected() {
    this.value.textContent = "offline";
    this.dot.classList.remove("warn");
    this.dot.classList.add("bad");
  }
}
