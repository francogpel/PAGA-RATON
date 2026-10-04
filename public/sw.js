// ═══════════════════════════════════════════════════════════════════════════════
//  SERVICE WORKER — lo que hace que Pagá Ratón se pueda instalar como app.
//
//  Estrategia:
//  - La página (navegación): primero la red, así cada deploy se ve al toque;
//    si no hay conexión, la última copia guardada.
//  - Imágenes y archivos propios: se sirven del caché y se actualizan atrás.
//  - /api/ y /__/ (datos de salas, pagos y login) NUNCA se guardan: tienen que
//    ser siempre los del momento.
//
//  Al cambiar algo de este archivo, subir VERSION para que se renueve el caché.
// ═══════════════════════════════════════════════════════════════════════════════
const VERSION = "paga-raton-v1";
const BASE = [
  "/",
  "/paga-raton-logo.jpeg",
  "/icon-192.png",
  "/favicon-32.png",
  "/mp-logo.png",
  "/mp-logo-badge.png",
  "/infinity-solutions.png",
];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(BASE)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", e => {
  e.waitUntil(
    caches.keys()
      .then(claves => Promise.all(claves.filter(k => k !== VERSION).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;                 // Firebase, Mercado Pago, fuentes
  if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/__/")) return;

  if (req.mode === "navigate") {
    e.respondWith(
      fetch(req)
        .then(res => {
          const copia = res.clone();
          caches.open(VERSION).then(c => c.put("/", copia));
          return res;
        })
        .catch(() => caches.match("/", { ignoreSearch: true }))
    );
    return;
  }

  e.respondWith(
    caches.match(req).then(enCache => {
      const deRed = fetch(req)
        .then(res => {
          if (res.ok) { const copia = res.clone(); caches.open(VERSION).then(c => c.put(req, copia)); }
          return res;
        })
        .catch(() => enCache);
      return enCache || deRed;
    })
  );
});
