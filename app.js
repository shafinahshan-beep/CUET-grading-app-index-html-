/* ============================================================
   StudyDrive — App Logic (Google Drive API Integration)
   ============================================================ */

'use strict';

// ─── CONFIG ─────────────────────────────────────────────────
// IMPORTANT: Replace these with your own Google Cloud credentials
const CONFIG = {
  CLIENT_ID: '476818483706-f669f7s2nhfpc5m0onuluovoi9as0s5e.apps.googleusercontent.com',
  API_KEY: 'AIzaSyBRzaZR1DwlEMiN0L9j2mAZyxtqh6IzOiI',
  DISCOVERY_DOC: 'https://www.googleapis.com/discovery/v1/apis/drive/v3/rest',
  SCOPES:        'https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/drive.readonly https://www.googleapis.com/auth/drive.metadata.readonly',
};

// ─── STATE ──────────────────────────────────────────────────
let state = {
  gapiInited: false,
  gsiInited: false,
  tokenClient: null,
  user: null,
  currentFolder: 'root',
  folderStack: [{ id: 'root', name: '🏠 My Drive' }],
  allFiles: [],
  displayFiles: [],
  currentView: 'all',
  currentFilter: null,
  viewMode: 'grid', // 'grid' | 'list'
  searchQuery: '',
  sortBy: 'name',
  activeFileId: null,
  activeFileData: null,
};

// ─── GAPI / GSI INIT ────────────────────────────────────────
function gapiLoaded() {
  gapi.load('client', async () => {
    await gapi.client.init({
      apiKey: CONFIG.API_KEY,
      discoveryDocs: [CONFIG.DISCOVERY_DOC],
    });
    state.gapiInited = true;
    maybeEnableAuth();
  });
}

function gsiLoaded() {
  state.tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: CONFIG.CLIENT_ID,
    scope: CONFIG.SCOPES,
    callback: handleTokenResponse,
  });
  state.gsiInited = true;
  maybeEnableAuth();
}

function maybeEnableAuth() {
  if (state.gapiInited && state.gsiInited) {
    // Auto-restore session
    const saved = sessionStorage.getItem('sd_token');
    if (saved) {
      gapi.client.setToken(JSON.parse(saved));
      fetchUserProfile().then(() => showApp());
    }
  }
}

// ─── AUTH ────────────────────────────────────────────────────
function handleSignIn() {
  if (!state.gapiInited || !state.gsiInited) {
    showToast('⏳ Still loading Google APIs, please wait...', 'info');
    return;
  }
  state.tokenClient.requestAccessToken({ prompt: 'select_account' });
}

async function handleTokenResponse(resp) {
  if (resp.error) {
    showToast('❌ Sign-in failed: ' + resp.error, 'error');
    return;
  }
  sessionStorage.setItem('sd_token', JSON.stringify(gapi.client.getToken()));
  await fetchUserProfile();
  showApp();
}

async function fetchUserProfile() {
  try {
    const res = await gapi.client.drive.about.get({ fields: 'user,storageQuota' });
    const { user, storageQuota } = res.result;
    state.user = { ...user, storageQuota };

    // Update UI
    const avatar = document.getElementById('user-avatar');
    if (avatar && user.photoLink) avatar.src = user.photoLink;
    setEl('menu-user-name', user.displayName || '');
    setEl('menu-user-email', user.emailAddress || '');

    // Storage bar
    if (storageQuota) updateStorageUI(storageQuota);
  } catch (e) {
    console.error('Profile fetch failed', e);
  }
}

function updateStorageUI(q) {
  const used = parseInt(q.usageInDrive || 0);
  const total = parseInt(q.limit || 1);
  const pct = Math.min(100, Math.round((used / total) * 100));
  const usedGB = (used / 1e9).toFixed(2);
  const totalGB = (total / 1e9).toFixed(0);

  const bar = document.getElementById('storage-bar');
  if (bar) { setTimeout(() => { bar.style.width = pct + '%'; }, 300); }
  setEl('storage-text', `${usedGB} GB of ${totalGB} GB used`);
}

function handleSignOut() {
  const token = gapi.client.getToken();
  if (token) google.accounts.oauth2.revoke(token.access_token, () => { });
  gapi.client.setToken('');
  sessionStorage.removeItem('sd_token');
  state.user = null;
  state.allFiles = [];
  state.displayFiles = [];
  hideApp();
  showToast('👋 Signed out successfully', 'info');
}

