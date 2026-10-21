/**
 * TrustMate Fleet — Service Worker
 * Strategy: cache-first for static shell, network-first for API calls.
 * App shell (index.html + fonts) is pre-cached on install so the app
 * launches instantly even on a slow connection.
 */

const CACHE_NAME = 'tm-shell-v1';

// Files that make up the app shell — cached on install
const SHELL_FILES = [
  '/',
  '/index.html',
];

// Prefixes that should NEVER be served from cache (API, auth, edge functions)
const NETWORK_ONLY_PREFIXES = [
  'supabase.co',
  'resend.com',
  'googleapis.com',
  'googletagmanager.com',
  '/netlify/functions/',
];

// ── Install: pre-cache the app shell ─────────────────────────────────────────
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(SHELL_FILES))
  );
  self.skipWaiting();
});

// ── Activate: delete old caches ───────────────────────────────────────────────
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// ── Fetch: network-first for API, cache-first for shell ───────────────────────
self.addEventListener('fetch', event => {
  const { request } = event;
  const url = request.url;

  // Only handle GET requests
  if (request.method !== 'GET') return;

  // Let API/auth calls go straight to network, no caching
  if (NETWORK_ONLY_PREFIXES.some(prefix => url.includes(prefix))) return;

  // Navigation requests (page loads): serve cached shell, fall back to network
  if (request.mode === 'navigate') {
    event.respondWith(
      caches.match('/index.html').then(cached => cached || fetch(request))
    );
    return;
  }

  // Static assets (fonts, icons, scripts loaded from CDN): cache-first
  event.respondWith(
    caches.match(request).then(cached => {
      if (cached) return cached;
      return fetch(request).then(response => {
        // Cache successful opaque or same-origin responses for static assets
        if (response && (response.status === 200 || response.type === 'opaque')) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(request, clone));
        }
        return response;
      });
    })
  );
});
