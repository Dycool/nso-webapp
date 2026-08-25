/**
 * WebServiceManager
 * Central orchestration layer for Nintendo Switch Online Game Web Services.
 * Handles adapter selection, canonical GameWebServiceToken acquisition,
 * Durable Object session management, and the controlled postMessage bridge protocol.
 */


function nsoUiText(source) {
    try { return typeof window.nsoTranslateText === 'function' ? window.nsoTranslateText(source) : source; } catch { return source; }
}
function nsoUiVars(source, values = {}) {
    try { return typeof window.nsoTranslateVars === 'function' ? window.nsoTranslateVars(source, values) : String(source).replace(/\{([A-Za-z0-9_]+)\}/g, (_, key) => String(values[key] ?? '')); } catch { return source; }
}
function nsoUiApk(key, fallback = '') {
    try { return typeof window.nsoTranslateApkKey === 'function' ? window.nsoTranslateApkKey(key) : (fallback || key); } catch { return fallback || key; }
}

class WebServiceManager {
    constructor() {
        this.SPLATNET3_ID = '4834290508791808';
        this.NOOKLINK_ID = '4953919198265344';
        this.SPLATNET2_ID = '5741031244955648';
        this.SMASHWORLD_ID = '5598642853249024';
        this.SMASHWORLD_LEGACY_ID = '5614999764533248';

        this.genericAdapter = new GenericWebViewAdapter(this);
        this.zeldaNotesAdapter = new ZeldaNotesAdapter(this);
        this.splatnet3Adapter = new SplatNet3QuirksAdapter(this);
        this.nooklinkAdapter = new NookLinkQuirksAdapter(this);
        this.splatnet2Adapter = new SplatNet2QuirksAdapter(this);
        this.smashWorldAdapter = new SmashWorldQuirksAdapter(this);

        this.activeAdapter = null;
        this.activeService = null;
        this.launchingButton = null;
        this.tokenCache = new Map();
        this.tokenInFlight = new Map();

        this.launchLocked = false;
        this.launchEpoch = 0;
        this.launchTransitionTimer = null;
        this.loadingFallbackTimer = null;
        this.activeLaunchController = null;
        this.activeLaunchId = null;
        this.cancelInFlight = null;

        // No background nxapi/f prewarming: first-use attestation is intentionally on demand.

        this.initPostMessageListener();
    }

    getWorkerUrl() {
        return typeof WORKER_URL !== 'undefined' ? WORKER_URL : 'https://nso-worker-backend.diogoenes0.workers.dev';
    }

    /**
     * Resolves the appropriate adapter for any game service.
     * Unknown / future services automatically fall back to GenericWebViewAdapter.
     */
    getAdapter(service) {
        if (!service) return this.genericAdapter;
        const idStr = String(service.id || '');
        const name = (service.name || '').toLowerCase();
        const uri = (service.uri || service.url || '').toLowerCase();

        if (idStr === this.SPLATNET3_ID || uri.includes('av5ja.srv.nintendo.net')) {
            return this.splatnet3Adapter;
        }
        if (idStr === this.NOOKLINK_ID || uri.includes('acbaa.srv.nintendo.net')) {
            return this.nooklinkAdapter;
        }
        if (idStr === this.SPLATNET2_ID || uri.includes('splatoon2.nintendo.net')) {
            return this.splatnet2Adapter;
        }
        if (idStr === this.SMASHWORLD_ID || idStr === this.SMASHWORLD_LEGACY_ID || uri.includes('smashbros.nintendo.net') || uri.includes('smashworld.nintendo.net') || uri.includes('aaaba') || name.includes('smash')) {
            return this.smashWorldAdapter;
        }
        if (name.includes('zelda') || uri.includes('zelda')) {
            return this.zeldaNotesAdapter;
        }

        // Generic fallback for any future or catalog service
        return this.genericAdapter;
    }

    rehydratePersistentGameTokens() {
        if (typeof hasRememberedAccount === 'function' && !hasRememberedAccount() && !userSession) return;
        try {
            const raw = localStorage.getItem('nso_gws_tokens');
            if (!raw) return;
            const parsed = JSON.parse(raw);
            if (!Array.isArray(parsed)) return;
            const now = Date.now();
            for (const [id, entry] of parsed) {
                if (entry && Number(entry.expiresAt || 0) > now + 60000 && entry.token) {
                    this.tokenCache.set(String(id), { token: String(entry.token), expiresAt: Number(entry.expiresAt) });
                }
            }
        } catch { }
    }

