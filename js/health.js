/**
 * Dependency diagnostics, circuit-breaker UI and application bootstrap hooks.
 * Kept in original execution order while separating this responsibility from the app shell.
 */

// ---------------------------------------------------------------------------
// Worker control-plane transport optimization
// ---------------------------------------------------------------------------
// The webapp runs on GitHub Pages while the API is workers.dev. `application/json`
// makes every cross-origin POST non-simple, so browsers may spend a second Worker
// invocation on OPTIONS before the real request. Cloudflare's hardened gateway
// already validates the exact Origin for every /api/nso control-plane request, and
// Request.json() parses the body independently of the declared media type. Send the
// exact same JSON string as CORS-safelisted text/plain so normal POSTs need no
// preflight at all.
//
// Remembered resume has one additional optimization: include the existing broker
// clientId in /remember/resume. A new backend can then perform /cache/session/start
// internally and return `brokerSession` in the same response. Old backends ignore the
// optional body, so deployment order remains safe.
(function installWorkerSimplePostTransport() {
    if (window.__nsoWorkerSimplePostTransportInstalled) return;
    window.__nsoWorkerSimplePostTransportInstalled = true;
    const nativeFetch = window.fetch.bind(window);
    const workerOrigin = new URL(WORKER_URL).origin;

    function installOneShotBrokerResume(snapshot) {
        if (!snapshot || typeof snapshot !== 'object') return;
        const original = window.startTokenBrokerSession;
        if (typeof original !== 'function' || original.__nsoCombinedResumeOneShot) return;

        let restoreTimer = null;
        const restore = () => {
            if (window.startTokenBrokerSession === wrapped) {
                window.startTokenBrokerSession = original;
                try { startTokenBrokerSession = original; } catch { }
            }
            if (restoreTimer) clearTimeout(restoreTimer);
            restoreTimer = null;
        };
        const wrapped = async function startTokenBrokerSessionFromCombinedResume() {
            restore();
            try { window.nsoHydrateBrokerGameTokens?.(snapshot.gws); } catch { }
            return snapshot;
        };
        wrapped.__nsoCombinedResumeOneShot = true;
        window.startTokenBrokerSession = wrapped;
        try { startTokenBrokerSession = wrapped; } catch { }
        restoreTimer = setTimeout(restore, 30_000);
    }


    function mapPathToExtensionMessage(pathname, body) {
        if (pathname === '/api/nso/remember/resume') return { type: 'NSO_RESUME_SESSION', ...(body || {}) };
        if (pathname === '/api/nso/remember/save') return { type: 'NSO_REMEMBER_SAVE', ...(body || {}) };
        if (pathname === '/api/nso/remember/forget') return { type: 'NSO_REMEMBER_FORGET', ...(body || {}) };
        if (pathname === '/api/nso/cache/session/start') return { type: 'NSO_SESSION_START', ...(body || {}) };
        if (pathname === '/api/nso/cache/session/release') return { type: 'NSO_SESSION_RELEASE', ...(body || {}) };
        if (pathname === '/api/nso/cache/coral/get-or-create') return { type: 'NSO_CORAL_SESSION', ...(body || {}) };
        if (pathname === '/api/nso/service/token') return { type: 'NSO_GAME_TOKEN', ...(body || {}) };
        if (pathname === '/api/nso/service/token/cache') return { type: 'NSO_GAME_TOKEN_CACHE', ...(body || {}) };
        if (pathname === '/api/nso/coral/call') return { type: 'NSO_CORAL_CALL', ...(body || {}) };
        if (pathname === '/api/nso/coral/batch') return { type: 'NSO_CORAL_BATCH', ...(body || {}) };
        if (pathname === '/api/nso/service/session/create') return { type: 'NSO_GAME_SESSION_CREATE', ...(body || {}) };
        if (pathname === '/api/nso/auth/logout') return { type: 'NSO_LOGOUT', ...(body || {}) };
        if (pathname === '/api/nso/proxy') return { type: 'NSO_PROXY', ...(body || {}) };

        const renewMatch = pathname.match(/^\/api\/nso\/service\/session\/([a-zA-Z0-9-]+)\/renew-token$/);
        if (renewMatch) return { type: 'NSO_GAME_TOKEN_RENEW', sessionId: renewMatch[1], ...(body || {}) };

        const closeMatch = pathname.match(/^\/api\/nso\/service\/session\/([a-zA-Z0-9-]+)\/close$/);
        if (closeMatch) return { type: 'NSO_GAME_SESSION_CLOSE', sessionId: closeMatch[1], ...(body || {}) };

        return null;
    }

    async function dispatchExtensionFetch(msg, pathname) {
        try {
            const extRes = await window.nsoDispatchExtensionMessage(msg.type, msg);
            const status = extRes.status || (extRes.ok ? 200 : 400);
            const headers = new Headers({
                'Content-Type': 'application/json',
                'Cache-Control': 'no-store',
                'X-NSO-Active-Backend': 'extension'
            });
            if (pathname === '/api/nso/remember/resume' && extRes.data?.brokerSession) {
                installOneShotBrokerResume(extRes.data.brokerSession);
            }
            const bodyContent = typeof extRes.text === 'string' ? extRes.text : JSON.stringify(extRes.data !== undefined ? extRes.data : extRes);
            return new Response(bodyContent, { status, headers });
        } catch (extErr) {
            console.warn('[NSO WebApp] Extension request failed, attempting Cloudflare fallback:', extErr?.message);
            throw extErr;
        }
    }

    window.fetch = function nsoEfficientFetch(input, init) {
        try {
            // Current control-plane code uses URL/string inputs. Leave Request-object
            // calls untouched so we never clone/consume an arbitrary request body.
            if (!(input instanceof Request)) {
                const target = new URL(String(input), location.href);
                const method = String(init?.method || 'GET').toUpperCase();
                if (target.origin === workerOrigin && target.pathname.startsWith('/api/nso/') && method === 'POST') {
                    if (window.nsoBackendMode === 'extension' && typeof window.nsoDispatchExtensionMessage === 'function') {
                        let parsedBody = {};
                        try {
                            if (typeof init?.body === 'string') parsedBody = JSON.parse(init.body);
                        } catch (_) {}
                        const extMsg = mapPathToExtensionMessage(target.pathname, parsedBody);
                        if (extMsg) {
                            return dispatchExtensionFetch(extMsg, target.pathname).catch(() => nativeFetch(input, init));
                        }
                    }
                    const headers = new Headers(init?.headers || {});
                    let nextInit = { ...(init || {}), headers };
                    let combinedResume = false;

                    if (target.pathname === '/api/nso/remember/resume' && nextInit.body == null && typeof tokenBrokerClientId === 'function') {
                        const clientId = String(tokenBrokerClientId() || '');
                        if (/^[A-Za-z0-9_-]{8,128}$/.test(clientId)) {
                            headers.set('Content-Type', 'text/plain;charset=UTF-8');
                            nextInit.body = JSON.stringify({ clientId });
                            combinedResume = true;
                        }
                    } else {
                        const contentType = String(headers.get('Content-Type') || '');
                        if (/^application\/json(?:\s*;|$)/i.test(contentType)) {
                            headers.set('Content-Type', 'text/plain;charset=UTF-8');
                        }
                    }

                    const requestPromise = nativeFetch(input, nextInit);
                    if (!combinedResume) return requestPromise;

                    return requestPromise.then(async response => {
                        if (!response.ok) return response;
                        try {
                            const data = await response.clone().json();
                            if (data?.brokerSession) installOneShotBrokerResume(data.brokerSession);
                        } catch { }
                        return response;
                    });
                }
            }
        } catch { }
        return nativeFetch(input, init);
    };
})();

