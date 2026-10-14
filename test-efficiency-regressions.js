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
const signin = read('js/signin.js');
const localization = read('js/localization.js');
const sw = read('sw.js');

assert(coral.includes("'/v4/Friend/List': 60_000"), 'Friend presence remains short-lived while benefiting from one-minute local caching');
assert(coral.includes("'/v4/GameWebService/List': 12 * 60 * 60_000"), 'Game-service catalog is reused locally across repeat sessions');
assert(coral.includes("'/v4/Media/List': 5 * 60_000"), 'Album list avoids repeated startup reads without becoming long-term stale');
assert(coral.includes('CORAL_BATCH_MAX_CALLS = 4'), 'Concurrent Coral reads stay within a conservative Free Worker CPU-sized batch');
assert(coral.includes("/api/nso/coral/batch"), 'Concurrent Coral reads use the one-request batch endpoint');
assert(coral.includes('queueMicrotask'), 'Same-turn startup/notification reads are coalesced before transport');
assert(coral.includes('singleCoralTransport(item)'), 'Batching has a direct compatibility fallback to the original call path');
assert(coral.includes('ttlMs > 0'), 'Only cacheable/read-style Coral operations are eligible for automatic batching');

assert(core.includes('nsoHydrateBrokerGameTokens'), 'Legacy warm-token hydration remains backward compatible');
assert(manager.indexOf('getCachedGameWebServiceToken') < manager.indexOf('requestBrokerCachedToken'), 'Game launches prefer the in-memory token before spending a Worker cache lookup');
assert(signin.includes('nxapiGenerateF(1, idToken'), 'Coral login always obtains its method-1 f-token from nxapi');
assert(signin.includes('startTokenBrokerSession(accessToken);'), 'Worker broker start only fetches the profile and creates session bookkeeping');
assert(!signin.includes('generateCoralViaTokenBroker'), 'Coral login never asks the Worker to generate an f-token');
assert(!auth.includes('/api/nso/cache/coral/get-or-create'), 'Client has no Worker-backed Coral token generation path');
assert(!auth.includes('preparation?.idToken'), 'Broker start does not pass an ID token that triggers Worker native f generation');
assert(manager.includes('nxapiGenerateF(2, token'), 'Game-service tokens use nxapi method-2 attestation');
assert(manager.includes('getGameWebServiceTokenCanonical(idStr, traceId, options)'), 'New game-service tokens always follow the client nxapi path');
assert(!manager.includes('/api/nso/service/token`'), 'Game-token generation is never delegated to Worker');
assert(!core.includes('installSharedF2Batching'), 'No shared method-2 generation is routed to the Worker');

assert(health.includes('installWorkerSimplePostTransport'), 'Cross-origin Worker JSON POSTs install the preflight-free transport shim');
assert(health.includes("headers.set('Content-Type', 'text/plain;charset=UTF-8')"), 'Worker JSON POST bodies use a CORS-safelisted media type');
assert(health.includes("target.origin === workerOrigin") && health.includes("target.pathname.startsWith('/api/nso/')"), 'Simple-POST rewrite is scoped only to the NSO Worker control plane');
assert(health.includes('if (!(input instanceof Request))'), 'Transport shim leaves arbitrary Request objects untouched');
assert(!health.includes('installOneShotBrokerResume'), 'Remembered login does not use combined Worker resume/native f generation');
assert(!health.includes('combinedResume = true'), 'The Worker combined-resume optimization is not requested');
assert(signin.includes("const requireNxapiConsent = () => {") && !signin.includes("if (window.nsoBackendMode !== 'extension') return true"), 'All backend modes require nxapi consent');

assert(auth.includes('function startTokenBrokerHeartbeat()'), 'Token-broker heartbeat compatibility hook remains defined');
assert(auth.includes('stopTokenBrokerHeartbeat();'), 'Heartbeat hook stays disabled rather than polling the Worker');
assert(sw.includes("url.hostname.includes('workers.dev')"), 'Service worker never pretends Worker/API traffic is ordinary static app cache data');

assert(auth.includes("localStorage.getItem('nso_user_session')"), 'Remembered sessions persist Coral access credentials across browser restarts');
assert(auth.includes('expiresAt > Date.now() + 60000'), 'Restored Coral sessions verify active token expiration time');
assert(manager.includes('rehydratePersistentGameTokens') && manager.includes("localStorage.getItem('nso_gws_tokens')"), 'GameWebService tokens persist in local storage for unexpired game launches');
assert(manager.includes('savePersistentGameTokens'), 'New game tokens are persisted on write for remembered accounts');

assert(manager.includes('[coral:f2:nxapi]'), 'Method-2 generation is identified as nxapi, never fallback');
assert(!manager.includes('[coral:f2:fallback]') && !manager.includes('via client fallback'), 'Game token log has no obsolete fallback wording');
assert(manager.includes("source: 'nxapi'"), 'Generated game-service tokens identify nxapi as their source');
assert(!auth.includes('Game Token fallback') && auth.includes("tr('Game Token')"), 'nxapi method-2 reason has no fallback wording');
assert(localization.includes('"pt-PT": "A gerar GameWebServiceToken para o serviço {serviceId}"'), 'Portuguese game-token generation uses the existing neutral translation');
assert(!localization.includes('via alternativa do cliente') && !localization.includes('"Game Token fallback"'), 'Obsolete fallback translations are removed');

console.log('NSO webapp free-tier efficiency regression suite passed.');
