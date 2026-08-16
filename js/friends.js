/**
 * Friend list/detail UI plus Coral-backed friend requests, blocks, QR and GameChat controls.
 * Kept in original execution order while separating this responsibility from the app shell.
 */

function friendPresencePlatformLabel(presence) {
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
    return 'Nintendo Switch';
}

function getFriendPresenceInfo(friend) {
    const presence = friend?.presence || {};
    const state = String(presence.state || friend?.state || '').toUpperCase();
    const isOnline = Boolean(friend?.isOnline) || state === 'ONLINE' || state === 'PLAYING';
    const game = presence?.game && typeof presence.game === 'object' ? presence.game : null;
    return {
        presence,
        state,
        isOnline,
        game,
        platformLabel: friendPresencePlatformLabel(presence)
    };
}

function renderFriendDetailPresence(friend) {
    const host = document.getElementById('friendDetailPresence');
    if (!host) return;
    host.replaceChildren();

    const info = getFriendPresenceInfo(friend);
    host.classList.toggle('has-current-game', Boolean(info.isOnline && info.game?.name));

    if (!info.isOnline || !info.game?.name) {
        const status = document.createElement('span');
        status.className = info.isOnline ? 'friend-detail-presence-online-text' : 'friend-detail-presence-offline-text';
        status.textContent = info.isOnline ? (info.platformLabel === 'Nintendo Switch 2' ? trKey('Presence_Online_Device_Ounce') : trKey('Presence_Online_Device_NX')) : trKey('FriendDetails_Label_Presence_Offline');
        host.appendChild(status);
        return;
    }

    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'friend-detail-current-game';
    row.setAttribute('aria-label', `${trKey('A11y_More_Info')}: ${info.game.name}`);

    const image = document.createElement('img');
    image.src = info.game.imageUri || '';
    image.alt = '';
    image.loading = 'eager';
    image.addEventListener('error', () => image.classList.add('friend-detail-current-game-image-missing'));

    const copy = document.createElement('span');
    copy.className = 'friend-detail-current-game-copy';

    const online = document.createElement('span');
    online.className = 'friend-detail-current-game-online';
    online.textContent = info.platformLabel === 'Nintendo Switch 2' ? trKey('Presence_Online_Device_Ounce') : trKey('Presence_Online_Device_NX');

    const title = document.createElement('strong');
    title.textContent = info.game.name;

    copy.append(online, title);
    row.append(image, copy);
    row.addEventListener('click', () => openGameSheet({
        name: info.game.name || 'Game',
        imageUri: info.game.imageUri || '',
        shopUri: info.game.shopUri || ''
    }));
    host.appendChild(row);
}

function renderFriendsList(friends) {
    currentFriends = friends || [];
    renderFriendsInto(document.getElementById('homeFriendsGrid'), currentFriends.slice(0, 8));
    renderFriendsInto(document.getElementById('friendsGrid'), currentFriends);
    const totalCountEl = document.getElementById('totalCount');
    if (totalCountEl) totalCountEl.textContent = currentFriends.length;
}

function renderFriendsInto(container, friends) {
    if (!container) return;
    container.innerHTML = '';
    if (!friends || friends.length === 0) {
        container.innerHTML = `<p style="color:var(--text-secondary);padding:20px 0;">${escapeHtml(trKey('Home_Label_Friend_No_Friends'))}</p>`;
        return;
    }

    friends.forEach(f => {
        const presenceInfo = getFriendPresenceInfo(f);
        const presence = presenceInfo.presence;
        const isOnline = presenceInfo.isOnline;
        const presenceName = presenceInfo.game?.name || presence.name || '';
        const card = document.createElement('button');
        card.type = 'button';
        card.className = 'friend-card';

        let statusText = 'Offline';
        if (isOnline) {
            statusText = presenceName || 'Online';
        } else {
            const rawTs = presence.updatedAt || presence.logoutAt || f.updatedAt || f.logoutAt;
            if (rawTs) {
                const tsSec = typeof rawTs === 'number' ? (rawTs > 1e11 ? Math.floor(rawTs / 1000) : rawTs) : Math.floor(Date.parse(rawTs) / 1000);
                if (!isNaN(tsSec) && tsSec > 0) {
                    const diffSec = Math.floor(Date.now() / 1000) - tsSec;
                    if (diffSec > 0) {
                        if (diffSec < 60) statusText = relativeTime(tsSec * 1000);
                        else if (diffSec < 3600) statusText = trFormat('Friend_Offline_Minutes_Ago', Math.floor(diffSec / 60));
                        else if (diffSec < 86400) statusText = trFormat('Friend_Offline_Hours_Ago', Math.floor(diffSec / 3600));
                        else if (diffSec < 2592000) statusText = trFormat('Friend_Offline_Days_Ago', Math.floor(diffSec / 86400));
                        else if (diffSec < 31536000) statusText = relativeTime(tsSec * 1000);
                    }
                }
            }
            if (statusText === 'Offline' && f.statusText) {
                statusText = f.statusText;
            }
        }

        card.innerHTML = `
            <div class="friend-avatar-wrap">
                <img src="${f.imageUri || f.image_url || 'https://cdn-icons-png.flaticon.com/512/808/808439.png'}" alt="${f.name}">
            </div>
            <div class="friend-info">
                <div class="friend-name">${f.name}</div>
                ${isOnline ? `<div class="friend-online-platform">${escapeHtml(presenceInfo.platformLabel === 'Nintendo Switch 2' ? trKey('Presence_Online_Device_Ounce') : trKey('Presence_Online_Device_NX'))}</div>` : ''}
                <div class="friend-game ${isOnline && presenceName ? 'friend-game-playing' : ''}">${isOnline && presenceName ? presenceName : statusText}</div>
            </div>
        `;
        card.addEventListener('click', () => openFriendDetail(f));
        container.appendChild(card);
    });
}

function formatBecameFriendsRoute(route) {
    if (!route) return trKey('Friend_Route_FriendCode');
    const channel = typeof route === 'string' ? route : (route.channel || '');
    switch (channel) {
        case 'NX_FACED':
            return trKey('Friend_Route_Nearby');
        case 'IN_APP':
            return route.userName ? `${trKey('Friend_Route_InGame_Name')} ${route.userName}` : tr('By playing together in a game.');
        case '3DS':
            return trKey('Friend_Route_3DS');
        case 'NNID':
            return trKey('Friend_Route_WiiU');
        case 'CAMPUS':
            return trKey('Friend_Route_Chat');
        case 'NINTENDO_ACCOUNT':
            return route.appName || 'Nintendo Account';
        case 'FRIEND_CODE':
        default:
            return trKey('Friend_Route_FriendCode');
    }
}