// ─── SHOW/HIDE APP ──────────────────────────────────────────
function showApp() {
  document.getElementById('splash-screen').classList.add('hidden');
  document.getElementById('app').classList.remove('hidden');
  loadFiles();
}

function hideApp() {
  document.getElementById('splash-screen').classList.remove('hidden');
  document.getElementById('app').classList.add('hidden');
}

// ─── LOAD FILES ─────────────────────────────────────────────
async function loadFiles(folderId = null) {
  const folder = folderId || state.currentFolder;
  showLoading();

  try {
    let query = `'${folder}' in parents and trashed = false`;
    const res = await gapi.client.drive.files.list({
      q: query,
      fields: 'files(id,name,mimeType,size,modifiedTime,iconLink,thumbnailLink,webViewLink,webContentLink,starred,parents)',
      pageSize: 200,
      orderBy: 'folder,name',
    });

    state.allFiles = res.result.files || [];
    state.currentFolder = folder;
    state.currentFilter = null;
    state.searchQuery = '';
    clearSearchInput();

    applyFiltersAndSort();
    showToast(`📂 Loaded ${state.allFiles.length} items`, 'success');
  } catch (e) {
    console.error('Load files error', e);
    showToast('❌ Failed to load files. Check your API key & permissions.', 'error');
    hideLoading();
  }
}

async function loadRecentFiles() {
  showLoading();
  try {
    const res = await gapi.client.drive.files.list({
      q: 'trashed = false',
      orderBy: 'modifiedTime desc',
      pageSize: 60,
      fields: 'files(id,name,mimeType,size,modifiedTime,iconLink,thumbnailLink,webViewLink,webContentLink,starred)',
    });
    state.allFiles = res.result.files || [];
    applyFiltersAndSort();
  } catch (e) {
    showToast('❌ Failed to load recent files', 'error');
    hideLoading();
  }
}

async function loadStarredFiles() {
  showLoading();
  try {
    const res = await gapi.client.drive.files.list({
      q: 'starred = true and trashed = false',
      pageSize: 100,
      fields: 'files(id,name,mimeType,size,modifiedTime,iconLink,thumbnailLink,webViewLink,webContentLink,starred)',
    });
    state.allFiles = res.result.files || [];
    applyFiltersAndSort();
  } catch (e) {
    showToast('❌ Failed to load starred files', 'error');
    hideLoading();
  }
}

async function loadSharedFiles() {
  showLoading();
  try {
    const res = await gapi.client.drive.files.list({
      q: 'sharedWithMe = true and trashed = false',
      pageSize: 100,
      fields: 'files(id,name,mimeType,size,modifiedTime,iconLink,thumbnailLink,webViewLink,webContentLink,starred)',
    });
    state.allFiles = res.result.files || [];
    applyFiltersAndSort();
  } catch (e) {
    showToast('❌ Failed to load shared files', 'error');
    hideLoading();
  }
}

async function loadTrashFiles() {
  showLoading();
  try {
    const res = await gapi.client.drive.files.list({
      q: 'trashed = true',
      pageSize: 100,
      fields: 'files(id,name,mimeType,size,modifiedTime,iconLink,thumbnailLink,webViewLink,webContentLink,starred)',
    });
    state.allFiles = res.result.files || [];
    applyFiltersAndSort();
  } catch (e) {
    showToast('❌ Failed to load trash', 'error');
    hideLoading();
  }
}

function refreshFiles() {
  showToast('🔄 Refreshing...', 'info');
  const view = state.currentView;
  if (view === 'recent') { loadRecentFiles(); return; }
  if (view === 'starred') { loadStarredFiles(); return; }
  if (view === 'shared') { loadSharedFiles(); return; }
  if (view === 'trash') { loadTrashFiles(); return; }
  loadFiles(state.currentFolder);
}

// ─── NAVIGATION ─────────────────────────────────────────────
function navigateToFolder(file) {
  state.folderStack.push({ id: file.id, name: file.name });
  updateBreadcrumb();
  loadFiles(file.id);
}

function navigateToRoot() {
  state.folderStack = [{ id: 'root', name: '🏠 My Drive' }];
  updateBreadcrumb();
  loadFiles('root');
}

function navigateToBreadcrumb(index) {
  state.folderStack = state.folderStack.slice(0, index + 1);
  const folder = state.folderStack[state.folderStack.length - 1];
  updateBreadcrumb();
  loadFiles(folder.id);
}