    savePersistentGameTokens() {
        if (typeof hasRememberedAccount === 'function' && !hasRememberedAccount() && !userSession) {
            try { localStorage.removeItem('nso_gws_tokens'); } catch { }
            return;
        }
        try {
            const entries = [];
            const now = Date.now();
            for (const [id, entry] of this.tokenCache.entries()) {
                if (entry && Number(entry.expiresAt || 0) > now + 60000 && entry.token) {
                    entries.push([String(id), { token: String(entry.token), expiresAt: Number(entry.expiresAt) }]);
                }
            }
            if (entries.length) {
                localStorage.setItem('nso_gws_tokens', JSON.stringify(entries));
            } else {
                localStorage.removeItem('nso_gws_tokens');
            }
        } catch { }
    }

    getCachedGameWebServiceToken(serviceId) {
        const idStr = String(serviceId);
        let cached = this.tokenCache.get(idStr);
        if (!cached && (typeof hasRememberedAccount !== 'function' || hasRememberedAccount() || Boolean(userSession))) {
            this.rehydratePersistentGameTokens();
            cached = this.tokenCache.get(idStr);
        }
        if (cached && cached.expiresAt > Date.now() + 60000) return cached.token;
        if (cached) {
            this.tokenCache.delete(idStr);
            this.savePersistentGameTokens();
        }
        return null;
    }

    tokenBrokerClientId() {
        return typeof window.nsoTokenBrokerClientId === 'function'
            ? window.nsoTokenBrokerClientId()
            : null;
    }

