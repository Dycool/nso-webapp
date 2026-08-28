/**
 * Coral API client, request caching, friends/service loading and game-service hooks.
 * Kept in original execution order while separating this responsibility from the app shell.
 */

// Coral API access and browser-local response caching.
function coralAccessToken() {
    return userSession?.result?.webApiServerCredential?.accessToken ||
        userSession?.webApiServerCredential?.accessToken || userSession?.accessToken || null;
}

const CORAL_DATA_CACHE_PREFIX = 'nso_coral_data_v2:';
const coralRequestFlights = new Map();
// Prefer browser-local reads aggressively for resources whose mutations are either
// controlled by this app (and therefore explicitly invalidate below) or naturally
// low-frequency. Presence/active-event data stays deliberately short-lived.
const CORAL_READ_TTLS = Object.freeze({
    '/v4/User/ShowSelf': 30 * 60_000,
    '/v3/User/Permissions/ShowSelf': 30 * 60_000,
    '/v4/Friend/List': 60_000,
    '/v4/Friend/Show': 5 * 60_000,
    '/v4/User/PlayLog/Show': 30 * 60_000,
    '/v5/Chat/FriendCandidate/List': 5 * 60_000,
    '/v4/FriendRequest/Received/List': 2 * 60_000,
    '/v5/Chat/List': 2 * 60_000,
    '/v5/Chat/Show': 5 * 60_000,
    '/v1/Event/GetActiveEvent': 2 * 60_000,
    '/v5/PushNotification/Settings/List': 30 * 60_000,
    '/v4/GameWebService/List': 12 * 60 * 60_000,
    '/v4/Announcement/List': 15 * 60_000,
    '/v4/Media/List': 5 * 60_000,
    '/v5/Hashtag/List': 60 * 60_000,
    '/v4/NA/User/LoginFactor/Show': 60 * 60_000
});

