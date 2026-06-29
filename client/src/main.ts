import "./style.css";
import { App } from "./app";

const canvas = document.getElementById("game") as HTMLCanvasElement;
new App(canvas);

// hide the splash once the first frames have painted
const splash = document.getElementById("splash");
requestAnimationFrame(() =>
  requestAnimationFrame(() => {
    splash?.classList.add("hide");
    setTimeout(() => splash?.remove(), 500);
  })
);

// PWA: register the app-shell service worker (production builds only).
// When an updated worker activates and takes control, reload once so a player who had the
// old build cached lands on the fresh one automatically (no manual hard-refresh needed).
if (import.meta.env.PROD && "serviceWorker" in navigator) {
  let reloading = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (reloading) return;
    reloading = true;
    location.reload();
  });
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => {});
  });
}