function formatBecameFriendsDate(timestamp) {
    if (!timestamp) return '—';
    let ms = Number(timestamp);
    if (isNaN(ms) || ms <= 0) return '—';
    if (ms < 1e11) ms *= 1000;
    const d = new Date(ms);
    try {
        return new Intl.DateTimeFormat(typeof window.nsoCurrentLocale === 'function' ? window.nsoCurrentLocale() : undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(d);
    } catch {
        return d.toLocaleString(typeof window.nsoCurrentLocale === 'function' ? window.nsoCurrentLocale() : undefined);
    }
}

async function openFriendDetail(friend) {
    activeFriendDetailData = friend;
    navTabStacks.friends = 'detail';
    const activePageEl = document.querySelector('.tab-page.active');
    friendDetailOriginTab = activePageEl?.id === 'page-home' ? 'home' : 'friends';

    const presenceInfo = getFriendPresenceInfo(friend);
    const isOnline = presenceInfo.isOnline;
    const presence = presenceInfo.game?.name || friend.presence?.name || '';
    document.getElementById('friendDetailAvatar').src = friend.imageUri || friend.image_url || '';
    document.getElementById('friendDetailAvatar').alt = friend.name || 'Friend';
    document.getElementById('friendDetailName').textContent = friend.name || 'Friend';
    renderFriendDetailPresence(friend);

    // Populate How / When you became friends metadata
    const howBecameEl = document.getElementById('friendDetailHowBecame');
    if (howBecameEl) {
        howBecameEl.textContent = formatBecameFriendsRoute(friend.route || friend.howBecameFriend);
    }
    const whenBecameEl = document.getElementById('friendDetailWhenBecame');
    if (whenBecameEl) {
        whenBecameEl.textContent = formatBecameFriendsDate(friend.friendCreatedAt || friend.becameFriendAt || friend.createdAt);
    }

    const activity = document.getElementById('friendDetailActivity');
    activity.innerHTML = `<div style="color:#aaaab0;font-size:13px;padding:12px 0">${escapeHtml(trKey('GameWebView_Initial_Loading_Label'))}</div>`;
    slideViewIn(document.getElementById('friendDetailView'));

    try {
        if (!friend.nsaId) {
            if (presence) {
                activity.innerHTML = `
                    <div class="friend-activity-list">
                        <div class="friend-activity-row">
                            <img src="${friend.presence?.imageUri || friend.presence?.game?.imageUri || friend.imageUri || friend.image_url || ''}" alt="">
                            <div>
                                <strong>${presence}</strong>
                                <span class="${isOnline ? 'playtime-highlight' : 'playtime-normal'}">${escapeHtml(isOnline ? tr('Playing now') : tr('Recently played'))}</span>
                            </div>
                        </div>
                    </div>
                `;
            } else {
                activity.textContent = trKey('Common_PlayActivity_Empty');
            }
            return;
        }

        const result = await coralCall('/v4/User/PlayLog/Show', { nsaId: friend.nsaId });
        const playLogs = Array.isArray(result) ? result : (result?.playLogs || []);
        if (playLogs.length > 0) {
            activity.innerHTML = '<div class="friend-activity-list"></div>';
            const list = activity.firstElementChild;
            playLogs.forEach(log => {
                const hours = Math.round((log.totalPlayTime || 0) / 60);
                const isOver50 = hours >= 50;
                let playText = trKey('FriendDetails_Label_Play_Log_Little');
                if (hours > 0) {
                    playText = trFormat('FriendDetails_Label_Play_Log_Time', hours);
                }

                const row = document.createElement('div');
                row.className = 'friend-activity-row clickable';
                row.innerHTML = `
                    <img src="${log.imageUri || ''}" alt="" onerror="this.style.display='none'">
                    <div>
                        <strong>${log.name || 'Game'}</strong>
                        <span class="${isOver50 ? 'playtime-highlight' : 'playtime-normal'}">${playText}</span>
                    </div>
                `;
                row.addEventListener('click', () => openGameSheet({
                    name: log.name || 'Game',
                    imageUri: log.imageUri || '',
                    shopUri: log.shopUri || ''
                }));
                list.appendChild(row);
            });
        } else if (presence) {
            activity.innerHTML = `
                <div class="friend-activity-list">
                    <div class="friend-activity-row">
                        <img src="${friend.presence?.imageUri || friend.presence?.game?.imageUri || friend.imageUri || friend.image_url || ''}" alt="">
                        <div>
                            <strong>${presence}</strong>
                            <span class="${isOnline ? 'playtime-highlight' : 'playtime-normal'}">${escapeHtml(isOnline ? tr('Playing now') : tr('Recently played'))}</span>
                        </div>
                    </div>
                </div>
            `;
        } else {
            activity.textContent = trKey('Common_PlayActivity_Empty');
        }
    } catch (e) {
        if (presence) {
            activity.innerHTML = `
                <div class="friend-activity-list">
                    <div class="friend-activity-row">
                        <img src="${friend.presence?.imageUri || friend.presence?.game?.imageUri || friend.imageUri || friend.image_url || ''}" alt="">
                        <div>
                            <strong>${presence}</strong>
                            <span class="${isOnline ? 'playtime-highlight' : 'playtime-normal'}">${escapeHtml(isOnline ? tr('Playing now') : tr('Recently played'))}</span>
                        </div>
                    </div>
                </div>
            `;
        } else {
            activity.textContent = tr('Play activity is set to private or not available.');
        }
    }
}

// Game detail bottom sheet
function openGameSheet(game) {
    const overlay = document.getElementById('gameSheetOverlay');
    const sheet = document.getElementById('gameSheet');
    const img = document.getElementById('gameSheetImg');
    const name = document.getElementById('gameSheetName');
    const link = document.getElementById('gameSheetLink');

    img.src = game.imageUri || '';
    img.alt = game.name || 'Game';
    name.textContent = game.name || 'Game';

    if (game.shopUri) {
        link.href = game.shopUri;
        link.style.display = '';
    } else {
        link.style.display = 'none';
    }

    sheet.classList.remove('sheet-closing');
    overlay.classList.remove('hidden');
}

function closeGameSheet() {
    const overlay = document.getElementById('gameSheetOverlay');
    const sheet = document.getElementById('gameSheet');
    sheet.classList.add('sheet-closing');
    sheet.addEventListener('animationend', () => {
        overlay.classList.add('hidden');
        sheet.classList.remove('sheet-closing');
    }, { once: true });
}

document.getElementById('gameSheetOverlay')?.addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closeGameSheet();
});

document.getElementById('closeMediaModalBtn').addEventListener('click', () => {
    document.getElementById('mediaModal').classList.add('hidden');
    document.getElementById('mediaModalContent').innerHTML = '';
    document.getElementById('mediaModalMeta').classList.add('hidden');
    activeMediaItem = null;
});

document.getElementById('mediaInfoBtn').addEventListener('click', showActiveMediaInfo);
document.getElementById('mediaShareBtn').addEventListener('click', shareActiveMedia);
document.getElementById('mediaDownloadBtn').addEventListener('click', downloadActiveMedia);

