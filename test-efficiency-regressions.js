const fs = require('fs');
const path = require('path');

function read(file) {
  return fs.readFileSync(path.join(__dirname, file), 'utf8');
}

function assert(condition, message) {
  if (!condition) throw new Error(`FAIL: ${message}`);
  console.log(`PASS: ${message}`);
}

const auth = read('js/auth.js');
const coral = read('js/coral.js');
const core = read('js/core.js');
const health = read('js/health.js');
const manager = read('services/manager.js');
const sw = read('sw.js');

assert(coral.includes("'/v4/Friend/List': 60_000"), 'Friend presence remains short-lived while benefiting from one-minute local caching');
assert(coral.includes("'/v4/GameWebService/List': 12 * 60 * 60_000"), 'Game-service catalog is reused locally across repeat sessions');
assert(coral.includes("'/v4/Media/List': 5 * 60_000"), 'Album list avoids repeated startup reads without becoming long-term stale');
assert(coral.includes('CORAL_BATCH_MAX_CALLS = 4'), 'Concurrent Coral reads stay within a conservative Free Worker CPU-sized batch');
assert(coral.includes("/api/nso/coral/batch"), 'Concurrent Coral reads use the one-request batch endpoint');
assert(coral.includes('queueMicrotask'), 'Same-turn startup/notification reads are coalesced before transport');
assert(coral.includes('singleCoralTransport(item)'), 'Batching has a direct compatibility fallback to the original call path');
assert(coral.includes('ttlMs > 0'), 'Only cacheable/read-style Coral operations are eligible for automatic batching');

assert(core.includes('nsoHydrateBrokerGameTokens'), 'Remembered broker tokens hydrate the in-memory game-token cache');
assert(core.includes('data?.gws'), 'Warm game tokens piggyback on the existing broker-start response');
assert(manager.indexOf('getCachedGameWebServiceToken') < manager.indexOf('requestBrokerCachedToken'), 'Game launches prefer the in-memory token before spending a Worker cache lookup');

assert(health.includes('installWorkerSimplePostTransport'), 'Cross-origin Worker JSON POSTs install the preflight-free transport shim');
assert(health.includes("headers.set('Content-Type', 'text/plain;charset=UTF-8')"), 'Worker JSON POST bodies use a CORS-safelisted media type');
assert(health.includes("target.origin === workerOrigin") && health.includes("target.pathname.startsWith('/api/nso/')"), 'Simple-POST rewrite is scoped only to the NSO Worker control plane');
assert(health.includes('if (!(input instanceof Request))'), 'Transport shim leaves arbitrary Request objects untouched');
assert(health.includes("target.pathname === '/api/nso/remember/resume'"), 'Remembered resume opts into the one-request combined backend path');
assert(health.includes('JSON.stringify({ clientId })'), 'Combined resume sends only the existing broker client identifier');
assert(health.includes('data?.brokerSession'), 'Frontend detects the optional embedded broker-start result');
assert(health.includes('installOneShotBrokerResume'), 'Embedded broker state replaces exactly one subsequent broker-start call');
assert(health.includes('window.nsoHydrateBrokerGameTokens?.(snapshot.gws)'), 'Combined resume also hydrates remembered GameWebServiceTokens');
assert(health.includes('setTimeout(restore, 30_000)'), 'Unused combined broker state automatically restores the original compatibility path');

assert(auth.includes('function startTokenBrokerHeartbeat()'), 'Token-broker heartbeat compatibility hook remains defined');
assert(auth.includes('stopTokenBrokerHeartbeat();'), 'Heartbeat hook stays disabled rather than polling the Worker');
assert(sw.includes("url.hostname.includes('workers.dev')"), 'Service worker never pretends Worker/API traffic is ordinary static app cache data');

assert(auth.includes("localStorage.getItem('nso_user_session')"), 'Remembered sessions persist Coral access credentials across browser restarts');
assert(auth.includes('expiresAt > Date.now() + 60000'), 'Restored Coral sessions verify active token expiration time');
assert(manager.includes('rehydratePersistentGameTokens') && manager.includes("localStorage.getItem('nso_gws_tokens')"), 'GameWebService tokens persist in local storage for unexpired game launches');
assert(manager.includes('savePersistentGameTokens'), 'New game tokens are persisted on write for remembered accounts');

console.log('NSO webapp free-tier efficiency regression suite passed.');
