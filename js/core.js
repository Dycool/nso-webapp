



const WORKER_URL = 'https://nso-worker-backend.diogoenes0.workers.dev';




const DEFAULT_NSO_EXTENSION_ID = 'bjcigdmffhlolfpaocccgclocgdnenfc';
const NSO_EXTENSION_ID = window.NSO_EXTENSION_ID ||
    localStorage.getItem('nso_extension_id') ||
    DEFAULT_NSO_EXTENSION_ID;

window.nsoBackendMode = 'detecting';
let extensionPingPromise = null;

async function nsoDetectBackend() {
    if (extensionPingPromise) return extensionPingPromise;

    extensionPingPromise = (async () => {
        if (typeof chrome !== 'undefined' && chrome.runtime && typeof chrome.runtime.sendMessage === 'function') {
            try {
                const response = await new Promise((resolve) => {


                    const timeout = setTimeout(() => resolve(null), 120);
                    try {
                        chrome.runtime.sendMessage(NSO_EXTENSION_ID, { type: 'NSO_PING' }, (res) => {
                            clearTimeout(timeout);
                            if (chrome.runtime?.lastError) resolve(null);
                            else resolve(res);
                        });
                    } catch (_) {
                        clearTimeout(timeout);
                        resolve(null);
                    }
                });

                if (response && response.status === 'ok') {
                    window.nsoBackendMode = 'extension';
                    window.nsoActiveBackend = 'extension';
                    const msg = typeof window.trVars === 'function'
                        ? window.trVars('Connected to browser extension backend (v{version})', { version: response.version || '1.0.0' })
                        : `Connected to browser extension backend (v${response.version || '1.0.0'})`;
                    console.log(`%c[backend:extension]%c ${msg}`, 'color: #10b981; font-weight: bold', 'color: inherit');
                    return 'extension';
                }
            } catch (_) {}
        }

        window.nsoBackendMode = 'cloudflare';
        window.nsoActiveBackend = 'cloudflare';
        const cloudMsg = typeof window.tr === 'function'
            ? window.tr('Connected to external server backend')
            : 'Connected to external server backend';
        console.log(`%c[backend:external]%c ${cloudMsg}`, 'color: #f59e0b; font-weight: bold', 'color: inherit');
        return 'cloudflare';
    })();

    return extensionPingPromise;
}


void nsoDetectBackend();

async function nsoDispatchExtensionMessage(type, payload = {}) {
    if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.sendMessage) {
        throw new Error('Chrome extension runtime is not available');
    }
    return new Promise((resolve, reject) => {
        chrome.runtime.sendMessage(NSO_EXTENSION_ID, { type, ...payload }, (res) => {
            if (chrome.runtime?.lastError) {
                reject(new Error(chrome.runtime.lastError.message || 'Extension communication error'));
            } else if (res && res.error) {
                resolve({ ok: false, status: res.status || 400, data: res });
            } else {
                resolve({ ok: true, status: res?.status || 200, data: res?.data ?? res });
            }
        });
    });
}

window.nsoDetectBackend = nsoDetectBackend;
window.nsoDispatchExtensionMessage = nsoDispatchExtensionMessage;

const DEFAULT_NXAPI_ZNCA_API_URL = 'https://nxapi-znca-api.fancy.org.uk/api/znca';
const DEFAULT_NXAPI_AUTH_CLIENT_ID = 'JGN1is1KSmRMOL-g4qmgZA';
const NXAPI_ZNCA_API_URL = (window.NXAPI_ZNCA_API_URL ||
    localStorage.getItem('nxapi_znca_api_url') ||
    DEFAULT_NXAPI_ZNCA_API_URL).replace(/\/$/, '');
const NXAPI_AUTH_CLIENT_ID = window.NXAPI_AUTH_CLIENT_ID || DEFAULT_NXAPI_AUTH_CLIENT_ID;
const NXAPI_AUTH_SCOPE = 'ca:gf ca:er ca:dr';
const NXAPI_CLIENT_VERSION = 'd8fAZDPzwimzQ7c6';


const ZNCA_PLATFORM = 'Android';
const ZNCA_PLATFORM_VERSION = '12';
const BUNDLED_ZNCA_VERSION = '3.5.0';
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





class AuthStageError extends Error {
    constructor(stage, message, originalError = null, status = null) {
        super(message);
        this.name = 'AuthStageError';
        this.stage = stage;
        this.originalError = originalError;
        this.status = status;
    }
}





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








(function installBrokerWarmTokenHydration() {
    function hydrate(snapshot) {
        const manager = window.webServiceManager;
        if (!manager?.tokenCache || !snapshot || typeof snapshot !== 'object') return 0;
        let count = 0;
        for (const [serviceId, cached] of Object.entries(snapshot)) {
            const token = cached?.token;
            const expiresAt = Number(cached?.expiresAt || 0);
            if (!/^\d+$/.test(String(serviceId)) || !token || expiresAt <= Date.now() + 60_000) continue;
            const current = manager.tokenCache.get(String(serviceId));
            if (!current || Number(current.expiresAt || 0) < expiresAt) {
                manager.tokenCache.set(String(serviceId), { token: String(token), expiresAt });
                count++;
            }
        }
        if (count > 0) manager.savePersistentGameTokens?.();
        return count;
    }

    window.nsoHydrateBrokerGameTokens = hydrate;

    const install = () => {
        const original = window.startTokenBrokerSession;
        if (typeof original !== 'function' || original.__nsoWarmTokenHydration) return;
        const wrapped = async function startTokenBrokerSessionWithWarmTokens(...args) {
            const data = await original.apply(this, args);
            hydrate(data?.gws);
            return data;
        };
        wrapped.__nsoWarmTokenHydration = true;
        window.startTokenBrokerSession = wrapped;
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', install, { once: true });
    } else {
        install();
    }
})();




function toast(message) {
    if (!message) return;
    let el = document.getElementById('nsoAppToast');
    if (!el) {
        el = document.createElement('div');
        el.id = 'nsoAppToast';
        el.className = 'op-toast';
        document.body.appendChild(el);
    }
    el.textContent = message;
    el.classList.add('show');
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => el?.classList.remove('show'), 2200);
}
window.toast = toast;

