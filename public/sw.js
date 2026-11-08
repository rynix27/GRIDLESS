/*
 * Offline app shell. Caches the static UI so GridLess opens instantly and
 * stays usable (restored conversation, reference topics once cached) even
 * when the page is loaded with no connectivity. API calls are never cached:
 * live answers must come from the live ladder. Note: the GridLess server
 * must still be reachable for answers — this makes the UI resilient, it does
 * not replace the server. Service workers need localhost or HTTPS.
 */
const CACHE = "gridless-shell-v2";
const SHELL = ["/", "/index.html", "/style.css", "/app.js", "/manifest.webmanifest", "/icon.svg"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin || url.pathname.startsWith("/api/")) return;
  // network-first so updates ship immediately; cache is the offline fallback
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
        }
        return res;
      })
      .catch(() => caches.match(e.request).then((hit) => hit || caches.match("/index.html")))
  );
});