function updateBreadcrumb() {
  const bc = document.getElementById('breadcrumb');
  if (!bc) return;
  bc.innerHTML = state.folderStack.map((f, i) => {
    const isLast = i === state.folderStack.length - 1;
    if (isLast) return `<span class="crumb active">${f.name}</span>`;
    return `<span class="crumb" onclick="navigateToBreadcrumb(${i})">${f.name}</span>`;
  }).join('');
}

// ─── VIEW SWITCHING ──────────────────────────────────────────
function switchView(view, el) {
  state.currentView = view;
  state.currentFilter = null;
  state.searchQuery = '';
  clearSearchInput();
  activateNavItem(el);

  // Reset breadcrumb and folder for folder views
  if (view === 'all') {
    state.folderStack = [{ id: 'root', name: '🏠 My Drive' }];
    updateBreadcrumb();
    loadFiles('root');
  } else if (view === 'recent') { updateBreadcrumb(); loadRecentFiles(); }
  else if (view === 'starred') { updateBreadcrumb(); loadStarredFiles(); }
  else if (view === 'shared') { updateBreadcrumb(); loadSharedFiles(); }
  else if (view === 'trash') { updateBreadcrumb(); loadTrashFiles(); }
}

function filterByType(type, el) {
  state.currentFilter = type;
  state.currentView = type;
  activateNavItem(el);

  // We load all files first, then filter
  showLoading();
  gapi.client.drive.files.list({
    q: 'trashed = false',
    pageSize: 200,
    fields: 'files(id,name,mimeType,size,modifiedTime,iconLink,thumbnailLink,webViewLink,webContentLink,starred)',
  }).then(res => {
    state.allFiles = res.result.files || [];
    applyFiltersAndSort();
  }).catch(() => {
    showToast('❌ Failed to filter files', 'error');
    hideLoading();
  });
}

function activateNavItem(el) {
  if (!el) return;
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  el.classList.add('active');
}

// ─── SEARCH ─────────────────────────────────────────────────
let searchTimer = null;
function handleSearch(query) {
  state.searchQuery = query.trim();
  const clearBtn = document.getElementById('search-clear');
  if (clearBtn) clearBtn.classList.toggle('hidden', !query);
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => applyFiltersAndSort(), 300);
}

function clearSearch() {
  state.searchQuery = '';
  const inp = document.getElementById('search-input');
  if (inp) inp.value = '';
  const clearBtn = document.getElementById('search-clear');
  if (clearBtn) clearBtn.classList.add('hidden');
  document.getElementById('search-results-state').classList.add('hidden');
  applyFiltersAndSort();
}

function clearSearchInput() {
  const inp = document.getElementById('search-input');
  if (inp) inp.value = '';
  const clr = document.getElementById('search-clear');
  if (clr) clr.classList.add('hidden');
  document.getElementById('search-results-state').classList.add('hidden');
}

// ─── FILTER + SORT ──────────────────────────────────────────
function applyFiltersAndSort() {
  let files = [...state.allFiles];

  // Type filter
  if (state.currentFilter) {
    files = files.filter(f => matchesTypeFilter(f, state.currentFilter));
  }

  // Search filter
  if (state.searchQuery) {
    const q = state.searchQuery.toLowerCase();
    files = files.filter(f => f.name.toLowerCase().includes(q));

    // Show search results banner
    const srState = document.getElementById('search-results-state');
    srState.classList.remove('hidden');
    setEl('search-query-label', `"${state.searchQuery}"`);
  } else {
    document.getElementById('search-results-state').classList.add('hidden');
  }

  // Sort
  files = sortFileList(files, state.sortBy);

  state.displayFiles = files;
  renderFiles(files);
}

function matchesTypeFilter(file, type) {
  const mime = file.mimeType || '';
  switch (type) {
    case 'docs': return mime.includes('document') || mime.includes('msword') || mime.includes('text');
    case 'sheets': return mime.includes('spreadsheet') || mime.includes('excel');
    case 'slides': return mime.includes('presentation') || mime.includes('powerpoint');
    case 'pdfs': return mime === 'application/pdf';
    case 'images': return mime.startsWith('image/');
    case 'videos': return mime.startsWith('video/');
    case 'folders': return mime === 'application/vnd.google-apps.folder';
    default: return true;
  }
}

