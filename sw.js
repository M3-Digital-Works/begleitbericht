/* Service Worker: hält die App offline verfügbar.
 * Strategie "stale-while-revalidate": es wird immer sofort aus dem Cache geliefert
 * und im Hintergrund aktualisiert – Änderungen erscheinen beim nächsten Öffnen. */
const CACHE = "begleitbericht-v1";
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
      const cached = await cache.match(req, { ignoreSearch: true });
      const network = fetch(req)
        .then((res) => { if (res && res.ok) cache.put(req, res.clone()); return res; })
        .catch(() => null);
      if (cached) { e.waitUntil(network); return cached; }
      return (await network) || (req.mode === "navigate" ? cache.match("index.html") : Response.error());
    })
  );
});