// Service Health / Diagnostics
// ---------------------------------------------------------------------------
// Diagnostics are background-only. A failed dependency request starts one
// single-flight health pass; the UI is only notified after that pass confirms a
// real service problem. Healthy/transient results stay silent.
const SERVICE_DIAGNOSTICS_COOLDOWN_MS = 60_000;
const SERVICE_CIRCUIT_DEFAULT_MS = 30_000;
const SERVICE_HEALTH_TOAST_MS = 3_000;
let serviceDiagnosticsInFlight = null;
let lastServiceDiagnosticsAt = 0;
let lastServiceDiagnostics = null;
let serviceIssueCircuit = { provider: null, until: 0, reason: '', status: 0 };
let serviceHealthToastTimer = null;

function serviceProviderForTarget(targetUrl) {
    try {
        const host = new URL(targetUrl).hostname.toLowerCase();
        if (host === 'nxapi-znca-api.fancy.org.uk') return 'nxapi-znca';
        if (host === 'nxapi-auth.fancy.org.uk' || host === 'fancy.org.uk') return 'nxapi-auth';
        if (host === 'api-lp1.znc.srv.nintendo.net') return 'nintendo-coral';
        if (host.endsWith('.nintendo.net') || host.endsWith('.srv.nintendo.net')) return 'nintendo';
    } catch (e) { }
    return 'unknown';
}

