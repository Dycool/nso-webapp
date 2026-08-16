/**
 * Nintendo Switch Online WebApp.
 * Uses nxapi's public ZNCA API for Coral attestation and request encryption.
 * The Worker provides CORS relay, reverse-proxied WebView hosting, and encrypted Remember Me storage.
 */

const WORKER_URL = 'https://nso-worker-backend.diogoenes0.workers.dev';
const DEFAULT_NXAPI_ZNCA_API_URL = 'https://nxapi-znca-api.fancy.org.uk/api/znca';
const DEFAULT_NXAPI_AUTH_CLIENT_ID = 'JGN1is1KSmRMOL-g4qmgZA';
const NXAPI_ZNCA_API_URL = (window.NXAPI_ZNCA_API_URL ||
    localStorage.getItem('nxapi_znca_api_url') ||
    DEFAULT_NXAPI_ZNCA_API_URL).replace(/\/$/, '');
const NXAPI_AUTH_CLIENT_ID = window.NXAPI_AUTH_CLIENT_ID || DEFAULT_NXAPI_AUTH_CLIENT_ID;
const NXAPI_AUTH_SCOPE = 'ca:gf ca:er ca:dr';
const NXAPI_CLIENT_VERSION = 'w8zSLBsxR7rVoGJA';

// Exact Coral Header Constants
const ZNCA_PLATFORM = 'Android';
const ZNCA_PLATFORM_VERSION = '12';
let ZNCA_VERSION = '3.4.1';

function zncaUserAgent() {
    return `com.nintendo.znca/${ZNCA_VERSION}(${ZNCA_PLATFORM}/${ZNCA_PLATFORM_VERSION})`;
}

// ---------------------------------------------------------------------------
// Stage-Specific Typed Diagnostic Errors
// ---------------------------------------------------------------------------

class AuthStageError extends Error {
    constructor(stage, message, originalError = null, status = null) {
        super(message);
        this.name = 'AuthStageError';
        this.stage = stage;
        this.originalError = originalError;
        this.status = status;
    }
}

// ---------------------------------------------------------------------------
// Memory-Only App & nxapi Authentication State
// ---------------------------------------------------------------------------

let userSession = null;
let nxapiAuthSession = {
    accessToken: null,
    refreshToken: null,
    expiresAt: 0
};
let nxapiTokenPromise = null;
let nxapiAuthMetadata = null;
let activeMediaItem = null;
let currentFriends = [];
let currentMedia = [];

// Rate Limit & Retry-After Utilities
const NXAPI_RATE_LIMIT_SCOPES = ['auth', 'f1', 'f2', 'encrypt', 'decrypt'];
const NXAPI_RATE_LIMIT_LABELS = {
    auth: 'nxapi authentication',
    f1: 'Coral authentication (method 1)',
    f2: 'Game service authentication (method 2)',
    encrypt: 'request encryption',
    decrypt: 'response decryption'
};

function parseRetryAfter(headerValue) {
    if (!headerValue) return null;
    const trimmed = String(headerValue).trim();
    const seconds = Number(trimmed);
    if (!isNaN(seconds) && seconds >= 0) return Date.now() + seconds * 1000;
    const parsedDate = Date.parse(trimmed);
    return !isNaN(parsedDate) && parsedDate > Date.now() ? parsedDate : null;
}

function getRateLimitUntil(scope = null) {
    try {
        // Remove the legacy global limiter. A method-2 429 must never block
        // unrelated nxapi-auth, encryption, or method-1 requests.
        localStorage.removeItem('nxapi_rate_limit_until');
        const read = (name) => {
            const num = Number(localStorage.getItem(`nxapi_rate_limit_until_${name}`));
            return !isNaN(num) && num > Date.now() ? num : 0;
        };
        if (scope) return read(scope);
        return Math.max(0, ...NXAPI_RATE_LIMIT_SCOPES.map(read));
    } catch (e) {
        return 0;
    }
}

function setRateLimitUntil(scope, timestamp) {
    try {
        const key = `nxapi_rate_limit_until_${scope}`;
        if (timestamp > Date.now()) localStorage.setItem(key, String(timestamp));
        else localStorage.removeItem(key);
        updateRateLimitBanner();
    } catch (e) {}
}

let rateLimitTimer = null;
function updateRateLimitBanner() {
    const banner = document.getElementById('rateLimitBanner');
    const bannerText = document.getElementById('rateLimitBannerText');
    const active = NXAPI_RATE_LIMIT_SCOPES
        .map(scope => ({ scope, until: getRateLimitUntil(scope) }))
        .filter(item => item.until > Date.now())
        .sort((a, b) => a.until - b.until);

    if (rateLimitTimer) {
        clearTimeout(rateLimitTimer);
        rateLimitTimer = null;
    }

    if (active.length) {
        if (banner) banner.classList.remove('hidden');
        const first = active[0];
        const remainingSec = Math.ceil((first.until - Date.now()) / 1000);
        const timeStr = new Date(first.until).toLocaleTimeString();
        if (bannerText) {
            bannerText.textContent = `${NXAPI_RATE_LIMIT_LABELS[first.scope] || first.scope} is temporarily rate-limited. Retry after ${timeStr} (${remainingSec}s remaining).`;
        }
        rateLimitTimer = setTimeout(updateRateLimitBanner, 1000);
    } else {
        if (banner) banner.classList.add('hidden');
    }
}


// ---------------------------------------------------------------------------
// Service Health / Diagnostics
// ---------------------------------------------------------------------------
// Diagnostics are background-only. A failed dependency request starts one
// single-flight health pass; the UI is only notified after that pass confirms a
// real service problem. Healthy/transient results stay silent.
const SERVICE_DIAGNOSTICS_COOLDOWN_MS = 15_000;
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
    } catch (e) {}
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
            'Cloudflare backend issue',
            'The nso-webapp backend health check is not healthy. Some features may be temporarily unavailable.',
            bits.join(' · '),
            'is-error'
        );
        return;
    }

    if (['unavailable', 'error', 'degraded'].includes(summary.zncaStatus)) {
        showServiceHealthWarning(
            'nxapi temporarily unavailable',
            summary.zncaDescription || 'nxapi ZNCA reported a service or worker problem. The app will try again when appropriate.',
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
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), 5_000);
            let healthResp;
            try {
                healthResp = await fetch(`${WORKER_URL}/health?deep=1`, {
                    headers: { Accept: 'application/json' },
                    cache: 'no-store',
                    signal: controller.signal
                });
            } finally {
                clearTimeout(timer);
            }
            const health = await healthResp.json().catch(() => ({}));
            result.cloudflare = {
                status: health?.status || (healthResp.ok ? 'ok' : 'error'),
                httpStatus: healthResp.status,
                checks: health?.checks || {},
                timestamp: health?.timestamp || null
            };

            if (healthResp.ok) {
                const validNxapiToken = nxapiAuthSession?.accessToken && nxapiAuthSession.expiresAt > Date.now() + 5_000
                    ? nxapiAuthSession.accessToken : null;
                const diagController = new AbortController();
                const diagTimer = setTimeout(() => diagController.abort(), 7_000);
                let diagResp;
                try {
                    diagResp = await fetch(`${WORKER_URL}/api/nso/diagnostics`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
                        credentials: 'include',
                        cache: 'no-store',
                        signal: diagController.signal,
                        body: JSON.stringify({
                            nxapiAccessToken: validNxapiToken || undefined,
                            zncaVersion: ZNCA_VERSION
                        })
                    });
                } finally {
                    clearTimeout(diagTimer);
                }
                const diag = await diagResp.json().catch(() => ({}));
                if (diag?.cloudflare) result.cloudflare = diag.cloudflare;
                if (diag?.nxapi) result.nxapi = diag.nxapi;
                result.status = diag?.status || (diagResp.ok ? 'ok' : 'degraded');
            } else {
                result.status = 'unavailable';
            }
        } catch (error) {
            result.status = 'unavailable';
            result.cloudflare = {
                status: 'unavailable',
                error: error?.name === 'AbortError' ? 'health_timeout' : 'health_request_failed'
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
        try { data = await clone.json(); } catch (e) {}
        const errorCode = String(data?.nso_error || data?.error || proxyError || '').toLowerCase();
        const description = data?.error_description || data?.error_message || data?.error || `HTTP ${status}`;
        const looksUnavailable = failureLooksLikeWorkerUnavailable(status, data);
        const isZnca = isNxapiZncaProvider(provider) || context.provider === 'nxapi-znca' || errorCode.startsWith('nxapi_');
        const isUnsupportedVersion = status === 406 && (errorCode.includes('unsupported_version') || String(description).toLowerCase().includes('unsupported version'));

        // Do not show anything while diagnostics are running and do not open a
        // circuit on the raw response alone. A transient 500 should be allowed to
        // recover. The circuit/warning is only created if diagnostics confirms an
        // unhealthy dependency.
        if (isZnca && (looksUnavailable || isUnsupportedVersion)) {
            void runServiceDiagnostics({
                reason: context.operation || (isUnsupportedVersion ? 'nxapi version mismatch' : `nxapi HTTP ${status}`),
                force: isUnsupportedVersion
            });
        } else if (provider === 'cloudflare' && [500, 502, 503, 504].includes(status)) {
            void runServiceDiagnostics({ reason: context.operation || `Cloudflare HTTP ${status}` });
        }
    })();
    return response;
}

window.nsoObserveServiceResponse = observeServiceResponse;

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

function checkStartupSession() {
    // Coral credentials are never kept in persistent browser storage unless the
    // user has explicitly opted into Remember Me. Migrate one legacy localStorage
    // session only when that opt-in flag exists, then remove the persistent copy.
    let stored = sessionStorage.getItem('nso_user_session');
    const legacy = localStorage.getItem('nso_user_session');
    if (!stored && legacy && localStorage.getItem('nso_has_remembered_account') === 'true') {
        stored = legacy;
        try { sessionStorage.setItem('nso_user_session', legacy); } catch (e) {}
    }
    if (legacy) localStorage.removeItem('nso_user_session');

    if (stored) {
        try {
            const parsed = JSON.parse(stored);
            const expiresAt = Number(parsed?.nsoWebapp?.coralExpiresAt || 0);
            const token = parsed?.result?.webApiServerCredential?.accessToken;

            if (token && expiresAt > Date.now() + 60000) {
                userSession = parsed;
                showAuthenticatedUI(parsed);
                return;
            }
        } catch (e) {
            console.warn('[Startup] Invalid cached session structure:', e);
        }
        sessionStorage.removeItem('nso_user_session');
        userSession = null;
    }

    showLoginGate();
    updateRememberedUI();
}

function updateRememberedUI() {
    const rememberedFlag = localStorage.getItem('nso_has_remembered_account') === 'true';
    const rememberedExpiresAt = Number(localStorage.getItem('nso_remember_expires_at') || 0);
    // Pre-v14 remembered grants did not store their server expiry locally. Keep those
    // visible and let the already-30-day-capped server record decide at resume time.
    const hasRemembered = rememberedFlag && (rememberedExpiresAt <= 0 || rememberedExpiresAt > Date.now());

    // New grants carry their absolute server expiry, so the UI can expire them locally
    // without even offering a stale resume action.
    if (rememberedFlag && rememberedExpiresAt > 0 && rememberedExpiresAt <= Date.now()) {
        localStorage.removeItem('nso_has_remembered_account');
        localStorage.removeItem('nso_remember_expires_at');
    }

    const section = document.getElementById('rememberedAccountSection');
    const profileForgetBtn = document.getElementById('profileForgetRememberedBtn');

    if (section) {
        if (hasRemembered) {
            section.classList.remove('hidden');
        } else {
            section.classList.add('hidden');
        }
    }
    if (profileForgetBtn) {
        if (hasRemembered) {
            profileForgetBtn.classList.remove('hidden');
        } else {
            profileForgetBtn.classList.add('hidden');
        }
    }
}


let tokenBrokerHeartbeatTimer = null;

function tokenBrokerClientId() {
    const key = 'nso_token_broker_client_id';
    let value = null;
    try { value = sessionStorage.getItem(key); } catch (e) {}
    if (!value) {
        value = crypto.randomUUID().replace(/-/g, '_');
        try { sessionStorage.setItem(key, value); } catch (e) {}
    }
    return value;
}

window.nsoTokenBrokerClientId = tokenBrokerClientId;

async function startTokenBrokerSession(nintendoAccessToken) {
    if (!nintendoAccessToken) return null;
    const response = await fetch(`${WORKER_URL}/api/nso/cache/session/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
            nintendoAccessToken,
            clientId: tokenBrokerClientId()
        })
    });
    let data = {};
    try { data = await response.json(); } catch (e) {}
    if (!response.ok) {
        const error = new Error(data?.error_description || data?.error || `Token broker session failed (HTTP ${response.status}).`);
        error.status = response.status;
        throw error;
    }
    return data;
}

function validBrokerCoralSession(entry, expectedNaId) {
    const session = entry?.session || entry;
    const expiresAt = Number(entry?.expiresAt || session?.nsoWebapp?.coralExpiresAt || 0);
    return Boolean(
        session?.result?.webApiServerCredential?.accessToken &&
        expiresAt > Date.now() + 60000 &&
        (!expectedNaId || String(session?.nsoWebapp?.naId || '') === String(expectedNaId))
    );
}

let nxapiLoginWarmPromise = null;

async function warmNxapiForLogin() {
    if (nxapiLoginWarmPromise) return nxapiLoginWarmPromise;
    nxapiLoginWarmPromise = (async () => {
        const accessToken = await getNxapiAccessToken();
        await refreshNxapiConfig();
        return accessToken;
    })();
    try {
        return await nxapiLoginWarmPromise;
    } finally {
        nxapiLoginWarmPromise = null;
    }
}

async function generateCoralViaTokenBroker({ idToken, naId, language, country, birthday }) {
    await prepareNxapi();
    // nxapi authentication/config are warmed as soon as the user explicitly accepts
    // the disclosure, usually while Nintendo sign-in is open in the other tab.
    const nxapiAccessToken = await warmNxapiForLogin();
    const response = await fetch(`${WORKER_URL}/api/nso/cache/coral/get-or-create`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
            clientId: tokenBrokerClientId(),
            idToken,
            nxapiAccessToken,
            naId,
            language,
            country,
            birthday,
            zncaVersion: ZNCA_VERSION
        })
    });
    observeServiceResponse(response, { provider: 'nxapi-znca', operation: 'Coral token broker' });
    let data = {};
    try { data = await response.json(); } catch (e) {}
    if (response.status === 429) {
        const until = parseRetryAfter(response.headers.get('Retry-After')) || (Date.now() + 60000);
        setRateLimitUntil('f1', until);
    }
    if (response.status === 401 && data?.error === 'nxapi_invalid_token') {
        nxapiAuthSession = { accessToken: null, refreshToken: null, expiresAt: 0 };
    }
    if (!response.ok || !validBrokerCoralSession(data?.coral, naId)) {
        const message = serviceFailureMessage(data, response, `Cloudflare token broker could not create Coral session`);
        throw new AuthStageError(
            data?.error === 'nxapi_rate_limited' ? 'NXAPI_F_METHOD_1' : 'CORAL_ACCOUNT_LOGIN',
            message,
            null,
            response.status
        );
    }
    return data.coral.session;
}

function startTokenBrokerHeartbeat() {
    if (tokenBrokerHeartbeatTimer) clearInterval(tokenBrokerHeartbeatTimer);
    const beat = () => {
        if (!userSession) return;
        fetch(`${WORKER_URL}/api/nso/cache/heartbeat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({ clientId: tokenBrokerClientId() })
        }).catch(() => {});
    };
    beat();
    tokenBrokerHeartbeatTimer = setInterval(beat, 45_000);
}

function stopTokenBrokerHeartbeat() {
    if (tokenBrokerHeartbeatTimer) clearInterval(tokenBrokerHeartbeatTimer);
    tokenBrokerHeartbeatTimer = null;
}

function releaseTokenBrokerSession(options = {}) {
    stopTokenBrokerHeartbeat();
    const payload = JSON.stringify({ clientId: tokenBrokerClientId() });
    return fetch(`${WORKER_URL}/api/nso/cache/session/release`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: payload,
        keepalive: options.keepalive === true
    }).catch(() => {});
}

window.addEventListener('pagehide', (event) => {
    if (!event.persisted) releaseTokenBrokerSession({ keepalive: true });
});

window.addEventListener('pageshow', () => {
    if (userSession) startTokenBrokerHeartbeat();
});

function nxapiClientId() {
    return NXAPI_AUTH_CLIENT_ID.trim();
}

function hasNxapiConsent() {
    return document.getElementById('nxapiConsentCheckbox')?.checked === true;
}

async function prepareNxapi() {
    if (!hasNxapiConsent()) {
        throw new AuthStageError('NXAPI_AUTH', 'Please accept the nxapi third-party service disclosure before continuing.');
    }
    // Do not put nxapi discovery/config on the critical login path. It is warmed
    // after explicit consent and only awaited if the Coral broker actually misses.
}

function throwIfAborted(signal) {
    if (!signal?.aborted) return;
    throw new DOMException('The operation was aborted.', 'AbortError');
}

async function proxyFetch(targetUrl, options = {}) {
    throwIfAborted(options.signal);
    const provider = serviceProviderForTarget(targetUrl);
    const circuit = currentServiceCircuit(provider);
    if (circuit) return syntheticCircuitResponse(circuit);

    const proxyPayload = {
        targetUrl: targetUrl,
        method: options.method || 'GET',
        headers: options.headers || {}
    };
    if (options.cancelKey) proxyPayload.cancelKey = String(options.cancelKey);
    if (options.bodyBase64) {
        proxyPayload.dataBase64 = options.bodyBase64;
    } else {
        proxyPayload.data = options.body || null;
    }

    try {
        const response = await fetch(`${WORKER_URL}/api/nso/proxy`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(proxyPayload),
            signal: options.signal
        });
        observeServiceResponse(response, {
            provider,
            operation: options.diagnosticOperation || `${provider} ${options.method || 'GET'}`
        });
        return response;
    } catch (error) {
        if (error?.name !== 'AbortError') {
            void runServiceDiagnostics({ reason: `Cloudflare proxy transport failure for ${provider}` });
        }
        throw error;
    }
}

function nxapiUrl(path) {
    return `${NXAPI_ZNCA_API_URL}/${path.replace(/^\//, '')}`;
}

/**
 * Single-flight in-memory nxapi token acquisition adhering strictly to public terms.
 * Never persists nxapi tokens to storage.
 */
async function getNxapiAccessToken(options = {}) {
    throwIfAborted(options.signal);
    const rateLimitUntil = getRateLimitUntil('auth');
    if (rateLimitUntil > Date.now()) {
        const timeStr = new Date(rateLimitUntil).toLocaleTimeString();
        const remainingSec = Math.ceil((rateLimitUntil - Date.now()) / 1000);
        throw new AuthStageError(
            'NXAPI_AUTH',
            `nxapi authentication temporarily rate-limited. Retry after ${timeStr} (${remainingSec}s remaining).`
        );
    }

    // Reuse valid in-memory token (10-second safety margin)
    if (nxapiAuthSession.accessToken && nxapiAuthSession.expiresAt > Date.now() + 10000) {
        return nxapiAuthSession.accessToken;
    }

    // Single-flight deduplication
    if (nxapiTokenPromise) {
        return nxapiTokenPromise;
    }

    nxapiTokenPromise = (async () => {
        const clientId = nxapiClientId();
        if (!clientId) {
            throw new AuthStageError('NXAPI_AUTH', 'Enter an nxapi-auth public client ID before signing in.');
        }

        if (!nxapiAuthMetadata) {
            const apiOrigin = new URL(NXAPI_ZNCA_API_URL).origin;
            const protectedResourceResp = await proxyFetch(`${apiOrigin}/.well-known/oauth-protected-resource`, {
                headers: { Accept: 'application/json' },
                signal: options.signal,
                cancelKey: options.cancelKey
            });
            const protectedResource = await protectedResourceResp.json().catch(() => ({}));
            if (!protectedResourceResp.ok || !protectedResource.authorization_servers?.[0]) {
                throw new AuthStageError('NXAPI_AUTH', protectedResource.error_description || 'Could not discover nxapi authentication metadata.');
            }

            const authorizationServer = new URL(protectedResource.authorization_servers[0]);
            const authorizationMetadataResp = await proxyFetch(
                `${authorizationServer.origin}/.well-known/oauth-authorization-server`,
                {
                    headers: { Accept: 'application/json' },
                    signal: options.signal,
                    cancelKey: options.cancelKey
                }
            );
            nxapiAuthMetadata = await authorizationMetadataResp.json().catch(() => ({}));
            if (!authorizationMetadataResp.ok || !nxapiAuthMetadata.token_endpoint) {
                throw new AuthStageError('NXAPI_AUTH', nxapiAuthMetadata.error_description || 'Could not discover the nxapi token endpoint.');
            }
        }

        const isRefresh = Boolean(nxapiAuthSession.refreshToken);
        const tokenRequest = isRefresh ? {
            grant_type: 'refresh_token',
            client_id: clientId,
            refresh_token: nxapiAuthSession.refreshToken
        } : {
            grant_type: 'client_credentials',
            client_id: clientId,
            scope: NXAPI_AUTH_SCOPE
        };

        const tokenResp = await proxyFetch(nxapiAuthMetadata.token_endpoint, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                Accept: 'application/json'
            },
            body: new URLSearchParams(tokenRequest).toString(),
            signal: options.signal,
            cancelKey: options.cancelKey
        });

        if (tokenResp.status === 429) {
            const retryAfterHeader = tokenResp.headers.get('Retry-After');
            const until = parseRetryAfter(retryAfterHeader) || (Date.now() + 60000);
            setRateLimitUntil('auth', until);
            const timeStr = new Date(until).toLocaleTimeString();
            throw new AuthStageError('NXAPI_AUTH', `nxapi authentication rate-limited (HTTP 429). Retry after ${timeStr}.`, null, 429);
        }

        let tokenData = {};
        try {
            tokenData = await tokenResp.json();
        } catch (e) {}

        if (!tokenResp.ok || !tokenData.access_token) {
            if (isRefresh) {
                nxapiAuthSession = { accessToken: null, refreshToken: null, expiresAt: 0 };
            }
            const errMsg = tokenData.error_description || tokenData.error || `nxapi authentication failed (HTTP ${tokenResp.status}).`;
            throw new AuthStageError('NXAPI_AUTH', errMsg, null, tokenResp.status);
        }

        nxapiAuthSession = {
            accessToken: tokenData.access_token,
            expiresAt: Date.now() + Math.max(1, Number(tokenData.expires_in || 300)) * 1000,
            refreshToken: tokenData.refresh_token || null
        };

        return nxapiAuthSession.accessToken;
    })();

    try {
        return await nxapiTokenPromise;
    } finally {
        nxapiTokenPromise = null;
    }
}

async function nxapiFetch(path, options = {}) {
    throwIfAborted(options.signal);
    const token = await getNxapiAccessToken({ signal: options.signal, cancelKey: options.cancelKey });
    const response = await proxyFetch(nxapiUrl(path), {
        ...options,
        headers: {
            'X-znca-Client-Version': NXAPI_CLIENT_VERSION,
            'X-znca-Platform': ZNCA_PLATFORM,
            'X-znca-Version': ZNCA_VERSION,
            Authorization: `Bearer ${token}`,
            ...(options.headers || {})
        }
    });

    if (response.status === 401) {
        nxapiAuthSession = { accessToken: null, refreshToken: null, expiresAt: 0 };
    }

    return response;
}

async function refreshNxapiConfig() {
    try {
        const response = await proxyFetch(nxapiUrl('config'), { headers: { Accept: 'application/json' } });
        const config = await response.json();
        if (response.ok && typeof config.nso_version === 'string') {
            ZNCA_VERSION = config.nso_version;
        }
    } catch (e) {
        console.warn('Could not load nxapi ZNCA configuration; using bundled version.', e);
    }
}

async function nxapiGenerateF(method, token, userData = {}, requestOptions = {}) {
    // Keep f-generation on the proven nxapi-auth path. The Worker already relays
    // these requests, so adding a second Worker-owned OAuth client path only adds
    // another failure mode without making the remote attestation itself faster.
    const response = await nxapiFetch('f', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ hash_method: String(method), token, ...userData }),
        signal: requestOptions.signal,
        cancelKey: requestOptions.cancelKey
    });

    let data = {};
    try {
        data = await response.json();
    } catch (e) {}

    if (!response.ok || !data.f || !data.request_id || !Number.isFinite(Number(data.timestamp))) {
        const errorMsg = serviceFailureMessage(data, response, 'nxapi did not return a complete attestation result.');
        if (response.status === 429 || errorMsg.toLowerCase().includes('too many attempts') || errorMsg.toLowerCase().includes('rate limit')) {
            const retryAfterHeader = response.headers.get('Retry-After');
            const until = parseRetryAfter(retryAfterHeader) || (Date.now() + 60000);
            setRateLimitUntil(method === 1 ? 'f1' : 'f2', until);
            const timeStr = new Date(until).toLocaleTimeString();
            const sec = Math.ceil((until - Date.now()) / 1000);
            throw new AuthStageError(
                'NXAPI_AUTH',
                `nxapi authentication temporarily rate-limited. Retry after ${timeStr} (${sec}s remaining).`,
                null,
                429
            );
        }
        const stage = method === 1 ? 'NXAPI_F_METHOD_1' : 'NXAPI_F_METHOD_2';
        throw new AuthStageError(stage, errorMsg, null, response.status);
    }
    return { f: data.f, timestamp: Number(data.timestamp), requestId: data.request_id };
}

async function nxapiEncryptRequest(url, bearerToken, body, requestOptions = {}) {
    const response = await nxapiFetch('encrypt-request', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ url, token: bearerToken || null, data: body }),
        signal: requestOptions.signal,
        cancelKey: requestOptions.cancelKey
    });
    let data = {};
    try {
        data = await response.json();
    } catch (e) {}

    if (!response.ok || !data.data) {
        const errorMsg = serviceFailureMessage(data, response, 'nxapi request encryption failed.');
        if (response.status === 429 || errorMsg.toLowerCase().includes('too many attempts') || errorMsg.toLowerCase().includes('rate limit')) {
            const retryAfterHeader = response.headers.get('Retry-After');
            const until = parseRetryAfter(retryAfterHeader) || (Date.now() + 60000);
            setRateLimitUntil('encrypt', until);
            const timeStr = new Date(until).toLocaleTimeString();
            const sec = Math.ceil((until - Date.now()) / 1000);
            throw new AuthStageError(
                'NXAPI_AUTH',
                `nxapi request encryption temporarily rate-limited. Retry after ${timeStr} (${sec}s remaining).`,
                null,
                429
            );
        }
        throw new AuthStageError('NXAPI_ENCRYPT_ACCOUNT_LOGIN', errorMsg, null, response.status);
    }
    // The API returns base64url; the existing binary proxy accepts standard base64.
    return data.data.replace(/-/g, '+').replace(/_/g, '/');
}

async function nxapiDecryptResponse(encryptedBase64, requestOptions = {}) {
    const response = await nxapiFetch('decrypt-response', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'text/plain' },
        body: JSON.stringify({ data: encryptedBase64 }),
        signal: requestOptions.signal,
        cancelKey: requestOptions.cancelKey
    });
    const data = await response.text();
    if (!response.ok) {
        if (response.status === 429 || data.toLowerCase().includes('too many attempts') || data.toLowerCase().includes('rate limit')) {
            const retryAfterHeader = response.headers.get('Retry-After');
            const until = parseRetryAfter(retryAfterHeader) || (Date.now() + 60000);
            setRateLimitUntil('decrypt', until);
            const timeStr = new Date(until).toLocaleTimeString();
            const sec = Math.ceil((until - Date.now()) / 1000);
            throw new AuthStageError(
                'NXAPI_AUTH',
                `nxapi response decryption temporarily rate-limited. Retry after ${timeStr} (${sec}s remaining).`,
                null,
                429
            );
        }
        throw new AuthStageError('NXAPI_DECRYPT_ACCOUNT_LOGIN', data || 'nxapi response decryption failed.', null, response.status);
    }
    return data;
}

function arrayBufferToBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    const chunkSize = 0x8000;
    for (let i = 0; i < bytes.length; i += chunkSize) {
        binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
    }
    return btoa(binary);
}

async function parseCoralResponse(response, requestOptions = {}) {
    throwIfAborted(requestOptions.signal);
    const buffer = await response.arrayBuffer();
    const text = new TextDecoder().decode(buffer);
    const trimmed = text.trimStart();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
        try {
            return JSON.parse(text);
        } catch (e) {
            // Some Coral encrypted responses are labelled application/json.
        }
    }
    const encryptedBase64 = arrayBufferToBase64(buffer);
    const decrypted = await nxapiDecryptResponse(encryptedBase64, requestOptions);
    return JSON.parse(decrypted);
}

// PKCE & State Generator (Alphanumeric safe for Nintendo Account)
function generateRandomString(length = 50) {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-';
    let result = '';
    const randomValues = new Uint8Array(length);
    crypto.getRandomValues(randomValues);
    for (let i = 0; i < length; i++) {
        result += chars[randomValues[i] % chars.length];
    }
    return result;
}

async function generatePKCE() {
    const verifier = generateRandomString(50);
    const encoder = new TextEncoder();
    const data = encoder.encode(verifier);
    const hash = await crypto.subtle.digest('SHA-256', data);
    
    let binary = '';
    const bytes = new Uint8Array(hash);
    for (let i = 0; i < bytes.byteLength; i++) {
        binary += String.fromCharCode(bytes[i]);
    }
    const challenge = btoa(binary)
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');

    return { verifier, challenge };
}

async function openNintendoOAuth() {
    try {
        await prepareNxapi();
    } catch (e) {
        alert(e.message);
        return;
    }

    const { verifier, challenge } = await generatePKCE();
    const state = generateRandomString(50);

    localStorage.setItem('nso_pkce_verifier', verifier);
    localStorage.setItem('nso_auth_state', state);

    // EXACT 1:1 nxapi Coral auth scope. Do not request user.mii here: Coral
    // authentication expects the smaller Nintendo Account token scope.
    const oauthUrl = `https://accounts.nintendo.com/connect/1.0.0/authorize?state=${state}&redirect_uri=npf71b963c1b7b6d119%3A%2F%2Fauth&client_id=71b963c1b7b6d119&scope=openid+user+user.birthday+user.screenName&response_type=session_token_code&session_token_code_challenge=${challenge}&session_token_code_challenge_method=S256&theme=login_form`;

    window.open(oauthUrl, '_blank');
}

// Navigation Tabs & CrewVue-style Lottie Dock Bar
const DOCK_LOTTIE_CONFIG = {
    tabs: ['home', 'friends', 'album'],
    containers: {
        home: 'dockLottieHome',
        friends: 'dockLottieFriends',
        album: 'dockLottieAlbum'
    },
    paths: {
        home: {
            dark: { on: 'assets/lottie/home_dark_on.json', off: 'assets/lottie/home_dark_off.json' },
            light: { on: 'assets/lottie/home_light_on.json', off: 'assets/lottie/home_light_off.json' }
        },
        friends: {
            dark: { on: 'assets/lottie/friend_dark_on.json', off: 'assets/lottie/friend_dark_off.json' },
            light: { on: 'assets/lottie/friend_light_on.json', off: 'assets/lottie/friend_light_off.json' }
        },
        album: {
            dark: { on: 'assets/lottie/album_dark_on.json', off: 'assets/lottie/album_dark_off.json' },
            light: { on: 'assets/lottie/album_light_on.json', off: 'assets/lottie/album_light_off.json' }
        }
    }
};

let dockLottieCache = {};
let dockLottiePlayers = {};
let currentActiveDockTab = 'home';

