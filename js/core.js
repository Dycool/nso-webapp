/**
 * Configuration, shared state, translation bridges and rate limiting.
 * Kept in original execution order while separating this responsibility from the app shell.
 */

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
const BUNDLED_ZNCA_VERSION = '3.4.1';
let ZNCA_VERSION = BUNDLED_ZNCA_VERSION;

function validZncaVersion(value) {
    return typeof value === 'string' && /^\d+\.\d+\.\d+$/.test(value);
}

function activeZncaVersion(session = userSession) {
    const pinned = session?.nsoWebapp?.zncaVersion;
    return validZncaVersion(pinned) ? pinned : (validZncaVersion(ZNCA_VERSION) ? ZNCA_VERSION : BUNDLED_ZNCA_VERSION);
}

function applySessionZncaVersion(session = userSession) {
    ZNCA_VERSION = validZncaVersion(session?.nsoWebapp?.zncaVersion)
        ? session.nsoWebapp.zncaVersion
        : BUNDLED_ZNCA_VERSION;
    return ZNCA_VERSION;
}

window.nsoActiveZncaVersion = activeZncaVersion;

function zncaUserAgent() {
    return `com.nintendo.znca/${activeZncaVersion()}(${ZNCA_PLATFORM}/${ZNCA_PLATFORM_VERSION})`;
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
    expiresAt: 0,
    coralNaId: null,
    zncaVersion: null
};

function clearNxapiAuthSession() {
    nxapiAuthSession = { accessToken: null, refreshToken: null, expiresAt: 0, coralNaId: null, zncaVersion: null };
}

function bindNxapiCoralContext(naId, zncaVersion = activeZncaVersion()) {
    const normalizedNaId = String(naId || '');
    const normalizedVersion = validZncaVersion(zncaVersion) ? zncaVersion : BUNDLED_ZNCA_VERSION;
    const boundUser = String(nxapiAuthSession.coralNaId || '');
    const boundVersion = String(nxapiAuthSession.zncaVersion || '');
    if ((boundUser && normalizedNaId && boundUser !== normalizedNaId) ||
        (boundVersion && boundVersion !== normalizedVersion)) {
        clearNxapiAuthSession();
    }
    if (normalizedNaId) nxapiAuthSession.coralNaId = normalizedNaId;
    nxapiAuthSession.zncaVersion = normalizedVersion;
    ZNCA_VERSION = normalizedVersion;
    return normalizedVersion;
}

window.nsoBindNxapiCoralContext = bindNxapiCoralContext;
let nxapiTokenPromise = null;
let nxapiAuthMetadata = null;
let activeMediaItem = null;
let currentFriends = [];
let currentMedia = [];

// ---------------------------------------------------------------------------
// Shared translation, formatting & HTML-escape bridges
// The canonical implementations live inside the localization IIFE further down.
// These top-level wrappers delegate to window.nsoTranslate* once that IIFE has
// executed; before that point they safely return the English source text so
// early callers never throw a ReferenceError.
// ---------------------------------------------------------------------------

function tr(source) {
    return typeof window.nsoTranslateText === 'function'
        ? window.nsoTranslateText(source)
        : String(source ?? '');
}

function trKey(key) {
    return typeof window.nsoTranslateApkKey === 'function'
        ? window.nsoTranslateApkKey(key)
        : String(key ?? '');
}

function trFormat(resourceKey, ...values) {
    if (typeof window.nsoTranslateFormat === 'function') {
        return window.nsoTranslateFormat(resourceKey, ...values);
    }
    // Fallback: just return the key (localization IIFE not yet loaded)
    return String(resourceKey ?? '');
}

function trVars(source, values = {}) {
    if (typeof window.nsoTranslateVars === 'function') {
        return window.nsoTranslateVars(source, values);
    }
    return String(source ?? '').replace(
        /\{([A-Za-z0-9_]+)\}/g,
        (_, key) => String(values[key] ?? '')
    );
}