function isNxapiZncaProvider(provider) {
    return provider === 'nxapi-znca' || String(provider || '').startsWith('nxapi-f') ||
        String(provider || '').startsWith('nxapi-encrypt') || String(provider || '').startsWith('nxapi-decrypt');
}

function currentServiceCircuit(provider) {
    if (!provider || serviceIssueCircuit.provider !== provider || serviceIssueCircuit.until <= Date.now()) return null;
    return serviceIssueCircuit;
}

function openServiceCircuit(provider, reason, status = 503, durationMs = SERVICE_CIRCUIT_DEFAULT_MS) {
    if (!provider) return;
    serviceIssueCircuit = {
        provider,
        reason: String(reason || 'Service temporarily unavailable.'),
        status: Number(status || 503),
        until: Date.now() + Math.max(5_000, Number(durationMs || SERVICE_CIRCUIT_DEFAULT_MS))
    };
}

function clearServiceCircuit(provider = null) {
    if (provider && serviceIssueCircuit.provider !== provider) return;
    serviceIssueCircuit = { provider: null, until: 0, reason: '', status: 0 };
}

function serviceHealthSummary(diag = lastServiceDiagnostics) {
    if (!diag) return null;
    const cloudflare = diag.cloudflare || diag.worker || {};
    const nxapi = diag.nxapi || {};
    const znca = nxapi.znca || {};
    const config = nxapi.config || {};
    return {
        cloudflareStatus: cloudflare.status || 'unknown',
        zncaStatus: znca.status || 'not_checked',
        zncaHttpStatus: Number(znca.httpStatus || 0),
        zncaDescription: znca.error_description || znca.description || znca.error || '',
        requestedWorkerCount: Number.isFinite(Number(config.requestedWorkerCount)) ? Number(config.requestedWorkerCount) : null,
        traceId: znca.traceId || znca.debugId || ''
    };
}

function hideServiceHealthWarning() {
    if (serviceHealthToastTimer) {
        clearTimeout(serviceHealthToastTimer);
        serviceHealthToastTimer = null;
    }
    document.getElementById('serviceHealthBanner')?.classList.add('hidden');
}

function showServiceHealthWarning(titleText, message, detailText = '', severity = 'is-warning') {
    const banner = document.getElementById('serviceHealthBanner');
    const title = document.getElementById('serviceHealthTitle');
    const text = document.getElementById('serviceHealthText');
    const details = document.getElementById('serviceHealthDetails');
    if (!banner) return;

    if (serviceHealthToastTimer) clearTimeout(serviceHealthToastTimer);
    banner.classList.remove('hidden', 'is-ok', 'is-warning', 'is-error');
    banner.classList.add(severity);
    if (title) title.textContent = titleText;
    if (text) text.textContent = message;
    if (details) details.textContent = detailText;
    serviceHealthToastTimer = setTimeout(() => {
        serviceHealthToastTimer = null;
        banner.classList.add('hidden');
    }, SERVICE_HEALTH_TOAST_MS);
}

