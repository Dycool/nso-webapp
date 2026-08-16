/* NSO WebApp runtime cache.
 * API/auth/GameWebService traffic is intentionally never cached here.
 */
const STATIC_CACHE = 'nso-static-v3';
const IMAGE_CACHE = 'nso-images-v1';
const MAX_IMAGE_ENTRIES = 300;
const MAX_STATIC_ENTRIES = 80;

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => {
    event.waitUntil((async () => {
        const keep = new Set([STATIC_CACHE, IMAGE_CACHE]);
        const names = await caches.keys();
        await Promise.all(names.filter(name => name.startsWith('nso-') && !keep.has(name)).map(name => caches.delete(name)));
        await self.clients.claim();
    })());
});

async function trimCache(cacheName, maxEntries) {
    const cache = await caches.open(cacheName);
    const keys = await cache.keys();
    const excess = keys.length - maxEntries;
    if (excess > 0) await Promise.all(keys.slice(0, excess).map(key => cache.delete(key)));
}

async function cacheFirst(request, cacheName) {
    const cache = await caches.open(cacheName);
    const hit = await cache.match(request);
    if (hit) return hit;
    const response = await fetch(request);
    if (response && (response.ok || response.type === 'opaque')) {
        await cache.put(request, response.clone()).catch(() => {});
        if (cacheName === IMAGE_CACHE) void trimCache(IMAGE_CACHE, MAX_IMAGE_ENTRIES);
        if (cacheName === STATIC_CACHE) void trimCache(STATIC_CACHE, MAX_STATIC_ENTRIES);
    }
    return response;
}

async function networkFirst(request, cacheName) {
    const cache = await caches.open(cacheName);
    try {
        const response = await fetch(request);
        if (response && (response.ok || response.type === 'opaque')) {
            await cache.put(request, response.clone()).catch(() => {});
            if (cacheName === STATIC_CACHE) void trimCache(STATIC_CACHE, MAX_STATIC_ENTRIES);
        }
        return response;
    } catch (error) {
        const cached = await cache.match(request);
        if (cached) return cached;
        throw error;
    }
}

self.addEventListener('fetch', (event) => {
    const request = event.request;
    if (request.method !== 'GET') return;
    const url = new URL(request.url);

    // Never cache Cloudflare/Nintendo/nxapi API calls or proxied game-service pages.
    if (url.hostname.includes('workers.dev') || url.pathname.includes('/api/nso/') || url.pathname.includes('/proxy')) return;

    if (request.mode === 'navigate') {
        // HTML stays network-first so deployments are observed immediately.
        event.respondWith(fetch(request).catch(() => caches.match(request)));
        return;
    }

    if (request.destination === 'image') {
        event.respondWith(cacheFirst(request, IMAGE_CACHE));
        return;
    }

    if (url.origin === self.location.origin && request.destination === 'script') {
        // JavaScript must observe deployments immediately. Keeping scripts cache-first
        // caused refactor fixes to remain hidden behind an unchanged query suffix.
        event.respondWith(networkFirst(request, STATIC_CACHE));
        return;
    }

    if (url.origin === self.location.origin && ['style', 'font'].includes(request.destination)) {
        event.respondWith(cacheFirst(request, STATIC_CACHE));
        return;
    }
});

self.addEventListener('message', (event) => {
    if (event.data?.type === 'CLEAR_RUNTIME') {
        event.waitUntil(caches.delete(IMAGE_CACHE));
    }
});
