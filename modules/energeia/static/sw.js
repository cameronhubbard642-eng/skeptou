/* energeia service worker — cache-first / network-first / network-only routing
 *
 * Bump CACHE_NAME to invalidate all caches on next deploy.
 * Strategy map:
 *   /api/*          → network-only  (state-mutating Workers; never cache)
 *   same-origin *   → cache-first   (app shell, CSS, fonts, icons)
 *   cross-origin    → browser default (Google Fonts CDN etc.)
 */

'use strict';

const CACHE_NAME = 'energeia-v9';

const APP_SHELL = [
  '/',
  '/index.html',
  '/skeptou.css',
  '/design-tokens.css',
  '/manifest.json',
  '/icons/icon-192.svg',
  '/icons/icon-512.svg',
];

self.addEventListener('install', function(event) {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(function(cache) { return cache.addAll(APP_SHELL); })
      .then(function() { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function(event) {
  event.waitUntil(
    caches.keys()
      .then(function(keys) {
        return Promise.all(
          keys.filter(function(k) { return k !== CACHE_NAME; })
              .map(function(k) { return caches.delete(k); })
        );
      })
      .then(function() { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function(event) {
  const url = new URL(event.request.url);

  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) return;

  event.respondWith(cacheFirst(event.request));
});

async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;

  try {
    const response = await fetch(request);
    if (response.ok && request.method === 'GET') {
      const cache = await caches.open(CACHE_NAME);
      cache.put(request, response.clone());
    }
    return response;
  } catch (_) {
    if (request.mode === 'navigate') {
      const shell = await caches.match('/') || await caches.match('/index.html');
      if (shell) return shell;
    }
    return new Response('Offline — resource not in cache.', {
      status: 503,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' }
    });
  }
}
