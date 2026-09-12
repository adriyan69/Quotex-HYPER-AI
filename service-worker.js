const CACHE_NAME = 'market-ai-shell-v9';

const SHELL_ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './css/styles.css',
  './js/app.js',
  './js/core/MarketDataProvider.js',
  './js/core/MockDataProvider.js',
  './js/core/ReplayDataProvider.js',
  './js/core/CandleNormalizer.js',
  './js/core/sampleData.js',
  './js/indicators/ema.js',
  './js/indicators/rsi.js',
  './js/indicators/macd.js',
  './js/indicators/atr.js',
  './js/indicators/bollinger.js',
  './js/indicators/roc.js',
  './js/indicators/index.js',
  './js/structure/swingPoints.js',
  './js/structure/marketStructure.js',
  './js/signal/priceAction.js',
  './js/signal/scoringEngine.js',
  './js/engine/RealtimeEngine.js',
  './js/alerts/alertManager.js',
  './js/history/historyStore.js',
  './js/backtest/BacktestEngine.js',
  './js/worker/engine.worker.js',
  './js/worker/backtest.worker.js',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-192.png',
  './icons/icon-maskable-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Cache-first for the app shell, network fallback for anything else.
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  event.respondWith(
    caches.match(event.request).then((cached) => {
      return (
        cached ||
        fetch(event.request).catch(() => cached)
      );
    })
  );
});

// Phase 7: focus (or open) the app when a signal notification is tapped.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if ('focus' in client) return client.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow('./');
    })
  );
});
