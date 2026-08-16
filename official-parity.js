/**
 * Nintendo Switch App parity layer.
 *
 * Derived from the user's Nintendo Switch App 3.4.1 APK and wired against the
 * Coral helpers already present in nso-webapp. It deliberately leaves the
 * working authentication and game-specific WebView code alone.
 */
(() => {
    'use strict';

    if (window.__nsoOfficialParityLoaded) return;
    window.__nsoOfficialParityLoaded = true;

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
        announcements: [],
        loginFactor: null,
        screensReady: false,
        refreshing: null,
        mobileObserver: null
    };

    // Endpoints recovered from the official 3.4.1 APK / current Coral contract.
    // Flags mirror the Android client behavior rather than adding Coral headers
    // globally to every request.
    const ENDPOINTS = Object.freeze({
        currentUser:      { path: '/v4/User/ShowSelf' },
        permissions:      { path: '/v3/User/Permissions/ShowSelf', noParameter: true, requestId: true },
        permissionsWrite: { path: '/v4/User/Permissions/UpdateSelf' },
        friends:          { path: '/v4/Friend/List', platform: true },
        friendShow:       { path: '/v4/Friend/Show' },
        favoriteAdd:      { path: '/v3/Friend/Favorite/Create', platform: true },
        favoriteDelete:   { path: '/v3/Friend/Favorite/Delete', platform: true },
        friendNote:       { path: '/v4/Friend/Note/Update' },
        friendDelete:     { path: '/v3/Friend/Delete' },
        friendBlock:      { path: '/v3/User/Block/Create' },
        friendChatSelect: { path: '/v5/Chat/SelectedList/Update' },
        friendOnlinePush: { path: '/v5/PushNotification/Settings/Update' },
        friendPlayLog:    { path: '/v4/User/PlayLog/Show' },
        chatCandidates:   { path: '/v5/Chat/FriendCandidate/List' },
        friendRequest:    { path: '/v4/FriendRequest/Create' },
        chats:            { path: '/v5/Chat/List' },
        chatShow:         { path: '/v5/Chat/Show' },
        pushList:         { path: '/v5/PushNotification/Settings/List' },
        pushUpdate:       { path: '/v5/PushNotification/Settings/Update' },
        webServices:      { path: '/v4/GameWebService/List', noParameter: true, requestId: true },
        announcements:    { path: '/v4/Announcement/List', platform: true },
        announcementRead: { path: '/v4/Announcement/MarkAsRead', platform: true },
        mediaHashtags:    { path: '/v5/Hashtag/List' },
        feedback:         { path: '/v1/Support/SendOpinion' },
        loginFactor:      { path: '/v4/NA/User/LoginFactor/Show' }
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
            return new Intl.DateTimeFormat(undefined, withTime
                ? { dateStyle: 'medium', timeStyle: 'short' }
                : { dateStyle: 'medium' }).format(new Date(ms));
        } catch {
            return new Date(ms).toLocaleString();
        }
    }

    function relativeTime(value) {
        const ms = toMillis(value);
        if (!ms) return '';
        const sec = Math.max(0, Math.floor((Date.now() - ms) / 1000));
        if (sec < 60) return 'Just now';
        if (sec < 3600) return `${Math.floor(sec / 60)} min. ago`;
        if (sec < 86400) return `${Math.floor(sec / 3600)} hr. ago`;
        return `${Math.floor(sec / 86400)} d. ago`;
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
        } catch {}
        try {
            return userSession?.result?.webApiServerCredential?.accessToken ||
                userSession?.webApiServerCredential?.accessToken ||
                userSession?.accessToken || null;
        } catch {
            return null;
        }
    }

    /**
     * Exact-ish Coral call for the endpoints added by this parity layer.
     * Existing project calls are intentionally not monkey-patched, so working
     * game services and auth remain untouched.
     */
    async function coralExact(name, parameter = undefined, bodyOverride = undefined) {
        const meta = ENDPOINTS[name];
        if (!meta) throw new Error(`Blocked unknown Coral operation: ${name}`);
        const token = coralToken();
        if (!token) throw new Error('No Coral access token is available. Sign in again.');
        if (typeof nxapiEncryptRequest !== 'function' || typeof proxyFetch !== 'function' || typeof parseCoralResponse !== 'function') {
            throw new Error('The Coral encryption bridge is not ready.');
        }

        const url = BASE + meta.path;
        let body;
        if (bodyOverride !== undefined) {
            body = bodyOverride;
        } else if (meta.noParameter) {
            body = meta.requestId ? { requestId: uuid() } : {};
        } else {
            body = { parameter: parameter === undefined ? {} : parameter };
        }

        const encrypted = await nxapiEncryptRequest(url, token, JSON.stringify(body));
        const headers = {
            'Content-Type': 'application/octet-stream',
            'Accept': 'application/octet-stream,application/json',
            'Accept-Language': 'en-GB',
            'Authorization': `Bearer ${token}`,
            'User-Agent': typeof zncaUserAgent === 'function' ? zncaUserAgent() : 'com.nintendo.znca/3.4.1(Android/12)',
            'Pragma': 'no-cache',
            'Cache-Control': 'no-cache'
        };
        if (meta.platform) headers['X-Platform'] = typeof ZNCA_PLATFORM !== 'undefined' ? ZNCA_PLATFORM : 'Android';
        if (meta.productVersion) headers['X-ProductVersion'] = typeof ZNCA_VERSION !== 'undefined' ? ZNCA_VERSION : '3.4.1';

        const response = await proxyFetch(url, {
            method: 'POST',
            headers,
            bodyBase64: encrypted
        });
        const data = await parseCoralResponse(response);
        if (!response.ok || !data || data.status !== 0 || !Object.prototype.hasOwnProperty.call(data, 'result')) {
            const status = data?.status ?? response.status;
            const message = data?.errorMessage || data?.error || `Nintendo API request failed (${status}).`;
            const error = new Error(message);
            error.coralStatus = data?.status;
            throw error;
        }
        return data.result;
    }

    function toast(message) {
        let el = $('officialParityToast');
        if (!el) {
            el = document.createElement('div');
            el.id = 'officialParityToast';
            el.className = 'op-toast';
            document.body.appendChild(el);
        }
        el.textContent = message;
        el.classList.add('show');
        clearTimeout(toast.timer);
        toast.timer = setTimeout(() => el.classList.remove('show'), 2200);
    }

    function replaceControl(id, handler, options = {}) {
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
            button.dataset.oldHtml = button.innerHTML;
            button.disabled = true;
            if (busyText) button.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> ${escapeHtml(busyText)}`;
        } else {
            button.disabled = false;
            if (button.dataset.oldHtml != null) {
                button.innerHTML = button.dataset.oldHtml;
                delete button.dataset.oldHtml;
            }
        }
    }

    function closeParityScreens(except = null) {
        document.querySelectorAll('.op-screen').forEach((screen) => {
            if (screen.id !== except) screen.classList.add('hidden');
        });
    }

    function openScreen(id) {
        closeParityScreens(id);
        $(id)?.classList.remove('hidden');
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
            <div class="op-profile-hero">
                <img id="opUserAvatar" src="" alt="">
                <h3 id="opUserName">Switch Player</h3>
            </div>
            <section class="op-group">
                <h4>Nintendo Account</h4>
                <button class="op-row" id="opFriendCodeRow"><span><b>Friend Code</b><small id="opFriendCode">—</small></span><i class="fa-solid fa-chevron-right"></i></button>
                <button class="op-row" id="opOnlineStatusRow"><span><b>Online Status</b><small id="opOnlineStatusSummary">—</small></span><i class="fa-solid fa-chevron-right"></i></button>
                <button class="op-row" id="opPlayActivityRow"><span><b>Play Activity</b><small id="opPlayActivitySummary">—</small></span><i class="fa-solid fa-chevron-right"></i></button>
                <button class="op-row" id="opNintendoAccountRow"><span><b>Nintendo Account Website</b></span><i class="fa-solid fa-arrow-up-right-from-square"></i></button>
            </section>
            <section class="op-group">
                <h4>Other</h4>
                <button class="op-row" id="opPushNotificationsRow"><span><b>Push Notifications</b></span><i class="fa-solid fa-chevron-right"></i></button>
                <button class="op-row" id="opAppSettingsRow"><span><b>Settings</b></span><i class="fa-solid fa-chevron-right"></i></button>
            </section>
            <button class="op-signout" id="opSignOutBtn"><i class="fa-solid fa-right-from-bracket"></i> Sign Out</button>`);

        screenShell('opVisibilityPage', 'Setting', `<div id="opVisibilityBody"></div>`);
        screenShell('opPushPage', 'Push Notifications', `<div id="opPushBody"></div>`);
        screenShell('opFriendOnlinePage', 'Notify When Friends Come Online', `
            <div class="op-info-card">You'll get online-status notifications for friends (max of once per 30 mins. for each friend).</div>
            <div id="opFriendOnlineList" class="op-list"></div>`);
        screenShell('opSettingsPage', 'Settings', `<div id="opSettingsBody"></div>`);
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
        screenShell('opFriendActionsPage', 'Friend', `<div id="opFriendActionsBody"></div>`);
        screenShell('opAlbumAboutPage', 'About the Upload Feature', `
            <div class="op-copy-page">
                <p>Screenshots and videos uploaded from your Nintendo Switch 2 will be displayed here.</p>
                <h3>How to Upload</h3>
                <ol class="op-steps">
                    <li><b>Power on your Nintendo Switch 2 system.</b><small>Nintendo Switch systems don't support the upload feature.</small></li>
                    <li><b>Open the Album.</b></li>
                    <li><b>Upload screenshots and videos.</b><small>Pick which screenshots and videos you want to upload and then select Upload to Smart Device.</small></li>
                </ol>
                <div class="op-info-card">Up to 100 files can be uploaded and stored for up to 30 days. If you attempt to store more than 100 files, the oldest uploads will be overwritten.</div>
                <h3>Uploading Is Easy with Automatic Uploads</h3>
                <p>The automatic-uploads feature allows you to automatically upload any screenshot or video as soon as you capture it.</p>
                <p class="op-muted">You can enable automatic uploads from the upload settings on your Nintendo Switch 2 system.</p>
            </div>`);

        wireScreenBackNavigation();
    }

    function wireScreenBackNavigation() {
        const parents = {
            opVisibilityPage: 'opUserPage',
            opPushPage: 'opUserPage',
            opFriendOnlinePage: 'opPushPage',
            opSettingsPage: 'opUserPage',
            opDarkModePage: 'opSettingsPage',
            opMobileDataPage: 'opSettingsPage',
            opUsageDataPage: 'opSettingsPage',
            opLegalPage: 'opSettingsPage',
            opLicenseDetailPage: 'opLegalPage',
            opFeedbackPage: 'opSettingsPage',
            opAnnouncementDetailPage: 'opAnnouncementPage',
            opChatDetailPage: 'opChatPage',
            opChatCandidatePage: 'chattedUsersView',
            opFriendNotePage: 'friendDetailView',
            opFriendActionsPage: 'friendDetailView'
        };
        for (const [child, parent] of Object.entries(parents)) {
            const back = $(child)?.querySelector('.op-back');
            if (!back) continue;
            replaceNodeListener(back, () => {
                $(child)?.classList.add('hidden');
                if (parent.startsWith('op')) openScreen(parent);
                else $(parent)?.classList.remove('hidden');
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
            return ({ FRIENDS: 'All Friends', FAVORITE_FRIENDS: 'Best Friends', SELF: 'No One' })[value] || value || '—';
        }
        return ({ EVERYONE: 'All Users', FRIENDS: 'Friends', FAVORITE_FRIENDS: 'Best Friends', SELF: 'No One' })[value] || value || '—';
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
        if (user) state.currentUser = user;
        if (permissions) state.permissions = permissions;
    }

    async function openUserPage() {
        ensureScreens();
        const user = sessionUser();
        $('opUserAvatar').src = user?.imageUri || user?.image2Uri || $('profileViewAvatar')?.src || '';
        $('opUserName').textContent = user?.name || user?.nickname || $('profileViewName')?.textContent || 'Switch Player';
        $('opFriendCode').textContent = user?.links?.friendCode?.id || $('profileViewFriendCode')?.textContent || '—';
        openScreen('opUserPage');

        try {
            await loadCurrentUserAndPermissions(true);
            const full = state.currentUser || user || {};
            $('opUserAvatar').src = full.imageUri || full.image2Uri || $('opUserAvatar').src;
            $('opUserName').textContent = full.name || $('opUserName').textContent;
            $('opFriendCode').textContent = full.links?.friendCode?.id || $('opFriendCode').textContent;
            const p = state.permissions?.permissions || full.permissions || {};
            $('opOnlineStatusSummary').textContent = permissionLabel('presence', p.presence);
            $('opPlayActivitySummary').textContent = permissionLabel('playLog', p.playLog);
        } catch (error) {
            console.warn('[OfficialParity] User Page refresh failed', error);
        }
    }

    async function openVisibility(kind) {
        ensureScreens();
        await loadCurrentUserAndPermissions();
        const isPresence = kind === 'presence';
        const screen = $('opVisibilityPage');
        const title = isPresence ? 'Display Online Status' : 'Show Play Activity';
        screen.querySelector('h2').textContent = title;
        const current = state.permissions?.permissions?.[kind] || state.currentUser?.permissions?.[kind];
        const options = isPresence
            ? [
                ['FRIENDS', 'All Friends'],
                ['FAVORITE_FRIENDS', 'Best Friends'],
                ['SELF', 'No One']
              ]
            : [
                ['EVERYONE', 'All Users'],
                ['FRIENDS', 'Friends'],
                ['FAVORITE_FRIENDS', 'Best Friends'],
                ['SELF', 'No One']
              ];
        const notice = isPresence
            ? "You can set who can see your online status. Friends who can't see your online status may not be able to join you during online play. Changing the setting here will update the setting on your system."
            : "If you choose to make your play activity visible to some users, they'll be able to see how long you've spent playing each game, as well as information about when you first played them.";

        $('opVisibilityBody').innerHTML = `
            <p class="op-page-prompt">${escapeHtml(isPresence ? 'Who do you want to see your online status?' : 'Who do you want to see your play activity?')}</p>
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
                    toast('Setting changed.');
                } catch (error) {
                    alert(`Could not update setting: ${error.message}`);
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

    async function openPushNotifications() {
        ensureScreens();
        openScreen('opPushPage');
        const body = $('opPushBody');
        body.innerHTML = '<p class="op-loading"><i class="fa-solid fa-spinner fa-spin"></i> Loading…</p>';
        try {
            const [settings, services] = await Promise.all([
                loadPushSettings(true),
                loadWebServicesForSettings(true).catch(() => [])
            ]);
            body.innerHTML = `
                <section class="op-group op-no-margin">
                    <label class="op-toggle-row"><span><b>Friend Requests</b><small>You'll get notifications when receiving friend requests and when other users accept your friend requests.</small></span><input id="opPushFriendRequest" type="checkbox" ${settings.friendRequest ? 'checked' : ''}><i></i></label>
                    <label class="op-toggle-row"><span><b>GameChat Invites</b><small>You'll get GameChat-invite notifications.</small></span><input id="opPushChatInvitation" type="checkbox" ${settings.chatInvitation ? 'checked' : ''}><i></i></label>
                    <button class="op-row" id="opPushFriendOnline"><span><b>Notify When Friends Come Online</b><small>Choose individual friends.</small></span><i class="fa-solid fa-chevron-right"></i></button>
                </section>
                <section class="op-group">
                    <h4>Online Play Invitations</h4>
                    <p class="op-group-notice">You'll get play-invite notifications.</p>
                    <div class="op-radio-list" id="opPlayInviteRadios">
                        ${[['FRIENDS','All Friends'],['FAVORITE_FRIENDS','Best Friends'],['NONE',"Don't Notify"]].map(([value,label]) => `<label class="op-radio-row"><span>${escapeHtml(label)}</span><input type="radio" name="opPlayInvite" value="${value}" ${settings.playInvitation === value ? 'checked' : ''}></label>`).join('')}
                    </div>
                </section>
                <section class="op-group">
                    <h4>Game-Specific Services</h4>
                    <p class="op-group-notice">You'll get game-related notifications.</p>
                    <div id="opGwsPushList">${renderGwsPushRows(services)}</div>
                </section>`;

            bindPushControls(services);
        } catch (error) {
            body.innerHTML = `<p class="service-status error">Couldn't load notification settings: ${escapeHtml(error.message)}</p>`;
        }
    }

    function renderGwsPushRows(services) {
        const supported = (services || []).filter((s) => s?.isNotificationSupported);
        if (!supported.length) return '<p class="op-muted op-pad">No game-specific notification settings are available.</p>';
        return supported.map((s) => `
            <label class="op-toggle-row op-gws-toggle">
                <span class="op-gws-label"><img src="${escapeHtml(s.imageUri || '')}" alt=""><b>${escapeHtml(s.name || 'Game-Specific Service')}</b></span>
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
                    toast('Notification setting changed.');
                } catch (error) {
                    input.checked = !desired;
                    alert(`Could not update notification setting: ${error.message}`);
                } finally { input.disabled = false; }
            });
        };
        bindToggle('opPushFriendRequest', 'friendRequest');
        bindToggle('opPushChatInvitation', 'chatInvitation');
        $('opPushFriendOnline')?.addEventListener('click', openFriendOnlineSettings);

        $('opPlayInviteRadios')?.querySelectorAll('input').forEach((input) => {
            input.addEventListener('change', async () => {
                if (!input.checked) return;
                const old = state.pushSettings.playInvitation;
                $('opPlayInviteRadios').querySelectorAll('input').forEach((x) => x.disabled = true);
                try {
                    await updatePush({ type: 'playInvitation', scope: input.value });
                    toast('Notification setting changed.');
                } catch (error) {
                    const prev = $('opPlayInviteRadios').querySelector(`input[value="${CSS.escape(old || '')}"]`);
                    if (prev) prev.checked = true;
                    alert(`Could not update notification setting: ${error.message}`);
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
                    toast('Notification setting changed.');
                } catch (error) {
                    input.checked = !desired;
                    alert(`Could not update game notification setting: ${error.message}`);
                } finally { input.disabled = false; }
            });
        });
    }

    async function openFriendOnlineSettings() {
        ensureScreens();
        openScreen('opFriendOnlinePage');
        const list = $('opFriendOnlineList');
        let friends = getCurrentFriends();
        if (!friends.length) {
            try {
                const result = await coralExact('friends');
                friends = Array.isArray(result) ? result : (result?.friends || []);
            } catch {}
        }
        if (!friends.length) {
            list.innerHTML = '<p class="op-empty">Friends will appear here.</p>';
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
                    toast('Notification setting changed.');
                } catch (error) {
                    input.checked = !desired;
                    alert(`Could not update online notification: ${error.message}`);
                } finally { input.disabled = false; }
            });
        });
    }

    function localSetting(key, fallback = '') {
        try {
            const value = localStorage.getItem(`nso_official_${key}`);
            return value == null ? fallback : value;
        } catch { return fallback; }
    }

    function saveLocalSetting(key, value) {
        try { localStorage.setItem(`nso_official_${key}`, String(value)); } catch {}
    }

    function darkModeLabel(mode) {
        return ({ system: 'Device Settings', on: 'On', off: 'Off' })[mode] || 'Device Settings';
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
        } catch {}
    }

    function installSystemThemeWatcher() {
        const media = globalThis.matchMedia?.('(prefers-color-scheme: dark)');
        if (!media || media.__nsoParityBound) return;
        media.__nsoParityBound = true;
        media.addEventListener?.('change', () => {
            if (localSetting('dark_mode', 'system') === 'system') applyDarkMode('system');
        });
    }

    function openDarkModeSetting() {
        ensureScreens();
        const current = localSetting('dark_mode', 'system');
        $('opDarkModeBody').innerHTML = `
            <div class="op-radio-list">
                ${[['system','Device Settings'],['on','On'],['off','Off']].map(([value,label]) => `
                    <label class="op-radio-row"><span>${label}</span><input type="radio" name="opDarkMode" value="${value}" ${current === value ? 'checked' : ''}></label>`).join('')}
            </div>
            <div class="op-info-card">If set to Device Settings, the app display will change to match the settings on the device you're using.</div>`;
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
        return ({ standard: 'Standard', low: 'Low Data', never: "Don't Allow" })[value] || 'Standard';
    }

    function openMobileDataSetting() {
        ensureScreens();
        const current = localSetting('mobile_data', 'standard');
        $('opMobileDataBody').innerHTML = `
            <div class="op-radio-list">
                ${[['standard','Standard'],['low','Low Data'],['never',"Don't Allow"]].map(([value,label]) => `
                    <label class="op-radio-row"><span>${label}</span><input type="radio" name="opMobileData" value="${value}" ${current === value ? 'checked' : ''}></label>`).join('')}
            </div>
            <div class="op-info-card">If set to Low Data, videos won't play automatically. If set to Don't Allow, videos won't load.<br><br>Features will not be restricted when using a Wi-Fi connection.</div>`;
        openScreen('opMobileDataPage');
        $('opMobileDataBody').querySelectorAll('input[name="opMobileData"]').forEach((input) => {
            input.addEventListener('change', () => {
                if (!input.checked) return;
                saveLocalSetting('mobile_data', input.value);
                enforceMobileDataPreference();
                renderSettingsPage();
                toast('Mobile-data setting changed.');
            });
        });
    }

    function openUsageDataSetting() {
        ensureScreens();
        const allowed = localSetting('usage_data', 'deny') === 'allow';
        $('opUsageDataBody').innerHTML = `
            <div class="op-copy-page">
                <p>If you select Allow, this application and its game-specific services will collect data, including via cookies, and will send it to Nintendo in order to analyze Nintendo's performance and provide Nintendo with statistics to optimize content, products, and services.</p>
                <p>You can change this setting at any time from About Sending Usage Data. If you change this setting, this will not affect data that was already collected.</p>
                <div class="op-radio-list op-inline-radio-list">
                    <label class="op-radio-row"><span>Allow</span><input type="radio" name="opUsageData" value="allow" ${allowed ? 'checked' : ''}></label>
                    <label class="op-radio-row"><span>Don't Allow</span><input type="radio" name="opUsageData" value="deny" ${!allowed ? 'checked' : ''}></label>
                </div>
                <p class="op-muted">Web-port note: this preference is preserved locally. The web port does not invent a Nintendo analytics transport that is not present in this project.</p>
            </div>`;
        openScreen('opUsageDataPage');
        $('opUsageDataBody').querySelectorAll('input[name="opUsageData"]').forEach((input) => {
            input.addEventListener('change', () => {
                if (!input.checked) return;
                saveLocalSetting('usage_data', input.value);
                renderSettingsPage();
                toast('Usage-data preference changed.');
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
        host.innerHTML = '<p class="op-empty"><i class="fa-solid fa-spinner fa-spin"></i> Loading notices…</p>';
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
                    <span><b>${escapeHtml(item.name || item.dependency || 'Open-source software')}</b><small>${escapeHtml(item.dependency || '')}</small></span><i class="fa-solid fa-chevron-right"></i>
                </button>`).join('')}</div>`;
            host.querySelectorAll('[data-license-index]').forEach((button) => {
                button.addEventListener('click', () => {
                    const item = packages[Number(button.dataset.licenseIndex)];
                    openLicenseDetail(item);
                });
            });
        } catch (error) {
            host.innerHTML = `<p class="op-empty">Could not load intellectual-property notices: ${escapeHtml(error.message)}</p>`;
        }
    }

    function openLicenseDetail(item) {
        const data = state.thirdPartyLicenses || {};
        const files = item?.license_file_names || [];
        const text = files.map((name) => data.licenses?.[name] || '').filter(Boolean).join('\n\n');
        $('opLicenseDetailPage').querySelector('h2').textContent = item?.name || 'License';
        $('opLicenseDetailBody').innerHTML = `
            <div class="op-copy-page op-license-detail">
                ${item?.dependency ? `<p><b>${escapeHtml(item.dependency)}</b></p>` : ''}
                ${item?.url ? `<p><a class="op-inline-link" href="${escapeHtml(item.url)}" target="_blank" rel="noopener noreferrer">Project Website <i class="fa-solid fa-arrow-up-right-from-square"></i></a></p>` : ''}
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
        $('opSettingsBody').innerHTML = `
            <section class="op-group op-no-margin">
                <h4>Account Information</h4>
                <button class="op-row" id="opSettingsProfile"><span><b>Profile</b><small>${escapeHtml(profileSummary)}</small></span><i class="fa-solid fa-chevron-right"></i></button>
            </section>
            <section class="op-group">
                <h4>System</h4>
                <button class="op-row" id="opSettingsDarkMode"><span><b>Dark Mode</b><small>${escapeHtml(darkModeLabel(localSetting('dark_mode', 'system')))}</small></span><i class="fa-solid fa-chevron-right"></i></button>
                <button class="op-row" id="opSettingsMobileData"><span><b>Mobile Data</b><small>${escapeHtml(mobileDataLabel(localSetting('mobile_data', 'standard')))}</small></span><i class="fa-solid fa-chevron-right"></i></button>
                <button class="op-row" id="opSettingsStorage"><span><b>Storage</b><small>Clear cached images and data.</small></span><i class="fa-solid fa-chevron-right"></i></button>
                <button class="op-row" id="opSettingsUsageData"><span><b>About Sending Usage Data</b><small>${usageAllowed ? 'Allow Sending Usage Data' : "Don't Allow"}</small></span><i class="fa-solid fa-chevron-right"></i></button>
            </section>
            <section class="op-group">
                <h4>Other</h4>
                <button class="op-row" id="opSettingsFeedback"><span><b>Feedback</b><small>Send feedback about this app.</small></span><i class="fa-solid fa-chevron-right"></i></button>
            </section>
            <section class="op-group">
                <h4>About This App</h4>
                <a class="op-row" href="https://accounts.nintendo.com/term_chooser/eula" target="_blank" rel="noopener"><span><b>Nintendo Account User Agreement</b></span><i class="fa-solid fa-arrow-up-right-from-square"></i></a>
                <a class="op-row" href="https://www.nintendo.com/privacy-policy/" target="_blank" rel="noopener"><span><b>Nintendo Privacy Policy</b></span><i class="fa-solid fa-arrow-up-right-from-square"></i></a>
                <button class="op-row" id="opSettingsLegal"><span><b>Intellectual Property Notices</b></span><i class="fa-solid fa-chevron-right"></i></button>
                <a class="op-row" href="https://support.nintendo.com/" target="_blank" rel="noopener"><span><b>Nintendo Support</b></span><i class="fa-solid fa-arrow-up-right-from-square"></i></a>
                ${supportCode ? `<div class="op-row op-static"><span><b>Support Code</b><small>${escapeHtml(supportCode)}</small></span></div>` : ''}
                <div class="op-row op-static"><span><b>Version</b><small>${escapeHtml(version)}</small></span></div>
                <div class="op-row op-static"><span><b>© Nintendo</b></span></div>
            </section>`;
        $('opSettingsProfile')?.addEventListener('click', () => {
            $('opSettingsPage')?.classList.add('hidden');
            openUserPage();
        });
        $('opSettingsDarkMode')?.addEventListener('click', openDarkModeSetting);
        $('opSettingsMobileData')?.addEventListener('click', openMobileDataSetting);
        $('opSettingsUsageData')?.addEventListener('click', openUsageDataSetting);
        $('opSettingsLegal')?.addEventListener('click', openLegalNotices);
        $('opSettingsFeedback')?.addEventListener('click', openFeedback);
        $('opSettingsStorage')?.addEventListener('click', async () => {
            const ok = await confirmSheet('Clear cached images and data?', 'Cached images and data will be cleared, freeing up space on your device.', 'Clear');
            if (!ok) return;
            try {
                if ('caches' in window) {
                    const keys = await caches.keys();
                    await Promise.all(keys.map((key) => caches.delete(key)));
                }
                toast('Cleared cache.');
            } catch (error) {
                alert(`Couldn't clear cache: ${error.message}`);
            }
        });
    }

    async function openSettings() {
        ensureScreens();
        openScreen('opSettingsPage');
        await loadCurrentUserAndPermissions().catch(() => {});
        if (!state.loginFactor) {
            state.loginFactor = await coralExact('loginFactor').catch(() => null);
        }
        renderSettingsPage();
    }

    function openFeedback() {
        ensureScreens();
        $('opFeedbackBody').innerHTML = `
            <p class="op-page-prompt">Send feedback about this app.</p>
            <label class="op-field"><span>Topic</span><select id="opFeedbackTopic">
                <option value="4">About Game-Specific Services</option>
                <option value="9">Friend Features</option>
                <option value="10">The Album Feature</option>
                <option value="6">Features You'd Like to See</option>
                <option value="8">App Problems</option>
                <option value="0">Other</option>
            </select></label>
            <label class="op-field"><span>Description</span><textarea id="opFeedbackText" maxlength="1000" placeholder="Your Feedback"></textarea><small id="opFeedbackCount">0/1000</small></label>
            <p class="op-muted">Please be aware that we don't directly reply to feedback we receive.</p>
            <button type="button" class="op-primary" id="opFeedbackSubmit">Submit</button>`;
        openScreen('opFeedbackPage');
        const text = $('opFeedbackText');
        text?.addEventListener('input', () => $('opFeedbackCount').textContent = `${text.value.length}/1000`);
        $('opFeedbackSubmit')?.addEventListener('click', async () => {
            const message = text.value.trim();
            if (!message) { text.focus(); return; }
            const button = $('opFeedbackSubmit');
            setBusy(button, true, 'Submitting…');
            try {
                await coralExact('feedback', {
                    category: Number($('opFeedbackTopic').value),
                    message
                });
                $('opFeedbackBody').innerHTML = `
                    <div class="op-success-state"><i class="fa-solid fa-circle-check"></i><h3>Feedback submitted.</h3><p>We always strive to improve our services. Thanks for your feedback!</p></div>`;
            } catch (error) {
                alert(`Could not submit feedback: ${error.message}`);
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
            <div class="op-section-title-row"><h2>GameChat</h2><button type="button" id="opOpenChatPage">Details</button></div>
            <div id="opHomeChatContent" class="op-chat-strip"><p class="service-status">Loading GameChat…</p></div>`;
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
                host.innerHTML = `<button type="button" class="op-chat-empty-card" id="opChatHowToHome"><i class="fa-solid fa-comments"></i><span><b>You can use GameChat from your Nintendo Switch 2 system.</b><small>How to Use GameChat</small></span><i class="fa-solid fa-chevron-right"></i></button>`;
                $('opChatHowToHome')?.addEventListener('click', openChatPage);
                return;
            }
            host.innerHTML = chats.slice(0, 4).map((chat, index) => `
                <button class="op-chat-card" data-chat-index="${index}">
                    <img src="${escapeHtml(chat.inviter.imageUri)}" alt="">
                    <span><b>${escapeHtml(chat.inviter.isMe ? 'Invitation you sent' : `Invitation from ${chat.inviter.name || 'a friend'}`)}</b><small>${escapeHtml(relativeTime(chat.invitedAt))}</small></span>
                </button>`).join('');
            host.querySelectorAll('[data-chat-index]').forEach((button) => button.addEventListener('click', () => openChatDetail(chats[Number(button.dataset.chatIndex)])));
        } catch (error) {
            // GameChat may not be available to every account. Keep Home usable.
            host.innerHTML = `<button type="button" class="op-chat-empty-card" id="opChatHowToHome"><i class="fa-solid fa-comments"></i><span><b>You can use GameChat from your Nintendo Switch 2 system.</b><small>How to Use GameChat</small></span><i class="fa-solid fa-chevron-right"></i></button>`;
            $('opChatHowToHome')?.addEventListener('click', openChatPage);
            console.debug('[OfficialParity] Chat/List unavailable', error);
        }
    }

    function howToChatHtml() {
        return `
            <div class="op-info-card">You can use GameChat from your Nintendo Switch 2 system.</div>
            <h3 class="op-subtitle">How to Use GameChat</h3>
            <ol class="op-steps">
                <li><b>Power on your Nintendo Switch 2 system.</b><small>◆ This feature cannot be used on a Nintendo Switch system.</small></li>
                <li><b>Open GameChat.</b><small>To open GameChat, you can also go to the HOME Menu and select GameChat.</small></li>
                <li><b>Join or start a chat session!</b></li>
            </ol>`;
    }

    async function openChatPage() {
        ensureScreens();
        const body = $('opChatBody');
        body.innerHTML = '<p class="op-loading"><i class="fa-solid fa-spinner fa-spin"></i> Loading…</p>';
        openScreen('opChatPage');
        try {
            const chats = await loadChats(true);
            body.innerHTML = `${howToChatHtml()}<h3 class="op-subtitle">Chat Invitations</h3><div id="opChatList"></div>`;
            const list = $('opChatList');
            if (!chats.length) {
                list.innerHTML = '<p class="op-empty">No chat invitations right now.</p>';
            } else {
                list.innerHTML = chats.map((chat, index) => `
                    <button class="op-chat-list-row" data-chat-index="${index}">
                        <img src="${escapeHtml(chat.inviter.imageUri)}" alt="">
                        <span><b>${escapeHtml(chat.inviter.isMe ? 'Invitation you sent' : `Invitation from ${chat.inviter.name || 'a friend'}`)}</b><small>${escapeHtml(formatDate(chat.invitedAt))}</small></span>
                        <i class="fa-solid fa-chevron-right"></i>
                    </button>`).join('');
                list.querySelectorAll('[data-chat-index]').forEach((button) => button.addEventListener('click', () => openChatDetail(chats[Number(button.dataset.chatIndex)])));
            }
        } catch (error) {
            body.innerHTML = `${howToChatHtml()}<p class="service-status error">Couldn't load GameChat invitations: ${escapeHtml(error.message)}</p>`;
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
        body.innerHTML = '<p class="op-loading"><i class="fa-solid fa-spinner fa-spin"></i> Loading…</p>';
        if (!chat?.chatId) {
            body.innerHTML = '<p class="op-empty">Couldn\'t find the chat.</p>';
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
                <div class="op-chat-detail-hero"><i class="fa-solid fa-comments"></i><h3>${escapeHtml(inviter?.isMe ? 'Started by you' : `Invited by ${inviter?.name || chat.inviter.name || 'a friend'}`)}</h3><p>${escapeHtml(formatDate(started))}</p></div>
                ${renderChatMemberSection('Users in Chat', members.filter((m) => m.isJoined))}
                ${renderChatMemberSection('Not friends', members.filter((m) => !m.isFriend && !m.isMe))}
                ${renderChatMemberSection('Other Invited Users', members.filter((m) => !m.isJoined && (m.isFriend || m.isMe)))}
            `;
        } catch (error) {
            body.innerHTML = `<p class="service-status error">Couldn't find the chat: ${escapeHtml(error.message)}</p>`;
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
        body.innerHTML = '<p class="op-loading"><i class="fa-solid fa-spinner fa-spin"></i> Loading…</p>';
        try {
            const result = await coralExact('announcements');
            state.announcements = Array.isArray(result) ? result : (result?.announcements || []);
            renderAnnouncements();
        } catch (error) {
            body.innerHTML = `<p class="service-status error">Couldn't load notifications: ${escapeHtml(error.message)}</p>`;
        }
    }

    function renderAnnouncements() {
        const body = $('opAnnouncementBody');
        if (!state.announcements.length) {
            body.innerHTML = '<p class="op-empty">No notifications right now.</p>';
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
            coralExact('announcementRead', { id: item.id }).catch((error) => console.debug('[OfficialParity] Announcement read marker failed', error));
        }
        const content = item.operation?.contents || item.contents || (item.type === 'FRIEND_REQUEST' ? 'You received a friend request.' : '');
        $('opAnnouncementDetailBody').innerHTML = `
            ${item.imageUri ? `<img class="op-announcement-hero" src="${escapeHtml(item.imageUri)}" alt="">` : ''}
            <article class="op-copy-page"><h3>${escapeHtml(item.title || 'Nintendo Switch App')}</h3><p class="op-muted">${escapeHtml(formatDate(item.deliversAt || item.distributionDate))}</p><p>${escapeHtml(content)}</p>${item.type === 'FRIEND_REQUEST' ? '<button class="op-primary" id="opAnnouncementOpenRequests">View Friend Requests</button>' : ''}</article>`;
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
        $('notificationBtn')?.setAttribute('aria-label', unread ? 'Notifications — unread notifications' : 'Notifications');
    }

    function installAlbumParity() {
        const title = $('albumPageTitle');
        if (title) title.textContent = 'Uploaded Data';
        const header = title?.closest('.album-toolbar-header');
        if (header && !$('opAlbumAboutBtn')) {
            const btn = document.createElement('button');
            btn.id = 'opAlbumAboutBtn';
            btn.type = 'button';
            btn.className = 'op-header-info-button';
            btn.innerHTML = '<i class="fa-solid fa-circle-info"></i> About';
            btn.addEventListener('click', () => { ensureScreens(); openScreen('opAlbumAboutPage'); });
            header.querySelector('.album-batch-actions')?.prepend(btn);
        }

        replaceControl('mediaInfoBtn', async () => {
            const item = currentMediaItem();
            if (!item) return;
            const meta = $('mediaModalMeta');
            if (!meta) return;
            meta.classList.remove('hidden');
            meta.innerHTML = '<p class="op-loading"><i class="fa-solid fa-spinner fa-spin"></i> Loading details…</p>';
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
                    console.debug('[OfficialParity] Hashtag/List unavailable', error);
                }
            }
            const expiration = expirationLabel(item.expiresAt);
            meta.innerHTML = `
                <div class="op-media-details">
                    ${detailRow('Software name:', item.appName || 'Nintendo Switch')}
                    ${detailRow('Date captured:', formatDate(item.capturedAt))}
                    ${detailRow('Date uploaded:', formatDate(item.uploadedAt))}
                    ${detailRow('Storage time:', expiration)}
                    ${detailRow('Hashtags:', tags || '—', 'opMediaHashtags')}
                </div>
                ${tags ? '<button type="button" class="op-secondary" id="opCopyHashtags">Copy Hashtags</button>' : ''}`;
            $('opCopyHashtags')?.addEventListener('click', async () => {
                try { await navigator.clipboard.writeText(tags); toast('Hashtags copied.'); }
                catch { prompt('Copy hashtags:', tags); }
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
        view.classList.remove('hidden');
        body.innerHTML = '<p class="op-loading"><i class="fa-solid fa-spinner fa-spin"></i> Loading…</p>';
        try {
            const result = await coralExact('chatCandidates');
            const raw = Array.isArray(result) ? result : (result?.chatParticipants || result?.friendCandidates || []);
            if (!raw.length) {
                body.innerHTML = '<p class="chatted-users-empty">Users you\'ve chatted with will be displayed here.</p>';
                return;
            }
            body.innerHTML = raw.map((candidate, index) => `
                <button class="op-candidate-row" data-candidate-index="${index}">
                    <img src="${escapeHtml(candidate.imageUri || candidate.image2Uri || '')}" alt="">
                    <span><b>${escapeHtml(candidate.name || 'Switch Player')}</b><small>You chatted together.</small></span>
                    <i class="fa-solid fa-chevron-right"></i>
                </button>`).join('');
            body.querySelectorAll('[data-candidate-index]').forEach((button) => {
                button.addEventListener('click', () => openChatCandidateDetail(raw[Number(button.dataset.candidateIndex)]));
            });
        } catch (error) {
            body.innerHTML = `<p class="service-status error">Couldn't load users you've chatted with: ${escapeHtml(error.message)}</p>`;
        }
    }

    async function openChatCandidateDetail(candidate) {
        state.activeChatCandidate = candidate;
        const body = $('opChatCandidateBody');
        body.innerHTML = `
            <div class="op-profile-hero"><img src="${escapeHtml(candidate.imageUri || candidate.image2Uri || '')}" alt=""><h3>${escapeHtml(candidate.name || 'Switch Player')}</h3><p>You chatted together.</p></div>
            <div class="op-action-grid">
                <button type="button" class="op-primary" id="opCandidateAdd">Send Friend Request</button>
                <button type="button" class="op-secondary danger" id="opCandidateBlock">Block</button>
            </div>
            <section class="op-group"><h4>Play Activity</h4><div id="opCandidatePlayLog"><p class="op-loading">Loading…</p></div></section>`;
        openScreen('opChatCandidatePage');
        $('opCandidateAdd')?.addEventListener('click', async () => {
            if (!candidate.nsaId) return;
            const button = $('opCandidateAdd'); setBusy(button, true, 'Sending…');
            try {
                await coralExact('friendRequest', { nsaId: candidate.nsaId, channel: 'CAMPUS' });
                button.textContent = 'Friend request sent.'; button.disabled = true; delete button.dataset.oldHtml;
            } catch (error) { alert(`Could not send friend request: ${error.message}`); setBusy(button, false); }
        });
        $('opCandidateBlock')?.addEventListener('click', async () => {
            if (!candidate.nsaId) return;
            const ok = await confirmSheet('Block', "You won't get friend requests sent by blocked users, and you won't encounter those users during online play. (This may not apply to all games or game modes.)", 'Block');
            if (!ok) return;
            try { await coralExact('friendBlock', { nsaId: candidate.nsaId }); toast('Blocked.'); $('opChatCandidatePage').classList.add('hidden'); }
            catch (error) { alert(`Could not block user: ${error.message}`); }
        });
        if (candidate.nsaId) {
            try {
                const result = await coralExact('friendPlayLog', { nsaId: candidate.nsaId });
                renderPlayLog($('opCandidatePlayLog'), result);
            } catch {
                $('opCandidatePlayLog').innerHTML = '<p class="op-empty">Play activity will appear here.</p>';
            }
        }
    }

    function renderPlayLog(host, result) {
        if (!host) return;
        const logs = Array.isArray(result) ? result : (result?.playLogs || []);
        if (!logs.length) { host.innerHTML = '<p class="op-empty">Play activity will appear here.</p>'; return; }
        host.innerHTML = logs.map((log) => `
            <div class="op-playlog-row"><img src="${escapeHtml(log.imageUri || '')}" alt=""><span><b>${escapeHtml(log.name || 'Game')}</b><small>${Number(log.totalPlayTime || 0) > 0 ? `Played for ${Math.max(1, Math.round(Number(log.totalPlayTime) / 60))} hour(s) or more` : 'Recently played'}</small></span></div>`).join('');
    }

    function installFriendOnlinePageReplacement() {
        const oldOpen = $('openNotifySettingBtn');
        if (oldOpen) {
            const btn = replaceControl('openNotifySettingBtn', async () => {
                $('friendSettingsView')?.classList.add('hidden');
                await openFriendOnlineSettings();
            });
            btn?.querySelector('span') && (btn.querySelector('span').textContent = 'Notify When Friends Come Online');
        }
        // Remove the earlier capture-phase redirect by replacing the button node.
        replaceControl('changeNotifySettingBtn', openFriendOnlineSettings);
        const notice = $('friendSettingsNotifyView')?.querySelector('.settings-subtext');
        if (notice) notice.textContent = "You'll get online-status notifications for friends (max of once per 30 mins. for each friend).";
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
                toast('Setting changed.');
            } catch (error) {
                input.checked = !desired;
                alert(`Could not update friend-request setting: ${error.message}`);
            } finally { input.disabled = false; }
        });
        $('openRequestsSettingBtn')?.addEventListener('click', async () => {
            try {
                await loadCurrentUserAndPermissions(true);
                const value = state.permissions?.permissions?.friendRequestReception;
                if (typeof value === 'boolean') input.checked = value;
            } catch {}
        });
    }

    function installFriendDetailParity() {
        if (typeof openFriendDetail === 'function') {
            const previous = openFriendDetail;
            openFriendDetail = function(friend) {
                state.activeFriend = friend || null;
                const result = previous(friend);
                queueMicrotask(() => enhanceFriendDetail(friend));
                if (friend?.nsaId) {
                    coralExact('friendShow', { nsaId: friend.nsaId }).then((full) => {
                        state.activeFriend = { ...friend, ...(full || {}) };
                        enhanceFriendDetail(state.activeFriend);
                    }).catch(() => {});
                }
                return result;
            };
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
            const clone = more.cloneNode(true); clone.id = 'friendsMoreButton'; clone.dataset.opBound = 'true'; clone.disabled = false; more.replaceWith(clone);
            clone.addEventListener('click', openFriendActions);
        }
        updateFriendDetailLabels(friend || state.activeFriend);
    }

    function updateFriendDetailLabels(friend) {
        if (!friend) return;
        const note = $('friendsNoteButton');
        const noteText = String(friend.note || '').trim();
        if (note) note.innerHTML = `<i class="fa-solid fa-pencil"></i> ${escapeHtml(noteText || 'Add Note')}`;
        const fav = $('friendsFavouriteButton');
        if (fav) fav.innerHTML = `<i class="${friend.isFavoriteFriend ? 'fa-solid' : 'fa-regular'} fa-star"></i> Best Friends`;
        const notify = $('friendsNotifyButton');
        if (notify) notify.innerHTML = `<i class="${friend.isOnlineNotificationEnabled ? 'fa-solid' : 'fa-regular'} fa-bell"></i> Notify When This Friend Comes Online`;
    }

    function openFriendNoteEditor() {
        ensureScreens();
        const friend = state.activeFriend;
        if (!friend?.nsaId) return;
        const note = String(friend.note || '');
        $('opFriendNoteBody').innerHTML = `
            <p class="op-info-copy">You can leave notes to yourself about users on your friend list.</p>
            <label class="op-field"><span>Your note</span><textarea id="opFriendNoteInput" maxlength="20" placeholder="Your note">${escapeHtml(note)}</textarea><small><span id="opFriendNoteCount">${note.length}</span>/20</small></label>
            <p class="op-muted">Friends won't be able to see notes you write about them.</p>
            <button type="button" class="op-primary" id="opFriendNoteSave">Save</button>`;
        openScreen('opFriendNotePage');
        const input = $('opFriendNoteInput');
        input?.focus();
        input?.addEventListener('input', () => $('opFriendNoteCount').textContent = input.value.length);
        $('opFriendNoteSave')?.addEventListener('click', async () => {
            const value = input.value;
            if (value.length > 20) return;
            const button = $('opFriendNoteSave'); setBusy(button, true, 'Saving…');
            try {
                await coralExact('friendNote', { friendNsaId: friend.nsaId, note: value });
                friend.note = value; state.activeFriend.note = value; updateFriendDetailLabels(friend);
                $('opFriendNotePage').classList.add('hidden'); $('friendDetailView')?.classList.remove('hidden'); toast('Saved.');
            } catch (error) { alert(`Could not update note: ${error.message}`); }
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
            friend.isFavoriteFriend = desired; updateFriendDetailLabels(friend); toast(desired ? 'Added to Best Friends.' : 'Removed from Best Friends.');
            if (typeof loadLiveFriendsList === 'function') loadLiveFriendsList().catch(() => {});
        } catch (error) { alert(`Could not update Best Friends: ${error.message}`); }
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
            friend.isOnlineNotificationEnabled = desired; updateFriendDetailLabels(friend); toast('Notification setting changed.');
        } catch (error) { alert(`Could not update online notification: ${error.message}`); }
        finally { setBusy(button, false); }
    }

    function openFriendActions() {
        ensureScreens();
        const friend = state.activeFriend;
        if (!friend?.nsaId) return;
        $('opFriendActionsPage').querySelector('h2').textContent = friend.name || 'Friend';
        $('opFriendActionsBody').innerHTML = `
            <div class="op-action-list">
                <button id="opFriendAllowChat"><span><b>Allow for GameChat</b><small>This friend will be allowed for GameChat.</small></span><i class="fa-solid fa-chevron-right"></i></button>
                <button id="opFriendRejectChat"><span><b>Don't Allow for GameChat</b><small>This friend won't be allowed for GameChat.</small></span><i class="fa-solid fa-chevron-right"></i></button>
                <button id="opFriendDelete" class="danger"><span><b>Delete Friend</b></span><i class="fa-solid fa-chevron-right"></i></button>
                <button id="opFriendBlock" class="danger"><span><b>Block</b></span><i class="fa-solid fa-chevron-right"></i></button>
            </div>`;
        openScreen('opFriendActionsPage');
        $('opFriendAllowChat')?.addEventListener('click', () => setFriendChatSelection(true));
        $('opFriendRejectChat')?.addEventListener('click', () => setFriendChatSelection(false));
        $('opFriendDelete')?.addEventListener('click', deleteActiveFriend);
        $('opFriendBlock')?.addEventListener('click', blockActiveFriend);
    }

    async function setFriendChatSelection(isSelected) {
        const friend = state.activeFriend;
        if (!friend?.nsaId) return;
        if (!isSelected) {
            const ok = await confirmSheet("Don't Allow for GameChat", 'If you choose not to allow a user for GameChat, you will no longer be able to use GameChat with them. You can change your selection later. Whether you choose to approve a friend or not, that information will not be shared with them.', "Don't Allow");
            if (!ok) return;
        }
        try {
            // APK serializer: NintendoServiceAccountId + boolean isSelected.
            await coralExact('friendChatSelect', { nsaId: friend.nsaId, isSelected });
            toast(isSelected ? 'This friend will be allowed for GameChat.' : "This friend won't be allowed for GameChat.");
            $('opFriendActionsPage').classList.add('hidden'); $('friendDetailView')?.classList.remove('hidden');
        } catch (error) { alert(`Could not update GameChat setting: ${error.message}`); }
    }

    async function deleteActiveFriend() {
        const friend = state.activeFriend;
        const ok = await confirmSheet('Delete Friend', 'Delete this friend?', 'Delete Friend');
        if (!ok || !friend?.nsaId) return;
        try {
            await coralExact('friendDelete', { nsaId: friend.nsaId });
            toast('Friend deleted.');
            $('opFriendActionsPage').classList.add('hidden'); $('friendDetailView')?.classList.add('hidden');
            if (typeof loadLiveFriendsList === 'function') loadLiveFriendsList().catch(() => {});
        } catch (error) { alert(`Could not delete friend: ${error.message}`); }
    }

    async function blockActiveFriend() {
        const friend = state.activeFriend;
        const ok = await confirmSheet('Block', "You won't get friend requests sent by blocked users, and you won't encounter those users during online play. (This may not apply to all games or game modes.)", 'Block');
        if (!ok || !friend?.nsaId) return;
        try {
            await coralExact('friendBlock', { nsaId: friend.nsaId });
            toast('Blocked.');
            $('opFriendActionsPage').classList.add('hidden'); $('friendDetailView')?.classList.add('hidden');
            if (typeof loadLiveFriendsList === 'function') loadLiveFriendsList().catch(() => {});
        } catch (error) { alert(`Could not block user: ${error.message}`); }
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
            const finish = (value) => { overlay.classList.add('hidden'); resolve(value); };
            $('opDialogCancel').onclick = () => finish(false);
            $('opDialogOk').onclick = () => finish(true);
            overlay.onclick = (event) => { if (event.target === overlay) finish(false); };
        });
    }

    function installChatCandidateReplacement() {
        replaceControl('openVoiceChattedFriendsBtn', openChatCandidates);
        const empty = $('chattedUsersView')?.querySelector('.chatted-users-empty');
        if (empty) empty.textContent = "Users you've chatted with will be displayed here.";
    }

    function installProfileAndNotifications() {
        replaceControl('userAvatarContainer', (event) => {
            event.preventDefault();
            event.stopImmediatePropagation();
            $('profileView')?.classList.add('hidden');
            openUserPage();
        }, { capture: true });
        replaceControl('notificationBtn', (event) => {
            event.preventDefault();
            event.stopImmediatePropagation();
            $('notificationView')?.classList.add('hidden');
            openAnnouncements();
        }, { capture: true });
    }

    function installUserPageBindings() {
        ensureScreens();
        $('opFriendCodeRow')?.addEventListener('click', () => $('openMyCodeQrBtn')?.click());
        $('opOnlineStatusRow')?.addEventListener('click', () => openVisibility('presence'));
        $('opPlayActivityRow')?.addEventListener('click', () => openVisibility('playLog'));
        $('opNintendoAccountRow')?.addEventListener('click', () => window.open('https://accounts.nintendo.com/', '_blank', 'noopener'));
        $('opPushNotificationsRow')?.addEventListener('click', openPushNotifications);
        $('opAppSettingsRow')?.addEventListener('click', openSettings);
        $('opSignOutBtn')?.addEventListener('click', async () => {
            const ok = await confirmSheet('Sign Out', 'Sign out of Nintendo Switch App?', 'Sign Out');
            if (ok && typeof logout === 'function') logout();
        });
    }

    function installAuthenticatedRefreshHook() {
        if (typeof showAuthenticatedUI === 'function' && !showAuthenticatedUI.__opWrapped) {
            const previous = showAuthenticatedUI;
            const wrapped = function(session) {
                const result = previous(session);
                queueMicrotask(() => refreshParityData());
                return result;
            };
            wrapped.__opWrapped = true;
            showAuthenticatedUI = wrapped;
        }
    }

    async function refreshParityData() {
        if (state.refreshing) return state.refreshing;
        state.refreshing = (async () => {
            ensureHomeChatSection();
            installAlbumParity();
            if (coralToken()) {
                refreshHomeChat();
                coralExact('announcements').then((result) => {
                    state.announcements = Array.isArray(result) ? result : (result?.announcements || []);
                    updateAnnouncementDot();
                }).catch(() => {});
            }
        })().finally(() => { state.refreshing = null; });
        return state.refreshing;
    }

    function installReceivedRequestTextParity() {
        const host = $('receivedRequestsContainer');
        if (!host) return;
        const fix = () => {
            host.querySelectorAll('.friends-functional-request-actions').forEach((actions) => {
                const buttons = actions.querySelectorAll('button');
                if (buttons[0]) buttons[0].textContent = 'Become Friends';
                if (buttons[1]) buttons[1].textContent = "Don't Become Friends";
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
        installAuthenticatedRefreshHook();
        installProfileAndNotifications();
        installUserPageBindings();
        installFriendOnlinePageReplacement();
        installExistingRequestSettingExactCall();
        installFriendDetailParity();
        installChatCandidateReplacement();
        installAlbumParity();
        installReceivedRequestTextParity();
        ensureHomeChatSection();
        refreshParityData();
        console.log('[OfficialParity] APK-derived Nintendo Switch App parity layer loaded');
    }

    init();
})();
