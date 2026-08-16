/**
 * Dock navigation, view transitions, authenticated shell, profile and notifications.
 * Kept in original execution order while separating this responsibility from the app shell.
 */

const DOCK_LOTTIE_CONFIG = {
    tabs: ['home', 'friends', 'album'],
    containers: {
        home: 'dockLottieHome',
        friends: 'dockLottieFriends',
        album: 'dockLottieAlbum'
    },
    paths: {
        home: {
            dark: { on: 'assets/lottie/home_dark_on.json', off: 'assets/lottie/home_dark_off.json' },
            light: { on: 'assets/lottie/home_light_on.json', off: 'assets/lottie/home_light_off.json' }
        },
        friends: {
            dark: { on: 'assets/lottie/friend_dark_on.json', off: 'assets/lottie/friend_dark_off.json' },
            light: { on: 'assets/lottie/friend_light_on.json', off: 'assets/lottie/friend_light_off.json' }
        },
        album: {
            dark: { on: 'assets/lottie/album_dark_on.json', off: 'assets/lottie/album_dark_off.json' },
            light: { on: 'assets/lottie/album_light_on.json', off: 'assets/lottie/album_light_off.json' }
        }
    }
};

let dockLottieCache = {};
let dockLottiePlayers = {};
let currentActiveDockTab = 'home';

async function preloadDockLottie() {
    if (typeof lottie === 'undefined') return;
    const mode = document.body.classList.contains('dark-theme') ? 'dark' : 'light';
    const fetches = [];
    for (const tab of DOCK_LOTTIE_CONFIG.tabs) {
        for (const m of ['dark', 'light']) {
            for (const state of ['on', 'off']) {
                const path = DOCK_LOTTIE_CONFIG.paths[tab][m][state];
                fetches.push(
                    fetch(path)
                        .then(r => r.json())
                        .then(data => { dockLottieCache[`${tab}_${m}_${state}`] = data; })
                        .catch(err => console.warn(`[Lottie] Failed to load ${path}:`, err))
                );
            }
        }
    }
    await Promise.allSettled(fetches);
    initDockLottiePlayers();
}

function getDockLottieData(tab, state) {
    const mode = document.body.classList.contains('dark-theme') ? 'dark' : 'light';
    return dockLottieCache[`${tab}_${mode}_${state}`] || dockLottieCache[`${tab}_dark_${state}`];
}

function initDockLottiePlayers() {
    if (typeof lottie === 'undefined') return;
    for (const tab of DOCK_LOTTIE_CONFIG.tabs) {
        const container = document.getElementById(DOCK_LOTTIE_CONFIG.containers[tab]);
        if (!container) continue;
        container.innerHTML = '';
        const isSelected = tab === currentActiveDockTab;
        const animData = getDockLottieData(tab, isSelected ? 'on' : 'off');
        if (!animData) continue;

        try {
            const player = lottie.loadAnimation({
                container,
                renderer: 'svg',
                loop: false,
                autoplay: false,
                animationData: animData
            });
            dockLottiePlayers[tab] = { player, state: isSelected ? 'on' : 'off' };
            player.addEventListener('DOMLoaded', () => {
                const lastFrame = (player.totalFrames || animData.op || 1) - 1;
                player.goToAndStop(lastFrame, true);
            });
        } catch (e) {
            console.warn(`[Lottie] Error initializing ${tab}:`, e);
        }
    }
}

