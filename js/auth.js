/**
 * Remembered-session handling, token broker, nxapi auth helpers and Nintendo OAuth.
 * Kept in original execution order while separating this responsibility from the app shell.
 */

function checkStartupSession() {
    let stored = sessionStorage.getItem('nso_user_session');
    if (!stored && hasRememberedAccount()) {
        const persistent = localStorage.getItem('nso_user_session');
        if (persistent) {
            try {
                const parsed = JSON.parse(persistent);
                const expiresAt = Number(parsed?.nsoWebapp?.coralExpiresAt || 0);
                if (expiresAt > Date.now() + 60000 && parsed?.result?.webApiServerCredential?.accessToken) {
                    stored = persistent;
                    try { sessionStorage.setItem('nso_user_session', persistent); } catch (e) { }
                } else {
                    localStorage.removeItem('nso_user_session');
                }
            } catch (e) {
                localStorage.removeItem('nso_user_session');
            }
        }
    }

    if (stored) {
        try {
            const parsed = JSON.parse(stored);
            const expiresAt = Number(parsed?.nsoWebapp?.coralExpiresAt || 0);
            const token = parsed?.result?.webApiServerCredential?.accessToken;

            if (token && expiresAt > Date.now() + 60000) {
                userSession = parsed;
                applySessionZncaVersion(parsed);
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

function hasRememberedAccount() {
    const rememberedFlag = localStorage.getItem('nso_has_remembered_account') === 'true';
    const rememberedExpiresAt = Number(localStorage.getItem('nso_remember_expires_at') || 0);

    // New grants carry their absolute server expiry. Legacy grants without a local
    // expiry are still checked against the server's hard 30-day limit at resume time.
    if (rememberedFlag && rememberedExpiresAt > 0 && rememberedExpiresAt <= Date.now()) {
        localStorage.removeItem('nso_has_remembered_account');
        localStorage.removeItem('nso_remember_expires_at');
        return false;
    }
    return rememberedFlag && (rememberedExpiresAt <= 0 || rememberedExpiresAt > Date.now());
}

function updateRememberedUI() {
    const hasRemembered = hasRememberedAccount();
    const profileForgetBtn = document.getElementById('profileForgetRememberedBtn');
    if (profileForgetBtn) {
        profileForgetBtn.classList.toggle('hidden', !hasRemembered);
    }
    return hasRemembered;
}


let tokenBrokerHeartbeatTimer = null;

function tokenBrokerClientId() {
    const key = 'nso_token_broker_client_id';
    let value = null;
    try { value = sessionStorage.getItem(key); } catch (e) { }
    if (!value) {
        value = crypto.randomUUID().replace(/-/g, '_');
        try { sessionStorage.setItem(key, value); } catch (e) { }
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
    try { data = await response.json(); } catch (e) { }
    if (!response.ok) {
        const error = new Error(data?.error_description || data?.error || `Token broker session failed (HTTP ${response.status}).`);
        error.status = response.status;
        throw error;
    }
    return data;
}

function validBrokerCoralSession(entry, expectedNaId, expectedZncaVersion = nxapiAuthSession?.zncaVersion || null) {
    const session = entry?.session || entry;
    const expiresAt = Number(entry?.expiresAt || session?.nsoWebapp?.coralExpiresAt || 0);
    const sessionVersion = String(entry?.zncaVersion || session?.nsoWebapp?.zncaVersion || '');
    const requiredVersion = validZncaVersion(expectedZncaVersion) ? expectedZncaVersion : null;
    return Boolean(
        requiredVersion &&
        session?.result?.webApiServerCredential?.accessToken &&
        expiresAt > Date.now() + 60000 &&
        (!expectedNaId || String(session?.nsoWebapp?.naId || '') === String(expectedNaId)) &&
        sessionVersion === requiredVersion
    );
}

let nxapiLoginWarmPromise = null;

async function warmNxapiForLogin() {
    if (nxapiLoginWarmPromise) return nxapiLoginWarmPromise;
    nxapiLoginWarmPromise = (async () => {
        const nxapiAccessToken = await getNxapiAccessToken();
        const config = await getNxapiZncaConfig({ accessToken: nxapiAccessToken });
        return { nxapiAccessToken, zncaVersion: config.version };
    })();
    try {
        return await nxapiLoginWarmPromise;
    } finally {
        nxapiLoginWarmPromise = null;
    }
}

async function generateCoralViaTokenBroker({ idToken, naId, language, country, birthday }) {
    await prepareNxapi();
    // Resolve the version from nxapi before binding the OAuth token to a Coral
    // context. Hardcoding an app version eventually yields HTTP 406 when nxapi no
    // longer has a matching worker for that release.
    const { nxapiAccessToken, zncaVersion } = await warmNxapiForLogin();
    bindNxapiCoralContext(naId, zncaVersion);
    console.log("%c[nxapi:f1]%c Generating Coral session token (Method 1: Account Login)", "color: #3b82f6; font-weight: bold", "color: inherit");
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
            zncaVersion
        })
    });
    observeServiceResponse(response, { provider: 'nxapi-znca', operation: 'Coral token broker' });
    let data = {};
    try { data = await response.json(); } catch (e) { }
    if (response.status === 429) {
        const until = parseRetryAfter(response.headers.get('Retry-After')) || (Date.now() + 60000);
        setRateLimitUntil('f1', until);
    }
    if (response.status === 401 && data?.error === 'nxapi_invalid_token') {
        clearNxapiAuthSession();
    }
    if (response.status === 406 || data?.error === 'nxapi_unsupported_version') {
        clearNxapiZncaConfig();
        clearNxapiAuthSession();
    }
    if (!response.ok || !validBrokerCoralSession(data?.coral, naId, zncaVersion)) {
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

// Broker operations themselves refresh the ephemeral lease. A periodic keepalive
// would spend one Worker/DO request on ordinary pagehide/refresh. Ephemeral leases
// expire server-side and explicit Sign Out still performs destructive cleanup.
function startTokenBrokerHeartbeat() {
    stopTokenBrokerHeartbeat();
}

function stopTokenBrokerHeartbeat() {
    if (tokenBrokerHeartbeatTimer) clearTimeout(tokenBrokerHeartbeatTimer);
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
    }).catch(() => { });
}

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

const NXAPI_AUTH_METADATA_CACHE_KEY = 'nso_nxapi_auth_metadata_v1';
const NXAPI_AUTH_METADATA_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const NXAPI_ZNCA_CONFIG_MAX_AGE_MS = 5 * 60 * 1000;
let nxapiZncaConfig = null;

function clearNxapiZncaConfig() {
    nxapiZncaConfig = null;
    nxapiZncaConfigPromise = null;
}

function readCachedNxapiAuthMetadata() {
    try {
        const record = JSON.parse(localStorage.getItem(NXAPI_AUTH_METADATA_CACHE_KEY) || 'null');
        if (!record || Number(record.expiresAt || 0) <= Date.now()) return null;
        const endpoint = String(record.tokenEndpoint || '');
        const url = new URL(endpoint);
        if (url.protocol !== 'https:' || !url.hostname.endsWith('fancy.org.uk')) return null;
        return { token_endpoint: endpoint };
    } catch { return null; }
}

function writeCachedNxapiAuthMetadata(metadata) {
    try {
        const endpoint = String(metadata?.token_endpoint || '');
        if (!endpoint) return;
        localStorage.setItem(NXAPI_AUTH_METADATA_CACHE_KEY, JSON.stringify({
            tokenEndpoint: endpoint,
            expiresAt: Date.now() + NXAPI_AUTH_METADATA_MAX_AGE_MS
        }));
    } catch { }
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

    // Cross-tab Web Locks deduplication
    return await navigator.locks.request('nxapi-token', async () => {
        // Double check cache inside lock
        if (nxapiAuthSession.accessToken && nxapiAuthSession.expiresAt > Date.now() + 10000) {
            return nxapiAuthSession.accessToken;
        }
        const clientId = nxapiClientId();
        if (!clientId) {
            throw new AuthStageError('NXAPI_AUTH', 'Enter an nxapi-auth public client ID before signing in.');
        }

        if (!nxapiAuthMetadata) nxapiAuthMetadata = readCachedNxapiAuthMetadata();

        if (!nxapiAuthMetadata) {
            const apiOrigin = new URL(NXAPI_ZNCA_API_URL).origin;
            const protectedResourceResp = await proxyFetch(`${apiOrigin}/.well-known/oauth-protected-resource`, {
                headers: { Accept: 'application/json' },
                signal: options.signal
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
                    signal: options.signal
                }
            );
            nxapiAuthMetadata = await authorizationMetadataResp.json().catch(() => ({}));
            if (!authorizationMetadataResp.ok || !nxapiAuthMetadata.token_endpoint) {
                throw new AuthStageError('NXAPI_AUTH', nxapiAuthMetadata.error_description || 'Could not discover the nxapi token endpoint.');
            }
            writeCachedNxapiAuthMetadata(nxapiAuthMetadata);
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

        console.log(`%c[nxapi:auth]%c Requesting OAuth access token (${isRefresh ? "refresh" : "client_credentials"})`, "color: #8b5cf6; font-weight: bold", "color: inherit");
        const tokenResp = await proxyFetch(nxapiAuthMetadata.token_endpoint, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                Accept: 'application/json'
            },
            body: new URLSearchParams(tokenRequest).toString(),
            signal: options.signal
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
        } catch (e) { }

        if (!tokenResp.ok || !tokenData.access_token) {
            if (isRefresh) {
                clearNxapiAuthSession();
            }
            const errMsg = tokenData.error_description || tokenData.error || `nxapi authentication failed (HTTP ${tokenResp.status}).`;
            throw new AuthStageError('NXAPI_AUTH', errMsg, null, tokenResp.status);
        }

        nxapiAuthSession = {
            accessToken: tokenData.access_token,
            expiresAt: Date.now() + Math.max(1, Number(tokenData.expires_in || 300)) * 1000,
            refreshToken: tokenData.refresh_token || nxapiAuthSession.refreshToken || null,
            coralNaId: nxapiAuthSession.coralNaId || null,
            // The version is deliberately left unbound until /config tells us what
            // nxapi can currently serve. Binding BUNDLED_ZNCA_VERSION here caused 406s.
            zncaVersion: nxapiAuthSession.zncaVersion || null
        };

        return nxapiAuthSession.accessToken;
    });
}

async function getNxapiZncaConfig(options = {}) {
    throwIfAborted(options.signal);
    if (nxapiZncaConfig && nxapiZncaConfig.fetchedAt + NXAPI_ZNCA_CONFIG_MAX_AGE_MS > Date.now()) {
        return nxapiZncaConfig;
    }
    return await navigator.locks.request('nxapi-config', async () => {
        if (nxapiZncaConfig && nxapiZncaConfig.fetchedAt + NXAPI_ZNCA_CONFIG_MAX_AGE_MS > Date.now()) {
            return nxapiZncaConfig;
        }
        const accessToken = options.accessToken || await getNxapiAccessToken({
            signal: options.signal
        });
        console.log("%c[nxapi:config]%c Fetching znca version configuration from nxapi", "color: #06b6d4; font-weight: bold", "color: inherit");
        const response = await proxyFetch(nxapiUrl('config'), {
            method: 'GET',
            headers: {
                Accept: 'application/json',
                Authorization: `Bearer ${accessToken}`,
                'X-znca-Client-Version': NXAPI_CLIENT_VERSION,
                'X-znca-Platform': ZNCA_PLATFORM
            },
            signal: options.signal,
            diagnosticOperation: 'nxapi supported-version config'
        });
        const data = await response.json().catch(() => ({}));

        if (response.status === 401) {
            clearNxapiAuthSession();
        }
        if (!response.ok) {
            throw new AuthStageError(
                'NXAPI_CONFIG',
                data?.error_description || data?.error || `Could not read nxapi ZNCA configuration (HTTP ${response.status}).`,
                null,
                response.status
            );
        }

        const version = String(data?.nso_version || '');
        if (!validZncaVersion(version)) {
            throw new AuthStageError('NXAPI_CONFIG', 'nxapi returned an invalid or missing nso_version.');
        }

        const supportedVersions = Array.isArray(data?.versions)
            ? data.versions
                .filter(item => item?.platform === ZNCA_PLATFORM && item?.name === 'com.nintendo.znca' && validZncaVersion(item?.version))
                .map(item => String(item.version))
            : [];
        if (supportedVersions.length && !supportedVersions.includes(version)) {
            throw new AuthStageError('NXAPI_CONFIG', `nxapi reported ${version} as latest but not as an available Android ZNCA version.`);
        }

        nxapiZncaConfig = {
            version,
            supportedVersions,
            fetchedAt: Date.now()
        };
        ZNCA_VERSION = version;
        nxapiAuthSession.zncaVersion = version;
        return nxapiZncaConfig;
    });
}

async function nxapiFetch(path, options = {}) {
    throwIfAborted(options.signal);
    const token = await getNxapiAccessToken({ signal: options.signal });
    if (!userSession && !validZncaVersion(nxapiAuthSession.zncaVersion)) {
        await getNxapiZncaConfig({ accessToken: token, signal: options.signal });
    }
    const response = await proxyFetch(nxapiUrl(path), {
        ...options,
        headers: {
            'X-znca-Client-Version': NXAPI_CLIENT_VERSION,
            'X-znca-Platform': ZNCA_PLATFORM,
            'X-znca-Version': activeZncaVersion(),
            Authorization: `Bearer ${token}`,
            ...(options.headers || {})
        }
    });

    if (response.status === 401) {
        clearNxapiAuthSession();
    }
    if (response.status === 406) {
        clearNxapiZncaConfig();
    }

    return response;
}

// Do not dynamically change X-znca-Version after nxapi/Coral authentication.
// nxapi associates protected API use with one Coral user/context; changing the
// app version while reusing that context causes `X-znca-Version ... does not match token`.
// Version changes therefore happen only when a brand-new Coral session is created.

async function nxapiGenerateF(method, token, userData = {}, requestOptions = {}) {
    if (userData?.na_id && !userSession) {
        const accessToken = await getNxapiAccessToken({ signal: requestOptions.signal });
        const config = await getNxapiZncaConfig({ accessToken, signal: requestOptions.signal });
        bindNxapiCoralContext(userData.na_id, config.version);
    } else if (userData?.na_id) {
        bindNxapiCoralContext(userData.na_id, activeZncaVersion());
    }
    // Keep f-generation on the proven nxapi-auth path. The Worker already relays
    // these requests, so adding a second Worker-owned OAuth client path only adds
    // another failure mode without making the remote attestation itself faster.
    console.log(`%c[nxapi:f${method}]%c Generating Method ${method} attestation (Reason: ${method === 1 ? "Coral Login" : "Game Token fallback"})`, "color: #f97316; font-weight: bold", "color: inherit");
    const response = await nxapiFetch('f', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ hash_method: String(method), token, ...userData }),
        signal: requestOptions.signal
    });

    let data = {};
    try {
        data = await response.json();
    } catch (e) { }

    if (!response.ok || !data.f || !data.request_id || !Number.isFinite(Number(data.timestamp))) {
        if (nxapiVersionContextMismatch(response.status, data)) clearNxapiAuthSession();
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
    if (userSession?.nsoWebapp?.naId) bindNxapiCoralContext(userSession.nsoWebapp.naId, activeZncaVersion());
    console.log(`%c[nxapi:encrypt]%c Encrypting Coral request: ${url}`, "color: #64748b; font-weight: bold", "color: inherit");
    const response = await nxapiFetch('encrypt-request', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ url, token: bearerToken || null, data: body }),
        signal: requestOptions.signal
    });
    let data = {};
    try {
        data = await response.json();
    } catch (e) { }

    if (!response.ok || !data.data) {
        if (nxapiVersionContextMismatch(response.status, data)) clearNxapiAuthSession();
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
    if (userSession?.nsoWebapp?.naId) bindNxapiCoralContext(userSession.nsoWebapp.naId, activeZncaVersion());
    console.log(`%c[nxapi:decrypt]%c Decrypting Coral response`, "color: #64748b; font-weight: bold", "color: inherit");
    const response = await nxapiFetch('decrypt-response', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'text/plain' },
        body: JSON.stringify({ data: encryptedBase64 }),
        signal: requestOptions.signal
    });
    const data = await response.text();
    if (!response.ok) {
        if (nxapiVersionContextMismatch(response.status, data)) clearNxapiAuthSession();
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

function userFacingErrorMessage(error, fallbackKey = 'Error_Dialog_Message_Unknown_Error') {
    const message = String(error?.message || '');
    const code = String(error?.code || '');
    const status = Number(error?.status || 0);
    if (status === 429 || code.includes('rate_limit') || /rate.?limit/i.test(message)) return tr('nxapi is temporarily rate-limited. Please try again later.');
    if (status === 406 || code === 'nxapi_unsupported_version' || /no matching workers/i.test(message)) return tr('nxapi is temporarily unavailable. Please try again later.');
    return trKey(fallbackKey);
}

async function prepareNintendoOAuthLink() {
    try {
        const { verifier, challenge } = await generatePKCE();
        const state = generateRandomString(50);

        localStorage.setItem('nso_pkce_verifier', verifier);
        localStorage.setItem('nso_auth_state', state);

        const oauthUrl = `https://accounts.nintendo.com/connect/1.0.0/authorize?state=${state}&redirect_uri=npf71b963c1b7b6d119%3A%2F%2Fauth&client_id=71b963c1b7b6d119&scope=openid+user+user.birthday+user.screenName&response_type=session_token_code&session_token_code_challenge=${challenge}&session_token_code_challenge_method=S256&theme=login_form`;

        const oauthBtn = document.getElementById('nintendoOAuthGateBtn');
        if (oauthBtn) {
            oauthBtn.setAttribute('href', oauthUrl);
            oauthBtn.dataset.oauthUrl = oauthUrl;
        }
        return oauthUrl;
    } catch (e) {
        console.warn('[auth] Failed to pre-generate Nintendo OAuth link:', e);
        return null;
    }
}

async function openNintendoOAuth(e) {
    const nxapiConsentCheckbox = document.getElementById('nxapiConsentCheckbox');
    if (nxapiConsentCheckbox && !nxapiConsentCheckbox.checked) {
        if (e) e.preventDefault();
        const nxapiDisclosure = document.getElementById('nxapiDisclosure');
        nxapiDisclosure?.classList.add('needs-consent');
        nxapiConsentCheckbox.focus();
        nxapiConsentCheckbox.reportValidity?.();
        return;
    }

    const oauthBtn = document.getElementById('nintendoOAuthGateBtn');
    let oauthUrl = oauthBtn?.dataset?.oauthUrl || oauthBtn?.getAttribute('href');

    if (!oauthUrl || oauthUrl === '#' || oauthUrl.startsWith('javascript:')) {
        if (e) e.preventDefault();
        // Synchronously open blank window to bypass mobile popup blockers before async operations
        const popup = window.open('about:blank', '_blank');
        try {
            oauthUrl = await prepareNintendoOAuthLink();
            if (oauthUrl) {
                if (popup && !popup.closed) {
                    popup.location.href = oauthUrl;
                } else {
                    window.location.href = oauthUrl;
                }
            } else if (popup && !popup.closed) {
                popup.close();
            }
        } catch (err) {
            if (popup && !popup.closed) popup.close();
            alert(userFacingErrorMessage(err, 'Error_Dialog_Message_Login_Failed'));
        }
        return;
    }

    // Anchor link handles navigation natively without popup blocker interference.
    // Prepare next PKCE verifier/challenge in advance for subsequent attempts.
    setTimeout(() => {
        void prepareNintendoOAuthLink();
    }, 1200);
}

// Navigation Tabs & CrewVue-style Lottie Dock Bar