async function preloadDockLottie() {
    if (typeof lottie === 'undefined') return;
    const mode = document.body.classList.contains('dark-theme') ? 'dark' : 'light';
    const fetches = [];
    for (const tab of DOCK_LOTTIE_CONFIG.tabs) {
        for (const m of ['dark', 'light']) {
            for (const state of ['on', 'off']) {
                const path = DOCK_LOTTIE_CONFIG.paths[tab][m][state];
                fetches.push(
                    fetch(path)
                        .then(r => r.json())
                        .then(data => { dockLottieCache[`${tab}_${m}_${state}`] = data; })
                        .catch(err => console.warn(`[Lottie] Failed to load ${path}:`, err))
                );
            }
        }
    }
    await Promise.allSettled(fetches);
    initDockLottiePlayers();
}

function getDockLottieData(tab, state) {
    const mode = document.body.classList.contains('dark-theme') ? 'dark' : 'light';
    return dockLottieCache[`${tab}_${mode}_${state}`] || dockLottieCache[`${tab}_dark_${state}`];
}

function initDockLottiePlayers() {
    if (typeof lottie === 'undefined') return;
    for (const tab of DOCK_LOTTIE_CONFIG.tabs) {
        const container = document.getElementById(DOCK_LOTTIE_CONFIG.containers[tab]);
        if (!container) continue;
        container.innerHTML = '';
        const isSelected = tab === currentActiveDockTab;
        const animData = getDockLottieData(tab, isSelected ? 'on' : 'off');
        if (!animData) continue;

        try {
            const player = lottie.loadAnimation({
                container,
                renderer: 'svg',
                loop: false,
                autoplay: false,
                animationData: animData
            });
            dockLottiePlayers[tab] = { player, state: isSelected ? 'on' : 'off' };
            player.addEventListener('DOMLoaded', () => {
                const lastFrame = (player.totalFrames || animData.op || 1) - 1;
                player.goToAndStop(lastFrame, true);
            });
        } catch (e) {
            console.warn(`[Lottie] Error initializing ${tab}:`, e);
        }
    }
}

function playDockTabAnimation(tab, targetState, animate = true) {
    if (typeof lottie === 'undefined') return;
    const container = document.getElementById(DOCK_LOTTIE_CONFIG.containers[tab]);
    if (!container) return;

    const animData = getDockLottieData(tab, targetState);
    if (!animData) return;

    if (dockLottiePlayers[tab]?.player) {
        try { dockLottiePlayers[tab].player.destroy(); } catch (e) {}
    }

    container.innerHTML = '';
    const player = lottie.loadAnimation({
        container,
        renderer: 'svg',
        loop: false,
        autoplay: false,
        animationData: animData
    });

    dockLottiePlayers[tab] = { player, state: targetState };

    player.addEventListener('DOMLoaded', () => {
        const lastFrame = (player.totalFrames || animData.op || 1) - 1;
        if (animate) {
            player.goToAndPlay(0, true);
        } else {
            player.goToAndStop(lastFrame, true);
        }
    });

    if (targetState === 'on') {
        player.addEventListener('complete', () => {
            const lastFrame = (player.totalFrames || animData.op || 1) - 1;
            player.goToAndStop(lastFrame, true);
        });
    }
}

function switchDockTab(tabName) {
    if (currentActiveDockTab === tabName) return;
    const prevTab = currentActiveDockTab;
    currentActiveDockTab = tabName;

    if (prevTab) {
        playDockTabAnimation(prevTab, 'off', true);
    }
    playDockTabAnimation(tabName, 'on', true);
}

function initNavigation() {
    document.getElementById('logoutBtn').addEventListener('click', logout);
    document.getElementById('openAuthModalBtn').addEventListener('click', showLoginGate);
    document.getElementById('notificationBtn').addEventListener('click', openNotifications);
    document.getElementById('userAvatarContainer').addEventListener('click', openProfile);

    const dockButtons = [...document.querySelectorAll('#homeDock button')];
    dockButtons.forEach(button => {
        button.addEventListener('click', () => {
            showAppPage(button.dataset.page);
        });
    });

    preloadDockLottie();
}

// Tab Stack State Management
const navTabStacks = {
    home: 'home', // Legacy state used by older handlers. Persistent views are tracked separately below.
    friends: 'list',
    album: 'album'
};

// Nintendo Switch App-style bottom-tab state permanence. Each bottom tab owns its
// own overlay stack. Switching tabs suspends the currently visible overlays
// without destroying their DOM/data/scroll state, and returning to that tab
// restores the exact screens that were left open.
let activeAppTab = 'home';
const tabViewSnapshots = { home: [], friends: [], album: [] };
const tabBaseScroll = { home: 0, friends: 0, album: 0 };
const tabViewScroll = new Map();
// While a selected bottom tab is animating back to its root, don't let a
// simultaneous tab switch capture the outgoing submenu as fresh saved state.
const tabRootResetInFlight = new Set();
const PERSISTENT_VIEW_SELECTOR = [
    '#profileView',
    '#notificationView',
    '#friendDetailView',
    '.friend-settings-screen',
    '.sent-req-detail-screen',
    '.fc-search-screen',
    '.chatted-users-view',
    '.op-screen'
].join(',');

function validAppTab(tab) {
    return ['home', 'friends', 'album'].includes(tab) ? tab : 'home';
}

function persistentViewOwner(view) {
    if (!view) return activeAppTab;
    return validAppTab(view.dataset.nsoOwnerTab || activeAppTab);
}

function assignPersistentViewOwner(view, owner = activeAppTab) {
    if (!view || !view.matches?.(PERSISTENT_VIEW_SELECTOR)) return;
    view.dataset.nsoOwnerTab = validAppTab(owner);
}

function persistentScrollHost(view) {
    if (!view) return null;
    if (view.classList.contains('op-screen')) return view.querySelector('.op-scroll') || view;
    return view;
}

function persistentViews() {
    return [...document.querySelectorAll(PERSISTENT_VIEW_SELECTOR)];
}

function captureTabNavigationState(tab) {
    tab = validAppTab(tab);
    if (tabRootResetInFlight.has(tab)) return;
    tabBaseScroll[tab] = window.scrollY || 0;
    const visible = persistentViews().filter((view) =>
        !view.classList.contains('hidden') && persistentViewOwner(view) === tab
    );
    tabViewSnapshots[tab] = visible.map((view) => view.id).filter(Boolean);
    visible.forEach((view) => {
        const host = persistentScrollHost(view);
        if (host && view.id) tabViewScroll.set(view.id, host.scrollTop || 0);
    });
}

function suspendTabNavigationState(tab) {
    tab = validAppTab(tab);
    persistentViews().forEach((view) => {
        if (persistentViewOwner(view) !== tab || view.classList.contains('hidden')) return;
        hideViewInstant(view);
    });
}

function restoreTabNavigationState(tab) {
    tab = validAppTab(tab);
    const ids = tabViewSnapshots[tab] || [];
    ids.forEach((id) => {
        const view = document.getElementById(id);
        if (!view || persistentViewOwner(view) !== tab) return;
        showViewInstant(view);
    });

    requestAnimationFrame(() => {
        if (activeAppTab !== tab) return;
        // Restore the base page position even when an overlay is on top, so pressing
        // Back after returning to the tab reveals the same underlying content.
        window.scrollTo({ top: tabBaseScroll[tab] || 0, behavior: 'auto' });
        ids.forEach((id) => {
            const view = document.getElementById(id);
            const host = persistentScrollHost(view);
            if (host && tabViewScroll.has(id)) host.scrollTop = tabViewScroll.get(id);
        });
    });
}

function resetTabNavigationState() {
    activeAppTab = 'home';
    for (const tab of Object.keys(tabViewSnapshots)) {
        tabViewSnapshots[tab] = [];
        tabBaseScroll[tab] = 0;
    }
    tabViewScroll.clear();
    persistentViews().forEach((view) => hideViewInstant(view));
}

// Reselecting the currently active bottom tab acts like Android's pop-to-root:
// preserve nested state while switching between tabs, but a second press on the
// already-selected tab clears that tab's overlay/back stack and reveals its base page.
// The visible leaf screen uses the same APK-derived Back transition as a normal
// submenu Back press instead of disappearing instantly.
function resetTabToRoot(tab) {
    tab = validAppTab(tab);
    const ownedViews = persistentViews().filter((view) => persistentViewOwner(view) === tab);
    const visibleOwnedViews = ownedViews.filter((view) => !view.classList.contains('hidden'));
    const hasVisibleNestedView = visibleOwnedViews.length > 0;
    const hasSavedNestedView = (tabViewSnapshots[tab] || []).length > 0;
    if (!hasVisibleNestedView && !hasSavedNestedView) return false;
    if (tabRootResetInFlight.has(tab)) return true;

    // Prefer the visually topmost visible submenu. z-index wins first; DOM order
    // breaks ties for screens that share the same native overlay layer.
    const leavingView = visibleOwnedViews.reduce((top, view) => {
        if (!top) return view;
        const topZ = Number.parseInt(getComputedStyle(top).zIndex, 10);
        const viewZ = Number.parseInt(getComputedStyle(view).zIndex, 10);
        const safeTopZ = Number.isFinite(topZ) ? topZ : 0;
        const safeViewZ = Number.isFinite(viewZ) ? viewZ : 0;
        if (safeViewZ !== safeTopZ) return safeViewZ > safeTopZ ? view : top;
        return top.compareDocumentPosition(view) & Node.DOCUMENT_POSITION_FOLLOWING ? view : top;
    }, null);

    tabRootResetInFlight.add(tab);
    tabViewSnapshots[tab] = [];
    ownedViews.forEach((view) => {
        if (view.id) tabViewScroll.delete(view.id);
    });

    // Keep the legacy per-tab state in sync with the root immediately so older
    // handlers cannot reopen a stale submenu while the leave animation is running.
    if (tab === 'friends') navTabStacks.friends = 'list';
    else if (tab === 'album') navTabStacks.album = 'album';
    else navTabStacks.home = 'home';

    const rootPage = document.getElementById(`page-${tab}`);
    document.querySelectorAll('.tab-page').forEach((page) => page.classList.remove('active'));
    rootPage?.classList.add('active');

    // Only the leaf screen should animate. Any older stacked overlays are removed
    // first so the section root is the actual background revealed by Back.
    ownedViews.forEach((view) => {
        if (view !== leavingView) hideViewInstant(view);
    });

    const finish = () => {
        ownedViews.forEach((view) => hideViewInstant(view));
        tabRootResetInFlight.delete(tab);
        if (activeAppTab !== tab) return;
        requestAnimationFrame(() => {
            if (activeAppTab !== tab) return;
            window.scrollTo({ top: tabBaseScroll[tab] || 0, behavior: 'auto' });
        });
    };

    if (leavingView && rootPage) {
        // One native-style pop-to-root animation, matching an ordinary submenu Back.
        Promise.resolve(nsoApkBack(leavingView, rootPage)).then(finish, finish);
    } else {
        finish();
    }
    return true;
}

window.nsoCurrentTab = () => activeAppTab;

let activeFriendDetailData = null;
let friendDetailOriginTab = 'friends';

// --- Slide transition helpers ---
function slideViewIn(el) {
    if (!el) return;
    assignPersistentViewOwner(el, activeAppTab);
    el.classList.remove('hidden', 'view-slide-out');
    el.classList.add('view-slide-in');
    el.addEventListener('animationend', () => {
        el.classList.remove('view-slide-in');
    }, { once: true });
}

function slideViewOut(el, cb) {
    if (!el) return;
    el.classList.remove('view-slide-in');
    el.classList.add('view-slide-out');
    el.addEventListener('animationend', () => {
        el.classList.remove('view-slide-out');
        el.classList.add('hidden');
        if (cb) cb();
    }, { once: true });
}

function hideViewInstant(el) {
    if (!el) return;
    el.classList.remove('view-slide-in', 'view-slide-out');
    el.classList.add('hidden');
}

function showViewInstant(el) {
    if (!el) return;
    el.classList.remove('hidden', 'view-slide-in', 'view-slide-out');
}

// Exact activity transition timing recovered from the Nintendo Switch App APK:
// forward = 150 ms delay + 400 ms ease-out scale, with the alpha phase at 200 ms;
// back = 400 ms ease-out scale, with a 50 ms alpha phase after 50 ms.
const NSO_APK_FORWARD_TRANSITION_MS = 550;
const NSO_APK_BACK_TRANSITION_MS = 400;

function clearNsoApkTransition(el) {
    if (!el) return;
    if (el.__nsoApkTransitionTimer) {
        clearTimeout(el.__nsoApkTransitionTimer);
        el.__nsoApkTransitionTimer = null;
    }
    el.classList.remove(
        'nso-apk-go-enter',
        'nso-apk-go-exit',
        'nso-apk-back-enter',
        'nso-apk-back-exit',
        'nso-apk-transition-foreground',
        'nso-apk-transition-background'
    );
}

function nsoApkForward(fromView, toView, options = {}) {
    if (!toView) return Promise.resolve();
    assignPersistentViewOwner(toView, fromView?.dataset?.nsoOwnerTab || activeAppTab);
    const hideSource = options.hideSource !== false;
    clearNsoApkTransition(fromView);
    clearNsoApkTransition(toView);

    toView.classList.remove('hidden', 'view-slide-in', 'view-slide-out');
    toView.classList.add('nso-apk-transition-foreground', 'nso-apk-go-enter');
    if (fromView && fromView !== toView) {
        fromView.classList.remove('view-slide-in', 'view-slide-out');
        fromView.classList.add('nso-apk-transition-background', 'nso-apk-go-exit');
    }

    return new Promise((resolve) => {
        const finish = () => {
            if (fromView && fromView !== toView) {
                clearNsoApkTransition(fromView);
                if (hideSource) fromView.classList.add('hidden');
            }
            clearNsoApkTransition(toView);
            resolve();
        };
        toView.__nsoApkTransitionTimer = setTimeout(finish, NSO_APK_FORWARD_TRANSITION_MS + 30);
    });
}

function nsoApkBack(fromView, toView, options = {}) {
    if (!fromView) return Promise.resolve();
    const hideSource = options.hideSource !== false;
    clearNsoApkTransition(fromView);
    clearNsoApkTransition(toView);

    if (toView) {
        toView.classList.remove('hidden', 'view-slide-in', 'view-slide-out');
        toView.classList.add('nso-apk-transition-background', 'nso-apk-back-enter');
    }
    fromView.classList.remove('hidden', 'view-slide-in', 'view-slide-out');
    fromView.classList.add('nso-apk-transition-foreground', 'nso-apk-back-exit');

    return new Promise((resolve) => {
        const finish = () => {
            clearNsoApkTransition(fromView);
            if (hideSource) fromView.classList.add('hidden');
            clearNsoApkTransition(toView);
            resolve();
        };
        fromView.__nsoApkTransitionTimer = setTimeout(finish, NSO_APK_BACK_TRANSITION_MS + 30);
    });
}

window.nsoApkForward = nsoApkForward;
window.nsoApkBack = nsoApkBack;

function applyTabViewState(tabName = 'home', options = {}) {
    tabName = validAppTab(tabName);
    const restoringSnapshot = options.restoreSnapshot === true;

    // When this is an in-tab state change (for example Friend Detail -> Friends),
    // refresh the snapshot from the live DOM instead of replaying an older saved
    // leaf screen. Cross-tab restores deliberately skip this capture.
    if (!restoringSnapshot && tabName === activeAppTab) {
        captureTabNavigationState(tabName);
    }

    // Every tab keeps its base page mounted underneath its own overlay stack.
    // This mirrors the native app's Fragment/back-stack behavior and prevents
    // a one-frame Home flash when restoring a submenu.
    document.querySelectorAll('.tab-page').forEach((page) => page.classList.remove('active'));
    document.getElementById(`page-${tabName}`)?.classList.add('active');

    persistentViews().forEach((view) => {
        if (persistentViewOwner(view) !== tabName && !view.classList.contains('hidden')) {
            hideViewInstant(view);
        }
    });

    if (restoringSnapshot) restoreTabNavigationState(tabName);
}

function showAppPage(pageName = 'home') {
    pageName = validAppTab(pageName);
    const switchedTabs = pageName !== activeAppTab;

    if (switchedTabs) {
        captureTabNavigationState(activeAppTab);
        suspendTabNavigationState(activeAppTab);
        activeAppTab = pageName;
    } else {
        // A tap on the already-selected bottom tab is an explicit request to go
        // back to that section's main/root screen. Cross-tab restores still keep
        // their exact submenu and scroll state until this reselect happens.
        resetTabToRoot(pageName);
    }

    document.querySelectorAll('#homeDock button').forEach(button => {
        button.classList.toggle('active', button.dataset.page === pageName);
    });
    switchDockTab(pageName);
    applyTabViewState(pageName, { restoreSnapshot: switchedTabs });
}

// Game Services Tabs
function initServicesNav() {
    const serviceBtns = document.querySelectorAll('.service-tab-btn');
    const serviceContents = document.querySelectorAll('.service-content');

    serviceBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            serviceBtns.forEach(b => b.classList.remove('active'));
            serviceContents.forEach(c => c.classList.remove('active'));

            btn.classList.add('active');
            const targetId = `service-${btn.dataset.service}`;
            document.getElementById(targetId).classList.add('active');
        });
    });
}

function showLoginGate() {
    document.getElementById('loginGate').classList.remove('hidden');
    document.getElementById('appContent').classList.add('hidden');
    document.getElementById('mainNavTabs').classList.add('hidden');
    document.getElementById('userAvatarContainer').classList.add('hidden');
    document.getElementById('notificationBtn').classList.add('hidden');
    document.getElementById('homeDock').classList.add('hidden');
    document.getElementById('openAuthModalBtn').classList.remove('hidden');
    document.getElementById('profileView').classList.add('hidden');
    document.getElementById('notificationView').classList.add('hidden');
}

function showAuthenticatedUI(session) {
    document.getElementById('loginGate').classList.add('hidden');
    document.getElementById('appContent').classList.remove('hidden');
    document.getElementById('mainNavTabs').classList.remove('hidden');
    document.getElementById('userAvatarContainer').classList.remove('hidden');
    document.getElementById('notificationBtn').classList.remove('hidden');
    document.getElementById('homeDock').classList.remove('hidden');
    document.getElementById('openAuthModalBtn').classList.add('hidden');
    resetTabNavigationState();
    showAppPage('home');
    startTokenBrokerHeartbeat();

    if (session && session.result && session.result.user) {
        const user = session.result.user;
        const displayName = user.nickname || user.name || 'Switch Player';
        document.getElementById('myNickname').textContent = displayName;
        document.getElementById('userNickname').textContent = displayName;
        document.getElementById('profileViewName').textContent = displayName;
        if (user.imageUri) {
            document.getElementById('myAvatar').src = user.imageUri;
            document.getElementById('userAvatar').src = user.imageUri;
            document.getElementById('profileViewAvatar').src = user.imageUri;
        }
        if (user.links && user.links.friendCode) {
            document.getElementById('myFriendCode').textContent = user.links.friendCode.id;
            document.getElementById('profileViewFriendCode').textContent = user.links.friendCode.id;
        }
    } else if (session && session.user) {
        document.getElementById('myNickname').textContent = session.user.nickname || 'Switch Player';
        document.getElementById('userNickname').textContent = session.user.nickname || 'Switch Player';
        document.getElementById('profileViewName').textContent = session.user.nickname || 'Switch Player';
        if (session.user.imageUri) {
            document.getElementById('myAvatar').src = session.user.imageUri;
            document.getElementById('userAvatar').src = session.user.imageUri;
            document.getElementById('profileViewAvatar').src = session.user.imageUri;
        }
    }

    loadLiveFriendsList();
    loadGameServices();
    loadSwitchMedia();
}

function logout() {
    window.webServiceManager?.closeActiveService();
    window.nsoCloseAppScreens?.();
    // Release only this tab's active lease. If the user explicitly enabled Remember
    // Me, keep that encrypted grant and its Coral cache so “Sign Out” does not behave
    // like “Forget Remembered Account”.
    releaseTokenBrokerSession({ keepalive: true });
    try { sessionStorage.removeItem('nso_token_broker_client_id'); } catch (e) {}
    sessionStorage.removeItem('nso_user_session');
    localStorage.removeItem('nso_user_session');
    localStorage.removeItem('nso_pkce_verifier');
    localStorage.removeItem('nso_auth_state');
    userSession = null;
    nxapiAuthSession = { accessToken: null, refreshToken: null, expiresAt: 0 };
    showLoginGate();
    updateRememberedUI();
}

async function clearRememberedAccount() {
    localStorage.removeItem('nso_has_remembered_account');
    localStorage.removeItem('nso_remember_expires_at');
    updateRememberedUI();
    try {
        await fetch(`${WORKER_URL}/api/nso/remember/forget`, {
            method: 'POST',
            credentials: 'include'
        });
    } catch (e) {
        console.warn('[RememberMe] Failed to delete server-side remember record:', e);
    }
}

async function forgetRememberedAccount() {
    await clearRememberedAccount();
    alert('Remembered Nintendo Account has been forgotten on this device.');
}

function openProfile() {
    navTabStacks.home = 'profile';
    slideViewIn(document.getElementById('profileView'));
}

async function openNotifications() {
    navTabStacks.home = 'notifications';
    slideViewIn(document.getElementById('notificationView'));
    const list = document.getElementById('notificationList');
    list.innerHTML = '<div class="notification-item"><div></div><div><strong>Loading notifications…</strong></div></div>';
    try {
        const result = await coralCall('/v4/Announcement/List');
        renderNotifications(Array.isArray(result) ? result : (result.announcements || []));
    } catch (error) {
        list.innerHTML = `<p class="service-status error">Could not load notifications: ${error.message}</p>`;
    }
}

function renderNotifications(items) {
    const list = document.getElementById('notificationList');
    list.innerHTML = '';
    if (!items.length) {
        list.innerHTML = '<p class="service-status">There are no notifications.</p>';
        return;
    }
    for (const item of items) {
        const article = document.createElement('article');
        article.className = 'notification-item';
        const image = document.createElement('img');
        image.src = item.imageUri || item.image2Uri || '';
        image.alt = '';
        const copy = document.createElement('div');
        const title = document.createElement('strong');
        title.textContent = item.title || 'Nintendo Switch App';
        const description = document.createElement('p');
        description.textContent = item.operation?.contents || item.contents || '';
        const time = document.createElement('span');
        time.textContent = formatMediaDate(item.deliversAt || item.distributionDate);
        copy.append(title, description, time);
        article.append(image, copy);
        list.append(article);
    }
}

let loginInFlight = null;

function setAuthButtonsDisabled(disabled, label = null) {
    const submitGateBtn = document.getElementById('submitAuthGateBtn');
    const pasteAuthGateBtn = document.getElementById('pasteAuthGateBtn');
    const oauthGateBtn = document.getElementById('nintendoOAuthGateBtn');
    const resumeBtn = document.getElementById('resumeRememberedBtn');
    const forgetBtn = document.getElementById('forgetRememberedBtn');

    if (submitGateBtn) {
        submitGateBtn.disabled = disabled;
        if (label) submitGateBtn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> ${label}`;
        else submitGateBtn.innerHTML = '<i class="fa-solid fa-right-to-bracket"></i> Sign In';
    }
    if (pasteAuthGateBtn) pasteAuthGateBtn.disabled = disabled;
    if (oauthGateBtn) oauthGateBtn.disabled = disabled;
    if (resumeBtn) {
        resumeBtn.disabled = disabled;
        if (label && disabled) resumeBtn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> ${label}`;
        else resumeBtn.innerHTML = '<i class="fa-solid fa-key"></i> Continue with remembered Nintendo Account';
    }
    if (forgetBtn) forgetBtn.disabled = disabled;
}

function setAuthGateHint(_text) {
    // Login progress/errors are shown through the button state and error dialogs.
    // Keep the area below “Paste from clipboard” clean instead of exposing internal
    // authentication-stage/debug text in the UI.
}

async function performFullAuthentication(options = {}) {
    if (loginInFlight) {
        console.log('[Auth] Authentication already in progress, awaiting active flow.');
        return loginInFlight;
    }

    // Immediately disable buttons BEFORE any await
    setAuthButtonsDisabled(true, 'Signing in...');

    loginInFlight = (async () => {
        try {
            // Do not contact nxapi just to check a remembered/brokered Coral session.
            // Consent is enforced at the exact point an nxapi request becomes necessary.
            let idToken = null;
            let accessToken = null;
            let longLivedSessionToken = null;
            const isResume = options.isResume === true;

            if (isResume) {
                setAuthButtonsDisabled(true, 'Signing in...');
                setAuthGateHint('Resuming your saved Nintendo Account session…');

                let resumeResp;
                try {
                    resumeResp = await fetch(`${WORKER_URL}/api/nso/remember/resume`, {
                        method: 'POST',
                        credentials: 'include'
                    });
                } catch (e) {
                    throw new AuthStageError('REMEMBER_RESUME', `Network error contacting remember service: ${e.message}`, e);
                }

                if (!resumeResp.ok) {
                    localStorage.removeItem('nso_has_remembered_account');
                    localStorage.removeItem('nso_remember_expires_at');
                    updateRememberedUI();
                    let errMsg = `HTTP ${resumeResp.status}`;
                    try {
                        const errData = await resumeResp.json();
                        errMsg = errData.error || errMsg;
                    } catch {}
                    throw new AuthStageError('REMEMBER_RESUME', `Remembered session expired or revoked: ${errMsg}`, null, resumeResp.status);
                }

                const resumeData = await resumeResp.json();
                idToken = resumeData.idToken;
                accessToken = resumeData.accessToken;
            } else {
                const input = (options.input || document.getElementById('idTokenGateInput')?.value || '').trim();
                if (!input) {
                    throw new Error('Please paste the redirect URL or session_token string.');
                }

                // Direct JSON Session or AccessToken input support
                if (input.startsWith('{') && input.endsWith('}')) {
                    try {
                        const jsonSession = JSON.parse(input);
                        const expiresIn = Number(jsonSession?.result?.webApiServerCredential?.expiresIn || 7200);
                        jsonSession.nsoWebapp = jsonSession.nsoWebapp || {
                            coralExpiresAt: Date.now() + expiresIn * 1000
                        };
                        userSession = jsonSession;
                        sessionStorage.setItem('nso_user_session', JSON.stringify(jsonSession));
                        showAuthenticatedUI(jsonSession);
                        return;
                    } catch (e) {}
                }

                let code = input;
                let returnedState = null;
                if (input.includes('session_token_code=')) {
                    const hashPart = input.split('#')[1] || input.split('?')[1] || input;
                    const urlParams = new URLSearchParams(hashPart);
                    code = urlParams.get('session_token_code') || code;
                    returnedState = urlParams.get('state') || null;
                }

                const expectedState = localStorage.getItem('nso_auth_state');
                if (returnedState && expectedState && returnedState !== expectedState) {
                    throw new AuthStageError(
                        'NINTENDO_SESSION_TOKEN_EXCHANGE',
                        'OAuth state mismatch. The sign-in response did not match the expected authentication request. Please click "Open Nintendo Sign In" again.'
                    );
                }

                const verifier = localStorage.getItem('nso_pkce_verifier');
                if (!verifier && (input.includes('session_token_code=') || input.length < 120)) {
                    throw new AuthStageError(
                        'NINTENDO_SESSION_TOKEN_EXCHANGE',
                        'PKCE verifier missing. Please click "Open Nintendo Sign In" again to start a new authentication session.'
                    );
                }

                // Step 1: Exchange session_token_code + session_token_code_verifier -> session_token
                setAuthButtonsDisabled(true, 'Signing in...');
                setAuthGateHint('Exchanging session authorization code with Nintendo…');

                const formBody = new URLSearchParams({
                    client_id: '71b963c1b7b6d119',
                    session_token_code: code,
                    session_token_code_verifier: verifier || ''
                });

                const step1Resp = await proxyFetch('https://accounts.nintendo.com/connect/1.0.0/api/session_token', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/x-www-form-urlencoded',
                        'User-Agent': 'Dalvik/2.1.0 (Linux; U; Android 10; Build/QP1A.190711.020)'
                    },
                    body: formBody.toString()
                });
                const step1Data = await step1Resp.json().catch(() => ({}));

                if (!step1Resp.ok || !step1Data.session_token) {
                    throw new AuthStageError(
                        'NINTENDO_SESSION_TOKEN_EXCHANGE',
                        `Nintendo session code exchange failed: ${step1Data.error || step1Data.errorMessage || 'Invalid session_token_code'} (HTTP ${step1Resp.status})`,
                        null,
                        step1Resp.status
                    );
                }

                longLivedSessionToken = step1Data.session_token;
                localStorage.removeItem('nso_pkce_verifier');
                localStorage.removeItem('nso_auth_state');

                // Step 2: Exchange session_token -> id_token & access_token (JWT)
                setAuthButtonsDisabled(true, 'Signing in...');
                setAuthGateHint('Requesting Nintendo Account tokens…');

                const step2Resp = await proxyFetch('https://accounts.nintendo.com/connect/1.0.0/api/token', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'User-Agent': 'Dalvik/2.1.0 (Linux; U; Android 10; Build/QP1A.190711.020)'
                    },
                    body: JSON.stringify({
                        client_id: '71b963c1b7b6d119',
                        session_token: longLivedSessionToken,
                        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer-session-token'
                    })
                });
                const step2Data = await step2Resp.json().catch(() => ({}));

                if (!step2Resp.ok || !step2Data.id_token) {
                    throw new AuthStageError(
                        'NINTENDO_ID_TOKEN_EXCHANGE',
                        `Nintendo token exchange failed: ${step2Data.error_description || step2Data.error || 'Failed to obtain id_token'} (HTTP ${step2Resp.status})`,
                        null,
                        step2Resp.status
                    );
                }

                idToken = step2Data.id_token;
                accessToken = step2Data.access_token;
            }

            // Start the account broker once. The Worker already validates the Nintendo
            // access token against /users/me to derive the account key, so return that
            // same profile instead of making the browser perform the identical request
            // a second time. This removes one Nintendo + Cloudflare round trip from login.
            setAuthButtonsDisabled(true, 'Signing in...');
            let data = null;
            let brokerReady = false;
            let brokerSession = null;
            let userInfo = null;
            try {
                brokerSession = await startTokenBrokerSession(accessToken);
                brokerReady = true;
                userInfo = brokerSession?.profile || null;
            } catch (error) {
                // Backward compatibility / temporary Worker outage: only then use the
                // canonical client-side profile + Coral path. Never fall back after an
                // nxapi/Coral response from the broker, which would double-spend auth.
                console.warn('[AccountTokenBroker] Session unavailable; using canonical Coral login path:', error);
            }

            if (!userInfo) {
                const userResp = await proxyFetch('https://api.accounts.nintendo.com/2.0.0/users/me', {
                    headers: {
                        'Authorization': `Bearer ${accessToken}`,
                        'Accept-Language': 'en-GB',
                        'User-Agent': 'NASDKAPI; Android',
                        'Accept': 'application/json'
                    }
                });
                if (!userResp.ok) {
                    throw new AuthStageError(
                        'NINTENDO_PROFILE',
                        `Failed to retrieve Nintendo Account profile (HTTP ${userResp.status}).`,
                        null,
                        userResp.status
                    );
                }
                userInfo = await userResp.json().catch(() => ({}));
            }

            if (!userInfo?.id || !userInfo?.country || !userInfo?.language || !userInfo?.birthday) {
                throw new AuthStageError(
                    'NINTENDO_PROFILE',
                    'Nintendo Account profile is missing required fields (id, country, language, or birthday).'
                );
            }

            const naId = userInfo.id;
            const language = userInfo.language;
            const naCountry = userInfo.country;
            const naBirthday = userInfo.birthday;

            if (brokerReady && validBrokerCoralSession(brokerSession?.coral, naId)) {
                data = brokerSession.coral.session;
            }

            if (!data && brokerReady) {
                setAuthButtonsDisabled(true, 'Signing in...');
                setAuthGateHint('Cloudflare cache miss — requesting one nxapi Coral attestation…');
                data = await generateCoralViaTokenBroker({
                    idToken,
                    naId,
                    language,
                    country: naCountry,
                    birthday: naBirthday
                });
                console.log('[AccountTokenBroker] Coral cache filled from one method-1 generation.');
            }

            if (!data) {
                // Step 4: Request nxapi method-1 attestation. This is the fallback for
                // an unavailable broker, so enforce disclosure consent right here.
                await prepareNxapi();
                setAuthButtonsDisabled(true, 'Signing in...');
                setAuthGateHint('Generating Coral attestation f-token with nxapi…');

                let attestation;
                try {
                    attestation = await nxapiGenerateF(1, idToken, { na_id: naId });
                } catch (err) {
                    if (err instanceof AuthStageError) throw err;
                    throw new AuthStageError('NXAPI_F_METHOD_1', `nxapi attestation failed: ${err.message}`, err);
                }

                const { f: fToken, timestamp: timestampMs, requestId } = attestation;

                // Step 5: Encrypt Coral Account/Login payload
                setAuthButtonsDisabled(true, 'Signing in...');
                setAuthGateHint('Encrypting Coral login request…');

                const coralLoginUrl = 'https://api-lp1.znc.srv.nintendo.net/v4/Account/Login';
                const coralLoginBody = JSON.stringify({
                    parameter: {
                        f: fToken,
                        naIdToken: idToken,
                        timestamp: timestampMs,
                        requestId: requestId,
                        language,
                        naCountry,
                        naBirthday
                    }
                });

                let encryptedLoginBody;
                try {
                    encryptedLoginBody = await nxapiEncryptRequest(coralLoginUrl, null, coralLoginBody);
                } catch (err) {
                    if (err instanceof AuthStageError) throw err;
                    throw new AuthStageError('NXAPI_ENCRYPT_ACCOUNT_LOGIN', `nxapi login encryption failed: ${err.message}`, err);
                }

                // Step 6: Post to Coral /v4/Account/Login
                setAuthButtonsDisabled(true, 'Signing in...');
                setAuthGateHint('Connecting to Nintendo Switch Online Coral service…');

                const coralResp = await proxyFetch(coralLoginUrl, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/octet-stream',
                        'Accept': 'application/octet-stream,application/json',
                        'Accept-Language': 'en-GB',
                        'Pragma': 'no-cache',
                        'Cache-Control': 'no-cache',
                        'X-ProductVersion': ZNCA_VERSION,
                        'X-Platform': ZNCA_PLATFORM,
                        'User-Agent': zncaUserAgent()
                    },
                    bodyBase64: encryptedLoginBody
                });

                data = null;
                try {
                    data = await parseCoralResponse(coralResp);
                } catch (err) {
                    throw new AuthStageError('NXAPI_DECRYPT_ACCOUNT_LOGIN', `Could not decrypt Coral response: ${err.message}`, err);
                }

                if (!coralResp.ok || !data?.result) {
                    throw new AuthStageError(
                        'CORAL_ACCOUNT_LOGIN',
                        `Coral login failed (${data?.status || 'Error'}): ${data?.errorMessage || data?.error || 'Authentication rejected'} (HTTP ${coralResp.status})`,
                        null,
                        coralResp.status
                    );
                }

            }

            // Authentication succeeded! Derive expiresAt strictly from Coral's webApiServerCredential.expiresIn
            const expiresInSec = Number(data.result?.webApiServerCredential?.expiresIn || 7200);
            const brokerExpiresAt = Number(data?.nsoWebapp?.coralExpiresAt || 0);
            data.nsoWebapp = {
                ...(data.nsoWebapp || {}),
                naId,
                // A broker cache hit carries the original absolute expiry. Never
                // extend it merely because another device reused the same token.
                coralExpiresAt: brokerExpiresAt > Date.now()
                    ? brokerExpiresAt
                    : Date.now() + expiresInSec * 1000
            };
            userSession = data;
            sessionStorage.setItem('nso_user_session', JSON.stringify(data));

            // Persist Remember Me ONLY after complete Coral Account/Login flow succeeds!
            const rememberCheckbox = document.getElementById('rememberMeCheckbox');
            const shouldRemember = rememberCheckbox?.checked === true;

            if (shouldRemember && longLivedSessionToken) {
                try {
                    setAuthGateHint('Saving encrypted session on server…');
                    const remResp = await fetch(`${WORKER_URL}/api/nso/remember/save`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        credentials: 'include',
                        body: JSON.stringify({ sessionToken: longLivedSessionToken })
                    });
                    if (remResp.ok) {
                        const rememberData = await remResp.json().catch(() => ({}));
                        const rememberExpiresAt = Number(rememberData.expiresAt || 0);
                        if (rememberExpiresAt > Date.now()) {
                            localStorage.setItem('nso_has_remembered_account', 'true');
                            localStorage.setItem('nso_remember_expires_at', String(rememberExpiresAt));
                        } else {
                            localStorage.removeItem('nso_has_remembered_account');
                            localStorage.removeItem('nso_remember_expires_at');
                        }
                        updateRememberedUI();
                    } else {
                        const err = await remResp.json().catch(() => ({}));
                        console.warn('[RememberMe] Save rejected:', err.error);
                    }
                } catch (e) {
                    console.warn('[RememberMe] Save error:', e);
                }
            } else {
                // Treat an unchecked Remember Me box as an explicit opt-out for
                // this browser. Revoke any older remember grant/cookie so the
                // account broker cannot remain persistent because of stale local
                // consent from a previous sign-in on this browser.
                localStorage.removeItem('nso_has_remembered_account');
                localStorage.removeItem('nso_remember_expires_at');
                try {
                    await fetch(`${WORKER_URL}/api/nso/remember/forget`, {
                        method: 'POST',
                        credentials: 'include'
                    });
                } catch (e) {
                    console.warn('[RememberMe] Could not revoke an older remember grant:', e);
                }
                updateRememberedUI();
            }

            setAuthGateHint('');
            showAuthenticatedUI(data);
        } catch (err) {
            // If authentication failed after opening an ephemeral broker lease,
            // release it immediately. Without Remember Me this causes the account
            // cache to be purged now instead of waiting for the 90-second crash
            // fail-safe lease timeout.
            if (!userSession) releaseTokenBrokerSession({ keepalive: true });
            console.error('[Auth Error]', err);
            let displayMsg = err.message || 'An unknown error occurred during sign-in.';
            if (err instanceof AuthStageError) {
                displayMsg = `[${err.stage}] ${err.message}`;
            }
            alert(displayMsg);
            setAuthGateHint(displayMsg);
        } finally {
            loginInFlight = null;
            setAuthButtonsDisabled(false);
        }
    })();

    try {
        return await loginInFlight;
    } finally {
        loginInFlight = null;
        setAuthButtonsDisabled(false);
    }
}