function stableCacheString(value) {
    if (value === null || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(stableCacheString).join(',')}]`;
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableCacheString(value[key])}`).join(',')}}`;
}

function shortCacheHash(value) {
    let hash = 2166136261;
    const text = String(value || '');
    for (let i = 0; i < text.length; i++) {
        hash ^= text.charCodeAt(i);
        hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(36);
}

function coralCacheAccountKey() {
    const naId = String(userSession?.nsoWebapp?.naId || '');
    return naId ? shortCacheHash(naId) : '';
}

function coralCacheStorageKey(path, requestBody) {
    const account = coralCacheAccountKey();
    if (!account) return null;
    let identityBody = requestBody;
    if (requestBody && typeof requestBody === 'object' && !Array.isArray(requestBody) && Object.prototype.hasOwnProperty.call(requestBody, 'requestId')) {
        identityBody = { ...requestBody };
        delete identityBody.requestId; // transport nonce, not part of the resource identity
    }
    const locale = typeof window.nsoCurrentLocale === 'function' ? window.nsoCurrentLocale() : 'en-GB';
    return `${CORAL_DATA_CACHE_PREFIX}${account}:${shortCacheHash(`${locale}|${path}|${stableCacheString(identityBody)}`)}`;
}

function readCoralDataCache(path, requestBody, ttlMs, allowStaleMs = 0) {
    const key = coralCacheStorageKey(path, requestBody);
    if (!key) return null;
    try {
        const record = JSON.parse(localStorage.getItem(key) || 'null');
        if (!record || !Number.isFinite(Number(record.savedAt))) return null;
        const age = Date.now() - Number(record.savedAt);
        if (age <= ttlMs) return { value: record.value, stale: false, age };
        if (allowStaleMs > 0 && age <= allowStaleMs) return { value: record.value, stale: true, age };
    } catch { }
    return null;
}

function writeCoralDataCache(path, requestBody, value) {
    const key = coralCacheStorageKey(path, requestBody);
    if (!key) return;
    try {
        localStorage.setItem(key, JSON.stringify({ savedAt: Date.now(), path, value }));
    } catch {
        // Quota pressure should never break the live app. Drop the oldest NSO data
        // entries and retry once, leaving browser/static caches untouched.
        try {
            const entries = [];
            for (let i = 0; i < localStorage.length; i++) {
                const k = localStorage.key(i);
                if (!k?.startsWith(CORAL_DATA_CACHE_PREFIX)) continue;
                try { entries.push([k, Number(JSON.parse(localStorage.getItem(k) || '{}').savedAt || 0)]); } catch { }
            }
            entries.sort((a, b) => a[1] - b[1]).slice(0, Math.max(1, Math.ceil(entries.length / 3))).forEach(([k]) => localStorage.removeItem(k));
            localStorage.setItem(key, JSON.stringify({ savedAt: Date.now(), path, value }));
        } catch { }
    }
}

function invalidateCoralDataCache(paths = null) {
    const account = coralCacheAccountKey();
    if (!account) return;
    const prefix = `${CORAL_DATA_CACHE_PREFIX}${account}:`;
    const wanted = paths ? new Set(Array.isArray(paths) ? paths : [paths]) : null;
    try {
        const remove = [];
        for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            if (!key?.startsWith(prefix)) continue;
            if (!wanted) { remove.push(key); continue; }
            try {
                const record = JSON.parse(localStorage.getItem(key) || '{}');
                if (wanted.has(record.path)) remove.push(key);
            } catch { remove.push(key); }
        }
        remove.forEach(key => localStorage.removeItem(key));
    } catch { }
}

function clearAllCoralDataCache() {
    try {
        const remove = [];
        for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            if (key?.startsWith(CORAL_DATA_CACHE_PREFIX)) remove.push(key);
        }
        remove.forEach(key => localStorage.removeItem(key));
    } catch { }
    coralRequestFlights.clear();
}

window.nsoClearCoralDataCache = clearAllCoralDataCache;

function invalidateAfterCoralMutation(path) {
    const groups = {
        '/v4/User/Permissions/UpdateSelf': ['/v3/User/Permissions/ShowSelf'],
        '/v5/PushNotification/Settings/Update': ['/v5/PushNotification/Settings/List'],
        '/v4/Announcement/MarkAsRead': ['/v4/Announcement/List'],
        '/v3/Friend/Favorite/Create': ['/v4/Friend/List', '/v4/Friend/Show'],
        '/v3/Friend/Favorite/Delete': ['/v4/Friend/List', '/v4/Friend/Show'],
        '/v4/Friend/Note/Update': ['/v4/Friend/List', '/v4/Friend/Show'],
        '/v3/Friend/Delete': ['/v4/Friend/List', '/v4/Friend/Show'],
        '/v3/User/Block/Create': ['/v4/Friend/List', '/v5/Chat/FriendCandidate/List'],
        '/v4/FriendRequest/Create': ['/v4/FriendRequest/Received/List', '/v4/Friend/List'],
        '/v3/FriendRequest/Create': ['/v4/FriendRequest/Received/List', '/v4/Friend/List'],
        '/v3/FriendRequest/Delete': ['/v4/FriendRequest/Received/List']
    };
    if (groups[path]) invalidateCoralDataCache(groups[path]);
}

async function legacyCoralRequest(path, requestBody, token, options = {}) {
    const url = `https://api-lp1.znc.srv.nintendo.net${path}`;
    const requestOptions = { signal: options.signal };
    const encrypted = await nxapiEncryptRequest(url, token, JSON.stringify(requestBody), requestOptions);
    const headers = {
        'Content-Type': 'application/octet-stream',
        Accept: 'application/octet-stream,application/json',
        'Accept-Language': typeof window.nsoCurrentLocale === 'function' ? window.nsoCurrentLocale() : 'en-GB',
        Authorization: `Bearer ${token}`,
        'User-Agent': zncaUserAgent(),
        Pragma: 'no-cache',
        'Cache-Control': 'no-cache'
    };
    if (options.platform !== false) headers['X-Platform'] = ZNCA_PLATFORM;
    if (options.productVersion !== false) headers['X-ProductVersion'] = activeZncaVersion();
    const response = await proxyFetch(url, {
        method: 'POST', headers, bodyBase64: encrypted,
        signal: options.signal
    });
    const data = await parseCoralResponse(response, requestOptions);
    return { response, data };
}