function playDockTabAnimation(tab, targetState, animate = true) {
    if (typeof lottie === 'undefined') return;
    const container = document.getElementById(DOCK_LOTTIE_CONFIG.containers[tab]);
    if (!container) return;

    const animData = getDockLottieData(tab, targetState);
    if (!animData) return;

    if (dockLottiePlayers[tab]?.player) {
        try { dockLottiePlayers[tab].player.destroy(); } catch (e) { }
    }

    container.innerHTML = '';
    const player = lottie.loadAnimation({
        container,
        renderer: 'svg',
        loop: false,
        autoplay: false,
        animationData: animData
    });

    dockLottiePlayers[tab] = { player, state: targetState };

    player.addEventListener('DOMLoaded', () => {
        const lastFrame = (player.totalFrames || animData.op || 1) - 1;
        if (animate) {
            player.goToAndPlay(0, true);
        } else {
            player.goToAndStop(lastFrame, true);
        }
    });

    if (targetState === 'on') {
        player.addEventListener('complete', () => {
            const lastFrame = (player.totalFrames || animData.op || 1) - 1;
            player.goToAndStop(lastFrame, true);
        });
    }
}

function switchDockTab(tabName) {
    if (currentActiveDockTab === tabName) return;
    const prevTab = currentActiveDockTab;
    currentActiveDockTab = tabName;

    if (prevTab) {
        playDockTabAnimation(prevTab, 'off', true);
    }
    playDockTabAnimation(tabName, 'on', true);
}

function initNavigation() {
    document.getElementById('logoutBtn').addEventListener('click', logout);
    document.getElementById('openAuthModalBtn').addEventListener('click', showLoginGate);
    document.getElementById('notificationBtn').addEventListener('click', openNotifications);
    document.getElementById('userAvatarContainer').addEventListener('click', openProfile);

    const dockButtons = [...document.querySelectorAll('#homeDock button')];
    dockButtons.forEach(button => {
        button.addEventListener('click', () => {
            showAppPage(button.dataset.page);
        });
    });

    preloadDockLottie();
}

// Tab Stack State Management
const navTabStacks = {
    home: 'home', // Legacy state used by older handlers. Persistent views are tracked separately below.
    friends: 'list',
    album: 'album'
};

// Nintendo Switch App-style bottom-tab state permanence. Each bottom tab owns its
// own overlay stack. Switching tabs suspends the currently visible overlays
// without destroying their DOM/data/scroll state, and returning to that tab
// restores the exact screens that were left open.
let activeAppTab = 'home';
const tabViewSnapshots = { home: [], friends: [], album: [] };
const tabBaseScroll = { home: 0, friends: 0, album: 0 };
const tabViewScroll = new Map();
// While a selected bottom tab is animating back to its root, don't let a
// simultaneous tab switch capture the outgoing submenu as fresh saved state.
const tabRootResetInFlight = new Set();
const PERSISTENT_VIEW_SELECTOR = [
    '#profileView',
    '#notificationView',
    '#friendDetailView',
    '.friend-settings-screen',
    '.sent-req-detail-screen',
    '.fc-search-screen',
    '.chatted-users-view',
    '.op-screen'
].join(',');

function validAppTab(tab) {
    return ['home', 'friends', 'album'].includes(tab) ? tab : 'home';
}

function persistentViewOwner(view) {
    if (!view) return activeAppTab;
    return validAppTab(view.dataset.nsoOwnerTab || activeAppTab);
}

function assignPersistentViewOwner(view, owner = activeAppTab) {
    if (!view || !view.matches?.(PERSISTENT_VIEW_SELECTOR)) return;
    view.dataset.nsoOwnerTab = validAppTab(owner);
}

function persistentScrollHost(view) {
    if (!view) return null;
    if (view.classList.contains('op-screen')) return view.querySelector('.op-scroll') || view;
    return view;
}

function persistentViews() {
    return [...document.querySelectorAll(PERSISTENT_VIEW_SELECTOR)];
}

function captureTabNavigationState(tab) {
    tab = validAppTab(tab);
    if (tabRootResetInFlight.has(tab)) return;
    tabBaseScroll[tab] = window.scrollY || 0;
    const visible = persistentViews().filter((view) =>
        !view.classList.contains('hidden') && persistentViewOwner(view) === tab
    );
    tabViewSnapshots[tab] = visible.map((view) => view.id).filter(Boolean);
    visible.forEach((view) => {
        const host = persistentScrollHost(view);
        if (host && view.id) tabViewScroll.set(view.id, host.scrollTop || 0);
    });
}

