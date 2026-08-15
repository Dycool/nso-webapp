/**
 * Nintendo Switch Online WebApp.
 * Uses nxapi's public ZNCA API for Coral attestation and request encryption.
 * The Worker provides CORS relay, reverse-proxied WebView hosting, and encrypted Remember Me storage.
 */

const WORKER_URL = 'https://nso-worker-backend.diogoenes0.workers.dev';
const NXAPI_ZNCA_API_URL = (window.NXAPI_ZNCA_API_URL ||
    localStorage.getItem('nxapi_znca_api_url') ||
    'https://nxapi-znca-api.fancy.org.uk/api/znca').replace(/\/$/, '');
const NXAPI_AUTH_CLIENT_ID = window.NXAPI_AUTH_CLIENT_ID || 'JGN1is1KSmRMOL-g4qmgZA';
const NXAPI_AUTH_SCOPE = 'ca:gf ca:er ca:dr';
const NXAPI_CLIENT_VERSION = 'w8zSLBsxR7rVoGJA';

// Exact Coral Header Constants
const ZNCA_PLATFORM = 'Android';
const ZNCA_PLATFORM_VERSION = '12';
let ZNCA_VERSION = '3.4.0';

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
function parseRetryAfter(headerValue) {
    if (!headerValue) return null;
    const trimmed = String(headerValue).trim();
    const seconds = Number(trimmed);
    if (!isNaN(seconds) && seconds >= 0) {
        return Date.now() + seconds * 1000;
    }
    const parsedDate = Date.parse(trimmed);
    if (!isNaN(parsedDate) && parsedDate > Date.now()) {
        return parsedDate;
    }
    return null;
}

function getRateLimitUntil() {
    try {
        const val = localStorage.getItem('nxapi_rate_limit_until');
        const num = Number(val);
        return !isNaN(num) && num > Date.now() ? num : 0;
    } catch (e) {
        return 0;
    }
}

function setRateLimitUntil(timestamp) {
    try {
        if (timestamp > Date.now()) {
            localStorage.setItem('nxapi_rate_limit_until', String(timestamp));
        } else {
            localStorage.removeItem('nxapi_rate_limit_until');
        }
        updateRateLimitBanner();
    } catch (e) {}
}

let rateLimitTimer = null;
function updateRateLimitBanner() {
    const banner = document.getElementById('rateLimitBanner');
    const bannerText = document.getElementById('rateLimitBannerText');
    const until = getRateLimitUntil();

    if (rateLimitTimer) {
        clearTimeout(rateLimitTimer);
        rateLimitTimer = null;
    }

    if (until > Date.now()) {
        if (banner) banner.classList.remove('hidden');
        const remainingSec = Math.ceil((until - Date.now()) / 1000);
        const timeStr = new Date(until).toLocaleTimeString();
        if (bannerText) {
            bannerText.textContent = `nxapi authentication temporarily rate-limited. Retry after ${timeStr} (${remainingSec}s remaining).`;
        }
        rateLimitTimer = setTimeout(() => {
            updateRateLimitBanner();
        }, 1000);
    } else {
        if (banner) banner.classList.add('hidden');
        try { localStorage.removeItem('nxapi_rate_limit_until'); } catch (e) {}
    }
}

document.addEventListener('DOMContentLoaded', () => {
    initNavigation();
    initServicesNav();
    initAuthGate();
    updateRateLimitBanner();
    checkStartupSession();
});

function checkStartupSession() {
    const stored = localStorage.getItem('nso_user_session');
    if (stored) {
        try {
            const parsed = JSON.parse(stored);
            const expiresAt = Number(parsed?.nsoWebapp?.coralExpiresAt || 0);
            const token = parsed?.result?.webApiServerCredential?.accessToken;

            // Only reuse if token exists and expiration derived from Coral is strictly in the future
            if (token && expiresAt > Date.now() + 60000) {
                userSession = parsed;
                showAuthenticatedUI(parsed);
                return;
            }
        } catch (e) {
            console.warn('[Startup] Invalid cached session structure:', e);
        }
        localStorage.removeItem('nso_user_session');
        userSession = null;
    }

    showLoginGate();
    updateRememberedUI();
}

