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
        this.SMASHWORLD_ID = '5614999764533248';

        this.genericAdapter = new GenericWebViewAdapter(this);
        this.zeldaNotesAdapter = new ZeldaNotesAdapter(this);
        this.splatnet3Adapter = new SplatNet3QuirksAdapter(this);
        this.nooklinkAdapter = new NookLinkQuirksAdapter(this);
        this.splatnet2Adapter = new SplatNet2QuirksAdapter(this);
        this.smashWorldAdapter = new SmashWorldQuirksAdapter(this);

        this.activeAdapter = null;
        this.activeService = null;
        this.launchingButton = null;

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
        if (idStr === this.SMASHWORLD_ID || uri.includes('smashworld.nintendo.net')) {
            return this.smashWorldAdapter;
        }
        if (name.includes('zelda') || uri.includes('zelda')) {
            return this.zeldaNotesAdapter;
        }

        // Generic fallback for any future or catalog service
        return this.genericAdapter;
    }

    /**
     * Canonical GameWebServiceToken acquisition function.
     * Executes Coral method-2 /f attestation and calls /v4/Game/GetWebServiceToken.
     */
    async getGameWebServiceToken(serviceId, traceId) {
        const token = coralAccessToken();
        if (!token) throw new Error('No Coral access token available. Please sign in again.');

        const naId = userSession?.nsoWebapp?.naId;
        if (!naId) {
            throw new Error('Nintendo Account ID missing in session. Please sign out and sign in again.');
        }

        const coralUserId = String(userSession?.result?.user?.id || userSession?.user?.id || '');

        const fStart = performance.now();
        const attestation = await nxapiGenerateF(2, token, {
            na_id: naId,
            coral_user_id: coralUserId
        });
        const fDuration = Math.round(performance.now() - fStart);
        console.log(`[LaunchTrace:${traceId || 'anon'}] stage=nxapi_f_method_2 durationMs=${fDuration}`);

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

        return result.accessToken;
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
        const overlay = document.getElementById('inAppGameWebview');
        const frame = document.getElementById('inAppGameWebviewFrame');

        if (overlay) overlay.classList.add('hidden');
        if (frame) frame.src = 'about:blank';

        if (this.activeAdapter) {
            await this.activeAdapter.close();
            this.activeAdapter = null;
            this.activeService = null;
        }
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
        });
    }
}

// Global Singleton Instance
window.webServiceManager = new WebServiceManager();
