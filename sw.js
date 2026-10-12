// Service worker minimo. Enquanto o app ainda esta em ajuste frequente, ele
// NAO guarda nada em cache (sem fetch handler = navegador busca tudo normal,
// sempre na rede) — so existe pra manter o app instalavel no celular.
// Quando o app estiver estavel, um cache offline de verdade volta aqui.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.map((k) => caches.delete(k))))
  );
  self.clients.claim();
});
