/**
 * Nintendo Switch Online Game Web Service Adapters
 * Provides a universal NSO-compatible reverse-proxied host (GenericWebViewAdapter)
 * and service-specific native bridge quirk handlers.
 */

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
            country: userCountry
        };

        const response = await fetch(`${workerUrl}/api/nso/service/session/create`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include', // Includes Partitioned / HttpOnly cookies
            body: JSON.stringify(createPayload)
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

        // Open in-app overlay
        const overlay = document.getElementById('inAppGameWebview');
        const title = document.getElementById('inAppGameWebviewTitle');
        const frame = document.getElementById('inAppGameWebviewFrame');

        if (title) title.textContent = service.name || 'Game Service';
        if (overlay) overlay.classList.remove('hidden');
        document.documentElement.classList.add('webview-active');
        document.body.classList.add('webview-active');

        if (frame) {
            frame.src = sessionData.webviewUrl;
        }

        return this.currentSession;
    }

    async renewToken(newToken) {
        if (!this.currentSession?.id) return;
        const workerUrl = this.manager.getWorkerUrl();

        const response = await fetch(`${workerUrl}/api/nso/service/session/${this.currentSession.id}/renew-token`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({ token: newToken })
        });

        if (!response.ok) {
            console.warn('[GenericWebViewAdapter] Failed to update Worker session token:', response.status);
        }
    }

    async close() {
        document.documentElement.classList.remove('webview-active');
        document.body.classList.remove('webview-active');
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