function updateServiceHealthBanner() {
    const summary = serviceHealthSummary();
    const hasRecentDiagnostic = lastServiceDiagnostics && (Date.now() - lastServiceDiagnosticsAt < 120_000);
    if (!summary || !hasRecentDiagnostic) {
        hideServiceHealthWarning();
        return;
    }

    const bits = [];
    if (summary.cloudflareStatus) bits.push(`Cloudflare: ${summary.cloudflareStatus}`);
    if (summary.zncaStatus) bits.push(`nxapi ZNCA: ${summary.zncaStatus}`);
    if (summary.requestedWorkerCount !== null) bits.push(`matching workers: ${summary.requestedWorkerCount}`);
    if (summary.zncaHttpStatus) bits.push(`HTTP ${summary.zncaHttpStatus}`);
    if (summary.traceId) bits.push(`trace ${summary.traceId}`);

    if (summary.cloudflareStatus !== 'ok') {
        showServiceHealthWarning(
            tr('Cloudflare backend issue'),
            tr('The web app backend is temporarily unavailable. Some features may not work.'),
            bits.join(' · '),
            'is-error'
        );
        return;
    }

    if (['unavailable', 'error', 'degraded'].includes(summary.zncaStatus)) {
        showServiceHealthWarning(
            tr('nxapi temporarily unavailable'),
            tr('nxapi is temporarily unavailable. Please try again later.'),
            bits.join(' · '),
            'is-error'
        );
        return;
    }

    // A one-off 500 followed by healthy diagnostics is a normal transient. Do not
    // put a diagnostics window in front of the user for something that recovered.
    hideServiceHealthWarning();
}

function syntheticCircuitResponse(circuit) {
    return new Response(JSON.stringify({
        error: 'service_circuit_open',
        nso_error: 'service_circuit_open',
        error_description: `${circuit.reason} A recent health check confirmed the dependency is unavailable.`,
        provider: circuit.provider,
        retry_after_ms: Math.max(0, circuit.until - Date.now())
    }), {
        status: 503,
        headers: {
            'Content-Type': 'application/json',
            'Cache-Control': 'no-store',
            'X-NSO-Proxy-Error': 'service_circuit_open',
            'X-NSO-Upstream-Provider': circuit.provider,
            'Retry-After': String(Math.max(1, Math.ceil((circuit.until - Date.now()) / 1000)))
        }
    });
}

function failureLooksLikeWorkerUnavailable(status, data = {}) {
    const text = `${data?.error || ''} ${data?.nso_error || ''} ${data?.error_description || ''}`.toLowerCase();
    return [500, 502, 503, 504].includes(Number(status)) ||
        text.includes('no matching workers') || text.includes('service unavailable') || text.includes('worker unavailable');
}

async function runServiceDiagnostics(options = {}) {
    const force = options.force === true;
    if (serviceDiagnosticsInFlight) return serviceDiagnosticsInFlight;
    if (!force && lastServiceDiagnostics && Date.now() - lastServiceDiagnosticsAt < SERVICE_DIAGNOSTICS_COOLDOWN_MS) {
        return lastServiceDiagnostics;
    }

    serviceDiagnosticsInFlight = (async () => {
        const result = {
            timestamp: new Date().toISOString(),
            reason: options.reason || 'automatic',
            cloudflare: { status: 'unknown' },
            nxapi: { auth: { status: 'not_checked' }, znca: { status: 'not_checked' }, config: { status: 'not_checked' } }
        };

        try {
            // One Worker invocation is enough: /api/nso/diagnostics already checks
            // the Worker and nxapi. The older two-step /health?deep=1 + diagnostics
            // path doubled Worker traffic and Durable Object round-trips.
            const validNxapiToken = nxapiAuthSession?.accessToken && nxapiAuthSession.expiresAt > Date.now() + 5_000
                ? nxapiAuthSession.accessToken : null;
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), 7_000);
            let response;
            try {
                response = await fetch(`${WORKER_URL}/api/nso/diagnostics`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
                    credentials: 'include',
                    cache: 'no-store',
                    signal: controller.signal,
                    body: JSON.stringify({
                        nxapiAccessToken: validNxapiToken || undefined,
                        zncaVersion: activeZncaVersion(),
                        deepCloudflare: options.deepCloudflare === true
                    })
                });
            } finally {
                clearTimeout(timer);
            }
            const diag = await response.json().catch(() => ({}));
            result.status = diag?.status || (response.ok ? 'ok' : 'degraded');
            if (diag?.cloudflare) result.cloudflare = diag.cloudflare;
            else result.cloudflare = { status: response.ok ? 'ok' : 'unavailable', httpStatus: response.status };
            if (diag?.nxapi) result.nxapi = diag.nxapi;
        } catch (error) {
            result.status = 'unavailable';
            result.cloudflare = {
                status: 'unavailable',
                error: error?.name === 'AbortError' ? 'diagnostic_timeout' : 'diagnostic_request_failed'
            };
        }

        lastServiceDiagnostics = result;
        lastServiceDiagnosticsAt = Date.now();

        const summary = serviceHealthSummary(result);
        if (summary?.cloudflareStatus === 'ok' && summary?.zncaStatus === 'ok') {
            clearServiceCircuit('nxapi-znca');
        } else if (summary?.cloudflareStatus === 'ok' && ['unavailable', 'error', 'degraded'].includes(summary?.zncaStatus)) {
            openServiceCircuit('nxapi-znca', summary.zncaDescription || 'nxapi ZNCA health check is not healthy.', summary.zncaHttpStatus || 503, 30_000);
        } else if (summary?.cloudflareStatus && summary.cloudflareStatus !== 'ok') {
            openServiceCircuit('cloudflare', 'The nso-webapp backend health check is not healthy.', Number(result.cloudflare?.httpStatus || 503), 15_000);
        }

        updateServiceHealthBanner();
        return result;
    })().finally(() => {
        serviceDiagnosticsInFlight = null;
    });

    return serviceDiagnosticsInFlight;
}

