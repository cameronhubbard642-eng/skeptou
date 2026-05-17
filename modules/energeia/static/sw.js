/* energeia service worker — network-first HTML / cache-first assets / network-only API
 *
 * Bump CACHE_NAME to invalidate all caches on next deploy.
 * Strategy map:
 *   /api/*               → network-only  (state-mutating Workers; never cache)
 *   navigations + *.html → network-first (always get the latest deployed UI;
 *                          fall back to cache only when offline)
 *   other same-origin    → cache-first   (CSS, fonts, icons)
 *   cross-origin         → browser default (Google Fonts CDN etc.)
 */

'use strict';

const CACHE_NAME = 'energeia-v11';

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

  /* HTML (page navigations and *.html) must be network-first so a new deploy
     of index.html shows up immediately — cache-first here meant deploys were
     invisible until CACHE_NAME was bumped. Other assets stay cache-first. */
  const isHtml = event.request.mode === 'navigate' ||
                 url.pathname === '/' ||
                 url.pathname.endsWith('.html');
  event.respondWith(isHtml ? networkFirst(event.request) : cacheFirst(event.request));
});

async function networkFirst(request) {
  try {
    const response = await fetch(request);
    if (response.ok && request.method === 'GET') {
      const cache = await caches.open(CACHE_NAME);
      cache.put(request, response.clone());
    }
    return response;
  } catch (_) {
    const cached = await caches.match(request) ||
                   await caches.match('/index.html') ||
                   await caches.match('/');
    if (cached) return cached;
    return new Response('Offline — resource not in cache.', {
      status: 503,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' }
    });
  }
}

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
