/* HSK Parcel Tracker - service worker
   Makes the app installable and usable offline.
   - app shell: cache-first (fast, works offline)
   - tracking_data.json: network-first (always fresh, falls back to cache)
   - cross-origin requests (ads, courier sites): left untouched
*/
const CACHE = "hsk-tracker-v3";
const SHELL = ["./", "./index.html", "./manifest.webmanifest", "./icon-192.png", "./icon-512.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
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
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // never touch cross-origin

  // Data file: always try the network first so statuses stay fresh.
  if (url.pathname.endsWith("tracking_data.json")) {
    e.respondWith(
      fetch(req).then((r) => {
        const cp = r.clone();
        caches.open(CACHE).then((c) => c.put(req, cp));
        return r;
      }).catch(() => caches.match(req))
    );
    return;
  }

  // Navigations: network-first, fall back to cached shell offline.
  if (req.mode === "navigate") {
    e.respondWith(
      fetch(req).then((r) => {
        const cp = r.clone();
        caches.open(CACHE).then((c) => c.put(req, cp));
        return r;
      }).catch(() => caches.match("./index.html"))
    );
    return;
  }

  // Everything else same-origin: cache-first.
  e.respondWith(
    caches.match(req).then((hit) =>
      hit || fetch(req).then((r) => {
        const cp = r.clone();
        caches.open(CACHE).then((c) => c.put(req, cp));
        return r;
      })
    )
  );
});