function updateRememberedUI() {
    const hasRemembered = localStorage.getItem('nso_has_remembered_account') === 'true';
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

function nxapiClientId() {
    return NXAPI_AUTH_CLIENT_ID.trim();
}

function hasNxapiConsent() {
    return document.getElementById('nxapiConsentCheckbox')?.checked === true;
}

async function prepareNxapi() {
    if (!hasNxapiConsent()) {
        throw new AuthStageError('NXAPI_AUTH', 'Please acknowledge the nxapi data disclosure checkbox before continuing.');
    }
    await refreshNxapiConfig();
}

async function proxyFetch(targetUrl, options = {}) {
    const proxyPayload = {
        targetUrl: targetUrl,
        method: options.method || 'GET',
        headers: options.headers || {}
    };
    if (options.bodyBase64) {
        proxyPayload.dataBase64 = options.bodyBase64;
    } else {
        proxyPayload.data = options.body || null;
    }

    return fetch(`${WORKER_URL}/api/nso/proxy`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(proxyPayload)
    });
}

function nxapiUrl(path) {
    return `${NXAPI_ZNCA_API_URL}/${path.replace(/^\//, '')}`;
}

/**
 * Single-flight in-memory nxapi token acquisition adhering strictly to public terms.
 * Never persists nxapi tokens to storage.
 */
