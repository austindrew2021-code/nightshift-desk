/* NIGHTSHIFT — needed so Chrome on Galaxy offers Install app, not a shortcut. */
const SCOPE = self.registration.scope;

self.addEventListener("install", (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("fetch", (event) => {
  if (event.request.mode !== "navigate") return;
  event.respondWith(
    fetch(event.request).catch(() => fetch(SCOPE).catch(() => new Response("offline", { status: 503 }))),
  );
});
