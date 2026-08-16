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
    home: 'home', // 'home' | 'profile' | 'notifications'
    friends: 'list', // 'list' | 'detail'
    album: 'album' // 'album'
};

let activeFriendDetailData = null;
let friendDetailOriginTab = 'friends';

// --- Slide transition helpers ---
function slideViewIn(el) {
    if (!el) return;
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

function applyTabViewState(tabName = 'home') {
    // Hide all base tab pages and overlay views instantly (tab switches don't animate)
    document.querySelectorAll('.tab-page').forEach(page => page.classList.remove('active'));
    hideViewInstant(document.getElementById('profileView'));
    hideViewInstant(document.getElementById('notificationView'));
    hideViewInstant(document.getElementById('friendDetailView'));

    if (tabName === 'home') {
        const homeState = navTabStacks.home;
        if (homeState === 'profile') {
            showViewInstant(document.getElementById('profileView'));
        } else if (homeState === 'notifications') {
            showViewInstant(document.getElementById('notificationView'));
        } else {
            document.getElementById('page-home')?.classList.add('active');
        }
    } else if (tabName === 'friends') {
        const friendsState = navTabStacks.friends;
        if (friendsState === 'detail' && activeFriendDetailData) {
            showViewInstant(document.getElementById('friendDetailView'));
        } else {
            navTabStacks.friends = 'list';
            document.getElementById('page-friends')?.classList.add('active');
        }
    } else if (tabName === 'album') {
        document.getElementById('page-album')?.classList.add('active');
    }
}

function showAppPage(pageName = 'home') {
    document.querySelectorAll('#homeDock button').forEach(button => {
        button.classList.toggle('active', button.dataset.page === pageName);
    });
    switchDockTab(pageName);
    applyTabViewState(pageName);
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
    window.opCloseParityScreens?.();
    localStorage.removeItem('nso_user_session');
    localStorage.removeItem('nso_pkce_verifier');
    localStorage.removeItem('nso_auth_state');
    userSession = null;
    nxapiAuthSession = { accessToken: null, refreshToken: null, expiresAt: 0 };
    showLoginGate();
    updateRememberedUI();
    clearRememberedAccount();
}

async function clearRememberedAccount() {
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

    const isOnline = ['ONLINE', 'PLAYING'].includes(friend.presence?.state || friend.state) || friend.isOnline;
    const presence = friend.presence?.name || friend.presence?.game?.name || '';
    document.getElementById('friendDetailAvatar').src = friend.imageUri || friend.image_url || '';
    document.getElementById('friendDetailAvatar').alt = friend.name || 'Friend';
    document.getElementById('friendDetailName').textContent = friend.name || 'Friend';
    document.getElementById('friendDetailPresence').textContent = isOnline ? (presence ? `Playing ${presence}` : 'Online now') : 'Offline';

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
// Friends functional controls (merged from friends-functional.js)
// ---------------------------------------------------------------------------
/**
 * Completes the Friends UI already present in app.js/index.html.
 *
 * This file deliberately does not replace the existing Friends list renderer,
 * navigation, friend-code search UI, or play-activity UI. It only wires the
 * controls that are currently disabled/local-only to Coral endpoints exposed
 * through the existing coralCall() helper.
 */
(() => {
    'use strict';

    if (window.__nsoFriendsFunctionalLoaded) return;
    window.__nsoFriendsFunctionalLoaded = true;

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
                console.warn('[FriendsFunctional] Could not refresh friends', error);
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
            console.warn('[FriendsFunctional] Could not load friend permissions', error);
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
                console.warn('[FriendsFunctional] Could not load friend requests', error);
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
                console.warn('[FriendsFunctional] Could not load blocked users', error);
            });
        });

        $('openNotifySettingBtn')?.addEventListener('click', updateNotifySettingsSummary);
        $('openMyCodeQrBtn')?.addEventListener('click', showMyFriendCode);

        $('closeChattedUsersBtn')?.addEventListener('click', () => {
            $('chattedUsersView')?.classList.add('hidden');
        });

        $('openVoiceChattedFriendsBtn')?.addEventListener('click', () => {
            openVoiceChattedFriends().catch((error) => {
                console.warn('[FriendsFunctional] Could not load GameChat friend candidates', error);
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
        console.log('[FriendsFunctional] Missing Friends controls wired to Coral');
    }

    init();
})();

// ---------------------------------------------------------------------------
// APK-derived Nintendo Switch App parity layer (merged from official-parity.js)
// Loads after the Friends functional block; supersedes overlapping controls via clone-and-replace.
// ---------------------------------------------------------------------------

/**
 * Nintendo Switch App parity layer.
 *
 * Derived from the user's Nintendo Switch App 3.4.1 APK and wired against the
 * Coral helpers already present in nso-webapp. It deliberately leaves the
 * working authentication and game-specific WebView code alone.
 */
(() => {
    'use strict';

    if (window.__nsoOfficialParityLoaded) return;
    window.__nsoOfficialParityLoaded = true;

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
        chats:            { path: '/v5/Chat/List' },
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
     * Exact-ish Coral call for the endpoints added by this parity layer.
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
        let el = $('officialParityToast');
        if (!el) {
            el = document.createElement('div');
            el.id = 'officialParityToast';
            el.className = 'op-toast';
            document.body.appendChild(el);
        }
        el.textContent = message;
        el.classList.add('show');
        clearTimeout(toast.timer);
        toast.timer = setTimeout(() => el.classList.remove('show'), 2200);
    }

    function replaceControl(id, handler, options = {}) {
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

    function closeParityScreens(except = null) {
        document.querySelectorAll('.op-screen').forEach((screen) => {
            if (screen.id === except) return;
            if (typeof hideViewInstant === 'function') hideViewInstant(screen);
            else screen.classList.add('hidden');
        });
    }

    window.opCloseParityScreens = () => closeParityScreens();

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
                closeParityScreens(id);
            }, { once: true });
        } else {
            closeParityScreens(id);
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
            <div class="op-profile-hero">
                <img id="opUserAvatar" src="" alt="">
                <h3 id="opUserName">Switch Player</h3>
            </div>
            <section class="op-group">
                <h4>Nintendo Account</h4>
                <button class="op-row" id="opFriendCodeRow"><span><b>Friend Code</b><small id="opFriendCode">—</small></span><i class="fa-solid fa-chevron-right"></i></button>
                <button class="op-row" id="opOnlineStatusRow"><span><b>Online Status</b><small id="opOnlineStatusSummary">—</small></span><i class="fa-solid fa-chevron-right"></i></button>
                <button class="op-row" id="opPlayActivityRow"><span><b>Play Activity</b><small id="opPlayActivitySummary">—</small></span><i class="fa-solid fa-chevron-right"></i></button>
                <button class="op-row" id="opNintendoAccountRow"><span><b>Nintendo Account Website</b></span><i class="fa-solid fa-arrow-up-right-from-square"></i></button>
            </section>
            <section class="op-group">
                <h4>Other</h4>
                <button class="op-row" id="opPushNotificationsRow"><span><b>Push Notifications</b></span><i class="fa-solid fa-chevron-right"></i></button>
                <button class="op-row" id="opAppSettingsRow"><span><b>Settings</b></span><i class="fa-solid fa-chevron-right"></i></button>
            </section>
            <button class="op-signout" id="opSignOutBtn"><i class="fa-solid fa-right-from-bracket"></i> Sign Out</button>`);

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
            opVisibilityPage: 'opUserPage',
            opPushPage: 'opUserPage',
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
        for (const [child, parent] of Object.entries(parents)) {
            const back = $(child)?.querySelector('.op-back');
            if (!back) continue;
            replaceNodeListener(back, () => {
                const childView = $(child);
                const parentView = $(parent);
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

    async function openUserPage() {
        ensureScreens();
        const user = sessionUser();
        $('opUserAvatar').src = user?.imageUri || user?.image2Uri || $('profileViewAvatar')?.src || '';
        $('opUserName').textContent = user?.name || user?.nickname || $('profileViewName')?.textContent || 'Switch Player';
        $('opFriendCode').textContent = user?.links?.friendCode?.id || $('profileViewFriendCode')?.textContent || '—';
        openScreen('opUserPage');

        try {
            await loadCurrentUserAndPermissions(true);
            const full = state.currentUser || user || {};
            $('opUserAvatar').src = full.imageUri || full.image2Uri || $('opUserAvatar').src;
            $('opUserName').textContent = full.name || $('opUserName').textContent;
            $('opFriendCode').textContent = full.links?.friendCode?.id || $('opFriendCode').textContent;
            const p = state.permissions?.permissions || full.permissions || {};
            $('opOnlineStatusSummary').textContent = permissionLabel('presence', p.presence);
            $('opPlayActivitySummary').textContent = permissionLabel('playLog', p.playLog);
        } catch (error) {
            console.warn('[OfficialParity] User Page refresh failed', error);
        }
    }

    async function openVisibility(kind) {
        ensureScreens();
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

    async function openPushNotifications() {
        ensureScreens();
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
        if (!media || media.__nsoParityBound) return;
        media.__nsoParityBound = true;
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
        $('opSettingsBody').innerHTML = `
            <section class="op-group op-no-margin">
                <h4>Account Information</h4>
                <button class="op-row" id="opSettingsProfile"><span><b>Profile</b><small>${escapeHtml(profileSummary)}</small></span><i class="fa-solid fa-chevron-right"></i></button>
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
            </section>`;
        $('opSettingsProfile')?.addEventListener('click', () => {
            openUserPage();
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

    async function openSettings() {
        ensureScreens();
        openScreen('opSettingsPage');
        await loadCurrentUserAndPermissions().catch(() => {});
        if (!state.loginFactor) {
            state.loginFactor = await coralExact('loginFactor').catch(() => null);
        }
        renderSettingsPage();
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
            console.debug('[OfficialParity] Chat/List unavailable', error);
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
            coralExact('announcementRead', { id: item.id }).catch((error) => console.debug('[OfficialParity] Announcement read marker failed', error));
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

    function installAlbumParity() {
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

        replaceControl('mediaInfoBtn', async () => {
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
                    console.debug('[OfficialParity] Hashtag/List unavailable', error);
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
        view.classList.remove('hidden');
        body.innerHTML = '<p class="op-loading"><i class="fa-solid fa-spinner fa-spin"></i> Loading…</p>';
        try {
            const result = await coralExact('chatCandidates');
            const raw = Array.isArray(result) ? result : (result?.chatParticipants || result?.friendCandidates || []);
            if (!raw.length) {
                body.innerHTML = '<p class="chatted-users-empty">Users you\'ve chatted with will be displayed here.</p>';
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
        } catch (error) {
            body.innerHTML = `<p class="service-status error">Couldn't load users you've chatted with: ${escapeHtml(error.message)}</p>`;
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
        openScreen('opChatCandidatePage');
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
            try { await coralExact('friendBlock', { nsaId: candidate.nsaId }); toast('Blocked.'); $('opChatCandidatePage').classList.add('hidden'); }
            catch (error) { alert(`Could not block user: ${error.message}`); }
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
            const btn = replaceControl('openNotifySettingBtn', async () => {
                await openFriendOnlineSettings('friendSettingsView');
            });
            btn?.querySelector('span') && (btn.querySelector('span').textContent = 'Notify When Friends Come Online');
        }
        // Remove the earlier capture-phase redirect by replacing the button node.
        replaceControl('changeNotifySettingBtn', () => openFriendOnlineSettings('friendSettingsView'));
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

    function installFriendDetailParity() {
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
        replaceControl('openVoiceChattedFriendsBtn', openChatCandidates);
        const empty = $('chattedUsersView')?.querySelector('.chatted-users-empty');
        if (empty) empty.textContent = "Users you've chatted with will be displayed here.";
    }

    function installProfileAndNotifications() {
        replaceControl('userAvatarContainer', (event) => {
            event.preventDefault();
            event.stopImmediatePropagation();
            $('profileView')?.classList.add('hidden');
            openUserPage();
        }, { capture: true });
        replaceControl('notificationBtn', (event) => {
            event.preventDefault();
            event.stopImmediatePropagation();
            $('notificationView')?.classList.add('hidden');
            openAnnouncements();
        }, { capture: true });
    }

    function installUserPageBindings() {
        ensureScreens();
        $('opFriendCodeRow')?.addEventListener('click', () => $('openMyCodeQrBtn')?.click());
        $('opOnlineStatusRow')?.addEventListener('click', () => openVisibility('presence'));
        $('opPlayActivityRow')?.addEventListener('click', () => openVisibility('playLog'));
        $('opNintendoAccountRow')?.addEventListener('click', () => window.open('https://accounts.nintendo.com/', '_blank', 'noopener'));
        $('opPushNotificationsRow')?.addEventListener('click', openPushNotifications);
        $('opAppSettingsRow')?.addEventListener('click', openSettings);
        $('opSignOutBtn')?.addEventListener('click', async () => {
            const ok = await confirmSheet('Sign Out', 'Sign out of Nintendo Switch App?', 'Sign Out');
            if (ok && typeof logout === 'function') logout();
        });
    }

    function installAuthenticatedRefreshHook() {
        if (typeof showAuthenticatedUI === 'function' && !showAuthenticatedUI.__opWrapped) {
            const previous = showAuthenticatedUI;
            const wrapped = function(session) {
                const result = previous(session);
                queueMicrotask(() => refreshParityData());
                return result;
            };
            wrapped.__opWrapped = true;
            showAuthenticatedUI = wrapped;
        }
    }

    async function refreshParityData() {
        if (state.refreshing) return state.refreshing;
        state.refreshing = (async () => {
            installAlbumParity();
            if (coralToken()) {
                coralExact('announcements').then((result) => {
                    state.announcements = Array.isArray(result) ? result : (result?.announcements || []);
                    updateAnnouncementDot();
                }).catch(() => {});
            }
        })().finally(() => { state.refreshing = null; });
        return state.refreshing;
    }

    function installReceivedRequestTextParity() {
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
        installProfileAndNotifications();
        installUserPageBindings();
        installFriendOnlinePageReplacement();
        installExistingRequestSettingExactCall();
        installFriendDetailParity();
        installChatCandidateReplacement();
        installAlbumParity();
        installReceivedRequestTextParity();
        refreshParityData();
        console.log('[OfficialParity] APK-derived Nintendo Switch App parity layer loaded');
    }

    init();
})();