// ---------------------------------------------------------------------------
// Coral read micro-batching
// ---------------------------------------------------------------------------
// showAuthenticatedUI starts Friends, GameWebService/List and Media/List in the
// same JavaScript turn, and notification refreshes also fan out several read calls.
// Collapsing those concurrent reads into one incoming Worker request preserves the
// exact existing per-call backend implementation while spending only one request
// from Cloudflare's daily Worker allowance. Keep chunks small because Free Workers
// have a tight CPU budget even though upstream network wait time is not billed CPU.
const CORAL_BATCH_MAX_CALLS = 4;
let coralBatchSequence = 0;
let coralReadBatchQueue = [];
let coralReadBatchScheduled = false;

async function singleCoralTransport({ path, requestBody, token, naId, version, options }) {
    const response = await fetch(`${WORKER_URL}/api/nso/coral/call`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        credentials: 'include',
        signal: options.signal,
        body: JSON.stringify({
            clientId: tokenBrokerClientId(),
            path,
            requestBody,
            coralAccessToken: token,
            naId,
            zncaVersion: version,
            locale: typeof window.nsoCurrentLocale === 'function' ? window.nsoCurrentLocale() : 'en-GB',
            platform: options.platform !== false,
            productVersion: options.productVersion !== false
        })
    });
    observeServiceResponse(response, { provider: 'nintendo-coral', operation: `Coral ${path}` });
    const data = await response.json().catch(() => ({}));
    return { response, data };
}

function coralBatchGroupKey(item) {
    const locale = typeof window.nsoCurrentLocale === 'function' ? window.nsoCurrentLocale() : 'en-GB';
    return `${item.naId}|${item.version}|${shortCacheHash(item.token)}|${locale}`;
}

async function flushCoralReadBatchGroup(items) {
    for (let offset = 0; offset < items.length; offset += CORAL_BATCH_MAX_CALLS) {
        const chunk = items.slice(offset, offset + CORAL_BATCH_MAX_CALLS);
        if (chunk.length < 2) {
            const item = chunk[0];
            if (!item) continue;
            try { item.resolve(await singleCoralTransport(item)); }
            catch (error) { item.reject(error); }
            continue;
        }

        try {
            const first = chunk[0];
            const response = await fetch(`${WORKER_URL}/api/nso/coral/batch`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
                credentials: 'include',
                body: JSON.stringify({
                    clientId: tokenBrokerClientId(),
                    coralAccessToken: first.token,
                    naId: first.naId,
                    zncaVersion: first.version,
                    locale: typeof window.nsoCurrentLocale === 'function' ? window.nsoCurrentLocale() : 'en-GB',
                    calls: chunk.map(item => ({
                        id: item.batchId,
                        path: item.path,
                        requestBody: item.requestBody,
                        platform: item.options.platform !== false,
                        productVersion: item.options.productVersion !== false
                    }))
                })
            });
            observeServiceResponse(response, { provider: response.ok ? 'nintendo-coral' : 'nxapi-znca', operation: `Coral batch (${chunk.length})` });
            const payload = await response.json().catch(() => ({}));
            const results = Array.isArray(payload?.results) ? payload.results : null;

            // Deployment-order / compatibility escape hatch: if an older Worker has
            // not received the batch route yet, use the old one-call endpoint rather
            // than making startup dependent on synchronized frontend/backend deploys.
            if (!results || response.status === 404 || response.status === 405) {
                await Promise.all(chunk.map(async item => {
                    try { item.resolve(await singleCoralTransport(item)); }
                    catch (error) { item.reject(error); }
                }));
                continue;
            }

            const byId = new Map(results.map(result => [String(result?.id ?? ''), result]));
            for (const item of chunk) {
                const result = byId.get(item.batchId);
                if (!result) {
                    item.reject(new Error(`Cloudflare Coral batch omitted ${item.path}.`));
                    continue;
                }
                const headers = new Headers({ 'Content-Type': 'application/json' });
                if (result.retryAfter) headers.set('Retry-After', String(result.retryAfter));
                const synthetic = new Response(JSON.stringify(result.data ?? {}), {
                    status: Number(result.status || 500),
                    headers
                });
                observeServiceResponse(synthetic, {
                    provider: synthetic.ok ? 'nintendo-coral' : 'nxapi-znca',
                    operation: `Coral ${item.path}`
                });
                item.resolve({ response: synthetic, data: result.data ?? {} });
            }
        } catch (batchError) {
            // A batching-layer failure is never allowed to break a working Coral
            // feature. Fall back to the original request path; the extra requests
            // occur only when the optimization itself is unavailable.
            await Promise.all(chunk.map(async item => {
                try { item.resolve(await singleCoralTransport(item)); }
                catch (error) { item.reject(error || batchError); }
            }));
        }
    }
}