function suspendTabNavigationState(tab) {
    tab = validAppTab(tab);
    persistentViews().forEach((view) => {
        if (persistentViewOwner(view) !== tab || view.classList.contains('hidden')) return;
        hideViewInstant(view);
    });
}

function restoreTabNavigationState(tab) {
    tab = validAppTab(tab);
    const ids = tabViewSnapshots[tab] || [];
    ids.forEach((id) => {
        const view = document.getElementById(id);
        if (!view || persistentViewOwner(view) !== tab) return;
        showViewInstant(view);
    });

    requestAnimationFrame(() => {
        if (activeAppTab !== tab) return;
        // Restore the base page position even when an overlay is on top, so pressing
        // Back after returning to the tab reveals the same underlying content.
        window.scrollTo({ top: tabBaseScroll[tab] || 0, behavior: 'auto' });
        ids.forEach((id) => {
            const view = document.getElementById(id);
            const host = persistentScrollHost(view);
            if (host && tabViewScroll.has(id)) host.scrollTop = tabViewScroll.get(id);
        });
    });
}

function resetTabNavigationState() {
    activeAppTab = 'home';
    for (const tab of Object.keys(tabViewSnapshots)) {
        tabViewSnapshots[tab] = [];
        tabBaseScroll[tab] = 0;
    }
    tabViewScroll.clear();
    persistentViews().forEach((view) => hideViewInstant(view));
}

// Reselecting the currently active bottom tab acts like Android's pop-to-root:
// preserve nested state while switching between tabs, but a second press on the
// already-selected tab clears that tab's overlay/back stack and reveals its base page.
// The visible leaf screen uses the same APK-derived Back transition as a normal
// submenu Back press instead of disappearing instantly.
function resetTabToRoot(tab) {
    tab = validAppTab(tab);
    const ownedViews = persistentViews().filter((view) => persistentViewOwner(view) === tab);
    const visibleOwnedViews = ownedViews.filter((view) => !view.classList.contains('hidden'));
    const hasVisibleNestedView = visibleOwnedViews.length > 0;
    const hasSavedNestedView = (tabViewSnapshots[tab] || []).length > 0;
    if (!hasVisibleNestedView && !hasSavedNestedView) return false;
    if (tabRootResetInFlight.has(tab)) return true;

    // Prefer the visually topmost visible submenu. z-index wins first; DOM order
    // breaks ties for screens that share the same native overlay layer.
    const leavingView = visibleOwnedViews.reduce((top, view) => {
        if (!top) return view;
        const topZ = Number.parseInt(getComputedStyle(top).zIndex, 10);
        const viewZ = Number.parseInt(getComputedStyle(view).zIndex, 10);
        const safeTopZ = Number.isFinite(topZ) ? topZ : 0;
        const safeViewZ = Number.isFinite(viewZ) ? viewZ : 0;
        if (safeViewZ !== safeTopZ) return safeViewZ > safeTopZ ? view : top;
        return top.compareDocumentPosition(view) & Node.DOCUMENT_POSITION_FOLLOWING ? view : top;
    }, null);

    tabRootResetInFlight.add(tab);
    tabViewSnapshots[tab] = [];
    ownedViews.forEach((view) => {
        if (view.id) tabViewScroll.delete(view.id);
    });

    // Keep the legacy per-tab state in sync with the root immediately so older
    // handlers cannot reopen a stale submenu while the leave animation is running.
    if (tab === 'friends') navTabStacks.friends = 'list';
    else if (tab === 'album') navTabStacks.album = 'album';
    else navTabStacks.home = 'home';

    const rootPage = document.getElementById(`page-${tab}`);
    document.querySelectorAll('.tab-page').forEach((page) => page.classList.remove('active'));
    rootPage?.classList.add('active');

    // Only the leaf screen should animate. Any older stacked overlays are removed
    // first so the section root is the actual background revealed by Back.
    ownedViews.forEach((view) => {
        if (view !== leavingView) hideViewInstant(view);
    });

    const finish = () => {
        ownedViews.forEach((view) => hideViewInstant(view));
        tabRootResetInFlight.delete(tab);
        if (activeAppTab !== tab) return;
        requestAnimationFrame(() => {
            if (activeAppTab !== tab) return;
            window.scrollTo({ top: tabBaseScroll[tab] || 0, behavior: 'auto' });
        });
    };

    if (leavingView && rootPage) {
        // One native-style pop-to-root animation, matching an ordinary submenu Back.
        Promise.resolve(nsoApkBack(leavingView, rootPage)).then(finish, finish);
    } else {
        finish();
    }
    return true;
}

