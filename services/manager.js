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

    getCachedGameWebServiceToken(serviceId) {
        const idStr = String(serviceId);
        const cached = this.tokenCache.get(idStr);
        if (cached && cached.expiresAt > Date.now() + 60000) return cached.token;
        if (cached) this.tokenCache.delete(idStr);
        return null;
    }

    /**
     * Canonical, on-demand GameWebServiceToken acquisition.
     *
     * This intentionally does not prime every service in the catalog and does not
     * acquire nxapi credentials in the background. One method-2 attestation is
     * requested only when the user actually opens a service, matching the stable
     * pre-optimization behavior and greatly reducing nxapi rate-limit pressure.
     * Valid Nintendo web-service tokens are still cached in memory and concurrent
     * requests for the same service remain single-flight.
     */
    async getGameWebServiceToken(serviceId, traceId, forceFresh = false, options = {}) {
        const idStr = String(serviceId);
        if (!forceFresh) {
            const cached = this.getCachedGameWebServiceToken(idStr);
            if (cached) {
                console.log(`[LaunchTrace:${traceId || 'anon'}] Reusing active GameWebServiceToken for service ${idStr}`);
                return cached;
            }
        }

        const existingFlight = this.tokenInFlight.get(idStr);
        if (existingFlight) {
            const sameLaunch = !options.cancelKey || !existingFlight.cancelKey || existingFlight.cancelKey === options.cancelKey;
            if (sameLaunch) {
                console.log(`[LaunchTrace:${traceId || 'anon'}] Deduplicating concurrent token request for service ${idStr}`);
                return await existingFlight.promise;
            }
            // A cancelled launch may still be unwinding for a few milliseconds. Never
            // attach a new click to that old AbortSignal/cancellation key.
            console.log(`[LaunchTrace:${traceId || 'anon'}] Ignoring stale token flight for service ${idStr}`);
        }

        const fetchPromise = (async () => {
            const token = coralAccessToken();
            if (!token) throw new Error('No Coral access token available. Please sign in again.');

            const naId = userSession?.nsoWebapp?.naId;
            if (!naId) {
                throw new Error('Nintendo Account ID missing in session. Please sign out and sign in again.');
            }
            const coralUserId = String(userSession?.result?.user?.id || userSession?.user?.id || '');

            if (options.signal?.aborted) throw new DOMException('The operation was aborted.', 'AbortError');
            const fStartedAt = performance.now();
            const attestation = await nxapiGenerateF(2, token, {
                na_id: naId,
                coral_user_id: coralUserId
            }, {
                signal: options.signal,
                cancelKey: options.cancelKey
            });
            console.log(`[LaunchTrace:${traceId || 'anon'}] stage=nxapi_f_method_2 source=on_demand durationMs=${Math.round(performance.now() - fStartedAt)}`);

            const tokenStart = performance.now();
            if (options.signal?.aborted) throw new DOMException('The operation was aborted.', 'AbortError');
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
            console.log(`[LaunchTrace:${traceId || 'anon'}] stage=get_web_service_token durationMs=${Math.round(performance.now() - tokenStart)} path=canonical`);

            if (!result?.accessToken) {
                throw new Error('Nintendo did not return a valid GameWebServiceToken.');
            }

            const expiresInSec = Number.isFinite(Number(result.expiresIn)) ? Number(result.expiresIn) : 7200;
            this.tokenCache.set(idStr, {
                token: result.accessToken,
                expiresAt: Date.now() + Math.max(60, expiresInSec) * 1000
            });
            return result.accessToken;
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

    async cancelCloudflareLaunch(launchId) {
        if (!launchId) return;
        if (this.cancelInFlight?.launchId === launchId) return this.cancelInFlight.promise;

        const promise = fetch(`${this.getWorkerUrl()}/api/nso/service/launch/${encodeURIComponent(launchId)}/cancel`, {
            method: 'POST',
            credentials: 'include',
            headers: { Accept: 'application/json' }
        }).then(async (response) => {
            if (!response.ok) {
                let detail = '';
                try { detail = (await response.json())?.error || ''; } catch (e) {}
                throw new Error(detail || `Cloudflare launch cancellation failed (HTTP ${response.status}).`);
            }
        }).catch((error) => {
            // The local AbortController and iframe teardown already stop browser-side work.
            // Keep this warning visible because the explicit Worker/DO cancellation is what
            // guarantees an already-running nxapi/Nintendo fetch is aborted server-side.
            console.warn('[WebServiceManager] Cloudflare launch cancellation warning:', error);
        }).finally(() => {
            if (this.cancelInFlight?.launchId === launchId) this.cancelInFlight = null;
        });

        this.cancelInFlight = { launchId, promise };
        return promise;
    }

    setCatalogLocked(locked, activeButton = null) {
        this.launchLocked = Boolean(locked);
        const catalog = document.getElementById('gameServicesCatalog');
        catalog?.classList.toggle('launch-locked', this.launchLocked);

        document.querySelectorAll('#gameServicesCatalog .service-launch-card button').forEach((button) => {
            if (!button.dataset.nsoOriginalText) button.dataset.nsoOriginalText = button.textContent || 'Connect';
            button.disabled = this.launchLocked;
            if (button === activeButton && this.launchLocked) button.textContent = 'Connecting…';
            else button.textContent = button.dataset.nsoOriginalText || 'Connect';
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
                <strong class="gws-native-loading-title">${this.escapeText(service?.name || 'Game Service')}</strong>
            </div>`;
        loading.classList.remove('hidden', 'is-complete');
        return loading;
    }

    escapeText(value) {
        const div = document.createElement('div');
        div.textContent = String(value ?? '');
        return div.innerHTML;
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
        const frame = document.getElementById('inAppGameWebviewFrame');
        if (title) title.textContent = service?.name || 'Game Service';
        if (frame) frame.src = 'about:blank';
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
        loading.classList.add('is-complete');
        if (this.loadingFallbackTimer) {
            clearTimeout(this.loadingFallbackTimer);
            this.loadingFallbackTimer = null;
        }
        setTimeout(() => loading.classList.add('hidden'), 140);
    }

    installLoadFallback() {
        if (this.loadingFallbackTimer) clearTimeout(this.loadingFallbackTimer);
        // completeLoading from znca-js-api is authoritative. This only prevents a
        // permanently covered page if an old service never calls that bridge method.
        this.loadingFallbackTimer = setTimeout(() => {
            this.loadingFallbackTimer = null;
            this.markServiceLoaded();
        }, 12000);
    }

    async cancelNativeServiceLaunch() {
        if (this.launchTransitionTimer) {
            clearTimeout(this.launchTransitionTimer);
            this.launchTransitionTimer = null;
        }

        const overlay = document.getElementById('inAppGameWebview');
        const surfaces = this.getLaunchBackgroundSurfaces();
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
            console.log(`[LaunchTrace:${traceId}] Launching ${service.name || 'Game Service'} via ${adapter.constructor.name} launchId=${launchId}`);
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
            console.log(`[LaunchTrace:${traceId}] stage=webview_session_create durationMs=${sessionDuration}`);

            this.installLoadFallback();
            succeeded = true;
            const totalDuration = Math.round(performance.now() - overallStart);
            console.log(`[LaunchTrace:${traceId}] stage=total_launch durationMs=${totalDuration}`);
        } catch (e) {
            const cancelled = this.isLaunchCancellation(e) || launchController.signal.aborted || launchEpoch !== this.launchEpoch;
            if (!cancelled) {
                console.error(`[LaunchTrace:${traceId}] Launch failed:`, e);
                launchController.abort();
                await this.cancelCloudflareLaunch(launchId);
                await this.cancelNativeServiceLaunch();
                alert(`Could not open ${service.name || 'service'}: ${e.message}`);
            } else {
                console.log(`[LaunchTrace:${traceId}] launch_cancelled`);
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
        const cloudflareCancel = this.cancelCloudflareLaunch(launchId);

        if (this.launchTransitionTimer) {
            clearTimeout(this.launchTransitionTimer);
            this.launchTransitionTimer = null;
        }
        if (this.loadingFallbackTimer) {
            clearTimeout(this.loadingFallbackTimer);
            this.loadingFallbackTimer = null;
        }

        const overlay = document.getElementById('inAppGameWebview');
        const frame = document.getElementById('inAppGameWebviewFrame');
        const surfaces = this.getLaunchBackgroundSurfaces();

        // about:blank is set at the instant Back is pressed so the browser cancels
        // the Nintendo document/subresource waterfall instead of continuing it behind
        // the 400 ms APK-style back animation.
        if (frame) frame.src = 'about:blank';
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

        await cloudflareCancel;
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

            // 1. Fresh GameWebServiceToken request (e.g. Zelda Notes func_272e)
            if (data.type === 'NSO_REQUEST_GAME_WEB_TOKEN') {
                const serviceId = data.serviceId || this.activeService?.id;
                try {
                    console.log(`[WebServiceManager] Received fresh token request for service ${serviceId}`);
                    const freshToken = await this.getGameWebServiceToken(serviceId, undefined, false, {
                        signal: this.activeLaunchController?.signal,
                        cancelKey: this.activeLaunchId
                    });

                    // Update Worker/DO session
                    if (this.activeAdapter) {
                        await this.activeAdapter.renewToken(freshToken, { signal: this.activeLaunchController?.signal });
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
