// Nintendo Switch App features
// ---------------------------------------------------------------------------

/**
 * Native Nintendo Switch App screens and Coral-backed controls.
 * Authentication and game-specific WebView orchestration remain in their dedicated core modules.
 */
(() => {
    'use strict';

    const BASE = 'https://api-lp1.znc.srv.nintendo.net';
    const $ = (id) => document.getElementById(id);

    const state = {
        currentUser: null,
        permissions: null,
        pushSettings: null,
        webServices: [],
        chats: [],
        activeChat: null,
        activeFriend: null,
        activeChatCandidate: null,
        friendOnlineReturnTarget: 'opPushPage',
        announcements: [],
        loginFactor: null,
        ownPlayLogs: [],
        ownPlayLogsNsaId: '',
        ownPlayLogsLoadedAt: 0,
        ownPlayLogsPromise: null,
        visibilityReturnTarget: 'opUserPage',
        pushReturnTarget: 'opSettingsPage',
        browserNotifications: {
            timer: null,
            running: false,
            baselineReady: false,
            announcementIds: new Set(),
            requestIds: new Set(),
            chatIds: new Set(),
            activeEventKey: '',
            friendOnline: new Map(),
            lastFriendOnlineNotice: new Map(),
            lastPollAt: 0
        },
        screensReady: false,
        refreshing: null,
        mobileObserver: null
    };



    // Endpoints recovered from the official 3.4.1 APK / current Coral contract.
    // Flags mirror the Android client behavior rather than adding Coral headers
    // globally to every request.
    const ENDPOINTS = Object.freeze({
        currentUser: { path: '/v4/User/ShowSelf' },
        permissions: { path: '/v3/User/Permissions/ShowSelf', noParameter: true, requestId: true },
        permissionsWrite: { path: '/v4/User/Permissions/UpdateSelf' },
        friends: { path: '/v4/Friend/List', platform: true },
        friendShow: { path: '/v4/Friend/Show' },
        friendIsNewDelete: { path: '/v4/Friend/IsNew/Delete' },
        favoriteAdd: { path: '/v3/Friend/Favorite/Create', platform: true },
        favoriteDelete: { path: '/v3/Friend/Favorite/Delete', platform: true },
        friendNote: { path: '/v4/Friend/Note/Update' },
        friendDelete: { path: '/v3/Friend/Delete' },
        friendBlock: { path: '/v3/User/Block/Create' },
        friendOnlinePush: { path: '/v5/PushNotification/Settings/Update' },
        friendPlayLog: { path: '/v4/User/PlayLog/Show' },
        chatCandidates: { path: '/v5/Chat/FriendCandidate/List' },
        friendRequest: { path: '/v4/FriendRequest/Create' },
        receivedRequests: { path: '/v4/FriendRequest/Received/List' },
        chats: { path: '/v5/Chat/List' },
        activeEvent: { path: '/v1/Event/GetActiveEvent' },
        chatShow: { path: '/v5/Chat/Show' },
        pushList: { path: '/v5/PushNotification/Settings/List' },
        pushUpdate: { path: '/v5/PushNotification/Settings/Update' },
        webServices: { path: '/v4/GameWebService/List', noParameter: true, requestId: true },
        announcements: { path: '/v4/Announcement/List', platform: true },
        announcementRead: { path: '/v4/Announcement/MarkAsRead', platform: true },
        mediaHashtags: { path: '/v5/Hashtag/List' },
        feedback: { path: '/v1/Support/SendOpinion' },
        loginFactor: { path: '/v4/NA/User/LoginFactor/Show' }
    });

    function escapeHtml(value) {
        return String(value ?? '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    }

    function uuid() {
        return globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    }

    function toMillis(value) {
        if (!value) return 0;
        if (typeof value === 'number') return value < 10_000_000_000 ? value * 1000 : value;
        const parsed = Date.parse(value);
        return Number.isFinite(parsed) ? parsed : 0;
    }

    function formatDate(value, withTime = true) {
        const ms = toMillis(value);
        if (!ms) return '';
        try {
            return new Intl.DateTimeFormat(currentAppLocale(), withTime
                ? { dateStyle: 'medium', timeStyle: 'short' }
                : { dateStyle: 'medium' }).format(new Date(ms));
        } catch {
            return new Date(ms).toLocaleString(currentAppLocale());
        }
    }

    function relativeTime(value) {
        const ms = toMillis(value);
        if (!ms) return '';
        const elapsed = Math.max(0, Date.now() - ms);
        const rtf = new Intl.RelativeTimeFormat(currentAppLocale(), { numeric: 'auto' });
        if (elapsed < 60_000) return rtf.format(0, 'second');
        if (elapsed < 3_600_000) return rtf.format(-Math.floor(elapsed / 60_000), 'minute');
        if (elapsed < 86_400_000) return rtf.format(-Math.floor(elapsed / 3_600_000), 'hour');
        return rtf.format(-Math.floor(elapsed / 86_400_000), 'day');
    }

    function getCurrentFriends() {
        try { return typeof currentFriends !== 'undefined' && Array.isArray(currentFriends) ? currentFriends : []; }
        catch { return []; }
    }

    function currentMediaItem() {
        try { return typeof activeMediaItem !== 'undefined' ? activeMediaItem : null; }
        catch { return null; }
    }

    function sessionUser() {
        try {
            return userSession?.result?.user || userSession?.user || null;
        } catch {
            return null;
        }
    }

    function coralToken() {
        try {
            if (typeof coralAccessToken === 'function') return coralAccessToken();
        } catch { }
        try {
            return userSession?.result?.webApiServerCredential?.accessToken ||
                userSession?.webApiServerCredential?.accessToken ||
                userSession?.accessToken || null;
        } catch {
            return null;
        }
    }

    /**
     * Exact-ish Coral call for the endpoints added by this native feature controller.
     * Existing project calls are intentionally not monkey-patched, so working
     * game services and auth remain untouched.
     */
    async function coralExact(name, parameter = undefined, bodyOverride = undefined, callOptions = {}) {
        const meta = ENDPOINTS[name];
        if (!meta) throw new Error(`Blocked unknown Coral operation: ${name}`);
        let body;
        if (bodyOverride !== undefined) {
            body = bodyOverride;
        } else if (meta.noParameter) {
            body = meta.requestId ? { requestId: uuid() } : {};
        } else {
            body = { parameter: parameter === undefined ? {} : parameter };
        }
        return coralCall(meta.path, parameter === undefined ? {} : parameter, {
            body,
            // Preserve the exact endpoint-specific Android flags. The generic legacy
            // Coral helper defaults both headers on, while this controller intentionally
            // sends only the headers recovered for each endpoint.
            platform: meta.platform === true,
            productVersion: meta.productVersion === true,
            cache: callOptions.cache,
            cacheTtlMs: callOptions.cacheTtlMs,
            forceRefresh: callOptions.forceRefresh === true,
            allowStaleOnError: callOptions.allowStaleOnError,
            staleIfErrorMs: callOptions.staleIfErrorMs,
            signal: callOptions.signal,
            cancelKey: callOptions.cancelKey
        });
    }

    function toast(message) {
        let el = $('nsoAppToast');
        if (!el) {
            el = document.createElement('div');
            el.id = 'nsoAppToast';
            el.className = 'op-toast';
            document.body.appendChild(el);
        }
        el.textContent = message;
        el.classList.add('show');
        clearTimeout(toast.timer);
        toast.timer = setTimeout(() => el.classList.remove('show'), 2200);
    }

    function bindControl(id, handler, options = {}) {
        const old = $(id);
        if (!old) return null;
        const next = old.cloneNode(true);
        old.replaceWith(next);
        if (handler) next.addEventListener(options.event || 'click', handler, Boolean(options.capture));
        return next;
    }

    function setBusy(button, busy, busyText = '') {
        if (!button) return;
        if (busy) {
            if (button.dataset.opBusy === 'true') return;
            button.dataset.opBusy = 'true';
            button.dataset.opWasDisabled = button.disabled ? 'true' : 'false';
            button.disabled = true;
            button.setAttribute('aria-busy', 'true');
            button.style.opacity = '0.68';

            // Only snapshot/replace the label when a temporary busy label is requested.
            // This prevents stateful buttons (Best Friends / Notify When Online) from
            // reverting to stale HTML after their successful state update.
            if (busyText) {
                button.dataset.opBusyHtml = button.innerHTML;
                button.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> ${escapeHtml(busyText)}`;
            }
        } else {
            button.disabled = button.dataset.opWasDisabled === 'true';
            button.removeAttribute('aria-busy');
            button.style.removeProperty('opacity');

            if (button.dataset.opBusyHtml != null) {
                button.innerHTML = button.dataset.opBusyHtml;
            }

            delete button.dataset.opBusy;
            delete button.dataset.opWasDisabled;
            delete button.dataset.opBusyHtml;
        }
    }

    function closeAppScreens(except = null) {
        document.querySelectorAll('.op-screen').forEach((screen) => {
            if (screen.id === except) return;
            if (typeof hideViewInstant === 'function') hideViewInstant(screen);
            else screen.classList.add('hidden');
        });
    }

    window.nsoCloseAppScreens = () => closeAppScreens();

    let openScreenToken = 0;

    function openScreen(id) {
        const screen = $(id);
        if (!screen) return;
        const token = ++openScreenToken;
        if (typeof slideViewIn === 'function') {
            // Bring this screen to the front of the op-screen stack so it paints
            // over the previously visible screen during the slide-in, and only
            // hide the others once it has fully covered the viewport. Hiding them
            // up front would expose the home screen through the fade transition.
            document.body.appendChild(screen);
            slideViewIn(screen);
            screen.addEventListener('animationend', () => {
                if (token !== openScreenToken || screen.classList.contains('view-slide-out')) return;
                closeAppScreens(id);
            }, { once: true });
        } else {
            closeAppScreens(id);
            screen.classList.remove('hidden');
        }
        window.scrollTo({ top: 0, behavior: 'auto' });
    }

    function screenShell(id, title, bodyHtml, extraClass = '') {
        const section = document.createElement('section');
        section.className = `op-screen hidden ${extraClass}`.trim();
        section.id = id;
        section.innerHTML = `
            <header class="op-header">
                <button type="button" class="op-back" aria-label="Back"><i class="fa-solid fa-arrow-left"></i></button>
                <h2>${escapeHtml(title)}</h2>
                <span class="op-header-spacer"></span>
            </header>
            <div class="op-scroll">${bodyHtml}</div>`;
        section.querySelector('.op-back')?.addEventListener('click', () => section.classList.add('hidden'));
        document.body.appendChild(section);
        return section;
    }

    function ensureScreens() {
        if (state.screensReady) return;
        state.screensReady = true;

        screenShell('opUserPage', 'User Page', `
            <div class="native-user-page">
                <header class="native-user-hero">
                    <img id="opUserAvatar" src="" alt="User icon">
                    <h3 id="opUserName">Switch Player</h3>
                </header>

                <section class="native-user-card native-friend-code-card" aria-labelledby="nativeFriendCodeLabel">
                    <div class="native-friend-code-copy">
                        <span class="native-user-label" id="nativeFriendCodeLabel">Friend Code</span>
                        <button id="nativeFriendCodeCopyBtn" class="native-friend-code-button" type="button" aria-label="Copy friend code">
                            <span id="opFriendCode">SW-0000-0000-0000</span>
                            <i class="fa-regular fa-copy" aria-hidden="true"></i>
                        </button>
                        <span class="native-copy-status" id="nativeCopyStatus" aria-live="polite"></span>
                    </div>
                </section>

                <div class="native-user-actions" aria-label="Profile actions">
                    <button class="native-user-action-card" id="nativeAddFriendBtn" type="button">
                        <i class="fa-regular fa-face-smile"></i>
                        <span>Add Friend</span>
                    </button>
                    <button class="native-user-action-card" id="nativeSettingsBtn" type="button">
                        <i class="fa-solid fa-sun"></i>
                        <span>Settings</span>
                    </button>
                </div>

                <section class="native-user-section" aria-labelledby="nativeOnlineStatusHeading">
                    <div class="native-user-section-head">
                        <div>
                            <strong id="nativeOnlineStatusHeading">Online Status</strong>
                            <span id="opOnlineStatusSummary">—</span>
                        </div>
                        <button class="native-user-change" id="nativeOnlineStatusChangeBtn" type="button">
                            <i class="fa-solid fa-circle-chevron-right"></i> Change
                        </button>
                    </div>
                    <div class="native-user-presence" id="nativeOwnPresence">
                        <div class="native-user-offline">Offline</div>
                    </div>
                </section>

                <section class="native-user-section native-play-section" aria-labelledby="nativePlayActivityHeading">
                    <div class="native-user-section-head">
                        <div>
                            <strong id="nativePlayActivityHeading">Play Activity</strong>
                            <span id="opPlayActivitySummary">—</span>
                        </div>
                        <button class="native-user-change" id="nativePlayActivityChangeBtn" type="button">
                            <i class="fa-solid fa-circle-chevron-right"></i> Change
                        </button>
                    </div>
                    <div class="native-user-play-list" id="nativePlayActivityList">
                        <p class="native-user-loading">Loading play activity…</p>
                    </div>
                </section>
            </div>`);

        screenShell('opVisibilityPage', 'Setting', `<div id="opVisibilityBody"></div>`);
        screenShell('opPushPage', 'Push Notifications', `<div id="opPushBody"></div>`);
        screenShell('opFriendOnlinePage', 'Notify When Friends Go Online', `
            <div class="op-info-card">You'll get online-status notifications for friends (max of once per 30 mins. for each friend).</div>
            <div id="opFriendOnlineList" class="op-list"></div>`);
        screenShell('opSettingsPage', 'Settings', `<div id="opSettingsBody"></div>`);
        screenShell('opLanguagePage', 'Language', `<div id="opLanguageBody"></div>`);
        screenShell('opDarkModePage', 'Dark Mode', `<div id="opDarkModeBody"></div>`);
        screenShell('opMobileDataPage', 'Mobile Data', `<div id="opMobileDataBody"></div>`);
        screenShell('opUsageDataPage', 'About Sending Usage Data', `<div id="opUsageDataBody"></div>`);
        screenShell('opLegalPage', 'Intellectual Property Notices', `<div id="opLegalBody"></div>`);
        screenShell('opLicenseDetailPage', 'License', `<div id="opLicenseDetailBody"></div>`);
        screenShell('opFeedbackPage', 'Feedback', `<div id="opFeedbackBody"></div>`);
        screenShell('opAnnouncementPage', 'Notifications', `<div id="opAnnouncementBody"></div>`);
        screenShell('opAnnouncementDetailPage', 'Notification', `<div id="opAnnouncementDetailBody"></div>`);
        screenShell('opChatPage', 'GameChat', `<div id="opChatBody"></div>`);
        screenShell('opChatDetailPage', 'GameChat', `<div id="opChatDetailBody"></div>`);
        screenShell('opChatCandidatePage', "Users You've Chatted With", `<div id="opChatCandidateBody"></div>`);
        screenShell('opFriendNotePage', 'Add Note', `<div id="opFriendNoteBody"></div>`);
        screenShell('opAlbumAboutPage', 'About the Upload Feature', `
            <div class="op-copy-page">
                <p>Screenshots and videos uploaded from your Nintendo Switch 2 console will be displayed here.</p>
                <h3>How to Upload</h3>
                <ol class="op-steps">
                    <li><b>Power on your Nintendo Switch 2 system.</b><small>${escapeHtml(trKey('Album_How_To_Upload_1_Notice'))}</small></li>
                    <li><b>Open the album.</b></li>
                    <li><b>Upload screenshots and videos.</b><small>Pick which screenshots and videos you want to upload and then select Upload to Smart Device.</small></li>
                </ol>
                <div class="op-info-card">${escapeHtml(trKey('Album_Due_Notice'))}<br><br>${escapeHtml(trKey('Album_Restriction_Body'))}</div>
                <h3>Uploading Made Easy With Automatic Uploads</h3>
                <p>The automatic uploads feature allows you to automatically upload any screenshot or video as soon as you capture it.</p>
                <p class="op-muted">You can enable automatic uploads from the upload settings on your Nintendo Switch 2 console.</p>
            </div>`);

        wireScreenBackNavigation();
    }

    function wireScreenBackNavigation() {
        const parents = {
            opVisibilityPage: () => state.visibilityReturnTarget || 'opUserPage',
            opPushPage: () => state.pushReturnTarget || 'opSettingsPage',
            opSettingsPage: 'opUserPage',
            opLanguagePage: 'opSettingsPage',
            opDarkModePage: 'opSettingsPage',
            opMobileDataPage: 'opSettingsPage',
            opUsageDataPage: 'opSettingsPage',
            opLegalPage: 'opSettingsPage',
            opLicenseDetailPage: 'opLegalPage',
            opFeedbackPage: 'opSettingsPage',
            opAnnouncementDetailPage: 'opAnnouncementPage',
            opChatDetailPage: 'opChatPage',
            opChatCandidatePage: 'chattedUsersView',
            opFriendNotePage: 'friendDetailView'
        };
        for (const [child, parentSpec] of Object.entries(parents)) {
            const back = $(child)?.querySelector('.op-back');
            if (!back) continue;
            replaceNodeListener(back, () => {
                const parent = typeof parentSpec === 'function' ? parentSpec() : parentSpec;
                const childView = $(child);
                const parentView = $(parent);

                if ((child === 'opChatCandidatePage' || child === 'opPushPage') && childView && parentView && typeof nsoApkBack === 'function') {
                    nsoApkBack(childView, parentView);
                    return;
                }

                const revealParent = () => {
                    if (parent.startsWith('op')) {
                        // Unhide the parent so it paints underneath the exiting
                        // child (it was appended before the child). No animation:
                        // the child covers it until it starts sliding out.
                        if (parentView?.classList.contains('hidden')) {
                            if (typeof showViewInstant === 'function') showViewInstant(parentView);
                            else parentView.classList.remove('hidden');
                        }
                        return;
                    }
                    if (parentView?.classList.contains('hidden')) {
                        if (typeof slideViewIn === 'function') slideViewIn(parentView);
                        else parentView.classList.remove('hidden');
                    }
                };

                if (childView && typeof slideViewOut === 'function') {
                    // Reveal the parent underneath BEFORE the child starts
                    // sliding out, so the home screen never shows through the
                    // exit animation.
                    revealParent();
                    slideViewOut(childView);
                } else {
                    childView?.classList.add('hidden');
                    revealParent();
                }
            });
        }

        const friendOnlineBack = $('opFriendOnlinePage')?.querySelector('.op-back');
        if (friendOnlineBack) {
            replaceNodeListener(friendOnlineBack, () => {
                const childView = $('opFriendOnlinePage');
                const revealParent = () => {
                    const parent = state.friendOnlineReturnTarget || 'opPushPage';
                    const parentView = $(parent);
                    if (parent.startsWith('op')) {
                        if (parentView?.classList.contains('hidden')) {
                            if (typeof showViewInstant === 'function') showViewInstant(parentView);
                            else parentView.classList.remove('hidden');
                        }
                        return;
                    }
                    if (parentView?.classList.contains('hidden')) {
                        if (typeof slideViewIn === 'function') slideViewIn(parentView);
                        else parentView.classList.remove('hidden');
                    }
                };

                if (childView && typeof slideViewOut === 'function') {
                    revealParent();
                    slideViewOut(childView);
                } else {
                    childView?.classList.add('hidden');
                    revealParent();
                }
            });
        }
    }

    function replaceNodeListener(node, handler) {
        const clone = node.cloneNode(true);
        node.replaceWith(clone);
        clone.addEventListener('click', handler);
        return clone;
    }

    function permissionLabel(kind, value) {
        if (kind === 'presence') {
            return ({
                FRIENDS: trKey('Common_Visibility_Friends'),
                FAVORITE_FRIENDS: trKey('Common_Visibility_Best_Friends_Below'),
                SELF: trKey('Common_Visibility_No_One')
            })[value] || value || '—';
        }
        return ({
            EVERYONE: trKey('Common_Visibility_All_Users'),
            FRIENDS: trKey('Common_Visibility_Friends_Below'),
            FAVORITE_FRIENDS: trKey('Common_Visibility_Best_Friends_Below'),
            SELF: trKey('Common_Visibility_No_One')
        })[value] || value || '—';
    }

    async function loadCurrentUserAndPermissions(force = false) {
        if (!force && state.currentUser && state.permissions) return;
        const base = sessionUser();
        const id = Number(base?.id || 0);
        const calls = [
            id ? coralExact('currentUser', { id }).catch(() => base) : Promise.resolve(base),
            coralExact('permissions').catch(() => null)
        ];
        const [user, permissions] = await Promise.all(calls);
        if (user) {
            state.currentUser = user;
            window.nsoSetLocalizationUser?.(user);
        }
        if (permissions) state.permissions = permissions;
        if (localSetting('language', 'account') === 'account') applyAppLanguage(document);
    }

    function ownPresencePlatformLabel(presence) {
        const raw = presence?.platform;
        const normalized = String(raw ?? '').trim().toUpperCase().replace(/[\s-]+/g, '_');
        if (raw === 2 || normalized === '2' || normalized === 'OUNCE' ||
            normalized === 'NINTENDO_SWITCH_2' || normalized === 'SWITCH_2' || normalized === 'SWITCH2') {
            return 'Nintendo Switch 2';
        }
        if (raw === 1 || normalized === '1' || normalized === 'NX' ||
            normalized === 'NINTENDO_SWITCH' || normalized === 'SWITCH') {
            return 'Nintendo Switch';
        }
        // Older Coral responses did not expose the platform field. Those responses
        // predate Nintendo Switch 2, so Nintendo Switch is the closest native label.
        return 'Nintendo Switch';
    }

    function formatOwnOfflinePresence(user, presence) {
        const lastSeen = toMillis(
            presence?.updatedAt ?? presence?.logoutAt ?? presence?.lastOnlineAt ??
            user?.presenceUpdatedAt ?? user?.lastOnlineAt
        );
        if (!lastSeen) return 'Offline';

        const elapsedMs = Math.max(0, Date.now() - lastSeen);
        const minutes = Math.floor(elapsedMs / 60000);
        const hours = Math.floor(elapsedMs / 3600000);
        if (hours < 1) return trFormat('FriendDetails_Label_Presence_Offline_Minute', Math.max(1, minutes));
        if (hours < 48) return trFormat('FriendDetails_Label_Presence_Offline_Hour', hours);
        return trFormat('FriendDetails_Label_Presence_Offline_Day', Math.floor(hours / 24));
    }

    function renderOwnPresence(user) {
        const host = $('nativeOwnPresence');
        if (!host) return;
        host.replaceChildren();

        const presence = user?.presence || sessionUser()?.presence || null;
        const presenceState = String(presence?.state || presence?.status || '').toUpperCase();
        const isOnline = presenceState === 'ONLINE' || presenceState === 'PLAYING';
        const game = presence?.game && typeof presence.game === 'object' ? presence.game : null;
        const hasGame = Boolean(isOnline && game?.name);

        if (!hasGame) {
            const status = document.createElement('div');
            status.className = 'native-user-offline';
            status.textContent = isOnline
                ? `Online (${ownPresencePlatformLabel(presence)})`
                : formatOwnOfflinePresence(user, presence);
            host.appendChild(status);
            return;
        }

        const row = document.createElement('button');
        row.type = 'button';
        row.className = 'native-user-presence-row';
        row.setAttribute('aria-label', `${trKey('A11y_More_Info')}: ${game.name}`);

        const image = document.createElement('img');
        image.src = game.imageUri || '';
        image.alt = '';
        image.loading = 'eager';
        image.addEventListener('error', () => image.classList.add('native-user-presence-image-missing'));

        const copy = document.createElement('span');
        copy.className = 'native-user-presence-copy';

        const online = document.createElement('span');
        online.className = 'native-user-presence-online';
        online.textContent = `Online (${ownPresencePlatformLabel(presence)})`;

        const title = document.createElement('strong');
        title.textContent = game.name || 'Game';

        copy.append(online, title);
        row.append(image, copy);

        if (typeof openGameSheet === 'function') {
            row.addEventListener('click', () => openGameSheet({
                name: game.name || 'Game',
                imageUri: game.imageUri || '',
                shopUri: game.shopUri || ''
            }));
        } else {
            row.disabled = true;
        }

        host.appendChild(row);
    }

    function ownPlayTimeText(totalPlayTime) {
        const minutes = Number(totalPlayTime || 0);
        if (!Number.isFinite(minutes) || minutes < 60) {
            return trKey('FriendDetails_Label_Play_Log_Little');
        }
        const hours = Math.max(1, Math.round(minutes / 60));
        return trFormat('FriendDetails_Label_Play_Log_Time', hours);
    }

    function renderOwnPlayLogs(playLogs = []) {
        const host = $('nativePlayActivityList');
        if (!host) return;
        host.replaceChildren();

        if (!Array.isArray(playLogs) || playLogs.length === 0) {
            const empty = document.createElement('p');
            empty.className = 'native-user-empty';
            empty.textContent = trKey('Common_PlayActivity_Empty');
            host.appendChild(empty);
            return;
        }

        for (const log of playLogs) {
            const row = document.createElement('button');
            row.type = 'button';
            row.className = 'native-user-play-row';

            const image = document.createElement('img');
            image.src = log.imageUri || '';
            image.alt = '';
            image.loading = 'eager';
            image.addEventListener('error', () => image.classList.add('native-user-play-image-missing'));

            const copy = document.createElement('span');
            copy.className = 'native-user-play-copy';
            const title = document.createElement('strong');
            title.textContent = log.name || 'Game';
            const playtime = document.createElement('span');
            const minutes = Number(log.totalPlayTime || 0);
            playtime.textContent = ownPlayTimeText(minutes);
            playtime.className = Number.isFinite(minutes) && minutes >= 3000
                ? 'native-playtime-highlight'
                : 'native-playtime-normal';
            copy.append(title, playtime);
            row.append(image, copy);

            if (typeof openGameSheet === 'function') {
                row.addEventListener('click', () => openGameSheet({
                    name: log.name || 'Game',
                    imageUri: log.imageUri || '',
                    shopUri: log.shopUri || ''
                }));
            } else {
                row.disabled = true;
            }
            host.appendChild(row);
        }
    }

    async function loadOwnPlayLogs(force = false) {
        const user = state.currentUser || sessionUser() || {};
        const nsaId = String(user.nsaId || '');
        const host = $('nativePlayActivityList');
        if (!host) return;
        if (!nsaId) {
            renderOwnPlayLogs([]);
            return;
        }

        const isFresh = state.ownPlayLogsNsaId === nsaId &&
            Date.now() - state.ownPlayLogsLoadedAt < 5 * 60 * 1000;
        if (!force && isFresh) {
            renderOwnPlayLogs(state.ownPlayLogs);
            return;
        }
        if (state.ownPlayLogsPromise) return state.ownPlayLogsPromise;

        host.innerHTML = `<p class="native-user-loading">${escapeHtml(trKey('GameWebView_Initial_Loading_Label'))}</p>`;
        state.ownPlayLogsPromise = (async () => {
            try {
                const result = await coralExact('friendPlayLog', { nsaId });
                const logs = Array.isArray(result) ? result : (result?.playLogs || []);
                state.ownPlayLogs = logs;
                state.ownPlayLogsNsaId = nsaId;
                state.ownPlayLogsLoadedAt = Date.now();
                renderOwnPlayLogs(logs);
            } catch {
                host.innerHTML = `<p class="native-user-empty">${escapeHtml(trKey('Common_PlayActivity_Empty'))}</p>`;
            } finally {
                state.ownPlayLogsPromise = null;
            }
        })();
        return state.ownPlayLogsPromise;
    }

    async function copyOwnFriendCode() {
        const value = $('opFriendCode')?.textContent?.trim();
        if (!value || value === '—') return;
        try {
            if (navigator.clipboard?.writeText) {
                await navigator.clipboard.writeText(value);
            } else {
                const input = document.createElement('textarea');
                input.value = value;
                input.style.position = 'fixed';
                input.style.opacity = '0';
                document.body.appendChild(input);
                input.select();
                document.execCommand('copy');
                input.remove();
            }
            const status = $('nativeCopyStatus');
            if (status) status.textContent = tr('Copied');
            setTimeout(() => {
                if (status) status.textContent = '';
            }, 1200);
        } catch {
            toast(tr('Could not copy the friend code.'));
        }
    }

    async function openUserPage(options = {}) {
        ensureScreens();
        const userPage = $('opUserPage');
        assignPersistentViewOwner(userPage, activeAppTab);

        const user = state.currentUser || sessionUser() || {};
        $('opUserAvatar').src = user.imageUri || user.image2Uri || $('profileViewAvatar')?.src || '';
        $('opUserName').textContent = user.name || user.nickname || $('profileViewName')?.textContent || 'Switch Player';
        $('opFriendCode').textContent = user.links?.friendCode?.id || $('profileViewFriendCode')?.textContent || '—';
        renderOwnPresence(user);

        const backFromId = String(options.backFrom || '');
        const backFrom = backFromId ? $(backFromId) : null;
        if (backFrom && userPage && typeof nsoApkBack === 'function') {
            ++openScreenToken;
            await nsoApkBack(backFrom, userPage);
            closeAppScreens('opUserPage');
        } else {
            openScreen('opUserPage');
        }
        applyAppLanguage(userPage || document);

        void (async () => {
            try {
                await loadCurrentUserAndPermissions(true);
                const full = state.currentUser || user;
                $('opUserAvatar').src = full.imageUri || full.image2Uri || $('opUserAvatar').src;
                $('opUserName').textContent = full.name || full.nickname || $('opUserName').textContent;
                $('opFriendCode').textContent = full.links?.friendCode?.id || $('opFriendCode').textContent;
                renderOwnPresence(full);
                const permissions = state.permissions?.permissions || full.permissions || {};
                $('opOnlineStatusSummary').textContent = permissionLabel('presence', permissions.presence);
                $('opPlayActivitySummary').textContent = permissionLabel('playLog', permissions.playLog);
                if (localSetting('language', 'account') === 'account') applyAppLanguage(document);
                await loadOwnPlayLogs(false);
            } catch {
                await loadOwnPlayLogs(false);
            }
        })();
    }

    async function openVisibility(kind, returnTarget = 'opUserPage') {
        ensureScreens();
        state.visibilityReturnTarget = returnTarget || 'opUserPage';
        await loadCurrentUserAndPermissions();
        const isPresence = kind === 'presence';
        const screen = $('opVisibilityPage');
        const title = isPresence ? trKey('Other_Page_Title_Online_Status') : trKey('Profile_PlayActivity');
        screen.querySelector('h2').textContent = title;
        const current = state.permissions?.permissions?.[kind] || state.currentUser?.permissions?.[kind];
        const options = isPresence
            ? [
                ['FRIENDS', trKey('Common_Visibility_Friends')],
                ['FAVORITE_FRIENDS', trKey('Common_Visibility_Best_Friends_Below')],
                ['SELF', trKey('Common_Visibility_No_One')]
            ]
            : [
                ['EVERYONE', trKey('Common_Visibility_All_Users')],
                ['FRIENDS', trKey('Common_Visibility_Friends_Below')],
                ['FAVORITE_FRIENDS', trKey('Common_Visibility_Best_Friends_Below')],
                ['SELF', trKey('Common_Visibility_No_One')]
            ];
        const notice = isPresence
            ? trKey('Other_Label_Online_Status_Description')
            : trKey('PlayActivity_Settings_Notice');

        $('opVisibilityBody').innerHTML = `
            <p class="op-page-prompt">${escapeHtml(isPresence ? trKey('Other_Page_Title_Online_Status') : trKey('Profile_PlayActivity'))}</p>
            <div class="op-radio-list">
                ${options.map(([value, label]) => `<label class="op-radio-row"><span>${escapeHtml(label)}</span><input type="radio" name="opVisibility" value="${value}" ${value === current ? 'checked' : ''}></label>`).join('')}
            </div>
            <div class="op-info-card">${escapeHtml(notice)}</div>`;
        openScreen('opVisibilityPage');

        $('opVisibilityBody').querySelectorAll('input[name="opVisibility"]').forEach((input) => {
            input.addEventListener('change', async () => {
                if (!input.checked) return;
                const value = input.value;
                $('opVisibilityBody').querySelectorAll('input').forEach((x) => x.disabled = true);
                try {
                    await coralExact('permissionsWrite', { permissions: { [kind]: value } });
                    state.permissions = state.permissions || { permissions: {} };
                    state.permissions.permissions = state.permissions.permissions || {};
                    state.permissions.permissions[kind] = value;
                    if (kind === 'presence') $('opOnlineStatusSummary').textContent = permissionLabel(kind, value);
                    else $('opPlayActivitySummary').textContent = permissionLabel(kind, value);
                    toast(tr('Setting changed.'));
                } catch (error) {
                    console.error('[UI action] request failed', error); alert(trKey('Error_Dialog_Message_CommunicationFailed'));
                    input.checked = false;
                    const old = $('opVisibilityBody').querySelector(`input[value="${CSS.escape(current || '')}"]`);
                    if (old) old.checked = true;
                } finally {
                    $('opVisibilityBody').querySelectorAll('input').forEach((x) => x.disabled = false);
                }
            });
        });
    }

    function normalizePushList(result) {
        if (!result || typeof result !== 'object') return {};
        return result.settings || result;
    }

    async function loadPushSettings(force = false) {
        if (!force && state.pushSettings) return state.pushSettings;
        state.pushSettings = normalizePushList(await coralExact('pushList'));
        return state.pushSettings;
    }

    async function loadWebServicesForSettings(force = false) {
        if (!force && state.webServices.length) return state.webServices;
        const result = await coralExact('webServices');
        state.webServices = Array.isArray(result) ? result : (result?.webServices || []);
        return state.webServices;
    }

    async function updatePush(item) {
        await coralExact('pushUpdate', [item]);
        if (item.type === 'friendRequest') state.pushSettings.friendRequest = item.value;
        if (item.type === 'chatInvitation') state.pushSettings.chatInvitation = item.value;
        if (item.type === 'playInvitation') state.pushSettings.playInvitation = item.scope;
    }

    const BROWSER_NOTIFICATION_SETTING_KEY = 'nso_browser_notifications_enabled';

    function browserNotificationSupport() {
        if (!('Notification' in window)) {
            return { supported: false, permission: 'unsupported', enabled: false };
        }

        let preference = localSetting('browser_notifications', '');
        if (!preference) {
            try {
                const legacy = localStorage.getItem(BROWSER_NOTIFICATION_SETTING_KEY);
                if (legacy === 'true') preference = 'on';
                else if (legacy != null) preference = 'off';
                if (preference) saveLocalSetting('browser_notifications', preference);
            } catch { }
        }

        const optedIn = preference === 'on';
        return {
            supported: true,
            permission: Notification.permission,
            enabled: optedIn && Notification.permission === 'granted'
        };
    }

    function setBrowserNotificationPreference(enabled) {
        saveLocalSetting('browser_notifications', enabled ? 'on' : 'off');
        try {
            if (enabled) localStorage.setItem(BROWSER_NOTIFICATION_SETTING_KEY, 'true');
            else localStorage.removeItem(BROWSER_NOTIFICATION_SETTING_KEY);
        } catch { }
    }

    function browserNotificationExplanation() {
        return tr('Show Nintendo Switch App notifications in this browser while this web app is open. They follow your Nintendo notification settings. Nintendo and nxapi credentials are not stored for browser notifications.');
    }

    function browserNotificationKey(item, fallbackPrefix) {
        const id = item?.id ?? item?.notificationId ?? item?.chatId ?? item?.requestId ?? item?.nsaId;
        return id !== undefined && id !== null && String(id)
            ? String(id)
            : `${fallbackPrefix}:${String(item?.createdAt || item?.updatedAt || item?.sentAt || '')}:${String(item?.name || item?.title || '')}`;
    }

    function personFromRequest(request) {
        return request?.sender || request?.user || request?.friend || request?.from || request?.requester || {};
    }

    function isFriendOnline(friend) {
        const presence = friend?.presence || {};
        const stateName = String(presence.state || friend?.state || '').toUpperCase();
        return Boolean(friend?.isOnline) || stateName === 'ONLINE' || stateName === 'PLAYING';
    }

    function fireBrowserNotification(title, options = {}, onClick = null) {
        const status = browserNotificationSupport();
        if (!status.enabled) return;
        // The native UI is already visible while this tab has focus. Use the OS/browser
        // surface when the NSO page is in the background to avoid duplicate alerts.
        if (document.visibilityState === 'visible' && document.hasFocus()) return;

        try {
            const notification = new Notification(title, {
                body: options.body || '',
                icon: options.icon || sessionUser()?.imageUri || '',
                tag: options.tag || undefined,
                renotify: options.renotify === true,
                silent: false
            });
            notification.onclick = () => {
                try { window.focus(); } catch (e) { }
                try { notification.close(); } catch (e) { }
                if (typeof onClick === 'function') {
                    try { onClick(); } catch (e) { }
                }
            };
        } catch (error) {
            console.warn('[BrowserNotifications] Notification creation failed:', error);
        }
    }

    function resetBrowserNotificationBaseline() {
        const monitor = state.browserNotifications;
        monitor.baselineReady = false;
        monitor.announcementIds.clear();
        monitor.requestIds.clear();
        monitor.chatIds.clear();
        monitor.activeEventKey = '';
        monitor.friendOnline.clear();
        monitor.lastPollAt = 0;
    }

    function stopBrowserNotificationMonitor() {
        const monitor = state.browserNotifications;
        if (monitor.timer) clearTimeout(monitor.timer);
        monitor.timer = null;
        monitor.running = false;
    }

    function scheduleBrowserNotificationPoll(delayMs) {
        const monitor = state.browserNotifications;
        if (monitor.timer) clearTimeout(monitor.timer);
        if (!browserNotificationSupport().enabled || !coralToken()) {
            monitor.timer = null;
            return;
        }
        monitor.timer = setTimeout(() => {
            monitor.timer = null;
            pollBrowserNotifications().catch((error) => {
                console.warn('[BrowserNotifications] Poll failed:', error);
            });
        }, Math.max(0, Number(delayMs) || 0));
    }

    async function pollBrowserNotifications() {
        const monitor = state.browserNotifications;
        if (monitor.running || !browserNotificationSupport().enabled || !coralToken()) return;

        // Coral traffic is encrypted/decrypted through nxapi. Browser notification
        // polling must never compete with sign-in or GameWebServiceToken traffic, so
        // foreground/background lifecycle events cannot force rapid repeated polls.
        const minimumGap = monitor.baselineReady ? (document.hidden ? 10 * 60_000 : 15 * 60_000) : 0;
        const elapsed = Date.now() - Number(monitor.lastPollAt || 0);
        if (minimumGap && elapsed < minimumGap) {
            scheduleBrowserNotificationPoll(minimumGap - elapsed);
            return;
        }

        monitor.running = true;
        monitor.lastPollAt = Date.now();

        try {
            const settings = await loadPushSettings().catch(() => state.pushSettings || {});
            const jobs = [
                coralExact('announcements').then((value) => ({ type: 'announcements', value })).catch(() => null),
                coralExact('friends').then((value) => ({ type: 'friends', value })).catch(() => null)
            ];
            if (settings?.friendRequest) {
                jobs.push(coralExact('receivedRequests').then((value) => ({ type: 'requests', value })).catch(() => null));
            }
            if (settings?.chatInvitation) {
                jobs.push(coralExact('chats').then((value) => ({ type: 'chats', value })).catch(() => null));
            }
            if (settings?.playInvitation && settings.playInvitation !== 'NONE') {
                jobs.push(coralExact('activeEvent').then((value) => ({ type: 'active-event', value })).catch(() => null));
            }

            const results = (await Promise.all(jobs)).filter(Boolean);
            const baselineOnly = !monitor.baselineReady;

            for (const result of results) {
                if (result.type === 'announcements') {
                    const items = Array.isArray(result.value) ? result.value : (result.value?.announcements || []);
                    state.announcements = items;
                    updateAnnouncementDot();
                    const next = new Set();
                    for (const item of items) {
                        const key = browserNotificationKey(item, 'announcement');
                        next.add(key);
                        if (!baselineOnly && !monitor.announcementIds.has(key) && item?.isRead !== true) {
                            fireBrowserNotification(
                                item?.title || 'Nintendo Switch App',
                                {
                                    body: item?.description || item?.body || item?.message || tr('You have a new notification.'),
                                    icon: item?.imageUri || undefined,
                                    tag: `nso-announcement-${key}`
                                },
                                () => openAnnouncements()
                            );
                        }
                    }
                    monitor.announcementIds = next;
                }

                if (result.type === 'requests') {
                    const items = Array.isArray(result.value)
                        ? result.value
                        : (result.value?.friendRequests || result.value?.requests || []);
                    const next = new Set();
                    for (const request of items) {
                        const key = browserNotificationKey(request, 'friend-request');
                        next.add(key);
                        if (!baselineOnly && !monitor.requestIds.has(key)) {
                            const person = personFromRequest(request);
                            fireBrowserNotification(
                                trKey('Notification_Settings_Friend_Request'),
                                {
                                    body: person?.name ? trVars('{name} sent you a friend request.', { name: person.name }) : trKey('Onboarding_Notification_Friend_Request'),
                                    icon: person?.imageUri || person?.image2Uri || undefined,
                                    tag: `nso-friend-request-${key}`
                                },
                                () => $('openAddFriendBtn')?.click()
                            );
                        }
                    }
                    monitor.requestIds = next;
                }

                if (result.type === 'chats') {
                    const items = Array.isArray(result.value) ? result.value : (result.value?.chats || result.value?.chatList || []);
                    const next = new Set();
                    for (const chat of items) {
                        const key = browserNotificationKey(chat, 'chat');
                        next.add(key);
                        if (!baselineOnly && !monitor.chatIds.has(key)) {
                            const host = chat?.owner || chat?.host || chat?.user || {};
                            fireBrowserNotification(
                                trKey('Notification_Settings_Chat_Invitation'),
                                {
                                    body: host?.name ? trVars('{name} invited you to GameChat.', { name: host.name }) : trKey('Onboarding_Notification_Chat_Invitation'),
                                    icon: host?.imageUri || undefined,
                                    tag: `nso-chat-${key}`
                                },
                                () => openChatPage()
                            );
                        }
                    }
                    monitor.chatIds = next;
                }

                if (result.type === 'active-event') {
                    const event = result.value?.event || result.value || null;
                    const key = event ? browserNotificationKey(event, 'active-event') : '';
                    if (!baselineOnly && key && monitor.activeEventKey && key !== monitor.activeEventKey) {
                        const inviter = event?.owner || event?.host || event?.inviter || {};
                        fireBrowserNotification(
                            trKey('Notification_Settings_Friend_Online_Play'),
                            {
                                body: inviter?.name ? trVars('{name} invited you to play.', { name: inviter.name }) : tr('You have a new online play invitation.'),
                                icon: inviter?.imageUri || undefined,
                                tag: `nso-play-invite-${key}`
                            },
                            () => openChatPage()
                        );
                    }
                    monitor.activeEventKey = key;
                }

                if (result.type === 'friends') {
                    const friends = Array.isArray(result.value) ? result.value : (result.value?.friends || []);
                    const next = new Map();
                    const now = Date.now();
                    for (const friend of friends) {
                        const id = String(friend?.nsaId || friend?.id || '');
                        if (!id) continue;
                        const online = isFriendOnline(friend);
                        next.set(id, online);
                        const wasOnline = monitor.friendOnline.get(id);
                        const wantsNotice = friend?.isOnlineNotificationEnabled === true;
                        const lastNotice = monitor.lastFriendOnlineNotice.get(id) || 0;
                        if (!baselineOnly && wantsNotice && wasOnline === false && online && now - lastNotice > 30 * 60 * 1000) {
                            monitor.lastFriendOnlineNotice.set(id, now);
                            fireBrowserNotification(
                                trKey('Notification_Settings_Friend_Online'),
                                {
                                    body: friend?.name ? trVars('{name} is online.', { name: friend.name }) : trKey('Onboarding_Notification_Friend_Online'),
                                    icon: friend?.imageUri || friend?.image2Uri || undefined,
                                    tag: `nso-friend-online-${id}`
                                },
                                () => openFriendDetail(friend)
                            );
                        }
                    }
                    monitor.friendOnline = next;
                }
            }

            monitor.baselineReady = true;
        } finally {
            monitor.running = false;
            // Keep polling deliberately conservative: Coral calls are authenticated and
            // encrypted through nxapi, so browser notifications must not become a request storm.
            if (browserNotificationSupport().enabled && coralToken()) {
                const steadyDelay = document.hidden ? 10 * 60_000 : 15 * 60_000;
                const rateLimitUntil = typeof getRateLimitUntil === 'function'
                    ? Math.max(getRateLimitUntil('auth'), getRateLimitUntil('encrypt'), getRateLimitUntil('decrypt'))
                    : 0;
                const rateLimitDelay = rateLimitUntil > Date.now() ? (rateLimitUntil - Date.now() + 2000) : 0;
                scheduleBrowserNotificationPoll(Math.max(steadyDelay, rateLimitDelay));
            }
        }
    }

    function startBrowserNotificationMonitor({ resetBaseline = false, immediate = true } = {}) {
        if (!browserNotificationSupport().enabled || !coralToken()) {
            stopBrowserNotificationMonitor();
            return;
        }
        if (resetBaseline) resetBrowserNotificationBaseline();
        scheduleBrowserNotificationPoll(immediate ? 0 : (document.hidden ? 10 * 60_000 : 15 * 60_000));
    }

    async function setBrowserNotificationsEnabled(enabled) {
        const status = browserNotificationSupport();
        if (!status.supported || status.permission === 'denied') {
            setBrowserNotificationPreference(false);
            stopBrowserNotificationMonitor();
            return false;
        }

        if (!enabled) {
            setBrowserNotificationPreference(false);
            stopBrowserNotificationMonitor();
            return false;
        }

        let permission = status.permission;
        if (permission !== 'granted') permission = await Notification.requestPermission();

        const granted = permission === 'granted';
        setBrowserNotificationPreference(granted);
        if (granted) startBrowserNotificationMonitor({ resetBaseline: true, immediate: true });
        else stopBrowserNotificationMonitor();
        return granted;
    }

    function installBrowserNotificationLifecycle() {
        if (window.__nsoBrowserNotificationLifecycleInstalled) return;
        window.__nsoBrowserNotificationLifecycleInstalled = true;
        document.addEventListener('visibilitychange', () => {
            if (!browserNotificationSupport().enabled || !coralToken()) return;
            // Reconcile promptly when the tab changes foreground/background state,
            // then fall back to the conservative steady-state polling interval.
            scheduleBrowserNotificationPoll(document.hidden ? 1500 : 5000);
        });
        window.addEventListener('online', () => {
            if (browserNotificationSupport().enabled && coralToken()) {
                scheduleBrowserNotificationPoll(1500);
            }
        });
    }

    async function openPushNotifications(returnTarget = 'opSettingsPage') {
        ensureScreens();
        state.pushReturnTarget = returnTarget || 'opSettingsPage';
        openScreen('opPushPage');
        const body = $('opPushBody');
        body.innerHTML = `<p class="op-loading"><i class="fa-solid fa-spinner fa-spin"></i> ${escapeHtml(trKey('GameWebView_Initial_Loading_Label'))}</p>`;
        try {
            const [settings, services] = await Promise.all([
                loadPushSettings(true),
                loadWebServicesForSettings(true).catch(() => [])
            ]);
            body.innerHTML = `
                <section class="op-group op-no-margin">
                    <label class="op-toggle-row">
                        <span>
                            <b>${escapeHtml(tr('Browser Notifications'))}</b>
                            <small>${escapeHtml(browserNotificationExplanation())}</small>
                        </span>
                        <input id="opBrowserNotificationsToggle" type="checkbox"
                            ${browserNotificationSupport().enabled ? 'checked' : ''}
                            ${!browserNotificationSupport().supported || browserNotificationSupport().permission === 'denied' ? 'disabled' : ''}>
                        <i></i>
                    </label>
                </section>
                <section class="op-group">
                    <label class="op-toggle-row"><span><b>${escapeHtml(trKey('Notification_Settings_Friend_Request'))}</b><small>${escapeHtml(trKey('Notification_Settings_Friend_Request_Notice'))}</small></span><input id="opPushFriendRequest" type="checkbox" ${settings.friendRequest ? 'checked' : ''}><i></i></label>
                    <label class="op-toggle-row"><span><b>${escapeHtml(trKey('Notification_Settings_Chat_Invitation'))}</b><small>${escapeHtml(trKey('Notification_Settings_Chat_Invitation_Notice'))}</small></span><input id="opPushChatInvitation" type="checkbox" ${settings.chatInvitation ? 'checked' : ''}><i></i></label>
                    <button class="op-row" id="opPushFriendOnline"><span><b>${escapeHtml(trKey('Notification_Settings_Friend_Online'))}</b><small>${escapeHtml(trKey('Notification_Settings_Friend_Online_About_Feature')).replace(/\n/g, '<br>')}</small></span><i class="fa-solid fa-chevron-right"></i></button>
                </section>
                <section class="op-group">
                    <h4>${escapeHtml(trKey('Notification_Settings_Friend_Online_Play'))}</h4>
                    <p class="op-group-notice">${escapeHtml(trKey('Notification_Settings_Friend_Online_Play_Notice'))}</p>
                    <div class="op-radio-list" id="opPlayInviteRadios">
                        ${[['FRIENDS', 'Notification_Settings_Friend_Online_Play_All'], ['FAVORITE_FRIENDS', 'Notification_Settings_Friend_Online_Play_Best_Friends'], ['NONE', 'Notification_Settings_Friend_Online_Play_Off']].map(([value, key]) => `<label class="op-radio-row"><span>${escapeHtml(trKey(key))}</span><input type="radio" name="opPlayInvite" value="${value}" ${settings.playInvitation === value ? 'checked' : ''}></label>`).join('')}
                    </div>
                </section>
                <section class="op-group">
                    <h4>${escapeHtml(trKey('Notification_Settings_GameWebService'))}</h4>
                    <p class="op-group-notice">${escapeHtml(trKey('Notification_Settings_GameWebService_Notice'))}</p>
                    <div id="opGwsPushList">${renderGwsPushRows(services)}</div>
                </section>`;

            const browserToggle = $('opBrowserNotificationsToggle');
            browserToggle?.addEventListener('change', async () => {
                const desired = browserToggle.checked;
                browserToggle.disabled = true;
                try {
                    const enabled = await setBrowserNotificationsEnabled(desired);
                    browserToggle.checked = enabled;
                } finally {
                    const latest = browserNotificationSupport();
                    browserToggle.checked = latest.enabled;
                    browserToggle.disabled = !latest.supported || latest.permission === 'denied';
                }
            });

            bindPushControls(services);
        } catch (error) {
            console.error('[Notifications] settings load failed', error); body.innerHTML = `<p class="service-status error">${escapeHtml(trKey('Common_Loading_Failed'))}</p>`;
        }
    }

    function renderGwsPushRows(services) {
        const supported = (services || []).filter((s) => s?.isNotificationSupported);
        if (!supported.length) return '<p class="op-muted op-pad">No game-specific notification settings are available.</p>';
        return supported.map((s) => `
            <label class="op-toggle-row op-gws-toggle">
                <span class="op-gws-label"><img src="${escapeHtml(s.imageUri || '')}" alt=""><b>${escapeHtml(s.name || tr('Game Specific Service'))}</b></span>
                <input type="checkbox" data-gws-id="${escapeHtml(String(s.id))}" ${s.isNotificationAllowed ? 'checked' : ''}><i></i>
            </label>`).join('');
    }

    function bindPushControls(services) {
        const bindToggle = (id, type) => {
            const input = $(id);
            input?.addEventListener('change', async () => {
                const desired = input.checked;
                input.disabled = true;
                try {
                    await updatePush({ type, value: desired });
                    toast(tr('Notification setting changed.'));
                } catch (error) {
                    input.checked = !desired;
                    console.error('[UI action] request failed', error); alert(trKey('Error_Dialog_Message_CommunicationFailed'));
                } finally { input.disabled = false; }
            });
        };
        bindToggle('opPushFriendRequest', 'friendRequest');
        bindToggle('opPushChatInvitation', 'chatInvitation');
        $('opPushFriendOnline')?.addEventListener('click', () => openFriendOnlineSettings('opPushPage'));

        $('opPlayInviteRadios')?.querySelectorAll('input').forEach((input) => {
            input.addEventListener('change', async () => {
                if (!input.checked) return;
                const old = state.pushSettings.playInvitation;
                $('opPlayInviteRadios').querySelectorAll('input').forEach((x) => x.disabled = true);
                try {
                    await updatePush({ type: 'playInvitation', scope: input.value });
                    toast(tr('Notification setting changed.'));
                } catch (error) {
                    const prev = $('opPlayInviteRadios').querySelector(`input[value="${CSS.escape(old || '')}"]`);
                    if (prev) prev.checked = true;
                    console.error('[UI action] request failed', error); alert(trKey('Error_Dialog_Message_CommunicationFailed'));
                } finally {
                    $('opPlayInviteRadios').querySelectorAll('input').forEach((x) => x.disabled = false);
                }
            });
        });

        $('opGwsPushList')?.querySelectorAll('input[data-gws-id]').forEach((input) => {
            input.addEventListener('change', async () => {
                const id = Number(input.dataset.gwsId);
                const desired = input.checked;
                input.disabled = true;
                try {
                    await coralExact('pushUpdate', [{ type: 'gws', gwsId: id, value: desired }]);
                    const service = services.find((s) => Number(s.id) === id);
                    if (service) service.isNotificationAllowed = desired;
                    toast(tr('Notification setting changed.'));
                } catch (error) {
                    input.checked = !desired;
                    console.error('[UI action] request failed', error); alert(trKey('Error_Dialog_Message_CommunicationFailed'));
                } finally { input.disabled = false; }
            });
        });
    }

    async function openFriendOnlineSettings(returnTarget = 'opPushPage') {
        ensureScreens();
        state.friendOnlineReturnTarget = returnTarget || 'opPushPage';
        openScreen('opFriendOnlinePage');
        const list = $('opFriendOnlineList');
        let friends = getCurrentFriends();
        if (!friends.length) {
            try {
                const result = await coralExact('friends');
                friends = Array.isArray(result) ? result : (result?.friends || []);
            } catch { }
        }
        if (!friends.length) {
            list.innerHTML = `<p class="op-empty">${escapeHtml(trKey('Notification_Settings_Friend_Online_No_Friends'))}</p>`;
            return;
        }
        list.innerHTML = friends.map((friend) => `
            <label class="op-friend-toggle-row">
                <img src="${escapeHtml(friend.imageUri || friend.image2Uri || '')}" alt="">
                <span><b>${escapeHtml(friend.name || 'Switch Player')}</b></span>
                <input type="checkbox" data-nsa-id="${escapeHtml(friend.nsaId || '')}" ${friend.isOnlineNotificationEnabled ? 'checked' : ''}>
                <i></i>
            </label>`).join('');
        list.querySelectorAll('input[data-nsa-id]').forEach((input) => {
            input.addEventListener('change', async () => {
                const desired = input.checked;
                input.disabled = true;
                try {
                    await coralExact('friendOnlinePush', [{ type: 'friendOnline', value: desired, friendId: input.dataset.nsaId }]);
                    const friend = friends.find((f) => f.nsaId === input.dataset.nsaId);
                    if (friend) friend.isOnlineNotificationEnabled = desired;
                    toast(tr('Notification setting changed.'));
                } catch (error) {
                    input.checked = !desired;
                    console.error('[UI action] request failed', error); alert(trKey('Error_Dialog_Message_CommunicationFailed'));
                } finally { input.disabled = false; }
            });
        });
    }

    const USER_SETTINGS_CACHE_KEY = 'nso_official_user_settings_v1';

    function readUserSettingsCache() {
        try {
            const parsed = JSON.parse(localStorage.getItem(USER_SETTINGS_CACHE_KEY) || '{}');
            return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
        } catch {
            return {};
        }
    }

    function writeUserSettingsCache(cache) {
        try { localStorage.setItem(USER_SETTINGS_CACHE_KEY, JSON.stringify(cache || {})); } catch { }
    }

    function localSetting(key, fallback = '') {
        try {
            const cache = readUserSettingsCache();
            if (Object.prototype.hasOwnProperty.call(cache, key)) return String(cache[key]);

            const legacy = localStorage.getItem(`nso_official_${key}`);
            if (legacy != null) {
                cache[key] = String(legacy);
                writeUserSettingsCache(cache);
                return String(legacy);
            }
            return fallback;
        } catch {
            return fallback;
        }
    }

    function saveLocalSetting(key, value) {
        try {
            const normalized = String(value);
            const cache = readUserSettingsCache();
            cache[key] = normalized;
            writeUserSettingsCache(cache);
            // Preserve downgrade compatibility with the older per-setting keys.
            localStorage.setItem(`nso_official_${key}`, normalized);
        } catch { }
    }

    function languageSettingLabel() {
        const preference = localSetting('language', 'account');
        if (preference === 'account') {
            const accountLocale = accountAppLocale();
            return accountLocale
                ? `${localeDisplayName(accountLocale)} · ${tr('Nintendo Account')}`
                : tr('Nintendo Account language');
        }
        return localeDisplayName(normalizeAppLocale(preference) || currentAppLocale());
    }

    function renderLanguageSettingBody() {
        const body = $('opLanguageBody');
        if (!body) return;

        const accountLocale = accountAppLocale() || normalizeAppLocale(navigator.language) || 'en-GB';
        const preference = localSetting('language', 'account');
        const otherLocales = APP_SUPPORTED_LOCALES.filter((locale) => locale !== accountLocale);

        body.innerHTML = `
            <div class="op-radio-list op-language-list">
                <label class="op-radio-row op-language-row">
                    <span class="op-language-copy">
                        <b>${escapeHtml(localeDisplayName(accountLocale))}</b>
                        <small>${escapeHtml(tr('Nintendo Account language'))}</small>
                    </span>
                    <input type="radio" name="opLanguage" value="account" ${preference === 'account' ? 'checked' : ''}>
                </label>
                ${otherLocales.map((locale) => `
                    <label class="op-radio-row op-language-row">
                        <span class="op-language-copy"><b>${escapeHtml(localeDisplayName(locale))}</b></span>
                        <input type="radio" name="opLanguage" value="${escapeHtml(locale)}" ${preference === locale ? 'checked' : ''}>
                    </label>`).join('')}
            </div>
            <div class="op-info-card">${escapeHtml(tr('Use your Nintendo Account language by default. You can choose another language for this web app; the choice is saved on this device.'))}</div>`;

        body.querySelectorAll('input[name="opLanguage"]').forEach((input) => {
            input.addEventListener('change', () => {
                if (!input.checked) return;
                saveLocalSetting('language', input.value);
                applyAppLanguage(document);
                renderSettingsPage();
                renderLanguageSettingBody();
            });
        });
        applyAppLanguage(body);
    }

    function openLanguageSetting() {
        ensureScreens();
        renderLanguageSettingBody();
        openScreen('opLanguagePage');
    }

    function darkModeLabel(mode) {
        return ({ system: 'Use Device Settings', on: 'On', off: 'Off' })[mode] || 'Use Device Settings';
    }

    function effectiveDarkMode(mode = localSetting('dark_mode', 'system')) {
        if (mode === 'on') return true;
        if (mode === 'off') return false;
        return globalThis.matchMedia?.('(prefers-color-scheme: dark)')?.matches !== false;
    }

    function applyDarkMode(mode = localSetting('dark_mode', 'system')) {
        const dark = effectiveDarkMode(mode);
        document.body.classList.toggle('dark-theme', dark);
        document.body.classList.toggle('op-light-theme', !dark);
        document.documentElement.style.colorScheme = dark ? 'dark' : 'light';
        try {
            if (typeof initDockLottiePlayers === 'function') initDockLottiePlayers();
        } catch { }
    }

    function installSystemThemeWatcher() {
        const media = globalThis.matchMedia?.('(prefers-color-scheme: dark)');
        if (!media || media.__nsoMediaBound) return;
        media.__nsoMediaBound = true;
        media.addEventListener?.('change', () => {
            if (localSetting('dark_mode', 'system') === 'system') applyDarkMode('system');
        });
    }

    function openDarkModeSetting() {
        ensureScreens();
        const current = localSetting('dark_mode', 'system');
        $('opDarkModeBody').innerHTML = `
            <div class="op-radio-list">
                ${[['system', 'Darkmode_System'], ['on', 'Darkmode_On'], ['off', 'Darkmode_Off']].map(([value, key]) => `
                    <label class="op-radio-row"><span>${escapeHtml(trKey(key))}</span><input type="radio" name="opDarkMode" value="${value}" ${current === value ? 'checked' : ''}></label>`).join('')}
            </div>
            <div class="op-info-card">If "Use Device Settings" is selected, the app display will change to match the settings for the device you're using.</div>`;
        openScreen('opDarkModePage');
        $('opDarkModeBody').querySelectorAll('input[name="opDarkMode"]').forEach((input) => {
            input.addEventListener('change', () => {
                if (!input.checked) return;
                saveLocalSetting('dark_mode', input.value);
                applyDarkMode(input.value);
                renderSettingsPage();
            });
        });
    }

    function mobileDataLabel(value) {
        return ({ standard: trKey('Data_Saver_Default'), low: trKey('Data_Saver_Low_Data'), never: trKey('Data_Saver_Never') })[value] || trKey('Data_Saver_Default');
    }

    function openMobileDataSetting() {
        ensureScreens();
        const current = localSetting('mobile_data', 'standard');
        $('opMobileDataBody').innerHTML = `
            <div class="op-radio-list">
                ${[['standard', 'Data_Saver_Default'], ['low', 'Data_Saver_Low_Data'], ['never', 'Data_Saver_Never']].map(([value, key]) => `
                    <label class="op-radio-row"><span>${escapeHtml(trKey(key))}</span><input type="radio" name="opMobileData" value="${value}" ${current === value ? 'checked' : ''}></label>`).join('')}
            </div>
            <div class="op-info-card">${escapeHtml(trKey('Data_Saver_Notice')).replace(/\n/g, '<br>')}</div>`;
        openScreen('opMobileDataPage');
        $('opMobileDataBody').querySelectorAll('input[name="opMobileData"]').forEach((input) => {
            input.addEventListener('change', () => {
                if (!input.checked) return;
                saveLocalSetting('mobile_data', input.value);
                enforceMobileDataPreference();
                renderSettingsPage();
                toast(tr('Mobile-data setting changed.'));
            });
        });
    }

    function openUsageDataSetting() {
        ensureScreens();
        const allowed = localSetting('usage_data', 'deny') === 'allow';
        $('opUsageDataBody').innerHTML = `
            <div class="op-copy-page">
                <p>${escapeHtml(trKey('Optout_Label_Sub_Description')).replace(/\n/g, '<br>')}</p>
                <p class="op-muted">${escapeHtml(tr('Web-port note: this preference is saved only in this browser. This web port does not send Nintendo analytics data that the project does not implement.'))}</p>
                <div class="op-radio-list op-inline-radio-list">
                    <label class="op-radio-row"><span>${escapeHtml(trKey('Reset_Data_Usage_Button_Allow'))}</span><input type="radio" name="opUsageData" value="allow" ${allowed ? 'checked' : ''}></label>
                    <label class="op-radio-row"><span>${escapeHtml(trKey('Reset_Data_Usage_Button_Deny'))}</span><input type="radio" name="opUsageData" value="deny" ${!allowed ? 'checked' : ''}></label>
                </div>
            </div>`;
        openScreen('opUsageDataPage');
        $('opUsageDataBody').querySelectorAll('input[name="opUsageData"]').forEach((input) => {
            input.addEventListener('change', () => {
                if (!input.checked) return;
                saveLocalSetting('usage_data', input.value);
                renderSettingsPage();
                toast(tr('Usage-data preference changed.'));
            });
        });
    }

    function isLikelyCellularConnection() {
        const connection = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
        return connection?.type === 'cellular';
    }

    function enforceMobileDataPreference() {
        const apply = () => {
            if (!isLikelyCellularConnection()) return;
            const pref = localSetting('mobile_data', 'standard');
            document.querySelectorAll('#mediaModal video').forEach((video) => {
                if (pref === 'low') video.autoplay = false;
                if (pref === 'never') {
                    video.pause();
                    video.removeAttribute('src');
                    video.load();
                }
            });
        };
        apply();
        if (state.mobileObserver) return;
        state.mobileObserver = new MutationObserver(apply);
        state.mobileObserver.observe(document.body, { childList: true, subtree: true });
    }

    async function openLegalNotices() {
        ensureScreens();
        const host = $('opLegalBody');
        host.innerHTML = `<p class="op-empty"><i class="fa-solid fa-spinner fa-spin"></i> ${escapeHtml(trKey('GameWebView_Initial_Loading_Label'))}</p>`;
        openScreen('opLegalPage');
        try {
            if (!state.thirdPartyLicenses) {
                const response = await fetch('official-third-party.json?v=20260816-v1', { cache: 'force-cache' });
                if (!response.ok) throw new Error(`HTTP ${response.status}`);
                state.thirdPartyLicenses = await response.json();
            }
            const packages = state.thirdPartyLicenses?.packages || [];
            host.innerHTML = `<div class="op-license-list">${packages.map((item, index) => `
                <button type="button" class="op-row op-license-row" data-license-index="${index}">
                    <span><b>${escapeHtml(item.name || item.dependency || tr('Open-source software'))}</b><small>${escapeHtml(item.dependency || '')}</small></span><i class="fa-solid fa-chevron-right"></i>
                </button>`).join('')}</div>`;
            host.querySelectorAll('[data-license-index]').forEach((button) => {
                button.addEventListener('click', () => {
                    const item = packages[Number(button.dataset.licenseIndex)];
                    openLicenseDetail(item);
                });
            });
        } catch (error) {
            console.error('[Licenses] load failed', error); host.innerHTML = `<p class="op-empty">${escapeHtml(trKey('Common_Loading_Failed'))}</p>`;
        }
    }

    function openLicenseDetail(item) {
        const data = state.thirdPartyLicenses || {};
        const files = item?.license_file_names || [];
        const text = files.map((name) => data.licenses?.[name] || '').filter(Boolean).join('\n\n');
        $('opLicenseDetailPage').querySelector('h2').textContent = item?.name || tr('License');
        $('opLicenseDetailBody').innerHTML = `
            <div class="op-copy-page op-license-detail">
                ${item?.dependency ? `<p><b>${escapeHtml(item.dependency)}</b></p>` : ''}
                ${item?.url ? `<p><a class="op-inline-link" href="${escapeHtml(item.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(tr('Project Website'))} <i class="fa-solid fa-arrow-up-right-from-square"></i></a></p>` : ''}
                <pre>${escapeHtml(text || 'License text is not available in this package.')}</pre>
            </div>`;
        openScreen('opLicenseDetailPage');
    }

    function renderSettingsPage() {
        const version = (() => { try { return typeof ZNCA_VERSION !== 'undefined' ? ZNCA_VERSION : '3.4.1'; } catch { return '3.4.1'; } })();
        const supportCode = state.currentUser?.supportId || sessionUser()?.supportId || '';
        const factor = state.loginFactor || {};
        const profileSummary = factor.email || factor.loginId || state.currentUser?.name || sessionUser()?.name || 'Nintendo Account';
        const usageAllowed = localSetting('usage_data', 'deny') === 'allow';
        const settingsUser = state.currentUser || sessionUser() || {};
        const settingsPermissions = state.permissions?.permissions || settingsUser.permissions || {};
        const settingsFriendCode = settingsUser.links?.friendCode?.id || $('opFriendCode')?.textContent || '—';
        $('opSettingsBody').innerHTML = `
            <section class="op-group op-no-margin">
                <h4>Nintendo Account</h4>
                <button class="op-row" id="opSettingsProfile"><span><b>Profile</b><small>${escapeHtml(profileSummary)}</small></span><i class="fa-solid fa-chevron-right"></i></button>
                <button class="op-row" id="opFriendCodeRow"><span><b>Friend Code</b><small>${escapeHtml(settingsFriendCode)}</small></span><i class="fa-solid fa-chevron-right"></i></button>
                <button class="op-row" id="opOnlineStatusRow"><span><b>Online Status</b><small>${escapeHtml(permissionLabel('presence', settingsPermissions.presence))}</small></span><i class="fa-solid fa-chevron-right"></i></button>
                <button class="op-row" id="opPlayActivityRow"><span><b>Play Activity</b><small>${escapeHtml(permissionLabel('playLog', settingsPermissions.playLog))}</small></span><i class="fa-solid fa-chevron-right"></i></button>
                <button class="op-row" id="opNintendoAccountRow"><span><b>${escapeHtml(trKey('Other_Button_Nintendo_Account_Management'))}</b></span><i class="fa-solid fa-arrow-up-right-from-square"></i></button>
            </section>
            <section class="op-group">
                <h4>Notifications</h4>
                <button class="op-row" id="opPushNotificationsRow"><span><b>Push Notifications</b></span><i class="fa-solid fa-chevron-right"></i></button>
            </section>
            <section class="op-group">
                <h4>System</h4>
                <button class="op-row" id="opSettingsLanguage"><span><b>Language</b><small>${escapeHtml(languageSettingLabel())}</small></span><i class="fa-solid fa-chevron-right"></i></button>
                <button class="op-row" id="opSettingsDarkMode"><span><b>Dark Mode</b><small>${escapeHtml(darkModeLabel(localSetting('dark_mode', 'system')))}</small></span><i class="fa-solid fa-chevron-right"></i></button>
                <button class="op-row" id="opSettingsMobileData"><span><b>Mobile Data</b><small>${escapeHtml(mobileDataLabel(localSetting('mobile_data', 'standard')))}</small></span><i class="fa-solid fa-chevron-right"></i></button>
                <button class="op-row" id="opSettingsStorage"><span><b>Storage</b><small>Cached images and data will be cleared, freeing up space on your device.</small></span><i class="fa-solid fa-chevron-right"></i></button>
                <button class="op-row" id="opSettingsUsageData"><span><b>About Sending Usage Data</b><small>${escapeHtml(usageAllowed ? trKey('Data_Usage_Allow') : trKey('Reset_Data_Usage_Button_Deny'))}</small></span><i class="fa-solid fa-chevron-right"></i></button>
            </section>
            <section class="op-group">
                <h4>Other</h4>
                <button class="op-row" id="opSettingsFeedback"><span><b>Feedback</b><small>Send feedback about this app.</small></span><i class="fa-solid fa-chevron-right"></i></button>
            </section>
            <section class="op-group">
                <h4>About This App</h4>
                <a class="op-row" href="https://accounts.nintendo.com/term_chooser/eula" target="_blank" rel="noopener"><span><b>${escapeHtml(trKey('Other_Label_Contract'))}</b></span><i class="fa-solid fa-arrow-up-right-from-square"></i></a>
                <a class="op-row" href="https://www.nintendo.com/privacy-policy/" target="_blank" rel="noopener"><span><b>${escapeHtml(trKey('Other_Label_Privacy_Policy'))}</b></span><i class="fa-solid fa-arrow-up-right-from-square"></i></a>
                <button class="op-row" id="opSettingsLegal"><span><b>Intellectual Property Notices</b></span><i class="fa-solid fa-chevron-right"></i></button>
                <a class="op-row" href="https://support.nintendo.com/" target="_blank" rel="noopener"><span><b>${escapeHtml(trKey('Other_Label_Support'))}</b></span><i class="fa-solid fa-arrow-up-right-from-square"></i></a>
                ${supportCode ? `<div class="op-row op-static"><span><b>${escapeHtml(trKey('Other_Label_Support_Number'))}</b><small>${escapeHtml(supportCode)}</small></span></div>` : ''}
                <div class="op-row op-static"><span><b>Version</b><small>${escapeHtml(version)}</small></span></div>
                <div class="op-row op-static"><span><b>© Nintendo</b></span></div>
            </section>
            <button class="op-signout" id="opSettingsSignOutBtn"><i class="fa-solid fa-right-from-bracket"></i> Sign Out</button>`;
        $('opSettingsProfile')?.addEventListener('click', () => {
            openUserPage({ backFrom: 'opSettingsPage' });
        });
        $('opFriendCodeRow')?.addEventListener('click', () => $('openMyCodeQrBtn')?.click());
        $('opOnlineStatusRow')?.addEventListener('click', () => openVisibility('presence', 'opSettingsPage'));
        $('opPlayActivityRow')?.addEventListener('click', () => openVisibility('playLog', 'opSettingsPage'));
        $('opNintendoAccountRow')?.addEventListener('click', () => window.open('https://accounts.nintendo.com/', '_blank', 'noopener'));
        $('opPushNotificationsRow')?.addEventListener('click', () => openPushNotifications('opSettingsPage'));
        $('opSettingsSignOutBtn')?.addEventListener('click', async () => {
            const ok = await confirmSheet(trKey('Cmn_Button_Logout'), trKey('Others_Dialog_Logout_Description_V2'), trKey('Other_Dialog_Logout_Button_Ok'));
            if (ok && typeof logout === 'function') logout();
        });
        $('opSettingsLanguage')?.addEventListener('click', openLanguageSetting);
        $('opSettingsDarkMode')?.addEventListener('click', openDarkModeSetting);
        $('opSettingsMobileData')?.addEventListener('click', openMobileDataSetting);
        $('opSettingsUsageData')?.addEventListener('click', openUsageDataSetting);
        $('opSettingsLegal')?.addEventListener('click', openLegalNotices);
        $('opSettingsFeedback')?.addEventListener('click', openFeedback);
        $('opSettingsStorage')?.addEventListener('click', async () => {
            const ok = await confirmSheet(trKey('Storage_Clear_Confirm'), trKey('Storage_Notice'), trKey('Storage_Clear_Submit'));
            if (!ok) return;
            try {
                if ('caches' in window) {
                    const keys = await caches.keys();
                    await Promise.all(keys.map((key) => caches.delete(key)));
                }
                toast(trKey('Storage_Clear_Deleted'));
            } catch (error) {
                console.error('[Storage] clear failed', error); alert(trKey('Storage_Clear_Failed'));
            }
        });
    }

    function openSettings() {
        ensureScreens();

        // Render immediately from current session/cached data so the settings rows
        // exist before the transition starts. Remote Coral calls only enrich labels.
        renderSettingsPage();
        openScreen('opSettingsPage');

        const settingsPage = $('opSettingsPage');
        const scrollHost = settingsPage?.querySelector('.op-scroll') || settingsPage;

        const userRefresh = loadCurrentUserAndPermissions().catch(() => { });
        const factorRefresh = state.loginFactor
            ? Promise.resolve()
            : coralExact('loginFactor')
                .then((factor) => { if (factor) state.loginFactor = factor; })
                .catch(() => { });

        // Run the slow calls concurrently in the background and refresh in place.
        // If the user already left Settings, do not touch the hidden page.
        void Promise.all([userRefresh, factorRefresh]).then(() => {
            if (!settingsPage || settingsPage.classList.contains('hidden')) return;
            const scrollTop = scrollHost?.scrollTop || 0;
            renderSettingsPage();
            if (scrollHost) scrollHost.scrollTop = scrollTop;
        });
    }

    function openFeedback() {
        ensureScreens();
        $('opFeedbackBody').innerHTML = `
            <p class="op-page-prompt">${escapeHtml(trKey('Opinion_Label_Page_Header'))}</p>
            <label class="op-field"><span>${escapeHtml(trKey('Opinion_Label_Opinion_Type_Header_Plural'))}</span><select id="opFeedbackTopic">
                <option value="4">${escapeHtml(trKey('Opinion_Label_Type_Fun_Function'))}</option>
                <option value="9">${escapeHtml(trKey('Opinion_Label_Friend'))}</option>
                <option value="10">${escapeHtml(trKey('Opinion_Album'))}</option>
                <option value="6">${escapeHtml(trKey('Opinion_Label_Type_Request'))}</option>
                <option value="8">${escapeHtml(trKey('Opinion_Label_Defect'))}</option>
                <option value="0">${escapeHtml(trKey('Opinion_Label_Type_Other'))}</option>
            </select></label>
            <label class="op-field"><span>${escapeHtml(trKey('Opinion_Label_Opinion_Content_Header'))}</span><textarea id="opFeedbackText" maxlength="1000" placeholder="${escapeHtml(trKey('Opinion_Label_Opinion_Content_Description'))}"></textarea><small id="opFeedbackCount">0/1000</small></label>
            <p class="op-muted">${escapeHtml(trKey('Opinion_Notice')).replace(/\n/g, '<br>')}</p>
            <button type="button" class="op-primary" id="opFeedbackSubmit">${escapeHtml(trKey('Opinion_Label_Send'))}</button>`;
        openScreen('opFeedbackPage');
        const text = $('opFeedbackText');
        text?.addEventListener('input', () => $('opFeedbackCount').textContent = `${text.value.length}/1000`);
        $('opFeedbackSubmit')?.addEventListener('click', async () => {
            const message = text.value.trim();
            if (!message) { text.focus(); return; }
            const button = $('opFeedbackSubmit');
            setBusy(button, true, tr('Loading…'));
            try {
                await coralExact('feedback', {
                    category: Number($('opFeedbackTopic').value),
                    message
                });
                $('opFeedbackBody').innerHTML = `
                    <div class="op-success-state"><i class="fa-solid fa-circle-check"></i><h3>${escapeHtml(trKey('Opinion_Sent'))}</h3><p>${escapeHtml(trKey('Opinion_Sent_Notice'))}</p></div>`;
            } catch (error) {
                console.error('[UI action] request failed', error); alert(trKey('Error_Dialog_Message_CommunicationFailed'));
            } finally { setBusy(button, false); }
        });
    }

    function ensureHomeChatSection() {
        const home = $('page-home');
        if (!home || $('opHomeChatSection')) return;
        const section = document.createElement('section');
        section.id = 'opHomeChatSection';
        section.className = 'home-content-section op-home-chat';
        section.innerHTML = `
            <div class="op-section-title-row"><h2>${escapeHtml(trKey('Common_Chat'))}</h2><button type="button" id="opOpenChatPage">${escapeHtml(trKey('Chat_For_Details'))}</button></div>
            <div id="opHomeChatContent" class="op-chat-strip"><p class="service-status">${escapeHtml(trKey('GameWebView_Initial_Loading_Label'))}</p></div>`;
        const gws = $('gameServicesCatalog')?.closest('.home-content-section');
        if (gws) home.insertBefore(section, gws); else home.appendChild(section);
        $('opOpenChatPage')?.addEventListener('click', openChatPage);
    }

    function normalizeChat(chat) {
        const inviter = chat?.inviter || chat?.creator || {};
        return {
            raw: chat,
            chatId: chat?.chatId || chat?.id || chat?.chat?.id || '',
            invitedAt: chat?.invitedAt || chat?.createdAt || chat?.startedAt || null,
            inviter: {
                nsaId: inviter?.nsaId || '',
                imageUri: inviter?.imageUri || inviter?.image2Uri || '',
                name: inviter?.name || inviter?.nickname || '',
                isMe: Boolean(inviter?.isMe || inviter?.isSelf)
            }
        };
    }

    async function loadChats(force = false) {
        if (!force && state.chats.length) return state.chats;
        const result = await coralExact('chats');
        const raw = Array.isArray(result) ? result : (result?.chats || result?.chatList || []);
        state.chats = raw.map(normalizeChat);
        return state.chats;
    }

    async function refreshHomeChat() {
        ensureHomeChatSection();
        const host = $('opHomeChatContent');
        if (!host) return;
        try {
            const chats = await loadChats(true);
            if (!chats.length) {
                host.innerHTML = `<button type="button" class="op-chat-empty-card" id="opChatHowToHome"><i class="fa-solid fa-comments"></i><span><b>${escapeHtml(trKey('Chat_Available'))}</b><small>${escapeHtml(trKey('Chat_How_To_Join'))}</small></span><i class="fa-solid fa-chevron-right"></i></button>`;
                $('opChatHowToHome')?.addEventListener('click', openChatPage);
                return;
            }
            host.innerHTML = chats.slice(0, 4).map((chat, index) => `
                <button class="op-chat-card" data-chat-index="${index}">
                    <img src="${escapeHtml(chat.inviter.imageUri)}" alt="">
                    <span><b>${escapeHtml(chat.inviter.isMe ? trKey('Chat_Invitation_From_Me') : trFormat('Chat_Invitation_From', chat.inviter.name || tr('Friend')))}</b><small>${escapeHtml(relativeTime(chat.invitedAt))}</small></span>
                </button>`).join('');
            host.querySelectorAll('[data-chat-index]').forEach((button) => button.addEventListener('click', () => openChatDetail(chats[Number(button.dataset.chatIndex)])));
        } catch (error) {
            // GameChat may not be available to every account. Keep Home usable.
            host.innerHTML = `<button type="button" class="op-chat-empty-card" id="opChatHowToHome"><i class="fa-solid fa-comments"></i><span><b>${escapeHtml(trKey('Chat_Available'))}</b><small>${escapeHtml(trKey('Chat_How_To_Join'))}</small></span><i class="fa-solid fa-chevron-right"></i></button>`;
            $('opChatHowToHome')?.addEventListener('click', openChatPage);
            console.debug('[NSO] Chat/List unavailable', error);
        }
    }

    function howToChatHtml() {
        return `
            <div class="op-info-card">${escapeHtml(trKey('Chat_Available'))}</div>
            <h3 class="op-subtitle">${escapeHtml(trKey('Chat_How_To_Join'))}</h3>
            <ol class="op-steps">
                <li><b>${escapeHtml(trKey('Chat_How_To_Join_1'))}</b><small>${escapeHtml(trKey('Chat_How_To_Join_1_Notice'))}</small></li>
                <li><b>${escapeHtml(trKey('Chat_How_To_Join_2'))}</b><small>${escapeHtml(trKey('Chat_How_To_Join_2_Notice'))}</small></li>
                <li><b>${escapeHtml(trKey('Chat_How_To_Join_3'))}</b></li>
            </ol>`;
    }

    async function openChatPage() {
        ensureScreens();
        const body = $('opChatBody');
        body.innerHTML = `<p class="op-loading"><i class="fa-solid fa-spinner fa-spin"></i> ${escapeHtml(trKey('GameWebView_Initial_Loading_Label'))}</p>`;
        openScreen('opChatPage');
        try {
            const chats = await loadChats(true);
            body.innerHTML = `${howToChatHtml()}<h3 class="op-subtitle">${escapeHtml(trKey('Chat_Invitation'))}</h3><div id="opChatList"></div>`;
            const list = $('opChatList');
            if (!chats.length) {
                list.innerHTML = `<p class="op-empty">${escapeHtml(tr('No chat invitations right now.'))}</p>`;
            } else {
                list.innerHTML = chats.map((chat, index) => `
                    <button class="op-chat-list-row" data-chat-index="${index}">
                        <img src="${escapeHtml(chat.inviter.imageUri)}" alt="">
                        <span><b>${escapeHtml(chat.inviter.isMe ? trKey('Chat_Invitation_From_Me') : trFormat('Chat_Invitation_From', chat.inviter.name || tr('Friend')))}</b><small>${escapeHtml(formatDate(chat.invitedAt))}</small></span>
                        <i class="fa-solid fa-chevron-right"></i>
                    </button>`).join('');
                list.querySelectorAll('[data-chat-index]').forEach((button) => button.addEventListener('click', () => openChatDetail(chats[Number(button.dataset.chatIndex)])));
            }
        } catch (error) {
            console.error('[GameChat] invitation load failed', error); body.innerHTML = `${howToChatHtml()}<p class="service-status error">${escapeHtml(trKey('Common_Loading_Failed'))}</p>`;
        }
    }

    function normalizeChatMember(member) {
        return {
            nsaId: member?.nsaId || '',
            imageUri: member?.imageUri || member?.image2Uri || '',
            name: member?.name || 'Switch Player',
            isFriend: Boolean(member?.isFriend),
            isJoined: Boolean(member?.isJoined || member?.isInChat || member?.joined),
            isInvited: Boolean(member?.isInvited),
            isMe: Boolean(member?.isMe || member?.isSelf)
        };
    }

    async function openChatDetail(chat) {
        ensureScreens();
        state.activeChat = chat;
        const body = $('opChatDetailBody');
        openScreen('opChatDetailPage');
        body.innerHTML = `<p class="op-loading"><i class="fa-solid fa-spinner fa-spin"></i> ${escapeHtml(trKey('GameWebView_Initial_Loading_Label'))}</p>`;
        if (!chat?.chatId) {
            body.innerHTML = `<p class="op-empty">${escapeHtml(trKey('Chat_Not_Found'))}</p>`;
            return;
        }
        try {
            // APK: ChatDetailRequest.Parameter wraps a ChatId value object.
            const detail = await coralExact('chatShow', { chatId: chat.chatId });
            const membersRaw = detail?.members || detail?.chatMembers || [];
            const members = (Array.isArray(membersRaw) ? membersRaw : []).map(normalizeChatMember);
            const inviter = detail?.inviter || chat.inviter || {};
            const started = detail?.invitedAt || detail?.startedAt || chat.invitedAt;
            body.innerHTML = `
                <div class="op-chat-detail-hero"><i class="fa-solid fa-comments"></i><h3>${escapeHtml(inviter?.isMe ? trKey('Chat_Invite') : trFormat('Chat_Invited_By', inviter?.name || chat.inviter.name || tr('Friend')))}</h3><p>${escapeHtml(formatDate(started))}</p></div>
                ${renderChatMemberSection(trKey('Chat_Members_Joined'), members.filter((m) => m.isJoined))}
                ${renderChatMemberSection(trKey('Chat_Members_Not_Friend'), members.filter((m) => !m.isFriend && !m.isMe))}
                ${renderChatMemberSection(trKey('Chat_Members_Not_Joined'), members.filter((m) => !m.isJoined && (m.isFriend || m.isMe)))}
            `;
        } catch (error) {
            console.error('[GameChat] detail load failed', error); body.innerHTML = `<p class="service-status error">${escapeHtml(trKey('Chat_Not_Found'))}</p>`;
        }
    }

    function renderChatMemberSection(title, members) {
        if (!members.length) return '';
        return `<section class="op-member-section"><h4>${escapeHtml(title)}</h4>${members.map((m) => `<div class="op-member-row"><img src="${escapeHtml(m.imageUri)}" alt=""><span><b>${escapeHtml(m.name)}</b></span></div>`).join('')}</section>`;
    }

    async function openAnnouncements() {
        ensureScreens();
        openScreen('opAnnouncementPage');
        const body = $('opAnnouncementBody');
        body.innerHTML = `<p class="op-loading"><i class="fa-solid fa-spinner fa-spin"></i> ${escapeHtml(trKey('GameWebView_Initial_Loading_Label'))}</p>`;
        try {
            const result = await coralExact('announcements');
            state.announcements = Array.isArray(result) ? result : (result?.announcements || []);
            renderAnnouncements();
        } catch (error) {
            console.error('[Notifications] parity load failed', error); body.innerHTML = `<p class="service-status error">${escapeHtml(trKey('Common_Loading_Failed'))}</p>`;
        }
    }

    function renderAnnouncements() {
        const body = $('opAnnouncementBody');
        if (!state.announcements.length) {
            body.innerHTML = `<p class="op-empty">${escapeHtml(trKey('Announcement_Empty'))}</p>`;
            updateAnnouncementDot();
            return;
        }
        body.innerHTML = `<div class="op-announcement-list">${state.announcements.map((item, index) => `
            <button class="op-announcement-row ${item.hasRead === false ? 'unread' : ''}" data-announcement-index="${index}">
                <img src="${escapeHtml(item.imageUri || item.image2Uri || '')}" alt="">
                <span><b>${escapeHtml(item.title || 'Nintendo Switch App')}</b><small>${escapeHtml(formatDate(item.deliversAt || item.distributionDate))}</small></span>
                <i class="fa-solid fa-chevron-right"></i>
            </button>`).join('')}</div>`;
        body.querySelectorAll('[data-announcement-index]').forEach((button) => {
            button.addEventListener('click', () => openAnnouncementDetail(Number(button.dataset.announcementIndex)));
        });
        updateAnnouncementDot();
    }

    async function openAnnouncementDetail(index) {
        const item = state.announcements[index];
        if (!item) return;
        if (item.hasRead === false && item.id) {
            item.hasRead = true;
            coralExact('announcementRead', { id: item.id }).catch((error) => console.debug('[NSO] Announcement read marker failed', error));
        }
        const content = item.operation?.contents || item.contents || (item.type === 'FRIEND_REQUEST' ? trKey('FriendRequest_Received_Alert') : '');
        $('opAnnouncementDetailBody').innerHTML = `
            ${item.imageUri ? `<img class="op-announcement-hero" src="${escapeHtml(item.imageUri)}" alt="">` : ''}
            <article class="op-copy-page"><h3>${escapeHtml(item.title || 'Nintendo Switch App')}</h3><p class="op-muted">${escapeHtml(formatDate(item.deliversAt || item.distributionDate))}</p><p>${escapeHtml(content)}</p>${item.type === 'FRIEND_REQUEST' ? `<button class="op-primary" id="opAnnouncementOpenRequests">${escapeHtml(trKey('FriendRequest_Received'))}</button>` : ''}</article>`;
        openScreen('opAnnouncementDetailPage');
        $('opAnnouncementOpenRequests')?.addEventListener('click', () => {
            $('opAnnouncementDetailPage')?.classList.add('hidden');
            $('addFriendView')?.classList.remove('hidden');
            $('openAddFriendBtn')?.click();
        });
        renderAnnouncements();
    }

    function updateAnnouncementDot() {
        const unread = state.announcements.some((item) => item.hasRead === false);
        const dot = $('notificationBtn')?.querySelector('span');
        if (dot) dot.style.display = unread ? '' : 'none';
        $('notificationBtn')?.setAttribute('aria-label', unread ? trKey('A11y_Has_Unread') : trKey('A11y_No_Unread'));
    }

    function installAlbumFeatures() {
        const title = $('albumPageTitle');
        if (title) title.textContent = 'Uploaded Data';
        const header = title?.closest('.album-toolbar-header');
        if (header && !$('opAlbumAboutBtn')) {
            const btn = document.createElement('button');
            btn.id = 'opAlbumAboutBtn';
            btn.type = 'button';
            btn.className = 'op-header-info-button';
            btn.innerHTML = `<i class="fa-solid fa-circle-info"></i> ${escapeHtml(trKey('Album_About'))}`;
            btn.addEventListener('click', () => { ensureScreens(); openScreen('opAlbumAboutPage'); });
            header.querySelector('.album-batch-actions')?.prepend(btn);
        }

        bindControl('mediaInfoBtn', async () => {
            const item = currentMediaItem();
            if (!item) return;
            const meta = $('mediaModalMeta');
            if (!meta) return;
            meta.classList.remove('hidden');
            meta.innerHTML = `<p class="op-loading"><i class="fa-solid fa-spinner fa-spin"></i> ${escapeHtml(trKey('GameWebView_Initial_Loading_Label'))}</p>`;
            let tags = '';
            if (item.applicationId != null && item.platformId != null) {
                try {
                    const result = await coralExact('mediaHashtags', {
                        applications: [{
                            platformId: item.platformId,
                            acdIndex: item.acdIndex,
                            extraData: item.extraData,
                            applicationId: item.applicationId
                        }]
                    });
                    tags = result?.tags || '';
                } catch (error) {
                    console.debug('[NSO] Hashtag/List unavailable', error);
                }
            }
            const expiration = expirationLabel(item.expiresAt);
            meta.innerHTML = `
                <div class="op-media-details">
                    ${detailRow('Software Name', item.appName || 'Nintendo Switch')}
                    ${detailRow('Date Captured', formatDate(item.capturedAt))}
                    ${detailRow('Date Uploaded', formatDate(item.uploadedAt))}
                    ${detailRow('Storage Time', expiration)}
                    ${detailRow('Hashtags:', tags || '—', 'opMediaHashtags')}
                </div>
                ${tags ? '<button type="button" class="op-secondary" id="opCopyHashtags">Copy Hashtags</button>' : ''}`;
            $('opCopyHashtags')?.addEventListener('click', async () => {
                try { await navigator.clipboard.writeText(tags); toast(trKey('Album_Copy_Hashtags_Done')); }
                catch { prompt(trKey('Album_Copy_Hashtags'), tags); }
            });
        });
    }

    function detailRow(label, value, valueId = '') {
        return `<div class="op-detail-row"><b>${escapeHtml(label)}</b><span ${valueId ? `id="${valueId}"` : ''}>${escapeHtml(value || '—')}</span></div>`;
    }

    function expirationLabel(value) {
        const ms = toMillis(value);
        if (!ms) return '—';
        const remain = ms - Date.now();
        if (remain <= 0) return 'Expired';
        const hours = Math.floor(remain / 3600000);
        if (hours < 1) return 'Under an hour left';
        if (hours < 24) return `${hours} hr. left`;
        const days = Math.floor(hours / 24);
        return `${days} d. ${hours % 24} hr. left`;
    }

    async function openChatCandidates() {
        ensureScreens();
        const view = $('chattedUsersView');
        const body = view?.querySelector('.chatted-users-body');
        if (!view || !body) return;

        body.innerHTML = `<p class="op-loading"><i class="fa-solid fa-spinner fa-spin"></i> ${escapeHtml(trKey('GameWebView_Initial_Loading_Label'))}</p>`;

        const addFriendView = $('addFriendView');
        const openedFromAddFriend = addFriendView && !addFriendView.classList.contains('hidden');
        view.dataset.nsoReturnTarget = openedFromAddFriend ? 'addFriendView' : '';

        // Start the real APK-style activity transition immediately; do not expose the
        // Home page between Add Friend and the GameChat candidate screen.
        const transition = openedFromAddFriend && typeof nsoApkForward === 'function'
            ? nsoApkForward(addFriendView, view)
            : (view.classList.remove('hidden'), Promise.resolve());

        try {
            const resultPromise = coralExact('chatCandidates');
            const result = await resultPromise;
            const raw = Array.isArray(result) ? result : (result?.chatParticipants || result?.friendCandidates || []);
            if (!raw.length) {
                body.innerHTML = `<p class="chatted-users-empty">${escapeHtml(trKey('FriendRequest_GameChat_Empty'))}</p>`;
                await transition;
                return;
            }
            body.innerHTML = raw.map((candidate, index) => `
                <button class="op-candidate-row" data-candidate-index="${index}">
                    <img src="${escapeHtml(candidate.imageUri || candidate.image2Uri || '')}" alt="">
                    <span><b>${escapeHtml(candidate.name || tr('Switch Player'))}</b><small>${escapeHtml(trKey('FriendRequest_Chatted_User'))}</small></span>
                    <i class="fa-solid fa-chevron-right"></i>
                </button>`).join('');
            body.querySelectorAll('[data-candidate-index]').forEach((button) => {
                button.addEventListener('click', () => openChatCandidateDetail(raw[Number(button.dataset.candidateIndex)]));
            });
            await transition;
        } catch (error) {
            console.error('[GameChat] candidate load failed', error); body.innerHTML = `<p class="service-status error">${escapeHtml(trKey('Common_Loading_Failed'))}</p>`;
            await transition;
        }
    }

    async function openChatCandidateDetail(candidate) {
        state.activeChatCandidate = candidate;
        const body = $('opChatCandidateBody');
        body.innerHTML = `
            <div class="op-profile-hero"><img src="${escapeHtml(candidate.imageUri || candidate.image2Uri || '')}" alt=""><h3>${escapeHtml(candidate.name || tr('Switch Player'))}</h3><p>${escapeHtml(trKey('FriendRequest_Chatted_User'))}</p></div>
            <div class="op-action-grid">
                <button type="button" class="op-primary" id="opCandidateAdd">${escapeHtml(trKey('FriendRequest_Send'))}</button>
                <button type="button" class="op-secondary danger" id="opCandidateBlock">${escapeHtml(trKey('Friend_Block'))}</button>
            </div>
            <section class="op-group"><h4>${escapeHtml(trKey('Common_PlayActivity'))}</h4><div id="opCandidatePlayLog"><p class="op-loading">${escapeHtml(trKey('GameWebView_Initial_Loading_Label'))}</p></div></section>`;
        const candidatePage = $('opChatCandidatePage');
        const candidateList = $('chattedUsersView');
        closeAppScreens('opChatCandidatePage');
        if (candidatePage && candidateList && typeof nsoApkForward === 'function') {
            nsoApkForward(candidateList, candidatePage);
        } else {
            openScreen('opChatCandidatePage');
        }
        $('opCandidateAdd')?.addEventListener('click', async () => {
            if (!candidate.nsaId) return;
            const button = $('opCandidateAdd'); setBusy(button, true, tr('Sending Request…'));
            try {
                await coralExact('friendRequest', { nsaId: candidate.nsaId, channel: 'CAMPUS' });
                button.textContent = trKey('FriendRequest_Dialog_Sent_Label_Sent_Request'); button.disabled = true; delete button.dataset.oldHtml;
            } catch (error) { console.error('[FriendRequest] send failed', error); alert(trKey('Error_Dialog_Message_CommunicationFailed')); setBusy(button, false); }
        });
        $('opCandidateBlock')?.addEventListener('click', async () => {
            if (!candidate.nsaId) return;
            const ok = await confirmSheet(trKey('Friend_Block'), trKey('Friend_Block_Alert'), trKey('Friend_Block_Submit'));
            if (!ok) return;
            try {
                await coralExact('friendBlock', { nsaId: candidate.nsaId });
                toast(trKey('Friend_Blocked'));
                const candidatePage = $('opChatCandidatePage');
                const candidateList = $('chattedUsersView');
                if (candidatePage && candidateList && typeof nsoApkBack === 'function') {
                    nsoApkBack(candidatePage, candidateList);
                } else {
                    candidatePage?.classList.add('hidden');
                    candidateList?.classList.remove('hidden');
                }
            } catch (error) { console.error('[UI action] request failed', error); alert(trKey('Error_Dialog_Message_CommunicationFailed')); }
        });
        if (candidate.nsaId) {
            try {
                const result = await coralExact('friendPlayLog', { nsaId: candidate.nsaId });
                renderPlayLog($('opCandidatePlayLog'), result);
            } catch {
                $('opCandidatePlayLog').innerHTML = `<p class="op-empty">${escapeHtml(trKey('Common_PlayActivity_Empty'))}</p>`;
            }
        }
    }

    function renderPlayLog(host, result) {
        if (!host) return;
        const logs = Array.isArray(result) ? result : (result?.playLogs || []);
        if (!logs.length) { host.innerHTML = `<p class="op-empty">${escapeHtml(trKey('Common_PlayActivity_Empty'))}</p>`; return; }
        host.innerHTML = logs.map((log) => `
            <div class="op-playlog-row"><img src="${escapeHtml(log.imageUri || '')}" alt=""><span><b>${escapeHtml(log.name || 'Game')}</b><small>${Number(log.totalPlayTime || 0) > 0 ? trFormat('FriendDetails_Label_Play_Log_Time', Math.max(1, Math.round(Number(log.totalPlayTime) / 60))) : tr('Recently played')}</small></span></div>`).join('');
    }

    function installFriendOnlinePageReplacement() {
        const oldOpen = $('openNotifySettingBtn');
        if (oldOpen) {
            const btn = bindControl('openNotifySettingBtn', async () => {
                await openFriendOnlineSettings('friendSettingsView');
            });
            btn?.querySelector('span') && (btn.querySelector('span').textContent = trKey('Notification_Settings_Friend_Online'));
        }
        // Remove the earlier capture-phase redirect by replacing the button node.
        bindControl('changeNotifySettingBtn', () => openFriendOnlineSettings('friendSettingsView'));
        const notice = $('friendSettingsNotifyView')?.querySelector('.settings-subtext');
        if (notice) notice.textContent = trKey('Notification_Settings_Friend_Online_Notice');
    }

    function installExistingRequestSettingExactCall() {
        const old = $('receiveRequestsToggle');
        if (!old) return;
        const input = old.cloneNode(true);
        old.replaceWith(input);
        input.addEventListener('change', async () => {
            const desired = input.checked;
            input.disabled = true;
            try {
                await coralExact('permissionsWrite', { permissions: { friendRequestReception: desired } });
                state.permissions = state.permissions || { permissions: {} };
                state.permissions.permissions = state.permissions.permissions || {};
                state.permissions.permissions.friendRequestReception = desired;
                toast(tr('Setting changed.'));
            } catch (error) {
                input.checked = !desired;
                console.error('[UI action] request failed', error); alert(trKey('Error_Dialog_Message_CommunicationFailed'));
            } finally { input.disabled = false; }
        });
        $('openRequestsSettingBtn')?.addEventListener('click', async () => {
            try {
                await loadCurrentUserAndPermissions(true);
                const value = state.permissions?.permissions?.friendRequestReception;
                if (typeof value === 'boolean') input.checked = value;
            } catch { }
        });
    }

    function installFriendDetailFeatures() {
        if (typeof openFriendDetail === 'function' && !openFriendDetail.__opFriendDetailWrapped) {
            const previous = openFriendDetail;
            const wrapped = function (friend) {
                state.activeFriend = friend || null;
                closeFriendMoreMenu(true);

                const requestedNsaId = friend?.nsaId || null;
                const result = previous(friend);

                queueMicrotask(() => {
                    if (!requestedNsaId || state.activeFriend?.nsaId === requestedNsaId) {
                        enhanceFriendDetail(friend);
                    }
                });

                if (requestedNsaId) {
                    coralExact('friendShow', { nsaId: requestedNsaId }).then((full) => {
                        // Do not let a slow Friend/Show response overwrite a newer detail view.
                        if (state.activeFriend?.nsaId !== requestedNsaId) return;

                        state.activeFriend = { ...friend, ...(full || {}) };
                        try { activeFriendDetailData = state.activeFriend; } catch { }

                        const howEl = $('friendDetailHowBecame');
                        if (howEl && typeof formatBecameFriendsRoute === 'function') {
                            howEl.textContent = formatBecameFriendsRoute(state.activeFriend.route || state.activeFriend.howBecameFriend);
                        }
                        const whenEl = $('friendDetailWhenBecame');
                        if (whenEl && typeof formatBecameFriendsDate === 'function') {
                            whenEl.textContent = formatBecameFriendsDate(
                                state.activeFriend.friendCreatedAt ||
                                state.activeFriend.becameFriendAt ||
                                state.activeFriend.createdAt
                            );
                        }

                        enhanceFriendDetail(state.activeFriend);
                    }).catch(() => { });

                    if (friend?.isNew) {
                        coralExact('friendIsNewDelete', { friendNsaId: requestedNsaId })
                            .then(() => { friend.isNew = false; })
                            .catch(() => { });
                    }
                }

                return result;
            };
            wrapped.__opFriendDetailWrapped = true;
            openFriendDetail = wrapped;
        }

        enhanceFriendDetail(state.activeFriend);
    }

    function enhanceFriendDetail(friend) {
        const view = $('friendDetailView');
        if (!view) return;
        const note = $('friendsNoteButton') || view.querySelector('.friend-detail-note');
        if (note && note.dataset.opBound !== 'true') {
            const clone = note.cloneNode(true);
            clone.dataset.opBound = 'true';
            clone.id = 'friendsNoteButton';
            note.replaceWith(clone);
            clone.addEventListener('click', openFriendNoteEditor);
            clone.addEventListener('keydown', (event) => {
                if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); openFriendNoteEditor(); }
            });
        }
        const fav = $('friendsFavouriteButton') || view.querySelector('.friend-detail-actions button:nth-child(1)');
        if (fav && fav.dataset.opBound !== 'true') {
            const clone = fav.cloneNode(true); clone.id = 'friendsFavouriteButton'; clone.dataset.opBound = 'true'; clone.disabled = false; fav.replaceWith(clone);
            clone.addEventListener('click', toggleFavoriteFriend);
        }
        const notify = $('friendsNotifyButton') || view.querySelector('.friend-detail-actions button:nth-child(2)');
        if (notify && notify.dataset.opBound !== 'true') {
            const clone = notify.cloneNode(true); clone.id = 'friendsNotifyButton'; clone.dataset.opBound = 'true'; clone.disabled = false; notify.replaceWith(clone);
            clone.addEventListener('click', toggleFriendOnlineNotice);
        }
        const more = $('friendsMoreButton') || view.querySelector('.friend-detail-more');
        if (more && more.dataset.opBound !== 'true') {
            $('friendsMoreMenu')?.remove();
            const clone = more.cloneNode(true);
            clone.id = 'friendsMoreButton';
            clone.dataset.opBound = 'true';
            clone.disabled = false;
            clone.setAttribute('aria-haspopup', 'menu');
            clone.setAttribute('aria-expanded', 'false');
            more.replaceWith(clone);
            clone.addEventListener('click', (event) => {
                event.preventDefault();
                event.stopPropagation();
                toggleFriendMoreMenu();
            });
        }

        ensureFriendMoreMenu();
        updateFriendDetailLabels(friend || state.activeFriend);
    }

    function animateFriendControl(button, html, enabled) {
        if (!button) return;
        button.dataset.enabled = enabled ? 'true' : 'false';
        if (button.innerHTML === html) return;

        button.innerHTML = html;
        if (typeof button.animate === 'function') {
            button.animate(
                [
                    { opacity: 0.55, transform: 'scale(0.985)' },
                    { opacity: 1, transform: 'scale(1)' }
                ],
                { duration: 150, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)' }
            );
        }
    }

    function updateFriendDetailLabels(friend) {
        if (!friend) return;

        const note = $('friendsNoteButton');
        const noteText = String(friend.note || '').trim();
        if (note) {
            const next = `<i class="fa-solid fa-pencil"></i> ${escapeHtml(noteText || 'Add Note')}`;
            if (note.innerHTML !== next) note.innerHTML = next;
        }

        animateFriendControl(
            $('friendsFavouriteButton'),
            `<i class="${friend.isFavoriteFriend ? 'fa-solid' : 'fa-regular'} fa-star"></i> Best Friends`,
            Boolean(friend.isFavoriteFriend)
        );

        animateFriendControl(
            $('friendsNotifyButton'),
            `<i class="${friend.isOnlineNotificationEnabled ? 'fa-solid' : 'fa-regular'} fa-bell"></i> Notify When Online`,
            Boolean(friend.isOnlineNotificationEnabled)
        );
    }

    function openFriendNoteEditor() {
        ensureScreens();
        const friend = state.activeFriend;
        if (!friend?.nsaId) return;
        const note = String(friend.note || '');
        $('opFriendNoteBody').innerHTML = `
            <p class="op-info-copy">You can leave notes for yourself about users on your friend list.</p>
            <label class="op-field"><span>Your note</span><textarea id="opFriendNoteInput" maxlength="20" placeholder="Your note">${escapeHtml(note)}</textarea><small><span id="opFriendNoteCount">${note.length}</span>/20</small></label>
            <p class="op-muted">Friends won't be able to see any notes you write about them.
Note contents can also be checked and edited on your Nintendo Switch 2/Nintendo Switch console.
Notes can contain any characters supported on Nintendo Switch 2/Nintendo Switch.</p>
            <button type="button" class="op-primary" id="opFriendNoteSave">Save</button>`;
        openScreen('opFriendNotePage');
        const input = $('opFriendNoteInput');
        input?.focus();
        input?.addEventListener('input', () => $('opFriendNoteCount').textContent = input.value.length);
        $('opFriendNoteSave')?.addEventListener('click', async () => {
            const value = input.value;
            if (value.length > 20) return;
            const button = $('opFriendNoteSave'); setBusy(button, true, tr('Loading…'));
            try {
                await coralExact('friendNote', { friendNsaId: friend.nsaId, note: value });
                friend.note = value;
                state.activeFriend.note = value;
                updateFriendDetailLabels(friend);
                toast(trKey('Album_Already_Saved'));

                const notePage = $('opFriendNotePage');
                if (notePage && typeof slideViewOut === 'function') slideViewOut(notePage);
                else notePage?.classList.add('hidden');
            } catch (error) { console.error('[UI action] request failed', error); alert(trKey('Error_Dialog_Message_CommunicationFailed')); }
            finally { setBusy(button, false); }
        });
    }

    async function toggleFavoriteFriend() {
        const friend = state.activeFriend;
        if (!friend?.nsaId) return;
        const button = $('friendsFavouriteButton');
        const desired = !friend.isFavoriteFriend;
        setBusy(button, true);
        try {
            await coralExact(desired ? 'favoriteAdd' : 'favoriteDelete', { nsaId: friend.nsaId });
            friend.isFavoriteFriend = desired; updateFriendDetailLabels(friend); toast(tr('Setting changed.'));
            if (typeof loadLiveFriendsList === 'function') loadLiveFriendsList().catch(() => { });
        } catch (error) { console.error('[UI action] request failed', error); alert(trKey('Error_Dialog_Message_CommunicationFailed')); }
        finally { setBusy(button, false); }
    }

    async function toggleFriendOnlineNotice() {
        const friend = state.activeFriend;
        if (!friend?.nsaId) return;
        const button = $('friendsNotifyButton');
        const desired = !friend.isOnlineNotificationEnabled;
        setBusy(button, true);
        try {
            await coralExact('friendOnlinePush', [{ type: 'friendOnline', value: desired, friendId: friend.nsaId }]);
            friend.isOnlineNotificationEnabled = desired; updateFriendDetailLabels(friend); toast(tr('Notification setting changed.'));
        } catch (error) { console.error('[UI action] request failed', error); alert(trKey('Error_Dialog_Message_CommunicationFailed')); }
        finally { setBusy(button, false); }
    }

    let friendMoreMenuOutsideBound = false;

    function ensureFriendMoreMenu() {
        let menu = $('friendsMoreMenu');
        if (menu) return menu;

        const view = $('friendDetailView');
        if (!view) return null;

        menu = document.createElement('div');
        menu.id = 'friendsMoreMenu';
        menu.className = 'friends-functional-menu hidden';
        menu.setAttribute('role', 'menu');
        menu.setAttribute('aria-label', tr('More friend options'));
        menu.innerHTML = `
            <button type="button" id="friendsDeleteFriend" class="danger" role="menuitem">
                <i class="fa-solid fa-user-minus"></i> Delete Friend
            </button>
            <button type="button" id="friendsBlockFriend" class="danger" role="menuitem">
                <i class="fa-solid fa-ban"></i> Block
            </button>`;
        view.appendChild(menu);

        $('friendsDeleteFriend')?.addEventListener('click', async (event) => {
            event.stopPropagation();
            closeFriendMoreMenu();
            await deleteActiveFriend();
        });
        $('friendsBlockFriend')?.addEventListener('click', async (event) => {
            event.stopPropagation();
            closeFriendMoreMenu();
            await blockActiveFriend();
        });

        if (!friendMoreMenuOutsideBound) {
            friendMoreMenuOutsideBound = true;

            document.addEventListener('click', (event) => {
                if (!event.target.closest('#friendsMoreMenu') && !event.target.closest('#friendsMoreButton')) {
                    closeFriendMoreMenu();
                }
            });

            document.addEventListener('keydown', (event) => {
                if (event.key === 'Escape') closeFriendMoreMenu();
            });
        }

        return menu;
    }

    function setFriendMoreMenuOpen(open, immediate = false) {
        const menu = ensureFriendMoreMenu();
        const more = $('friendsMoreButton');
        if (!menu) return;

        more?.setAttribute('aria-expanded', open ? 'true' : 'false');
        menu.getAnimations?.().forEach((animation) => animation.cancel());

        if (open) {
            menu.classList.remove('hidden');
            if (!immediate && typeof menu.animate === 'function') {
                menu.animate(
                    [
                        { opacity: 0, transform: 'translateY(-7px) scale(0.97)' },
                        { opacity: 1, transform: 'translateY(0) scale(1)' }
                    ],
                    { duration: 160, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)' }
                );
            }
            return;
        }

        if (menu.classList.contains('hidden')) return;
        if (immediate || typeof menu.animate !== 'function') {
            menu.classList.add('hidden');
            return;
        }

        const animation = menu.animate(
            [
                { opacity: 1, transform: 'translateY(0) scale(1)' },
                { opacity: 0, transform: 'translateY(-5px) scale(0.98)' }
            ],
            { duration: 120, easing: 'cubic-bezier(0.4, 0, 1, 1)' }
        );
        animation.finished.catch(() => { }).finally(() => menu.classList.add('hidden'));
    }

    function toggleFriendMoreMenu() {
        const menu = ensureFriendMoreMenu();
        if (!menu) return;
        setFriendMoreMenuOpen(menu.classList.contains('hidden'));
    }

    function closeFriendMoreMenu(immediate = false) {
        const menu = $('friendsMoreMenu');
        $('friendsMoreButton')?.setAttribute('aria-expanded', 'false');
        if (!menu) return;
        setFriendMoreMenuOpen(false, immediate);
    }

    function leaveFriendDetailAfterRemoval() {
        closeFriendMoreMenu(true);
        state.activeFriend = null;

        try {
            navTabStacks.friends = 'list';
            activeFriendDetailData = null;
        } catch { }

        const view = $('friendDetailView');
        const originTab = (() => {
            try { return friendDetailOriginTab || 'friends'; } catch { return 'friends'; }
        })();

        const finish = () => {
            if (typeof applyTabViewState === 'function') applyTabViewState(originTab);
        };

        if (view && typeof slideViewOut === 'function' && !view.classList.contains('hidden')) {
            slideViewOut(view, finish);
        } else {
            view?.classList.add('hidden');
            finish();
        }
    }

    async function deleteActiveFriend() {
        const friend = state.activeFriend;
        if (!friend?.nsaId) return;

        const ok = await confirmSheet(
            'Delete Friend',
            trKey('Friend_Remove_Alert'),
            'Delete Friend'
        );
        if (!ok) return;

        try {
            await coralExact('friendDelete', { nsaId: friend.nsaId });
            toast(trKey('Friend_Removed'));
            leaveFriendDetailAfterRemoval();
            if (typeof loadLiveFriendsList === 'function') loadLiveFriendsList().catch(() => { });
        } catch (error) {
            console.error('[UI action] request failed', error); alert(trKey('Error_Dialog_Message_CommunicationFailed'));
        }
    }

    async function blockActiveFriend() {
        const friend = state.activeFriend;
        if (!friend?.nsaId) return;

        const ok = await confirmSheet(
            'Block',
            trKey('Friend_Block_Alert'),
            'Block'
        );
        if (!ok) return;

        try {
            await coralExact('friendBlock', { nsaId: friend.nsaId });
            toast(trKey('Friend_Blocked'));
            leaveFriendDetailAfterRemoval();
            if (typeof loadLiveFriendsList === 'function') loadLiveFriendsList().catch(() => { });
        } catch (error) {
            console.error('[UI action] request failed', error); alert(trKey('Error_Dialog_Message_CommunicationFailed'));
        }
    }

    function confirmSheet(title, message, primary = 'OK') {
        return new Promise((resolve) => {
            let overlay = $('opConfirmOverlay');
            if (!overlay) {
                overlay = document.createElement('div');
                overlay.id = 'opConfirmOverlay';
                overlay.className = 'op-dialog-overlay hidden';
                document.body.appendChild(overlay);
            }
            overlay.innerHTML = `
                <div class="op-dialog" role="dialog" aria-modal="true">
                    <h3>${escapeHtml(title)}</h3>
                    <p>${escapeHtml(message)}</p>
                    <div class="op-dialog-actions"><button id="opDialogCancel">Cancel</button><button id="opDialogOk" class="primary">${escapeHtml(primary)}</button></div>
                </div>`;
            overlay.classList.remove('hidden');
            const dialog = overlay.querySelector('.op-dialog');

            overlay.getAnimations?.().forEach((animation) => animation.cancel());
            dialog?.getAnimations?.().forEach((animation) => animation.cancel());

            overlay.animate?.(
                [{ opacity: 0 }, { opacity: 1 }],
                { duration: 140, easing: 'ease-out' }
            );
            dialog?.animate?.(
                [
                    { opacity: 0, transform: 'translateY(18px) scale(0.98)' },
                    { opacity: 1, transform: 'translateY(0) scale(1)' }
                ],
                { duration: 180, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)' }
            );

            let settled = false;
            const finish = (value) => {
                if (settled) return;
                settled = true;

                const close = () => {
                    overlay.classList.add('hidden');
                    resolve(value);
                };

                if (typeof dialog?.animate !== 'function') {
                    close();
                    return;
                }

                const animation = dialog.animate(
                    [
                        { opacity: 1, transform: 'translateY(0) scale(1)' },
                        { opacity: 0, transform: 'translateY(10px) scale(0.985)' }
                    ],
                    { duration: 120, easing: 'cubic-bezier(0.4, 0, 1, 1)' }
                );
                animation.finished.catch(() => { }).finally(close);
            };

            $('opDialogCancel').onclick = () => finish(false);
            $('opDialogOk').onclick = () => finish(true);
            overlay.onclick = (event) => { if (event.target === overlay) finish(false); };
        });
    }

    function installChatCandidateReplacement() {
        bindControl('openVoiceChattedFriendsBtn', openChatCandidates);

        const close = $('closeChattedUsersBtn');
        close?.addEventListener('click', (event) => {
            const view = $('chattedUsersView');
            if (!view || view.classList.contains('hidden')) return;
            if (view.dataset.nsoReturnTarget !== 'addFriendView') return;

            event.preventDefault();
            event.stopImmediatePropagation();
            const addFriendView = $('addFriendView');
            if (addFriendView && typeof nsoApkBack === 'function') {
                nsoApkBack(view, addFriendView).finally(() => {
                    view.dataset.nsoReturnTarget = '';
                });
            } else {
                view.classList.add('hidden');
                addFriendView?.classList.remove('hidden');
                view.dataset.nsoReturnTarget = '';
            }
        }, { capture: true });

        const empty = $('chattedUsersView')?.querySelector('.chatted-users-empty');
        if (empty) empty.textContent = trKey('FriendRequest_GameChat_Empty');
    }

    function installProfileAndNotifications() {
        bindControl('userAvatarContainer', (event) => {
            event.preventDefault();
            event.stopImmediatePropagation();
            $('profileView')?.classList.add('hidden');
            openUserPage();
        }, { capture: true });
        bindControl('notificationBtn', (event) => {
            event.preventDefault();
            event.stopImmediatePropagation();
            $('notificationView')?.classList.add('hidden');
            openAnnouncements();
        }, { capture: true });
    }

    function installUserPageBindings() {
        ensureScreens();

        $('nativeFriendCodeCopyBtn')?.addEventListener('click', copyOwnFriendCode);
        $('nativeOnlineStatusChangeBtn')?.addEventListener('click', () => openVisibility('presence', 'opUserPage'));
        $('nativePlayActivityChangeBtn')?.addEventListener('click', () => openVisibility('playLog', 'opUserPage'));
        $('nativeSettingsBtn')?.addEventListener('click', openSettings);
        $('nativeAddFriendBtn')?.addEventListener('click', () => {
            const userPage = $('opUserPage');
            const addFriend = $('addFriendView');
            if (!addFriend) {
                $('openAddFriendBtn')?.click();
                return;
            }

            addFriend.dataset.nsoReturnTarget = 'opUserPage';
            assignPersistentViewOwner(addFriend, userPage?.dataset?.nsoOwnerTab || activeAppTab);
            if (userPage && typeof nsoApkForward === 'function') {
                // Keep the User Page painted underneath until Add Friend completely covers
                // it. This removes the one-frame Home flash from the old hide-then-open path.
                nsoApkForward(userPage, addFriend);
            } else if (typeof slideViewIn === 'function') {
                slideViewIn(addFriend);
            } else {
                addFriend.classList.remove('hidden');
            }
        });

        $('closeAddFriendBtn')?.addEventListener('click', (event) => {
            const addFriend = $('addFriendView');
            if (!addFriend || addFriend.dataset.nsoReturnTarget !== 'opUserPage') return;

            event.preventDefault();
            event.stopImmediatePropagation();
            const userPage = $('opUserPage');
            if (userPage && typeof nsoApkBack === 'function') {
                nsoApkBack(addFriend, userPage).finally(() => {
                    addFriend.dataset.nsoReturnTarget = '';
                });
            } else {
                addFriend.classList.add('hidden');
                userPage?.classList.remove('hidden');
                addFriend.dataset.nsoReturnTarget = '';
            }
        }, { capture: true });

        const userPageBack = $('opUserPage')?.querySelector('.op-back');
        userPageBack?.addEventListener('click', (event) => {
            event.preventDefault();
            event.stopImmediatePropagation();
            const userPage = $('opUserPage');
            if (!userPage) return;
            if (typeof slideViewOut === 'function') slideViewOut(userPage);
            else userPage.classList.add('hidden');
        }, { capture: true });

        document.addEventListener('keydown', (event) => {
            if (event.key !== 'Escape') return;
            const userPage = $('opUserPage');
            if (!userPage || userPage.classList.contains('hidden')) return;
            if (typeof slideViewOut === 'function') slideViewOut(userPage);
            else userPage.classList.add('hidden');
        });
    }

    function installAuthenticatedRefreshHook() {
        if (typeof showAuthenticatedUI === 'function' && !showAuthenticatedUI.__opWrapped) {
            const previous = showAuthenticatedUI;
            const wrapped = function (session) {
                const result = previous(session);
                queueMicrotask(() => {
                    if (localSetting('language', 'account') === 'account') applyAppLanguage(document);
                    refreshNativeData();
                });
                return result;
            };
            wrapped.__opWrapped = true;
            showAuthenticatedUI = wrapped;
        }
    }

    async function refreshNativeData() {
        if (state.refreshing) return state.refreshing;
        state.refreshing = (async () => {
            installAlbumFeatures();
            if (coralToken()) {
                coralExact('announcements').then((result) => {
                    state.announcements = Array.isArray(result) ? result : (result?.announcements || []);
                    updateAnnouncementDot();
                }).catch(() => { });
                startBrowserNotificationMonitor({ immediate: true });
            } else {
                stopBrowserNotificationMonitor();
            }
        })().finally(() => { state.refreshing = null; });
        return state.refreshing;
    }

    function installReceivedRequestText() {
        const host = $('receivedRequestsContainer');
        if (!host) return;
        const fix = () => {
            host.querySelectorAll('.friends-functional-request-actions').forEach((actions) => {
                const buttons = actions.querySelectorAll('button');
                if (buttons[0]) buttons[0].textContent = trKey('FriendRequest_Received_Confirm');
                if (buttons[1]) buttons[1].textContent = trKey('FriendRequest_Received_Decline');
            });
        };
        new MutationObserver(fix).observe(host, { childList: true, subtree: true });
        fix();
    }

    function init() {
        applyDarkMode();
        installSystemThemeWatcher();
        enforceMobileDataPreference();
        ensureScreens();
        installLanguageObserver();
        applyAppLanguage(document);
        installAuthenticatedRefreshHook();
        installBrowserNotificationLifecycle();
        installProfileAndNotifications();
        installUserPageBindings();
        installFriendOnlinePageReplacement();
        installExistingRequestSettingExactCall();
        installFriendDetailFeatures();
        installChatCandidateReplacement();
        installAlbumFeatures();
        installReceivedRequestText();
        refreshNativeData();
    }

    init();
})();
