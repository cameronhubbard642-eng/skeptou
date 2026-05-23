/* phronesis service worker — cache-first / network-first / network-only routing
 *
 * Bump CACHE_NAME to invalidate all caches on next deploy.
 * Strategy map:
 *   /api/* (GET)    → network-first (D1 reads; cached, served stale offline)
 *   /api/* (writes) → network-only  (state-mutating Workers; never cache)
 *   /data/*         → network-first (data files; cache fallback for offline)
 *   same-origin *   → cache-first   (app shell, CSS, fonts, icons)
 *   cross-origin    → browser default (Google Fonts CDN etc.)
 */

'use strict';

const CACHE_NAME = 'phronesis-v12';

/* Pre-cache the minimal app shell on install */
const APP_SHELL = [
  '/',
  '/index.html',
  '/skeptou.css',
  '/design-tokens.css',
  '/manifest.json',
  '/icons/icon-192.svg',
  '/icons/icon-512.svg',
];

/* ── Install: pre-cache app shell, then skip waiting ── */
self.addEventListener('install', function(event) {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(function(cache) { return cache.addAll(APP_SHELL); })
      .then(function() { return self.skipWaiting(); })
  );
});

/* ── Activate: delete stale caches, claim all clients ── */
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

/* ── Fetch: route by path ── */
self.addEventListener('fetch', function(event) {
  const url = new URL(event.request.url);

  /* Cross-origin (Google Fonts, CDN assets) — pass through */
  if (url.origin !== self.location.origin) return;

  /* API: GET reads → network-first (fresh data, cache fallback offline);
   * POST/PATCH/DELETE mutations → network-only, never intercept */
  if (url.pathname.startsWith('/api/')) {
    if (event.request.method === 'GET') {
      event.respondWith(networkFirst(event.request));
    }
    return;
  }

  /* Data files — network-first, cache fallback */
  if (url.pathname.startsWith('/data/')) {
    event.respondWith(networkFirst(event.request));
    return;
  }

  /* HTML navigations + CSS — network-first so UI and stylesheet deploys
     show immediately (cache-first here meant deploys were invisible until
     CACHE_NAME was bumped). Fonts and icons stay cache-first. */
  if (event.request.mode === 'navigate' ||
      url.pathname === '/' ||
      url.pathname.endsWith('.html') ||
      url.pathname.endsWith('.css')) {
    event.respondWith(networkFirst(event.request));
    return;
  }

  /* Fonts, icons, other static assets — cache-first */
  event.respondWith(cacheFirst(event.request));
});

/* ── Strategies ── */

async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;

  try {
    const response = await fetch(request);
    if (response.ok && request.method === 'GET') {
      const cache = await caches.open(CACHE_NAME);
      cache.put(request, response.clone()); /* intentionally not awaited */
    }
    return response;
  } catch (_) {
    /* Navigation offline fallback: serve cached shell */
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

async function networkFirst(request) {
  try {
    /* redirect:'manual' converts an auth-middleware 302 into an opaqueredirect
     * instead of a CORS-blocked cross-origin follow, preventing the SW from
     * silently swallowing auth failures and returning stale/empty JSON. */
    const response = await fetch(new Request(request, { redirect: 'manual' }));

    /* opaqueredirect (or status 0) = auth 302 caught before CORS could fail.
     * Return a plain 401 so loadLiveData() surfaces a "session expired" toast. */
    if (response.type === 'opaqueredirect' || response.status === 0) {
      return new Response('{"error":"Session required — reload to log in"}', {
        status: 401,
        headers: { 'Content-Type': 'application/json; charset=utf-8' }
      });
    }

    if (response.ok && request.method === 'GET') {
      const cache = await caches.open(CACHE_NAME);
      cache.put(request, response.clone()); /* intentionally not awaited */
    }
    return response;
  } catch (_) {
    const cached = await caches.match(request);
    if (cached) return cached;
    /* Genuine network failure (offline) — return 503 so callers know */
    return new Response('{"error":"Offline — data not cached"}', {
      status: 503,
      headers: { 'Content-Type': 'application/json; charset=utf-8' }
    });
  }
}