document.getElementById('closeFriendDetailBtn')?.addEventListener('click', () => {
    navTabStacks.friends = 'list';
    activeFriendDetailData = null;
    const originTab = friendDetailOriginTab || 'friends';
    slideViewOut(document.getElementById('friendDetailView'), () => {
        applyTabViewState(originTab);
    });
});

document.getElementById('closeNotificationBtn')?.addEventListener('click', () => {
    navTabStacks.home = 'home';
    slideViewOut(document.getElementById('notificationView'));
});

document.getElementById('closeProfileBtn')?.addEventListener('click', () => {
    navTabStacks.home = 'home';
    slideViewOut(document.getElementById('profileView'));
});

// Friend Settings Screen Navigation (Screenshots 2, 3, 4, 5)
document.getElementById('openFriendSettingsBtn')?.addEventListener('click', () => {
    slideViewIn(document.getElementById('friendSettingsView'));
});

document.getElementById('closeFriendSettingsBtn')?.addEventListener('click', () => {
    slideViewOut(document.getElementById('friendSettingsView'));
});

document.getElementById('openNotifySettingBtn')?.addEventListener('click', () => {
    slideViewIn(document.getElementById('friendSettingsNotifyView'));
});

document.getElementById('closeNotifySettingBtn')?.addEventListener('click', () => {
    slideViewOut(document.getElementById('friendSettingsNotifyView'));
});

document.getElementById('openRequestsSettingBtn')?.addEventListener('click', () => {
    slideViewIn(document.getElementById('friendSettingsRequestsView'));
});

document.getElementById('closeRequestsSettingBtn')?.addEventListener('click', () => {
    slideViewOut(document.getElementById('friendSettingsRequestsView'));
});

document.getElementById('openBlockedSettingBtn')?.addEventListener('click', () => {
    slideViewIn(document.getElementById('friendSettingsBlockedView'));
});

document.getElementById('closeBlockedSettingBtn')?.addEventListener('click', () => {
    slideViewOut(document.getElementById('friendSettingsBlockedView'));
});

document.getElementById('changeNotifySettingBtn')?.addEventListener('click', () => {
    const label = document.getElementById('notifyStatusLabel');
    if (label) {
        const isDis = label.textContent.includes('disabled');
        label.textContent = isDis ? tr('Notifications enabled') : trKey('Notification_Settings_Disabled');
    }
});

// In-App Game Web Service Controls
document.getElementById('closeInAppGameWebviewBtn')?.addEventListener('click', () => {
    document.documentElement.classList.remove('webview-active');
    document.body.classList.remove('webview-active');
    const overlay = document.getElementById('inAppGameWebview');
    const iframe = document.getElementById('inAppGameWebviewFrame');
    if (overlay) overlay.classList.add('hidden');
    if (iframe) iframe.src = 'about:blank';
});

document.getElementById('reloadInAppGameWebviewBtn')?.addEventListener('click', () => {
    const iframe = document.getElementById('inAppGameWebviewFrame');
    if (iframe) {
        try {
            iframe.contentWindow?.location.reload();
        } catch (e) {
            iframe.src = iframe.src;
        }
    }
});

// Add Friend Menu (Screenshot 1 & 5)
document.getElementById('openAddFriendBtn')?.addEventListener('click', () => {
    slideViewIn(document.getElementById('addFriendView'));
});

document.getElementById('closeAddFriendBtn')?.addEventListener('click', () => {
    slideViewOut(document.getElementById('addFriendView'));
});

document.getElementById('openSearchByFriendCodeBtn')?.addEventListener('click', () => {
    slideViewIn(document.getElementById('searchByFriendCodeView'));
    const input = document.getElementById('friendCodeInput');
    if (input) {
        input.focus();
    }
});

document.getElementById('closeSearchByFriendCodeBtn')?.addEventListener('click', () => {
    slideViewOut(document.getElementById('searchByFriendCodeView'));
    document.getElementById('fcResultSheet')?.classList.add('hidden');
});

// Format Friend Code Input as XXXX XXXX XXXX
let activeSearchedFriend = null;
const friendCodeInput = document.getElementById('friendCodeInput');
const searchFriendCodeBtn = document.getElementById('searchFriendCodeBtn');
const fcInputBox = document.getElementById('fcInputBox');

friendCodeInput?.addEventListener('input', (e) => {
    let val = e.target.value.replace(/[^0-9]/g, '');
    if (val.length > 12) val = val.slice(0, 12);

    // Group in 4s
    const parts = [];
    for (let i = 0; i < val.length; i += 4) {
        parts.push(val.slice(i, i + 4));
    }
    e.target.value = parts.join(' ');

    if (val.length === 12) {
        searchFriendCodeBtn.disabled = false;
        searchFriendCodeBtn.classList.remove('disabled');
        fcInputBox?.classList.add('active-focused');
    } else {
        searchFriendCodeBtn.disabled = true;
        searchFriendCodeBtn.classList.add('disabled');
        fcInputBox?.classList.remove('active-focused');
        document.getElementById('fcResultSheet')?.classList.add('hidden');
    }
});

