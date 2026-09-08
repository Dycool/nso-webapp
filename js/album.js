

const albumView = { game: '', type: '', sort: 'uploaded-desc' };
let albumDownloadBusy = false;
let albumDeleteBusy = false;
let albumRevision = 0;

function mediaTimestamp(value) {
    if (value === null || value === undefined || value === '') return 0;
    const numeric = Number(value);
    const ms = Number.isFinite(numeric)
        ? (numeric < 10_000_000_000 ? numeric * 1000 : numeric)
        : Date.parse(value);
    return Number.isFinite(ms) && Number.isFinite(new Date(ms).getTime()) ? ms : 0;
}

function visibleAlbumMedia(media = currentMedia) {
    const [field, direction] = (albumView.sort || 'uploaded-desc').split('-');
    const dateField = field === 'captured' ? 'capturedAt' : 'uploadedAt';
    return media.filter(item => (!albumView.game || item.appName === albumView.game)
        && (!albumView.type || (item.type === 'video' ? 'video' : 'image') === albumView.type))
        .sort((a, b) => {
            const left = mediaTimestamp(a[dateField]);
            const right = mediaTimestamp(b[dateField]);

            if (!left || !right) return left ? -1 : right ? 1 : 0;
            return direction === 'asc' ? left - right : right - left;
        });
}

function albumSavedStorageKey() {
    const account = typeof coralCacheAccountKey === 'function' ? coralCacheAccountKey() : null;
    return account ? `nso_album_saved:${account}` : 'nso_album_saved';
}

function albumSavedKeys() {
    try {
        const key = albumSavedStorageKey();
        const value = key ? JSON.parse(localStorage.getItem(key) || '[]') : [];
        return new Set(Array.isArray(value) ? value : []);
    } catch { return new Set(); }
}

function markAlbumSaved(items, storageKey = albumSavedStorageKey()) {
    if (!storageKey) return;
    const saved = albumSavedKeys();
    items.forEach(item => saved.add(getMediaKey(item)));
    try { localStorage.setItem(storageKey, JSON.stringify([...saved].slice(-5000))); } catch { }
}

function albumPreserveCaptureDate() {
    try { return localStorage.getItem('nso_album_preserve_capture_date') === 'true'; }
    catch { return false; }
}

function setAlbumPreserveCaptureDate(enabled) {
    try { localStorage.setItem('nso_album_preserve_capture_date', String(enabled)); }
    catch { toast(tr('Unable to save this setting.')); }
}

function albumZipDate(item, preserve = albumPreserveCaptureDate()) {
    const captured = mediaTimestamp(item.capturedAt);

    const date = new Date(preserve && captured ? captured : Date.now());
    return date.getFullYear() >= 1980 && date.getFullYear() <= 2107 ? date : new Date();
}

function uniqueAlbumPath(item, usedPaths) {
    const original = getSwitchFilePath(item);
    let candidate = original;
    let suffix = 2;
    while (usedPaths.has(candidate)) candidate = original.replace(/(\.[^.]+)$/, `_${suffix++}$1`);
    usedPaths.add(candidate);
    return candidate;
}

function refreshAlbumView() {

    selectedMediaSet.clear();
    renderMediaLists(currentMedia);
}

function getMediaKey(item) {
    return item.id ? String(item.id) : item.contentUri;
}