// Shared relative-time formatter restored from the pre-modular app.js. Friends
// rendering still calls this helper outside the localization IIFE, so it belongs
// in the shared runtime rather than being hidden inside one feature module.
function relativeTime(value) {
    if (!value) return '';

    let ms = 0;
    if (typeof value === 'number') {
        ms = value < 10_000_000_000 ? value * 1000 : value;
    } else {
        const parsed = Date.parse(value);
        ms = Number.isFinite(parsed) ? parsed : 0;
    }
    if (!ms) return '';

    const elapsed = Math.max(0, Date.now() - ms);
    const locale = typeof window.nsoCurrentLocale === 'function'
        ? window.nsoCurrentLocale()
        : undefined;
    const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
    if (elapsed < 60_000) return rtf.format(0, 'second');
    if (elapsed < 3_600_000) return rtf.format(-Math.floor(elapsed / 60_000), 'minute');
    if (elapsed < 86_400_000) return rtf.format(-Math.floor(elapsed / 3_600_000), 'hour');
    return rtf.format(-Math.floor(elapsed / 86_400_000), 'day');
}

function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

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
    } catch (e) { }
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
            bannerText.textContent = `${tr('nxapi is temporarily rate-limited. Please try again later.')} ${timeStr} (${remainingSec}s)`;
        }
        rateLimitTimer = setTimeout(updateRateLimitBanner, 1000);
    } else {
        if (banner) banner.classList.add('hidden');
    }
}