function initAuthGate() {
    const oauthGateBtn = document.getElementById('nintendoOAuthGateBtn');
    const submitGateBtn = document.getElementById('submitAuthGateBtn');
    const pasteAuthGateBtn = document.getElementById('pasteAuthGateBtn');
    const beginSignInBtn = document.getElementById('beginSignInBtn');
    const loginWorkflow = document.getElementById('loginWorkflow');
    const authInput = document.getElementById('idTokenGateInput');
    const resumeRememberedBtn = document.getElementById('resumeRememberedBtn');
    const forgetRememberedBtn = document.getElementById('forgetRememberedBtn');
    const profileForgetRememberedBtn = document.getElementById('profileForgetRememberedBtn');
    const nxapiConsentCheckbox = document.getElementById('nxapiConsentCheckbox');
    const nxapiDisclosure = document.getElementById('nxapiDisclosure');

    const requireNxapiConsent = () => {
        if (nxapiConsentCheckbox?.checked) {
            nxapiDisclosure?.classList.remove('needs-consent');
            return true;
        }
        nxapiDisclosure?.classList.add('needs-consent');
        nxapiConsentCheckbox?.focus();
        nxapiConsentCheckbox?.reportValidity?.();
        return false;
    };

    nxapiConsentCheckbox?.addEventListener('change', () => {
        nxapiDisclosure?.classList.toggle('needs-consent', !nxapiConsentCheckbox.checked);
        if (nxapiConsentCheckbox.checked) {
            // Consent is explicit at this point. Warm nxapi OAuth/config while the user
            // is completing Nintendo sign-in, hiding that latency from the critical path.
            void warmNxapiForLogin().catch(() => {});
        }
    });

    let pasteDebounceTimer = null;
    const continueWithPastedRedirect = () => {
        if (pasteDebounceTimer) clearTimeout(pasteDebounceTimer);
        pasteDebounceTimer = setTimeout(() => {
            const value = authInput?.value.trim() || '';
            if (!value || !(value.includes('session_token_code=') || value.startsWith('eyJ') || value.startsWith('{'))) return;
            if (!requireNxapiConsent()) return;
            performFullAuthentication({ input: value });
        }, 300);
    };

    if (beginSignInBtn) {
        beginSignInBtn.addEventListener('click', () => {
            loginWorkflow.classList.remove('hidden');
            beginSignInBtn.classList.add('hidden');
            document.querySelector('.login-help')?.classList.add('hidden');
            loginWorkflow.scrollIntoView({ behavior: 'smooth', block: 'center' });
        });
    }

    if (authInput) {
        authInput.addEventListener('paste', continueWithPastedRedirect);
    }

    if (pasteAuthGateBtn) {
        pasteAuthGateBtn.addEventListener('click', async () => {
            try {
                const clipboardText = await navigator.clipboard.readText();
                if (!clipboardText) throw new Error('Your clipboard is empty.');
                authInput.value = clipboardText.trim();
                continueWithPastedRedirect();
            } catch (e) {
                setAuthGateHint(`${e.message} Paste the link into the box manually.`);
                authInput.focus();
            }
        });
    }

    if (oauthGateBtn) {
        oauthGateBtn.addEventListener('click', openNintendoOAuth);
    }

    if (submitGateBtn) {
        submitGateBtn.addEventListener('click', () => {
            if (!requireNxapiConsent()) return;
            const input = authInput?.value.trim() || '';
            performFullAuthentication({ input });
        });
    }

    if (resumeRememberedBtn) {
        resumeRememberedBtn.addEventListener('click', () => {
            // A valid remembered Coral cache hit needs no nxapi call, so do not force
            // disclosure consent up front. If the cache is expired/missing, the nxapi
            // path itself will request consent before making any third-party request.
            performFullAuthentication({ isResume: true });
        });
    }

    if (forgetRememberedBtn) {
        forgetRememberedBtn.addEventListener('click', forgetRememberedAccount);
    }

    if (profileForgetRememberedBtn) {
        profileForgetRememberedBtn.addEventListener('click', forgetRememberedAccount);
    }
}



// Load Live Friends directly from Nintendo API in Browser Client-Side JS
async function loadLiveFriendsList() {
    if (!userSession) return;

    const friendContainers = ['homeFriendsGrid', 'friendsGrid'].map(id => document.getElementById(id));
    friendContainers.forEach(container => {
        container.innerHTML = Array.from({ length: 6 }, () => '<div class="friend-loading-tile"><i></i><span></span></div>').join('');
    });

    let tokenToUse = null;
    if (userSession.result && userSession.result.webApiServerCredential) {
        tokenToUse = userSession.result.webApiServerCredential.accessToken;
    } else if (userSession.webApiServerCredential) {
        tokenToUse = userSession.webApiServerCredential.accessToken;
    } else if (userSession.accessToken) {
        tokenToUse = userSession.accessToken;
    }

    if (!tokenToUse) {
        friendContainers.forEach(container => {
            container.innerHTML = '<p class="service-status error">No valid access token is available. Sign in again.</p>';
        });
        return;
    }

    try {
        const friendListUrl = 'https://api-lp1.znc.srv.nintendo.net/v4/Friend/List';
        const friendListBody = JSON.stringify({ parameter: {} });
        const encryptedFriendListBody = await nxapiEncryptRequest(friendListUrl, tokenToUse, friendListBody);

        const resp = await proxyFetch(friendListUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/octet-stream',
                'Accept': 'application/octet-stream,application/json',
                'Accept-Language': 'en-GB',
                'Authorization': `Bearer ${tokenToUse}`,
                'X-ProductVersion': ZNCA_VERSION,
                'X-Platform': ZNCA_PLATFORM,
                'User-Agent': zncaUserAgent(),
                'Pragma': 'no-cache',
                'Cache-Control': 'no-cache'
            },
            bodyBase64: encryptedFriendListBody
        });

        const data = await parseCoralResponse(resp);
        if (data.result && data.result.friends) {
            renderFriendsList(data.result.friends);
        } else {
            friendContainers.forEach(container => {
                container.innerHTML = `<p class="service-status">No friends found: ${data.errorMessage || 'Unknown error'}</p>`;
            });
        }
    } catch (e) {
        friendContainers.forEach(container => {
            container.innerHTML = `<p class="service-status error">Error loading friends: ${e.message}</p>`;
        });
    }
}

function coralAccessToken() {
    return userSession?.result?.webApiServerCredential?.accessToken ||
        userSession?.webApiServerCredential?.accessToken || userSession?.accessToken || null;
}

async function coralCall(path, parameter = {}, options = {}) {
    const token = coralAccessToken();
    if (!token) throw new Error('No Coral access token is available. Sign in again.');

    const url = `https://api-lp1.znc.srv.nintendo.net${path}`;
    throwIfAborted(options.signal);
    const requestBody = options.body || { parameter };
    const requestOptions = { signal: options.signal, cancelKey: options.cancelKey };
    const encrypted = await nxapiEncryptRequest(url, token, JSON.stringify(requestBody), requestOptions);
    throwIfAborted(options.signal);
    const response = await proxyFetch(url, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/octet-stream',
            Accept: 'application/octet-stream,application/json',
            'Accept-Language': 'en-GB',
            Authorization: `Bearer ${token}`,
            'X-ProductVersion': ZNCA_VERSION,
            'X-Platform': ZNCA_PLATFORM,
            'User-Agent': zncaUserAgent()
        },
        bodyBase64: encrypted,
        signal: options.signal,
        cancelKey: options.cancelKey
    });
    const data = await parseCoralResponse(response, requestOptions);
    if (!response.ok || !data?.result) {
        throw new Error(data?.errorMessage || data?.error || `Nintendo API request failed (HTTP ${response.status}).`);
    }
    return data.result;
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
            container.innerHTML = '<p class="service-status">No game web services are available for this account.</p>';
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
            description.textContent = 'Available through Nintendo Switch Online';
            copy.append(title, description);
            const button = document.createElement('button');
            button.type = 'button';
            button.textContent = 'Connect';
            button.setAttribute('aria-label', `Open ${service.name}`);
            button.addEventListener('click', () => window.webServiceManager?.launchService(service, button));
            card.append(image, copy, button);
            container.appendChild(card);
        });
    } catch (e) {
        container.innerHTML = `<p class="service-status error">Could not load game services: ${e.message}</p>`;
    }
}

document.getElementById('closeInAppGameWebviewBtn')?.addEventListener('click', () => {
    window.webServiceManager?.closeActiveService();
});

document.getElementById('reloadInAppGameWebviewBtn')?.addEventListener('click', () => {
    window.webServiceManager?.reloadActiveService();
});

let selectedMediaSet = new Set();

function getMediaKey(item) {
    return item.id ? String(item.id) : item.contentUri;
}

function sanitizeFolderName(name) {
    if (!name || typeof name !== 'string') return 'Other';
    const clean = name.replace(/[<>:"/\\|?*]/g, '').trim();
    return clean || 'Other';
}

function getSwitchFilePath(item) {
    const timestamp = item.capturedAt || item.uploadedAt || Date.now();
    const ms = timestamp < 10_000_000_000 ? timestamp * 1000 : timestamp;
    const d = new Date(ms);
    const yyyy = String(d.getFullYear());
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    const hh = String(d.getHours()).padStart(2, '0');
    const min = String(d.getMinutes()).padStart(2, '0');
    const sec = String(d.getSeconds()).padStart(2, '0');
    const timePrefix = `${yyyy}${mm}${dd}${hh}${min}${sec}00`;
    const ext = item.type === 'video' ? 'mp4' : 'jpg';
    const folder = sanitizeFolderName(item.appName);
    const filename = `${timePrefix}_c.${ext}`;

    // Exact Nintendo Switch / Switch 2 PC USB transfer structure:
    // Album/<Game Name>/YYYYMMDDHHMMSS00_c.jpg (or .mp4)
    return `Album/${folder}/${filename}`;
}

function updateAlbumSelectionUI() {
    const totalSelected = selectedMediaSet.size;
    const downloadBtn = document.getElementById('albumDownloadZipBtn');
    const countBadge = document.getElementById('selectedCountBadge');
    const selectAllBtnText = document.getElementById('selectAllBtnText');

    if (downloadBtn) {
        downloadBtn.disabled = totalSelected === 0;
    }
    if (countBadge) {
        countBadge.textContent = totalSelected;
        countBadge.classList.toggle('hidden', totalSelected === 0);
    }
    if (selectAllBtnText) {
        if (currentMedia.length > 0 && totalSelected === currentMedia.length) {
            selectAllBtnText.textContent = 'Deselect All';
        } else {
            selectAllBtnText.textContent = totalSelected > 0 ? `Select All (${totalSelected})` : 'Select All';
        }
    }

    const albumGrid = document.getElementById('mediaGrid');
    if (albumGrid) {
        const cards = albumGrid.querySelectorAll('.media-item');
        cards.forEach((card, index) => {
            const item = currentMedia[index];
            if (item) {
                const isSelected = selectedMediaSet.has(getMediaKey(item));
                card.classList.toggle('is-selected', isSelected);
            }
        });
    }
}

function toggleSelectMedia(item) {
    const key = getMediaKey(item);
    if (selectedMediaSet.has(key)) {
        selectedMediaSet.delete(key);
    } else {
        selectedMediaSet.add(key);
    }
    updateAlbumSelectionUI();
}

function toggleSelectAllAlbum() {
    if (!currentMedia || currentMedia.length === 0) return;
    if (selectedMediaSet.size === currentMedia.length) {
        selectedMediaSet.clear();
    } else {
        selectedMediaSet.clear();
        currentMedia.forEach(item => selectedMediaSet.add(getMediaKey(item)));
    }
    updateAlbumSelectionUI();
}

async function downloadSelectedAlbumZip() {
    if (selectedMediaSet.size === 0) return;
    if (typeof JSZip === 'undefined') {
        alert('Zip library is still loading. Please try again in a moment.');
        return;
    }

    const downloadBtn = document.getElementById('albumDownloadZipBtn');
    const originalContent = downloadBtn.innerHTML;
    downloadBtn.disabled = true;

    const itemsToDownload = currentMedia.filter(item => selectedMediaSet.has(getMediaKey(item)));
    const total = itemsToDownload.length;
    const zip = new JSZip();

    try {
        for (let i = 0; i < total; i++) {
            const item = itemsToDownload[i];
            downloadBtn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> <span>Downloading ${i + 1}/${total}...</span>`;

            const response = await proxyFetch(item.contentUri);
            if (!response.ok) throw new Error(`Failed to download ${item.appName || 'capture'} (HTTP ${response.status})`);
            const blob = await response.blob();
            const filePath = getSwitchFilePath(item);
            zip.file(filePath, blob);
        }

        downloadBtn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> <span>Packaging ZIP...</span>`;
        const zipBlob = await zip.generateAsync({
            type: 'blob',
            compression: 'DEFLATE',
            compressionOptions: { level: 6 }
        });

        const downloadUrl = URL.createObjectURL(zipBlob);
        const anchor = document.createElement('a');
        anchor.href = downloadUrl;
        anchor.download = `Nintendo_Switch_Album_${new Date().toISOString().slice(0, 10)}.zip`;
        anchor.click();
        setTimeout(() => URL.revokeObjectURL(downloadUrl), 30_000);
    } catch (error) {
        alert(`ZIP Download Failed: ${error.message}`);
    } finally {
        downloadBtn.disabled = selectedMediaSet.size === 0;
        downloadBtn.innerHTML = originalContent;
        updateAlbumSelectionUI();
    }
}

document.getElementById('albumSelectAllBtn')?.addEventListener('click', toggleSelectAllAlbum);
document.getElementById('albumDownloadZipBtn')?.addEventListener('click', downloadSelectedAlbumZip);

function renderMediaCards(container, items, isAlbumPage = false) {
    container.innerHTML = '';
    items.forEach(item => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'media-item';
        const key = getMediaKey(item);
        if (isAlbumPage && selectedMediaSet.has(key)) {
            button.classList.add('is-selected');
        }
        const title = item.appName || 'Nintendo Switch capture';
        button.innerHTML = `
            ${isAlbumPage ? '<button class="media-select-check" type="button" aria-label="Select item"><i class="fa-solid fa-check"></i></button>' : ''}
            <div class="media-thumb-wrap">
                <img src="${item.thumbnailUri || item.contentUri}" alt="${title}" loading="lazy">
                ${item.type === 'video' ? '<span class="video-badge"><i class="fa-solid fa-play"></i></span>' : ''}
            </div>
            <span class="media-title">${title}</span>
        `;

        if (isAlbumPage) {
            const checkBtn = button.querySelector('.media-select-check');
            checkBtn?.addEventListener('click', (e) => {
                e.stopPropagation();
                toggleSelectMedia(item);
            });
        }

        button.addEventListener('click', () => {
            if (isAlbumPage && selectedMediaSet.size > 0) {
                toggleSelectMedia(item);
            } else {
                openMediaViewer(item);
            }
        });

        container.appendChild(button);
    });
}

function renderMediaLists(media) {
    const homeContainer = document.getElementById('homeMediaGrid');
    const albumContainer = document.getElementById('mediaGrid');
    const recentMedia = media.slice(0, 5);

    if (homeContainer) {
        if (recentMedia.length) {
            renderMediaCards(homeContainer, recentMedia, false);
        } else {
            homeContainer.innerHTML = '<p class="service-status">No uploaded Switch media is available.</p>';
        }
    }

    if (albumContainer) {
        if (media.length) {
            renderMediaCards(albumContainer, media, true);
            updateAlbumSelectionUI();
        } else {
            albumContainer.innerHTML = '<p class="service-status">No uploaded Switch media is available.</p>';
        }
    }
}

async function loadSwitchMedia() {
    const mediaContainers = ['homeMediaGrid', 'mediaGrid'].map(id => document.getElementById(id));
    if (!userSession) return;
    mediaContainers.forEach(container => {
        container.innerHTML = Array.from({ length: 5 }, () => '<div class="media-loading-tile"></div>').join('');
    });
    try {
        const result = await coralCall('/v4/Media/List');
        const media = result.media || [];
        currentMedia = media;
        renderMediaLists(media);
    } catch (e) {
        mediaContainers.forEach(container => {
            container.innerHTML = `<p class="service-status error">Could not load media: ${e.message}</p>`;
        });
    }
}

function openMediaViewer(item) {
    activeMediaItem = item;
    const title = item.appName || 'Nintendo Switch capture';
    const titleEl = document.getElementById('mediaModalTitle');
    if (titleEl) titleEl.textContent = title;
    const content = document.getElementById('mediaModalContent');
    if (content) {
        content.innerHTML = '';
        const media = document.createElement(item.type === 'video' ? 'video' : 'img');
        media.src = item.contentUri;
        if (item.type === 'video') {
            media.controls = true;
            media.autoplay = true;
            media.playsInline = true;
        } else {
            media.alt = title;
        }
        content.append(media);
    }
    document.getElementById('mediaModalMeta')?.classList.add('hidden');
    document.getElementById('mediaModal')?.classList.remove('hidden');

    // Prevent background scrolling while media viewer is open
    document.body.style.overflow = 'hidden';
    document.documentElement.style.overflow = 'hidden';
}

function closeMediaViewer() {
    const modal = document.getElementById('mediaModal');
    if (modal) modal.classList.add('hidden');
    const content = document.getElementById('mediaModalContent');
    if (content) {
        const video = content.querySelector('video');
        if (video) video.pause();
        content.innerHTML = '';
    }
    activeMediaItem = null;

    // Restore background scrolling
    document.body.style.overflow = '';
    document.documentElement.style.overflow = '';
}

document.getElementById('closeMediaModalBtn')?.addEventListener('click', closeMediaViewer);
document.getElementById('mediaInfoBtn')?.addEventListener('click', showActiveMediaInfo);
document.getElementById('mediaShareBtn')?.addEventListener('click', shareActiveMedia);
document.getElementById('mediaDownloadBtn')?.addEventListener('click', downloadActiveMedia);

document.getElementById('mediaModal')?.addEventListener('click', (e) => {
    if (e.target.id === 'mediaModal') {
        closeMediaViewer();
    }
});

document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !document.getElementById('mediaModal')?.classList.contains('hidden')) {
        closeMediaViewer();
    }
});

function formatMediaDate(timestamp) {
    if (!timestamp) return 'Not available';
    const milliseconds = timestamp < 10_000_000_000 ? timestamp * 1000 : timestamp;
    return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(milliseconds));
}

function showActiveMediaInfo() {
    if (!activeMediaItem) return;
    const meta = document.getElementById('mediaModalMeta');
    meta.innerHTML = '';
    const rows = [
        ['Software', activeMediaItem.appName || 'Nintendo Switch'],
        ['Type', activeMediaItem.type === 'video' ? 'Video' : 'Screenshot'],
        ['Captured', formatMediaDate(activeMediaItem.capturedAt)],
        ['Uploaded', formatMediaDate(activeMediaItem.uploadedAt)],
        ['Expires', formatMediaDate(activeMediaItem.expiresAt)]
    ];
    for (const [label, value] of rows) {
        const row = document.createElement('p');
        const strong = document.createElement('strong');
        strong.textContent = label;
        row.append(strong, document.createTextNode(value));
        meta.append(row);
    }
    meta.classList.toggle('hidden');
}

async function shareActiveMedia() {
    if (!activeMediaItem) return;
    const shareData = { title: activeMediaItem.appName || 'Nintendo Switch capture', url: activeMediaItem.contentUri };
    if (navigator.share) {
        try {
            await navigator.share(shareData);
            return;
        } catch (error) {
            if (error.name === 'AbortError') return;
        }
    }
    try {
        await navigator.clipboard.writeText(activeMediaItem.contentUri);
        alert('Capture link copied to the clipboard.');
    } catch {
        window.open(activeMediaItem.contentUri, '_blank', 'noopener');
    }
}

async function downloadActiveMedia() {
    if (!activeMediaItem) return;
    const button = document.getElementById('mediaDownloadBtn');
    button.disabled = true;
    try {
        const response = await proxyFetch(activeMediaItem.contentUri);
        if (!response.ok) throw new Error(`Download failed (HTTP ${response.status}).`);
        const blob = await response.blob();
        const objectUrl = URL.createObjectURL(blob);
        const extension = activeMediaItem.type === 'video' ? 'mp4' : 'jpg';
        const anchor = document.createElement('a');
        anchor.href = objectUrl;
        anchor.download = `nintendo-switch-${activeMediaItem.id || Date.now()}.${extension}`;
        anchor.click();
        setTimeout(() => URL.revokeObjectURL(objectUrl), 30_000);
    } catch (error) {
        alert(error.message);
    } finally {
        button.disabled = false;
    }
}

function friendPresencePlatformLabel(presence) {
    const raw = presence?.platform;
    const normalized = String(raw ?? '').trim().toUpperCase().replace(/[\s-]+/g, '_');
    if (raw === 2 || normalized === '2' || normalized === 'OUNCE' ||
        normalized === 'NINTENDO_SWITCH_2' || normalized === 'SWITCH_2' || normalized === 'SWITCH2') {
        return 'Nintendo Switch 2';
    }
    if (raw === 1 || normalized === '1' || normalized === 'NX' ||
        normalized === 'NINTENDO_SWITCH' || normalized === 'SWITCH') {
        return 'Nintendo Switch';
    }
    return 'Nintendo Switch';
}

function getFriendPresenceInfo(friend) {
    const presence = friend?.presence || {};
    const state = String(presence.state || friend?.state || '').toUpperCase();
    const isOnline = Boolean(friend?.isOnline) || state === 'ONLINE' || state === 'PLAYING';
    const game = presence?.game && typeof presence.game === 'object' ? presence.game : null;
    return {
        presence,
        state,
        isOnline,
        game,
        platformLabel: friendPresencePlatformLabel(presence)
    };
}

function renderFriendDetailPresence(friend) {
    const host = document.getElementById('friendDetailPresence');
    if (!host) return;
    host.replaceChildren();

    const info = getFriendPresenceInfo(friend);
    host.classList.toggle('has-current-game', Boolean(info.isOnline && info.game?.name));

    if (!info.isOnline || !info.game?.name) {
        const status = document.createElement('span');
        status.className = info.isOnline ? 'friend-detail-presence-online-text' : 'friend-detail-presence-offline-text';
        status.textContent = info.isOnline ? `Online (${info.platformLabel})` : 'Offline';
        host.appendChild(status);
        return;
    }

    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'friend-detail-current-game';
    row.setAttribute('aria-label', `Open ${info.game.name}`);

    const image = document.createElement('img');
    image.src = info.game.imageUri || '';
    image.alt = '';
    image.loading = 'eager';
    image.addEventListener('error', () => image.classList.add('friend-detail-current-game-image-missing'));

    const copy = document.createElement('span');
    copy.className = 'friend-detail-current-game-copy';

    const online = document.createElement('span');
    online.className = 'friend-detail-current-game-online';
    online.textContent = `Online (${info.platformLabel})`;

    const title = document.createElement('strong');
    title.textContent = info.game.name;

    copy.append(online, title);
    row.append(image, copy);
    row.addEventListener('click', () => openGameSheet({
        name: info.game.name || 'Game',
        imageUri: info.game.imageUri || '',
        shopUri: info.game.shopUri || ''
    }));
    host.appendChild(row);
}

function renderFriendsList(friends) {
    currentFriends = friends || [];
    renderFriendsInto(document.getElementById('homeFriendsGrid'), currentFriends.slice(0, 8));
    renderFriendsInto(document.getElementById('friendsGrid'), currentFriends);
    const totalCountEl = document.getElementById('totalCount');
    if (totalCountEl) totalCountEl.textContent = currentFriends.length;
}

function renderFriendsInto(container, friends) {
    if (!container) return;
    container.innerHTML = '';
    if (!friends || friends.length === 0) {
        container.innerHTML = '<p style="color:var(--text-secondary);padding:20px 0;">No friends added to your Nintendo Switch account yet.</p>';
        return;
    }

    friends.forEach(f => {
        const presenceInfo = getFriendPresenceInfo(f);
        const presence = presenceInfo.presence;
        const isOnline = presenceInfo.isOnline;
        const presenceName = presenceInfo.game?.name || presence.name || '';
        const card = document.createElement('button');
        card.type = 'button';
        card.className = 'friend-card';

        let statusText = 'Offline';
        if (isOnline) {
            statusText = presenceName || 'Online';
        } else {
            const rawTs = presence.updatedAt || presence.logoutAt || f.updatedAt || f.logoutAt;
            if (rawTs) {
                const tsSec = typeof rawTs === 'number' ? (rawTs > 1e11 ? Math.floor(rawTs / 1000) : rawTs) : Math.floor(Date.parse(rawTs) / 1000);
                if (!isNaN(tsSec) && tsSec > 0) {
                    const diffSec = Math.floor(Date.now() / 1000) - tsSec;
                    if (diffSec > 0) {
                        if (diffSec < 60) statusText = 'Just now';
                        else if (diffSec < 3600) statusText = `${Math.floor(diffSec / 60)}m ago`;
                        else if (diffSec < 86400) statusText = `${Math.floor(diffSec / 3600)}h ago`;
                        else if (diffSec < 2592000) statusText = `${Math.floor(diffSec / 86400)}d ago`;
                        else if (diffSec < 31536000) statusText = `${Math.floor(diffSec / 2592000)}mo ago`;
                    }
                }
            }
            if (statusText === 'Offline' && f.statusText) {
                statusText = f.statusText;
            }
        }

        card.innerHTML = `
            <div class="friend-avatar-wrap">
                <img src="${f.imageUri || f.image_url || 'https://cdn-icons-png.flaticon.com/512/808/808439.png'}" alt="${f.name}">
            </div>
            <div class="friend-info">
                <div class="friend-name">${f.name}</div>
                ${isOnline ? `<div class="friend-online-platform">Online (${presenceInfo.platformLabel})</div>` : ''}
                <div class="friend-game ${isOnline && presenceName ? 'friend-game-playing' : ''}">${isOnline && presenceName ? presenceName : statusText}</div>
            </div>
        `;
        card.addEventListener('click', () => openFriendDetail(f));
        container.appendChild(card);
    });
}

