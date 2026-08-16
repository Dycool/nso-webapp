/**
 * Completes the Friends UI already present in app.js/index.html.
 *
 * This file deliberately does not replace the existing Friends list renderer,
 * navigation, friend-code search UI, or play-activity UI. It only wires the
 * controls that are currently disabled/local-only to Coral endpoints exposed
 * through the existing coralCall() helper.
 */
(() => {
    'use strict';

    if (window.__nsoFriendsFunctionalLoaded) return;
    window.__nsoFriendsFunctionalLoaded = true;

    const state = {
        activeFriend: null,
        receivedRequests: [],
        sentRequests: [],
        blockedUsers: [],
        permissions: null,
        qrLibraryPromise: null
    };

    const $ = (id) => document.getElementById(id);

    function coral(path, parameter = {}, options = {}) {
        if (typeof coralCall !== 'function') {
            throw new Error('Coral is not ready. Sign in again and reload the page.');
        }
        return coralCall(path, parameter, options);
    }

    function escapeHtml(value) {
        return String(value ?? '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    }

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
            return new Intl.DateTimeFormat(undefined, {
                dateStyle: 'medium',
                timeStyle: 'short'
            }).format(new Date(ms));
        } catch {
            return new Date(ms).toLocaleString();
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
                console.warn('[FriendsFunctional] Could not refresh friends', error);
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
        } catch {}
    }

    function getActiveSentRequest() {
        try {
            return typeof activeSentRequest !== 'undefined' ? activeSentRequest : null;
        } catch {
            return null;
        }
    }

    function updateFriendDetailControls(friend) {
        const note = $('friendsNoteButton');
        if (note) {
            const value = String(friend?.note || '').trim();
            note.innerHTML = `<i class="fa-solid fa-pencil"></i> ${escapeHtml(value || 'Add Note')}`;
            note.title = value ? `Friend note: ${value}` : 'Add a note';
        }

        const favourite = $('friendsFavouriteButton');
        if (favourite) {
            const enabled = Boolean(friend?.isFavoriteFriend);
            favourite.disabled = false;
            favourite.dataset.enabled = enabled ? 'true' : 'false';
            favourite.innerHTML = `<i class="${enabled ? 'fa-solid' : 'fa-regular'} fa-star"></i> ${enabled ? 'Best Friend' : 'Best Friends'}`;
        }

        const notify = $('friendsNotifyButton');
        if (notify) {
            const enabled = Boolean(friend?.isOnlineNotificationEnabled);
            notify.disabled = false;
            notify.dataset.enabled = enabled ? 'true' : 'false';
            notify.innerHTML = `<i class="${enabled ? 'fa-solid' : 'fa-regular'} fa-bell"></i> ${enabled ? 'Online Alerts On' : 'Notify When Online'}`;
        }
    }

    function installFriendDetailActions() {
        const view = $('friendDetailView');
        if (!view) return;

        const note = view.querySelector('.friend-detail-note');
        if (note) {
            note.id = 'friendsNoteButton';
            note.setAttribute('role', 'button');
            note.setAttribute('tabindex', '0');

            const editNote = async () => {
                const friend = state.activeFriend;
                if (!friend?.nsaId) return;
                const current = String(friend.note || '');
                const next = prompt('Friend note (maximum 20 characters):', current);
                if (next == null) return;
                if (next.length > 20) {
                    alert('Friend notes can be at most 20 characters.');
                    return;
                }

                try {
                    await coral('/v4/Friend/Note/Update', {
                        friendNsaId: friend.nsaId,
                        note: next
                    });
                    friend.note = next;
                    updateFriendDetailControls(friend);
                    showToast('Friend note updated.');
                } catch (error) {
                    alert(`Could not update friend note: ${error.message}`);
                }
            };

            note.addEventListener('click', editNote);
            note.addEventListener('keydown', (event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    editNote();
                }
            });
        }

        const actionButtons = [...view.querySelectorAll('.friend-detail-actions button')];
        const favourite = actionButtons[0];
        const notify = actionButtons[1];

        if (favourite) {
            favourite.id = 'friendsFavouriteButton';
            favourite.disabled = false;
            favourite.addEventListener('click', async () => {
                const friend = state.activeFriend;
                if (!friend?.nsaId) return;
                const wasFavourite = Boolean(friend.isFavoriteFriend);
                const path = wasFavourite
                    ? '/v3/Friend/Favorite/Delete'
                    : '/v3/Friend/Favorite/Create';

                try {
                    await runButton(
                        favourite,
                        () => coral(path, { nsaId: friend.nsaId }),
                        wasFavourite ? 'Removed from Best Friends.' : 'Added to Best Friends.'
                    );
                    friend.isFavoriteFriend = !wasFavourite;
                    updateFriendDetailControls(friend);
                    refreshFriends();
                } catch (error) {
                    alert(`Could not update Best Friend status: ${error.message}`);
                }
            });
        }

        if (notify) {
            notify.id = 'friendsNotifyButton';
            notify.disabled = false;
            notify.addEventListener('click', async () => {
                const friend = state.activeFriend;
                if (!friend?.nsaId) return;
                const wasEnabled = Boolean(friend.isOnlineNotificationEnabled);

                try {
                    await runButton(
                        notify,
                        () => coral('/v5/PushNotification/Settings/Update', [
                            {
                                type: 'friendOnline',
                                value: !wasEnabled,
                                friendId: friend.nsaId
                            }
                        ]),
                        !wasEnabled ? 'Online notifications enabled.' : 'Online notifications disabled.'
                    );
                    friend.isOnlineNotificationEnabled = !wasEnabled;
                    updateFriendDetailControls(friend);
                    updateNotifySettingsSummary();
                } catch (error) {
                    alert(`Could not update online notifications: ${error.message}`);
                }
            });
        }

        const more = view.querySelector('.friend-detail-more');
        if (more) {
            more.id = 'friendsMoreButton';
            more.disabled = false;

            const menu = document.createElement('div');
            menu.id = 'friendsMoreMenu';
            menu.className = 'friends-functional-menu hidden';
            menu.innerHTML = `
                <button type="button" id="friendsRemoveFriend"><i class="fa-solid fa-user-minus"></i> Remove Friend</button>
                <button type="button" id="friendsBlockFriend" class="danger"><i class="fa-solid fa-ban"></i> Block User</button>`;
            view.appendChild(menu);

            more.addEventListener('click', (event) => {
                event.stopPropagation();
                menu.classList.toggle('hidden');
            });

            document.addEventListener('click', (event) => {
                if (!event.target.closest('#friendsMoreMenu') && !event.target.closest('#friendsMoreButton')) {
                    menu.classList.add('hidden');
                }
            });

            $('friendsRemoveFriend')?.addEventListener('click', async () => {
                const friend = state.activeFriend;
                if (!friend?.nsaId) return;
                if (!confirm(`Remove ${friend.name || 'this user'} from your friends list?`)) return;

                try {
                    await runButton(
                        $('friendsRemoveFriend'),
                        () => coral('/v3/Friend/Delete', { nsaId: friend.nsaId }),
                        'Friend removed.'
                    );
                    menu.classList.add('hidden');
                    view.classList.add('hidden');
                    state.activeFriend = null;
                    refreshFriends();
                } catch (error) {
                    alert(`Could not remove friend: ${error.message}`);
                }
            });

            $('friendsBlockFriend')?.addEventListener('click', async () => {
                const friend = state.activeFriend;
                if (!friend?.nsaId) return;
                if (!confirm(`Block ${friend.name || 'this user'}?`)) return;

                try {
                    await runButton(
                        $('friendsBlockFriend'),
                        () => coral('/v3/User/Block/Create', { nsaId: friend.nsaId }),
                        'User blocked.'
                    );
                    menu.classList.add('hidden');
                    view.classList.add('hidden');
                    state.activeFriend = null;
                    refreshFriends();
                    loadBlockedUsers().catch(() => {});
                } catch (error) {
                    alert(`Could not block user: ${error.message}`);
                }
            });
        }

        if (typeof openFriendDetail === 'function') {
            const originalOpenFriendDetail = openFriendDetail;
            const wrappedOpenFriendDetail = function(friend) {
                state.activeFriend = friend || null;
                updateFriendDetailControls(friend);

                const originalResult = originalOpenFriendDetail(friend);

                if (friend?.nsaId) {
                    coral('/v4/Friend/Show', { nsaId: friend.nsaId })
                        .then((full) => {
                            state.activeFriend = { ...friend, ...(full || {}) };
                            updateFriendDetailControls(state.activeFriend);
                        })
                        .catch((error) => {
                            console.debug('[FriendsFunctional] Friend/Show unavailable; using Friend/List data.', error);
                        });

                    if (friend.isNew) {
                        coral('/v4/Friend/IsNew/Delete', { friendNsaId: friend.nsaId })
                            .then(() => { friend.isNew = false; })
                            .catch(() => {});
                    }
                }

                return originalResult;
            };

            try {
                openFriendDetail = wrappedOpenFriendDetail;
            } catch (error) {
                console.warn('[FriendsFunctional] Could not wrap openFriendDetail', error);
            }
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
            console.warn('[FriendsFunctional] Could not load friend permissions', error);
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
                showToast(desired ? 'Friend requests enabled.' : 'Friend requests disabled.');
            } catch (error) {
                toggle.checked = !desired;
                alert(`Could not update friend-request setting: ${error.message}`);
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
        label.textContent = enabledCount === 0
            ? 'No friends are currently selected.'
            : `${enabledCount} friend${enabledCount === 1 ? '' : 's'} selected for online notifications.`;
        button.textContent = 'Choose a Friend';
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
            showToast('Open a friend and choose “Notify When Online”.');
        }, true);
    }

    async function loadBlockedUsers() {
        const list = $('blockedUsersNativeList');
        const empty = $('blockedUsersEmptyText');
        if (!list) return;

        list.classList.remove('hidden');
        list.innerHTML = '<p><i class="fa-solid fa-spinner fa-spin"></i> Loading blocked users…</p>';
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
                        <span>${user.blockedAt ? `Blocked ${escapeHtml(formatDate(user.blockedAt))}` : 'Blocked user'}</span>
                    </div>`;

                const button = document.createElement('button');
                button.type = 'button';
                button.textContent = 'Unblock';
                button.addEventListener('click', async () => {
                    if (!user.nsaId) return;
                    try {
                        await runButton(
                            button,
                            () => coral('/v3/User/Block/Delete', { nsaId: user.nsaId }),
                            'User unblocked.'
                        );
                        await loadBlockedUsers();
                    } catch (error) {
                        alert(`Could not unblock user: ${error.message}`);
                    }
                });
                row.appendChild(button);
                list.appendChild(row);
            }
        } catch (error) {
            list.innerHTML = `<p class="service-status error">Could not load blocked users: ${escapeHtml(error.message)}</p>`;
        }
    }

    function requestPerson(request, direction) {
        return direction === 'received'
            ? (request?.sender || request?.user || {})
            : (request?.receiver || request?.user || {});
    }

    function requestRouteText(request) {
        const route = request?.route || {};
        if (route.channel === 'FRIEND_CODE') return 'By exchanging friend codes.';
        if (route.channel === 'CAMPUS') return 'GameChat';
        if (route.appName) return route.appName;
        return 'Nintendo Switch';
    }

    function renderReceivedRequests() {
        const container = $('receivedRequestsContainer');
        if (!container) return;
        container.innerHTML = '';

        if (!state.receivedRequests.length) {
            container.innerHTML = '<p>You have not received any friend requests at this time.</p>';
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
            accept.textContent = 'Accept';
            accept.addEventListener('click', async (event) => {
                event.stopPropagation();
                try {
                    await runButton(
                        accept,
                        () => coral('/v3/FriendRequest/Accept', { id: request.id }),
                        'Friend request accepted.'
                    );
                    await loadFriendRequestLists();
                    refreshFriends();
                } catch (error) {
                    alert(`Could not accept friend request: ${error.message}`);
                }
            });

            const reject = document.createElement('button');
            reject.type = 'button';
            reject.textContent = 'Reject';
            reject.addEventListener('click', async (event) => {
                event.stopPropagation();
                if (!confirm(`Reject the friend request from ${sender.name || 'this user'}?`)) return;
                try {
                    await runButton(
                        reject,
                        () => coral('/v3/FriendRequest/Reject', { id: request.id }),
                        'Friend request rejected.'
                    );
                    await loadFriendRequestLists();
                } catch (error) {
                    alert(`Could not reject friend request: ${error.message}`);
                }
            });

            actions.append(accept, reject);
            row.appendChild(actions);

            row.addEventListener('click', () => {
                if (request.hasRead === false && request.id) {
                    request.hasRead = true;
                    row.classList.remove('unread');
                    coral('/v4/FriendRequest/Received/MarkAsRead', { id: request.id }).catch(() => {});
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
            receivedContainer.innerHTML = '<p><i class="fa-solid fa-spinner fa-spin"></i> Loading received requests…</p>';
        }

        const sentList = $('sentRequestsList');
        const sentEmpty = $('sentRequestsEmptyText');
        if (sentList) {
            sentList.classList.remove('hidden');
            sentList.innerHTML = '<p><i class="fa-solid fa-spinner fa-spin"></i> Loading sent requests…</p>';
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
            receivedContainer.innerHTML = `<p class="service-status error">Could not load received requests: ${escapeHtml(receivedResult.reason?.message || receivedResult.reason)}</p>`;
        }

        if (sentResult.status === 'fulfilled') {
            state.sentRequests = Array.isArray(sentResult.value)
                ? sentResult.value
                : (sentResult.value?.friendRequests || []);
            if (!syncLegacySentRequests() && sentList) {
                sentList.innerHTML = state.sentRequests.length
                    ? '<p>Sent requests loaded, but the existing renderer is unavailable.</p>'
                    : '';
            }
        } else if (sentList) {
            sentList.classList.remove('hidden');
            sentList.innerHTML = `<p class="service-status error">Could not load sent requests: ${escapeHtml(sentResult.reason?.message || sentResult.reason)}</p>`;
        }
    }

    function installCorrectSendFriendRequest() {
        const button = $('sendFriendRequestBtn');
        if (!button) return;

        button.addEventListener('click', async (event) => {
            // app.js currently has a legacy /v3/FriendRequest/Create handler. Capture
            // phase prevents that handler from also running.
            event.preventDefault();
            event.stopImmediatePropagation();

            const friend = getActiveSearchedFriend();
            if (!friend?.nsaId) {
                alert('Search for a Nintendo Switch user first.');
                return;
            }

            const originalHtml = button.innerHTML;
            button.disabled = true;
            button.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Sending Request...';
            try {
                await coral('/v4/FriendRequest/Create', {
                    nsaId: friend.nsaId,
                    channel: 'FRIEND_CODE'
                });
                showToast('Friend request sent.');

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
                alert(`Could not send friend request: ${error.message}`);
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
            // app.js currently calls /v3/FriendRequest/Delete. Sent requests are
            // cancelled with /v3/FriendRequest/Cancel.
            event.preventDefault();
            event.stopImmediatePropagation();

            const request = getActiveSentRequest();
            const id = request?.requestId || request?.id;
            if (!id) return;
            if (!confirm(`Cancel the friend request sent to ${request.name || 'this user'}?`)) return;

            try {
                await runButton(
                    button,
                    () => coral('/v3/FriendRequest/Cancel', { id }),
                    'Friend request cancelled.'
                );
                $('sentReqDropdown')?.classList.add('hidden');
                $('sentReqDetailView')?.classList.add('hidden');
                await loadFriendRequestLists();
            } catch (error) {
                alert(`Could not cancel friend request: ${error.message}`);
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

    async function showMyFriendCode() {
        const button = $('openMyCodeQrBtn');
        if (!button) return;

        const oldHtml = button.innerHTML;
        button.disabled = true;
        try {
            // nxapi marks this call as NoParameter, so the request body is exactly {}.
            const result = await coral('/v3/Friend/CreateFriendCodeUrl', {}, { body: {} });
            const modal = ensureFriendCodeModal();
            const body = $('friendCodeQrBody');
            if (!body) return;

            const rawFriendCode = String(result?.friendCode || '');
            const displayFriendCode = rawFriendCode
                ? (rawFriendCode.startsWith('SW-') ? rawFriendCode : `SW-${rawFriendCode}`)
                : 'Friend Code unavailable';

            body.innerHTML = `
                <div id="friendCodeQrCanvas" class="friends-functional-qr-canvas"></div>
                <p class="friends-functional-qr-label">Your Friend Code</p>
                <strong class="friends-functional-friend-code">${escapeHtml(displayFriendCode)}</strong>
                <div class="friends-functional-qr-actions">
                    <button type="button" id="copyFriendCodeBtn">Copy Friend Code</button>
                    <button type="button" id="copyFriendLinkBtn" ${result?.url ? '' : 'disabled'}>Copy Friend Link</button>
                </div>`;

            $('copyFriendCodeBtn')?.addEventListener('click', async () => {
                try {
                    await navigator.clipboard.writeText(displayFriendCode);
                    showToast('Friend Code copied.');
                } catch {
                    prompt('Copy your Friend Code:', displayFriendCode);
                }
            });

            $('copyFriendLinkBtn')?.addEventListener('click', async () => {
                if (!result?.url) return;
                try {
                    await navigator.clipboard.writeText(result.url);
                    showToast('Friend link copied.');
                } catch {
                    prompt('Copy your friend link:', result.url);
                }
            });

            modal.classList.remove('hidden');

            if (result?.url) {
                try {
                    const Qr = await loadQrLibrary();
                    const host = $('friendCodeQrCanvas');
                    if (host) {
                        host.innerHTML = '';
                        new Qr(host, {
                            text: result.url,
                            width: 190,
                            height: 190,
                            correctLevel: Qr.CorrectLevel?.M
                        });
                    }
                } catch (error) {
                    const host = $('friendCodeQrCanvas');
                    if (host) host.innerHTML = `<p class="service-status">${escapeHtml(error.message)} The Friend Code and link are still available below.</p>`;
                }
            }
        } catch (error) {
            alert(`Could not create your Friend Code QR link: ${error.message}`);
        } finally {
            button.disabled = false;
            button.innerHTML = oldHtml;
        }
    }

    function installViewLoaders() {
        $('openAddFriendBtn')?.addEventListener('click', () => {
            loadFriendRequestLists().catch((error) => {
                console.warn('[FriendsFunctional] Could not load friend requests', error);
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
                console.warn('[FriendsFunctional] Could not load blocked users', error);
            });
        });

        $('openNotifySettingBtn')?.addEventListener('click', updateNotifySettingsSummary);
        $('openMyCodeQrBtn')?.addEventListener('click', showMyFriendCode);

        // nxapi currently does not expose enough request/response information for
        // Chat/FriendCandidate/List to implement this safely. Make the existing
        // button explain that limitation instead of appearing broken.
        $('openVoiceChattedFriendsBtn')?.addEventListener('click', () => {
            alert('Users You\'ve Chatted With is not available yet because the current nxapi Coral implementation does not define the Chat/FriendCandidate/List request/response format.');
        });
    }

    function injectStyles() {
        if ($('friendsFunctionalStyles')) return;
        const style = document.createElement('style');
        style.id = 'friendsFunctionalStyles';
        style.textContent = `
            .friends-functional-toast {
                position: fixed; z-index: 10000; left: 50%; bottom: 84px;
                max-width: min(420px, calc(100vw - 32px)); padding: 10px 16px;
                border-radius: 999px; background: rgba(20,20,22,.96); color: #fff;
                font: 600 13px var(--font-heading, sans-serif); opacity: 0;
                transform: translate(-50%, 10px); pointer-events: none;
                transition: opacity .16s ease, transform .16s ease;
                box-shadow: 0 8px 24px rgba(0,0,0,.35);
            }
            .friends-functional-toast.show { opacity: 1; transform: translate(-50%, 0); }
            #friendsNoteButton { cursor: pointer; }
            #friendsNoteButton:focus-visible { outline: 2px solid #fff; outline-offset: 4px; }
            .friends-functional-menu {
                position: absolute; z-index: 220; top: 58px; right: 22px;
                min-width: 190px; padding: 6px; border-radius: 10px;
                background: #303034; box-shadow: 0 10px 30px rgba(0,0,0,.45);
            }
            .friends-functional-menu button {
                display: flex; width: 100%; align-items: center; gap: 9px;
                padding: 11px 12px; border: 0; border-radius: 7px;
                background: transparent; color: #eee; text-align: left; cursor: pointer;
            }
            .friends-functional-menu button:hover { background: rgba(255,255,255,.08); }
            .friends-functional-menu button.danger { color: #ff6b72; }
            .friends-functional-user-row,
            .friends-functional-request-row {
                display: grid; grid-template-columns: 52px minmax(0, 1fr) auto;
                gap: 12px; width: 100%; align-items: center; padding: 12px;
                margin: 0 0 8px; border-radius: 11px; background: #2a2a2d;
                text-align: left;
            }
            .friends-functional-user-row img,
            .friends-functional-request-row img {
                width: 52px; height: 52px; border-radius: 50%; object-fit: cover;
                background: #3a3a3d;
            }
            .friends-functional-user-row > div,
            .friends-functional-request-row > div { min-width: 0; }
            .friends-functional-user-row strong,
            .friends-functional-request-row strong { display: block; color: #fff; }
            .friends-functional-user-row span,
            .friends-functional-request-row span,
            .friends-functional-request-row small {
                display: block; margin-top: 2px; color: #99999e; font-size: 12px;
                overflow: hidden; white-space: nowrap; text-overflow: ellipsis;
            }
            .friends-functional-user-row > button,
            .friends-functional-request-actions button,
            .friends-functional-qr-actions button {
                border: 0; border-radius: 999px; padding: 8px 12px;
                background: #444448; color: #fff; font-weight: 700; cursor: pointer;
            }
            .friends-functional-request-row.unread { box-shadow: inset 3px 0 0 #22b8f0; }
            .friends-functional-request-actions { display: flex; gap: 7px; }
            .friends-functional-request-actions button.primary { background: #22aee8; }
            .friends-functional-qr-card {
                width: min(360px, calc(100vw - 32px)); padding: 0 0 24px;
                text-align: center; overflow: hidden;
            }
            .friends-functional-qr-header {
                display: grid; grid-template-columns: 44px 1fr 44px; align-items: center;
                min-height: 52px; padding: 0 8px; border-bottom: 1px solid rgba(255,255,255,.08);
            }
            .friends-functional-qr-header button {
                width: 40px; height: 40px; border: 0; background: transparent;
                color: #fff; font-size: 18px; cursor: pointer;
            }
            .friends-functional-qr-header h2 { grid-column: 2; margin: 0; font-size: 17px; }
            #friendCodeQrBody { padding: 22px 24px 0; }
            .friends-functional-qr-canvas {
                display: flex; min-height: 190px; align-items: center; justify-content: center;
                margin-bottom: 16px;
            }
            .friends-functional-qr-canvas img,
            .friends-functional-qr-canvas canvas { padding: 8px; background: #fff; border-radius: 8px; }
            .friends-functional-qr-label { margin: 0 0 4px; color: #99999e; font-size: 12px; }
            .friends-functional-friend-code { display: block; margin-bottom: 16px; font-size: 20px; }
            .friends-functional-qr-actions { display: flex; justify-content: center; gap: 8px; flex-wrap: wrap; }
            @media (max-width: 560px) {
                .friends-functional-request-row { grid-template-columns: 48px minmax(0, 1fr); }
                .friends-functional-request-actions { grid-column: 1 / -1; }
            }
        `;
        document.head.appendChild(style);
    }

    function init() {
        injectStyles();
        installFriendDetailActions();
        installReceiveRequestsSetting();
        installNotifySettingsNavigation();
        installCorrectSendFriendRequest();
        installCorrectCancelSentRequest();
        installViewLoaders();
        updateNotifySettingsSummary();
        console.log('[FriendsFunctional] Missing Friends controls wired to Coral');
    }

    init();
})();
