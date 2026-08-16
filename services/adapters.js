/**
 * Nintendo Switch Online Game Web Service Adapters
 * Provides a universal NSO-compatible reverse-proxied host (GenericWebViewAdapter)
 * and service-specific native bridge quirk handlers.
 */

/**
 * Cross-module localization compatibility bridge.
 *
 * app.js contains legacy feature IIFEs that can execute before the Nintendo
 * Switch App localization/parity IIFE. The real tr()/trKey()/trVars() helpers
 * are lexical to that later IIFE, so early callers cannot see them directly.
 *
 * adapters.js is loaded before app.js, making it a safe place to expose small
 * global wrappers. Before localization is ready they fail open to the source
 * string instead of crashing startup; afterwards they delegate to app.js's
 * exported localization API.
 */
(function installNsoI18nBridge(global) {
    'use strict';

    const sourceText = (value) => String(value ?? '');
    const earlyKeyFallbacks = Object.freeze({
        Friend_Notify_Online: 'Notify When Online'
    });

    global.tr = function tr(source) {
        const translate = global.nsoTranslateText;
        return typeof translate === 'function' && translate !== global.tr
            ? translate(source)
            : sourceText(source);
    };

    global.trKey = function trKey(resourceKey) {
        const translateKey = global.nsoTranslateApkKey;
        if (typeof translateKey === 'function' && translateKey !== global.trKey) {
            return translateKey(resourceKey);
        }
        const key = sourceText(resourceKey);
        return earlyKeyFallbacks[key] || key;
    };

    global.trVars = function trVars(source, values = {}) {
        const translateVars = global.nsoTranslateVars;
        if (typeof translateVars === 'function' && translateVars !== global.trVars) {
            return translateVars(source, values);
        }
        return sourceText(source).replace(/\{([A-Za-z0-9_]+)\}/g, (_, key) => sourceText(values[key]));
    };
})(window);

class GenericWebViewAdapter {
    constructor(manager) {
        this.manager = manager;
        this.currentSession = null;
    }

    /**
     * Launch the game web service in the in-app WebView overlay.
     * Performs session creation on the Worker/Durable Object and loads the proxied page.
     */
    async launch(service, token, options = {}) {
        const workerUrl = this.manager.getWorkerUrl();
        const userLanguage = options.language || 'en-US';
        const userCountry = options.country || 'US';

        const createPayload = {
            serviceId: String(service.id),
            serviceUri: service.uri || service.url,
            whiteList: Array.isArray(service.whiteList) ? service.whiteList : (Array.isArray(service.whitelist) ? service.whitelist : []),
            token: token,
            language: userLanguage,
            country: userCountry,
            launchId: options.launchId || undefined
        };

        const response = await fetch(`${workerUrl}/api/nso/service/session/create`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include', // Includes Partitioned / HttpOnly cookies
            body: JSON.stringify(createPayload),
            signal: options.signal
        });

        if (!response.ok) {
            let errorMsg = `HTTP ${response.status}`;
            try {
                const errData = await response.json();
                errorMsg = errData.error || errorMsg;
            } catch (e) {}
            throw new Error(`Worker session creation failed: ${errorMsg}`);
        }

        const sessionData = await response.json();
        this.currentSession = {
            id: sessionData.sessionId,
            serviceId: String(service.id),
            service: service,
            webviewUrl: sessionData.webviewUrl,
            expiresAt: sessionData.expiresAt
        };

        // The manager owns the APK-style activity transition and global WebView lock.
        // This adapter only supplies the proxied Nintendo document once the session exists.
        const title = document.getElementById('inAppGameWebviewTitle');
        const frame = document.getElementById('inAppGameWebviewFrame');

        if (title) title.textContent = service.name || 'Game Service';
        if (frame) frame.src = sessionData.webviewUrl;

        return this.currentSession;
    }

    async renewToken(newToken, options = {}) {
        if (!this.currentSession?.id) return;
        const workerUrl = this.manager.getWorkerUrl();

        const response = await fetch(`${workerUrl}/api/nso/service/session/${this.currentSession.id}/renew-token`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({ token: newToken }),
            signal: options.signal
        });

        if (!response.ok) {
            console.warn('[GenericWebViewAdapter] Failed to update Worker session token:', response.status);
        }
    }

    async close() {
        if (!this.currentSession?.id) return;
        const workerUrl = this.manager.getWorkerUrl();
        const sessionId = this.currentSession.id;
        this.currentSession = null;

        try {
            await fetch(`${workerUrl}/api/nso/service/session/${sessionId}/close`, {
                method: 'POST',
                credentials: 'include'
            });
        } catch (e) {
            console.warn('[GenericWebViewAdapter] Session close warning:', e);
        }
    }
}

class ZeldaNotesAdapter extends GenericWebViewAdapter {
    async launch(service, token, options = {}) {
        try {
            localStorage.removeItem('nso_persist_5935781783175168');
            localStorage.removeItem('nso_persist_4974384874151936');
        } catch (e) {}
        return super.launch(service, token, options);
    }
}

class SplatNet3QuirksAdapter extends GenericWebViewAdapter {
    async launch(service, token, options = {}) {
        return super.launch(service, token, options);
    }
}

class NookLinkQuirksAdapter extends GenericWebViewAdapter {
    async launch(service, token, options = {}) {
        return super.launch(service, token, options);
    }
}

class SplatNet2QuirksAdapter extends GenericWebViewAdapter {
    async launch(service, token, options = {}) {
        return super.launch(service, token, options);
    }
}

class SmashWorldQuirksAdapter extends GenericWebViewAdapter {
    async launch(service, token, options = {}) {
        return super.launch(service, token, options);
    }
}

// Export for global browser use
window.GenericWebViewAdapter = GenericWebViewAdapter;
window.ZeldaNotesAdapter = ZeldaNotesAdapter;
window.SplatNet3QuirksAdapter = SplatNet3QuirksAdapter;
window.NookLinkQuirksAdapter = NookLinkQuirksAdapter;
window.SplatNet2QuirksAdapter = SplatNet2QuirksAdapter;
window.SmashWorldQuirksAdapter = SmashWorldQuirksAdapter;
