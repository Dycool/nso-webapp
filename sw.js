/* NSO WebApp runtime cache.
 * API/auth/GameWebService traffic is intentionally never cached here.
 */
const STATIC_CACHE = 'nso-static-v8';
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
    try {
        const cache = await caches.open(cacheName);
        const keys = await cache.keys();
        const excess = keys.length - maxEntries;
        if (excess > 0) await Promise.all(keys.slice(0, excess).map(key => cache.delete(key)));
    } catch (_) {}
}

async function cacheFirst(request, cacheName) {
    const cache = await caches.open(cacheName);
    const hit = await cache.match(request);
    if (hit) return hit;
    try {
        const response = await fetch(request);
        if (response && (response.ok || response.type === 'opaque')) {
            await cache.put(request, response.clone()).catch(() => {});
            if (cacheName === IMAGE_CACHE) void trimCache(IMAGE_CACHE, MAX_IMAGE_ENTRIES);
            if (cacheName === STATIC_CACHE) void trimCache(STATIC_CACHE, MAX_STATIC_ENTRIES);
        }
        return response;
    } catch (err) {
        if (request.destination === 'image') {
            return new Response('', { status: 408, statusText: 'Image Fetch Failed' });
        }
        throw err;
    }
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
        return new Response('/* Offline fallback */', {
            status: 503,
            statusText: 'Service Unavailable',
            headers: { 'Content-Type': 'application/javascript; charset=utf-8' }
        });
    }
}

async function handleNavigation(request) {
    try {
        const networkResponse = await fetch(request);
        if (networkResponse && (networkResponse.ok || networkResponse.type === 'opaque')) {
            const cache = await caches.open(STATIC_CACHE);
            cache.put(request, networkResponse.clone()).catch(() => {});
        }
        return networkResponse;
    } catch (err) {
        const cached = await caches.match(request) ||
                       await caches.match('./index.html') ||
                       await caches.match('index.html') ||
                       await caches.match('/nso-webapp/index.html');
        if (cached) return cached;
        return new Response('Network error and page is not cached offline.', {
            status: 503,
            statusText: 'Service Unavailable',
            headers: { 'Content-Type': 'text/plain; charset=utf-8' }
        });
    }
}

self.addEventListener('fetch', (event) => {
    const request = event.request;
    if (request.method !== 'GET') return;
    if (!request.url.startsWith('http')) return;

    const url = new URL(request.url);

    // Never cache Cloudflare/Nintendo/nxapi API calls or proxied game-service pages.
    if (
        url.hostname.includes('workers.dev') ||
        url.pathname.includes('/api/nso/') ||
        url.pathname.includes('/proxy') ||
        url.hostname.includes('nintendo.net') ||
        url.hostname.includes('fancy.org.uk')
    ) {
        return;
    }

    if (request.mode === 'navigate' || request.destination === 'document') {
        // HTML stays network-first with guaranteed Response fallback on network failure
        event.respondWith(handleNavigation(request));
        return;
    }

    if (request.destination === 'image') {
        event.respondWith(cacheFirst(request, IMAGE_CACHE));
        return;
    }

    if (url.origin === self.location.origin && request.destination === 'script') {
        // JavaScript must observe deployments immediately.
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