async function flushCoralReadBatchQueue() {
    coralReadBatchScheduled = false;
    const queued = coralReadBatchQueue;
    coralReadBatchQueue = [];
    if (!queued.length) return;

    const groups = new Map();
    for (const item of queued) {
        const key = coralBatchGroupKey(item);
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(item);
    }
    await Promise.all(Array.from(groups.values()).map(flushCoralReadBatchGroup));
}

function queuedCoralReadTransport(item) {
    return new Promise((resolve, reject) => {
        coralReadBatchQueue.push({
            ...item,
            batchId: `b${++coralBatchSequence}`,
            resolve,
            reject
        });
        if (!coralReadBatchScheduled) {
            coralReadBatchScheduled = true;
            queueMicrotask(() => { void flushCoralReadBatchQueue(); });
        }
    });
}

function coralTransport(item, batchEligible) {
    if (batchEligible && !item.options.signal &&  item.options.batch !== false) {
        return queuedCoralReadTransport(item);
    }
    return singleCoralTransport(item);
}

async function coralCall(path, parameter = {}, options = {}) {
    const token = coralAccessToken();
    if (!token) throw new Error('No Coral access token is available. Sign in again.');
    const naId = String(userSession?.nsoWebapp?.naId || '');
    if (!naId) throw new Error('Nintendo Account context is unavailable. Sign in again.');

    const requestBody = options.body || { parameter };
    const ttlMs = options.cache === false ? 0 : Math.max(0, Number(options.cacheTtlMs ?? CORAL_READ_TTLS[path] ?? 0));
    const staleIfErrorMs = ttlMs ? Math.max(ttlMs, Number(options.staleIfErrorMs ?? Math.min(24 * 60 * 60_000, ttlMs * 12))) : 0;
    const cacheKey = coralCacheStorageKey(path, requestBody);
    if (ttlMs && options.forceRefresh !== true) {
        const cached = readCoralDataCache(path, requestBody, ttlMs);
        if (cached) return cached.value;
    }

    const flightKey = cacheKey || `${path}|${stableCacheString(requestBody)}`;
    if (coralRequestFlights.has(flightKey)) return coralRequestFlights.get(flightKey);

    const promise = (async () => {
        try {
            throwIfAborted(options.signal);
            const version = bindNxapiCoralContext(naId, activeZncaVersion());
            let { response, data } = await coralTransport({
                path,
                requestBody,
                token,
                naId,
                version,
                options
            }, ttlMs > 0);
            let effectiveResponse = response;
            if (response.status === 401 && data?.error === 'broker_session_missing') {
                // A restored session can outlive the broker session cookie. Preserve
                // functionality by falling back to the older three-hop relay only in
                // this edge case; normal sessions stay on the one-invocation route.
                const legacy = await legacyCoralRequest(path, requestBody, token, options);
                effectiveResponse = legacy.response;
                data = legacy.data;
            }
            if (effectiveResponse.status === 401 && data?.error === 'nxapi_invalid_token') clearNxapiAuthSession();
            if (data?.error === 'nxapi_version_context_mismatch' || nxapiVersionContextMismatch(effectiveResponse.status, data)) {
                // Do not automatically retry an nxapi HTTP response. Clearing only
                // the memory token lets the next explicit user action acquire a
                // fresh token for the session's pinned app version.
                clearNxapiAuthSession();
            }
            if (effectiveResponse.status === 429) {
                const until = parseRetryAfter(effectiveResponse.headers.get('Retry-After')) || (Date.now() + 60000);
                setRateLimitUntil('encrypt', until);
            }
            if (!effectiveResponse.ok || !data || data.status !== 0 || !Object.prototype.hasOwnProperty.call(data, 'result')) {
                const status = data?.status ?? effectiveResponse.status;
                const message = data?.errorMessage || data?.error_description || data?.error || `Nintendo API request failed (${status}).`;
                const error = new Error(message);
                error.status = effectiveResponse.status;
                error.coralStatus = data?.status;
                error.code = data?.error || data?.nso_error || 'coral_request_failed';
                throw error;
            }
            const result = data.result;
            if (ttlMs) writeCoralDataCache(path, requestBody, result);
            else invalidateAfterCoralMutation(path);
            return result;
        } catch (error) {
            if (ttlMs && options.allowStaleOnError !== false) {
                const stale = readCoralDataCache(path, requestBody, 0, staleIfErrorMs);
                if (stale) return stale.value;
            }
            throw error;
        }
    })();

    coralRequestFlights.set(flightKey, promise);
    try { return await promise; }
    finally { if (coralRequestFlights.get(flightKey) === promise) coralRequestFlights.delete(flightKey); }
}

