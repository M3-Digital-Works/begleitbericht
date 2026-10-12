/* Service Worker: hält die App offline verfügbar.
 * Strategie "network-first": bei Internet wird immer die aktuelle Version vom Server geholt
 * (und im Hintergrund im Cache aktualisiert) – Änderungen erscheinen sofort beim nächsten Laden,
 * ohne zweimaliges Neuladen. Nur ohne Internet greift der gespeicherte Stand. */
const CACHE = "transportbegleitung-v3"; // Versionswechsel: Cache-Strategie auf "network-first" umgestellt
const ASSETS = [
  "./", "index.html", "style.css", "app.js", "pdf.js", "vendor/pdf-lib.min.js",
  "template.pdf", "manifest.webmanifest", "icon-192.png", "icon-512.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET" || new URL(req.url).origin !== location.origin) return;
  e.respondWith(
    caches.open(CACHE).then(async (cache) => {
      try {
        const res = await fetch(req);
        if (res && res.ok) cache.put(req, res.clone());
        return res;
      } catch (err) {
        const cached = await cache.match(req, { ignoreSearch: true });
        return cached || (req.mode === "navigate" ? cache.match("index.html") : Promise.reject(err));
      }
    })
  );
});