function formatBecameFriendsRoute(route) {
    if (!route) return 'By exchanging friend codes.';
    const channel = typeof route === 'string' ? route : (route.channel || '');
    switch (channel) {
        case 'NX_FACED':
            return 'By searching for local users.';
        case 'IN_APP':
            return route.userName ? `In-Game Name: ${route.userName}` : "By playing together in a game.";
        case '3DS':
            return 'Nintendo 3DS';
        case 'NNID':
            return 'Wii U';
        case 'CAMPUS':
            return 'GameChat';
        case 'NINTENDO_ACCOUNT':
            return route.appName || 'Nintendo Account';
        case 'FRIEND_CODE':
        default:
            return 'By exchanging friend codes.';
    }
}

function formatBecameFriendsDate(timestamp) {
    if (!timestamp) return '—';
    let ms = Number(timestamp);
    if (isNaN(ms) || ms <= 0) return '—';
    if (ms < 1e11) ms *= 1000;
    const d = new Date(ms);
    const pad = n => String(n).padStart(2, '0');
    return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

async function openFriendDetail(friend) {
    activeFriendDetailData = friend;
    navTabStacks.friends = 'detail';
    const activePageEl = document.querySelector('.tab-page.active');
    friendDetailOriginTab = activePageEl?.id === 'page-home' ? 'home' : 'friends';

    const presenceInfo = getFriendPresenceInfo(friend);
    const isOnline = presenceInfo.isOnline;
    const presence = presenceInfo.game?.name || friend.presence?.name || '';
    document.getElementById('friendDetailAvatar').src = friend.imageUri || friend.image_url || '';
    document.getElementById('friendDetailAvatar').alt = friend.name || 'Friend';
    document.getElementById('friendDetailName').textContent = friend.name || 'Friend';
    renderFriendDetailPresence(friend);

    // Populate How / When you became friends metadata
    const howBecameEl = document.getElementById('friendDetailHowBecame');
    if (howBecameEl) {
        howBecameEl.textContent = formatBecameFriendsRoute(friend.route || friend.howBecameFriend);
    }
    const whenBecameEl = document.getElementById('friendDetailWhenBecame');
    if (whenBecameEl) {
        whenBecameEl.textContent = formatBecameFriendsDate(friend.friendCreatedAt || friend.becameFriendAt || friend.createdAt);
    }

    const activity = document.getElementById('friendDetailActivity');
    activity.innerHTML = '<div style="color:#aaaab0;font-size:13px;padding:12px 0">Loading play activity…</div>';
    slideViewIn(document.getElementById('friendDetailView'));

    try {
        if (!friend.nsaId) {
            if (presence) {
                activity.innerHTML = `
                    <div class="friend-activity-list">
                        <div class="friend-activity-row">
                            <img src="${friend.presence?.imageUri || friend.presence?.game?.imageUri || friend.imageUri || friend.image_url || ''}" alt="">
                            <div>
                                <strong>${presence}</strong>
                                <span class="${isOnline ? 'playtime-highlight' : 'playtime-normal'}">${isOnline ? 'Playing now' : 'Recently played'}</span>
                            </div>
                        </div>
                    </div>
                `;
            } else {
                activity.textContent = 'No play activity is available.';
            }
            return;
        }

        const result = await coralCall('/v4/User/PlayLog/Show', { nsaId: friend.nsaId });
        const playLogs = Array.isArray(result) ? result : (result?.playLogs || []);
        if (playLogs.length > 0) {
            activity.innerHTML = '<div class="friend-activity-list"></div>';
            const list = activity.firstElementChild;
            playLogs.forEach(log => {
                const hours = Math.round((log.totalPlayTime || 0) / 60);
                const isOver50 = hours >= 50;
                let playText = 'Played for a little while';
                if (hours > 0) {
                    playText = `Played for ${hours} hour(s) or more`;
                }

                const row = document.createElement('div');
                row.className = 'friend-activity-row clickable';
                row.innerHTML = `
                    <img src="${log.imageUri || ''}" alt="" onerror="this.style.display='none'">
                    <div>
                        <strong>${log.name || 'Game'}</strong>
                        <span class="${isOver50 ? 'playtime-highlight' : 'playtime-normal'}">${playText}</span>
                    </div>
                `;
                row.addEventListener('click', () => openGameSheet({
                    name: log.name || 'Game',
                    imageUri: log.imageUri || '',
                    shopUri: log.shopUri || ''
                }));
                list.appendChild(row);
            });
        } else if (presence) {
            activity.innerHTML = `
                <div class="friend-activity-list">
                    <div class="friend-activity-row">
                        <img src="${friend.presence?.imageUri || friend.presence?.game?.imageUri || friend.imageUri || friend.image_url || ''}" alt="">
                        <div>
                            <strong>${presence}</strong>
                            <span class="${isOnline ? 'playtime-highlight' : 'playtime-normal'}">${isOnline ? 'Playing now' : 'Recently played'}</span>
                        </div>
                    </div>
                </div>
            `;
        } else {
            activity.textContent = 'No play activity is available.';
        }
    } catch (e) {
        if (presence) {
            activity.innerHTML = `
                <div class="friend-activity-list">
                    <div class="friend-activity-row">
                        <img src="${friend.presence?.imageUri || friend.presence?.game?.imageUri || friend.imageUri || friend.image_url || ''}" alt="">
                        <div>
                            <strong>${presence}</strong>
                            <span class="${isOnline ? 'playtime-highlight' : 'playtime-normal'}">${isOnline ? 'Playing now' : 'Recently played'}</span>
                        </div>
                    </div>
                </div>
            `;
        } else {
            activity.textContent = 'Play activity is set to private or not available.';
        }
    }
}

// Game detail bottom sheet
function openGameSheet(game) {
    const overlay = document.getElementById('gameSheetOverlay');
    const sheet = document.getElementById('gameSheet');
    const img = document.getElementById('gameSheetImg');
    const name = document.getElementById('gameSheetName');
    const link = document.getElementById('gameSheetLink');

    img.src = game.imageUri || '';
    img.alt = game.name || 'Game';
    name.textContent = game.name || 'Game';

    if (game.shopUri) {
        link.href = game.shopUri;
        link.style.display = '';
    } else {
        link.style.display = 'none';
    }

    sheet.classList.remove('sheet-closing');
    overlay.classList.remove('hidden');
}

function closeGameSheet() {
    const overlay = document.getElementById('gameSheetOverlay');
    const sheet = document.getElementById('gameSheet');
    sheet.classList.add('sheet-closing');
    sheet.addEventListener('animationend', () => {
        overlay.classList.add('hidden');
        sheet.classList.remove('sheet-closing');
    }, { once: true });
}

document.getElementById('gameSheetOverlay')?.addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closeGameSheet();
});

document.getElementById('closeMediaModalBtn').addEventListener('click', () => {
    document.getElementById('mediaModal').classList.add('hidden');
    document.getElementById('mediaModalContent').innerHTML = '';
    document.getElementById('mediaModalMeta').classList.add('hidden');
    activeMediaItem = null;
});

document.getElementById('mediaInfoBtn').addEventListener('click', showActiveMediaInfo);
document.getElementById('mediaShareBtn').addEventListener('click', shareActiveMedia);
document.getElementById('mediaDownloadBtn').addEventListener('click', downloadActiveMedia);

document.getElementById('closeFriendDetailBtn')?.addEventListener('click', () => {
    navTabStacks.friends = 'list';
    activeFriendDetailData = null;
    const originTab = friendDetailOriginTab || 'friends';
    slideViewOut(document.getElementById('friendDetailView'), () => {
        applyTabViewState(originTab);
    });
});

document.getElementById('closeNotificationBtn')?.addEventListener('click', () => {
    navTabStacks.home = 'home';
    slideViewOut(document.getElementById('notificationView'));
});

document.getElementById('closeProfileBtn')?.addEventListener('click', () => {
    navTabStacks.home = 'home';
    slideViewOut(document.getElementById('profileView'));
});

// Friend Settings Screen Navigation (Screenshots 2, 3, 4, 5)
document.getElementById('openFriendSettingsBtn')?.addEventListener('click', () => {
    slideViewIn(document.getElementById('friendSettingsView'));
});

document.getElementById('closeFriendSettingsBtn')?.addEventListener('click', () => {
    slideViewOut(document.getElementById('friendSettingsView'));
});

document.getElementById('openNotifySettingBtn')?.addEventListener('click', () => {
    slideViewIn(document.getElementById('friendSettingsNotifyView'));
});

document.getElementById('closeNotifySettingBtn')?.addEventListener('click', () => {
    slideViewOut(document.getElementById('friendSettingsNotifyView'));
});

document.getElementById('openRequestsSettingBtn')?.addEventListener('click', () => {
    slideViewIn(document.getElementById('friendSettingsRequestsView'));
});

document.getElementById('closeRequestsSettingBtn')?.addEventListener('click', () => {
    slideViewOut(document.getElementById('friendSettingsRequestsView'));
});

document.getElementById('openBlockedSettingBtn')?.addEventListener('click', () => {
    slideViewIn(document.getElementById('friendSettingsBlockedView'));
});

document.getElementById('closeBlockedSettingBtn')?.addEventListener('click', () => {
    slideViewOut(document.getElementById('friendSettingsBlockedView'));
});

document.getElementById('changeNotifySettingBtn')?.addEventListener('click', () => {
    const label = document.getElementById('notifyStatusLabel');
    if (label) {
        const isDis = label.textContent.includes('disabled');
        label.textContent = isDis ? 'Notifications enabled' : 'Notifications disabled';
    }
});

// In-App Game Web Service Controls
document.getElementById('closeInAppGameWebviewBtn')?.addEventListener('click', () => {
    document.documentElement.classList.remove('webview-active');
    document.body.classList.remove('webview-active');
    const overlay = document.getElementById('inAppGameWebview');
    const iframe = document.getElementById('inAppGameWebviewFrame');
    if (overlay) overlay.classList.add('hidden');
    if (iframe) iframe.src = 'about:blank';
});

document.getElementById('reloadInAppGameWebviewBtn')?.addEventListener('click', () => {
    const iframe = document.getElementById('inAppGameWebviewFrame');
    if (iframe) {
        try {
            iframe.contentWindow?.location.reload();
        } catch (e) {
            iframe.src = iframe.src;
        }
    }
});

// Add Friend Menu (Screenshot 1 & 5)
document.getElementById('openAddFriendBtn')?.addEventListener('click', () => {
    slideViewIn(document.getElementById('addFriendView'));
});

document.getElementById('closeAddFriendBtn')?.addEventListener('click', () => {
    slideViewOut(document.getElementById('addFriendView'));
});

document.getElementById('openSearchByFriendCodeBtn')?.addEventListener('click', () => {
    slideViewIn(document.getElementById('searchByFriendCodeView'));
    const input = document.getElementById('friendCodeInput');
    if (input) {
        input.focus();
    }
});

document.getElementById('closeSearchByFriendCodeBtn')?.addEventListener('click', () => {
    slideViewOut(document.getElementById('searchByFriendCodeView'));
    document.getElementById('fcResultSheet')?.classList.add('hidden');
});

// Format Friend Code Input as XXXX XXXX XXXX
let activeSearchedFriend = null;
const friendCodeInput = document.getElementById('friendCodeInput');
const searchFriendCodeBtn = document.getElementById('searchFriendCodeBtn');
const fcInputBox = document.getElementById('fcInputBox');

friendCodeInput?.addEventListener('input', (e) => {
    let val = e.target.value.replace(/[^0-9]/g, '');
    if (val.length > 12) val = val.slice(0, 12);
    
    // Group in 4s
    const parts = [];
    for (let i = 0; i < val.length; i += 4) {
        parts.push(val.slice(i, i + 4));
    }
    e.target.value = parts.join(' ');

    if (val.length === 12) {
        searchFriendCodeBtn.disabled = false;
        searchFriendCodeBtn.classList.remove('disabled');
        fcInputBox?.classList.add('active-focused');
    } else {
        searchFriendCodeBtn.disabled = true;
        searchFriendCodeBtn.classList.add('disabled');
        fcInputBox?.classList.remove('active-focused');
        document.getElementById('fcResultSheet')?.classList.add('hidden');
    }
});

searchFriendCodeBtn?.addEventListener('click', async () => {
    const raw = friendCodeInput.value.replace(/[^0-9]/g, '');
    if (raw.length !== 12) return;

    searchFriendCodeBtn.disabled = true;
    searchFriendCodeBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Searching...';

    try {
        const formattedCode = `${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 12)}`;
        const result = await coralCall('/v3/Friend/GetUserByFriendCode', { friendCode: formattedCode });
        activeSearchedFriend = {
            name: result?.name || 'Switch Player',
            friendCode: `SW-${formattedCode}`,
            imageUri: result?.imageUri || 'https://cdn-icons-png.flaticon.com/512/808/808439.png',
            rawCode: raw,
            nsaId: result?.nsaId
        };

        document.getElementById('fcResultAvatar').src = activeSearchedFriend.imageUri;
        document.getElementById('fcResultName').textContent = activeSearchedFriend.name;
        document.getElementById('fcResultCode').textContent = activeSearchedFriend.friendCode;
        document.getElementById('fcResultSheet').classList.remove('hidden');
    } catch (e) {
        alert(`Friend search failed: ${e.message}`);
    } finally {
        searchFriendCodeBtn.disabled = false;
        searchFriendCodeBtn.textContent = 'Search';
    }
});

// Send Friend Request (Screenshot 4 -> 5)
const sentFriendRequests = [];
document.getElementById('sendFriendRequestBtn')?.addEventListener('click', async () => {
    if (!activeSearchedFriend) return;
    const sendBtn = document.getElementById('sendFriendRequestBtn');
    sendBtn.disabled = true;
    sendBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Sending Request...';

    try {
        const now = new Date();
        const dateStr = `${String(now.getDate()).padStart(2, '0')}/${String(now.getMonth() + 1).padStart(2, '0')}/${now.getFullYear()} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

        if (coralAccessToken() && activeSearchedFriend.nsaId) {
            try {
                await coralCall('/v3/FriendRequest/Create', { nsaId: activeSearchedFriend.nsaId });
            } catch (err) {
                console.warn('Coral FriendRequest/Create note:', err);
            }
        }

        sentFriendRequests.unshift({
            name: activeSearchedFriend.name,
            friendCode: activeSearchedFriend.friendCode,
            imageUri: activeSearchedFriend.imageUri,
            dateStr: dateStr,
            nsaId: activeSearchedFriend.nsaId,
            source: 'By exchanging friend codes.'
        });

        renderSentFriendRequests();

        // Close search and return to Add Friend screen
        document.getElementById('fcResultSheet').classList.add('hidden');
        document.getElementById('searchByFriendCodeView').classList.add('hidden');
        document.getElementById('addFriendView').classList.remove('hidden');
        friendCodeInput.value = '';
        searchFriendCodeBtn.disabled = true;
        searchFriendCodeBtn.classList.add('disabled');
        fcInputBox?.classList.remove('active-focused');
    } catch (e) {
        alert(`Could not send friend request: ${e.message}`);
    } finally {
        sendBtn.disabled = false;
        sendBtn.textContent = 'Send Friend Request';
    }
});

function renderSentFriendRequests() {
    const emptyText = document.getElementById('sentRequestsEmptyText');
    const list = document.getElementById('sentRequestsList');
    if (!list) return;

    if (sentFriendRequests.length === 0) {
        if (emptyText) emptyText.classList.remove('hidden');
        list.classList.add('hidden');
        list.innerHTML = '';
        return;
    }

    if (emptyText) emptyText.classList.add('hidden');
    list.classList.remove('hidden');
    list.innerHTML = '';

    sentFriendRequests.forEach(req => {
        const item = document.createElement('button');
        item.type = 'button';
        item.className = 'sent-request-card';
        item.innerHTML = `
            <img src="${req.imageUri}" alt="${req.name}" class="sent-request-avatar">
            <div class="sent-request-info">
                <strong>${req.name}</strong>
                <span>${req.dateStr}</span>
            </div>
        `;
        item.addEventListener('click', () => openSentRequestDetail(req));
        list.appendChild(item);
    });
}

let activeSentRequest = null;

async function openSentRequestDetail(req) {
    activeSentRequest = req;
    document.getElementById('sentReqDropdown')?.classList.add('hidden');
    document.getElementById('sentReqDetailAvatar').src = req.imageUri || 'https://cdn-icons-png.flaticon.com/512/808/808439.png';
    document.getElementById('sentReqDetailName').textContent = req.name || 'Friend';
    document.getElementById('sentReqDetailSource').textContent = req.source || 'By exchanging friend codes.';
    document.getElementById('sentReqDetailDate').textContent = req.dateStr || new Date().toLocaleString('en-GB');

    const activityList = document.getElementById('sentReqDetailActivityList');
    if (!activityList) return;
    activityList.innerHTML = '<div style="padding:16px;color:#88888c;font-size:13px">Loading play activity…</div>';
    slideViewIn(document.getElementById('sentReqDetailView'));

    try {
        let playLogs = [];
        if (req.nsaId && coralAccessToken()) {
            const result = await coralCall('/v4/User/PlayLog/Show', { nsaId: req.nsaId });
            playLogs = Array.isArray(result) ? result : (result?.playLogs || []);
        } else if (req.playLogs) {
            playLogs = req.playLogs;
        }

        if (playLogs.length > 0) {
            activityList.innerHTML = '';
            playLogs.forEach(log => {
                const hours = Math.round((log.totalPlayTime || 0) / 60);
                const item = document.createElement('div');
                item.className = 'req-activity-item';
                item.innerHTML = `
                    <img src="${log.imageUri || ''}" alt="" onerror="this.style.display='none'">
                    <div class="req-activity-item-info">
                        <strong>${log.name || 'Game'}</strong>
                        <span class="${hours > 0 ? '' : 'muted'}">${hours > 0 ? `Played for ${hours} hour(s) or more` : 'Played for a little while'}</span>
                    </div>
                `;
                activityList.appendChild(item);
            });
        } else {
            activityList.innerHTML = '<div style="padding:16px;color:#88888c;font-size:13px">No play activity is available.</div>';
        }
    } catch (e) {
        activityList.innerHTML = '<div style="padding:16px;color:#88888c;font-size:13px">Play activity is set to private or not available.</div>';
    }
}

document.getElementById('closeSentReqDetailBtn')?.addEventListener('click', () => {
    slideViewOut(document.getElementById('sentReqDetailView'));
    document.getElementById('sentReqDropdown')?.classList.add('hidden');
    activeSentRequest = null;
});

// Toggle 3-dots more menu on Sent Request Detail
document.getElementById('sentReqMoreBtn')?.addEventListener('click', (e) => {
    e.stopPropagation();
    document.getElementById('sentReqDropdown')?.classList.toggle('hidden');
});

// Close dropdown on outside click
document.addEventListener('click', (e) => {
    if (!e.target.closest('.req-detail-menu-wrap')) {
        document.getElementById('sentReqDropdown')?.classList.add('hidden');
    }
});

// Delete Sent Friend Request
document.getElementById('deleteSentReqBtn')?.addEventListener('click', async () => {
    if (!activeSentRequest) return;
    
    if (coralAccessToken() && activeSentRequest.requestId) {
        try {
            await coralCall('/v3/FriendRequest/Delete', { requestId: activeSentRequest.requestId });
        } catch (err) {
            console.warn('Coral FriendRequest delete note:', err);
        }
    }

    const idx = sentFriendRequests.indexOf(activeSentRequest);
    if (idx !== -1) {
        sentFriendRequests.splice(idx, 1);
    }

    renderSentFriendRequests();
    document.getElementById('sentReqDropdown')?.classList.add('hidden');
    document.getElementById('sentReqDetailView')?.classList.add('hidden');
    activeSentRequest = null;
});





// ---------------------------------------------------------------------------
// Friends features
// ---------------------------------------------------------------------------
/**
 * Friends requests, privacy, blocked-user, QR and GameChat controls wired directly to Coral.
 */
(() => {
    'use strict';

    const state = {
        receivedRequests: [],
        sentRequests: [],
        blockedUsers: [],
        permissions: null,
        qrLibraryPromise: null,
        chatCandidates: []
    };

    const $ = (id) => document.getElementById(id);

    function coral(path, parameter = {}, options = {}) {
        if (typeof coralCall !== 'function') {
            throw new Error('Coral is not ready. Sign in again and reload the page.');
        }
        return coralCall(path, parameter, options);
    }

    function escapeHtml(value) {
        return String(value ?? '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    }

    function toMillis(value) {
        if (!value) return 0;
        if (typeof value === 'number') return value < 10_000_000_000 ? value * 1000 : value;
        const parsed = Date.parse(value);
        return Number.isFinite(parsed) ? parsed : 0;
    }

    function formatDate(value) {
        const ms = toMillis(value);
        if (!ms) return '';
        try {
            return new Intl.DateTimeFormat(undefined, {
                dateStyle: 'medium',
                timeStyle: 'short'
            }).format(new Date(ms));
        } catch {
            return new Date(ms).toLocaleString();
        }
    }

    function requestId() {
        if (globalThis.crypto?.randomUUID) return crypto.randomUUID();
        return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    }

    function showToast(message) {
        let toast = $('friendsFunctionalToast');
        if (!toast) {
            toast = document.createElement('div');
            toast.id = 'friendsFunctionalToast';
            toast.className = 'friends-functional-toast';
            document.body.appendChild(toast);
        }
        toast.textContent = message;
        toast.classList.add('show');
        clearTimeout(showToast.timer);
        showToast.timer = setTimeout(() => toast.classList.remove('show'), 2200);
    }

    async function runButton(button, work, successMessage = '') {
        if (!button || button.dataset.busy === 'true') return undefined;
        const oldDisabled = button.disabled;
        button.dataset.busy = 'true';
        button.disabled = true;
        try {
            const result = await work();
            if (successMessage) showToast(successMessage);
            return result;
        } finally {
            delete button.dataset.busy;
            button.disabled = oldDisabled;
        }
    }

    function refreshFriends() {
        if (typeof loadLiveFriendsList === 'function') {
            Promise.resolve(loadLiveFriendsList()).catch((error) => {
                console.warn('[Friends] Could not refresh friends', error);
            });
        }
    }

    function getCurrentFriends() {
        try {
            return Array.isArray(currentFriends) ? currentFriends : [];
        } catch {
            return [];
        }
    }

    function getLegacySentRequests() {
        try {
            return Array.isArray(sentFriendRequests) ? sentFriendRequests : null;
        } catch {
            return null;
        }
    }

    function getActiveSearchedFriend() {
        try {
            return typeof activeSearchedFriend !== 'undefined' ? activeSearchedFriend : null;
        } catch {
            return null;
        }
    }

    function clearActiveSearchedFriend() {
        try {
            activeSearchedFriend = null;
        } catch {}
    }

    function getActiveSentRequest() {
        try {
            return typeof activeSentRequest !== 'undefined' ? activeSentRequest : null;
        } catch {
            return null;
        }
    }

    async function loadPermissions() {
        const toggle = $('receiveRequestsToggle');
        if (toggle) toggle.disabled = true;
        try {
            state.permissions = await coral('/v3/User/Permissions/ShowSelf', {}, {
                body: { requestId: requestId() }
            });
            const value = state.permissions?.permissions?.friendRequestReception;
            if (toggle && typeof value === 'boolean') toggle.checked = value;
        } catch (error) {
            console.warn('[Friends] Could not load friend permissions', error);
        } finally {
            if (toggle) toggle.disabled = false;
        }
    }

    function installReceiveRequestsSetting() {
        const toggle = $('receiveRequestsToggle');
        if (!toggle) return;

        toggle.addEventListener('change', async () => {
            const desired = toggle.checked;
            toggle.disabled = true;
            try {
                await coral('/v4/User/Permissions/UpdateSelf', {
                    permissions: { friendRequestReception: desired }
                });
                if (state.permissions?.permissions) {
                    state.permissions.permissions.friendRequestReception = desired;
                }
                showToast(desired ? 'Friend requests enabled.' : 'Friend requests disabled.');
            } catch (error) {
                toggle.checked = !desired;
                alert(`Could not update friend-request setting: ${error.message}`);
            } finally {
                toggle.disabled = false;
            }
        });
    }

    function updateNotifySettingsSummary() {
        const label = $('notifyStatusLabel');
        const button = $('changeNotifySettingBtn');
        if (!label || !button) return;
        const enabledCount = getCurrentFriends().filter((friend) => friend?.isOnlineNotificationEnabled).length;
        label.textContent = enabledCount === 0
            ? 'No friends are currently selected.'
            : `${enabledCount} friend${enabledCount === 1 ? '' : 's'} selected for online notifications.`;
        button.textContent = 'Choose a Friend';
    }

    function installNotifySettingsNavigation() {
        const button = $('changeNotifySettingBtn');
        if (!button) return;

        button.addEventListener('click', (event) => {
            // Stop the legacy demo handler that only toggles label text locally.
            event.preventDefault();
            event.stopImmediatePropagation();
            $('friendSettingsNotifyView')?.classList.add('hidden');
            $('friendSettingsView')?.classList.add('hidden');
            if (typeof showAppPage === 'function') showAppPage('friends');
            showToast('Open a friend and choose “Notify When Online”.');
        }, true);
    }

    async function loadBlockedUsers() {
        const list = $('blockedUsersNativeList');
        const empty = $('blockedUsersEmptyText');
        if (!list) return;

        list.classList.remove('hidden');
        list.innerHTML = '<p><i class="fa-solid fa-spinner fa-spin"></i> Loading blocked users…</p>';
        empty?.classList.add('hidden');

        try {
            const result = await coral('/v3/User/Block/List');
            state.blockedUsers = Array.isArray(result)
                ? result
                : (result?.blockingUsers || result?.blockedUsers || []);

            list.innerHTML = '';
            if (!state.blockedUsers.length) {
                list.classList.add('hidden');
                empty?.classList.remove('hidden');
                return;
            }

            for (const user of state.blockedUsers) {
                const row = document.createElement('article');
                row.className = 'friends-functional-user-row';
                row.innerHTML = `
                    <img src="${escapeHtml(user.imageUri || user.image2Uri || '')}" alt="">
                    <div>
                        <strong>${escapeHtml(user.name || 'Switch Player')}</strong>
                        <span>${user.blockedAt ? `Blocked ${escapeHtml(formatDate(user.blockedAt))}` : 'Blocked user'}</span>
                    </div>`;

                const button = document.createElement('button');
                button.type = 'button';
                button.textContent = 'Unblock';
                button.addEventListener('click', async () => {
                    if (!user.nsaId) return;
                    try {
                        await runButton(
                            button,
                            () => coral('/v3/User/Block/Delete', { nsaId: user.nsaId }),
                            'User unblocked.'
                        );
                        await loadBlockedUsers();
                    } catch (error) {
                        alert(`Could not unblock user: ${error.message}`);
                    }
                });
                row.appendChild(button);
                list.appendChild(row);
            }
        } catch (error) {
            list.innerHTML = `<p class="service-status error">Could not load blocked users: ${escapeHtml(error.message)}</p>`;
        }
    }

    function requestPerson(request, direction) {
        return direction === 'received'
            ? (request?.sender || request?.user || {})
            : (request?.receiver || request?.user || {});
    }

    function requestRouteText(request) {
        const route = request?.route || {};
        if (route.channel === 'FRIEND_CODE') return 'By exchanging friend codes.';
        if (route.channel === 'CAMPUS') return 'GameChat';
        if (route.appName) return route.appName;
        return 'Nintendo Switch';
    }

    function renderReceivedRequests() {
        const container = $('receivedRequestsContainer');
        if (!container) return;
        container.innerHTML = '';

        if (!state.receivedRequests.length) {
            container.innerHTML = '<p>You have not received any friend requests at this time.</p>';
            return;
        }

        for (const request of state.receivedRequests) {
            const sender = requestPerson(request, 'received');
            const row = document.createElement('article');
            row.className = `friends-functional-request-row${request.hasRead === false ? ' unread' : ''}`;
            row.innerHTML = `
                <img src="${escapeHtml(sender.imageUri || sender.image2Uri || '')}" alt="">
                <div>
                    <strong>${escapeHtml(sender.name || 'Switch Player')}</strong>
                    <span>${escapeHtml(requestRouteText(request))}</span>
                    <small>${escapeHtml(formatDate(request.createdAt))}</small>
                </div>`;

            const actions = document.createElement('div');
            actions.className = 'friends-functional-request-actions';

            const accept = document.createElement('button');
            accept.type = 'button';
            accept.className = 'primary';
            accept.textContent = 'Accept';
            accept.addEventListener('click', async (event) => {
                event.stopPropagation();
                try {
                    await runButton(
                        accept,
                        () => coral('/v3/FriendRequest/Accept', { id: request.id }),
                        'Friend request accepted.'
                    );
                    await loadFriendRequestLists();
                    refreshFriends();
                } catch (error) {
                    alert(`Could not accept friend request: ${error.message}`);
                }
            });

            const reject = document.createElement('button');
            reject.type = 'button';
            reject.textContent = 'Reject';
            reject.addEventListener('click', async (event) => {
                event.stopPropagation();
                if (!confirm(`Reject the friend request from ${sender.name || 'this user'}?`)) return;
                try {
                    await runButton(
                        reject,
                        () => coral('/v3/FriendRequest/Reject', { id: request.id }),
                        'Friend request rejected.'
                    );
                    await loadFriendRequestLists();
                } catch (error) {
                    alert(`Could not reject friend request: ${error.message}`);
                }
            });

            actions.append(accept, reject);
            row.appendChild(actions);

            row.addEventListener('click', () => {
                if (request.hasRead === false && request.id) {
                    request.hasRead = true;
                    row.classList.remove('unread');
                    coral('/v4/FriendRequest/Received/MarkAsRead', { id: request.id }).catch(() => {});
                }
            });

            container.appendChild(row);
        }
    }

    function syncLegacySentRequests() {
        const legacy = getLegacySentRequests();
        if (!legacy || typeof renderSentFriendRequests !== 'function') return false;

        legacy.splice(0, legacy.length, ...state.sentRequests.map((request) => {
            const receiver = requestPerson(request, 'sent');
            return {
                name: receiver.name || 'Switch Player',
                imageUri: receiver.imageUri || receiver.image2Uri || '',
                nsaId: receiver.nsaId,
                requestId: request.id,
                dateStr: formatDate(request.createdAt),
                source: requestRouteText(request)
            };
        }));
        renderSentFriendRequests();
        return true;
    }

    async function loadFriendRequestLists() {
        const receivedContainer = $('receivedRequestsContainer');
        if (receivedContainer) {
            receivedContainer.innerHTML = '<p><i class="fa-solid fa-spinner fa-spin"></i> Loading received requests…</p>';
        }

        const sentList = $('sentRequestsList');
        const sentEmpty = $('sentRequestsEmptyText');
        if (sentList) {
            sentList.classList.remove('hidden');
            sentList.innerHTML = '<p><i class="fa-solid fa-spinner fa-spin"></i> Loading sent requests…</p>';
        }
        sentEmpty?.classList.add('hidden');

        const [receivedResult, sentResult] = await Promise.allSettled([
            coral('/v4/FriendRequest/Received/List'),
            coral('/v3/FriendRequest/Sent/List')
        ]);

        if (receivedResult.status === 'fulfilled') {
            state.receivedRequests = Array.isArray(receivedResult.value)
                ? receivedResult.value
                : (receivedResult.value?.friendRequests || []);
            renderReceivedRequests();
        } else if (receivedContainer) {
            receivedContainer.innerHTML = `<p class="service-status error">Could not load received requests: ${escapeHtml(receivedResult.reason?.message || receivedResult.reason)}</p>`;
        }

        if (sentResult.status === 'fulfilled') {
            state.sentRequests = Array.isArray(sentResult.value)
                ? sentResult.value
                : (sentResult.value?.friendRequests || []);
            if (!syncLegacySentRequests() && sentList) {
                sentList.innerHTML = state.sentRequests.length
                    ? '<p>Sent requests loaded, but the existing renderer is unavailable.</p>'
                    : '';
            }
        } else if (sentList) {
            sentList.classList.remove('hidden');
            sentList.innerHTML = `<p class="service-status error">Could not load sent requests: ${escapeHtml(sentResult.reason?.message || sentResult.reason)}</p>`;
        }
    }

    function installCorrectSendFriendRequest() {
        const button = $('sendFriendRequestBtn');
        if (!button) return;

        button.addEventListener('click', async (event) => {
            // app.js currently has a legacy /v3/FriendRequest/Create handler. Capture
            // phase prevents that handler from also running.
            event.preventDefault();
            event.stopImmediatePropagation();

            const friend = getActiveSearchedFriend();
            if (!friend?.nsaId) {
                alert('Search for a Nintendo Switch user first.');
                return;
            }

            const originalHtml = button.innerHTML;
            button.disabled = true;
            button.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Sending Request...';
            try {
                await coral('/v4/FriendRequest/Create', {
                    nsaId: friend.nsaId,
                    channel: 'FRIEND_CODE'
                });
                showToast('Friend request sent.');

                $('fcResultSheet')?.classList.add('hidden');
                $('searchByFriendCodeView')?.classList.add('hidden');
                $('addFriendView')?.classList.remove('hidden');
                if ($('friendCodeInput')) $('friendCodeInput').value = '';
                if ($('searchFriendCodeBtn')) {
                    $('searchFriendCodeBtn').disabled = true;
                    $('searchFriendCodeBtn').classList.add('disabled');
                }
                $('fcInputBox')?.classList.remove('active-focused');
                clearActiveSearchedFriend();
                await loadFriendRequestLists();
            } catch (error) {
                alert(`Could not send friend request: ${error.message}`);
            } finally {
                button.disabled = false;
                button.innerHTML = originalHtml;
            }
        }, true);
    }

    function installCorrectCancelSentRequest() {
        const button = $('deleteSentReqBtn');
        if (!button) return;

        button.addEventListener('click', async (event) => {
            // app.js currently calls /v3/FriendRequest/Delete. Sent requests are
            // cancelled with /v3/FriendRequest/Cancel.
            event.preventDefault();
            event.stopImmediatePropagation();

            const request = getActiveSentRequest();
            const id = request?.requestId || request?.id;
            if (!id) return;
            if (!confirm(`Cancel the friend request sent to ${request.name || 'this user'}?`)) return;

            try {
                await runButton(
                    button,
                    () => coral('/v3/FriendRequest/Cancel', { id }),
                    'Friend request cancelled.'
                );
                $('sentReqDropdown')?.classList.add('hidden');
                $('sentReqDetailView')?.classList.add('hidden');
                await loadFriendRequestLists();
            } catch (error) {
                alert(`Could not cancel friend request: ${error.message}`);
            }
        }, true);
    }

    function ensureFriendCodeModal() {
        let modal = $('friendCodeQrModal');
        if (modal) return modal;

        modal = document.createElement('div');
        modal.id = 'friendCodeQrModal';
        modal.className = 'modal-overlay hidden';
        modal.innerHTML = `
            <div class="modal-card friends-functional-qr-card" role="dialog" aria-modal="true" aria-labelledby="friendCodeQrTitle">
                <header class="friends-functional-qr-header">
                    <button type="button" id="closeFriendCodeQrBtn" aria-label="Close"><i class="fa-solid fa-xmark"></i></button>
                    <h2 id="friendCodeQrTitle">QR Code</h2>
                </header>
                <div id="friendCodeQrBody"></div>
            </div>`;
        document.body.appendChild(modal);

        $('closeFriendCodeQrBtn')?.addEventListener('click', () => modal.classList.add('hidden'));
        modal.addEventListener('click', (event) => {
            if (event.target === modal) modal.classList.add('hidden');
        });
        return modal;
    }

    function loadQrLibrary() {
        if (typeof QRCode === 'function') return Promise.resolve(QRCode);
        if (state.qrLibraryPromise) return state.qrLibraryPromise;

        state.qrLibraryPromise = new Promise((resolve, reject) => {
            const script = document.createElement('script');
            script.src = 'https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js';
            script.async = true;
            script.onload = () => {
                if (typeof QRCode === 'function') resolve(QRCode);
                else reject(new Error('QR library loaded without QRCode support.'));
            };
            script.onerror = () => reject(new Error('Could not load the QR rendering library.'));
            document.head.appendChild(script);
        }).finally(() => {
            if (typeof QRCode !== 'function') state.qrLibraryPromise = null;
        });

        return state.qrLibraryPromise;
    }

    async function showMyFriendCode() {
        const button = $('openMyCodeQrBtn');
        if (!button) return;

        const oldHtml = button.innerHTML;
        button.disabled = true;
        try {
            // nxapi marks this call as NoParameter, so the request body is exactly {}.
            const result = await coral('/v3/Friend/CreateFriendCodeUrl', {}, { body: {} });
            const modal = ensureFriendCodeModal();
            const body = $('friendCodeQrBody');
            if (!body) return;

            const rawFriendCode = String(result?.friendCode || '');
            const displayFriendCode = rawFriendCode
                ? (rawFriendCode.startsWith('SW-') ? rawFriendCode : `SW-${rawFriendCode}`)
                : 'Friend Code unavailable';

            body.innerHTML = `
                <div id="friendCodeQrCanvas" class="friends-functional-qr-canvas"></div>
                <p class="friends-functional-qr-label">Your Friend Code</p>
                <strong class="friends-functional-friend-code">${escapeHtml(displayFriendCode)}</strong>
                <div class="friends-functional-qr-actions">
                    <button type="button" id="copyFriendCodeBtn">Copy Friend Code</button>
                    <button type="button" id="copyFriendLinkBtn" ${result?.url ? '' : 'disabled'}>Copy Friend Link</button>
                </div>`;

            $('copyFriendCodeBtn')?.addEventListener('click', async () => {
                try {
                    await navigator.clipboard.writeText(displayFriendCode);
                    showToast('Friend Code copied.');
                } catch {
                    prompt('Copy your Friend Code:', displayFriendCode);
                }
            });

            $('copyFriendLinkBtn')?.addEventListener('click', async () => {
                if (!result?.url) return;
                try {
                    await navigator.clipboard.writeText(result.url);
                    showToast('Friend link copied.');
                } catch {
                    prompt('Copy your friend link:', result.url);
                }
            });

            modal.classList.remove('hidden');

            if (result?.url) {
                try {
                    const Qr = await loadQrLibrary();
                    const host = $('friendCodeQrCanvas');
                    if (host) {
                        host.innerHTML = '';
                        new Qr(host, {
                            text: result.url,
                            width: 190,
                            height: 190,
                            correctLevel: Qr.CorrectLevel?.M
                        });
                    }
                } catch (error) {
                    const host = $('friendCodeQrCanvas');
                    if (host) host.innerHTML = `<p class="service-status">${escapeHtml(error.message)} The Friend Code and link are still available below.</p>`;
                }
            }
        } catch (error) {
            alert(`Could not create your Friend Code QR link: ${error.message}`);
        } finally {
            button.disabled = false;
            button.innerHTML = oldHtml;
        }
    }

    function normalizeChatCandidate(candidate) {
        if (!candidate || typeof candidate !== 'object') return null;

        // Nintendo Switch App 3.4.1 serializes ChatParticipants as:
        // NintendoServiceAccountId, ChatHistoryId, imageUri, name, lastSeenAt.
        const normalized = {
            nsaId: candidate.nsaId || candidate.friendNsaId || '',
            chatHistoryId: candidate.chatHistoryId || '',
            imageUri: candidate.imageUri || candidate.image2Uri || '',
            name: candidate.name || 'Switch Player',
            lastSeenAt: candidate.lastSeenAt || null
        };
        return normalized.nsaId ? normalized : null;
    }

    function renderVoiceChattedFriends(candidates) {
        const view = $('chattedUsersView');
        const body = view?.querySelector('.chatted-users-body');
        if (!view || !body) return;

        body.querySelectorAll('.friends-functional-user-row').forEach((row) => row.remove());
        const empty = body.querySelector('.chatted-users-empty');
        empty?.classList.add('hidden');

        if (!candidates.length) {
            if (empty) {
                empty.textContent = "You have not chatted with any users who can be added as friends at this time.";
                empty.classList.remove('hidden');
            }
            return;
        }

        for (const candidate of candidates) {
            const row = document.createElement('div');
            row.className = 'friends-functional-user-row';
            row.dataset.nsaId = candidate.nsaId;
            if (candidate.chatHistoryId) row.dataset.chatHistoryId = candidate.chatHistoryId;

            const lastSeen = formatDate(candidate.lastSeenAt);
            row.innerHTML = `
                <img src="${escapeHtml(candidate.imageUri)}" alt="" onerror="this.style.visibility='hidden'">
                <div>
                    <strong>${escapeHtml(candidate.name)}</strong>
                    <span>${escapeHtml(lastSeen ? `Last chatted ${lastSeen}` : 'GameChat user')}</span>
                </div>
                <button type="button" class="friends-functional-chat-add">Add Friend</button>`;

            row.querySelector('.friends-functional-chat-add')?.addEventListener('click', async (event) => {
                const button = event.currentTarget;
                try {
                    await runButton(button, async () => {
                        await coral('/v4/FriendRequest/Create', {
                            nsaId: candidate.nsaId,
                            // CAMPUS is Coral's route channel for GameChat-origin friend requests.
                            channel: 'CAMPUS'
                        });
                    }, 'Friend request sent.');
                    button.textContent = 'Sent';
                    button.disabled = true;
                    loadFriendRequestLists().catch(() => {});
                } catch (error) {
                    alert(`Could not send friend request: ${error.message}`);
                }
            });

            body.appendChild(row);
        }
    }

    async function openVoiceChattedFriends() {
        const view = $('chattedUsersView');
        const body = view?.querySelector('.chatted-users-body');
        if (!view || !body) return;

        view.classList.remove('hidden');
        body.querySelectorAll('.friends-functional-user-row').forEach((row) => row.remove());
        const empty = body.querySelector('.chatted-users-empty');
        if (empty) {
            empty.textContent = 'Loading GameChat users…';
            empty.classList.remove('hidden');
        }

        const result = await coral('/v5/Chat/FriendCandidate/List');
        const rawCandidates = Array.isArray(result)
            ? result
            : (result?.chatParticipants || result?.friendCandidates || []);
        state.chatCandidates = rawCandidates.map(normalizeChatCandidate).filter(Boolean);
        renderVoiceChattedFriends(state.chatCandidates);
    }

    function installViewLoaders() {
        $('openAddFriendBtn')?.addEventListener('click', () => {
            loadFriendRequestLists().catch((error) => {
                console.warn('[Friends] Could not load friend requests', error);
            });
        });

        $('openFriendSettingsBtn')?.addEventListener('click', () => {
            loadPermissions();
            updateNotifySettingsSummary();
        });

        $('openRequestsSettingBtn')?.addEventListener('click', () => {
            loadPermissions();
        });

        $('openBlockedSettingBtn')?.addEventListener('click', () => {
            loadBlockedUsers().catch((error) => {
                console.warn('[Friends] Could not load blocked users', error);
            });
        });

        $('openNotifySettingBtn')?.addEventListener('click', updateNotifySettingsSummary);
        $('openMyCodeQrBtn')?.addEventListener('click', showMyFriendCode);

        $('closeChattedUsersBtn')?.addEventListener('click', () => {
            $('chattedUsersView')?.classList.add('hidden');
        });

        $('openVoiceChattedFriendsBtn')?.addEventListener('click', () => {
            openVoiceChattedFriends().catch((error) => {
                console.warn('[Friends] Could not load GameChat friend candidates', error);
                alert(`Could not load users you've chatted with: ${error.message}`);
            });
        });
    }

    function init() {
        installReceiveRequestsSetting();
        installNotifySettingsNavigation();
        installCorrectSendFriendRequest();
        installCorrectCancelSentRequest();
        installViewLoaders();
        updateNotifySettingsSummary();
    }

    init();
})();