searchFriendCodeBtn?.addEventListener('click', async () => {
    const raw = friendCodeInput.value.replace(/[^0-9]/g, '');
    if (raw.length !== 12) return;

    searchFriendCodeBtn.disabled = true;
    searchFriendCodeBtn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> ${escapeHtml(tr('Searching…'))}`;

    try {
        const formattedCode = `${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 12)}`;
        const result = await coralCall('/v3/Friend/GetUserByFriendCode', { friendCode: formattedCode });
        activeSearchedFriend = {
            name: result?.name || 'Switch Player',
            friendCode: `SW-${formattedCode}`,
            imageUri: result?.imageUri || 'https://cdn-icons-png.flaticon.com/512/808/808439.png',
            rawCode: raw,
            nsaId: result?.nsaId
        };

        document.getElementById('fcResultAvatar').src = activeSearchedFriend.imageUri;
        document.getElementById('fcResultName').textContent = activeSearchedFriend.name;
        document.getElementById('fcResultCode').textContent = activeSearchedFriend.friendCode;
        document.getElementById('fcResultSheet').classList.remove('hidden');
    } catch (e) {
        console.error('[FriendSearch] failed', e); alert(trKey('Error_Dialog_Message_CommunicationFailed'));
    } finally {
        searchFriendCodeBtn.disabled = false;
        searchFriendCodeBtn.textContent = trKey('FriendRequest_Button_Find');
    }
});

// Send Friend Request (Screenshot 4 -> 5)
const sentFriendRequests = [];
document.getElementById('sendFriendRequestBtn')?.addEventListener('click', async () => {
    if (!activeSearchedFriend) return;
    const sendBtn = document.getElementById('sendFriendRequestBtn');
    sendBtn.disabled = true;
    sendBtn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> ${escapeHtml(tr('Sending Request…'))}`;

    try {
        const now = new Date();
        const dateStr = `${String(now.getDate()).padStart(2, '0')}/${String(now.getMonth() + 1).padStart(2, '0')}/${now.getFullYear()} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

        if (coralAccessToken() && activeSearchedFriend.nsaId) {
            try {
                await coralCall('/v3/FriendRequest/Create', { nsaId: activeSearchedFriend.nsaId });
            } catch (err) {
                console.warn('Coral FriendRequest/Create note:', err);
            }
        }

        sentFriendRequests.unshift({
            name: activeSearchedFriend.name,
            friendCode: activeSearchedFriend.friendCode,
            imageUri: activeSearchedFriend.imageUri,
            dateStr: dateStr,
            nsaId: activeSearchedFriend.nsaId,
            source: 'By exchanging friend codes.'
        });

        renderSentFriendRequests();

        // Close search and return to Add Friend screen
        document.getElementById('fcResultSheet').classList.add('hidden');
        document.getElementById('searchByFriendCodeView').classList.add('hidden');
        document.getElementById('addFriendView').classList.remove('hidden');
        friendCodeInput.value = '';
        searchFriendCodeBtn.disabled = true;
        searchFriendCodeBtn.classList.add('disabled');
        fcInputBox?.classList.remove('active-focused');
    } catch (e) {
        console.error('[FriendRequest] send failed', e); alert(trKey('Error_Dialog_Message_CommunicationFailed'));
    } finally {
        sendBtn.disabled = false;
        sendBtn.textContent = trKey('FriendRequest_Send');
    }
});

function renderSentFriendRequests() {
    const emptyText = document.getElementById('sentRequestsEmptyText');
    const list = document.getElementById('sentRequestsList');
    if (!list) return;

    if (sentFriendRequests.length === 0) {
        if (emptyText) emptyText.classList.remove('hidden');
        list.classList.add('hidden');
        list.innerHTML = '';
        return;
    }

    if (emptyText) emptyText.classList.add('hidden');
    list.classList.remove('hidden');
    list.innerHTML = '';

    sentFriendRequests.forEach(req => {
        const item = document.createElement('button');
        item.type = 'button';
        item.className = 'sent-request-card';
        item.innerHTML = `
            <img src="${req.imageUri}" alt="${req.name}" class="sent-request-avatar">
            <div class="sent-request-info">
                <strong>${req.name}</strong>
                <span>${req.dateStr}</span>
            </div>
        `;
        item.addEventListener('click', () => openSentRequestDetail(req));
        list.appendChild(item);
    });
}

let activeSentRequest = null;

async function openSentRequestDetail(req) {
    activeSentRequest = req;
    document.getElementById('sentReqDropdown')?.classList.add('hidden');
    document.getElementById('sentReqDetailAvatar').src = req.imageUri || 'https://cdn-icons-png.flaticon.com/512/808/808439.png';
    document.getElementById('sentReqDetailName').textContent = req.name || 'Friend';
    document.getElementById('sentReqDetailSource').textContent = req.source || 'By exchanging friend codes.';
    document.getElementById('sentReqDetailDate').textContent = req.dateStr || new Date().toLocaleString(typeof window.nsoCurrentLocale === 'function' ? window.nsoCurrentLocale() : undefined);

    const activityList = document.getElementById('sentReqDetailActivityList');
    if (!activityList) return;
    activityList.innerHTML = `<div style="padding:16px;color:#88888c;font-size:13px">${escapeHtml(trKey('GameWebView_Initial_Loading_Label'))}</div>`;
    slideViewIn(document.getElementById('sentReqDetailView'));

    try {
        let playLogs = [];
        if (req.nsaId && coralAccessToken()) {
            const result = await coralCall('/v4/User/PlayLog/Show', { nsaId: req.nsaId });
            playLogs = Array.isArray(result) ? result : (result?.playLogs || []);
        } else if (req.playLogs) {
            playLogs = req.playLogs;
        }

        if (playLogs.length > 0) {
            activityList.innerHTML = '';
            playLogs.forEach(log => {
                const hours = Math.round((log.totalPlayTime || 0) / 60);
                const item = document.createElement('div');
                item.className = 'req-activity-item';
                item.innerHTML = `
                    <img src="${log.imageUri || ''}" alt="" onerror="this.style.display='none'">
                    <div class="req-activity-item-info">
                        <strong>${log.name || 'Game'}</strong>
                        <span class="${hours > 0 ? '' : 'muted'}">${hours > 0 ? trFormat('FriendDetails_Label_Play_Log_Time', hours) : trKey('FriendDetails_Label_Play_Log_Little')}</span>
                    </div>
                `;
                activityList.appendChild(item);
            });
        } else {
            activityList.innerHTML = `<div style="padding:16px;color:#88888c;font-size:13px">${escapeHtml(trKey('Common_PlayActivity_Empty'))}</div>`;
        }
    } catch (e) {
        activityList.innerHTML = `<div style="padding:16px;color:#88888c;font-size:13px">${escapeHtml(trKey('Common_PlayActivity_Empty'))}</div>`;
    }
}

document.getElementById('closeSentReqDetailBtn')?.addEventListener('click', () => {
    slideViewOut(document.getElementById('sentReqDetailView'));
    document.getElementById('sentReqDropdown')?.classList.add('hidden');
    activeSentRequest = null;
});

// Toggle 3-dots more menu on Sent Request Detail
document.getElementById('sentReqMoreBtn')?.addEventListener('click', (e) => {
    e.stopPropagation();
    document.getElementById('sentReqDropdown')?.classList.toggle('hidden');
});

// Close dropdown on outside click
document.addEventListener('click', (e) => {
    if (!e.target.closest('.req-detail-menu-wrap')) {
        document.getElementById('sentReqDropdown')?.classList.add('hidden');
    }
});

// Delete Sent Friend Request
document.getElementById('deleteSentReqBtn')?.addEventListener('click', async () => {
    if (!activeSentRequest) return;

    if (coralAccessToken() && activeSentRequest.requestId) {
        try {
            await coralCall('/v3/FriendRequest/Delete', { requestId: activeSentRequest.requestId });
        } catch (err) {
            console.warn('Coral FriendRequest delete note:', err);
        }
    }

    const idx = sentFriendRequests.indexOf(activeSentRequest);
    if (idx !== -1) {
        sentFriendRequests.splice(idx, 1);
    }

    renderSentFriendRequests();
    document.getElementById('sentReqDropdown')?.classList.add('hidden');
    document.getElementById('sentReqDetailView')?.classList.add('hidden');
    activeSentRequest = null;
});





// ---------------------------------------------------------------------------
// Friends features
// ---------------------------------------------------------------------------
/**
 * Friends requests, privacy, blocked-user, QR and GameChat controls wired directly to Coral.
 */
(() => {
    'use strict';

    const state = {
        receivedRequests: [],
        sentRequests: [],
        blockedUsers: [],
        permissions: null,
        qrLibraryPromise: null,
        friendCodeQrResult: null,
        friendCodeQrPromise: null,
        friendCodeQrFetchedAt: 0,
        chatCandidates: []
    };

    const $ = (id) => document.getElementById(id);

    function coral(path, parameter = {}, options = {}) {
        if (typeof coralCall !== 'function') {
            throw new Error('Coral is not ready. Sign in again and reload the page.');
        }
        return coralCall(path, parameter, options);
    }

    // escapeHtml is now provided by the top-level bridge

    function toMillis(value) {
        if (!value) return 0;
        if (typeof value === 'number') return value < 10_000_000_000 ? value * 1000 : value;
        const parsed = Date.parse(value);
        return Number.isFinite(parsed) ? parsed : 0;
    }

    function formatDate(value) {
        const ms = toMillis(value);
        if (!ms) return '';
        try {
            return new Intl.DateTimeFormat(typeof window.nsoCurrentLocale === 'function' ? window.nsoCurrentLocale() : undefined, {
                dateStyle: 'medium',
                timeStyle: 'short'
            }).format(new Date(ms));
        } catch {
            return new Date(ms).toLocaleString(typeof window.nsoCurrentLocale === 'function' ? window.nsoCurrentLocale() : undefined);
        }
    }

    function requestId() {
        if (globalThis.crypto?.randomUUID) return crypto.randomUUID();
        return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    }

    function showToast(message) {
        let toast = $('friendsFunctionalToast');
        if (!toast) {
            toast = document.createElement('div');
            toast.id = 'friendsFunctionalToast';
            toast.className = 'friends-functional-toast';
            document.body.appendChild(toast);
        }
        toast.textContent = message;
        toast.classList.add('show');
        clearTimeout(showToast.timer);
        showToast.timer = setTimeout(() => toast.classList.remove('show'), 2200);
    }

    async function runButton(button, work, successMessage = '') {
        if (!button || button.dataset.busy === 'true') return undefined;
        const oldDisabled = button.disabled;
        button.dataset.busy = 'true';
        button.disabled = true;
        try {
            const result = await work();
            if (successMessage) showToast(successMessage);
            return result;
        } finally {
            delete button.dataset.busy;
            button.disabled = oldDisabled;
        }
    }

    function refreshFriends() {
        if (typeof loadLiveFriendsList === 'function') {
            Promise.resolve(loadLiveFriendsList()).catch((error) => {
                console.warn('[Friends] Could not refresh friends', error);
            });
        }
    }

    function getCurrentFriends() {
        try {
            return Array.isArray(currentFriends) ? currentFriends : [];
        } catch {
            return [];
        }
    }

    function getLegacySentRequests() {
        try {
            return Array.isArray(sentFriendRequests) ? sentFriendRequests : null;
        } catch {
            return null;
        }
    }

    function getActiveSearchedFriend() {
        try {
            return typeof activeSearchedFriend !== 'undefined' ? activeSearchedFriend : null;
        } catch {
            return null;
        }
    }

    function clearActiveSearchedFriend() {
        try {
            activeSearchedFriend = null;
        } catch { }
    }

    function getActiveSentRequest() {
        try {
            return typeof activeSentRequest !== 'undefined' ? activeSentRequest : null;
        } catch {
            return null;
        }
    }

    async function loadPermissions() {
        const toggle = $('receiveRequestsToggle');
        if (toggle) toggle.disabled = true;
        try {
            state.permissions = await coral('/v3/User/Permissions/ShowSelf', {}, {
                body: { requestId: requestId() }
            });
            const value = state.permissions?.permissions?.friendRequestReception;
            if (toggle && typeof value === 'boolean') toggle.checked = value;
        } catch (error) {
            console.warn('[Friends] Could not load friend permissions', error);
        } finally {
            if (toggle) toggle.disabled = false;
        }
    }

    function installReceiveRequestsSetting() {
        const toggle = $('receiveRequestsToggle');
        if (!toggle) return;

        toggle.addEventListener('change', async () => {
            const desired = toggle.checked;
            toggle.disabled = true;
            try {
                await coral('/v4/User/Permissions/UpdateSelf', {
                    permissions: { friendRequestReception: desired }
                });
                if (state.permissions?.permissions) {
                    state.permissions.permissions.friendRequestReception = desired;
                }
                showToast(tr('Setting changed.'));
            } catch (error) {
                toggle.checked = !desired;
                console.error('[UI action] request failed', error); alert(trKey('Error_Dialog_Message_CommunicationFailed'));
            } finally {
                toggle.disabled = false;
            }
        });
    }

    function updateNotifySettingsSummary() {
        const label = $('notifyStatusLabel');
        const button = $('changeNotifySettingBtn');
        if (!label || !button) return;
        const enabledCount = getCurrentFriends().filter((friend) => friend?.isOnlineNotificationEnabled).length;
        label.textContent = enabledCount === 0 ? tr('No friends are currently selected.') : `${enabledCount} · ${trKey('Friend_Notify_Online')}`;
        button.textContent = tr('Choose a Friend');
    }

    function installNotifySettingsNavigation() {
        const button = $('changeNotifySettingBtn');
        if (!button) return;

        button.addEventListener('click', (event) => {
            // Stop the legacy demo handler that only toggles label text locally.
            event.preventDefault();
            event.stopImmediatePropagation();
            $('friendSettingsNotifyView')?.classList.add('hidden');
            $('friendSettingsView')?.classList.add('hidden');
            if (typeof showAppPage === 'function') showAppPage('friends');
            showToast(tr('Open a friend and choose “Notify When Online”.'));
        }, true);
    }

    async function loadBlockedUsers() {
        const list = $('blockedUsersNativeList');
        const empty = $('blockedUsersEmptyText');
        if (!list) return;

        list.classList.remove('hidden');
        list.innerHTML = `<p><i class="fa-solid fa-spinner fa-spin"></i> ${escapeHtml(trKey('GameWebView_Initial_Loading_Label'))}</p>`;
        empty?.classList.add('hidden');

        try {
            const result = await coral('/v3/User/Block/List');
            state.blockedUsers = Array.isArray(result)
                ? result
                : (result?.blockingUsers || result?.blockedUsers || []);

            list.innerHTML = '';
            if (!state.blockedUsers.length) {
                list.classList.add('hidden');
                empty?.classList.remove('hidden');
                return;
            }

            for (const user of state.blockedUsers) {
                const row = document.createElement('article');
                row.className = 'friends-functional-user-row';
                row.innerHTML = `
                    <img src="${escapeHtml(user.imageUri || user.image2Uri || '')}" alt="">
                    <div>
                        <strong>${escapeHtml(user.name || 'Switch Player')}</strong>
                        <span>${user.blockedAt ? `${escapeHtml(trKey('BlockList_Date_Blocked'))} ${escapeHtml(formatDate(user.blockedAt))}` : escapeHtml(trKey('Common_Blocked_User'))}</span>
                    </div>`;

                const button = document.createElement('button');
                button.type = 'button';
                button.textContent = trKey('BlockList_Unblock');
                button.addEventListener('click', async () => {
                    if (!user.nsaId) return;
                    try {
                        await runButton(
                            button,
                            () => coral('/v3/User/Block/Delete', { nsaId: user.nsaId }),
                            trKey('BlockList_Unblocked')
                        );
                        await loadBlockedUsers();
                    } catch (error) {
                        console.error('[UI action] request failed', error); alert(trKey('Error_Dialog_Message_CommunicationFailed'));
                    }
                });
                row.appendChild(button);
                list.appendChild(row);
            }
        } catch (error) {
            console.error('[BlockedUsers] load failed', error); list.innerHTML = `<p class="service-status error">${escapeHtml(trKey('Common_Loading_Failed'))}</p>`;
        }
    }

    function requestPerson(request, direction) {
        return direction === 'received'
            ? (request?.sender || request?.user || {})
            : (request?.receiver || request?.user || {});
    }

    function requestRouteText(request) {
        const route = request?.route || {};
        if (route.channel === 'FRIEND_CODE') return trKey('Friend_Route_FriendCode');
        if (route.channel === 'CAMPUS') return trKey('Friend_Route_Chat');
        if (route.appName) return route.appName;
        return 'Nintendo Switch';
    }

    function renderReceivedRequests() {
        const container = $('receivedRequestsContainer');
        if (!container) return;
        container.innerHTML = '';

        if (!state.receivedRequests.length) {
            container.innerHTML = `<p>${escapeHtml(trKey('FriendRequest_Received_Empty'))}</p>`;
            return;
        }

        for (const request of state.receivedRequests) {
            const sender = requestPerson(request, 'received');
            const row = document.createElement('article');
            row.className = `friends-functional-request-row${request.hasRead === false ? ' unread' : ''}`;
            row.innerHTML = `
                <img src="${escapeHtml(sender.imageUri || sender.image2Uri || '')}" alt="">
                <div>
                    <strong>${escapeHtml(sender.name || 'Switch Player')}</strong>
                    <span>${escapeHtml(requestRouteText(request))}</span>
                    <small>${escapeHtml(formatDate(request.createdAt))}</small>
                </div>`;

            const actions = document.createElement('div');
            actions.className = 'friends-functional-request-actions';

            const accept = document.createElement('button');
            accept.type = 'button';
            accept.className = 'primary';
            accept.textContent = trKey('FriendRequest_Received_Confirm');
            accept.addEventListener('click', async (event) => {
                event.stopPropagation();
                try {
                    await runButton(
                        accept,
                        () => coral('/v3/FriendRequest/Accept', { id: request.id }),
                        trKey('FriendRequest_Received_Confirmed')
                    );
                    await loadFriendRequestLists();
                    refreshFriends();
                } catch (error) {
                    console.error('[UI action] request failed', error); alert(trKey('Error_Dialog_Message_CommunicationFailed'));
                }
            });

            const reject = document.createElement('button');
            reject.type = 'button';
            reject.textContent = trKey('FriendRequest_Received_Decline');
            reject.addEventListener('click', async (event) => {
                event.stopPropagation();
                if (!confirm(trVars('Don’t become friends with {name}?', { name: sender.name || tr('Friend') }))) return;
                try {
                    await runButton(
                        reject,
                        () => coral('/v3/FriendRequest/Reject', { id: request.id }),
                        tr('Friend request rejected.')
                    );
                    await loadFriendRequestLists();
                } catch (error) {
                    console.error('[UI action] request failed', error); alert(trKey('Error_Dialog_Message_CommunicationFailed'));
                }
            });

            actions.append(accept, reject);
            row.appendChild(actions);

            row.addEventListener('click', () => {
                if (request.hasRead === false && request.id) {
                    request.hasRead = true;
                    row.classList.remove('unread');
                    coral('/v4/FriendRequest/Received/MarkAsRead', { id: request.id }).catch(() => { });
                }
            });

            container.appendChild(row);
        }
    }

    function syncLegacySentRequests() {
        const legacy = getLegacySentRequests();
        if (!legacy || typeof renderSentFriendRequests !== 'function') return false;

        legacy.splice(0, legacy.length, ...state.sentRequests.map((request) => {
            const receiver = requestPerson(request, 'sent');
            return {
                name: receiver.name || 'Switch Player',
                imageUri: receiver.imageUri || receiver.image2Uri || '',
                nsaId: receiver.nsaId,
                requestId: request.id,
                dateStr: formatDate(request.createdAt),
                source: requestRouteText(request)
            };
        }));
        renderSentFriendRequests();
        return true;
    }

    async function loadFriendRequestLists() {
        const receivedContainer = $('receivedRequestsContainer');
        if (receivedContainer) {
            receivedContainer.innerHTML = `<p><i class="fa-solid fa-spinner fa-spin"></i> ${escapeHtml(trKey('GameWebView_Initial_Loading_Label'))}</p>`;
        }

        const sentList = $('sentRequestsList');
        const sentEmpty = $('sentRequestsEmptyText');
        if (sentList) {
            sentList.classList.remove('hidden');
            sentList.innerHTML = `<p><i class="fa-solid fa-spinner fa-spin"></i> ${escapeHtml(trKey('GameWebView_Initial_Loading_Label'))}</p>`;
        }
        sentEmpty?.classList.add('hidden');

        const [receivedResult, sentResult] = await Promise.allSettled([
            coral('/v4/FriendRequest/Received/List'),
            coral('/v3/FriendRequest/Sent/List')
        ]);

        if (receivedResult.status === 'fulfilled') {
            state.receivedRequests = Array.isArray(receivedResult.value)
                ? receivedResult.value
                : (receivedResult.value?.friendRequests || []);
            renderReceivedRequests();
        } else if (receivedContainer) {
            console.error('[FriendRequests] received load failed', receivedResult.reason); receivedContainer.innerHTML = `<p class="service-status error">${escapeHtml(trKey('Common_Loading_Failed'))}</p>`;
        }

        if (sentResult.status === 'fulfilled') {
            state.sentRequests = Array.isArray(sentResult.value)
                ? sentResult.value
                : (sentResult.value?.friendRequests || []);
            if (!syncLegacySentRequests() && sentList) {
                sentList.innerHTML = state.sentRequests.length
                    ? `<p>${escapeHtml(trKey('Common_Loading_Failed'))}</p>`
                    : '';
            }
        } else if (sentList) {
            sentList.classList.remove('hidden');
            console.error('[FriendRequests] sent load failed', sentResult.reason); sentList.innerHTML = `<p class="service-status error">${escapeHtml(trKey('Common_Loading_Failed'))}</p>`;
        }
    }

    function installCorrectSendFriendRequest() {
        const button = $('sendFriendRequestBtn');
        if (!button) return;

        button.addEventListener('click', async (event) => {
            // The legacy app flow has a /v3/FriendRequest/Create handler. Capture
            // phase prevents that handler from also running.
            event.preventDefault();
            event.stopImmediatePropagation();

            const friend = getActiveSearchedFriend();
            if (!friend?.nsaId) {
                alert(tr('Search for a Nintendo Switch user first.'));
                return;
            }

            const originalHtml = button.innerHTML;
            button.disabled = true;
            button.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> ${escapeHtml(tr('Sending Request…'))}`;
            try {
                await coral('/v4/FriendRequest/Create', {
                    nsaId: friend.nsaId,
                    channel: 'FRIEND_CODE'
                });
                showToast(trKey('FriendRequest_Dialog_Sent_Label_Sent_Request'));

                $('fcResultSheet')?.classList.add('hidden');
                $('searchByFriendCodeView')?.classList.add('hidden');
                $('addFriendView')?.classList.remove('hidden');
                if ($('friendCodeInput')) $('friendCodeInput').value = '';
                if ($('searchFriendCodeBtn')) {
                    $('searchFriendCodeBtn').disabled = true;
                    $('searchFriendCodeBtn').classList.add('disabled');
                }
                $('fcInputBox')?.classList.remove('active-focused');
                clearActiveSearchedFriend();
                await loadFriendRequestLists();
            } catch (error) {
                console.error('[FriendRequest] send failed', error); alert(trKey('Error_Dialog_Message_CommunicationFailed'));
            } finally {
                button.disabled = false;
                button.innerHTML = originalHtml;
            }
        }, true);
    }

    function installCorrectCancelSentRequest() {
        const button = $('deleteSentReqBtn');
        if (!button) return;

        button.addEventListener('click', async (event) => {
            // The legacy app flow calls /v3/FriendRequest/Delete. Sent requests are
            // cancelled with /v3/FriendRequest/Cancel.
            event.preventDefault();
            event.stopImmediatePropagation();

            const request = getActiveSentRequest();
            const id = request?.requestId || request?.id;
            if (!id) return;
            if (!confirm(trKey('FriendRequest_Sent_Delete_Confirm'))) return;

            try {
                await runButton(
                    button,
                    () => coral('/v3/FriendRequest/Cancel', { id }),
                    trKey('FriendRequest_Deleted')
                );
                $('sentReqDropdown')?.classList.add('hidden');
                $('sentReqDetailView')?.classList.add('hidden');
                await loadFriendRequestLists();
            } catch (error) {
                console.error('[UI action] request failed', error); alert(trKey('Error_Dialog_Message_CommunicationFailed'));
            }
        }, true);
    }

    function ensureFriendCodeModal() {
        let modal = $('friendCodeQrModal');
        if (modal) return modal;

        modal = document.createElement('div');
        modal.id = 'friendCodeQrModal';
        modal.className = 'modal-overlay hidden';
        modal.innerHTML = `
            <div class="modal-card friends-functional-qr-card" role="dialog" aria-modal="true" aria-labelledby="friendCodeQrTitle">
                <header class="friends-functional-qr-header">
                    <button type="button" id="closeFriendCodeQrBtn" aria-label="Close"><i class="fa-solid fa-xmark"></i></button>
                    <h2 id="friendCodeQrTitle">QR Code</h2>
                </header>
                <div id="friendCodeQrBody"></div>
            </div>`;
        document.body.appendChild(modal);

        $('closeFriendCodeQrBtn')?.addEventListener('click', () => modal.classList.add('hidden'));
        modal.addEventListener('click', (event) => {
            if (event.target === modal) modal.classList.add('hidden');
        });
        return modal;
    }

    function loadQrLibrary() {
        if (typeof QRCode === 'function') return Promise.resolve(QRCode);
        if (state.qrLibraryPromise) return state.qrLibraryPromise;

        state.qrLibraryPromise = new Promise((resolve, reject) => {
            const script = document.createElement('script');
            script.src = 'https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js';
            script.async = true;
            script.onload = () => {
                if (typeof QRCode === 'function') resolve(QRCode);
                else reject(new Error('QR library loaded without QRCode support.'));
            };
            script.onerror = () => reject(new Error('Could not load the QR rendering library.'));
            document.head.appendChild(script);
        }).finally(() => {
            if (typeof QRCode !== 'function') state.qrLibraryPromise = null;
        });

        return state.qrLibraryPromise;
    }

    function knownFriendCode() {
        const candidates = [
            document.getElementById('opFriendCode')?.textContent,
            document.getElementById('profileViewFriendCode')?.textContent,
            document.getElementById('myFriendCode')?.textContent
        ];
        const raw = candidates.map((value) => String(value || '').trim()).find((value) => /^SW-\d{4}-\d{4}-\d{4}$/i.test(value));
        return raw || '';
    }

    function getFriendCodeQrResult() {
        const maxAgeMs = 10 * 60_000;
        if (state.friendCodeQrResult && Date.now() - state.friendCodeQrFetchedAt < maxAgeMs) {
            return Promise.resolve(state.friendCodeQrResult);
        }
        if (state.friendCodeQrPromise) return state.friendCodeQrPromise;

        state.friendCodeQrPromise = coral('/v3/Friend/CreateFriendCodeUrl', {}, { body: {} })
            .then((result) => {
                state.friendCodeQrResult = result || {};
                state.friendCodeQrFetchedAt = Date.now();
                return state.friendCodeQrResult;
            })
            .finally(() => { state.friendCodeQrPromise = null; });
        return state.friendCodeQrPromise;
    }

    async function showMyFriendCode() {
        // Open immediately from already-cached profile data. The Nintendo share URL
        // and QR renderer finish asynchronously after the sheet is already visible.
        const modal = ensureFriendCodeModal();
        const body = $('friendCodeQrBody');
        if (!modal || !body) return;

        let displayFriendCode = knownFriendCode() || '—';
        body.innerHTML = `
            <div id="friendCodeQrCanvas" class="friends-functional-qr-canvas">
                <div class="friends-functional-qr-loading"><i class="fa-solid fa-spinner fa-spin"></i><span>Loading QR code…</span></div>
            </div>
            <p class="friends-functional-qr-label">Friend Code</p>
            <strong id="friendCodeQrValue" class="friends-functional-friend-code">${escapeHtml(displayFriendCode)}</strong>
            <div class="friends-functional-qr-actions">
                <button type="button" id="copyFriendCodeBtn" ${displayFriendCode === '—' ? 'disabled' : ''}>Copy friend code</button>
                <button type="button" id="copyFriendLinkBtn" disabled>Copy Friend Link</button>
            </div>`;

        modal.classList.remove('hidden');

        $('copyFriendCodeBtn')?.addEventListener('click', async () => {
            const value = $('friendCodeQrValue')?.textContent || displayFriendCode;
            try {
                await navigator.clipboard.writeText(value);
                showToast(tr('Copied'));
            } catch {
                prompt(trKey('A11y_Copy_Friend_Code'), value);
            }
        });

        try {
            const [result, Qr] = await Promise.all([
                getFriendCodeQrResult(),
                loadQrLibrary()
            ]);

            const rawFriendCode = String(result?.friendCode || '').trim();
            if (rawFriendCode) {
                displayFriendCode = rawFriendCode.startsWith('SW-') ? rawFriendCode : `SW-${rawFriendCode}`;
                const value = $('friendCodeQrValue');
                if (value) value.textContent = displayFriendCode;
                const copyCode = $('copyFriendCodeBtn');
                if (copyCode) copyCode.disabled = false;
            }

            const copyLink = $('copyFriendLinkBtn');
            if (copyLink) {
                copyLink.disabled = !result?.url;
                copyLink.onclick = async () => {
                    if (!result?.url) return;
                    try {
                        await navigator.clipboard.writeText(result.url);
                        showToast(tr('Copied'));
                    } catch {
                        prompt(tr('Copy Friend Link'), result.url);
                    }
                };
            }

            const host = $('friendCodeQrCanvas');
            if (host && result?.url) {
                host.innerHTML = '';
                new Qr(host, {
                    text: result.url,
                    width: 190,
                    height: 190,
                    correctLevel: Qr.CorrectLevel?.M
                });
            } else if (host) {
                host.innerHTML = `<p class="service-status">${escapeHtml(trKey('Common_Loading_Failed'))}</p>`;
            }
        } catch (error) {
            const host = $('friendCodeQrCanvas');
            if (host) host.innerHTML = `<p class="service-status">${escapeHtml(tr('The Friend Code is still available below.'))}</p>`;
        }
    }

    function normalizeChatCandidate(candidate) {
        if (!candidate || typeof candidate !== 'object') return null;

        // Nintendo Switch App 3.4.1 serializes ChatParticipants as:
        // NintendoServiceAccountId, ChatHistoryId, imageUri, name, lastSeenAt.
        const normalized = {
            nsaId: candidate.nsaId || candidate.friendNsaId || '',
            chatHistoryId: candidate.chatHistoryId || '',
            imageUri: candidate.imageUri || candidate.image2Uri || '',
            name: candidate.name || 'Switch Player',
            lastSeenAt: candidate.lastSeenAt || null
        };
        return normalized.nsaId ? normalized : null;
    }

    function renderVoiceChattedFriends(candidates) {
        const view = $('chattedUsersView');
        const body = view?.querySelector('.chatted-users-body');
        if (!view || !body) return;

        body.querySelectorAll('.friends-functional-user-row').forEach((row) => row.remove());
        const empty = body.querySelector('.chatted-users-empty');
        empty?.classList.add('hidden');

        if (!candidates.length) {
            if (empty) {
                empty.textContent = trKey('FriendRequest_GameChat_Empty');
                empty.classList.remove('hidden');
            }
            return;
        }

        for (const candidate of candidates) {
            const row = document.createElement('div');
            row.className = 'friends-functional-user-row';
            row.dataset.nsaId = candidate.nsaId;
            if (candidate.chatHistoryId) row.dataset.chatHistoryId = candidate.chatHistoryId;

            const lastSeen = formatDate(candidate.lastSeenAt);
            row.innerHTML = `
                <img src="${escapeHtml(candidate.imageUri)}" alt="" onerror="this.style.visibility='hidden'">
                <div>
                    <strong>${escapeHtml(candidate.name)}</strong>
                    <span>${escapeHtml(lastSeen ? trVars('Last chatted {time}', { time: lastSeen }) : tr('GameChat user'))}</span>
                </div>
                <button type="button" class="friends-functional-chat-add">${escapeHtml(trKey('Common_Add_Friend'))}</button>`;

            row.querySelector('.friends-functional-chat-add')?.addEventListener('click', async (event) => {
                const button = event.currentTarget;
                try {
                    await runButton(button, async () => {
                        await coral('/v4/FriendRequest/Create', {
                            nsaId: candidate.nsaId,
                            // CAMPUS is Coral's route channel for GameChat-origin friend requests.
                            channel: 'CAMPUS'
                        });
                    }, 'Friend request sent.');
                    button.textContent = trKey('FriendRequest_Dialog_Sent_Label_Sent_Request');
                    button.disabled = true;
                    loadFriendRequestLists().catch(() => { });
                } catch (error) {
                    console.error('[FriendRequest] send failed', error); alert(trKey('Error_Dialog_Message_CommunicationFailed'));
                }
            });

            body.appendChild(row);
        }
    }

    async function openVoiceChattedFriends() {
        const view = $('chattedUsersView');
        const body = view?.querySelector('.chatted-users-body');
        if (!view || !body) return;

        view.classList.remove('hidden');
        body.querySelectorAll('.friends-functional-user-row').forEach((row) => row.remove());
        const empty = body.querySelector('.chatted-users-empty');
        if (empty) {
            empty.textContent = tr('Loading GameChat users…');
            empty.classList.remove('hidden');
        }

        const result = await coral('/v5/Chat/FriendCandidate/List');
        const rawCandidates = Array.isArray(result)
            ? result
            : (result?.chatParticipants || result?.friendCandidates || []);
        state.chatCandidates = rawCandidates.map(normalizeChatCandidate).filter(Boolean);
        renderVoiceChattedFriends(state.chatCandidates);
    }

    function installViewLoaders() {
        $('openAddFriendBtn')?.addEventListener('click', () => {
            loadFriendRequestLists().catch((error) => {
                console.warn('[Friends] Could not load friend requests', error);
            });
        });

        $('openFriendSettingsBtn')?.addEventListener('click', () => {
            loadPermissions();
            updateNotifySettingsSummary();
        });

        $('openRequestsSettingBtn')?.addEventListener('click', () => {
            loadPermissions();
        });

        $('openBlockedSettingBtn')?.addEventListener('click', () => {
            loadBlockedUsers().catch((error) => {
                console.warn('[Friends] Could not load blocked users', error);
            });
        });

        $('openNotifySettingBtn')?.addEventListener('click', updateNotifySettingsSummary);
        $('openMyCodeQrBtn')?.addEventListener('click', showMyFriendCode);

        $('closeChattedUsersBtn')?.addEventListener('click', () => {
            $('chattedUsersView')?.classList.add('hidden');
        });

        $('openVoiceChattedFriendsBtn')?.addEventListener('click', () => {
            openVoiceChattedFriends().catch((error) => {
                console.warn('[Friends] Could not load GameChat friend candidates', error);
                console.error('[UI action] request failed', error); alert(trKey('Error_Dialog_Message_CommunicationFailed'));
            });
        });
    }

    function init() {
        installReceiveRequestsSetting();
        installNotifySettingsNavigation();
        installCorrectSendFriendRequest();
        installCorrectCancelSentRequest();
        installViewLoaders();
        updateNotifySettingsSummary();
    }

    init();
})();

// ---------------------------------------------------------------------------