function sortFiles(by) {
  state.sortBy = by;
  applyFiltersAndSort();
}

function sortFileList(files, by) {
  return [...files].sort((a, b) => {
    // Always folders first
    const af = a.mimeType === 'application/vnd.google-apps.folder';
    const bf = b.mimeType === 'application/vnd.google-apps.folder';
    if (af && !bf) return -1;
    if (!af && bf) return 1;

    switch (by) {
      case 'name': return a.name.localeCompare(b.name);
      case 'name-desc': return b.name.localeCompare(a.name);
      case 'date': return new Date(b.modifiedTime) - new Date(a.modifiedTime);
      case 'size': return parseInt(b.size || 0) - parseInt(a.size || 0);
      default: return a.name.localeCompare(b.name);
    }
  });
}

// ─── RENDER FILES ────────────────────────────────────────────
function renderFiles(files) {
  hideLoading();

  const grid = document.getElementById('file-grid');
  if (!grid) return;

  // Update count
  setEl('file-count-label', `${files.length} item${files.length !== 1 ? 's' : ''}`);

  if (files.length === 0) {
    grid.innerHTML = '';
    document.getElementById('empty-state').classList.remove('hidden');
    return;
  }
  document.getElementById('empty-state').classList.add('hidden');

  grid.innerHTML = files.map((f, i) => buildFileCard(f, i)).join('');
}

function buildFileCard(file, index) {
  const isFolder = file.mimeType === 'application/vnd.google-apps.folder';
  const icon = getFileIcon(file.mimeType);
  const meta = buildMeta(file);
  const starBadge = file.starred ? '<span class="star-badge">⭐</span>' : '';

  // In list view, wrap name and meta in .card-info
  return `
    <div class="file-card ${isFolder ? 'is-folder' : ''}"
         onclick="${isFolder ? `openFolder('${file.id}','${escHtml(file.name)}')` : `openPreview('${file.id}')`}"
         title="${escHtml(file.name)}"
         data-id="${file.id}">
      ${starBadge}
      <span class="card-icon">${icon}</span>
      <div class="card-info">
        <div class="card-name">${escHtml(file.name)}</div>
        <div class="card-meta">${meta}</div>
      </div>
      <div class="card-actions" onclick="event.stopPropagation()">
        ${!isFolder ? `
          <button class="card-action-btn" title="Open in Drive" onclick="openFileDirect('${file.webViewLink}')">🔗</button>
          <button class="card-action-btn" title="Download" onclick="downloadFileDirect('${file.id}','${escHtml(file.name)}')">⬇️</button>
        ` : ''}
        <button class="card-action-btn" title="${file.starred ? 'Unstar' : 'Star'}" onclick="toggleFileStar('${file.id}', ${!!file.starred}, this)">
          ${file.starred ? '⭐' : '☆'}
        </button>
      </div>
    </div>`;
}

function buildMeta(file) {
  const parts = [];
  if (file.size) parts.push(formatSize(parseInt(file.size)));
  if (file.modifiedTime) parts.push(timeAgo(file.modifiedTime));
  return parts.join(' · ');
}

function getFileIcon(mime) {
  if (!mime) return '📄';
  if (mime === 'application/vnd.google-apps.folder') return '📁';
  if (mime.includes('document') || mime.includes('msword')) return '📝';
  if (mime.includes('spreadsheet') || mime.includes('excel')) return '📊';
  if (mime.includes('presentation') || mime.includes('powerpoint')) return '📋';
  if (mime === 'application/pdf') return '📕';
  if (mime.startsWith('image/')) return '🖼️';
  if (mime.startsWith('video/')) return '🎬';
  if (mime.startsWith('audio/')) return '🎵';
  if (mime.includes('zip') || mime.includes('rar') || mime.includes('tar')) return '📦';
  if (mime.includes('text') || mime.includes('json') || mime.includes('xml')) return '📃';
  if (mime.includes('javascript') || mime.includes('python') || mime.includes('code')) return '💻';
  if (mime === 'application/vnd.google-apps.form') return '📋';
  if (mime === 'application/vnd.google-apps.drawing') return '🎨';
  if (mime === 'application/vnd.google-apps.site') return '🌐';
  return '📄';
}

function openFolder(id, name) {
  state.folderStack.push({ id, name });
  updateBreadcrumb();
  loadFiles(id);
}