// ---------------------------------------------------------------------------
// Nintendo Switch App features
// ---------------------------------------------------------------------------

/**
 * Native Nintendo Switch App screens and Coral-backed controls.
 * Authentication and game-specific WebView orchestration remain in their dedicated core modules.
 */
(() => {
    'use strict';

    const BASE = 'https://api-lp1.znc.srv.nintendo.net';
    const $ = (id) => document.getElementById(id);

    const state = {
        currentUser: null,
        permissions: null,
        pushSettings: null,
        webServices: [],
        chats: [],
        activeChat: null,
        activeFriend: null,
        activeChatCandidate: null,
        friendOnlineReturnTarget: 'opPushPage',
        announcements: [],
        loginFactor: null,
        ownPlayLogs: [],
        ownPlayLogsNsaId: '',
        ownPlayLogsLoadedAt: 0,
        ownPlayLogsPromise: null,
        visibilityReturnTarget: 'opUserPage',
        pushReturnTarget: 'opSettingsPage',
        browserNotifications: {
            timer: null,
            running: false,
            baselineReady: false,
            announcementIds: new Set(),
            requestIds: new Set(),
            chatIds: new Set(),
            activeEventKey: '',
            friendOnline: new Map(),
            lastFriendOnlineNotice: new Map(),
            lastPollAt: 0
        },
        screensReady: false,
        refreshing: null,
        mobileObserver: null
    };

    // Endpoints recovered from the official 3.4.1 APK / current Coral contract.
    // Flags mirror the Android client behavior rather than adding Coral headers
    // globally to every request.
    const ENDPOINTS = Object.freeze({
        currentUser:      { path: '/v4/User/ShowSelf' },
        permissions:      { path: '/v3/User/Permissions/ShowSelf', noParameter: true, requestId: true },
        permissionsWrite: { path: '/v4/User/Permissions/UpdateSelf' },
        friends:          { path: '/v4/Friend/List', platform: true },
        friendShow:       { path: '/v4/Friend/Show' },
        friendIsNewDelete:{ path: '/v4/Friend/IsNew/Delete' },
        favoriteAdd:      { path: '/v3/Friend/Favorite/Create', platform: true },
        favoriteDelete:   { path: '/v3/Friend/Favorite/Delete', platform: true },
        friendNote:       { path: '/v4/Friend/Note/Update' },
        friendDelete:     { path: '/v3/Friend/Delete' },
        friendBlock:      { path: '/v3/User/Block/Create' },
        friendOnlinePush: { path: '/v5/PushNotification/Settings/Update' },
        friendPlayLog:    { path: '/v4/User/PlayLog/Show' },
        chatCandidates:   { path: '/v5/Chat/FriendCandidate/List' },
        friendRequest:    { path: '/v4/FriendRequest/Create' },
        receivedRequests: { path: '/v4/FriendRequest/Received/List' },
        chats:            { path: '/v5/Chat/List' },
        activeEvent:      { path: '/v1/Event/GetActiveEvent' },
        chatShow:         { path: '/v5/Chat/Show' },
        pushList:         { path: '/v5/PushNotification/Settings/List' },
        pushUpdate:       { path: '/v5/PushNotification/Settings/Update' },
        webServices:      { path: '/v4/GameWebService/List', noParameter: true, requestId: true },
        announcements:    { path: '/v4/Announcement/List', platform: true },
        announcementRead: { path: '/v4/Announcement/MarkAsRead', platform: true },
        mediaHashtags:    { path: '/v5/Hashtag/List' },
        feedback:         { path: '/v1/Support/SendOpinion' },
        loginFactor:      { path: '/v4/NA/User/LoginFactor/Show' }
    });

    function escapeHtml(value) {
        return String(value ?? '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    }

    function uuid() {
        return globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    }

    function toMillis(value) {
        if (!value) return 0;
        if (typeof value === 'number') return value < 10_000_000_000 ? value * 1000 : value;
        const parsed = Date.parse(value);
        return Number.isFinite(parsed) ? parsed : 0;
    }

    function formatDate(value, withTime = true) {
        const ms = toMillis(value);
        if (!ms) return '';
        try {
            return new Intl.DateTimeFormat(undefined, withTime
                ? { dateStyle: 'medium', timeStyle: 'short' }
                : { dateStyle: 'medium' }).format(new Date(ms));
        } catch {
            return new Date(ms).toLocaleString();
        }
    }

    function relativeTime(value) {
        const ms = toMillis(value);
        if (!ms) return '';
        const sec = Math.max(0, Math.floor((Date.now() - ms) / 1000));
        if (sec < 60) return 'Just now';
        if (sec < 3600) return `${Math.floor(sec / 60)} min. ago`;
        if (sec < 86400) return `${Math.floor(sec / 3600)} hr. ago`;
        return `${Math.floor(sec / 86400)} d. ago`;
    }

    function getCurrentFriends() {
        try { return typeof currentFriends !== 'undefined' && Array.isArray(currentFriends) ? currentFriends : []; }
        catch { return []; }
    }

    function currentMediaItem() {
        try { return typeof activeMediaItem !== 'undefined' ? activeMediaItem : null; }
        catch { return null; }
    }

    function sessionUser() {
        try {
            return userSession?.result?.user || userSession?.user || null;
        } catch {
            return null;
        }
    }

    function coralToken() {
        try {
            if (typeof coralAccessToken === 'function') return coralAccessToken();
        } catch {}
        try {
            return userSession?.result?.webApiServerCredential?.accessToken ||
                userSession?.webApiServerCredential?.accessToken ||
                userSession?.accessToken || null;
        } catch {
            return null;
        }
    }

    /**
     * Exact-ish Coral call for the endpoints added by this native feature controller.
     * Existing project calls are intentionally not monkey-patched, so working
     * game services and auth remain untouched.
     */
    async function coralExact(name, parameter = undefined, bodyOverride = undefined) {
        const meta = ENDPOINTS[name];
        if (!meta) throw new Error(`Blocked unknown Coral operation: ${name}`);
        const token = coralToken();
        if (!token) throw new Error('No Coral access token is available. Sign in again.');
        if (typeof nxapiEncryptRequest !== 'function' || typeof proxyFetch !== 'function' || typeof parseCoralResponse !== 'function') {
            throw new Error('The Coral encryption bridge is not ready.');
        }

        const url = BASE + meta.path;
        let body;
        if (bodyOverride !== undefined) {
            body = bodyOverride;
        } else if (meta.noParameter) {
            body = meta.requestId ? { requestId: uuid() } : {};
        } else {
            body = { parameter: parameter === undefined ? {} : parameter };
        }

        const encrypted = await nxapiEncryptRequest(url, token, JSON.stringify(body));
        const headers = {
            'Content-Type': 'application/octet-stream',
            'Accept': 'application/octet-stream,application/json',
            'Accept-Language': 'en-GB',
            'Authorization': `Bearer ${token}`,
            'User-Agent': typeof zncaUserAgent === 'function' ? zncaUserAgent() : 'com.nintendo.znca/3.4.1(Android/12)',
            'Pragma': 'no-cache',
            'Cache-Control': 'no-cache'
        };
        if (meta.platform) headers['X-Platform'] = typeof ZNCA_PLATFORM !== 'undefined' ? ZNCA_PLATFORM : 'Android';
        if (meta.productVersion) headers['X-ProductVersion'] = typeof ZNCA_VERSION !== 'undefined' ? ZNCA_VERSION : '3.4.1';

        const response = await proxyFetch(url, {
            method: 'POST',
            headers,
            bodyBase64: encrypted
        });
        const data = await parseCoralResponse(response);
        if (!response.ok || !data || data.status !== 0 || !Object.prototype.hasOwnProperty.call(data, 'result')) {
            const status = data?.status ?? response.status;
            const message = data?.errorMessage || data?.error || `Nintendo API request failed (${status}).`;
            const error = new Error(message);
            error.coralStatus = data?.status;
            throw error;
        }
        return data.result;
    }

    function toast(message) {
        let el = $('nsoAppToast');
        if (!el) {
            el = document.createElement('div');
            el.id = 'nsoAppToast';
            el.className = 'op-toast';
            document.body.appendChild(el);
        }
        el.textContent = message;
        el.classList.add('show');
        clearTimeout(toast.timer);
        toast.timer = setTimeout(() => el.classList.remove('show'), 2200);
    }

    function bindControl(id, handler, options = {}) {
        const old = $(id);
        if (!old) return null;
        const next = old.cloneNode(true);
        old.replaceWith(next);
        if (handler) next.addEventListener(options.event || 'click', handler, Boolean(options.capture));
        return next;
    }

    function setBusy(button, busy, busyText = '') {
        if (!button) return;
        if (busy) {
            if (button.dataset.opBusy === 'true') return;
            button.dataset.opBusy = 'true';
            button.dataset.opWasDisabled = button.disabled ? 'true' : 'false';
            button.disabled = true;
            button.setAttribute('aria-busy', 'true');
            button.style.opacity = '0.68';

            // Only snapshot/replace the label when a temporary busy label is requested.
            // This prevents stateful buttons (Best Friends / Notify When Online) from
            // reverting to stale HTML after their successful state update.
            if (busyText) {
                button.dataset.opBusyHtml = button.innerHTML;
                button.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> ${escapeHtml(busyText)}`;
            }
        } else {
            button.disabled = button.dataset.opWasDisabled === 'true';
            button.removeAttribute('aria-busy');
            button.style.removeProperty('opacity');

            if (button.dataset.opBusyHtml != null) {
                button.innerHTML = button.dataset.opBusyHtml;
            }

            delete button.dataset.opBusy;
            delete button.dataset.opWasDisabled;
            delete button.dataset.opBusyHtml;
        }
    }

    function closeAppScreens(except = null) {
        document.querySelectorAll('.op-screen').forEach((screen) => {
            if (screen.id === except) return;
            if (typeof hideViewInstant === 'function') hideViewInstant(screen);
            else screen.classList.add('hidden');
        });
    }

    window.nsoCloseAppScreens = () => closeAppScreens();

    let openScreenToken = 0;

    function openScreen(id) {
        const screen = $(id);
        if (!screen) return;
        const token = ++openScreenToken;
        if (typeof slideViewIn === 'function') {
            // Bring this screen to the front of the op-screen stack so it paints
            // over the previously visible screen during the slide-in, and only
            // hide the others once it has fully covered the viewport. Hiding them
            // up front would expose the home screen through the fade transition.
            document.body.appendChild(screen);
            slideViewIn(screen);
            screen.addEventListener('animationend', () => {
                if (token !== openScreenToken || screen.classList.contains('view-slide-out')) return;
                closeAppScreens(id);
            }, { once: true });
        } else {
            closeAppScreens(id);
            screen.classList.remove('hidden');
        }
        window.scrollTo({ top: 0, behavior: 'auto' });
    }

    function screenShell(id, title, bodyHtml, extraClass = '') {
        const section = document.createElement('section');
        section.className = `op-screen hidden ${extraClass}`.trim();
        section.id = id;
        section.innerHTML = `
            <header class="op-header">
                <button type="button" class="op-back" aria-label="Back"><i class="fa-solid fa-arrow-left"></i></button>
                <h2>${escapeHtml(title)}</h2>
                <span class="op-header-spacer"></span>
            </header>
            <div class="op-scroll">${bodyHtml}</div>`;
        section.querySelector('.op-back')?.addEventListener('click', () => section.classList.add('hidden'));
        document.body.appendChild(section);
        return section;
    }

    function ensureScreens() {
        if (state.screensReady) return;
        state.screensReady = true;

        screenShell('opUserPage', 'User Page', `
            <div class="native-user-page">
                <header class="native-user-hero">
                    <img id="opUserAvatar" src="" alt="Your Nintendo Switch profile image">
                    <h3 id="opUserName">Switch Player</h3>
                </header>

                <section class="native-user-card native-friend-code-card" aria-labelledby="nativeFriendCodeLabel">
                    <div class="native-friend-code-copy">
                        <span class="native-user-label" id="nativeFriendCodeLabel">Friend Code</span>
                        <button id="nativeFriendCodeCopyBtn" class="native-friend-code-button" type="button" aria-label="Copy friend code">
                            <span id="opFriendCode">SW-0000-0000-0000</span>
                            <i class="fa-regular fa-copy" aria-hidden="true"></i>
                        </button>
                        <span class="native-copy-status" id="nativeCopyStatus" aria-live="polite"></span>
                    </div>
                </section>

                <div class="native-user-actions" aria-label="Profile actions">
                    <button class="native-user-action-card" id="nativeAddFriendBtn" type="button">
                        <i class="fa-regular fa-face-smile"></i>
                        <span>Add Friend</span>
                    </button>
                    <button class="native-user-action-card" id="nativeSettingsBtn" type="button">
                        <i class="fa-solid fa-sun"></i>
                        <span>Settings</span>
                    </button>
                </div>

                <section class="native-user-section" aria-labelledby="nativeOnlineStatusHeading">
                    <div class="native-user-section-head">
                        <div>
                            <strong id="nativeOnlineStatusHeading">Online Status</strong>
                            <span id="opOnlineStatusSummary">—</span>
                        </div>
                        <button class="native-user-change" id="nativeOnlineStatusChangeBtn" type="button">
                            <i class="fa-solid fa-circle-chevron-right"></i> Change
                        </button>
                    </div>
                    <div class="native-user-presence" id="nativeOwnPresence">
                        <div class="native-user-offline">Offline</div>
                    </div>
                </section>

                <section class="native-user-section native-play-section" aria-labelledby="nativePlayActivityHeading">
                    <div class="native-user-section-head">
                        <div>
                            <strong id="nativePlayActivityHeading">Play Activity</strong>
                            <span id="opPlayActivitySummary">—</span>
                        </div>
                        <button class="native-user-change" id="nativePlayActivityChangeBtn" type="button">
                            <i class="fa-solid fa-circle-chevron-right"></i> Change
                        </button>
                    </div>
                    <div class="native-user-play-list" id="nativePlayActivityList">
                        <p class="native-user-loading">Loading play activity…</p>
                    </div>
                </section>
            </div>`);

        screenShell('opVisibilityPage', 'Setting', `<div id="opVisibilityBody"></div>`);
        screenShell('opPushPage', 'Push Notifications', `<div id="opPushBody"></div>`);
        screenShell('opFriendOnlinePage', 'Notify When Friends Come Online', `
            <div class="op-info-card">You'll get online-status notifications for friends (max of once per 30 mins. for each friend).</div>
            <div id="opFriendOnlineList" class="op-list"></div>`);
        screenShell('opSettingsPage', 'Settings', `<div id="opSettingsBody"></div>`);
        screenShell('opDarkModePage', 'Dark Mode', `<div id="opDarkModeBody"></div>`);
        screenShell('opMobileDataPage', 'Mobile Data', `<div id="opMobileDataBody"></div>`);
        screenShell('opUsageDataPage', 'About Sending Usage Data', `<div id="opUsageDataBody"></div>`);
        screenShell('opLegalPage', 'Intellectual Property Notices', `<div id="opLegalBody"></div>`);
        screenShell('opLicenseDetailPage', 'License', `<div id="opLicenseDetailBody"></div>`);
        screenShell('opFeedbackPage', 'Feedback', `<div id="opFeedbackBody"></div>`);
        screenShell('opAnnouncementPage', 'Notifications', `<div id="opAnnouncementBody"></div>`);
        screenShell('opAnnouncementDetailPage', 'Notification', `<div id="opAnnouncementDetailBody"></div>`);
        screenShell('opChatPage', 'GameChat', `<div id="opChatBody"></div>`);
        screenShell('opChatDetailPage', 'GameChat', `<div id="opChatDetailBody"></div>`);
        screenShell('opChatCandidatePage', "Users You've Chatted With", `<div id="opChatCandidateBody"></div>`);
        screenShell('opFriendNotePage', 'Add Note', `<div id="opFriendNoteBody"></div>`);
        screenShell('opAlbumAboutPage', 'About the Upload Feature', `
            <div class="op-copy-page">
                <p>Screenshots and videos uploaded from your Nintendo Switch 2 will be displayed here.</p>
                <h3>How to Upload</h3>
                <ol class="op-steps">
                    <li><b>Power on your Nintendo Switch 2 system.</b><small>Nintendo Switch systems don't support the upload feature.</small></li>
                    <li><b>Open the Album.</b></li>
                    <li><b>Upload screenshots and videos.</b><small>Pick which screenshots and videos you want to upload and then select Upload to Smart Device.</small></li>
                </ol>
                <div class="op-info-card">Up to 100 files can be uploaded and stored for up to 30 days. If you attempt to store more than 100 files, the oldest uploads will be overwritten.</div>
                <h3>Uploading Is Easy with Automatic Uploads</h3>
                <p>The automatic-uploads feature allows you to automatically upload any screenshot or video as soon as you capture it.</p>
                <p class="op-muted">You can enable automatic uploads from the upload settings on your Nintendo Switch 2 system.</p>
            </div>`);

        wireScreenBackNavigation();
    }

    function wireScreenBackNavigation() {
        const parents = {
            opVisibilityPage: () => state.visibilityReturnTarget || 'opUserPage',
            opPushPage: () => state.pushReturnTarget || 'opSettingsPage',
            opSettingsPage: 'opUserPage',
            opDarkModePage: 'opSettingsPage',
            opMobileDataPage: 'opSettingsPage',
            opUsageDataPage: 'opSettingsPage',
            opLegalPage: 'opSettingsPage',
            opLicenseDetailPage: 'opLegalPage',
            opFeedbackPage: 'opSettingsPage',
            opAnnouncementDetailPage: 'opAnnouncementPage',
            opChatDetailPage: 'opChatPage',
            opChatCandidatePage: 'chattedUsersView',
            opFriendNotePage: 'friendDetailView'
        };
        for (const [child, parentSpec] of Object.entries(parents)) {
            const back = $(child)?.querySelector('.op-back');
            if (!back) continue;
            replaceNodeListener(back, () => {
                const parent = typeof parentSpec === 'function' ? parentSpec() : parentSpec;
                const childView = $(child);
                const parentView = $(parent);

                if (child === 'opChatCandidatePage' && childView && parentView && typeof nsoApkBack === 'function') {
                    nsoApkBack(childView, parentView);
                    return;
                }

                const revealParent = () => {
                    if (parent.startsWith('op')) {
                        // Unhide the parent so it paints underneath the exiting
                        // child (it was appended before the child). No animation:
                        // the child covers it until it starts sliding out.
                        if (parentView?.classList.contains('hidden')) {
                            if (typeof showViewInstant === 'function') showViewInstant(parentView);
                            else parentView.classList.remove('hidden');
                        }
                        return;
                    }
                    if (parentView?.classList.contains('hidden')) {
                        if (typeof slideViewIn === 'function') slideViewIn(parentView);
                        else parentView.classList.remove('hidden');
                    }
                };

                if (childView && typeof slideViewOut === 'function') {
                    // Reveal the parent underneath BEFORE the child starts
                    // sliding out, so the home screen never shows through the
                    // exit animation.
                    revealParent();
                    slideViewOut(childView);
                } else {
                    childView?.classList.add('hidden');
                    revealParent();
                }
            });
        }

        const friendOnlineBack = $('opFriendOnlinePage')?.querySelector('.op-back');
        if (friendOnlineBack) {
            replaceNodeListener(friendOnlineBack, () => {
                const childView = $('opFriendOnlinePage');
                const revealParent = () => {
                    const parent = state.friendOnlineReturnTarget || 'opPushPage';
                    const parentView = $(parent);
                    if (parent.startsWith('op')) {
                        if (parentView?.classList.contains('hidden')) {
                            if (typeof showViewInstant === 'function') showViewInstant(parentView);
                            else parentView.classList.remove('hidden');
                        }
                        return;
                    }
                    if (parentView?.classList.contains('hidden')) {
                        if (typeof slideViewIn === 'function') slideViewIn(parentView);
                        else parentView.classList.remove('hidden');
                    }
                };

                if (childView && typeof slideViewOut === 'function') {
                    revealParent();
                    slideViewOut(childView);
                } else {
                    childView?.classList.add('hidden');
                    revealParent();
                }
            });
        }
    }

    function replaceNodeListener(node, handler) {
        const clone = node.cloneNode(true);
        node.replaceWith(clone);
        clone.addEventListener('click', handler);
        return clone;
    }

    function permissionLabel(kind, value) {
        if (kind === 'presence') {
            return ({ FRIENDS: 'All Friends', FAVORITE_FRIENDS: 'Best Friends', SELF: 'No One' })[value] || value || '—';
        }
        return ({ EVERYONE: 'All Users', FRIENDS: 'Friends', FAVORITE_FRIENDS: 'Best Friends', SELF: 'No One' })[value] || value || '—';
    }

    async function loadCurrentUserAndPermissions(force = false) {
        if (!force && state.currentUser && state.permissions) return;
        const base = sessionUser();
        const id = Number(base?.id || 0);
        const calls = [
            id ? coralExact('currentUser', { id }).catch(() => base) : Promise.resolve(base),
            coralExact('permissions').catch(() => null)
        ];
        const [user, permissions] = await Promise.all(calls);
        if (user) state.currentUser = user;
        if (permissions) state.permissions = permissions;
    }

    function ownPresencePlatformLabel(presence) {
        const raw = presence?.platform;
        const normalized = String(raw ?? '').trim().toUpperCase().replace(/[\s-]+/g, '_');
        if (raw === 2 || normalized === '2' || normalized === 'OUNCE' ||
            normalized === 'NINTENDO_SWITCH_2' || normalized === 'SWITCH_2' || normalized === 'SWITCH2') {
            return 'Nintendo Switch 2';
        }
        if (raw === 1 || normalized === '1' || normalized === 'NX' ||
            normalized === 'NINTENDO_SWITCH' || normalized === 'SWITCH') {
            return 'Nintendo Switch';
        }
        // Older Coral responses did not expose the platform field. Those responses
        // predate Nintendo Switch 2, so Nintendo Switch is the closest native label.
        return 'Nintendo Switch';
    }

    function formatOwnOfflinePresence(user, presence) {
        const lastSeen = toMillis(
            presence?.updatedAt ?? presence?.logoutAt ?? presence?.lastOnlineAt ??
            user?.presenceUpdatedAt ?? user?.lastOnlineAt
        );
        if (!lastSeen) return 'Offline';

        const elapsedMs = Math.max(0, Date.now() - lastSeen);
        const minutes = Math.floor(elapsedMs / 60000);
        const hours = Math.floor(elapsedMs / 3600000);
        if (hours < 1) return `Offline: ${Math.max(1, minutes)} minute(s)`;
        if (hours < 48) return `Offline: ${hours} hour(s)`;
        return `Offline: ${Math.floor(hours / 24)} day(s)`;
    }

    function renderOwnPresence(user) {
        const host = $('nativeOwnPresence');
        if (!host) return;
        host.replaceChildren();

        const presence = user?.presence || sessionUser()?.presence || null;
        const presenceState = String(presence?.state || presence?.status || '').toUpperCase();
        const isOnline = presenceState === 'ONLINE' || presenceState === 'PLAYING';
        const game = presence?.game && typeof presence.game === 'object' ? presence.game : null;
        const hasGame = Boolean(isOnline && game?.name);

        if (!hasGame) {
            const status = document.createElement('div');
            status.className = 'native-user-offline';
            status.textContent = isOnline
                ? `Online (${ownPresencePlatformLabel(presence)})`
                : formatOwnOfflinePresence(user, presence);
            host.appendChild(status);
            return;
        }

        const row = document.createElement('button');
        row.type = 'button';
        row.className = 'native-user-presence-row';
        row.setAttribute('aria-label', `Open ${game.name}`);

        const image = document.createElement('img');
        image.src = game.imageUri || '';
        image.alt = '';
        image.loading = 'eager';
        image.addEventListener('error', () => image.classList.add('native-user-presence-image-missing'));

        const copy = document.createElement('span');
        copy.className = 'native-user-presence-copy';

        const online = document.createElement('span');
        online.className = 'native-user-presence-online';
        online.textContent = `Online (${ownPresencePlatformLabel(presence)})`;

        const title = document.createElement('strong');
        title.textContent = game.name || 'Game';

        copy.append(online, title);
        row.append(image, copy);

        if (typeof openGameSheet === 'function') {
            row.addEventListener('click', () => openGameSheet({
                name: game.name || 'Game',
                imageUri: game.imageUri || '',
                shopUri: game.shopUri || ''
            }));
        } else {
            row.disabled = true;
        }

        host.appendChild(row);
    }

    function ownPlayTimeText(totalPlayTime) {
        const minutes = Number(totalPlayTime || 0);
        if (!Number.isFinite(minutes) || minutes < 60) return 'Played for a little while';
        const hours = Math.max(1, Math.round(minutes / 60));
        return `Played for ${hours} hour(s) or more`;
    }

    function renderOwnPlayLogs(playLogs = []) {
        const host = $('nativePlayActivityList');
        if (!host) return;
        host.replaceChildren();

        if (!Array.isArray(playLogs) || playLogs.length === 0) {
            const empty = document.createElement('p');
            empty.className = 'native-user-empty';
            empty.textContent = 'No play activity is available.';
            host.appendChild(empty);
            return;
        }

        for (const log of playLogs) {
            const row = document.createElement('button');
            row.type = 'button';
            row.className = 'native-user-play-row';

            const image = document.createElement('img');
            image.src = log.imageUri || '';
            image.alt = '';
            image.loading = 'lazy';
            image.addEventListener('error', () => image.classList.add('native-user-play-image-missing'));

            const copy = document.createElement('span');
            copy.className = 'native-user-play-copy';
            const title = document.createElement('strong');
            title.textContent = log.name || 'Game';
            const playtime = document.createElement('span');
            const minutes = Number(log.totalPlayTime || 0);
            playtime.textContent = ownPlayTimeText(minutes);
            playtime.className = Number.isFinite(minutes) && minutes >= 3000
                ? 'native-playtime-highlight'
                : 'native-playtime-normal';
            copy.append(title, playtime);
            row.append(image, copy);

            if (typeof openGameSheet === 'function') {
                row.addEventListener('click', () => openGameSheet({
                    name: log.name || 'Game',
                    imageUri: log.imageUri || '',
                    shopUri: log.shopUri || ''
                }));
            } else {
                row.disabled = true;
            }
            host.appendChild(row);
        }
    }

    async function loadOwnPlayLogs(force = false) {
        const user = state.currentUser || sessionUser() || {};
        const nsaId = String(user.nsaId || '');
        const host = $('nativePlayActivityList');
        if (!host) return;
        if (!nsaId) {
            renderOwnPlayLogs([]);
            return;
        }

        const isFresh = state.ownPlayLogsNsaId === nsaId &&
            Date.now() - state.ownPlayLogsLoadedAt < 5 * 60 * 1000;
        if (!force && isFresh) {
            renderOwnPlayLogs(state.ownPlayLogs);
            return;
        }
        if (state.ownPlayLogsPromise) return state.ownPlayLogsPromise;

        host.innerHTML = '<p class="native-user-loading">Loading play activity…</p>';
        state.ownPlayLogsPromise = (async () => {
            try {
                const result = await coralExact('friendPlayLog', { nsaId });
                const logs = Array.isArray(result) ? result : (result?.playLogs || []);
                state.ownPlayLogs = logs;
                state.ownPlayLogsNsaId = nsaId;
                state.ownPlayLogsLoadedAt = Date.now();
                renderOwnPlayLogs(logs);
            } catch {
                host.innerHTML = '<p class="native-user-empty">Play activity is private or not available.</p>';
            } finally {
                state.ownPlayLogsPromise = null;
            }
        })();
        return state.ownPlayLogsPromise;
    }

    async function copyOwnFriendCode() {
        const value = $('opFriendCode')?.textContent?.trim();
        if (!value || value === '—') return;
        try {
            if (navigator.clipboard?.writeText) {
                await navigator.clipboard.writeText(value);
            } else {
                const input = document.createElement('textarea');
                input.value = value;
                input.style.position = 'fixed';
                input.style.opacity = '0';
                document.body.appendChild(input);
                input.select();
                document.execCommand('copy');
                input.remove();
            }
            const status = $('nativeCopyStatus');
            if (status) status.textContent = 'Copied';
            setTimeout(() => {
                if (status) status.textContent = '';
            }, 1200);
        } catch {
            toast('Could not copy the friend code.');
        }
    }

    async function openUserPage() {
        ensureScreens();
        assignPersistentViewOwner($('opUserPage'), activeAppTab);
        const user = sessionUser() || {};
        $('opUserAvatar').src = user.imageUri || user.image2Uri || $('profileViewAvatar')?.src || '';
        $('opUserName').textContent = user.name || user.nickname || $('profileViewName')?.textContent || 'Switch Player';
        $('opFriendCode').textContent = user.links?.friendCode?.id || $('profileViewFriendCode')?.textContent || '—';
        renderOwnPresence(user);
        openScreen('opUserPage');

        try {
            await loadCurrentUserAndPermissions(true);
            const full = state.currentUser || user;
            $('opUserAvatar').src = full.imageUri || full.image2Uri || $('opUserAvatar').src;
            $('opUserName').textContent = full.name || full.nickname || $('opUserName').textContent;
            $('opFriendCode').textContent = full.links?.friendCode?.id || $('opFriendCode').textContent;
            renderOwnPresence(full);
            const permissions = state.permissions?.permissions || full.permissions || {};
            $('opOnlineStatusSummary').textContent = permissionLabel('presence', permissions.presence);
            $('opPlayActivitySummary').textContent = permissionLabel('playLog', permissions.playLog);
            await loadOwnPlayLogs(false);
        } catch {
            await loadOwnPlayLogs(false);
        }
    }

    async function openVisibility(kind, returnTarget = 'opUserPage') {
        ensureScreens();
        state.visibilityReturnTarget = returnTarget || 'opUserPage';
        await loadCurrentUserAndPermissions();
        const isPresence = kind === 'presence';
        const screen = $('opVisibilityPage');
        const title = isPresence ? 'Display Online Status' : 'Show Play Activity';
        screen.querySelector('h2').textContent = title;
        const current = state.permissions?.permissions?.[kind] || state.currentUser?.permissions?.[kind];
        const options = isPresence
            ? [
                ['FRIENDS', 'All Friends'],
                ['FAVORITE_FRIENDS', 'Best Friends'],
                ['SELF', 'No One']
              ]
            : [
                ['EVERYONE', 'All Users'],
                ['FRIENDS', 'Friends'],
                ['FAVORITE_FRIENDS', 'Best Friends'],
                ['SELF', 'No One']
              ];
        const notice = isPresence
            ? "You can set who can see your online status. Friends who can't see your online status may not be able to join you during online play. Changing the setting here will update the setting on your system."
            : "If you choose to make your play activity visible to some users, they'll be able to see how long you've spent playing each game, as well as information about when you first played them.";

        $('opVisibilityBody').innerHTML = `
            <p class="op-page-prompt">${escapeHtml(isPresence ? 'Who do you want to see your online status?' : 'Who do you want to see your play activity?')}</p>
            <div class="op-radio-list">
                ${options.map(([value, label]) => `<label class="op-radio-row"><span>${escapeHtml(label)}</span><input type="radio" name="opVisibility" value="${value}" ${value === current ? 'checked' : ''}></label>`).join('')}
            </div>
            <div class="op-info-card">${escapeHtml(notice)}</div>`;
        openScreen('opVisibilityPage');

        $('opVisibilityBody').querySelectorAll('input[name="opVisibility"]').forEach((input) => {
            input.addEventListener('change', async () => {
                if (!input.checked) return;
                const value = input.value;
                $('opVisibilityBody').querySelectorAll('input').forEach((x) => x.disabled = true);
                try {
                    await coralExact('permissionsWrite', { permissions: { [kind]: value } });
                    state.permissions = state.permissions || { permissions: {} };
                    state.permissions.permissions = state.permissions.permissions || {};
                    state.permissions.permissions[kind] = value;
                    if (kind === 'presence') $('opOnlineStatusSummary').textContent = permissionLabel(kind, value);
                    else $('opPlayActivitySummary').textContent = permissionLabel(kind, value);
                    toast('Setting changed.');
                } catch (error) {
                    alert(`Could not update setting: ${error.message}`);
                    input.checked = false;
                    const old = $('opVisibilityBody').querySelector(`input[value="${CSS.escape(current || '')}"]`);
                    if (old) old.checked = true;
                } finally {
                    $('opVisibilityBody').querySelectorAll('input').forEach((x) => x.disabled = false);
                }
            });
        });
    }

    function normalizePushList(result) {
        if (!result || typeof result !== 'object') return {};
        return result.settings || result;
    }

    async function loadPushSettings(force = false) {
        if (!force && state.pushSettings) return state.pushSettings;
        state.pushSettings = normalizePushList(await coralExact('pushList'));
        return state.pushSettings;
    }

    async function loadWebServicesForSettings(force = false) {
        if (!force && state.webServices.length) return state.webServices;
        const result = await coralExact('webServices');
        state.webServices = Array.isArray(result) ? result : (result?.webServices || []);
        return state.webServices;
    }

    async function updatePush(item) {
        await coralExact('pushUpdate', [item]);
        if (item.type === 'friendRequest') state.pushSettings.friendRequest = item.value;
        if (item.type === 'chatInvitation') state.pushSettings.chatInvitation = item.value;
        if (item.type === 'playInvitation') state.pushSettings.playInvitation = item.scope;
    }

    const BROWSER_NOTIFICATION_SETTING_KEY = 'nso_browser_notifications_enabled';

    function browserNotificationSupport() {
        if (!('Notification' in window)) {
            return { supported: false, permission: 'unsupported', enabled: false };
        }
        let optedIn = false;
        try { optedIn = localStorage.getItem(BROWSER_NOTIFICATION_SETTING_KEY) === 'true'; } catch (e) {}
        return {
            supported: true,
            permission: Notification.permission,
            enabled: optedIn && Notification.permission === 'granted'
        };
    }

    function setBrowserNotificationPreference(enabled) {
        try {
            if (enabled) localStorage.setItem(BROWSER_NOTIFICATION_SETTING_KEY, 'true');
            else localStorage.removeItem(BROWSER_NOTIFICATION_SETTING_KEY);
        } catch (e) {}
    }

    function browserNotificationStatusText() {
        const status = browserNotificationSupport();
        if (!status.supported) return 'Browser notifications are not supported by this browser.';
        if (status.permission === 'denied') return 'Blocked by your browser. Allow notifications for this site in browser settings.';
        if (status.enabled) return 'On. NSO events are shown as browser notifications while this web app is open.';
        if (status.permission === 'granted') return 'Off for this web app.';
        return 'Off. Your browser will ask for permission when you enable them.';
    }

    function browserNotificationActionText() {
        const status = browserNotificationSupport();
        if (!status.supported) return 'Not Supported';
        if (status.permission === 'denied') return 'Blocked in Browser';
        return status.enabled ? 'Turn Off Browser Notifications' : 'Enable Browser Notifications';
    }

    function browserNotificationKey(item, fallbackPrefix) {
        const id = item?.id ?? item?.notificationId ?? item?.chatId ?? item?.requestId ?? item?.nsaId;
        return id !== undefined && id !== null && String(id)
            ? String(id)
            : `${fallbackPrefix}:${String(item?.createdAt || item?.updatedAt || item?.sentAt || '')}:${String(item?.name || item?.title || '')}`;
    }

    function personFromRequest(request) {
        return request?.sender || request?.user || request?.friend || request?.from || request?.requester || {};
    }

    function isFriendOnline(friend) {
        const presence = friend?.presence || {};
        const stateName = String(presence.state || friend?.state || '').toUpperCase();
        return Boolean(friend?.isOnline) || stateName === 'ONLINE' || stateName === 'PLAYING';
    }

    function fireBrowserNotification(title, options = {}, onClick = null) {
        const status = browserNotificationSupport();
        if (!status.enabled) return;
        // The native UI is already visible while this tab has focus. Use the OS/browser
        // surface when the NSO page is in the background to avoid duplicate alerts.
        if (document.visibilityState === 'visible' && document.hasFocus()) return;

        try {
            const notification = new Notification(title, {
                body: options.body || '',
                icon: options.icon || sessionUser()?.imageUri || '',
                tag: options.tag || undefined,
                renotify: options.renotify === true,
                silent: false
            });
            notification.onclick = () => {
                try { window.focus(); } catch (e) {}
                try { notification.close(); } catch (e) {}
                if (typeof onClick === 'function') {
                    try { onClick(); } catch (e) {}
                }
            };
        } catch (error) {
            console.warn('[BrowserNotifications] Notification creation failed:', error);
        }
    }

    function resetBrowserNotificationBaseline() {
        const monitor = state.browserNotifications;
        monitor.baselineReady = false;
        monitor.announcementIds.clear();
        monitor.requestIds.clear();
        monitor.chatIds.clear();
        monitor.activeEventKey = '';
        monitor.friendOnline.clear();
        monitor.lastPollAt = 0;
    }

    function stopBrowserNotificationMonitor() {
        const monitor = state.browserNotifications;
        if (monitor.timer) clearTimeout(monitor.timer);
        monitor.timer = null;
        monitor.running = false;
    }

    function scheduleBrowserNotificationPoll(delayMs) {
        const monitor = state.browserNotifications;
        if (monitor.timer) clearTimeout(monitor.timer);
        if (!browserNotificationSupport().enabled || !coralToken()) {
            monitor.timer = null;
            return;
        }
        monitor.timer = setTimeout(() => {
            monitor.timer = null;
            pollBrowserNotifications().catch((error) => {
                console.warn('[BrowserNotifications] Poll failed:', error);
            });
        }, Math.max(0, Number(delayMs) || 0));
    }

    async function pollBrowserNotifications() {
        const monitor = state.browserNotifications;
        if (monitor.running || !browserNotificationSupport().enabled || !coralToken()) return;

        // Coral traffic is encrypted/decrypted through nxapi. Browser notification
        // polling must never compete with sign-in or GameWebServiceToken traffic, so
        // foreground/background lifecycle events cannot force rapid repeated polls.
        const minimumGap = monitor.baselineReady ? (document.hidden ? 10 * 60_000 : 15 * 60_000) : 0;
        const elapsed = Date.now() - Number(monitor.lastPollAt || 0);
        if (minimumGap && elapsed < minimumGap) {
            scheduleBrowserNotificationPoll(minimumGap - elapsed);
            return;
        }

        monitor.running = true;
        monitor.lastPollAt = Date.now();

        try {
            const settings = await loadPushSettings().catch(() => state.pushSettings || {});
            const jobs = [
                coralExact('announcements').then((value) => ({ type: 'announcements', value })).catch(() => null),
                coralExact('friends').then((value) => ({ type: 'friends', value })).catch(() => null)
            ];
            if (settings?.friendRequest) {
                jobs.push(coralExact('receivedRequests').then((value) => ({ type: 'requests', value })).catch(() => null));
            }
            if (settings?.chatInvitation) {
                jobs.push(coralExact('chats').then((value) => ({ type: 'chats', value })).catch(() => null));
            }
            if (settings?.playInvitation && settings.playInvitation !== 'NONE') {
                jobs.push(coralExact('activeEvent').then((value) => ({ type: 'active-event', value })).catch(() => null));
            }

            const results = (await Promise.all(jobs)).filter(Boolean);
            const baselineOnly = !monitor.baselineReady;

            for (const result of results) {
                if (result.type === 'announcements') {
                    const items = Array.isArray(result.value) ? result.value : (result.value?.announcements || []);
                    state.announcements = items;
                    updateAnnouncementDot();
                    const next = new Set();
                    for (const item of items) {
                        const key = browserNotificationKey(item, 'announcement');
                        next.add(key);
                        if (!baselineOnly && !monitor.announcementIds.has(key) && item?.isRead !== true) {
                            fireBrowserNotification(
                                item?.title || 'Nintendo Switch App',
                                {
                                    body: item?.description || item?.body || item?.message || 'You have a new notification.',
                                    icon: item?.imageUri || undefined,
                                    tag: `nso-announcement-${key}`
                                },
                                () => openAnnouncements()
                            );
                        }
                    }
                    monitor.announcementIds = next;
                }

                if (result.type === 'requests') {
                    const items = Array.isArray(result.value)
                        ? result.value
                        : (result.value?.friendRequests || result.value?.requests || []);
                    const next = new Set();
                    for (const request of items) {
                        const key = browserNotificationKey(request, 'friend-request');
                        next.add(key);
                        if (!baselineOnly && !monitor.requestIds.has(key)) {
                            const person = personFromRequest(request);
                            fireBrowserNotification(
                                'Friend Request',
                                {
                                    body: person?.name ? `${person.name} sent you a friend request.` : 'You received a friend request.',
                                    icon: person?.imageUri || person?.image2Uri || undefined,
                                    tag: `nso-friend-request-${key}`
                                },
                                () => $('openAddFriendBtn')?.click()
                            );
                        }
                    }
                    monitor.requestIds = next;
                }

                if (result.type === 'chats') {
                    const items = Array.isArray(result.value) ? result.value : (result.value?.chats || result.value?.chatList || []);
                    const next = new Set();
                    for (const chat of items) {
                        const key = browserNotificationKey(chat, 'chat');
                        next.add(key);
                        if (!baselineOnly && !monitor.chatIds.has(key)) {
                            const host = chat?.owner || chat?.host || chat?.user || {};
                            fireBrowserNotification(
                                'GameChat Invite',
                                {
                                    body: host?.name ? `${host.name} invited you to GameChat.` : 'You have a new GameChat invite.',
                                    icon: host?.imageUri || undefined,
                                    tag: `nso-chat-${key}`
                                },
                                () => openChatPage()
                            );
                        }
                    }
                    monitor.chatIds = next;
                }

                if (result.type === 'active-event') {
                    const event = result.value?.event || result.value || null;
                    const key = event ? browserNotificationKey(event, 'active-event') : '';
                    if (!baselineOnly && key && monitor.activeEventKey && key !== monitor.activeEventKey) {
                        const inviter = event?.owner || event?.host || event?.inviter || {};
                        fireBrowserNotification(
                            'Online Play Invitation',
                            {
                                body: inviter?.name ? `${inviter.name} invited you to play.` : 'You have a new online play invitation.',
                                icon: inviter?.imageUri || undefined,
                                tag: `nso-play-invite-${key}`
                            },
                            () => openChatPage()
                        );
                    }
                    monitor.activeEventKey = key;
                }

                if (result.type === 'friends') {
                    const friends = Array.isArray(result.value) ? result.value : (result.value?.friends || []);
                    const next = new Map();
                    const now = Date.now();
                    for (const friend of friends) {
                        const id = String(friend?.nsaId || friend?.id || '');
                        if (!id) continue;
                        const online = isFriendOnline(friend);
                        next.set(id, online);
                        const wasOnline = monitor.friendOnline.get(id);
                        const wantsNotice = friend?.isOnlineNotificationEnabled === true;
                        const lastNotice = monitor.lastFriendOnlineNotice.get(id) || 0;
                        if (!baselineOnly && wantsNotice && wasOnline === false && online && now - lastNotice > 30 * 60 * 1000) {
                            monitor.lastFriendOnlineNotice.set(id, now);
                            fireBrowserNotification(
                                'Friend Online',
                                {
                                    body: friend?.name ? `${friend.name} is online.` : 'A friend came online.',
                                    icon: friend?.imageUri || friend?.image2Uri || undefined,
                                    tag: `nso-friend-online-${id}`
                                },
                                () => openFriendDetail(friend)
                            );
                        }
                    }
                    monitor.friendOnline = next;
                }
            }

            monitor.baselineReady = true;
        } finally {
            monitor.running = false;
            // Keep polling deliberately conservative: Coral calls are authenticated and
            // encrypted through nxapi, so browser notifications must not become a request storm.
            if (browserNotificationSupport().enabled && coralToken()) {
                const steadyDelay = document.hidden ? 10 * 60_000 : 15 * 60_000;
                const rateLimitUntil = typeof getRateLimitUntil === 'function'
                    ? Math.max(getRateLimitUntil('auth'), getRateLimitUntil('encrypt'), getRateLimitUntil('decrypt'))
                    : 0;
                const rateLimitDelay = rateLimitUntil > Date.now() ? (rateLimitUntil - Date.now() + 2000) : 0;
                scheduleBrowserNotificationPoll(Math.max(steadyDelay, rateLimitDelay));
            }
        }
    }

    function startBrowserNotificationMonitor({ resetBaseline = false, immediate = true } = {}) {
        if (!browserNotificationSupport().enabled || !coralToken()) {
            stopBrowserNotificationMonitor();
            return;
        }
        if (resetBaseline) resetBrowserNotificationBaseline();
        scheduleBrowserNotificationPoll(immediate ? 0 : (document.hidden ? 10 * 60_000 : 15 * 60_000));
    }

    async function toggleBrowserNotifications() {
        const status = browserNotificationSupport();
        if (!status.supported || status.permission === 'denied') return;

        if (status.enabled) {
            setBrowserNotificationPreference(false);
            stopBrowserNotificationMonitor();
            return;
        }

        let permission = status.permission;
        if (permission !== 'granted') {
            permission = await Notification.requestPermission();
        }
        if (permission === 'granted') {
            setBrowserNotificationPreference(true);
            startBrowserNotificationMonitor({ resetBaseline: true, immediate: true });
        } else {
            setBrowserNotificationPreference(false);
            stopBrowserNotificationMonitor();
        }
    }

    function installBrowserNotificationLifecycle() {
        if (window.__nsoBrowserNotificationLifecycleInstalled) return;
        window.__nsoBrowserNotificationLifecycleInstalled = true;
        document.addEventListener('visibilitychange', () => {
            if (!browserNotificationSupport().enabled || !coralToken()) return;
            // Reconcile promptly when the tab changes foreground/background state,
            // then fall back to the conservative steady-state polling interval.
            scheduleBrowserNotificationPoll(document.hidden ? 1500 : 5000);
        });
        window.addEventListener('online', () => {
            if (browserNotificationSupport().enabled && coralToken()) {
                scheduleBrowserNotificationPoll(1500);
            }
        });
    }

    async function openPushNotifications(returnTarget = 'opSettingsPage') {
        ensureScreens();
        state.pushReturnTarget = returnTarget || 'opSettingsPage';
        openScreen('opPushPage');
        const body = $('opPushBody');
        body.innerHTML = '<p class="op-loading"><i class="fa-solid fa-spinner fa-spin"></i> Loading…</p>';
        try {
            const [settings, services] = await Promise.all([
                loadPushSettings(true),
                loadWebServicesForSettings(true).catch(() => [])
            ]);
            body.innerHTML = `
                <section class="op-group op-no-margin">
                    <h4>Browser Notifications</h4>
                    <div class="op-browser-notification-card">
                        <div>
                            <b>Show NSO Notifications in This Browser</b>
                            <small id="opBrowserNotificationStatus">${escapeHtml(browserNotificationStatusText())}</small>
                        </div>
                        <button type="button" class="op-browser-notification-action" id="opBrowserNotificationsAction" ${!browserNotificationSupport().supported || browserNotificationSupport().permission === 'denied' ? 'disabled' : ''}>${escapeHtml(browserNotificationActionText())}</button>
                    </div>
                    <p class="op-group-notice">Browser notifications follow your Nintendo notification settings and run only while this web app is open. No Nintendo or nxapi credentials are stored for browser notifications.</p>
                </section>
                <section class="op-group">
                    <label class="op-toggle-row"><span><b>Friend Requests</b><small>You'll get notifications when receiving friend requests and when other users accept your friend requests.</small></span><input id="opPushFriendRequest" type="checkbox" ${settings.friendRequest ? 'checked' : ''}><i></i></label>
                    <label class="op-toggle-row"><span><b>GameChat Invites</b><small>You'll get GameChat-invite notifications.</small></span><input id="opPushChatInvitation" type="checkbox" ${settings.chatInvitation ? 'checked' : ''}><i></i></label>
                    <button class="op-row" id="opPushFriendOnline"><span><b>Notify When Friends Come Online</b><small>Choose individual friends.</small></span><i class="fa-solid fa-chevron-right"></i></button>
                </section>
                <section class="op-group">
                    <h4>Online Play Invitations</h4>
                    <p class="op-group-notice">You'll get play-invite notifications.</p>
                    <div class="op-radio-list" id="opPlayInviteRadios">
                        ${[['FRIENDS','All Friends'],['FAVORITE_FRIENDS','Best Friends'],['NONE',"Don't Notify"]].map(([value,label]) => `<label class="op-radio-row"><span>${escapeHtml(label)}</span><input type="radio" name="opPlayInvite" value="${value}" ${settings.playInvitation === value ? 'checked' : ''}></label>`).join('')}
                    </div>
                </section>
                <section class="op-group">
                    <h4>Game-Specific Services</h4>
                    <p class="op-group-notice">You'll get game-related notifications.</p>
                    <div id="opGwsPushList">${renderGwsPushRows(services)}</div>
                </section>`;

            const browserAction = $('opBrowserNotificationsAction');
            browserAction?.addEventListener('click', async () => {
                browserAction.disabled = true;
                try {
                    await toggleBrowserNotifications();
                } finally {
                    const latest = browserNotificationSupport();
                    browserAction.textContent = browserNotificationActionText();
                    browserAction.disabled = !latest.supported || latest.permission === 'denied';
                    const status = $('opBrowserNotificationStatus');
                    if (status) status.textContent = browserNotificationStatusText();
                }
            });

            bindPushControls(services);
        } catch (error) {
            body.innerHTML = `<p class="service-status error">Couldn't load notification settings: ${escapeHtml(error.message)}</p>`;
        }
    }

    function renderGwsPushRows(services) {
        const supported = (services || []).filter((s) => s?.isNotificationSupported);
        if (!supported.length) return '<p class="op-muted op-pad">No game-specific notification settings are available.</p>';
        return supported.map((s) => `
            <label class="op-toggle-row op-gws-toggle">
                <span class="op-gws-label"><img src="${escapeHtml(s.imageUri || '')}" alt=""><b>${escapeHtml(s.name || 'Game-Specific Service')}</b></span>
                <input type="checkbox" data-gws-id="${escapeHtml(String(s.id))}" ${s.isNotificationAllowed ? 'checked' : ''}><i></i>
            </label>`).join('');
    }

    function bindPushControls(services) {
        const bindToggle = (id, type) => {
            const input = $(id);
            input?.addEventListener('change', async () => {
                const desired = input.checked;
                input.disabled = true;
                try {
                    await updatePush({ type, value: desired });
                    toast('Notification setting changed.');
                } catch (error) {
                    input.checked = !desired;
                    alert(`Could not update notification setting: ${error.message}`);
                } finally { input.disabled = false; }
            });
        };
        bindToggle('opPushFriendRequest', 'friendRequest');
        bindToggle('opPushChatInvitation', 'chatInvitation');
        $('opPushFriendOnline')?.addEventListener('click', () => openFriendOnlineSettings('opPushPage'));

        $('opPlayInviteRadios')?.querySelectorAll('input').forEach((input) => {
            input.addEventListener('change', async () => {
                if (!input.checked) return;
                const old = state.pushSettings.playInvitation;
                $('opPlayInviteRadios').querySelectorAll('input').forEach((x) => x.disabled = true);
                try {
                    await updatePush({ type: 'playInvitation', scope: input.value });
                    toast('Notification setting changed.');
                } catch (error) {
                    const prev = $('opPlayInviteRadios').querySelector(`input[value="${CSS.escape(old || '')}"]`);
                    if (prev) prev.checked = true;
                    alert(`Could not update notification setting: ${error.message}`);
                } finally {
                    $('opPlayInviteRadios').querySelectorAll('input').forEach((x) => x.disabled = false);
                }
            });
        });

        $('opGwsPushList')?.querySelectorAll('input[data-gws-id]').forEach((input) => {
            input.addEventListener('change', async () => {
                const id = Number(input.dataset.gwsId);
                const desired = input.checked;
                input.disabled = true;
                try {
                    await coralExact('pushUpdate', [{ type: 'gws', gwsId: id, value: desired }]);
                    const service = services.find((s) => Number(s.id) === id);
                    if (service) service.isNotificationAllowed = desired;
                    toast('Notification setting changed.');
                } catch (error) {
                    input.checked = !desired;
                    alert(`Could not update game notification setting: ${error.message}`);
                } finally { input.disabled = false; }
            });
        });
    }

    async function openFriendOnlineSettings(returnTarget = 'opPushPage') {
        ensureScreens();
        state.friendOnlineReturnTarget = returnTarget || 'opPushPage';
        openScreen('opFriendOnlinePage');
        const list = $('opFriendOnlineList');
        let friends = getCurrentFriends();
        if (!friends.length) {
            try {
                const result = await coralExact('friends');
                friends = Array.isArray(result) ? result : (result?.friends || []);
            } catch {}
        }
        if (!friends.length) {
            list.innerHTML = '<p class="op-empty">Friends will appear here.</p>';
            return;
        }
        list.innerHTML = friends.map((friend) => `
            <label class="op-friend-toggle-row">
                <img src="${escapeHtml(friend.imageUri || friend.image2Uri || '')}" alt="">
                <span><b>${escapeHtml(friend.name || 'Switch Player')}</b></span>
                <input type="checkbox" data-nsa-id="${escapeHtml(friend.nsaId || '')}" ${friend.isOnlineNotificationEnabled ? 'checked' : ''}>
                <i></i>
            </label>`).join('');
        list.querySelectorAll('input[data-nsa-id]').forEach((input) => {
            input.addEventListener('change', async () => {
                const desired = input.checked;
                input.disabled = true;
                try {
                    await coralExact('friendOnlinePush', [{ type: 'friendOnline', value: desired, friendId: input.dataset.nsaId }]);
                    const friend = friends.find((f) => f.nsaId === input.dataset.nsaId);
                    if (friend) friend.isOnlineNotificationEnabled = desired;
                    toast('Notification setting changed.');
                } catch (error) {
                    input.checked = !desired;
                    alert(`Could not update online notification: ${error.message}`);
                } finally { input.disabled = false; }
            });
        });
    }

    function localSetting(key, fallback = '') {
        try {
            const value = localStorage.getItem(`nso_official_${key}`);
            return value == null ? fallback : value;
        } catch { return fallback; }
    }

    function saveLocalSetting(key, value) {
        try { localStorage.setItem(`nso_official_${key}`, String(value)); } catch {}
    }

    function darkModeLabel(mode) {
        return ({ system: 'Device Settings', on: 'On', off: 'Off' })[mode] || 'Device Settings';
    }

    function effectiveDarkMode(mode = localSetting('dark_mode', 'system')) {
        if (mode === 'on') return true;
        if (mode === 'off') return false;
        return globalThis.matchMedia?.('(prefers-color-scheme: dark)')?.matches !== false;
    }

    function applyDarkMode(mode = localSetting('dark_mode', 'system')) {
        const dark = effectiveDarkMode(mode);
        document.body.classList.toggle('dark-theme', dark);
        document.body.classList.toggle('op-light-theme', !dark);
        document.documentElement.style.colorScheme = dark ? 'dark' : 'light';
        try {
            if (typeof initDockLottiePlayers === 'function') initDockLottiePlayers();
        } catch {}
    }

    function installSystemThemeWatcher() {
        const media = globalThis.matchMedia?.('(prefers-color-scheme: dark)');
        if (!media || media.__nsoMediaBound) return;
        media.__nsoMediaBound = true;
        media.addEventListener?.('change', () => {
            if (localSetting('dark_mode', 'system') === 'system') applyDarkMode('system');
        });
    }

    function openDarkModeSetting() {
        ensureScreens();
        const current = localSetting('dark_mode', 'system');
        $('opDarkModeBody').innerHTML = `
            <div class="op-radio-list">
                ${[['system','Device Settings'],['on','On'],['off','Off']].map(([value,label]) => `
                    <label class="op-radio-row"><span>${label}</span><input type="radio" name="opDarkMode" value="${value}" ${current === value ? 'checked' : ''}></label>`).join('')}
            </div>
            <div class="op-info-card">If set to Device Settings, the app display will change to match the settings on the device you're using.</div>`;
        openScreen('opDarkModePage');
        $('opDarkModeBody').querySelectorAll('input[name="opDarkMode"]').forEach((input) => {
            input.addEventListener('change', () => {
                if (!input.checked) return;
                saveLocalSetting('dark_mode', input.value);
                applyDarkMode(input.value);
                renderSettingsPage();
            });
        });
    }

    function mobileDataLabel(value) {
        return ({ standard: 'Standard', low: 'Low Data', never: "Don't Allow" })[value] || 'Standard';
    }

    function openMobileDataSetting() {
        ensureScreens();
        const current = localSetting('mobile_data', 'standard');
        $('opMobileDataBody').innerHTML = `
            <div class="op-radio-list">
                ${[['standard','Standard'],['low','Low Data'],['never',"Don't Allow"]].map(([value,label]) => `
                    <label class="op-radio-row"><span>${label}</span><input type="radio" name="opMobileData" value="${value}" ${current === value ? 'checked' : ''}></label>`).join('')}
            </div>
            <div class="op-info-card">If set to Low Data, videos won't play automatically. If set to Don't Allow, videos won't load.<br><br>Features will not be restricted when using a Wi-Fi connection.</div>`;
        openScreen('opMobileDataPage');
        $('opMobileDataBody').querySelectorAll('input[name="opMobileData"]').forEach((input) => {
            input.addEventListener('change', () => {
                if (!input.checked) return;
                saveLocalSetting('mobile_data', input.value);
                enforceMobileDataPreference();
                renderSettingsPage();
                toast('Mobile-data setting changed.');
            });
        });
    }

    function openUsageDataSetting() {
        ensureScreens();
        const allowed = localSetting('usage_data', 'deny') === 'allow';
        $('opUsageDataBody').innerHTML = `
            <div class="op-copy-page">
                <p>If you select Allow, this application and its game-specific services will collect data, including via cookies, and will send it to Nintendo in order to analyze Nintendo's performance and provide Nintendo with statistics to optimize content, products, and services.</p>
                <p>You can change this setting at any time from About Sending Usage Data. If you change this setting, this will not affect data that was already collected.</p>
                <div class="op-radio-list op-inline-radio-list">
                    <label class="op-radio-row"><span>Allow</span><input type="radio" name="opUsageData" value="allow" ${allowed ? 'checked' : ''}></label>
                    <label class="op-radio-row"><span>Don't Allow</span><input type="radio" name="opUsageData" value="deny" ${!allowed ? 'checked' : ''}></label>
                </div>
                <p class="op-muted">Web-port note: this preference is preserved locally. The web port does not invent a Nintendo analytics transport that is not present in this project.</p>
            </div>`;
        openScreen('opUsageDataPage');
        $('opUsageDataBody').querySelectorAll('input[name="opUsageData"]').forEach((input) => {
            input.addEventListener('change', () => {
                if (!input.checked) return;
                saveLocalSetting('usage_data', input.value);
                renderSettingsPage();
                toast('Usage-data preference changed.');
            });
        });
    }

    function isLikelyCellularConnection() {
        const connection = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
        return connection?.type === 'cellular';
    }

    function enforceMobileDataPreference() {
        const apply = () => {
            if (!isLikelyCellularConnection()) return;
            const pref = localSetting('mobile_data', 'standard');
            document.querySelectorAll('#mediaModal video').forEach((video) => {
                if (pref === 'low') video.autoplay = false;
                if (pref === 'never') {
                    video.pause();
                    video.removeAttribute('src');
                    video.load();
                }
            });
        };
        apply();
        if (state.mobileObserver) return;
        state.mobileObserver = new MutationObserver(apply);
        state.mobileObserver.observe(document.body, { childList: true, subtree: true });
    }

    async function openLegalNotices() {
        ensureScreens();
        const host = $('opLegalBody');
        host.innerHTML = '<p class="op-empty"><i class="fa-solid fa-spinner fa-spin"></i> Loading notices…</p>';
        openScreen('opLegalPage');
        try {
            if (!state.thirdPartyLicenses) {
                const response = await fetch('official-third-party.json?v=20260816-v1', { cache: 'force-cache' });
                if (!response.ok) throw new Error(`HTTP ${response.status}`);
                state.thirdPartyLicenses = await response.json();
            }
            const packages = state.thirdPartyLicenses?.packages || [];
            host.innerHTML = `<div class="op-license-list">${packages.map((item, index) => `
                <button type="button" class="op-row op-license-row" data-license-index="${index}">
                    <span><b>${escapeHtml(item.name || item.dependency || 'Open-source software')}</b><small>${escapeHtml(item.dependency || '')}</small></span><i class="fa-solid fa-chevron-right"></i>
                </button>`).join('')}</div>`;
            host.querySelectorAll('[data-license-index]').forEach((button) => {
                button.addEventListener('click', () => {
                    const item = packages[Number(button.dataset.licenseIndex)];
                    openLicenseDetail(item);
                });
            });
        } catch (error) {
            host.innerHTML = `<p class="op-empty">Could not load intellectual-property notices: ${escapeHtml(error.message)}</p>`;
        }
    }

    function openLicenseDetail(item) {
        const data = state.thirdPartyLicenses || {};
        const files = item?.license_file_names || [];
        const text = files.map((name) => data.licenses?.[name] || '').filter(Boolean).join('\n\n');
        $('opLicenseDetailPage').querySelector('h2').textContent = item?.name || 'License';
        $('opLicenseDetailBody').innerHTML = `
            <div class="op-copy-page op-license-detail">
                ${item?.dependency ? `<p><b>${escapeHtml(item.dependency)}</b></p>` : ''}
                ${item?.url ? `<p><a class="op-inline-link" href="${escapeHtml(item.url)}" target="_blank" rel="noopener noreferrer">Project Website <i class="fa-solid fa-arrow-up-right-from-square"></i></a></p>` : ''}
                <pre>${escapeHtml(text || 'License text is not available in this package.')}</pre>
            </div>`;
        openScreen('opLicenseDetailPage');
    }

    function renderSettingsPage() {
        const version = (() => { try { return typeof ZNCA_VERSION !== 'undefined' ? ZNCA_VERSION : '3.4.1'; } catch { return '3.4.1'; } })();
        const supportCode = state.currentUser?.supportId || sessionUser()?.supportId || '';
        const factor = state.loginFactor || {};
        const profileSummary = factor.email || factor.loginId || state.currentUser?.name || sessionUser()?.name || 'Nintendo Account';
        const usageAllowed = localSetting('usage_data', 'deny') === 'allow';
        const settingsUser = state.currentUser || sessionUser() || {};
        const settingsPermissions = state.permissions?.permissions || settingsUser.permissions || {};
        const settingsFriendCode = settingsUser.links?.friendCode?.id || $('opFriendCode')?.textContent || '—';
        $('opSettingsBody').innerHTML = `
            <section class="op-group op-no-margin">
                <h4>Nintendo Account</h4>
                <button class="op-row" id="opSettingsProfile"><span><b>Profile</b><small>${escapeHtml(profileSummary)}</small></span><i class="fa-solid fa-chevron-right"></i></button>
                <button class="op-row" id="opFriendCodeRow"><span><b>Friend Code</b><small>${escapeHtml(settingsFriendCode)}</small></span><i class="fa-solid fa-chevron-right"></i></button>
                <button class="op-row" id="opOnlineStatusRow"><span><b>Online Status</b><small>${escapeHtml(permissionLabel('presence', settingsPermissions.presence))}</small></span><i class="fa-solid fa-chevron-right"></i></button>
                <button class="op-row" id="opPlayActivityRow"><span><b>Play Activity</b><small>${escapeHtml(permissionLabel('playLog', settingsPermissions.playLog))}</small></span><i class="fa-solid fa-chevron-right"></i></button>
                <button class="op-row" id="opNintendoAccountRow"><span><b>Nintendo Account Website</b></span><i class="fa-solid fa-arrow-up-right-from-square"></i></button>
            </section>
            <section class="op-group">
                <h4>Notifications</h4>
                <button class="op-row" id="opPushNotificationsRow"><span><b>Push Notifications</b></span><i class="fa-solid fa-chevron-right"></i></button>
            </section>
            <section class="op-group">
                <h4>System</h4>
                <button class="op-row" id="opSettingsDarkMode"><span><b>Dark Mode</b><small>${escapeHtml(darkModeLabel(localSetting('dark_mode', 'system')))}</small></span><i class="fa-solid fa-chevron-right"></i></button>
                <button class="op-row" id="opSettingsMobileData"><span><b>Mobile Data</b><small>${escapeHtml(mobileDataLabel(localSetting('mobile_data', 'standard')))}</small></span><i class="fa-solid fa-chevron-right"></i></button>
                <button class="op-row" id="opSettingsStorage"><span><b>Storage</b><small>Clear cached images and data.</small></span><i class="fa-solid fa-chevron-right"></i></button>
                <button class="op-row" id="opSettingsUsageData"><span><b>About Sending Usage Data</b><small>${usageAllowed ? 'Allow Sending Usage Data' : "Don't Allow"}</small></span><i class="fa-solid fa-chevron-right"></i></button>
            </section>
            <section class="op-group">
                <h4>Other</h4>
                <button class="op-row" id="opSettingsFeedback"><span><b>Feedback</b><small>Send feedback about this app.</small></span><i class="fa-solid fa-chevron-right"></i></button>
            </section>
            <section class="op-group">
                <h4>About This App</h4>
                <a class="op-row" href="https://accounts.nintendo.com/term_chooser/eula" target="_blank" rel="noopener"><span><b>Nintendo Account User Agreement</b></span><i class="fa-solid fa-arrow-up-right-from-square"></i></a>
                <a class="op-row" href="https://www.nintendo.com/privacy-policy/" target="_blank" rel="noopener"><span><b>Nintendo Privacy Policy</b></span><i class="fa-solid fa-arrow-up-right-from-square"></i></a>
                <button class="op-row" id="opSettingsLegal"><span><b>Intellectual Property Notices</b></span><i class="fa-solid fa-chevron-right"></i></button>
                <a class="op-row" href="https://support.nintendo.com/" target="_blank" rel="noopener"><span><b>Nintendo Support</b></span><i class="fa-solid fa-arrow-up-right-from-square"></i></a>
                ${supportCode ? `<div class="op-row op-static"><span><b>Support Code</b><small>${escapeHtml(supportCode)}</small></span></div>` : ''}
                <div class="op-row op-static"><span><b>Version</b><small>${escapeHtml(version)}</small></span></div>
                <div class="op-row op-static"><span><b>© Nintendo</b></span></div>
            </section>
            <button class="op-signout" id="opSettingsSignOutBtn"><i class="fa-solid fa-right-from-bracket"></i> Sign Out</button>`;
        $('opSettingsProfile')?.addEventListener('click', () => {
            openUserPage();
        });
        $('opFriendCodeRow')?.addEventListener('click', () => $('openMyCodeQrBtn')?.click());
        $('opOnlineStatusRow')?.addEventListener('click', () => openVisibility('presence', 'opSettingsPage'));
        $('opPlayActivityRow')?.addEventListener('click', () => openVisibility('playLog', 'opSettingsPage'));
        $('opNintendoAccountRow')?.addEventListener('click', () => window.open('https://accounts.nintendo.com/', '_blank', 'noopener'));
        $('opPushNotificationsRow')?.addEventListener('click', () => openPushNotifications('opSettingsPage'));
        $('opSettingsSignOutBtn')?.addEventListener('click', async () => {
            const ok = await confirmSheet('Sign Out', 'Sign out of Nintendo Switch App?', 'Sign Out');
            if (ok && typeof logout === 'function') logout();
        });
        $('opSettingsDarkMode')?.addEventListener('click', openDarkModeSetting);
        $('opSettingsMobileData')?.addEventListener('click', openMobileDataSetting);
        $('opSettingsUsageData')?.addEventListener('click', openUsageDataSetting);
        $('opSettingsLegal')?.addEventListener('click', openLegalNotices);
        $('opSettingsFeedback')?.addEventListener('click', openFeedback);
        $('opSettingsStorage')?.addEventListener('click', async () => {
            const ok = await confirmSheet('Clear cached images and data?', 'Cached images and data will be cleared, freeing up space on your device.', 'Clear');
            if (!ok) return;
            try {
                if ('caches' in window) {
                    const keys = await caches.keys();
                    await Promise.all(keys.map((key) => caches.delete(key)));
                }
                toast('Cleared cache.');
            } catch (error) {
                alert(`Couldn't clear cache: ${error.message}`);
            }
        });
    }

    function openSettings() {
        ensureScreens();

        // Render immediately from current session/cached data so the settings rows
        // exist before the transition starts. Remote Coral calls only enrich labels.
        renderSettingsPage();
        openScreen('opSettingsPage');

        const settingsPage = $('opSettingsPage');
        const scrollHost = settingsPage?.querySelector('.op-scroll') || settingsPage;

        const userRefresh = loadCurrentUserAndPermissions().catch(() => {});
        const factorRefresh = state.loginFactor
            ? Promise.resolve()
            : coralExact('loginFactor')
                .then((factor) => { if (factor) state.loginFactor = factor; })
                .catch(() => {});

        // Run the slow calls concurrently in the background and refresh in place.
        // If the user already left Settings, do not touch the hidden page.
        void Promise.all([userRefresh, factorRefresh]).then(() => {
            if (!settingsPage || settingsPage.classList.contains('hidden')) return;
            const scrollTop = scrollHost?.scrollTop || 0;
            renderSettingsPage();
            if (scrollHost) scrollHost.scrollTop = scrollTop;
        });
    }

    function openFeedback() {
        ensureScreens();
        $('opFeedbackBody').innerHTML = `
            <p class="op-page-prompt">Send feedback about this app.</p>
            <label class="op-field"><span>Topic</span><select id="opFeedbackTopic">
                <option value="4">About Game-Specific Services</option>
                <option value="9">Friend Features</option>
                <option value="10">The Album Feature</option>
                <option value="6">Features You'd Like to See</option>
                <option value="8">App Problems</option>
                <option value="0">Other</option>
            </select></label>
            <label class="op-field"><span>Description</span><textarea id="opFeedbackText" maxlength="1000" placeholder="Your Feedback"></textarea><small id="opFeedbackCount">0/1000</small></label>
            <p class="op-muted">Please be aware that we don't directly reply to feedback we receive.</p>
            <button type="button" class="op-primary" id="opFeedbackSubmit">Submit</button>`;
        openScreen('opFeedbackPage');
        const text = $('opFeedbackText');
        text?.addEventListener('input', () => $('opFeedbackCount').textContent = `${text.value.length}/1000`);
        $('opFeedbackSubmit')?.addEventListener('click', async () => {
            const message = text.value.trim();
            if (!message) { text.focus(); return; }
            const button = $('opFeedbackSubmit');
            setBusy(button, true, 'Submitting…');
            try {
                await coralExact('feedback', {
                    category: Number($('opFeedbackTopic').value),
                    message
                });
                $('opFeedbackBody').innerHTML = `
                    <div class="op-success-state"><i class="fa-solid fa-circle-check"></i><h3>Feedback submitted.</h3><p>We always strive to improve our services. Thanks for your feedback!</p></div>`;
            } catch (error) {
                alert(`Could not submit feedback: ${error.message}`);
            } finally { setBusy(button, false); }
        });
    }

    function ensureHomeChatSection() {
        const home = $('page-home');
        if (!home || $('opHomeChatSection')) return;
        const section = document.createElement('section');
        section.id = 'opHomeChatSection';
        section.className = 'home-content-section op-home-chat';
        section.innerHTML = `
            <div class="op-section-title-row"><h2>GameChat</h2><button type="button" id="opOpenChatPage">Details</button></div>
            <div id="opHomeChatContent" class="op-chat-strip"><p class="service-status">Loading GameChat…</p></div>`;
        const gws = $('gameServicesCatalog')?.closest('.home-content-section');
        if (gws) home.insertBefore(section, gws); else home.appendChild(section);
        $('opOpenChatPage')?.addEventListener('click', openChatPage);
    }

    function normalizeChat(chat) {
        const inviter = chat?.inviter || chat?.creator || {};
        return {
            raw: chat,
            chatId: chat?.chatId || chat?.id || chat?.chat?.id || '',
            invitedAt: chat?.invitedAt || chat?.createdAt || chat?.startedAt || null,
            inviter: {
                nsaId: inviter?.nsaId || '',
                imageUri: inviter?.imageUri || inviter?.image2Uri || '',
                name: inviter?.name || inviter?.nickname || '',
                isMe: Boolean(inviter?.isMe || inviter?.isSelf)
            }
        };
    }

    async function loadChats(force = false) {
        if (!force && state.chats.length) return state.chats;
        const result = await coralExact('chats');
        const raw = Array.isArray(result) ? result : (result?.chats || result?.chatList || []);
        state.chats = raw.map(normalizeChat);
        return state.chats;
    }

    async function refreshHomeChat() {
        ensureHomeChatSection();
        const host = $('opHomeChatContent');
        if (!host) return;
        try {
            const chats = await loadChats(true);
            if (!chats.length) {
                host.innerHTML = `<button type="button" class="op-chat-empty-card" id="opChatHowToHome"><i class="fa-solid fa-comments"></i><span><b>You can use GameChat from your Nintendo Switch 2 system.</b><small>How to Use GameChat</small></span><i class="fa-solid fa-chevron-right"></i></button>`;
                $('opChatHowToHome')?.addEventListener('click', openChatPage);
                return;
            }
            host.innerHTML = chats.slice(0, 4).map((chat, index) => `
                <button class="op-chat-card" data-chat-index="${index}">
                    <img src="${escapeHtml(chat.inviter.imageUri)}" alt="">
                    <span><b>${escapeHtml(chat.inviter.isMe ? 'Invitation you sent' : `Invitation from ${chat.inviter.name || 'a friend'}`)}</b><small>${escapeHtml(relativeTime(chat.invitedAt))}</small></span>
                </button>`).join('');
            host.querySelectorAll('[data-chat-index]').forEach((button) => button.addEventListener('click', () => openChatDetail(chats[Number(button.dataset.chatIndex)])));
        } catch (error) {
            // GameChat may not be available to every account. Keep Home usable.
            host.innerHTML = `<button type="button" class="op-chat-empty-card" id="opChatHowToHome"><i class="fa-solid fa-comments"></i><span><b>You can use GameChat from your Nintendo Switch 2 system.</b><small>How to Use GameChat</small></span><i class="fa-solid fa-chevron-right"></i></button>`;
            $('opChatHowToHome')?.addEventListener('click', openChatPage);
            console.debug('[NSO] Chat/List unavailable', error);
        }
    }

    function howToChatHtml() {
        return `
            <div class="op-info-card">You can use GameChat from your Nintendo Switch 2 system.</div>
            <h3 class="op-subtitle">How to Use GameChat</h3>
            <ol class="op-steps">
                <li><b>Power on your Nintendo Switch 2 system.</b><small>◆ This feature cannot be used on a Nintendo Switch system.</small></li>
                <li><b>Open GameChat.</b><small>To open GameChat, you can also go to the HOME Menu and select GameChat.</small></li>
                <li><b>Join or start a chat session!</b></li>
            </ol>`;
    }

    async function openChatPage() {
        ensureScreens();
        const body = $('opChatBody');
        body.innerHTML = '<p class="op-loading"><i class="fa-solid fa-spinner fa-spin"></i> Loading…</p>';
        openScreen('opChatPage');
        try {
            const chats = await loadChats(true);
            body.innerHTML = `${howToChatHtml()}<h3 class="op-subtitle">Chat Invitations</h3><div id="opChatList"></div>`;
            const list = $('opChatList');
            if (!chats.length) {
                list.innerHTML = '<p class="op-empty">No chat invitations right now.</p>';
            } else {
                list.innerHTML = chats.map((chat, index) => `
                    <button class="op-chat-list-row" data-chat-index="${index}">
                        <img src="${escapeHtml(chat.inviter.imageUri)}" alt="">
                        <span><b>${escapeHtml(chat.inviter.isMe ? 'Invitation you sent' : `Invitation from ${chat.inviter.name || 'a friend'}`)}</b><small>${escapeHtml(formatDate(chat.invitedAt))}</small></span>
                        <i class="fa-solid fa-chevron-right"></i>
                    </button>`).join('');
                list.querySelectorAll('[data-chat-index]').forEach((button) => button.addEventListener('click', () => openChatDetail(chats[Number(button.dataset.chatIndex)])));
            }
        } catch (error) {
            body.innerHTML = `${howToChatHtml()}<p class="service-status error">Couldn't load GameChat invitations: ${escapeHtml(error.message)}</p>`;
        }
    }

    function normalizeChatMember(member) {
        return {
            nsaId: member?.nsaId || '',
            imageUri: member?.imageUri || member?.image2Uri || '',
            name: member?.name || 'Switch Player',
            isFriend: Boolean(member?.isFriend),
            isJoined: Boolean(member?.isJoined || member?.isInChat || member?.joined),
            isInvited: Boolean(member?.isInvited),
            isMe: Boolean(member?.isMe || member?.isSelf)
        };
    }

    async function openChatDetail(chat) {
        ensureScreens();
        state.activeChat = chat;
        const body = $('opChatDetailBody');
        openScreen('opChatDetailPage');
        body.innerHTML = '<p class="op-loading"><i class="fa-solid fa-spinner fa-spin"></i> Loading…</p>';
        if (!chat?.chatId) {
            body.innerHTML = '<p class="op-empty">Couldn\'t find the chat.</p>';
            return;
        }
        try {
            // APK: ChatDetailRequest.Parameter wraps a ChatId value object.
            const detail = await coralExact('chatShow', { chatId: chat.chatId });
            const membersRaw = detail?.members || detail?.chatMembers || [];
            const members = (Array.isArray(membersRaw) ? membersRaw : []).map(normalizeChatMember);
            const inviter = detail?.inviter || chat.inviter || {};
            const started = detail?.invitedAt || detail?.startedAt || chat.invitedAt;
            body.innerHTML = `
                <div class="op-chat-detail-hero"><i class="fa-solid fa-comments"></i><h3>${escapeHtml(inviter?.isMe ? 'Started by you' : `Invited by ${inviter?.name || chat.inviter.name || 'a friend'}`)}</h3><p>${escapeHtml(formatDate(started))}</p></div>
                ${renderChatMemberSection('Users in Chat', members.filter((m) => m.isJoined))}
                ${renderChatMemberSection('Not friends', members.filter((m) => !m.isFriend && !m.isMe))}
                ${renderChatMemberSection('Other Invited Users', members.filter((m) => !m.isJoined && (m.isFriend || m.isMe)))}
            `;
        } catch (error) {
            body.innerHTML = `<p class="service-status error">Couldn't find the chat: ${escapeHtml(error.message)}</p>`;
        }
    }

    function renderChatMemberSection(title, members) {
        if (!members.length) return '';
        return `<section class="op-member-section"><h4>${escapeHtml(title)}</h4>${members.map((m) => `<div class="op-member-row"><img src="${escapeHtml(m.imageUri)}" alt=""><span><b>${escapeHtml(m.name)}</b></span></div>`).join('')}</section>`;
    }

    async function openAnnouncements() {
        ensureScreens();
        openScreen('opAnnouncementPage');
        const body = $('opAnnouncementBody');
        body.innerHTML = '<p class="op-loading"><i class="fa-solid fa-spinner fa-spin"></i> Loading…</p>';
        try {
            const result = await coralExact('announcements');
            state.announcements = Array.isArray(result) ? result : (result?.announcements || []);
            renderAnnouncements();
        } catch (error) {
            body.innerHTML = `<p class="service-status error">Couldn't load notifications: ${escapeHtml(error.message)}</p>`;
        }
    }

    function renderAnnouncements() {
        const body = $('opAnnouncementBody');
        if (!state.announcements.length) {
            body.innerHTML = '<p class="op-empty">No notifications right now.</p>';
            updateAnnouncementDot();
            return;
        }
        body.innerHTML = `<div class="op-announcement-list">${state.announcements.map((item, index) => `
            <button class="op-announcement-row ${item.hasRead === false ? 'unread' : ''}" data-announcement-index="${index}">
                <img src="${escapeHtml(item.imageUri || item.image2Uri || '')}" alt="">
                <span><b>${escapeHtml(item.title || 'Nintendo Switch App')}</b><small>${escapeHtml(formatDate(item.deliversAt || item.distributionDate))}</small></span>
                <i class="fa-solid fa-chevron-right"></i>
            </button>`).join('')}</div>`;
        body.querySelectorAll('[data-announcement-index]').forEach((button) => {
            button.addEventListener('click', () => openAnnouncementDetail(Number(button.dataset.announcementIndex)));
        });
        updateAnnouncementDot();
    }

    async function openAnnouncementDetail(index) {
        const item = state.announcements[index];
        if (!item) return;
        if (item.hasRead === false && item.id) {
            item.hasRead = true;
            coralExact('announcementRead', { id: item.id }).catch((error) => console.debug('[NSO] Announcement read marker failed', error));
        }
        const content = item.operation?.contents || item.contents || (item.type === 'FRIEND_REQUEST' ? 'You received a friend request.' : '');
        $('opAnnouncementDetailBody').innerHTML = `
            ${item.imageUri ? `<img class="op-announcement-hero" src="${escapeHtml(item.imageUri)}" alt="">` : ''}
            <article class="op-copy-page"><h3>${escapeHtml(item.title || 'Nintendo Switch App')}</h3><p class="op-muted">${escapeHtml(formatDate(item.deliversAt || item.distributionDate))}</p><p>${escapeHtml(content)}</p>${item.type === 'FRIEND_REQUEST' ? '<button class="op-primary" id="opAnnouncementOpenRequests">View Friend Requests</button>' : ''}</article>`;
        openScreen('opAnnouncementDetailPage');
        $('opAnnouncementOpenRequests')?.addEventListener('click', () => {
            $('opAnnouncementDetailPage')?.classList.add('hidden');
            $('addFriendView')?.classList.remove('hidden');
            $('openAddFriendBtn')?.click();
        });
        renderAnnouncements();
    }

    function updateAnnouncementDot() {
        const unread = state.announcements.some((item) => item.hasRead === false);
        const dot = $('notificationBtn')?.querySelector('span');
        if (dot) dot.style.display = unread ? '' : 'none';
        $('notificationBtn')?.setAttribute('aria-label', unread ? 'Notifications — unread notifications' : 'Notifications');
    }

    function installAlbumFeatures() {
        const title = $('albumPageTitle');
        if (title) title.textContent = 'Uploaded Data';
        const header = title?.closest('.album-toolbar-header');
        if (header && !$('opAlbumAboutBtn')) {
            const btn = document.createElement('button');
            btn.id = 'opAlbumAboutBtn';
            btn.type = 'button';
            btn.className = 'op-header-info-button';
            btn.innerHTML = '<i class="fa-solid fa-circle-info"></i> About';
            btn.addEventListener('click', () => { ensureScreens(); openScreen('opAlbumAboutPage'); });
            header.querySelector('.album-batch-actions')?.prepend(btn);
        }

        bindControl('mediaInfoBtn', async () => {
            const item = currentMediaItem();
            if (!item) return;
            const meta = $('mediaModalMeta');
            if (!meta) return;
            meta.classList.remove('hidden');
            meta.innerHTML = '<p class="op-loading"><i class="fa-solid fa-spinner fa-spin"></i> Loading details…</p>';
            let tags = '';
            if (item.applicationId != null && item.platformId != null) {
                try {
                    const result = await coralExact('mediaHashtags', {
                        applications: [{
                            platformId: item.platformId,
                            acdIndex: item.acdIndex,
                            extraData: item.extraData,
                            applicationId: item.applicationId
                        }]
                    });
                    tags = result?.tags || '';
                } catch (error) {
                    console.debug('[NSO] Hashtag/List unavailable', error);
                }
            }
            const expiration = expirationLabel(item.expiresAt);
            meta.innerHTML = `
                <div class="op-media-details">
                    ${detailRow('Software name:', item.appName || 'Nintendo Switch')}
                    ${detailRow('Date captured:', formatDate(item.capturedAt))}
                    ${detailRow('Date uploaded:', formatDate(item.uploadedAt))}
                    ${detailRow('Storage time:', expiration)}
                    ${detailRow('Hashtags:', tags || '—', 'opMediaHashtags')}
                </div>
                ${tags ? '<button type="button" class="op-secondary" id="opCopyHashtags">Copy Hashtags</button>' : ''}`;
            $('opCopyHashtags')?.addEventListener('click', async () => {
                try { await navigator.clipboard.writeText(tags); toast('Hashtags copied.'); }
                catch { prompt('Copy hashtags:', tags); }
            });
        });
    }

    function detailRow(label, value, valueId = '') {
        return `<div class="op-detail-row"><b>${escapeHtml(label)}</b><span ${valueId ? `id="${valueId}"` : ''}>${escapeHtml(value || '—')}</span></div>`;
    }

    function expirationLabel(value) {
        const ms = toMillis(value);
        if (!ms) return '—';
        const remain = ms - Date.now();
        if (remain <= 0) return 'Expired';
        const hours = Math.floor(remain / 3600000);
        if (hours < 1) return 'Under an hour left';
        if (hours < 24) return `${hours} hr. left`;
        const days = Math.floor(hours / 24);
        return `${days} d. ${hours % 24} hr. left`;
    }

    async function openChatCandidates() {
        ensureScreens();
        const view = $('chattedUsersView');
        const body = view?.querySelector('.chatted-users-body');
        if (!view || !body) return;

        body.innerHTML = '<p class="op-loading"><i class="fa-solid fa-spinner fa-spin"></i> Loading…</p>';

        const addFriendView = $('addFriendView');
        const openedFromAddFriend = addFriendView && !addFriendView.classList.contains('hidden');
        view.dataset.nsoReturnTarget = openedFromAddFriend ? 'addFriendView' : '';

        // Start the real APK-style activity transition immediately; do not expose the
        // Home page between Add Friend and the GameChat candidate screen.
        const transition = openedFromAddFriend && typeof nsoApkForward === 'function'
            ? nsoApkForward(addFriendView, view)
            : (view.classList.remove('hidden'), Promise.resolve());

        try {
            const resultPromise = coralExact('chatCandidates');
            const result = await resultPromise;
            const raw = Array.isArray(result) ? result : (result?.chatParticipants || result?.friendCandidates || []);
            if (!raw.length) {
                body.innerHTML = '<p class="chatted-users-empty">Users you\'ve chatted with will be displayed here.</p>';
                await transition;
                return;
            }
            body.innerHTML = raw.map((candidate, index) => `
                <button class="op-candidate-row" data-candidate-index="${index}">
                    <img src="${escapeHtml(candidate.imageUri || candidate.image2Uri || '')}" alt="">
                    <span><b>${escapeHtml(candidate.name || 'Switch Player')}</b><small>You chatted together.</small></span>
                    <i class="fa-solid fa-chevron-right"></i>
                </button>`).join('');
            body.querySelectorAll('[data-candidate-index]').forEach((button) => {
                button.addEventListener('click', () => openChatCandidateDetail(raw[Number(button.dataset.candidateIndex)]));
            });
            await transition;
        } catch (error) {
            body.innerHTML = `<p class="service-status error">Couldn't load users you've chatted with: ${escapeHtml(error.message)}</p>`;
            await transition;
        }
    }

    async function openChatCandidateDetail(candidate) {
        state.activeChatCandidate = candidate;
        const body = $('opChatCandidateBody');
        body.innerHTML = `
            <div class="op-profile-hero"><img src="${escapeHtml(candidate.imageUri || candidate.image2Uri || '')}" alt=""><h3>${escapeHtml(candidate.name || 'Switch Player')}</h3><p>You chatted together.</p></div>
            <div class="op-action-grid">
                <button type="button" class="op-primary" id="opCandidateAdd">Send Friend Request</button>
                <button type="button" class="op-secondary danger" id="opCandidateBlock">Block</button>
            </div>
            <section class="op-group"><h4>Play Activity</h4><div id="opCandidatePlayLog"><p class="op-loading">Loading…</p></div></section>`;
        const candidatePage = $('opChatCandidatePage');
        const candidateList = $('chattedUsersView');
        closeAppScreens('opChatCandidatePage');
        if (candidatePage && candidateList && typeof nsoApkForward === 'function') {
            nsoApkForward(candidateList, candidatePage);
        } else {
            openScreen('opChatCandidatePage');
        }
        $('opCandidateAdd')?.addEventListener('click', async () => {
            if (!candidate.nsaId) return;
            const button = $('opCandidateAdd'); setBusy(button, true, 'Sending…');
            try {
                await coralExact('friendRequest', { nsaId: candidate.nsaId, channel: 'CAMPUS' });
                button.textContent = 'Friend request sent.'; button.disabled = true; delete button.dataset.oldHtml;
            } catch (error) { alert(`Could not send friend request: ${error.message}`); setBusy(button, false); }
        });
        $('opCandidateBlock')?.addEventListener('click', async () => {
            if (!candidate.nsaId) return;
            const ok = await confirmSheet('Block', "You won't get friend requests sent by blocked users, and you won't encounter those users during online play. (This may not apply to all games or game modes.)", 'Block');
            if (!ok) return;
            try {
                await coralExact('friendBlock', { nsaId: candidate.nsaId });
                toast('Blocked.');
                const candidatePage = $('opChatCandidatePage');
                const candidateList = $('chattedUsersView');
                if (candidatePage && candidateList && typeof nsoApkBack === 'function') {
                    nsoApkBack(candidatePage, candidateList);
                } else {
                    candidatePage?.classList.add('hidden');
                    candidateList?.classList.remove('hidden');
                }
            } catch (error) { alert(`Could not block user: ${error.message}`); }
        });
        if (candidate.nsaId) {
            try {
                const result = await coralExact('friendPlayLog', { nsaId: candidate.nsaId });
                renderPlayLog($('opCandidatePlayLog'), result);
            } catch {
                $('opCandidatePlayLog').innerHTML = '<p class="op-empty">Play activity will appear here.</p>';
            }
        }
    }

    function renderPlayLog(host, result) {
        if (!host) return;
        const logs = Array.isArray(result) ? result : (result?.playLogs || []);
        if (!logs.length) { host.innerHTML = '<p class="op-empty">Play activity will appear here.</p>'; return; }
        host.innerHTML = logs.map((log) => `
            <div class="op-playlog-row"><img src="${escapeHtml(log.imageUri || '')}" alt=""><span><b>${escapeHtml(log.name || 'Game')}</b><small>${Number(log.totalPlayTime || 0) > 0 ? `Played for ${Math.max(1, Math.round(Number(log.totalPlayTime) / 60))} hour(s) or more` : 'Recently played'}</small></span></div>`).join('');
    }

    function installFriendOnlinePageReplacement() {
        const oldOpen = $('openNotifySettingBtn');
        if (oldOpen) {
            const btn = bindControl('openNotifySettingBtn', async () => {
                await openFriendOnlineSettings('friendSettingsView');
            });
            btn?.querySelector('span') && (btn.querySelector('span').textContent = 'Notify When Friends Come Online');
        }
        // Remove the earlier capture-phase redirect by replacing the button node.
        bindControl('changeNotifySettingBtn', () => openFriendOnlineSettings('friendSettingsView'));
        const notice = $('friendSettingsNotifyView')?.querySelector('.settings-subtext');
        if (notice) notice.textContent = "You'll get online-status notifications for friends (max of once per 30 mins. for each friend).";
    }

    function installExistingRequestSettingExactCall() {
        const old = $('receiveRequestsToggle');
        if (!old) return;
        const input = old.cloneNode(true);
        old.replaceWith(input);
        input.addEventListener('change', async () => {
            const desired = input.checked;
            input.disabled = true;
            try {
                await coralExact('permissionsWrite', { permissions: { friendRequestReception: desired } });
                state.permissions = state.permissions || { permissions: {} };
                state.permissions.permissions = state.permissions.permissions || {};
                state.permissions.permissions.friendRequestReception = desired;
                toast('Setting changed.');
            } catch (error) {
                input.checked = !desired;
                alert(`Could not update friend-request setting: ${error.message}`);
            } finally { input.disabled = false; }
        });
        $('openRequestsSettingBtn')?.addEventListener('click', async () => {
            try {
                await loadCurrentUserAndPermissions(true);
                const value = state.permissions?.permissions?.friendRequestReception;
                if (typeof value === 'boolean') input.checked = value;
            } catch {}
        });
    }

    function installFriendDetailFeatures() {
        if (typeof openFriendDetail === 'function' && !openFriendDetail.__opFriendDetailWrapped) {
            const previous = openFriendDetail;
            const wrapped = function(friend) {
                state.activeFriend = friend || null;
                closeFriendMoreMenu(true);

                const requestedNsaId = friend?.nsaId || null;
                const result = previous(friend);

                queueMicrotask(() => {
                    if (!requestedNsaId || state.activeFriend?.nsaId === requestedNsaId) {
                        enhanceFriendDetail(friend);
                    }
                });

                if (requestedNsaId) {
                    coralExact('friendShow', { nsaId: requestedNsaId }).then((full) => {
                        // Do not let a slow Friend/Show response overwrite a newer detail view.
                        if (state.activeFriend?.nsaId !== requestedNsaId) return;

                        state.activeFriend = { ...friend, ...(full || {}) };
                        try { activeFriendDetailData = state.activeFriend; } catch {}

                        const howEl = $('friendDetailHowBecame');
                        if (howEl && typeof formatBecameFriendsRoute === 'function') {
                            howEl.textContent = formatBecameFriendsRoute(state.activeFriend.route || state.activeFriend.howBecameFriend);
                        }
                        const whenEl = $('friendDetailWhenBecame');
                        if (whenEl && typeof formatBecameFriendsDate === 'function') {
                            whenEl.textContent = formatBecameFriendsDate(
                                state.activeFriend.friendCreatedAt ||
                                state.activeFriend.becameFriendAt ||
                                state.activeFriend.createdAt
                            );
                        }

                        enhanceFriendDetail(state.activeFriend);
                    }).catch(() => {});

                    if (friend?.isNew) {
                        coralExact('friendIsNewDelete', { friendNsaId: requestedNsaId })
                            .then(() => { friend.isNew = false; })
                            .catch(() => {});
                    }
                }

                return result;
            };
            wrapped.__opFriendDetailWrapped = true;
            openFriendDetail = wrapped;
        }

        enhanceFriendDetail(state.activeFriend);
    }

    function enhanceFriendDetail(friend) {
        const view = $('friendDetailView');
        if (!view) return;
        const note = $('friendsNoteButton') || view.querySelector('.friend-detail-note');
        if (note && note.dataset.opBound !== 'true') {
            const clone = note.cloneNode(true);
            clone.dataset.opBound = 'true';
            clone.id = 'friendsNoteButton';
            note.replaceWith(clone);
            clone.addEventListener('click', openFriendNoteEditor);
            clone.addEventListener('keydown', (event) => {
                if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); openFriendNoteEditor(); }
            });
        }
        const fav = $('friendsFavouriteButton') || view.querySelector('.friend-detail-actions button:nth-child(1)');
        if (fav && fav.dataset.opBound !== 'true') {
            const clone = fav.cloneNode(true); clone.id = 'friendsFavouriteButton'; clone.dataset.opBound = 'true'; clone.disabled = false; fav.replaceWith(clone);
            clone.addEventListener('click', toggleFavoriteFriend);
        }
        const notify = $('friendsNotifyButton') || view.querySelector('.friend-detail-actions button:nth-child(2)');
        if (notify && notify.dataset.opBound !== 'true') {
            const clone = notify.cloneNode(true); clone.id = 'friendsNotifyButton'; clone.dataset.opBound = 'true'; clone.disabled = false; notify.replaceWith(clone);
            clone.addEventListener('click', toggleFriendOnlineNotice);
        }
        const more = $('friendsMoreButton') || view.querySelector('.friend-detail-more');
        if (more && more.dataset.opBound !== 'true') {
            $('friendsMoreMenu')?.remove();
            const clone = more.cloneNode(true);
            clone.id = 'friendsMoreButton';
            clone.dataset.opBound = 'true';
            clone.disabled = false;
            clone.setAttribute('aria-haspopup', 'menu');
            clone.setAttribute('aria-expanded', 'false');
            more.replaceWith(clone);
            clone.addEventListener('click', (event) => {
                event.preventDefault();
                event.stopPropagation();
                toggleFriendMoreMenu();
            });
        }

        ensureFriendMoreMenu();
        updateFriendDetailLabels(friend || state.activeFriend);
    }

    function animateFriendControl(button, html, enabled) {
        if (!button) return;
        button.dataset.enabled = enabled ? 'true' : 'false';
        if (button.innerHTML === html) return;

        button.innerHTML = html;
        if (typeof button.animate === 'function') {
            button.animate(
                [
                    { opacity: 0.55, transform: 'scale(0.985)' },
                    { opacity: 1, transform: 'scale(1)' }
                ],
                { duration: 150, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)' }
            );
        }
    }

    function updateFriendDetailLabels(friend) {
        if (!friend) return;

        const note = $('friendsNoteButton');
        const noteText = String(friend.note || '').trim();
        if (note) {
            const next = `<i class="fa-solid fa-pencil"></i> ${escapeHtml(noteText || 'Add Note')}`;
            if (note.innerHTML !== next) note.innerHTML = next;
        }

        animateFriendControl(
            $('friendsFavouriteButton'),
            `<i class="${friend.isFavoriteFriend ? 'fa-solid' : 'fa-regular'} fa-star"></i> Best Friends`,
            Boolean(friend.isFavoriteFriend)
        );

        animateFriendControl(
            $('friendsNotifyButton'),
            `<i class="${friend.isOnlineNotificationEnabled ? 'fa-solid' : 'fa-regular'} fa-bell"></i> Notify When Online`,
            Boolean(friend.isOnlineNotificationEnabled)
        );
    }

    function openFriendNoteEditor() {
        ensureScreens();
        const friend = state.activeFriend;
        if (!friend?.nsaId) return;
        const note = String(friend.note || '');
        $('opFriendNoteBody').innerHTML = `
            <p class="op-info-copy">You can leave notes to yourself about users on your friend list.</p>
            <label class="op-field"><span>Your note</span><textarea id="opFriendNoteInput" maxlength="20" placeholder="Your note">${escapeHtml(note)}</textarea><small><span id="opFriendNoteCount">${note.length}</span>/20</small></label>
            <p class="op-muted">Friends won't be able to see notes you write about them.</p>
            <button type="button" class="op-primary" id="opFriendNoteSave">Save</button>`;
        openScreen('opFriendNotePage');
        const input = $('opFriendNoteInput');
        input?.focus();
        input?.addEventListener('input', () => $('opFriendNoteCount').textContent = input.value.length);
        $('opFriendNoteSave')?.addEventListener('click', async () => {
            const value = input.value;
            if (value.length > 20) return;
            const button = $('opFriendNoteSave'); setBusy(button, true, 'Saving…');
            try {
                await coralExact('friendNote', { friendNsaId: friend.nsaId, note: value });
                friend.note = value;
                state.activeFriend.note = value;
                updateFriendDetailLabels(friend);
                toast('Saved.');

                const notePage = $('opFriendNotePage');
                if (notePage && typeof slideViewOut === 'function') slideViewOut(notePage);
                else notePage?.classList.add('hidden');
            } catch (error) { alert(`Could not update note: ${error.message}`); }
            finally { setBusy(button, false); }
        });
    }

    async function toggleFavoriteFriend() {
        const friend = state.activeFriend;
        if (!friend?.nsaId) return;
        const button = $('friendsFavouriteButton');
        const desired = !friend.isFavoriteFriend;
        setBusy(button, true);
        try {
            await coralExact(desired ? 'favoriteAdd' : 'favoriteDelete', { nsaId: friend.nsaId });
            friend.isFavoriteFriend = desired; updateFriendDetailLabels(friend); toast(desired ? 'Added to Best Friends.' : 'Removed from Best Friends.');
            if (typeof loadLiveFriendsList === 'function') loadLiveFriendsList().catch(() => {});
        } catch (error) { alert(`Could not update Best Friends: ${error.message}`); }
        finally { setBusy(button, false); }
    }

    async function toggleFriendOnlineNotice() {
        const friend = state.activeFriend;
        if (!friend?.nsaId) return;
        const button = $('friendsNotifyButton');
        const desired = !friend.isOnlineNotificationEnabled;
        setBusy(button, true);
        try {
            await coralExact('friendOnlinePush', [{ type: 'friendOnline', value: desired, friendId: friend.nsaId }]);
            friend.isOnlineNotificationEnabled = desired; updateFriendDetailLabels(friend); toast('Notification setting changed.');
        } catch (error) { alert(`Could not update online notification: ${error.message}`); }
        finally { setBusy(button, false); }
    }

    let friendMoreMenuOutsideBound = false;

    function ensureFriendMoreMenu() {
        let menu = $('friendsMoreMenu');
        if (menu) return menu;

        const view = $('friendDetailView');
        if (!view) return null;

        menu = document.createElement('div');
        menu.id = 'friendsMoreMenu';
        menu.className = 'friends-functional-menu hidden';
        menu.setAttribute('role', 'menu');
        menu.setAttribute('aria-label', 'Friend actions');
        menu.innerHTML = `
            <button type="button" id="friendsDeleteFriend" class="danger" role="menuitem">
                <i class="fa-solid fa-user-minus"></i> Delete Friend
            </button>
            <button type="button" id="friendsBlockFriend" class="danger" role="menuitem">
                <i class="fa-solid fa-ban"></i> Block
            </button>`;
        view.appendChild(menu);

        $('friendsDeleteFriend')?.addEventListener('click', async (event) => {
            event.stopPropagation();
            closeFriendMoreMenu();
            await deleteActiveFriend();
        });
        $('friendsBlockFriend')?.addEventListener('click', async (event) => {
            event.stopPropagation();
            closeFriendMoreMenu();
            await blockActiveFriend();
        });

        if (!friendMoreMenuOutsideBound) {
            friendMoreMenuOutsideBound = true;

            document.addEventListener('click', (event) => {
                if (!event.target.closest('#friendsMoreMenu') && !event.target.closest('#friendsMoreButton')) {
                    closeFriendMoreMenu();
                }
            });

            document.addEventListener('keydown', (event) => {
                if (event.key === 'Escape') closeFriendMoreMenu();
            });
        }

        return menu;
    }

    function setFriendMoreMenuOpen(open, immediate = false) {
        const menu = ensureFriendMoreMenu();
        const more = $('friendsMoreButton');
        if (!menu) return;

        more?.setAttribute('aria-expanded', open ? 'true' : 'false');
        menu.getAnimations?.().forEach((animation) => animation.cancel());

        if (open) {
            menu.classList.remove('hidden');
            if (!immediate && typeof menu.animate === 'function') {
                menu.animate(
                    [
                        { opacity: 0, transform: 'translateY(-7px) scale(0.97)' },
                        { opacity: 1, transform: 'translateY(0) scale(1)' }
                    ],
                    { duration: 160, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)' }
                );
            }
            return;
        }

        if (menu.classList.contains('hidden')) return;
        if (immediate || typeof menu.animate !== 'function') {
            menu.classList.add('hidden');
            return;
        }

        const animation = menu.animate(
            [
                { opacity: 1, transform: 'translateY(0) scale(1)' },
                { opacity: 0, transform: 'translateY(-5px) scale(0.98)' }
            ],
            { duration: 120, easing: 'cubic-bezier(0.4, 0, 1, 1)' }
        );
        animation.finished.catch(() => {}).finally(() => menu.classList.add('hidden'));
    }

    function toggleFriendMoreMenu() {
        const menu = ensureFriendMoreMenu();
        if (!menu) return;
        setFriendMoreMenuOpen(menu.classList.contains('hidden'));
    }

    function closeFriendMoreMenu(immediate = false) {
        const menu = $('friendsMoreMenu');
        $('friendsMoreButton')?.setAttribute('aria-expanded', 'false');
        if (!menu) return;
        setFriendMoreMenuOpen(false, immediate);
    }

    function leaveFriendDetailAfterRemoval() {
        closeFriendMoreMenu(true);
        state.activeFriend = null;

        try {
            navTabStacks.friends = 'list';
            activeFriendDetailData = null;
        } catch {}

        const view = $('friendDetailView');
        const originTab = (() => {
            try { return friendDetailOriginTab || 'friends'; } catch { return 'friends'; }
        })();

        const finish = () => {
            if (typeof applyTabViewState === 'function') applyTabViewState(originTab);
        };

        if (view && typeof slideViewOut === 'function' && !view.classList.contains('hidden')) {
            slideViewOut(view, finish);
        } else {
            view?.classList.add('hidden');
            finish();
        }
    }

    async function deleteActiveFriend() {
        const friend = state.activeFriend;
        if (!friend?.nsaId) return;

        const ok = await confirmSheet(
            'Delete Friend',
            `Delete ${friend.name || 'this friend'} from your friend list?`,
            'Delete Friend'
        );
        if (!ok) return;

        try {
            await coralExact('friendDelete', { nsaId: friend.nsaId });
            toast('Friend deleted.');
            leaveFriendDetailAfterRemoval();
            if (typeof loadLiveFriendsList === 'function') loadLiveFriendsList().catch(() => {});
        } catch (error) {
            alert(`Could not delete friend: ${error.message}`);
        }
    }

    async function blockActiveFriend() {
        const friend = state.activeFriend;
        if (!friend?.nsaId) return;

        const ok = await confirmSheet(
            'Block',
            "You won't get friend requests sent by blocked users, and you won't encounter those users during online play. (This may not apply to all games or game modes.)",
            'Block'
        );
        if (!ok) return;

        try {
            await coralExact('friendBlock', { nsaId: friend.nsaId });
            toast('Blocked.');
            leaveFriendDetailAfterRemoval();
            if (typeof loadLiveFriendsList === 'function') loadLiveFriendsList().catch(() => {});
        } catch (error) {
            alert(`Could not block user: ${error.message}`);
        }
    }

    function confirmSheet(title, message, primary = 'OK') {
        return new Promise((resolve) => {
            let overlay = $('opConfirmOverlay');
            if (!overlay) {
                overlay = document.createElement('div');
                overlay.id = 'opConfirmOverlay';
                overlay.className = 'op-dialog-overlay hidden';
                document.body.appendChild(overlay);
            }
            overlay.innerHTML = `
                <div class="op-dialog" role="dialog" aria-modal="true">
                    <h3>${escapeHtml(title)}</h3>
                    <p>${escapeHtml(message)}</p>
                    <div class="op-dialog-actions"><button id="opDialogCancel">Cancel</button><button id="opDialogOk" class="primary">${escapeHtml(primary)}</button></div>
                </div>`;
            overlay.classList.remove('hidden');
            const dialog = overlay.querySelector('.op-dialog');

            overlay.getAnimations?.().forEach((animation) => animation.cancel());
            dialog?.getAnimations?.().forEach((animation) => animation.cancel());

            overlay.animate?.(
                [{ opacity: 0 }, { opacity: 1 }],
                { duration: 140, easing: 'ease-out' }
            );
            dialog?.animate?.(
                [
                    { opacity: 0, transform: 'translateY(18px) scale(0.98)' },
                    { opacity: 1, transform: 'translateY(0) scale(1)' }
                ],
                { duration: 180, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)' }
            );

            let settled = false;
            const finish = (value) => {
                if (settled) return;
                settled = true;

                const close = () => {
                    overlay.classList.add('hidden');
                    resolve(value);
                };

                if (typeof dialog?.animate !== 'function') {
                    close();
                    return;
                }

                const animation = dialog.animate(
                    [
                        { opacity: 1, transform: 'translateY(0) scale(1)' },
                        { opacity: 0, transform: 'translateY(10px) scale(0.985)' }
                    ],
                    { duration: 120, easing: 'cubic-bezier(0.4, 0, 1, 1)' }
                );
                animation.finished.catch(() => {}).finally(close);
            };

            $('opDialogCancel').onclick = () => finish(false);
            $('opDialogOk').onclick = () => finish(true);
            overlay.onclick = (event) => { if (event.target === overlay) finish(false); };
        });
    }

    function installChatCandidateReplacement() {
        bindControl('openVoiceChattedFriendsBtn', openChatCandidates);

        const close = $('closeChattedUsersBtn');
        close?.addEventListener('click', (event) => {
            const view = $('chattedUsersView');
            if (!view || view.classList.contains('hidden')) return;
            if (view.dataset.nsoReturnTarget !== 'addFriendView') return;

            event.preventDefault();
            event.stopImmediatePropagation();
            const addFriendView = $('addFriendView');
            if (addFriendView && typeof nsoApkBack === 'function') {
                nsoApkBack(view, addFriendView).finally(() => {
                    view.dataset.nsoReturnTarget = '';
                });
            } else {
                view.classList.add('hidden');
                addFriendView?.classList.remove('hidden');
                view.dataset.nsoReturnTarget = '';
            }
        }, { capture: true });

        const empty = $('chattedUsersView')?.querySelector('.chatted-users-empty');
        if (empty) empty.textContent = "Users you've chatted with will be displayed here.";
    }

    function installProfileAndNotifications() {
        bindControl('userAvatarContainer', (event) => {
            event.preventDefault();
            event.stopImmediatePropagation();
            $('profileView')?.classList.add('hidden');
            openUserPage();
        }, { capture: true });
        bindControl('notificationBtn', (event) => {
            event.preventDefault();
            event.stopImmediatePropagation();
            $('notificationView')?.classList.add('hidden');
            openAnnouncements();
        }, { capture: true });
    }

    function installUserPageBindings() {
        ensureScreens();

        $('nativeFriendCodeCopyBtn')?.addEventListener('click', copyOwnFriendCode);
        $('nativeOnlineStatusChangeBtn')?.addEventListener('click', () => openVisibility('presence', 'opUserPage'));
        $('nativePlayActivityChangeBtn')?.addEventListener('click', () => openVisibility('playLog', 'opUserPage'));
        $('nativeSettingsBtn')?.addEventListener('click', openSettings);
        $('nativeAddFriendBtn')?.addEventListener('click', () => {
            const userPage = $('opUserPage');
            const addFriend = $('addFriendView');
            if (!addFriend) {
                $('openAddFriendBtn')?.click();
                return;
            }

            addFriend.dataset.nsoReturnTarget = 'opUserPage';
            assignPersistentViewOwner(addFriend, userPage?.dataset?.nsoOwnerTab || activeAppTab);
            if (userPage && typeof nsoApkForward === 'function') {
                // Keep the User Page painted underneath until Add Friend completely covers
                // it. This removes the one-frame Home flash from the old hide-then-open path.
                nsoApkForward(userPage, addFriend);
            } else if (typeof slideViewIn === 'function') {
                slideViewIn(addFriend);
            } else {
                addFriend.classList.remove('hidden');
            }
        });

        $('closeAddFriendBtn')?.addEventListener('click', (event) => {
            const addFriend = $('addFriendView');
            if (!addFriend || addFriend.dataset.nsoReturnTarget !== 'opUserPage') return;

            event.preventDefault();
            event.stopImmediatePropagation();
            const userPage = $('opUserPage');
            if (userPage && typeof nsoApkBack === 'function') {
                nsoApkBack(addFriend, userPage).finally(() => {
                    addFriend.dataset.nsoReturnTarget = '';
                });
            } else {
                addFriend.classList.add('hidden');
                userPage?.classList.remove('hidden');
                addFriend.dataset.nsoReturnTarget = '';
            }
        }, { capture: true });

        const userPageBack = $('opUserPage')?.querySelector('.op-back');
        userPageBack?.addEventListener('click', (event) => {
            event.preventDefault();
            event.stopImmediatePropagation();
            const userPage = $('opUserPage');
            if (!userPage) return;
            if (typeof slideViewOut === 'function') slideViewOut(userPage);
            else userPage.classList.add('hidden');
        }, { capture: true });

        document.addEventListener('keydown', (event) => {
            if (event.key !== 'Escape') return;
            const userPage = $('opUserPage');
            if (!userPage || userPage.classList.contains('hidden')) return;
            if (typeof slideViewOut === 'function') slideViewOut(userPage);
            else userPage.classList.add('hidden');
        });
    }

    function installAuthenticatedRefreshHook() {
        if (typeof showAuthenticatedUI === 'function' && !showAuthenticatedUI.__opWrapped) {
            const previous = showAuthenticatedUI;
            const wrapped = function(session) {
                const result = previous(session);
                queueMicrotask(() => refreshNativeData());
                return result;
            };
            wrapped.__opWrapped = true;
            showAuthenticatedUI = wrapped;
        }
    }

    async function refreshNativeData() {
        if (state.refreshing) return state.refreshing;
        state.refreshing = (async () => {
            installAlbumFeatures();
            if (coralToken()) {
                coralExact('announcements').then((result) => {
                    state.announcements = Array.isArray(result) ? result : (result?.announcements || []);
                    updateAnnouncementDot();
                }).catch(() => {});
                startBrowserNotificationMonitor({ immediate: true });
            } else {
                stopBrowserNotificationMonitor();
            }
        })().finally(() => { state.refreshing = null; });
        return state.refreshing;
    }

    function installReceivedRequestText() {
        const host = $('receivedRequestsContainer');
        if (!host) return;
        const fix = () => {
            host.querySelectorAll('.friends-functional-request-actions').forEach((actions) => {
                const buttons = actions.querySelectorAll('button');
                if (buttons[0]) buttons[0].textContent = 'Become Friends';
                if (buttons[1]) buttons[1].textContent = "Don't Become Friends";
            });
        };
        new MutationObserver(fix).observe(host, { childList: true, subtree: true });
        fix();
    }

    function init() {
        applyDarkMode();
        installSystemThemeWatcher();
        enforceMobileDataPreference();
        ensureScreens();
        installAuthenticatedRefreshHook();
        installBrowserNotificationLifecycle();
        installProfileAndNotifications();
        installUserPageBindings();
        installFriendOnlinePageReplacement();
        installExistingRequestSettingExactCall();
        installFriendDetailFeatures();
        installChatCandidateReplacement();
        installAlbumFeatures();
        installReceivedRequestText();
        refreshNativeData();
    }

    init();
})();
