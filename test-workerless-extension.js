const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require('node:path').join(__dirname, 'js/health.js'), 'utf8');
const worker = 'https://nso-worker-backend.diogoenes0.workers.dev';

async function makeApp(initialMode, fail = false) {
    const nativeRequests = [];
    const extensionMessages = [];
    const webWindow = {
        nsoBackendMode: initialMode,
        nsoDetectBackend: async () => {
            webWindow.nsoBackendMode = 'extension';
            return 'extension';
        },
        nsoDispatchExtensionMessage: async (type, data) => {
            extensionMessages.push({ type, data });
            if (fail) throw new Error('extension disconnected');
            return { ok: true, status: 200, data: { success: true } };
        },
        fetch: async (...args) => {
            nativeRequests.push(args);
            return new Response('network', { status: 200 });
        }
    };
    const context = {
        window: webWindow, WORKER_URL: worker,
        Request, Response, Headers, URL,
        location: { href: 'https://dycool.github.io/nso-webapp/', protocol: 'http:' },
        document: { addEventListener: () => {}, getElementById: () => null },
        navigator: {}, console,
        setTimeout, clearTimeout, Date
    };
    vm.runInNewContext(source, context, { filename: 'js/health.js' });
    return { webWindow, nativeRequests, extensionMessages };
}

async function main() {
    const session = await makeApp('detecting');
    const post = await session.webWindow.fetch(worker + '/api/nso/coral/call', {
        method: 'POST', body: JSON.stringify({ path: '/v4/Friend/List' })
    });
    assert.equal(post.status, 200);
    assert.equal(session.extensionMessages[0].type, 'NSO_CORAL_CALL');
    assert.equal(session.nativeRequests.length, 0, 'No Worker network call while detecting the extension');

    const diagnostic = await session.webWindow.fetch(worker + '/api/nso/diagnostics', {
        method: 'POST', body: '{}'
    });
    assert.equal(diagnostic.status, 503, 'Unmapped Worker diagnostics cannot escape extension mode');
    const get = await session.webWindow.fetch(worker + '/health');
    assert.equal(get.status, 503, 'GET Worker calls are disabled in extension mode');
    const requestObject = new Request(worker + '/api/nso/auth/logout', { method: 'POST' });
    const requestResponse = await session.webWindow.fetch(requestObject);
    assert.equal(requestResponse.status, 200, 'Request-object POSTs route through the extension');
    assert.equal(session.extensionMessages.at(-1).type, 'NSO_LOGOUT');
    assert.equal(session.nativeRequests.length, 0, 'No Worker network calls for any HTTP request type');

    const failed = await makeApp('extension', true);
    const bad = await failed.webWindow.fetch(worker + '/api/nso/coral/call', {
        method: 'POST', body: '{}'
    });
    assert.equal(bad.status, 503, 'Extension messaging failure is returned locally');
    assert.equal(failed.nativeRequests.length, 0, 'No Cloudflare fallback on extension errors');

    const cloudflare = await makeApp('cloudflare');
    await cloudflare.webWindow.fetch(worker + '/api/nso/coral/call', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}'
    });
    assert.equal(cloudflare.nativeRequests.length, 1, 'Cloudflare-only mode still works');
    assert.equal(cloudflare.nativeRequests[0][1].headers.get('Content-Type'), 'text/plain;charset=UTF-8');

    console.log('Strict extension mode network regression tests passed.');
}

main().catch(e => { console.error(e); process.exitCode = 1; });
