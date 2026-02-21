// ── OctaneIDE Service Worker ──────────────────────────────────
// Caches all static assets for full offline use.
// Strategy:
//   - App shell (HTML, JS, CSS, fonts, Monaco, xterm) → Cache First
//   - browsercc wasm binaries (jsDelivr) → Cache First after first fetch
//   - WASI shim (esm.sh) → Cache First after first fetch
//   - Everything else → Cache First with network fallback

const CACHE_VERSION = 'octaneide-v3';
const CACHE_STATIC  = CACHE_VERSION + '-static';
const CACHE_LARGE   = CACHE_VERSION + '-large';  // clang.wasm / lld.wasm / sysroot.tar

// Core app shell — precached on install
const PRECACHE_URLS = [
  '/',
  '/index.html',
  '/manifest.json',
  '/css/main.css',
  '/js/state.js',
  '/js/persist.js',
  '/js/filetree.js',
  '/js/editor.js',
  '/js/terminal.js',
  '/js/preview.js',
  '/js/compiler.js',
  '/js/settings.js',
  '/js/git.js',
  '/js/main.js',
  '/vendor/xterm/xterm.js',
  '/vendor/xterm/xterm-addon-fit.js',
  '/vendor/xterm/xterm.css',
  '/vendor/fonts/fonts.css',
  '/vendor/fonts/jetbrains-mono-400.woff2',
  '/vendor/fonts/jetbrains-mono-600.woff2',
  '/vendor/fonts/outfit-700.woff2',
  '/vendor/fonts/outfit-900.woff2',
  '/vendor/monaco/loader.js',
  '/vendor/monaco/editor/editor.main.js',
  '/vendor/monaco/editor/editor.main.css',
  '/vendor/monaco/editor/editor.main.nls.js',
  '/vendor/monaco/base/worker/workerMain.js',
];

// ── Install: precache app shell ──
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_STATIC).then(cache =>
      Promise.allSettled(
        PRECACHE_URLS.map(url =>
          cache.add(url).catch(e => console.warn('[SW] Failed to precache:', url, e.message))
        )
      )
    ).then(() => self.skipWaiting())
  );
});

// ── Activate: clean up old caches ──
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(k => k.startsWith('octaneide-') && k !== CACHE_STATIC && k !== CACHE_LARGE)
          .map(k => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

// ── Fetch: routing strategy ──
self.addEventListener('fetch', event => {
  const { request } = event;
  const url = new URL(request.url);

  if (request.method !== 'GET') return;

  // browsercc files from jsDelivr → cache first (large, immutable at pinned version)
  // These are clang.wasm (~30MB), lld.wasm (~20MB), sysroot.tar (~15MB), stdc++.h.pch
  if (url.hostname === 'cdn.jsdelivr.net') {
    event.respondWith(cacheFirst(request, CACHE_LARGE));
    return;
  }

  // WASI shim from esm.sh → cache first
  if (url.hostname === 'esm.sh') {
    event.respondWith(cacheFirst(request, CACHE_LARGE));
    return;
  }

  // All other cross-origin → pass through (don't intercept)
  if (url.hostname !== self.location.hostname) return;

  // Monaco workers → network first (they have their own loader logic)
  if (url.pathname.includes('/vendor/monaco/')) {
    event.respondWith(networkFirst(request, CACHE_STATIC));
    return;
  }

  // Everything else on our origin → cache first
  event.respondWith(cacheFirst(request, CACHE_STATIC));
});

// ── Strategies ──

async function cacheFirst(request, cacheName) {
  const cache  = await caches.open(cacheName);
  const cached = await cache.match(request);
  if (cached) return cached;
  try {
    const response = await fetch(request);
    if (response.ok) cache.put(request, response.clone());
    return response;
  } catch(e) {
    return new Response('Offline — resource not cached: ' + request.url, {
      status: 503, headers: { 'Content-Type': 'text/plain' }
    });
  }
}

async function networkFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  try {
    const response = await fetch(request);
    if (response.ok) cache.put(request, response.clone());
    return response;
  } catch(e) {
    const cached = await cache.match(request);
    if (cached) return cached;
    return new Response('Offline — resource not cached: ' + request.url, {
      status: 503, headers: { 'Content-Type': 'text/plain' }
    });
  }
}