window.nsoRunServiceDiagnostics = runServiceDiagnostics;

function observeServiceResponse(response, context = {}) {
    if (!response || response.ok) return response;
    const provider = response.headers?.get?.('X-NSO-Upstream-Provider') || context.provider || 'cloudflare';
    const proxyError = response.headers?.get?.('X-NSO-Proxy-Error') || '';
    const status = Number(response.status || 0);

    // Clone immediately; the caller remains free to consume the original body.
    const clone = response.clone();
    void (async () => {
        let data = {};
        try { data = await clone.json(); } catch (e) { }
        const errorCode = String(data?.nso_error || data?.error || proxyError || '').toLowerCase();
        const description = data?.error_description || data?.error_message || data?.error || `HTTP ${status}`;
        const looksUnavailable = failureLooksLikeWorkerUnavailable(status, data);
        const isZnca = isNxapiZncaProvider(provider) || context.provider === 'nxapi-znca' || errorCode.startsWith('nxapi_');
        const isUnsupportedVersion = status === 406 && (errorCode.includes('unsupported_version') || String(description).toLowerCase().includes('unsupported version'));

        // A 406 is already a definitive nxapi response and /config worker_count is
        // documented as monitoring/debug data, not client selection data. Avoid an
        // extra diagnostic request for it. For real 5xx/unavailable failures, use a
        // single diagnostics request (with a one-minute cooldown).
        if (isZnca && looksUnavailable && !isUnsupportedVersion && [500, 502, 503, 504].includes(status)) {
            void runServiceDiagnostics({
                reason: context.operation || `nxapi HTTP ${status}`,
                deepCloudflare: false
            });
        } else if (provider === 'cloudflare' && [500, 502, 503, 504].includes(status)) {
            void runServiceDiagnostics({
                reason: context.operation || `Cloudflare HTTP ${status}`,
                deepCloudflare: true
            });
        }
    })();
    return response;
}

window.nsoObserveServiceResponse = observeServiceResponse;

function nxapiVersionContextMismatch(status, dataOrText = '') {
    const text = typeof dataOrText === 'string'
        ? dataOrText
        : `${dataOrText?.error_description || ''} ${dataOrText?.error_message || ''} ${dataOrText?.error || ''}`;
    return Number(status) === 400 && /X-znca-Version.*does not match token/i.test(String(text));
}

function serviceFailureMessage(data, response, fallback) {
    const status = Number(response?.status || 0);
    const code = String(data?.nso_error || data?.error || response?.headers?.get?.('X-NSO-Proxy-Error') || '');
    const description = data?.error_description || data?.error_message || data?.error || fallback;
    if (code === 'service_circuit_open') return String(description);
    if ([500, 502, 503, 504].includes(status) || code === 'nxapi_service_unavailable' || code === 'nxapi_upstream_error') {
        return `${description || fallback} (HTTP ${status}).`;
    }
    return String(description || fallback);
}

document.addEventListener('DOMContentLoaded', () => {
    initNavigation();
    initServicesNav();
    initAuthGate();
    updateRateLimitBanner();
    updateServiceHealthBanner();
    checkStartupSession();
});

if ('serviceWorker' in navigator && location.protocol === 'https:') {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('./sw.js?v=20260816-v1', { scope: './' }).catch(() => { });
    }, { once: true });
}