// ─── FILE PREVIEW MODAL ─────────────────────────────────────
async function openPreview(fileId) {
  state.activeFileId = fileId;
  const file = state.allFiles.find(f => f.id === fileId);
  if (!file) return;
  state.activeFileData = file;

  // Fetch full metadata
  try {
    const res = await gapi.client.drive.files.get({
      fileId,
      fields: 'id,name,mimeType,size,modifiedTime,createdTime,webViewLink,webContentLink,starred,description,owners,thumbnailLink',
    });
    state.activeFileData = res.result;
  } catch (e) {
    console.warn('Could not fetch full metadata', e);
  }

  const f = state.activeFileData;
  setEl('modal-file-icon', getFileIcon(f.mimeType));
  setEl('modal-file-name', escHtml(f.name));
  setEl('modal-file-meta', formatMimeLabel(f.mimeType) + (f.size ? ' · ' + formatSize(parseInt(f.size)) : ''));

  // Update star button
  const starBtn = document.getElementById('modal-star-btn');
  if (starBtn) starBtn.textContent = f.starred ? '⭐ Unstar' : '☆ Star';

  // Build body content
  buildModalBody(f);

  document.getElementById('preview-modal').classList.remove('hidden');
}

function buildModalBody(f) {
  const body = document.getElementById('modal-body');
  let html = '';

  // Thumbnail for images
  if (f.mimeType && f.mimeType.startsWith('image/') && f.thumbnailLink) {
    html += `<img src="${f.thumbnailLink}" class="modal-preview-img" alt="Preview" />`;
  } else if (f.thumbnailLink) {
    html += `<img src="${f.thumbnailLink}" class="modal-preview-img" alt="Thumbnail" />`;
  }

  html += `<div class="modal-info-grid">`;

  html += infoItem('📌 Type', formatMimeLabel(f.mimeType));
  if (f.size) html += infoItem('📦 Size', formatSize(parseInt(f.size)));
  if (f.modifiedTime) html += infoItem('✏️ Modified', formatDate(f.modifiedTime));
  if (f.createdTime) html += infoItem('📅 Created', formatDate(f.createdTime));
  if (f.owners && f.owners.length) html += infoItem('👤 Owner', f.owners[0].displayName || '—');
  html += infoItem('⭐ Starred', f.starred ? 'Yes' : 'No');

  html += `</div>`;
  if (f.description) {
    html += `<div style="margin-top:16px;background:var(--bg-glass);border:1px solid var(--border-subtle);border-radius:10px;padding:14px 16px;">
      <div style="font-size:0.72rem;font-weight:700;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.06em;margin-bottom:6px;">📝 Description</div>
      <div style="font-size:0.88rem;color:var(--text-secondary)">${escHtml(f.description)}</div>
    </div>`;
  }

  body.innerHTML = html;
}

function infoItem(label, value) {
  return `<div class="modal-info-item"><label>${label}</label><span>${escHtml(String(value || '—'))}</span></div>`;
}

function closeModal() {
  document.getElementById('preview-modal').classList.add('hidden');
  state.activeFileId = null;
  state.activeFileData = null;
}

function closePreview(e) {
  if (e.target === document.getElementById('preview-modal')) closeModal();
}

function openInDrive() {
  if (state.activeFileData && state.activeFileData.webViewLink) {
    window.open(state.activeFileData.webViewLink, '_blank');
  }
}

function downloadFile() {
  if (!state.activeFileId) return;
  downloadFileDirect(state.activeFileId, state.activeFileData?.name || 'file');
}

function downloadFileDirect(fileId, name) {
  // For Google Workspace files, export; for others, download
  const file = state.allFiles.find(f => f.id === fileId) || state.activeFileData;
  if (!file) return;

  const gMime = file.mimeType || '';
  let url;

  if (gMime.includes('google-apps.document')) url = `https://docs.google.com/document/d/${fileId}/export?format=docx`;
  else if (gMime.includes('google-apps.spreadsheet')) url = `https://docs.google.com/spreadsheets/d/${fileId}/export?format=xlsx`;
  else if (gMime.includes('google-apps.presentation')) url = `https://docs.google.com/presentation/d/${fileId}/export/pptx`;
  else url = `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media&key=${CONFIG.API_KEY}`;

  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.target = '_blank';
  a.click();
  showToast(`⬇️ Downloading "${name}"`, 'success');
}

function openFileDirect(link) {
  if (link) window.open(link, '_blank');
}