window.nsoCurrentTab = () => activeAppTab;

let activeFriendDetailData = null;
let friendDetailOriginTab = 'friends';

// --- Slide transition helpers ---
function slideViewIn(el) {
    if (!el) return;
    assignPersistentViewOwner(el, activeAppTab);
    el.classList.remove('hidden', 'view-slide-out');
    el.classList.add('view-slide-in');
    el.addEventListener('animationend', () => {
        el.classList.remove('view-slide-in');
    }, { once: true });
}

function slideViewOut(el, cb) {
    if (!el) return;
    el.classList.remove('view-slide-in');
    el.classList.add('view-slide-out');
    el.addEventListener('animationend', () => {
        el.classList.remove('view-slide-out');
        el.classList.add('hidden');
        if (cb) cb();
    }, { once: true });
}

function hideViewInstant(el) {
    if (!el) return;
    el.classList.remove('view-slide-in', 'view-slide-out');
    el.classList.add('hidden');
}

function showViewInstant(el) {
    if (!el) return;
    el.classList.remove('hidden', 'view-slide-in', 'view-slide-out');
}

// Exact activity transition timing recovered from the Nintendo Switch App APK:
// forward = 150 ms delay + 400 ms ease-out scale, with the alpha phase at 200 ms;
// back = 400 ms ease-out scale, with a 50 ms alpha phase after 50 ms.
const NSO_APK_FORWARD_TRANSITION_MS = 550;
const NSO_APK_BACK_TRANSITION_MS = 400;

function clearNsoApkTransition(el) {
    if (!el) return;
    if (el.__nsoApkTransitionTimer) {
        clearTimeout(el.__nsoApkTransitionTimer);
        el.__nsoApkTransitionTimer = null;
    }
    el.classList.remove(
        'nso-apk-go-enter',
        'nso-apk-go-exit',
        'nso-apk-back-enter',
        'nso-apk-back-exit',
        'nso-apk-transition-foreground',
        'nso-apk-transition-background'
    );
}

function nsoApkForward(fromView, toView, options = {}) {
    if (!toView) return Promise.resolve();
    assignPersistentViewOwner(toView, fromView?.dataset?.nsoOwnerTab || activeAppTab);
    const hideSource = options.hideSource !== false;
    clearNsoApkTransition(fromView);
    clearNsoApkTransition(toView);

    toView.classList.remove('hidden', 'view-slide-in', 'view-slide-out');
    toView.classList.add('nso-apk-transition-foreground', 'nso-apk-go-enter');
    if (fromView && fromView !== toView) {
        fromView.classList.remove('view-slide-in', 'view-slide-out');
        fromView.classList.add('nso-apk-transition-background', 'nso-apk-go-exit');
    }

    return new Promise((resolve) => {
        const finish = () => {
            if (fromView && fromView !== toView) {
                clearNsoApkTransition(fromView);
                if (hideSource) fromView.classList.add('hidden');
            }
            clearNsoApkTransition(toView);
            resolve();
        };
        toView.__nsoApkTransitionTimer = setTimeout(finish, NSO_APK_FORWARD_TRANSITION_MS + 30);
    });
}

