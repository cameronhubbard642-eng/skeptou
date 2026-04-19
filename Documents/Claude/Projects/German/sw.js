// Service Worker for Philosophische Übersetzungswerkstatt
// Cache-first for assets, network-first for API calls and manifests

const CACHE_NAME = 'werkstatt-v9';

const PRECACHE_URLS = [
  'uebersetzungswerkstatt.html',
  'manifest.json',
  'German-Icon-I.jpeg',
  'German-Icon-II.jpeg',
  'German-Icon-III.jpeg',
  'German-Icon-IV.jpeg',
  'German-Icon-V.jpeg'
];

// Install: precache core assets
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(PRECACHE_URLS))
  );
});

// Activate: clean old caches
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// Fetch strategy
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // Network-first for API calls and manifests
  if (url.pathname.endsWith('manifest.json') ||
      url.hostname !== location.hostname ||
      event.request.method !== 'GET') {
    event.respondWith(
      fetch(event.request).then(response => {
        if (response.ok) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        }
        return response;
      }).catch(() => caches.match(event.request))
    );
    return;
  }

  // Cache-first for local assets
  event.respondWith(
    caches.match(event.request).then(cached => {
      if (cached) return cached;
      return fetch(event.request).then(response => {
        if (response.ok) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        }
        return response;
      });
    })
  );
});

// Listen for SKIP_WAITING message from update banner
self.addEventListener('message', event => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});