// ---------------------------------------------------------------------------
// Shared-f2 GameWebServiceToken batching
// ---------------------------------------------------------------------------
// First-use game-service launches can ask the account broker to generate tokens
// for the other uncached catalog services with the same fresh method-2 attestation.
// Force-fresh WebView renewals intentionally stay on the original single-service path.
(function installSharedF2Batching() {
    const manager = window.webServiceManager;
    if (!manager || typeof manager.requestBrokerGeneratedToken !== 'function') return;

    const originalRequestBrokerGeneratedToken = manager.requestBrokerGeneratedToken.bind(manager);

    manager.requestBrokerGeneratedToken = async function requestBrokerGeneratedTokenSharedF2(serviceId, traceId, options = {}) {
        if (options.forceFresh === true) {
            return originalRequestBrokerGeneratedToken(serviceId, traceId, options);
        }

        const requestedId = String(serviceId || '');
        const catalogIds = Array.from(document.querySelectorAll('#gameServicesCatalog .service-launch-card[data-service-id]'))
            .map(card => String(card.dataset.serviceId || ''))
            .filter(id => /^\d+$/.test(id));
        const serviceIds = Array.from(new Set([requestedId, ...catalogIds]))
            .filter(id => /^\d+$/.test(id))
            .filter(id => id === requestedId || !this.getCachedGameWebServiceToken(id))
            .slice(0, 12);

        // One missing service is faster on nxapi's combined f+encrypt endpoint.
        if (serviceIds.length < 2) {
            return originalRequestBrokerGeneratedToken(serviceId, traceId, options);
        }

        const clientId = this.tokenBrokerClientId();
        const coralToken = coralAccessToken();
        const naId = userSession?.nsoWebapp?.naId;
        const coralUserId = String(userSession?.result?.user?.id || userSession?.user?.id || '');
        if (!clientId || !coralToken || !naId) {
            return originalRequestBrokerGeneratedToken(serviceId, traceId, options);
        }

        const zncaVersion = typeof window.nsoActiveZncaVersion === 'function'
            ? window.nsoActiveZncaVersion()
            : (typeof ZNCA_VERSION === 'string' ? ZNCA_VERSION : '3.4.1');
        if (typeof window.nsoBindNxapiCoralContext === 'function') {
            window.nsoBindNxapiCoralContext(String(naId), zncaVersion);
        }

        const nxapiAccessToken = await getNxapiAccessToken({
            signal: options.signal,
            cancelKey: options.cancelKey
        });
        if (options.signal?.aborted) throw new DOMException('The operation was aborted.', 'AbortError');

        const response = await fetch(`${this.getWorkerUrl()}/api/nso/service/token`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
            credentials: 'include',
            signal: options.signal,
            body: JSON.stringify({
                clientId,
                serviceId: requestedId,
                serviceIds,
                coralAccessToken: coralToken,
                nxapiAccessToken,
                naId: String(naId),
                coralUserId,
                zncaVersion,
                forceFresh: false,
                cancelKey: options.cancelKey || undefined
            })
        });
        if (typeof window.nsoObserveServiceResponse === 'function') {
            window.nsoObserveServiceResponse(response, { provider: 'nxapi-znca', operation: 'Shared game service token generation' });
        }

        let data = {};
        try { data = await response.json(); } catch (e) { }

        if (response.ok && data?.token?.token) {
            for (const [id, cached] of Object.entries(data.tokens || {})) {
                const token = cached?.token;
                const expiresAt = Number(cached?.expiresAt || 0);
                if (token && expiresAt > Date.now() + 60000) {
                    this.tokenCache.set(String(id), { token: String(token), expiresAt });
                }
            }

            if (data.sharedF2) {
                console.info(`[SharedF2:${traceId || 'launch'}] broker reused one method-2 attestation across game services`, {
                    requestedId,
                    serviceIds: data.sharedF2.serviceIds || serviceIds,
                    succeeded: data.sharedF2.succeeded || [],
                    failed: data.sharedF2.failed || [],
                    generationMs: Number(data.sharedF2.generationMs || 0)
                });
            }

            this.setLoadingStatus('');
            return {
                token: data.token.token,
                expiresAt: Number(data.token.expiresAt || 0),
                source: data.source || 'shared_f2'
            };
        }

        if (response.status === 401 && data?.error === 'broker_session_missing') {
            this.setLoadingStatus('');
            return { unavailable: true };
        }
        if (response.status === 401 && data?.error === 'nxapi_invalid_token') {
            try { clearNxapiAuthSession(); } catch (e) { }
        }
        if (response.status === 429 && typeof parseRetryAfter === 'function' && typeof setRateLimitUntil === 'function') {
            const until = parseRetryAfter(response.headers.get('Retry-After')) || (Date.now() + 60000);
            setRateLimitUntil('f2', until);
        }
        if (response.status === 499 || data?.error === 'launch_cancelled') {
            this.setLoadingStatus('');
            throw new DOMException('The operation was aborted.', 'AbortError');
        }

        this.setLoadingStatus('');
        const noMatchingWorker = response.status === 406 || data?.error === 'nxapi_unsupported_version' ||
            /no matching workers/i.test(String(data?.error_description || data?.error || ''));
        const versionMismatch = response.status === 400 && (data?.error === 'nxapi_version_context_mismatch' ||
            /X-znca-Version.*does not match token/i.test(String(data?.error_description || data?.error || '')));
        if (versionMismatch) {
            try { clearNxapiAuthSession(); } catch (e) { }
        }
        const message = noMatchingWorker
            ? `nxapi has no matching Android worker for Nintendo Switch App ${zncaVersion} right now. ${String(data?.error_description || '').trim()}`.trim()
            : versionMismatch
                ? `The nxapi token context did not match Nintendo Switch App ${zncaVersion}. The stale in-memory nxapi token was cleared; try launching again.`
                : (data?.error_description || data?.error || `Cloudflare shared token broker failed (HTTP ${response.status}).`);
        const error = new Error(message);
        error.status = response.status;
        error.code = noMatchingWorker ? 'nxapi_unsupported_version' : (versionMismatch ? 'nxapi_version_context_mismatch' : (data?.error || 'shared_f2_broker_error'));
        if (noMatchingWorker || versionMismatch) error.requestedVersion = zncaVersion;
        throw error;
    };
})();