function nsoApkBack(fromView, toView, options = {}) {
    if (!fromView) return Promise.resolve();
    const hideSource = options.hideSource !== false;
    clearNsoApkTransition(fromView);
    clearNsoApkTransition(toView);

    if (toView) {
        toView.classList.remove('hidden', 'view-slide-in', 'view-slide-out');
        toView.classList.add('nso-apk-transition-background', 'nso-apk-back-enter');
    }
    fromView.classList.remove('hidden', 'view-slide-in', 'view-slide-out');
    fromView.classList.add('nso-apk-transition-foreground', 'nso-apk-back-exit');

    return new Promise((resolve) => {
        const finish = () => {
            clearNsoApkTransition(fromView);
            if (hideSource) fromView.classList.add('hidden');
            clearNsoApkTransition(toView);
            resolve();
        };
        fromView.__nsoApkTransitionTimer = setTimeout(finish, NSO_APK_BACK_TRANSITION_MS + 30);
    });
}

window.nsoApkForward = nsoApkForward;
window.nsoApkBack = nsoApkBack;

function applyTabViewState(tabName = 'home', options = {}) {
    tabName = validAppTab(tabName);
    const restoringSnapshot = options.restoreSnapshot === true;

    // When this is an in-tab state change (for example Friend Detail -> Friends),
    // refresh the snapshot from the live DOM instead of replaying an older saved
    // leaf screen. Cross-tab restores deliberately skip this capture.
    if (!restoringSnapshot && tabName === activeAppTab) {
        captureTabNavigationState(tabName);
    }

    // Every tab keeps its base page mounted underneath its own overlay stack.
    // This mirrors the native app's Fragment/back-stack behavior and prevents
    // a one-frame Home flash when restoring a submenu.
    document.querySelectorAll('.tab-page').forEach((page) => page.classList.remove('active'));
    document.getElementById(`page-${tabName}`)?.classList.add('active');

    persistentViews().forEach((view) => {
        if (persistentViewOwner(view) !== tabName && !view.classList.contains('hidden')) {
            hideViewInstant(view);
        }
    });

    if (restoringSnapshot) restoreTabNavigationState(tabName);
}

function showAppPage(pageName = 'home') {
    pageName = validAppTab(pageName);
    const switchedTabs = pageName !== activeAppTab;

    if (switchedTabs) {
        captureTabNavigationState(activeAppTab);
        suspendTabNavigationState(activeAppTab);
        activeAppTab = pageName;
    } else {
        // A tap on the already-selected bottom tab is an explicit request to go
        // back to that section's main/root screen. Cross-tab restores still keep
        // their exact submenu and scroll state until this reselect happens.
        resetTabToRoot(pageName);
    }

    document.querySelectorAll('#homeDock button').forEach(button => {
        button.classList.toggle('active', button.dataset.page === pageName);
    });
    switchDockTab(pageName);
    applyTabViewState(pageName, { restoreSnapshot: switchedTabs });
}

// Game Services Tabs
function initServicesNav() {
    const serviceBtns = document.querySelectorAll('.service-tab-btn');
    const serviceContents = document.querySelectorAll('.service-content');

    serviceBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            serviceBtns.forEach(b => b.classList.remove('active'));
            serviceContents.forEach(c => c.classList.remove('active'));

            btn.classList.add('active');
            const targetId = `service-${btn.dataset.service}`;
            document.getElementById(targetId).classList.add('active');
        });
    });
}

function showLoginGate() {
    document.getElementById('loginGate').classList.remove('hidden');
    document.getElementById('appContent').classList.add('hidden');
    document.getElementById('mainNavTabs').classList.add('hidden');
    document.getElementById('userAvatarContainer').classList.add('hidden');
    document.getElementById('notificationBtn').classList.add('hidden');
    document.getElementById('homeDock').classList.add('hidden');
    document.getElementById('openAuthModalBtn').classList.remove('hidden');
    document.getElementById('profileView').classList.add('hidden');
    document.getElementById('notificationView').classList.add('hidden');
}

