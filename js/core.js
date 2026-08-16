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
// Shared translation & HTML-escape bridges
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