// ─── STAR / UNSTAR ──────────────────────────────────────────
async function toggleStar() {
  if (!state.activeFileId) return;
  const starred = !state.activeFileData?.starred;
  try {
    await gapi.client.drive.files.update({
      fileId: state.activeFileId,
      resource: { starred },
    });
    if (state.activeFileData) state.activeFileData.starred = starred;
    const starBtn = document.getElementById('modal-star-btn');
    if (starBtn) starBtn.textContent = starred ? '⭐ Unstar' : '☆ Star';
    showToast(starred ? '⭐ File starred!' : '☆ File unstarred', 'success');
    // Update local data
    const f = state.allFiles.find(f => f.id === state.activeFileId);
    if (f) f.starred = starred;
  } catch (e) {
    showToast('❌ Could not update star', 'error');
  }
}

async function toggleFileStar(fileId, currentlyStarred, btn) {
  const starred = !currentlyStarred;
  try {
    await gapi.client.drive.files.update({ fileId, resource: { starred } });
    btn.textContent = starred ? '⭐' : '☆';
    const f = state.allFiles.find(f => f.id === fileId);
    if (f) f.starred = starred;
    showToast(starred ? '⭐ Starred!' : '☆ Unstarred', 'success');
    // Update star badge on card
    const card = document.querySelector(`.file-card[data-id="${fileId}"]`);
    if (card) {
      let badge = card.querySelector('.star-badge');
      if (starred) { if (!badge) { badge = document.createElement('span'); badge.className = 'star-badge'; card.prepend(badge); } badge.textContent = '⭐'; }
      else if (badge) badge.remove();
    }
  } catch (e) {
    showToast('❌ Could not update star', 'error');
  }
}

// ─── UPLOAD ─────────────────────────────────────────────────
function triggerUpload() {
  document.getElementById('file-input').click();
}

async function handleFileUpload(files) {
  if (!files || files.length === 0) return;
  const arr = Array.from(files);
  showToast(`⬆️ Uploading ${arr.length} file${arr.length > 1 ? 's' : ''}...`, 'info');

  for (const file of arr) {
    await uploadFile(file);
  }
  showToast('✅ Upload complete!', 'success');
  setTimeout(() => loadFiles(state.currentFolder), 1000);
}