function showAuthenticatedUI(session) {
    applySessionZncaVersion(session);
    document.getElementById('loginGate').classList.add('hidden');
    document.getElementById('appContent').classList.remove('hidden');
    document.getElementById('mainNavTabs').classList.remove('hidden');
    document.getElementById('userAvatarContainer').classList.remove('hidden');
    document.getElementById('notificationBtn').classList.remove('hidden');
    document.getElementById('homeDock').classList.remove('hidden');
    document.getElementById('openAuthModalBtn').classList.add('hidden');
    resetTabNavigationState();
    showAppPage('home');
    startTokenBrokerHeartbeat();

    if (session && session.result && session.result.user) {
        const user = session.result.user;
        const displayName = user.nickname || user.name || 'Switch Player';
        document.getElementById('myNickname').textContent = displayName;
        document.getElementById('userNickname').textContent = displayName;
        document.getElementById('profileViewName').textContent = displayName;
        if (user.imageUri) {
            document.getElementById('myAvatar').src = user.imageUri;
            document.getElementById('userAvatar').src = user.imageUri;
            document.getElementById('profileViewAvatar').src = user.imageUri;
        }
        if (user.links && user.links.friendCode) {
            document.getElementById('myFriendCode').textContent = user.links.friendCode.id;
            document.getElementById('profileViewFriendCode').textContent = user.links.friendCode.id;
        }
    } else if (session && session.user) {
        document.getElementById('myNickname').textContent = session.user.nickname || 'Switch Player';
        document.getElementById('userNickname').textContent = session.user.nickname || 'Switch Player';
        document.getElementById('profileViewName').textContent = session.user.nickname || 'Switch Player';
        if (session.user.imageUri) {
            document.getElementById('myAvatar').src = session.user.imageUri;
            document.getElementById('userAvatar').src = session.user.imageUri;
            document.getElementById('profileViewAvatar').src = session.user.imageUri;
        }
    }

    loadLiveFriendsList();
    loadGameServices();
    loadSwitchMedia();
}

async function purgeServerAccountState() {
    const clientId = tokenBrokerClientId();

    // New Worker versions perform Remember Me revocation + broker release in one
    // server-side operation so Sign Out cannot leave persistent account state behind.
    let response = null;
    try {
        response = await fetch(`${WORKER_URL}/api/nso/auth/logout`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
            credentials: 'include',
            keepalive: true,
            body: JSON.stringify({ clientId })
        });
    } catch (error) {
        response = null;
    }

    if (response?.ok) return;

    // Deployment-order compatibility: if the webapp reaches an older Worker, perform
    // the same cleanup through the two existing endpoints.
    if (!response || response.status === 404 || response.status === 405) {
        const [forgetResponse, releaseResponse] = await Promise.all([
            fetch(`${WORKER_URL}/api/nso/remember/forget`, {
                method: 'POST',
                credentials: 'include',
                keepalive: true
            }),
            fetch(`${WORKER_URL}/api/nso/cache/session/release`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include',
                keepalive: true,
                body: JSON.stringify({ clientId })
            })
        ]);
        if (forgetResponse.ok && releaseResponse.ok) return;
    }

    throw new Error('The server could not remove the remembered account and cached login session.');
}

