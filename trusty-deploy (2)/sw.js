/**
 * TrustMate Fleet — Service Worker v2
 *
 * Strategies:
 *  - App shell (index.html + supabase.min.js + offline.html): pre-cached on install
 *  - Navigation requests: serve cached shell → network → offline.html
 *  - Static CDN assets (fonts, scripts): cache-first, populate on first fetch
 *  - All Supabase / API calls: network-only, never cached
 *  - Push notifications: delivered here, shown as native notifications
 */

const CACHE_NAME = 'tm-shell-v2';

const SHELL_FILES = [
  '/',
  '/index.html',
  '/offline.html',
  '/js/supabase.min.js',
  '/manifest.json',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
];

const NETWORK_ONLY = [
  'supabase.co',
  'resend.com',
  'googletagmanager.com',
  'google-analytics.com',
  '/netlify/functions/',
];

// ── Install ───────────────────────────────────────────────────────────────────
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(SHELL_FILES))
  );
  self.skipWaiting();
});

// ── Activate: prune old caches ────────────────────────────────────────────────
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// ── Fetch ─────────────────────────────────────────────────────────────────────
self.addEventListener('fetch', event => {
  const { request } = event;
  const url = request.url;

  if (request.method !== 'GET') return;

  // API / auth — always go to network, no SW interception
  if (NETWORK_ONLY.some(p => url.includes(p))) return;

  // Navigation (page loads) — shell first, then network, then offline page
  if (request.mode === 'navigate') {
    event.respondWith(
      caches.match('/index.html')
        .then(cached => {
          if (cached) return cached;
          return fetch(request).catch(() => caches.match('/offline.html'));
        })
    );
    return;
  }

  // Everything else — cache-first, populate cache on miss
  event.respondWith(
    caches.match(request).then(cached => {
      if (cached) return cached;
      return fetch(request).then(response => {
        if (response && (response.status === 200 || response.type === 'opaque')) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(c => c.put(request, clone));
        }
        return response;
      }).catch(() => {
        // For non-navigation offline failures just let it fail naturally
        return new Response('', { status: 503 });
      });
    })
  );
});

// ── Push notifications ────────────────────────────────────────────────────────
self.addEventListener('push', event => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (e) {}

  const title   = data.title   || 'TrustMate Fleet';
  const body    = data.body    || 'You have a new notification.';
  const icon    = data.icon    || '/icons/icon-192.png';
  const badge   = data.badge   || '/icons/icon-192.png';
  const url     = data.url     || '/';
  const tag     = data.tag     || 'tm-default';

  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      icon,
      badge,
      tag,
      data: { url },
      vibrate: [150, 50, 150],
      requireInteraction: data.requireInteraction || false,
    })
  );
});

// ── Notification click: focus or open the app ─────────────────────────────────
self.addEventListener('notificationclick', event => {
  event.notification.close();
  const targetUrl = (event.notification.data && event.notification.data.url) || '/';

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clients => {
      const existing = clients.find(c => c.url.includes(self.location.origin));
      if (existing) {
        existing.focus();
        existing.postMessage({ type: 'PUSH_NAV', url: targetUrl });
      } else {
        self.clients.openWindow(targetUrl);
      }
    })
  );
});