// Load Live Friends with shared per-account caching/single-flight. A fresh cache hit
// renders without contacting Cloudflare; presence data is refreshed after one minute.
async function loadLiveFriendsList(options = {}) {
    if (!userSession) return;
    const friendContainers = ['homeFriendsGrid', 'friendsGrid'].map(id => document.getElementById(id)).filter(Boolean);
    const cached = readCoralDataCache('/v4/Friend/List', { parameter: {} }, CORAL_READ_TTLS['/v4/Friend/List']);
    if (!cached) {
        friendContainers.forEach(container => {
            container.innerHTML = Array.from({ length: 6 }, () => '<div class="friend-loading-tile"><i></i><span></span></div>').join('');
        });
    }
    try {
        const result = await coralCall('/v4/Friend/List', {}, {
            platform: true,
            productVersion: true,
            forceRefresh: options.forceRefresh === true
        });
        const friends = Array.isArray(result) ? result : (result?.friends || []);
        renderFriendsList(friends);
    } catch (e) {
        friendContainers.forEach(container => {
            console.error('[Friends] load failed', e);
            container.innerHTML = `<p class="service-status error">${escapeHtml(trKey('Common_Loading_Failed'))}</p>`;
        });
    }
}

async function loadGameServices() {
    const container = document.getElementById('gameServicesCatalog');
    if (!container || !userSession) return;
    container.innerHTML = Array.from({ length: 5 }, () => '<div class="service-loading-tile"></div>').join('');
    try {
        // The v4 catalog is the one Coral call that has no `parameter` object;
        // Android sends a top-level requestId and receives the service array directly.
        const result = await coralCall('/v4/GameWebService/List', {}, {
            body: { requestId: crypto.randomUUID() }
        });
        const services = Array.isArray(result) ? result : (result.webServices || []);
        if (!services.length) {
            container.innerHTML = `<p class="service-status">${escapeHtml(tr('No game web services are available for this account.'))}</p>`;
            return;
        }
        container.innerHTML = '';
        services.forEach(service => {
            const card = document.createElement('article');
            card.className = 'service-launch-card';
            card.dataset.serviceName = service.name || 'Game service';
            card.dataset.serviceId = String(service.id || '');
            const image = document.createElement('img');
            image.src = service.imageUri || '';
            image.alt = service.name || 'Game service';
            image.addEventListener('error', () => card.classList.add('missing-service-image'));
            const copy = document.createElement('div');
            const title = document.createElement('strong');
            title.textContent = service.name;
            const description = document.createElement('p');
            description.textContent = tr('Available through Nintendo Switch Online');
            copy.append(title, description);
            const button = document.createElement('button');
            button.type = 'button';
            button.textContent = tr('Connect');
            button.setAttribute('aria-label', `${tr('Connect')}: ${service.name}`);
            button.addEventListener('click', () => window.webServiceManager?.launchService(service, button));
            card.append(image, copy, button);
            container.appendChild(card);
        });
    } catch (e) {
        console.error('[GameServices] catalog load failed', e); container.innerHTML = `<p class="service-status error">${escapeHtml(trKey('Common_Loading_Failed'))}</p>`;
    }
}

document.getElementById('closeInAppGameWebviewBtn')?.addEventListener('click', () => {
    window.webServiceManager?.closeActiveService();
});

document.getElementById('reloadInAppGameWebviewBtn')?.addEventListener('click', () => {
    window.webServiceManager?.reloadActiveService();
});

let selectedMediaSet = new Set();
