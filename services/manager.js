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
        this.catalogServices = [];
        this.catalogPrimeTimer = null;
        this.catalogPrimeRunning = false;
        this.intentPrimeTimers = new Map();
        this.loadingFallbackTimer = null;

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
        const consumeWarm = (source = 'prewarmed', durationMs = 0) => {
            if (!this.hasFreshWarmAttestation(context)) return null;
            const warm = this.method2WarmAttestation;
            this.method2WarmAttestation = null; // one-shot: never reuse an f result
            const ageMs = Date.now() - warm.createdAt;
            console.log(`[LaunchTrace:${traceId || 'anon'}] stage=nxapi_f_method_2 source=${source} durationMs=${durationMs} ageMs=${ageMs}`);
            return warm.attestation;
        };

        let warm = consumeWarm();
        if (warm) return warm;

        // Join a prewarm already in flight instead of sending a duplicate request.
        // Report the actual wait time so total launch traces are no longer misleading.
        if (this.method2WarmPromise) {
            const waitStartedAt = performance.now();
            await this.method2WarmPromise;
            warm = consumeWarm('prewarm_join', Math.round(performance.now() - waitStartedAt));
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
                    this.scheduleAttestationPrewarm(0);
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

    getCachedGameWebServiceToken(serviceId) {
        const idStr = String(serviceId);
        const cached = this.tokenCache.get(idStr);
        if (cached && cached.expiresAt > Date.now() + 60000) return cached.token;
        if (cached) this.tokenCache.delete(idStr);
        return null;
    }

    /**
     * Mirrors nxapi's own CoralApi#getWebServiceToken fast path. The browser's
     * existing in-memory nxapi bearer is passed to the Worker for this request
     * only. Cloudflare never persists Nintendo or nxapi credentials.
     *
     * When a prewarmed f result exists we send it and the Worker performs only
     * encrypt-request -> Nintendo -> decrypt-response. Otherwise the Worker asks
     * nxapi for f + encrypted_token_request in one request, exactly like nxapi.
     */
    async requestOptimizedGameWebServiceToken(serviceId, traceId, attestation = null, retryAuth = true) {
        const coralToken = coralAccessToken();
        if (!coralToken) throw new Error('No Coral access token available. Please sign in again.');

        const naId = userSession?.nsoWebapp?.naId;
        if (!naId) {
            throw new Error('Nintendo Account ID missing in session. Please sign out and sign in again.');
        }
        const coralUserId = String(userSession?.result?.user?.id || userSession?.user?.id || '');

        const nxapiAccessToken = await getNxapiAccessToken();
        const startedAt = performance.now();
        const response = await fetch(`${this.getWorkerUrl()}/api/nso/service/token`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Accept: 'application/json'
            },
            body: JSON.stringify({
                serviceId: String(serviceId),
                coralAccessToken: coralToken,
                nxapiAccessToken,
                naId: String(naId),
                coralUserId,
                zncaVersion: typeof ZNCA_VERSION === 'string' ? ZNCA_VERSION : undefined,
                attestation: attestation ? {
                    f: attestation.f,
                    timestamp: Number(attestation.timestamp),
                    requestId: String(attestation.requestId)
                } : undefined
            })
        });

        let data = {};
        try { data = await response.json(); } catch (e) {}

        if (response.status === 401 && data?.error === 'nxapi_invalid_token' && retryAuth) {
            // nxapi access tokens are memory-only. Drop the expired bearer and retry
            // once through the normal single-flight OAuth acquisition path.
            try {
                nxapiAuthSession = { accessToken: null, refreshToken: null, expiresAt: 0 };
            } catch (e) {}
            return this.requestOptimizedGameWebServiceToken(serviceId, traceId, attestation, false);
        }

        if (!response.ok || !data?.accessToken) {
            const message = data?.error_description || data?.error ||
                `Optimized GameWebServiceToken request failed (HTTP ${response.status}).`;
            if (response.status === 429 && typeof parseRetryAfter === 'function' && typeof setRateLimitUntil === 'function') {
                const until = parseRetryAfter(response.headers.get('Retry-After')) || (Date.now() + 60000);
                setRateLimitUntil(until);
            }
            const error = new Error(message);
            error.status = response.status;
            error.code = data?.error || null;
            throw error;
        }

        const durationMs = Math.round(performance.now() - startedAt);
        console.log(
            `[LaunchTrace:${traceId || 'anon'}] stage=get_web_service_token durationMs=${durationMs} ` +
            `path=${attestation ? 'prewarmed_worker' : 'nxapi_combined_worker'}`
        );

        return {
            accessToken: data.accessToken,
            expiresIn: Number(data.expiresIn || 7200)
        };
    }

    /**
     * Canonical GameWebServiceToken acquisition.
     * Valid tokens are cached in memory for their Nintendo lifetime and concurrent
     * requests for the same service are single-flight.
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

        if (this.tokenInFlight.has(idStr)) {
            console.log(`[LaunchTrace:${traceId || 'anon'}] Deduplicating concurrent token request for service ${idStr}`);
            return await this.tokenInFlight.get(idStr);
        }

        const fetchPromise = (async () => {
            const context = this.getMethod2Context();
            if (!context) throw new Error('Nintendo account session is incomplete. Please sign in again.');

            let attestation = null;
            const canUseWarm = options.useWarmAttestation !== false &&
                (this.hasFreshWarmAttestation(context) || Boolean(this.method2WarmPromise));

            if (canUseWarm) {
                attestation = await this.consumeMethod2Attestation(traceId, context);
            }

            const result = await this.requestOptimizedGameWebServiceToken(
                serviceId,
                traceId,
                attestation
            );

            const expiresInSec = Number.isFinite(result.expiresIn) ? result.expiresIn : 7200;
            this.tokenCache.set(idStr, {
                token: result.accessToken,
                expiresAt: Date.now() + Math.max(60, expiresInSec) * 1000
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

    registerCatalogServices(services) {
        this.catalogServices = Array.isArray(services) ? services.filter((service) => service?.id) : [];

        const catalog = document.getElementById('gameServicesCatalog');
        if (catalog) {
            catalog.querySelectorAll('.service-launch-card').forEach((card) => {
                if (card.dataset.nsoPrimeBound === 'true') return;
                card.dataset.nsoPrimeBound = 'true';
                const service = this.catalogServices.find((item) => String(item.id) === String(card.dataset.serviceId));
                if (!service) return;

                const intent = () => this.scheduleIntentPrime(service);
                card.addEventListener('pointerenter', intent, { passive: true });
                card.addEventListener('focusin', intent);
                card.addEventListener('touchstart', intent, { passive: true });
            });
        }

        // The first method-2 attestation is already warming at login. Keep it
        // reserved for an actual user gesture for a short window, then spend it
        // priming service tokens in the background. Once primed, a click requires
        // no f generation and no GameWebServiceToken network request at all.
        this.scheduleCatalogPrime(12000);
    }

    scheduleIntentPrime(service) {
        if (!service?.id || this.launchLocked || this.getCachedGameWebServiceToken(service.id)) return;
        const id = String(service.id);
        if (this.intentPrimeTimers.has(id)) return;

        const timer = setTimeout(() => {
            this.intentPrimeTimers.delete(id);
            if (this.launchLocked || document.documentElement.classList.contains('webview-active')) return;
            this.getGameWebServiceToken(service.id, `intent_${id}`, false, { useWarmAttestation: true })
                .catch(() => {});
        }, 80);
        this.intentPrimeTimers.set(id, timer);
    }

    scheduleCatalogPrime(delayMs = 12000) {
        if (this.catalogPrimeTimer) clearTimeout(this.catalogPrimeTimer);
        if (!this.catalogServices.length) return;
        this.catalogPrimeTimer = setTimeout(() => {
            this.catalogPrimeTimer = null;
            this.primeCatalogTokens().catch(() => {});
        }, Math.max(0, delayMs));
    }

    async primeCatalogTokens() {
        if (this.catalogPrimeRunning || !this.catalogServices.length) return;
        if (this.launchLocked || document.hidden || document.documentElement.classList.contains('webview-active')) {
            this.scheduleCatalogPrime(8000);
            return;
        }

        this.catalogPrimeRunning = true;
        try {
            let firstUncached = true;
            for (const service of this.catalogServices) {
                if (this.launchLocked || document.hidden || document.documentElement.classList.contains('webview-active')) break;
                if (this.getCachedGameWebServiceToken(service.id)) continue;

                try {
                    await this.getGameWebServiceToken(
                        service.id,
                        `prime_${String(service.id)}`,
                        false,
                        { useWarmAttestation: firstUncached }
                    );
                } catch (error) {
                    // Background token priming is best-effort and must never affect
                    // the visible service catalog or account session. Stop immediately
                    // on provider throttling instead of walking the rest of the catalog.
                    if (error?.status === 429 || error?.code === 'nxapi_rate_limited') break;
                }
                firstUncached = false;
                await new Promise((resolve) => setTimeout(resolve, 900));
            }
        } finally {
            this.catalogPrimeRunning = false;
        }
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
            console.log(`[LaunchTrace:${traceId}] Launching ${service.name || 'Game Service'} via ${adapter.constructor.name}`);
            const token = await this.getGameWebServiceToken(
                service.id,
                traceId,
                false,
                { useWarmAttestation: true }
            );
            if (launchEpoch !== this.launchEpoch || !this.launchLocked) {
                const cancelled = new Error('Launch cancelled');
                cancelled.code = 'NSO_LAUNCH_CANCELLED';
                throw cancelled;
            }

            const userProfile = userSession?.result?.user || userSession?.user;
            const language = userProfile?.language || 'en-GB';
            const country = userProfile?.country || 'GB';

            const sessionStart = performance.now();
            await adapter.launch(service, token, { language, country });
            if (launchEpoch !== this.launchEpoch || !this.launchLocked) {
                await adapter.close().catch(() => {});
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
            const cancelled = e?.code === 'NSO_LAUNCH_CANCELLED';
            if (!cancelled) {
                console.error(`[LaunchTrace:${traceId}] Launch failed:`, e);
                await this.cancelNativeServiceLaunch();
                alert(`Could not open ${service.name || 'service'}: ${e.message}`);
            }
        } finally {
            buttonElement?.closest('.service-launch-card')?.classList.remove('launching-service');
            if (!succeeded) {
                this.activeAdapter = null;
                this.activeService = null;
                this.launchingButton = null;
                this.setCatalogLocked(false);
                this.scheduleAttestationPrewarm(500);
                this.scheduleCatalogPrime(2500);
            }
            // On success the catalog intentionally remains locked until closeActiveService().
        }
    }

    /**
     * Closes the currently active WebView using the APK back transition, then
     * deletes the Cloudflare session without exposing the Home screen mid-frame.
     */
    async closeActiveService() {
        if (!this.activeAdapter && !this.launchLocked) return;
        this.launchEpoch++;

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
        const closePromise = adapter ? adapter.close().catch(() => {}) : Promise.resolve();

        await new Promise((resolve) => setTimeout(resolve, 430));
        this.clearLaunchTransitionClasses();
        overlay?.classList.add('hidden');
        if (frame) frame.src = 'about:blank';
        document.getElementById('gwsNativeLoading')?.classList.add('hidden');

        document.documentElement.classList.remove('gws-transition-active');
        document.body.classList.remove('gws-transition-active');

        await closePromise;
        this.activeAdapter = null;
        this.activeService = null;
        this.launchingButton = null;
        this.setCatalogLocked(false);

        // Prepare the next launch again after the WebView has been dismissed.
        this.scheduleAttestationPrewarm(350);
        this.scheduleCatalogPrime(1500);
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
