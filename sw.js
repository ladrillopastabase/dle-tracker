/* Service worker: la app funciona sin conexión y se puede instalar.
   Estrategia "stale-while-revalidate" para los archivos propios: se sirve lo
   guardado al instante y se actualiza en segundo plano para la próxima visita.
   Lo externo (catálogo en GitHub, iconos de otras webs) no pasa por aquí. */
const CACHE = "dle-tracker-v3";
const SHELL = [
  "./",
  "index.html",
  "manifest.webmanifest",
  "static/css/styles.css",
  "static/js/logic.js",
  "static/js/store.js",
  "static/js/catalog.js",
  "static/js/mascot.js",
  "static/js/app.js",
  "static/vendor/chart.umd.min.js",
  "static/vendor/fonts/jetbrains-mono-latin-400-normal.woff2",
  "static/vendor/fonts/jetbrains-mono-latin-700-normal.woff2",
  "static/icons/icon-192.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET" || new URL(request.url).origin !== self.location.origin) return;
  event.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const cached = await cache.match(request, { ignoreSearch: true });
      const network = fetch(request)
        .then((response) => {
          if (response.ok) cache.put(request, response.clone());
          return response;
        })
        .catch(() => cached);
      return cached || network;
    }),
  );
});