function sanitizeFolderName(name) {
    if (!name || typeof name !== 'string') return 'Other';
    const clean = name.replace(/[<>:"/\\|?*]/g, '').trim();
    return clean || 'Other';
}

function getSwitchFilePath(item) {
    const ms = mediaTimestamp(item.capturedAt) || mediaTimestamp(item.uploadedAt) || Date.now();
    const d = new Date(ms);
    const yyyy = String(d.getFullYear());
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    const hh = String(d.getHours()).padStart(2, '0');
    const min = String(d.getMinutes()).padStart(2, '0');
    const sec = String(d.getSeconds()).padStart(2, '0');
    const timePrefix = `${yyyy}${mm}${dd}${hh}${min}${sec}00`;
    const ext = item.type === 'video' ? 'mp4' : 'jpg';
    const folder = sanitizeFolderName(item.appName);
    const filename = `${timePrefix}_c.${ext}`;

    return `Album/${folder}/${filename}`;
}

function updateAlbumSelectionUI() {
    const visible = visibleAlbumMedia();
    const totalSelected = selectedMediaSet.size;
    const downloadBtn = document.getElementById('albumDownloadZipBtn');
    const countBadge = document.getElementById('selectedCountBadge');
    const deleteBtn = document.getElementById('albumDeleteBtn');
    if (deleteBtn) deleteBtn.disabled = albumDeleteBusy || albumDownloadBusy || !visible.some(item => item.id && selectedMediaSet.has(getMediaKey(item)));
    const viewerDelete = document.getElementById('mediaDeleteBtn');
    if (viewerDelete) viewerDelete.disabled = albumDeleteBusy || albumDownloadBusy || !activeMediaItem?.id;
    const selectAllBtnText = document.getElementById('selectAllBtnText');

    if (downloadBtn) {
        downloadBtn.disabled = albumDownloadBusy || albumDeleteBusy || totalSelected === 0;
        const downloadBtnText = document.getElementById('downloadBtnText');
        if (downloadBtnText && !albumDownloadBusy) {
            downloadBtnText.textContent = tr('Download');
        }
    }
    if (countBadge) {
        countBadge.textContent = totalSelected;
        countBadge.classList.toggle('hidden', totalSelected === 0);
    }
    if (selectAllBtnText) {
        if (visible.length > 0 && visible.every(item => selectedMediaSet.has(getMediaKey(item)))) {
            selectAllBtnText.textContent = tr('Deselect All');
        } else {
            selectAllBtnText.textContent = totalSelected > 0 ? `${tr('Select All')} (${totalSelected})` : tr('Select All');
        }
    }

    const albumGrid = document.getElementById('mediaGrid');
    if (albumGrid) {
        const cards = albumGrid.querySelectorAll('.media-item');
        cards.forEach((card, index) => {
            const item = visible[index];
            if (item) {
                const isSelected = selectedMediaSet.has(getMediaKey(item));
                card.classList.toggle('is-selected', isSelected);
                card.querySelector('.media-select-check')?.setAttribute('aria-pressed', String(isSelected));
            }
        });
    }
}

function toggleSelectMedia(item) {
    if (albumDeleteBusy) return;
    const key = getMediaKey(item);
    if (selectedMediaSet.has(key)) {
        selectedMediaSet.delete(key);
    } else {
        selectedMediaSet.add(key);
    }
    updateAlbumSelectionUI();
}

function toggleSelectAllAlbum() {
    if (albumDeleteBusy) return;
    const visible = visibleAlbumMedia();
    if (!visible.length) return;
    if (visible.every(item => selectedMediaSet.has(getMediaKey(item)))) {
        selectedMediaSet.clear();
    } else {
        selectedMediaSet.clear();
        visible.forEach(item => selectedMediaSet.add(getMediaKey(item)));
    }
    updateAlbumSelectionUI();
}

async function fetchAlbumMediaBlob(contentUri) {
    if (!contentUri) throw new Error('Missing media URL');

    try {
        const directResp = await fetch(contentUri, { mode: 'cors' });
        if (directResp.ok) {
            return await directResp.blob();
        }
    } catch (_) {
    }

    const proxyResp = await proxyFetch(contentUri);
    if (!proxyResp.ok) throw new Error(`Download failed (HTTP ${proxyResp.status}).`);
    return await proxyResp.blob();
}

async function downloadSelectedAlbum() {
    if (albumDeleteBusy || albumDownloadBusy || selectedMediaSet.size === 0) return;

    const itemsToDownload = visibleAlbumMedia().filter(item => selectedMediaSet.has(getMediaKey(item)));
    const total = itemsToDownload.length;
    if (!total) return;

    const downloadBtn = document.getElementById('albumDownloadZipBtn');
    const originalContent = downloadBtn ? downloadBtn.innerHTML : '';
    albumDownloadBusy = true;
    if (downloadBtn) downloadBtn.disabled = true;

    const preserveDate = albumPreserveCaptureDate();
    const savedStorageKey = albumSavedStorageKey();

    try {
        if (total === 1) {

            const item = itemsToDownload[0];
            if (downloadBtn) {
                downloadBtn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> <span>${escapeHtml(trKey('Album_Saving'))}</span>`;
            }
            const blob = await fetchAlbumMediaBlob(item.contentUri);
            const filename = getSwitchFilePath(item).split('/').pop();
            const objectUrl = URL.createObjectURL(blob);
            const anchor = document.createElement('a');
            anchor.href = objectUrl;
            anchor.download = filename;
            anchor.click();
            markAlbumSaved([item], savedStorageKey);
            setTimeout(() => URL.revokeObjectURL(objectUrl), 30_000);
        } else {

            if (typeof JSZip === 'undefined') {
                alert(tr('Zip library is still loading. Please try again in a moment.'));
                return;
            }
            const zip = new JSZip();
            const usedPaths = new Set();
            for (let i = 0; i < total; i++) {
                const item = itemsToDownload[i];
                if (downloadBtn) {
                    downloadBtn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> <span>${escapeHtml(trFormat('Album_Saving_Multi', i + 1, total))}</span>`;
                }
                const blob = await fetchAlbumMediaBlob(item.contentUri);
                const filePath = uniqueAlbumPath(item, usedPaths);
                zip.file(filePath, blob, { date: albumZipDate(item, preserveDate) });
            }

            if (downloadBtn) {
                downloadBtn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> <span>${escapeHtml(tr('Packaging ZIP…'))}</span>`;
            }
            const zipBlob = await zip.generateAsync({
                type: 'blob',
                compression: 'DEFLATE',
                compressionOptions: { level: 6 }
            });

            const downloadUrl = URL.createObjectURL(zipBlob);
            const anchor = document.createElement('a');
            anchor.href = downloadUrl;
            anchor.download = `Nintendo_Switch_Album_${new Date().toISOString().slice(0, 10)}.zip`;
            anchor.click();
            markAlbumSaved(itemsToDownload, savedStorageKey);
            setTimeout(() => URL.revokeObjectURL(downloadUrl), 30_000);
        }
    } catch (error) {
        console.error('[Album] download failed', error);
        alert(trKey('Error_Dialog_Message_CommunicationFailed'));
    } finally {
        albumDownloadBusy = false;
        if (downloadBtn) {
            downloadBtn.disabled = selectedMediaSet.size === 0;
            downloadBtn.innerHTML = originalContent;
        }
        updateAlbumSelectionUI();
    }
}

document.getElementById('albumSelectAllBtn')?.addEventListener('click', toggleSelectAllAlbum);
document.getElementById('albumDownloadZipBtn')?.addEventListener('click', downloadSelectedAlbum);

function renderMediaCards(container, items, isAlbumPage = false) {
    container.innerHTML = '';
    items.forEach(item => {
        const button = document.createElement('div');
        button.className = 'media-item';
        const key = getMediaKey(item);
        if (isAlbumPage && selectedMediaSet.has(key)) {
            button.classList.add('is-selected');
        }
        const title = item.appName || 'Nintendo Switch capture';
        button.innerHTML = `
            ${isAlbumPage ? '<button class="media-select-check" type="button" aria-label="Select item"><i class="fa-solid fa-check"></i></button>' : ''}
            <button class="media-open" type="button" aria-label="${escapeHtml(title)}">
            <div class="media-thumb-wrap">
                <img src="${item.thumbnailUri || item.contentUri}" alt="${title}" loading="eager">
                ${item.type === 'video' ? '<span class="video-badge"><i class="fa-solid fa-play"></i></span>' : ''}
            </div>
            <span class="media-title">${escapeHtml(title)}</span>
            </button>
        `;

        if (isAlbumPage) {
            const checkBtn = button.querySelector('.media-select-check');
            checkBtn?.addEventListener('click', (e) => {
                e.stopPropagation();
                toggleSelectMedia(item);
            });
        }

        button.querySelector('.media-open')?.addEventListener('click', () => {
            if (isAlbumPage && selectedMediaSet.size > 0) {
                toggleSelectMedia(item);
            } else {
                openMediaViewer(item);
            }
        });

        container.appendChild(button);
    });
}

function renderMediaLists(media) {
    const homeContainer = document.getElementById('homeMediaGrid');
    const albumContainer = document.getElementById('mediaGrid');
    const recentMedia = media.slice(0, 5);
    const visible = visibleAlbumMedia(media);
    const gameFilter = document.getElementById('albumGameFilter');
    if (gameFilter) {
        gameFilter.replaceChildren(new Option(tr('All games'), ''));
        [...new Set(media.map(item => item.appName).filter(Boolean))].sort().forEach(name => {
            gameFilter.add(new Option(name, name));
        });
        gameFilter.value = albumView.game;
        if (gameFilter.selectedIndex < 0) {
            gameFilter.add(new Option(albumView.game, albumView.game));
            gameFilter.value = albumView.game;
        }
    }
    const count = document.getElementById('albumResultCount');
    if (count) count.textContent = `${visible.length} / ${media.length}`;

    if (homeContainer) {
        if (recentMedia.length) {
            renderMediaCards(homeContainer, recentMedia, false);
        } else {
            homeContainer.innerHTML = `<p class="service-status">${escapeHtml(trKey('Album_Empty_Notice'))}</p>`;
        }
    }

    if (albumContainer) {
        if (visible.length) {
            renderMediaCards(albumContainer, visible, true);
            updateAlbumSelectionUI();
        } else {
            albumContainer.innerHTML = `<p class="service-status">${escapeHtml(media.length ? trKey('Album_Filter_No_Match') : trKey('Album_Empty_Notice'))}</p>`;
            updateAlbumSelectionUI();
        }
    }
}

async function loadSwitchMedia() {
    const mediaContainers = ['homeMediaGrid', 'mediaGrid'].map(id => document.getElementById(id)).filter(Boolean);
    if (!userSession || albumDeleteBusy) return;
    const session = userSession;
    const revision = albumRevision;
    mediaContainers.forEach(container => {
        container.innerHTML = Array.from({ length: 5 }, () => '<div class="media-loading-tile"></div>').join('');
    });
    try {
        const result = await coralCall('/v4/Media/List');
        if (session !== userSession) return;
        if (revision !== albumRevision) {
            invalidateCoralDataCache('/v4/Media/List');
            return;
        }
        const media = Array.isArray(result.media) ? result.media : [];
        const keys = new Set(media.map(getMediaKey));
        for (const key of selectedMediaSet) if (!keys.has(key)) selectedMediaSet.delete(key);
        currentMedia = media;
        renderMediaLists(media);
    } catch (e) {
        if (session !== userSession || revision !== albumRevision) return;
        mediaContainers.forEach(container => {
            console.error('[Album] load failed', e); container.innerHTML = `<p class="service-status error">${escapeHtml(trKey('Common_Loading_Failed'))}</p>`;
        });
    }
}

function openMediaViewer(item) {
    activeMediaItem = item;
    updateAlbumSelectionUI();
    const title = item.appName || 'Nintendo Switch capture';
    const titleEl = document.getElementById('mediaModalTitle');
    if (titleEl) titleEl.textContent = title;
    const content = document.getElementById('mediaModalContent');
    if (content) {
        content.innerHTML = '';
        const media = document.createElement(item.type === 'video' ? 'video' : 'img');
        media.src = item.contentUri;
        if (item.type === 'video') {
            media.controls = true;
            media.autoplay = true;
            media.playsInline = true;
        } else {
            media.alt = title;
        }
        content.append(media);
    }
    document.getElementById('mediaModalMeta')?.classList.add('hidden');
    document.getElementById('mediaModal')?.classList.remove('hidden');

    document.body.style.overflow = 'hidden';
    document.documentElement.style.overflow = 'hidden';
}

function closeMediaViewer() {
    const modal = document.getElementById('mediaModal');
    if (modal) modal.classList.add('hidden');
    const content = document.getElementById('mediaModalContent');
    if (content) {
        const video = content.querySelector('video');
        if (video) video.pause();
        content.innerHTML = '';
    }
    activeMediaItem = null;

    document.body.style.overflow = '';
    document.documentElement.style.overflow = '';
}

document.getElementById('closeMediaModalBtn')?.addEventListener('click', closeMediaViewer);
document.getElementById('mediaInfoBtn')?.addEventListener('click', showActiveMediaInfo);
document.getElementById('mediaShareBtn')?.addEventListener('click', shareActiveMedia);
document.getElementById('mediaDownloadBtn')?.addEventListener('click', downloadActiveMedia);

document.getElementById('mediaModal')?.addEventListener('click', (e) => {
    if (e.target.id === 'mediaModal') {
        closeMediaViewer();
    }
});

document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !document.getElementById('mediaModal')?.classList.contains('hidden')) {
        closeMediaViewer();
    }
});

function formatMediaDate(timestamp) {
    if (!timestamp) return '—';
    const milliseconds = mediaTimestamp(timestamp);
    if (!milliseconds) return '—';
    return new Intl.DateTimeFormat(typeof window.nsoCurrentLocale === 'function' ? window.nsoCurrentLocale() : undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(milliseconds));
}

function showActiveMediaInfo() {
    if (!activeMediaItem) return;
    const meta = document.getElementById('mediaModalMeta');
    meta.innerHTML = '';
    const rows = [
        [trKey('Album_Game_Title'), activeMediaItem.appName || 'Nintendo Switch'],
        [tr('Type'), activeMediaItem.type === 'video' ? tr('Video') : tr('Screenshot')],
        [trKey('Album_Captured_Date'), formatMediaDate(activeMediaItem.capturedAt)],
        [trKey('Album_Uploaded_Date'), formatMediaDate(activeMediaItem.uploadedAt)],
        [tr('Expires'), formatMediaDate(activeMediaItem.expiresAt)]
    ];
    for (const [label, value] of rows) {
        const row = document.createElement('p');
        const strong = document.createElement('strong');
        strong.textContent = label;
        row.append(strong, document.createTextNode(value));
        meta.append(row);
    }
    meta.classList.toggle('hidden');
}

async function shareActiveMedia() {
    if (!activeMediaItem) return;
    const shareData = { title: activeMediaItem.appName || 'Nintendo Switch capture', url: activeMediaItem.contentUri };
    if (navigator.share) {
        try {
            await navigator.share(shareData);
            return;
        } catch (error) {
            if (error.name === 'AbortError') return;
        }
    }
    try {
        await navigator.clipboard.writeText(activeMediaItem.contentUri);
        toast(tr('Capture link copied to the clipboard.'));
    } catch {
        window.open(activeMediaItem.contentUri, '_blank', 'noopener');
    }
}

async function downloadActiveMedia() {
    if (!activeMediaItem || albumDeleteBusy || albumDownloadBusy) return;
    const item = activeMediaItem;
    const savedStorageKey = albumSavedStorageKey();
    const button = document.getElementById('mediaDownloadBtn');
    if (button?.disabled) return;
    albumDownloadBusy = true;
    if (button) button.disabled = true;
    try {
        const blob = await fetchAlbumMediaBlob(item.contentUri);
        const filename = getSwitchFilePath(item).split('/').pop();
        const objectUrl = URL.createObjectURL(blob);
        const anchor = document.createElement('a');
        anchor.href = objectUrl;
        anchor.download = filename;
        anchor.click();
        markAlbumSaved([item], savedStorageKey);
        setTimeout(() => URL.revokeObjectURL(objectUrl), 30_000);
    } catch (error) {
        console.error('[Album] download failed', error);
        alert(trKey('Error_Dialog_Message_CommunicationFailed'));
    } finally {
        albumDownloadBusy = false;
        if (button) button.disabled = false;
        updateAlbumSelectionUI();
    }
}

for (const [id, field] of [['albumGameFilter', 'game'], ['albumTypeFilter', 'type'], ['albumSort', 'sort']]) {
    document.getElementById(id)?.addEventListener('change', event => {
        albumView[field] = event.target.value;
        refreshAlbumView();
    });
}
document.getElementById('albumResetFilters')?.addEventListener('click', () => {
    Object.assign(albumView, { game: '', type: '', sort: 'uploaded-desc' });
    const gameFilter = document.getElementById('albumGameFilter');
    if (gameFilter) gameFilter.value = '';
    const typeFilter = document.getElementById('albumTypeFilter');
    if (typeFilter) typeFilter.value = '';
    const sortFilter = document.getElementById('albumSort');
    if (sortFilter) sortFilter.value = 'uploaded-desc';
    refreshAlbumView();
});
document.getElementById('albumFilterToggleBtn')?.addEventListener('click', () => {
    const panel = document.getElementById('albumFiltersPanel');
    const btn = document.getElementById('albumFilterToggleBtn');
    if (!panel) return;
    const isHidden = panel.classList.toggle('hidden');
    if (btn) {
        btn.setAttribute('aria-expanded', String(!isHidden));
        btn.classList.toggle('is-active', !isHidden);
    }
});

async function deleteAlbumMedia(items) {
    if (albumDeleteBusy || albumDownloadBusy || !userSession) return;
    const targets = [...new Map(items.filter(item => item.id).map(item => [String(item.id), item])).values()];
    if (!targets.length) return;
    const session = userSession;
    if (!window.confirm(`${trKey('Album_Delete_Alert')} (${targets.length})\n${trKey('Album_Delete_Alert_Notice')}`)) return;
    albumDeleteBusy = true;
    albumRevision++;
    const deleteBtn = document.getElementById('albumDeleteBtn');
    const deleteBtnText = document.getElementById('albumDeleteBtnText');
    if (deleteBtn) deleteBtn.disabled = true;
    if (deleteBtnText) deleteBtnText.textContent = `${tr('Deleting...')} (0/${targets.length})`;
    updateAlbumSelectionUI();
    let deleted = 0;
    try {

        for (const item of targets) {
            if (session !== userSession) break;
            await coralCall('/v4/Media/Delete', { mediaIds: [String(item.id)] }, {
                platform: false, productVersion: false, cache: false
            });
            if (session !== userSession) break;
            deleted++;
            if (deleteBtnText) deleteBtnText.textContent = `${tr('Deleting...')} (${deleted}/${targets.length})`;
            currentMedia = currentMedia.filter(entry => getMediaKey(entry) !== getMediaKey(item));
            selectedMediaSet.delete(getMediaKey(item));
            if (activeMediaItem && getMediaKey(activeMediaItem) === getMediaKey(item)) closeMediaViewer();
            invalidateCoralDataCache('/v4/Media/List');
            renderMediaLists(currentMedia);
        }
        if (deleted && session === userSession) toast(trKey('Album_Deleted'));
    } catch (error) {
        console.error('[Album] deletion failed', error);
        if (session === userSession) alert(`${tr('Could not delete all selected captures.')} ${deleted}/${targets.length}. ${tr('Refresh the album before retrying.')}`);
    } finally {
        albumDeleteBusy = false;
        if (deleteBtnText) deleteBtnText.textContent = tr('Delete selected');
        if (session === userSession) updateAlbumSelectionUI();
    }
}

document.getElementById('albumDeleteBtn')?.addEventListener('click', () => {
    deleteAlbumMedia(visibleAlbumMedia().filter(item => selectedMediaSet.has(getMediaKey(item))));
});
document.getElementById('mediaDeleteBtn')?.addEventListener('click', () => {
    if (activeMediaItem) deleteAlbumMedia([activeMediaItem]);
});
document.getElementById('albumRefreshBtn')?.addEventListener('click', () => {
    if (albumDeleteBusy) return;
    invalidateCoralDataCache('/v4/Media/List');
    loadSwitchMedia();
});

window.albumPreserveCaptureDate = albumPreserveCaptureDate;
window.setAlbumPreserveCaptureDate = setAlbumPreserveCaptureDate;
