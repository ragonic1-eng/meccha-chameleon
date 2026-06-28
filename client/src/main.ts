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

// PWA: register the app-shell service worker (production builds only)
if (import.meta.env.PROD && "serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => {});
  });
}