    async requestBrokerCachedToken(serviceId, options = {}) {
        const clientId = this.tokenBrokerClientId();
        if (!clientId) return { unavailable: true };
        const coralUserId = String(userSession?.result?.user?.id || userSession?.user?.id || '');
        const response = await fetch(`${this.getWorkerUrl()}/api/nso/service/token/cache`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
            credentials: 'include',
            signal: options.signal,
            body: JSON.stringify({
                clientId,
                serviceId: String(serviceId),
                coralUserId,
                zncaVersion: typeof window.nsoActiveZncaVersion === 'function' ? window.nsoActiveZncaVersion() : (typeof ZNCA_VERSION === 'string' ? ZNCA_VERSION : undefined),
                forceFresh: options.forceFresh === true
            })
        });
        if (typeof window.nsoObserveServiceResponse === 'function') {
            window.nsoObserveServiceResponse(response, { provider: 'cloudflare', operation: 'Game service token cache' });
        }
        let data = {};
        try { data = await response.json(); } catch (e) {}
        if (response.ok && data?.tokens && typeof data.tokens === "object") {
            for (const [id, entry] of Object.entries(data.tokens)) {
                if (entry?.token) {
                    this.tokenCache.set(String(id), {
                        token: String(entry.token),
                        expiresAt: Number(entry.expiresAt || (Date.now() + 7200 * 1000))
                    });
                }
            }
            this.savePersistentGameTokens();
            if (data?.source === "shared_f2") {
                console.log(`%c[nxapi:shared_f2]%c Reused 1 single method-2 attestation across ${Object.keys(data.tokens || {}).length} game services in parallel!`, "color: #10b981; font-weight: bold", "color: inherit");
            }
        }
        if (response.ok && data?.token?.token) {
            return { token: data.token.token, expiresAt: Number(data.token.expiresAt || 0), source: data.source || 'cache' };
        }
        if ((response.ok && data?.miss === true) || (response.status === 404 && data?.error === 'cache_miss')) return { miss: true };
        if (response.status === 401 && data?.error === 'broker_session_missing') return { unavailable: true };
        const error = new Error(data?.error_description || data?.error || `Cloudflare token cache failed (HTTP ${response.status}).`);
        error.status = response.status;
        error.code = data?.error || 'broker_cache_error';
        throw error;
    }

    setLoadingStatus(message = '') {
        const status = document.querySelector('#gwsNativeLoading .gws-native-loading-status');
        if (!status) return;
        const text = String(message || '').trim();
        status.textContent = text;
        status.classList.toggle('hidden', !text);
    }

    async requestBrokerGeneratedToken(serviceId, traceId, options = {}) {
        const clientId = this.tokenBrokerClientId();
        if (!clientId) return { unavailable: true };
        const coralToken = coralAccessToken();
        const naId = userSession?.nsoWebapp?.naId;
        const coralUserId = String(userSession?.result?.user?.id || userSession?.user?.id || '');
        if (!coralToken || !naId) return { unavailable: true };

        const zncaVersion = typeof window.nsoActiveZncaVersion === 'function'
            ? window.nsoActiveZncaVersion()
            : (typeof ZNCA_VERSION === 'string' ? ZNCA_VERSION : '3.4.1');
        if (typeof window.nsoBindNxapiCoralContext === 'function') {
            window.nsoBindNxapiCoralContext(String(naId), zncaVersion);
        }

        // Only acquire an nxapi bearer after Cloudflare has positively reported a
        // cache miss. The bearer is then kept in memory for its validity and remains
        // pinned to this Coral user + ZNCA version.
        const nxapiAccessToken = await getNxapiAccessToken({
            signal: options.signal,
            cancelKey: options.cancelKey
        });

        // Public nxapi terms prohibit automatic retries after an HTTP response.
        // One user interaction therefore produces at most one generation request.
        if (options.signal?.aborted) throw new DOMException('The operation was aborted.', 'AbortError');
        console.log(`%c[nxapi:f2]%c Generating GameWebServiceToken for service ${serviceId} via Worker (nxapi method 2)`, "color: #3b82f6; font-weight: bold", "color: inherit");
        const response = await fetch(`${this.getWorkerUrl()}/api/nso/service/token`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
            credentials: 'include',
            signal: options.signal,
            body: JSON.stringify({
                clientId,
                serviceId: String(serviceId),
                coralAccessToken: coralToken,
                nxapiAccessToken,
                naId: String(naId),
                coralUserId,
                zncaVersion,
                serviceIds: [String(serviceId), "4834290508791808", "5598642853249024", "4953919198265344", "5935781783175168", "5741031244955648"],
                forceFresh: options.forceFresh === true,
                cancelKey: options.cancelKey || undefined
            })
        });
        if (typeof window.nsoObserveServiceResponse === 'function') {
            window.nsoObserveServiceResponse(response, { provider: 'nxapi-znca', operation: 'Game service token generation' });
        }

        let data = {};
        try { data = await response.json(); } catch (e) {}
        if (response.ok && data?.token?.token) {
            this.setLoadingStatus('');
            return { token: data.token.token, expiresAt: Number(data.token.expiresAt || 0), source: data.source || 'generated' };
        }
        if (response.status === 401 && data?.error === 'broker_session_missing') {
            this.setLoadingStatus('');
            return { unavailable: true };
        }
        if (response.status === 401 && data?.error === 'nxapi_invalid_token') {
            try { clearNxapiAuthSession(); } catch (e) {}
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
            // Public nxapi terms prohibit retrying the failed HTTP response. Drop
            // only the in-memory OAuth token so the next explicit launch can obtain
            // a fresh token for the session's pinned ZNCA version.
            try { clearNxapiAuthSession(); } catch (e) {}
        }
        const message = noMatchingWorker
            ? `nxapi has no matching Android worker for Nintendo Switch App ${zncaVersion} right now. ${String(data?.error_description || '').trim()}`.trim()
            : versionMismatch
                ? `The nxapi token context did not match Nintendo Switch App ${zncaVersion}. The stale in-memory nxapi token was cleared; try launching again.`
                : (data?.error_description || data?.error || `Cloudflare token broker failed (HTTP ${response.status}).`);
        const error = new Error(message);
        error.status = response.status;
        error.code = noMatchingWorker ? 'nxapi_unsupported_version' : (versionMismatch ? 'nxapi_version_context_mismatch' : (data?.error || 'broker_generation_error'));
        if (noMatchingWorker || versionMismatch) error.requestedVersion = zncaVersion;
        throw error;
    }

    async getGameWebServiceTokenCanonical(serviceId, traceId, options = {}) {
        const token = coralAccessToken();
        if (!token) throw new Error('No Coral access token available. Please sign in again.');
        const naId = userSession?.nsoWebapp?.naId;
        if (!naId) throw new Error('Nintendo Account ID missing in session. Please sign out and sign in again.');
        const coralUserId = String(userSession?.result?.user?.id || userSession?.user?.id || '');

        if (options.signal?.aborted) throw new DOMException('The operation was aborted.', 'AbortError');
        const fStartedAt = performance.now();
        console.log(`%c[nxapi:f2:fallback]%c Generating GameWebServiceToken for service ${serviceId} via client fallback (nxapi method 2)`, "color: #ec4899; font-weight: bold", "color: inherit");
        const attestation = await nxapiGenerateF(2, token, {
            na_id: naId,
            coral_user_id: coralUserId
        }, {
            signal: options.signal,
            cancelKey: options.cancelKey
        });
        

        if (options.signal?.aborted) throw new DOMException('The operation was aborted.', 'AbortError');
        const tokenStart = performance.now();
        const result = await coralCall('/v4/Game/GetWebServiceToken', {
            id: Number(serviceId),
            registrationToken: '',
            f: attestation.f,
            timestamp: attestation.timestamp,
            requestId: attestation.requestId
        }, {
            signal: options.signal,
            cancelKey: options.cancelKey
        });
        
        if (!result?.accessToken) throw new Error('Nintendo did not return a valid GameWebServiceToken.');
        const expiresInSec = Number.isFinite(Number(result.expiresIn)) ? Number(result.expiresIn) : 7200;
        return {
            token: result.accessToken,
            expiresAt: Date.now() + Math.max(60, expiresInSec) * 1000,
            source: 'canonical_fallback'
        };
    }

    /**
     * Account-wide GameWebServiceToken acquisition.
     *
     * 1. Reuse this tab's in-memory copy when valid.
     * 2. Ask the Cloudflare account broker (zero nxapi calls on a hit).
     * 3. Only on a miss, acquire an in-memory nxapi bearer and let the account DO
     *    single-flight one method-2 generation across every active device.
     * 4. Fall back to the canonical browser path only when the broker session itself
     *    is unavailable. HTTP responses are never automatically retried.
     */
    async getGameWebServiceToken(serviceId, traceId, forceFresh = false, options = {}) {
        const idStr = String(serviceId);
        if (!forceFresh) {
            const cached = this.getCachedGameWebServiceToken(idStr);
            if (cached) {
                console.log(`%c[GWS:Cache HIT]%c Reusing cached token for service ${idStr} (Zero nxapi contact)`, "color: #10b981; font-weight: bold", "color: inherit");
                return cached;
            }
        }

        const existingFlight = this.tokenInFlight.get(idStr);
        if (existingFlight) {
            const sameLaunch = !options.cancelKey || !existingFlight.cancelKey || existingFlight.cancelKey === options.cancelKey;
            if (sameLaunch) {
                
                return await existingFlight.promise;
            }
        }

        const fetchPromise = (async () => {
            let result;
            if (!forceFresh) {
                result = await this.requestBrokerCachedToken(idStr, {
                    signal: options.signal,
                    forceFresh: false
                });
                if (result?.token) {
                    
                }
            } else {
                result = { miss: true };
            }

            if (!result?.token && !result?.unavailable) {
                console.log(`%c[GWS:Cache MISS]%c Requesting token for service ${idStr} (Method 2 f-token via nxapi)...`, "color: #f59e0b; font-weight: bold", "color: inherit");
                result = await this.requestBrokerGeneratedToken(idStr, traceId, {
                    signal: options.signal,
                    cancelKey: options.cancelKey,
                    forceFresh
                });
            }

            if (!result?.token && result?.unavailable) {
                result = await this.getGameWebServiceTokenCanonical(idStr, traceId, options);
            }
            if (!result?.token) throw new Error('Could not obtain a GameWebServiceToken.');

            this.tokenCache.set(idStr, {
                token: result.token,
                expiresAt: Number(result.expiresAt || (Date.now() + 2 * 60 * 60 * 1000))
            });
            this.savePersistentGameTokens();
            return result.token;
        })();

        const flight = { promise: fetchPromise, cancelKey: options.cancelKey || null };
        this.tokenInFlight.set(idStr, flight);
        try {
            return await fetchPromise;
        } finally {
            if (this.tokenInFlight.get(idStr) === flight) this.tokenInFlight.delete(idStr);
        }
    }

    isLaunchCancellation(error) {
        return error?.name === 'AbortError' || error?.code === 'NSO_LAUNCH_CANCELLED';
    }

    setCatalogLocked(locked, activeButton = null) {
        this.launchLocked = Boolean(locked);
        const catalog = document.getElementById('gameServicesCatalog');
        catalog?.classList.toggle('launch-locked', this.launchLocked);

        document.querySelectorAll('#gameServicesCatalog .service-launch-card button').forEach((button) => {
            if (!button.dataset.nsoOriginalText) button.dataset.nsoOriginalText = button.textContent || nsoUiText('Connect');
            button.disabled = this.launchLocked;
            if (button === activeButton && this.launchLocked) button.textContent = nsoUiText('Connecting…');
            else button.textContent = button.dataset.nsoOriginalText || nsoUiText('Connect');
        });
    }

    getLaunchBackgroundSurfaces() {
        return [
            document.querySelector('.navbar'),
            document.getElementById('appContent'),
            document.getElementById('homeDock')
        ].filter((el) => el && !el.classList.contains('hidden'));
    }

    ensureLoadingSurface(service) {
        const wrap = document.querySelector('.inapp-webview-frame-wrap');
        if (!wrap) return null;
        let loading = document.getElementById('gwsNativeLoading');
        if (!loading) {
            loading = document.createElement('div');
            loading.id = 'gwsNativeLoading';
            loading.className = 'gws-native-loading hidden';
            wrap.prepend(loading);
        }

        const image = service?.imageUri
            ? `<img class="gws-native-loading-icon" src="${String(service.imageUri).replace(/"/g, '&quot;')}" alt="">`
            : '';
        loading.innerHTML = `
            <div class="gws-native-loading-inner">
                ${image}
                <span class="gws-native-loading-spinner" aria-hidden="true"></span>
                <strong class="gws-native-loading-title">${this.escapeText(service?.name || nsoUiText('Game Service'))}</strong>
                <span class="gws-native-loading-status hidden" aria-live="polite"></span>
            </div>`;
        loading.classList.remove('hidden', 'is-complete');
        this.setLoadingStatus('');
        return loading;
    }

    escapeText(value) {
        const div = document.createElement('div');
        div.textContent = String(value ?? '');
        return div.innerHTML;
    }

    destroyServiceFrame() {
        const frame = document.getElementById('inAppGameWebviewFrame');
        if (!frame) return;
        try { frame.remove(); } catch (e) { frame.parentNode?.removeChild(frame); }
    }

    mountServiceFrame(service, src) {
        const wrap = document.querySelector('.inapp-webview-frame-wrap');
        if (!wrap || !src) return null;

        this.destroyServiceFrame();

        // Configure the complete cross-origin WebView while detached, then
        // navigate it directly to the Worker before insertion. This avoids a
        // sandboxed inherited about:blank document and its Chromium warning.
        const frame = document.createElement('iframe');
        frame.id = 'inAppGameWebviewFrame';
        frame.name = 'inAppGameWebviewFrame';
        frame.title = 'Nintendo Switch Online Game Service';
        frame.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-downloads');

        // Zelda Notes uses the Screen Wake Lock API while its map is open.
        // Delegate only that capability to Zelda's Worker-origin document.
        if (this.getAdapter(service) === this.zeldaNotesAdapter) {
            frame.setAttribute('allow', 'screen-wake-lock');
        }

        frame.src = String(src);
        wrap.appendChild(frame);
        return frame;
    }

    clearLaunchTransitionClasses() {
        const overlay = document.getElementById('inAppGameWebview');
        const surfaces = this.getLaunchBackgroundSurfaces();
        const classes = [
            'nso-apk-go-enter', 'nso-apk-go-exit',
            'nso-apk-back-enter', 'nso-apk-back-exit',
            'nso-apk-transition-foreground', 'nso-apk-transition-background'
        ];
        [overlay, ...surfaces].filter(Boolean).forEach((el) => {
            classes.forEach((name) => el.classList.remove(name));
        });
    }

    beginNativeServiceLaunch(service) {
        if (this.launchTransitionTimer) clearTimeout(this.launchTransitionTimer);
        this.clearLaunchTransitionClasses();

        const overlay = document.getElementById('inAppGameWebview');
        const title = document.getElementById('inAppGameWebviewTitle');
        if (title) title.textContent = service?.name || nsoUiText('Game Service');
        this.destroyServiceFrame();
        this.ensureLoadingSurface(service);

        document.documentElement.classList.add('gws-transition-active');
        document.body.classList.add('gws-transition-active');

        const surfaces = this.getLaunchBackgroundSurfaces();
        surfaces.forEach((surface) => {
            surface.classList.add('nso-apk-transition-background', 'nso-apk-go-exit');
        });

        if (overlay) {
            overlay.classList.remove('hidden');
            overlay.classList.add('nso-apk-transition-foreground', 'nso-apk-go-enter');
        }

        // The APK forward activity transition completes at 550 ms.
        this.launchTransitionTimer = setTimeout(() => {
            this.launchTransitionTimer = null;
            this.clearLaunchTransitionClasses();
            document.documentElement.classList.remove('gws-transition-active');
            document.body.classList.remove('gws-transition-active');
            document.documentElement.classList.add('webview-active');
            document.body.classList.add('webview-active');
        }, 580);
    }

    markServiceLoaded() {
        const loading = document.getElementById('gwsNativeLoading');
        if (!loading || loading.classList.contains('hidden')) return;
        this.setLoadingStatus('');
        loading.classList.add('is-complete');
        if (this.loadingFallbackTimer) {
            clearTimeout(this.loadingFallbackTimer);
            this.loadingFallbackTimer = null;
        }
        setTimeout(() => loading.classList.add('hidden'), 140);
    }

    installLoadFallback() {
        if (this.loadingFallbackTimer) clearTimeout(this.loadingFallbackTimer);
        // Native completeLoading/service-ready signals are authoritative. This is only
        // an emergency escape hatch for an unknown/legacy service that never emits one.
        this.loadingFallbackTimer = setTimeout(() => {
            this.loadingFallbackTimer = null;
            this.markServiceLoaded();
        }, 5000);
    }

    async cancelNativeServiceLaunch() {
        if (this.launchTransitionTimer) {
            clearTimeout(this.launchTransitionTimer);
            this.launchTransitionTimer = null;
        }

        const overlay = document.getElementById('inAppGameWebview');
        const surfaces = this.getLaunchBackgroundSurfaces();
        this.destroyServiceFrame();
        document.documentElement.classList.remove('webview-active');
        document.body.classList.remove('webview-active');
        document.documentElement.classList.add('gws-transition-active');
        document.body.classList.add('gws-transition-active');

        this.clearLaunchTransitionClasses();
        surfaces.forEach((surface) => {
            surface.classList.add('nso-apk-transition-background', 'nso-apk-back-enter');
        });
        overlay?.classList.add('nso-apk-transition-foreground', 'nso-apk-back-exit');

        await new Promise((resolve) => setTimeout(resolve, 430));
        this.clearLaunchTransitionClasses();
        overlay?.classList.add('hidden');
        document.documentElement.classList.remove('gws-transition-active');
        document.body.classList.remove('gws-transition-active');
        this.setLoadingStatus('');
        document.getElementById('gwsNativeLoading')?.classList.add('hidden');
    }

    /**
     * Launch a selected game service. A hard global lock is taken before any
     * asynchronous work, so a second service cannot be selected until this
     * WebView is closed or the launch fails.
     */
    async launchService(service, buttonElement) {
        if (!service || this.launchLocked || this.activeAdapter?.currentSession) return;

        const adapter = this.getAdapter(service);
        const launchId = crypto.randomUUID();
        const launchController = new AbortController();
        this.activeLaunchId = launchId;
        this.activeLaunchController = launchController;
        this.activeAdapter = adapter;
        this.activeService = service;
        this.launchingButton = buttonElement;
        this.setCatalogLocked(true, buttonElement);
        buttonElement?.closest('.service-launch-card')?.classList.add('launching-service');
        this.beginNativeServiceLaunch(service);

        const launchEpoch = ++this.launchEpoch;
        const traceId = 'tr_' + Math.random().toString(36).slice(2, 8);
        const overallStart = performance.now();
        let succeeded = false;

        try {
            
            const token = await this.getGameWebServiceToken(service.id, traceId, false, {
                signal: launchController.signal,
                cancelKey: launchId
            });
            if (launchController.signal.aborted || launchEpoch !== this.launchEpoch || !this.launchLocked) {
                const cancelled = new Error('Launch cancelled');
                cancelled.code = 'NSO_LAUNCH_CANCELLED';
                throw cancelled;
            }

            const userProfile = userSession?.result?.user || userSession?.user;
            const language = userProfile?.language || 'en-GB';
            const country = userProfile?.country || 'GB';

            const sessionStart = performance.now();
            await adapter.launch(service, token, {
                language,
                country,
                signal: launchController.signal,
                launchId
            });
            if (launchController.signal.aborted || launchEpoch !== this.launchEpoch || !this.launchLocked) {
                const cancelled = new Error('Launch cancelled');
                cancelled.code = 'NSO_LAUNCH_CANCELLED';
                throw cancelled;
            }
            const sessionDuration = Math.round(performance.now() - sessionStart);
            

            this.installLoadFallback();
            succeeded = true;
            const totalDuration = Math.round(performance.now() - overallStart);
            
        } catch (e) {
            const cancelled = this.isLaunchCancellation(e) || launchController.signal.aborted || launchEpoch !== this.launchEpoch;
            if (!cancelled) {
                console.error(`[LaunchTrace:${traceId}] Launch failed:`, e);

                // Remove the catalog loading treatment immediately. Previously it stayed
                // painted over the service artwork while the 400 ms Back transition and
                // Cloudflare cancellation completed, which made failures look stuck/broken.
                buttonElement?.closest('.service-launch-card')?.classList.remove('launching-service');
                launchController.abort();

                // Roll the UI back immediately and cancel the server-side launch in parallel.
                // The error dialog is only shown after the native Back animation has finished,
                // so no loading animation is visible behind it.
                                await this.cancelNativeServiceLaunch();
                                const reason = e?.code === 'nxapi_unsupported_version'
                    ? nsoUiVars('No matching nxapi Android worker is available for Nintendo Switch App {version} right now. Please try again later.', { version: e.requestedVersion || '?' })
                    : (Number(e?.status || 0) === 429 ? nsoUiText('nxapi is temporarily rate-limited. Please try again later.') : nsoUiApk('Error_Dialog_Message_Unknown_Error', 'An error has occurred.'));
                alert(nsoUiVars('Could not open {service}. {reason}', { service: service.name || nsoUiText('Game Service'), reason }));
            } else {
                
            }
        } finally {
            buttonElement?.closest('.service-launch-card')?.classList.remove('launching-service');
            const stillOwnsLaunch = launchEpoch === this.launchEpoch;
            if (!succeeded && stillOwnsLaunch) {
                this.activeAdapter = null;
                this.activeService = null;
                this.launchingButton = null;
                this.activeLaunchController = null;
                this.activeLaunchId = null;
                this.setCatalogLocked(false);
            }
            // On success the catalog intentionally remains locked until closeActiveService().
            // If Back cancelled the launch, closeActiveService() owns final cleanup instead.
        }
    }

    /**
     * Closes the currently active WebView using the APK back transition, then
     * deletes the Cloudflare session without exposing the Home screen mid-frame.
     */
    async closeActiveService() {
        if (!this.activeAdapter && !this.launchLocked && !this.activeLaunchId) return;

        // Invalidate the async launch pipeline first. AbortController stops the browser
        // request immediately; the explicit launch cancel endpoint aborts matching
        // nxapi/Nintendo fetches inside the launch-scoped Durable Object as well.
        this.launchEpoch++;
        const launchId = this.activeLaunchId;
        const launchController = this.activeLaunchController;
        if (launchController && !launchController.signal.aborted) launchController.abort();
        
        if (this.launchTransitionTimer) {
            clearTimeout(this.launchTransitionTimer);
            this.launchTransitionTimer = null;
        }
        if (this.loadingFallbackTimer) {
            clearTimeout(this.loadingFallbackTimer);
            this.loadingFallbackTimer = null;
        }

        const overlay = document.getElementById('inAppGameWebview');
        const surfaces = this.getLaunchBackgroundSurfaces();

        // Removing the frame cancels the Nintendo document/subresource waterfall
        // immediately without navigating through inherited about:blank.
        this.destroyServiceFrame();
        document.getElementById('gwsNativeLoading')?.classList.add('hidden');

        document.documentElement.classList.remove('webview-active');
        document.body.classList.remove('webview-active');
        document.documentElement.classList.add('gws-transition-active');
        document.body.classList.add('gws-transition-active');

        this.clearLaunchTransitionClasses();
        surfaces.forEach((surface) => {
            surface.classList.add('nso-apk-transition-background', 'nso-apk-back-enter');
        });
        overlay?.classList.add('nso-apk-transition-foreground', 'nso-apk-back-exit');

        const adapter = this.activeAdapter;
        // The Worker cancel route clears the launch/session and cookies. Drop the local
        // adapter handle now so a late session-create response cannot resurrect the WebView.
        if (adapter?.currentSession) adapter.currentSession = null;

        await new Promise((resolve) => setTimeout(resolve, 430));
        this.clearLaunchTransitionClasses();
        overlay?.classList.add('hidden');

        document.documentElement.classList.remove('gws-transition-active');
        document.body.classList.remove('gws-transition-active');

                this.activeAdapter = null;
        this.activeService = null;
        this.launchingButton = null;
        this.activeLaunchController = null;
        this.activeLaunchId = null;
        this.setCatalogLocked(false);
    }

    /**
     * Reloads the active WebView iframe.
     */
    reloadActiveService() {
        const frame = document.getElementById('inAppGameWebviewFrame');
        if (frame) {
            try {
                frame.contentWindow?.location.reload();
            } catch (e) {
                frame.src = frame.src;
            }
        }
    }

    /**
     * Controlled postMessage listener between proxied Nintendo iframe and nso-webapp.
     */
    initPostMessageListener() {
        window.addEventListener('message', async (event) => {
            const workerOrigin = new URL(this.getWorkerUrl()).origin;
            if (event.origin !== workerOrigin) return;

            const data = event.data;
            if (!data || typeof data !== 'object') return;

            const frame = document.getElementById('inAppGameWebviewFrame');
            const activeSessionId = this.activeAdapter?.currentSession?.id ? String(this.activeAdapter.currentSession.id) : '';
            const messageSessionId = data.sessionId ? String(data.sessionId) : '';
            const activeServiceId = this.activeService?.id ? String(this.activeService.id) : '';
            const messageServiceId = data.serviceId ? String(data.serviceId) : '';

            // Every Worker bridge message is scoped to the exact iframe session that
            // emitted it. Once Back is pressed currentSession is cleared immediately,
            // so queued/late callbacks from the dying document are silently discarded.
            if (!frame?.contentWindow || event.source !== frame.contentWindow) return;
            if (!activeSessionId || !messageSessionId || messageSessionId !== activeSessionId) return;
            if (activeServiceId && messageServiceId && activeServiceId !== messageServiceId) return;

            // 1. Fresh GameWebServiceToken request (e.g. Zelda Notes func_272e)
            if (data.type === 'NSO_REQUEST_GAME_WEB_TOKEN') {
                const serviceId = data.serviceId || this.activeService?.id;
                const requestSessionId = activeSessionId;
                const requestLaunchId = this.activeLaunchId;
                const requestController = this.activeLaunchController;
                const sessionStillActive = () => Boolean(
                    this.activeAdapter?.currentSession?.id &&
                    String(this.activeAdapter.currentSession.id) === requestSessionId &&
                    this.activeLaunchId === requestLaunchId &&
                    !requestController?.signal?.aborted
                );

                try {
                    
                    const freshToken = await this.getGameWebServiceToken(serviceId, undefined, false, {
                        signal: requestController?.signal,
                        cancelKey: requestLaunchId
                    });
                    if (!sessionStillActive()) return;

                    // Update Worker/DO session only while this exact WebView is alive.
                    await this.activeAdapter.renewToken(freshToken, { signal: requestController?.signal });
                    if (!sessionStillActive()) return;

                    // Send fresh token back only to the document that requested it.
                    frame.contentWindow.postMessage({
                        type: 'NSO_RECEIVE_GAME_WEB_TOKEN',
                        requestId: data.requestId,
                        token: freshToken,
                        isZelda: data.isZelda === true
                    }, workerOrigin);
                } catch (err) {
                    if (!sessionStillActive() || this.isLaunchCancellation(err)) return;
                    console.error('[WebServiceManager] Token renewal failed:', err);
                    frame.contentWindow.postMessage({
                        type: 'NSO_RECEIVE_GAME_WEB_TOKEN',
                        requestId: data.requestId,
                        token: null,
                        isZelda: data.isZelda === true,
                        error: err.message
                    }, workerOrigin);
                }
                return;
            }

            // 2. Close WebView
            if (data.type === 'NSO_CLOSE_WEBVIEW') {
                this.closeActiveService();
                return;
            }

            // 3. Complete Loading
            if (data.type === 'NSO_COMPLETE_LOADING') {
                if (this.launchingButton) {
                    this.launchingButton.closest('.service-launch-card')?.classList.remove('launching-service');
                }
                this.markServiceLoaded();
                return;
            }

            // 4. Native Share
            if (data.type === 'NSO_NATIVE_SHARE' || data.type === 'NSO_NATIVE_SHARE_URL') {
                if (navigator.share) {
                    navigator.share({
                        title: data.text || 'Nintendo Switch Online',
                        text: data.text || '',
                        url: data.url || data.image_url || undefined
                    }).catch(() => {});
                }
                return;
            }

            // 5. Open External Browser
            if (data.type === 'NSO_OPEN_EXTERNAL_BROWSER' && data.url) {
                try {
                    const target = new URL(data.url);
                    if (['http:', 'https:'].includes(target.protocol)) {
                        window.open(target.href, '_blank', 'noopener,noreferrer');
                    }
                } catch (e) {}
                return;
            }

            // 6. Copy to Clipboard
            if (data.type === 'NSO_COPY_TO_CLIPBOARD' && data.text) {
                if (navigator.clipboard) {
                    navigator.clipboard.writeText(String(data.text)).catch(() => {});
                }
                return;
            }

            // 7. Send Message (NookLink B_SHOW_SUCCESS, B_SHOW_ERROR, B_SET_INDEX)
            if (data.type === 'NSO_SEND_MESSAGE' && data.data) {
                try {
                    const parsed = typeof data.data === 'string' ? JSON.parse(data.data) : data.data;
                    
                    if (parsed?.type === 'B_SHOW_SUCCESS' && parsed?.message) {
                        
                    } else if (parsed?.type === 'B_SHOW_ERROR' && parsed?.message) {
                        console.warn('[NookLink:Error]', parsed.message);
                    }
                } catch (e) {}
                return;
            }
        });
    }
}

// Global Singleton Instance
window.webServiceManager = new WebServiceManager();
