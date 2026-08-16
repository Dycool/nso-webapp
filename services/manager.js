/**
 * WebServiceManager
 * Central orchestration layer for Nintendo Switch Online Game Web Services.
 * Handles adapter selection, canonical GameWebServiceToken acquisition,
 * Durable Object session management, and the controlled postMessage bridge protocol.
 */

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

        // Method-2 attestations are expensive on the public nxapi service. Keep one
        // short-lived, one-shot attestation in memory so the user's first service
        // launch usually does not sit behind the full f-generation round trip.
        // Nothing here is persisted to localStorage/sessionStorage.
        this.method2WarmAttestation = null;
        this.method2WarmPromise = null;
        this.method2WarmTtlMs = 25000;
        this.prewarmTimer = null;
        this.prewarmObserver = null;

        this.initPostMessageListener();
        this.initAttestationPrewarm();
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

    getMethod2Context() {
        const token = coralAccessToken();
        const naId = userSession?.nsoWebapp?.naId;
        const coralUserId = String(userSession?.result?.user?.id || userSession?.user?.id || '');
        if (!token || !naId) return null;
        return { token, naId, coralUserId };
    }

    sameMethod2Context(a, b) {
        return Boolean(a && b &&
            a.token === b.token &&
            a.naId === b.naId &&
            a.coralUserId === b.coralUserId);
    }

    hasFreshWarmAttestation(context) {
        const warm = this.method2WarmAttestation;
        return Boolean(warm &&
            this.sameMethod2Context(warm.context, context) &&
            Date.now() - warm.createdAt <= this.method2WarmTtlMs);
    }

    async warmGameWebServiceAttestation() {
        const context = this.getMethod2Context();
        if (!context || document.hidden || document.documentElement.classList.contains('webview-active')) return null;
        if (this.hasFreshWarmAttestation(context)) {
            return this.method2WarmAttestation.attestation;
        }
        if (this.method2WarmPromise) return this.method2WarmPromise;

        this.method2WarmPromise = (async () => {
            try {
                const attestation = await nxapiGenerateF(2, context.token, {
                    na_id: context.naId,
                    coral_user_id: context.coralUserId
                });

                const currentContext = this.getMethod2Context();
                if (this.sameMethod2Context(currentContext, context)) {
                    this.method2WarmAttestation = {
                        context,
                        attestation,
                        createdAt: Date.now()
                    };
                }
                return attestation;
            } catch (error) {
                // Background prewarming must never break sign-in or the service catalog.
                return null;
            } finally {
                this.method2WarmPromise = null;
            }
        })();

        return this.method2WarmPromise;
    }

    async consumeMethod2Attestation(traceId, context) {
        const consumeWarm = () => {
            if (!this.hasFreshWarmAttestation(context)) return null;
            const warm = this.method2WarmAttestation;
            this.method2WarmAttestation = null; // one-shot: never reuse an f result
            const ageMs = Date.now() - warm.createdAt;
            console.log(`[LaunchTrace:${traceId || 'anon'}] stage=nxapi_f_method_2 source=prewarmed durationMs=0 ageMs=${ageMs}`);
            return warm.attestation;
        };

        let warm = consumeWarm();
        if (warm) return warm;

        // If the idle prewarm is already running, join it instead of starting a
        // duplicate f request. This is the main latency win for quick clicks.
        if (this.method2WarmPromise) {
            await this.method2WarmPromise;
            warm = consumeWarm();
            if (warm) return warm;
        }

        const startedAt = performance.now();
        const attestation = await nxapiGenerateF(2, context.token, {
            na_id: context.naId,
            coral_user_id: context.coralUserId
        });
        console.log(`[LaunchTrace:${traceId || 'anon'}] stage=nxapi_f_method_2 source=live durationMs=${Math.round(performance.now() - startedAt)}`);
        return attestation;
    }

    scheduleAttestationPrewarm(delayMs = 0) {
        if (this.prewarmTimer) clearTimeout(this.prewarmTimer);
        this.prewarmTimer = setTimeout(() => {
            this.prewarmTimer = null;
            if (document.hidden) return;

            const run = () => this.warmGameWebServiceAttestation();
            if (typeof window.requestIdleCallback === 'function') {
                window.requestIdleCallback(run, { timeout: 1800 });
            } else {
                setTimeout(run, 0);
            }
        }, Math.max(0, delayMs));
    }

    initAttestationPrewarm() {
        const install = () => {
            const catalog = document.getElementById('gameServicesCatalog');
            if (!catalog) return;

            const kickIfReady = () => {
                if (catalog.querySelector('.service-launch-card')) {
                    this.scheduleAttestationPrewarm(350);
                }
            };

            this.prewarmObserver = new MutationObserver(kickIfReady);
            this.prewarmObserver.observe(catalog, { childList: true, subtree: true });

            // Also warm on intent. These calls are deduplicated and a fresh warm
            // attestation is kept only once, in memory, for 25 seconds.
            catalog.addEventListener('pointerenter', () => this.warmGameWebServiceAttestation(), { passive: true });
            catalog.addEventListener('focusin', () => this.warmGameWebServiceAttestation());
            catalog.addEventListener('touchstart', () => this.warmGameWebServiceAttestation(), { passive: true, once: true });
            document.addEventListener('visibilitychange', () => {
                if (!document.hidden) kickIfReady();
            });
            kickIfReady();
        };

        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', install, { once: true });
        } else {
            install();
        }
    }

    /**
     * Canonical GameWebServiceToken acquisition function.
     * Executes Coral method-2 /f attestation and calls /v4/Game/GetWebServiceToken.
     * Caches valid tokens and deduplicates concurrent in-flight requests.
     */
    async getGameWebServiceToken(serviceId, traceId, forceFresh = false) {
        const idStr = String(serviceId);
        if (!forceFresh && this.tokenCache.has(idStr)) {
            const cached = this.tokenCache.get(idStr);
            if (cached && cached.expiresAt > Date.now() + 60000) {
                console.log(`[LaunchTrace:${traceId || 'anon'}] Reusing active GameWebServiceToken for service ${idStr}`);
                return cached.token;
            }
        }

        if (this.tokenInFlight.has(idStr)) {
            console.log(`[LaunchTrace:${traceId || 'anon'}] Deduplicating concurrent token request for service ${idStr}`);
            return await this.tokenInFlight.get(idStr);
        }

        const fetchPromise = (async () => {
            const token = coralAccessToken();
            if (!token) throw new Error('No Coral access token available. Please sign in again.');

            const naId = userSession?.nsoWebapp?.naId;
            if (!naId) {
                throw new Error('Nintendo Account ID missing in session. Please sign out and sign in again.');
            }

            const coralUserId = String(userSession?.result?.user?.id || userSession?.user?.id || '');

            const attestation = await this.consumeMethod2Attestation(traceId, {
                token,
                naId,
                coralUserId
            });

            const tokenStart = performance.now();
            const result = await coralCall('/v4/Game/GetWebServiceToken', {
                id: Number(serviceId),
                registrationToken: '',
                f: attestation.f,
                timestamp: attestation.timestamp,
                requestId: attestation.requestId
            });
            const tokenDuration = Math.round(performance.now() - tokenStart);
            console.log(`[LaunchTrace:${traceId || 'anon'}] stage=get_web_service_token durationMs=${tokenDuration}`);

            if (!result?.accessToken) {
                throw new Error('Nintendo did not return a valid GameWebServiceToken.');
            }

            const expiresInSec = typeof result.expiresIn === 'number' ? result.expiresIn : 7200;
            this.tokenCache.set(idStr, {
                token: result.accessToken,
                expiresAt: Date.now() + expiresInSec * 1000
            });

            return result.accessToken;
        })();

        this.tokenInFlight.set(idStr, fetchPromise);
        try {
            return await fetchPromise;
        } finally {
            this.tokenInFlight.delete(idStr);
        }
    }

    /**
     * Launch a selected game service.
     */
    async launchService(service, buttonElement) {
        if (!service) return;
        const adapter = this.getAdapter(service);
        this.activeAdapter = adapter;
        this.activeService = service;
        this.launchingButton = buttonElement;

        const traceId = 'tr_' + Math.random().toString(36).slice(2, 8);
        const overallStart = performance.now();

        let originalText = '';
        const card = buttonElement?.closest('.service-launch-card');
        if (buttonElement) {
            originalText = buttonElement.textContent;
            buttonElement.disabled = true;
            buttonElement.textContent = 'Connecting…';
            card?.classList.add('launching-service');
        }

        try {
            console.log(`[LaunchTrace:${traceId}] Launching ${service.name || 'Game Service'} via ${adapter.constructor.name}`);
            const token = await this.getGameWebServiceToken(service.id, traceId);

            const userProfile = userSession?.result?.user || userSession?.user;
            const language = userProfile?.language || 'en-GB';
            const country = userProfile?.country || 'GB';

            const sessionStart = performance.now();
            await adapter.launch(service, token, { language, country });
            const sessionDuration = Math.round(performance.now() - sessionStart);
            console.log(`[LaunchTrace:${traceId}] stage=webview_session_create durationMs=${sessionDuration}`);

            const totalDuration = Math.round(performance.now() - overallStart);
            console.log(`[LaunchTrace:${traceId}] stage=total_launch durationMs=${totalDuration}`);
        } catch (e) {
            console.error(`[LaunchTrace:${traceId}] Launch failed:`, e);
            alert(`Could not open ${service.name || 'service'}: ${e.message}`);
        } finally {
            if (buttonElement) {
                buttonElement.disabled = false;
                buttonElement.textContent = originalText || 'Connect';
                card?.classList.remove('launching-service');
            }
        }
    }

    /**
     * Closes the currently active WebView overlay and deletes the session in the DO.
     */
    async closeActiveService() {
        document.documentElement.classList.remove('webview-active');
        document.body.classList.remove('webview-active');
        const overlay = document.getElementById('inAppGameWebview');
        const frame = document.getElementById('inAppGameWebviewFrame');

        if (overlay) overlay.classList.add('hidden');
        if (frame) frame.src = 'about:blank';

        if (this.activeAdapter) {
            await this.activeAdapter.close();
            this.activeAdapter = null;
            this.activeService = null;
        }

        // Returning from a WebView is the best moment to prepare the next service
        // launch without blocking the UI.
        this.scheduleAttestationPrewarm(350);
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

            // 1. Fresh GameWebServiceToken request (e.g. Zelda Notes func_272e)
            if (data.type === 'NSO_REQUEST_GAME_WEB_TOKEN') {
                const serviceId = data.serviceId || this.activeService?.id;
                try {
                    console.log(`[WebServiceManager] Received fresh token request for service ${serviceId}`);
                    const freshToken = await this.getGameWebServiceToken(serviceId);

                    // Update Worker/DO session
                    if (this.activeAdapter) {
                        await this.activeAdapter.renewToken(freshToken);
                    }

                    // Send fresh token back into isolated iframe context
                    if (frame?.contentWindow) {
                        frame.contentWindow.postMessage({
                            type: 'NSO_RECEIVE_GAME_WEB_TOKEN',
                            requestId: data.requestId,
                            token: freshToken,
                            isZelda: data.isZelda === true
                        }, workerOrigin);
                    }
                } catch (err) {
                    console.error('[WebServiceManager] Token renewal failed:', err);
                    if (frame?.contentWindow) {
                        frame.contentWindow.postMessage({
                            type: 'NSO_RECEIVE_GAME_WEB_TOKEN',
                            requestId: data.requestId,
                            token: null,
                            isZelda: data.isZelda === true,
                            error: err.message
                        }, workerOrigin);
                    }
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
                    console.log('[WebServiceManager:sendMessage]', parsed?.type, parsed?.message);
                    if (parsed?.type === 'B_SHOW_SUCCESS' && parsed?.message) {
                        console.info('[NookLink:Success]', parsed.message);
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
