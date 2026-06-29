// App-shell service worker. The app code (HTML/JS/CSS) is fetched NETWORK-FIRST so a
// returning player always gets the latest build when online — caching app code stale was
// serving the old single-classroom bundle for ages. Big immutable assets (maps, textures,
// icons) stay stale-while-revalidate for speed + offline. Realtime paths are never touched.
const CACHE = "mcc-v7";
const APP_SHELL = /\.(?:html|js|css)$/;

self.addEventListener("install", () => self.skipWaiting());

self.addEventListener("activate", (e) =>
  e.waitUntil(
    (async () => {
      // purge every previous cache so stale app code can never be served again
      const names = await caches.keys();
      await Promise.all(names.filter((n) => n !== CACHE).map((n) => caches.delete(n)));
      await self.clients.claim();
    })()
  )
);

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (/^\/(api|matchmake|health)/.test(url.pathname)) return;

  // app code: network-first (fresh build when online, cache only as offline fallback)
  if (req.mode === "navigate" || APP_SHELL.test(url.pathname)) {
    e.respondWith(
      fetch(req)
        .then((res) => {
          if (res && res.ok) caches.open(CACHE).then((c) => c.put(req, res.clone()));
          return res;
        })
        .catch(() => caches.match(req))
    );
    return;
  }

  // everything else (GLB maps, textures, icons): stale-while-revalidate
  e.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const cached = await cache.match(req);
      const network = fetch(req)
        .then((res) => {
          if (res && res.ok) cache.put(req, res.clone());
          return res;
        })
        .catch(() => cached);
      return cached || network;
    })
  );
});