async function getNxapiAccessToken() {
    const rateLimitUntil = getRateLimitUntil();
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
                headers: { Accept: 'application/json' }
            });
            const protectedResource = await protectedResourceResp.json().catch(() => ({}));
            if (!protectedResourceResp.ok || !protectedResource.authorization_servers?.[0]) {
                throw new AuthStageError('NXAPI_AUTH', protectedResource.error_description || 'Could not discover nxapi authentication metadata.');
            }

            const authorizationServer = new URL(protectedResource.authorization_servers[0]);
            const authorizationMetadataResp = await proxyFetch(
                `${authorizationServer.origin}/.well-known/oauth-authorization-server`,
                { headers: { Accept: 'application/json' } }
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
            body: new URLSearchParams(tokenRequest).toString()
        });

        if (tokenResp.status === 429) {
            const retryAfterHeader = tokenResp.headers.get('Retry-After');
            const until = parseRetryAfter(retryAfterHeader) || (Date.now() + 60000);
            setRateLimitUntil(until);
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
    const token = await getNxapiAccessToken();
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

    if (response.status === 429) {
        const retryAfterHeader = response.headers.get('Retry-After');
        const until = parseRetryAfter(retryAfterHeader) || (Date.now() + 60000);
        setRateLimitUntil(until);
        const timeStr = new Date(until).toLocaleTimeString();
        const sec = Math.ceil((until - Date.now()) / 1000);
        throw new AuthStageError(
            'NXAPI_AUTH',
            `nxapi authentication temporarily rate-limited (HTTP 429). Retry after ${timeStr} (${sec}s remaining).`,
            null,
            429
        );
    }

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

async function nxapiGenerateF(method, token, userData = {}) {
    const response = await nxapiFetch('f', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ hash_method: String(method), token, ...userData })
    });
    let data = {};
    try {
        data = await response.json();
    } catch (e) {}

    if (!response.ok || !data.f || !data.request_id || !Number.isFinite(Number(data.timestamp))) {
        const errorMsg = data.error_description || data.error_message || data.error || 'nxapi did not return a complete attestation result.';
        if (response.status === 429 || errorMsg.toLowerCase().includes('too many attempts') || errorMsg.toLowerCase().includes('rate limit')) {
            const retryAfterHeader = response.headers.get('Retry-After');
            const until = parseRetryAfter(retryAfterHeader) || (Date.now() + 60000);
            setRateLimitUntil(until);
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

async function nxapiEncryptRequest(url, bearerToken, body) {
    const response = await nxapiFetch('encrypt-request', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ url, token: bearerToken || null, data: body })
    });
    let data = {};
    try {
        data = await response.json();
    } catch (e) {}

    if (!response.ok || !data.data) {
        const errorMsg = data.error_description || data.error_message || data.error || 'nxapi request encryption failed.';
        if (response.status === 429 || errorMsg.toLowerCase().includes('too many attempts') || errorMsg.toLowerCase().includes('rate limit')) {
            const retryAfterHeader = response.headers.get('Retry-After');
            const until = parseRetryAfter(retryAfterHeader) || (Date.now() + 60000);
            setRateLimitUntil(until);
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

async function nxapiDecryptResponse(encryptedBase64) {
    const response = await nxapiFetch('decrypt-response', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'text/plain' },
        body: JSON.stringify({ data: encryptedBase64 })
    });
    const data = await response.text();
    if (!response.ok) {
        if (response.status === 429 || data.toLowerCase().includes('too many attempts') || data.toLowerCase().includes('rate limit')) {
            const retryAfterHeader = response.headers.get('Retry-After');
            const until = parseRetryAfter(retryAfterHeader) || (Date.now() + 60000);
            setRateLimitUntil(until);
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

async function parseCoralResponse(response) {
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
    const decrypted = await nxapiDecryptResponse(encryptedBase64);
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

// Navigation Tabs
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
}

function showAppPage(pageName = 'home') {
    document.querySelectorAll('.tab-page').forEach(page => page.classList.remove('active'));
    document.querySelectorAll('#homeDock button').forEach(button => {
        button.classList.toggle('active', button.dataset.page === pageName);
    });
    document.getElementById(`page-${pageName}`)?.classList.add('active');
    window.scrollTo({ top: 0, behavior: 'auto' });
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
    showAppPage('home');

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
    localStorage.removeItem('nso_user_session');
    localStorage.removeItem('nso_pkce_verifier');
    localStorage.removeItem('nso_auth_state');
    userSession = null;
    nxapiAuthSession = { accessToken: null, refreshToken: null, expiresAt: 0 };
    showLoginGate();
    updateRememberedUI();
}

async function forgetRememberedAccount() {
    localStorage.removeItem('nso_has_remembered_account');
    updateRememberedUI();
    try {
        await fetch(`${WORKER_URL}/api/nso/remember/forget`, {
            method: 'POST',
            credentials: 'include'
        });
    } catch (e) {
        console.warn('[RememberMe] Failed to delete server-side remember record:', e);
    }
    alert('Remembered Nintendo Account has been forgotten on this device.');
}

function openProfile() {
    document.getElementById('profileView').classList.remove('hidden');
}

async function openNotifications() {
    const view = document.getElementById('notificationView');
    const list = document.getElementById('notificationList');
    view.classList.remove('hidden');
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
        else submitGateBtn.innerHTML = '<i class="fa-solid fa-plug"></i> Authenticate & Enter WebApp';
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

function setAuthGateHint(text) {
    const hint = document.getElementById('authGateHint');
    if (hint) hint.textContent = text || '';
}

async function performFullAuthentication(options = {}) {
    if (loginInFlight) {
        console.log('[Auth] Authentication already in progress, awaiting active flow.');
        return loginInFlight;
    }

    // Immediately disable buttons BEFORE any await
    setAuthButtonsDisabled(true, 'Preparing authentication...');

    loginInFlight = (async () => {
        try {
            await prepareNxapi();

            let idToken = null;
            let accessToken = null;
            let longLivedSessionToken = null;
            const isResume = options.isResume === true;

            if (isResume) {
                setAuthButtonsDisabled(true, 'Resuming remembered session...');
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
                        localStorage.setItem('nso_user_session', JSON.stringify(jsonSession));
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
                setAuthButtonsDisabled(true, 'Step 1/3: Exchanging Session Code...');
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
                setAuthButtonsDisabled(true, 'Step 2/3: Fetching ID Token & Profile...');
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

            // Step 3: Fetch Nintendo User Profile (/2.0.0/users/me with NASDKAPI User-Agent)
            // Zero fake profile defaults: require id, country, language, birthday
            setAuthButtonsDisabled(true, 'Fetching Nintendo Profile...');
            setAuthGateHint('Retrieving authenticated Nintendo Account profile…');

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

            const userInfo = await userResp.json().catch(() => ({}));
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

            // Step 4: Request nxapi method-1 attestation
            setAuthButtonsDisabled(true, 'Step 3/3: Requesting nxapi attestation...');
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
            setAuthButtonsDisabled(true, 'Step 3/3: Encrypting Coral login...');
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
            setAuthButtonsDisabled(true, 'Logging into Coral Account...');
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

            let data;
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

            // Authentication succeeded! Derive expiresAt strictly from Coral's webApiServerCredential.expiresIn
            const expiresInSec = Number(data.result?.webApiServerCredential?.expiresIn || 7200);
            data.nsoWebapp = {
                naId,
                coralExpiresAt: Date.now() + expiresInSec * 1000
            };
            userSession = data;
            localStorage.setItem('nso_user_session', JSON.stringify(data));

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
                        localStorage.setItem('nso_has_remembered_account', 'true');
                        updateRememberedUI();
                    } else {
                        const err = await remResp.json().catch(() => ({}));
                        console.warn('[RememberMe] Save rejected:', err.error);
                    }
                } catch (e) {
                    console.warn('[RememberMe] Save error:', e);
                }
            }

            setAuthGateHint('');
            showAuthenticatedUI(data);
        } catch (err) {
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

    let pasteDebounceTimer = null;
    const continueWithPastedRedirect = () => {
        if (pasteDebounceTimer) clearTimeout(pasteDebounceTimer);
        pasteDebounceTimer = setTimeout(() => {
            const value = authInput?.value.trim() || '';
            if (!value || !(value.includes('session_token_code=') || value.startsWith('eyJ') || value.startsWith('{'))) return;
            if (!hasNxapiConsent()) {
                setAuthGateHint('Please acknowledge the nxapi disclosure checkbox before continuing.');
                return;
            }
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
            const input = authInput?.value.trim() || '';
            performFullAuthentication({ input });
        });
    }

    if (resumeRememberedBtn) {
        resumeRememberedBtn.addEventListener('click', () => {
            if (!hasNxapiConsent()) {
                setAuthGateHint('Please acknowledge the nxapi disclosure checkbox before continuing.');
                alert('Please acknowledge the nxapi data disclosure checkbox before continuing.');
                return;
            }
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
    const requestBody = options.body || { parameter };
    const encrypted = await nxapiEncryptRequest(url, token, JSON.stringify(requestBody));
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
        bodyBase64: encrypted
    });
    const data = await parseCoralResponse(response);
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
        const presence = f.presence || {};
        const presenceState = presence.state || f.state;
        const isOnline = ['ONLINE', 'PLAYING'].includes(presenceState) || f.isOnline;
        const presenceName = presence.game?.name || presence.name || '';
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
                <div class="friend-game">${statusText}</div>
            </div>
        `;
        card.addEventListener('click', () => openFriendDetail(f));
        container.appendChild(card);
    });
}

async function openFriendDetail(friend) {
    const isOnline = ['ONLINE', 'PLAYING'].includes(friend.presence?.state || friend.state) || friend.isOnline;
    const presence = friend.presence?.name || friend.presence?.game?.name || '';
    document.getElementById('friendDetailAvatar').src = friend.imageUri || friend.image_url || '';
    document.getElementById('friendDetailAvatar').alt = friend.name || 'Friend';
    document.getElementById('friendDetailName').textContent = friend.name || 'Friend';
    document.getElementById('friendDetailPresence').textContent = isOnline ? (presence ? `Playing ${presence}` : 'Online now') : 'Offline';

    const activity = document.getElementById('friendDetailActivity');
    activity.innerHTML = '<div style="color:#aaaab0;font-size:13px">Loading play activity…</div>';
    document.getElementById('friendDetailView').classList.remove('hidden');

    try {
        if (!friend.nsaId) {
            if (presence) {
                activity.innerHTML = `
                    <div class="friend-activity-row">
                        <img src="${friend.presence?.imageUri || friend.presence?.game?.imageUri || friend.imageUri || friend.image_url || ''}" alt="">
                        <div>
                            <strong>${presence}</strong>
                            <span>${isOnline ? 'Playing now' : 'Recently played'}</span>
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
            activity.innerHTML = '<div style="display:flex;flex-direction:column;gap:12px"></div>';
            const list = activity.firstElementChild;
            playLogs.forEach(log => {
                const hours = Math.round((log.totalPlayTime || 0) / 60);
                const row = document.createElement('div');
                row.className = 'friend-activity-row';
                row.innerHTML = `
                    <img src="${log.imageUri || ''}" alt="" onerror="this.style.display='none'">
                    <div>
                        <strong>${log.name || 'Game'}</strong>
                        <span>${hours > 0 ? `Played for ${hours} hours or more` : 'First played recently'}</span>
                    </div>
                `;
                list.appendChild(row);
            });
        } else if (presence) {
            activity.innerHTML = `
                <div class="friend-activity-row">
                    <img src="${friend.presence?.imageUri || friend.presence?.game?.imageUri || friend.imageUri || friend.image_url || ''}" alt="">
                    <div>
                        <strong>${presence}</strong>
                        <span>${isOnline ? 'Playing now' : 'Recently played'}</span>
                    </div>
                </div>
            `;
        } else {
            activity.textContent = 'No play activity is available.';
        }
    } catch (e) {
        if (presence) {
            activity.innerHTML = `
                <div class="friend-activity-row">
                    <img src="${friend.presence?.imageUri || friend.presence?.game?.imageUri || friend.imageUri || friend.image_url || ''}" alt="">
                    <div>
                        <strong>${presence}</strong>
                        <span>${isOnline ? 'Playing now' : 'Recently played'}</span>
                    </div>
                </div>
            `;
        } else {
            activity.textContent = 'Play activity is set to private or not available.';
        }
    }
}

document.getElementById('closeMediaModalBtn').addEventListener('click', () => {
    document.getElementById('mediaModal').classList.add('hidden');
    document.getElementById('mediaModalContent').innerHTML = '';
    document.getElementById('mediaModalMeta').classList.add('hidden');
    activeMediaItem = null;
});

document.getElementById('mediaInfoBtn').addEventListener('click', showActiveMediaInfo);
document.getElementById('mediaShareBtn').addEventListener('click', shareActiveMedia);
document.getElementById('mediaDownloadBtn').addEventListener('click', downloadActiveMedia);

document.getElementById('closeFriendDetailBtn').addEventListener('click', () => {
    document.getElementById('friendDetailView').classList.add('hidden');
});

document.getElementById('closeFriendDetailHomeBtn').addEventListener('click', () => {
    document.getElementById('friendDetailView').classList.add('hidden');
});

document.getElementById('closeNotificationBtn').addEventListener('click', () => {
    document.getElementById('notificationView').classList.add('hidden');
});

document.getElementById('closeProfileBtn').addEventListener('click', () => {
    document.getElementById('profileView').classList.add('hidden');
});

// Friend Settings Screen Navigation (Screenshots 2, 3, 4, 5)
document.getElementById('openFriendSettingsBtn')?.addEventListener('click', () => {
    document.getElementById('friendSettingsView')?.classList.remove('hidden');
});

document.getElementById('closeFriendSettingsBtn')?.addEventListener('click', () => {
    document.getElementById('friendSettingsView')?.classList.add('hidden');
});

document.getElementById('openNotifySettingBtn')?.addEventListener('click', () => {
    document.getElementById('friendSettingsNotifyView')?.classList.remove('hidden');
});

document.getElementById('closeNotifySettingBtn')?.addEventListener('click', () => {
    document.getElementById('friendSettingsNotifyView')?.classList.add('hidden');
});

document.getElementById('openRequestsSettingBtn')?.addEventListener('click', () => {
    document.getElementById('friendSettingsRequestsView')?.classList.remove('hidden');
});

document.getElementById('closeRequestsSettingBtn')?.addEventListener('click', () => {
    document.getElementById('friendSettingsRequestsView')?.classList.add('hidden');
});

document.getElementById('openBlockedSettingBtn')?.addEventListener('click', () => {
    document.getElementById('friendSettingsBlockedView')?.classList.remove('hidden');
});

document.getElementById('closeBlockedSettingBtn')?.addEventListener('click', () => {
    document.getElementById('friendSettingsBlockedView')?.classList.add('hidden');
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
    document.getElementById('addFriendView')?.classList.remove('hidden');
});

document.getElementById('closeAddFriendBtn')?.addEventListener('click', () => {
    document.getElementById('addFriendView')?.classList.add('hidden');
});

document.getElementById('openSearchByFriendCodeBtn')?.addEventListener('click', () => {
    document.getElementById('searchByFriendCodeView')?.classList.remove('hidden');
    const input = document.getElementById('friendCodeInput');
    if (input) {
        input.focus();
    }
});

document.getElementById('closeSearchByFriendCodeBtn')?.addEventListener('click', () => {
    document.getElementById('searchByFriendCodeView')?.classList.add('hidden');
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
    document.getElementById('sentReqDetailView')?.classList.remove('hidden');

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
    document.getElementById('sentReqDetailView')?.classList.add('hidden');
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