async function uploadFile(file) {
  const metadata = {
    name: file.name,
    parents: [state.currentFolder],
  };

  const form = new FormData();
  form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
  form.append('file', file);

  const token = gapi.client.getToken();
  try {
    await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token.access_token}` },
      body: form,
    });
  } catch (e) {
    showToast(`❌ Failed to upload "${file.name}"`, 'error');
  }
}

// ─── DRAG & DROP ─────────────────────────────────────────────
function initDragDrop() {
  const main = document.querySelector('.main-content');
  const zone = document.getElementById('upload-zone');
  if (!main || !zone) return;

  ['dragenter', 'dragover'].forEach(ev => {
    main.addEventListener(ev, e => { e.preventDefault(); main.classList.add('drag-active'); });
    zone.addEventListener(ev, e => { e.preventDefault(); zone.classList.add('drag-over'); });
  });
  ['dragleave', 'dragend'].forEach(ev => {
    main.addEventListener(ev, () => main.classList.remove('drag-active'));
    zone.addEventListener(ev, () => zone.classList.remove('drag-over'));
  });
  main.addEventListener('drop', e => {
    e.preventDefault();
    main.classList.remove('drag-active');
    zone.classList.remove('drag-over');
    handleFileUpload(e.dataTransfer.files);
  });
  zone.addEventListener('drop', e => {
    e.preventDefault();
    zone.classList.remove('drag-over');
    handleFileUpload(e.dataTransfer.files);
  });
}

// ─── VIEW MODE ───────────────────────────────────────────────
function toggleViewMode() {
  state.viewMode = state.viewMode === 'grid' ? 'list' : 'grid';
  const grid = document.getElementById('file-grid');
  const icon = document.getElementById('view-toggle-icon');
  if (grid) {
    grid.classList.toggle('grid-view', state.viewMode === 'grid');
    grid.classList.toggle('list-view', state.viewMode === 'list');
  }
  if (icon) icon.textContent = state.viewMode === 'grid' ? '⊞' : '☰';
  showToast(state.viewMode === 'grid' ? '⊞ Grid view' : '☰ List view', 'info');
}

// ─── SIDEBAR TOGGLE ─────────────────────────────────────────
function toggleSidebar() {
  const sidebar = document.getElementById('sidebar');
  const overlay = document.getElementById('sidebar-overlay') || createOverlay();
  sidebar.classList.toggle('open');
  overlay.classList.toggle('active');
}

function createOverlay() {
  let el = document.createElement('div');
  el.id = 'sidebar-overlay';
  el.className = 'sidebar-overlay';
  el.onclick = toggleSidebar;
  document.body.appendChild(el);
  return el;
}

// ─── USER MENU ───────────────────────────────────────────────
function toggleUserMenu() {
  const menu = document.getElementById('user-menu');
  if (menu) menu.classList.toggle('hidden');
}
document.addEventListener('click', e => {
  const wrap = document.querySelector('.user-avatar-wrap');
  const menu = document.getElementById('user-menu');
  if (menu && wrap && !wrap.contains(e.target)) menu.classList.add('hidden');
});

// ─── LOADING STATES ─────────────────────────────────────────
function showLoading() {
  document.getElementById('loading-state').classList.remove('hidden');
  document.getElementById('empty-state').classList.add('hidden');
  document.getElementById('file-grid').innerHTML = '';
}

function hideLoading() {
  document.getElementById('loading-state').classList.add('hidden');
}

// ─── TOAST ──────────────────────────────────────────────────
function showToast(msg, type = 'info') {
  const container = document.getElementById('toast-container');
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.innerHTML = msg;
  container.appendChild(toast);
  setTimeout(() => {
    toast.style.animation = 'toastOut 0.3s ease forwards';
    setTimeout(() => toast.remove(), 300);
  }, 3500);
}

// ─── HELPERS ────────────────────────────────────────────────
function setEl(id, text) {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
}

function escHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatSize(bytes) {
  if (!bytes || bytes === 0) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (bytes >= 1024 && i < units.length - 1) { bytes /= 1024; i++; }
  return bytes.toFixed(i > 0 ? 1 : 0) + ' ' + units[i];
}

function formatDate(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}

function timeAgo(iso) {
  if (!iso) return '';
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);
  if (mins < 1) return 'Just now';
  if (mins < 60) return `${mins}m ago`;
  if (hours < 24) return `${hours}h ago`;
  if (days < 7) return `${days}d ago`;
  if (days < 30) return `${Math.floor(days / 7)}w ago`;
  return formatDate(iso);
}

function formatMimeLabel(mime) {
  if (!mime) return 'File';
  if (mime === 'application/vnd.google-apps.folder') return 'Folder';
  if (mime.includes('google-apps.document')) return 'Google Doc';
  if (mime.includes('google-apps.spreadsheet')) return 'Google Sheet';
  if (mime.includes('google-apps.presentation')) return 'Google Slides';
  if (mime.includes('google-apps.form')) return 'Google Form';
  if (mime.includes('google-apps.drawing')) return 'Google Drawing';
  if (mime === 'application/pdf') return 'PDF';
  if (mime.startsWith('image/')) return 'Image (' + mime.split('/')[1].toUpperCase() + ')';
  if (mime.startsWith('video/')) return 'Video';
  if (mime.startsWith('audio/')) return 'Audio';
  if (mime.includes('msword') || mime.includes('openxmlformats-officedocument.wordprocessingml')) return 'Word Document';
  if (mime.includes('excel') || mime.includes('spreadsheetml')) return 'Excel Spreadsheet';
  if (mime.includes('powerpoint') || mime.includes('presentationml')) return 'PowerPoint';
  if (mime.includes('zip')) return 'ZIP Archive';
  if (mime.startsWith('text/')) return 'Text File';
  return mime.split('/').pop().toUpperCase();
}

// ─── KEYBOARD SHORTCUTS ──────────────────────────────────────
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    if (!document.getElementById('preview-modal').classList.contains('hidden')) {
      closeModal();
    }
  }
  if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
    e.preventDefault();
    document.getElementById('search-input')?.focus();
  }
  if ((e.ctrlKey || e.metaKey) && e.key === 'u') {
    e.preventDefault();
    triggerUpload();
  }
});

// ─── INIT ────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  initDragDrop();

  // Initial breadcrumb
  updateBreadcrumb();

  // Keyboard shortcut hint
  const searchInput = document.getElementById('search-input');
  if (searchInput) {
    searchInput.setAttribute('placeholder', 'Search files... (Ctrl+K)');
  }
});
