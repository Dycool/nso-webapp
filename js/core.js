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
// Shared-f2 GameWebServiceToken experiment
// ---------------------------------------------------------------------------
// Default-on for the current controlled test. Set the localStorage key to "off"
// and reload to instantly return to the original broker generation path without a
// code rollback. The experiment never runs for forceFresh token renewals.
const NSO_SHARED_F2_EXPERIMENT_KEY = 'nso_shared_f2_experiment';

function sharedF2ExperimentEnabled() {
    try { return localStorage.getItem(NSO_SHARED_F2_EXPERIMENT_KEY) !== 'off'; }
    catch { return true; }
}

window.nsoSetSharedF2Experiment = (enabled) => {
    try {
        if (enabled) localStorage.removeItem(NSO_SHARED_F2_EXPERIMENT_KEY);
        else localStorage.setItem(NSO_SHARED_F2_EXPERIMENT_KEY, 'off');
    } catch { }
};

(function installSharedF2Experiment() {
    const manager = window.webServiceManager;
    if (!manager || typeof manager.requestBrokerGeneratedToken !== 'function') return;

    const originalRequestBrokerGeneratedToken = manager.requestBrokerGeneratedToken.bind(manager);

    manager.requestBrokerGeneratedToken = async function requestBrokerGeneratedTokenSharedF2(serviceId, traceId, options = {}) {
        if (!sharedF2ExperimentEnabled() || options.forceFresh === true) {
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

        // With only one uncached service there is nothing to share, so keep the
        // proven combined nxapi f+encrypt broker path.
        if (serviceIds.length < 2) {
            return originalRequestBrokerGeneratedToken(serviceId, traceId, options);
        }

        const coralToken = coralAccessToken();
        const naId = userSession?.nsoWebapp?.naId;
        const coralUserId = String(userSession?.result?.user?.id || userSession?.user?.id || '');
        if (!coralToken || !naId) {
            return originalRequestBrokerGeneratedToken(serviceId, traceId, options);
        }

        if (options.signal?.aborted) throw new DOMException('The operation was aborted.', 'AbortError');

        const startedAt = performance.now();
        const attestation = await nxapiGenerateF(2, coralToken, {
            na_id: String(naId),
            coral_user_id: coralUserId
        }, {
            signal: options.signal,
            cancelKey: options.cancelKey
        });

        // All requests start immediately with the exact same f/timestamp/requestId.
        // This is the experiment: only the Nintendo GameWebService id differs.
        const settled = await Promise.allSettled(serviceIds.map(async (id) => {
            const result = await coralCall('/v4/Game/GetWebServiceToken', {
                id: Number(id),
                registrationToken: '',
                f: attestation.f,
                timestamp: attestation.timestamp,
                requestId: attestation.requestId
            }, {
                signal: options.signal,
                cancelKey: options.cancelKey,
                cache: false,
                allowStaleOnError: false
            });

            if (!result?.accessToken) {
                const error = new Error(`Nintendo did not return a GameWebServiceToken for service ${id}.`);
                error.code = 'shared_f2_missing_token';
                throw error;
            }

            const expiresInSec = Number.isFinite(Number(result.expiresIn)) ? Number(result.expiresIn) : 7200;
            const token = {
                token: String(result.accessToken),
                expiresAt: Date.now() + Math.max(60, expiresInSec) * 1000,
                source: 'shared_f2_experiment'
            };
            this.tokenCache.set(id, { token: token.token, expiresAt: token.expiresAt });
            return { id, ...token };
        }));

        const succeeded = [];
        const failed = [];
        let requestedResult = null;
        let requestedError = null;

        settled.forEach((entry, index) => {
            const id = serviceIds[index];
            if (entry.status === 'fulfilled') {
                succeeded.push(id);
                if (id === requestedId) requestedResult = entry.value;
            } else {
                failed.push({ id, code: entry.reason?.code || null, status: entry.reason?.status || null, message: entry.reason?.message || String(entry.reason) });
                if (id === requestedId) requestedError = entry.reason;
            }
        });

        console.info(`[SharedF2:${traceId || 'launch'}] one method-2 attestation reused across game services`, {
            requestedId,
            serviceIds,
            succeeded,
            failed,
            totalMs: Math.round(performance.now() - startedAt)
        });

        if (requestedResult) return requestedResult;

        const error = requestedError instanceof Error
            ? requestedError
            : new Error('Nintendo rejected the shared method-2 attestation for the requested game service.');
        if (!error.code) error.code = 'shared_f2_experiment_failed';
        throw error;
    };
})();