async function logout() {
    if (logout.__inFlight) return logout.__inFlight;

    logout.__inFlight = (async () => {
        window.webServiceManager?.closeActiveService();
        window.nsoCloseAppScreens?.();
        stopTokenBrokerHeartbeat();

        try {
            await purgeServerAccountState();
        } catch (error) {
            // Do not pretend sign-out succeeded while the server may still retain the
            // Remember Me grant/cache. Keep the local session so the user can retry.
            startTokenBrokerHeartbeat();
            console.error('[SignOut] secure cleanup failed', error); alert(trKey('Error_Dialog_Message_CommunicationFailed'));
            return;
        }

        localStorage.removeItem('nso_has_remembered_account');
        localStorage.removeItem('nso_remember_expires_at');
        try { sessionStorage.removeItem('nso_token_broker_client_id'); } catch (e) { }
        sessionStorage.removeItem('nso_user_session');
        localStorage.removeItem('nso_user_session');
        localStorage.removeItem('nso_pkce_verifier');
        localStorage.removeItem('nso_auth_state');
        clearAllCoralDataCache();
        try { navigator.serviceWorker?.controller?.postMessage({ type: 'CLEAR_RUNTIME' }); } catch (e) { }
        userSession = null;
        applySessionZncaVersion(null);
        clearNxapiAuthSession();

        const loginWorkflow = document.getElementById('loginWorkflow');
        loginWorkflow?.classList.add('hidden');
        loginWorkflow?.classList.remove('remembered-consent-only');
        document.getElementById('beginSignInBtn')?.classList.remove('hidden');
        document.querySelector('.login-help')?.classList.remove('hidden');

        showLoginGate();
        updateRememberedUI();
    })();

    try {
        return await logout.__inFlight;
    } finally {
        logout.__inFlight = null;
    }
}

async function clearRememberedAccount() {
    const response = await fetch(`${WORKER_URL}/api/nso/remember/forget`, {
        method: 'POST',
        credentials: 'include'
    });
    if (!response.ok) {
        throw new Error(`Remembered-account removal failed (HTTP ${response.status}).`);
    }
    localStorage.removeItem('nso_has_remembered_account');
    localStorage.removeItem('nso_remember_expires_at');
    updateRememberedUI();
}

async function forgetRememberedAccount() {
    try {
        await clearRememberedAccount();
        toast(tr('Setting changed.'));
    } catch (error) {
        console.error('[RememberMe] forget failed', error); alert(trKey('Error_Dialog_Message_CommunicationFailed'));
    }
}

function openProfile() {
    navTabStacks.home = 'profile';
    slideViewIn(document.getElementById('profileView'));
}

async function openNotifications() {
    navTabStacks.home = 'notifications';
    slideViewIn(document.getElementById('notificationView'));
    const list = document.getElementById('notificationList');
    list.innerHTML = `<div class="notification-item"><div></div><div><strong>${escapeHtml(tr('Loading…'))}</strong></div></div>`;
    try {
        const result = await coralCall('/v4/Announcement/List');
        renderNotifications(Array.isArray(result) ? result : (result.announcements || []));
    } catch (error) {
        console.error('[Notifications] load failed', error); list.innerHTML = `<p class="service-status error">${escapeHtml(trKey('Common_Loading_Failed'))}</p>`;
    }
}

function renderNotifications(items) {
    const list = document.getElementById('notificationList');
    list.innerHTML = '';
    if (!items.length) {
        list.innerHTML = `<p class="service-status">${escapeHtml(trKey('Announcement_Empty'))}</p>`;
        return;
    }
    for (const item of items) {
        const article = document.createElement('article');
        article.className = 'notification-item';
        const image = document.createElement('img');
        image.src = item.imageUri || item.image2Uri || '';
        image.alt = '';
        const copy = document.createElement('div');
        const title = document.createElement('strong');
        title.textContent = item.title || 'Nintendo Switch App';
        const description = document.createElement('p');
        description.textContent = item.operation?.contents || item.contents || '';
        const time = document.createElement('span');
        time.textContent = formatMediaDate(item.deliversAt || item.distributionDate);
        copy.append(title, description, time);
        article.append(image, copy);
        list.append(article);
    }
}

let loginInFlight = null;
let pendingRememberedResume = false;

