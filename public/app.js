let state = {
  user: null, // { slug, name, is_super_admin }
  token: localStorage.getItem('vinyl_admin_token') || null,
  inviteToken: null,
  inviteLabel: null,
  currentSpace: localStorage.getItem('vinyl_current_space') || 'alex',
  spaces: [],
  currentTab: 'collection',
  mediaFilter: 'all', // 'all' | 'vinyl' | 'cd'
  vinyls: [],
  settings: { wall_rows: 2, wall_cols: 4, currency: '€', collection_title: '33T-Box' },
  selectionMode: false,
  selectedIds: new Set(),
  currentModalVinylId: null,
  currentModalTracks: [],
  currentModalArtist: '',
  currentModalTitle: '',
  currentModalCover: '',
  currentModalDeezerAlbumId: '',
  activeWallSlot: null,
  autoCompleteTimer: null,
  qrScanner: null
};

// Indique si l'utilisateur connecté a les droits d'écriture sur l'espace actuellement affiché
function canEditCurrentSpace() {
  if (!state.user) return false;
  if (state.user.is_super_admin) return true;
  return state.user.slug === state.currentSpace;
}

async function apiFetch(url, options = {}) {
  const headers = options.headers || {};
  if (state.token) headers['Authorization'] = `Bearer ${state.token}`;
  if (state.inviteToken) headers['X-Invite-Token'] = state.inviteToken;
  headers['X-Space'] = state.currentSpace;
  if (options.body && typeof options.body === 'object') {
    headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify({ ...options.body, space: state.currentSpace });
  }
  const sep = url.includes('?') ? '&' : '?';
  const fullUrl = url.startsWith('/api/vinyls') || url.startsWith('/api/settings') || url.startsWith('/api/backup')
    ? `${url}${sep}space=${encodeURIComponent(state.currentSpace)}`
    : url;

  const res = await fetch(fullUrl, { ...options, headers });
  if (res.status === 401 && !url.includes("/api/auth/login")) {
    if (state.user && !url.includes('/login')) logoutUser();
  }
  return res;
}

async function initApp() {
  const urlParams = new URLSearchParams(window.location.search);
  const urlInvite = urlParams.get('invite');
  if (urlInvite) {
    state.inviteToken = urlInvite.trim();
    localStorage.removeItem('vinyl_invite_token');
    window.history.replaceState({}, document.title, window.location.pathname);
  }

  const authRes = await apiFetch('/api/auth/check');
  const authData = await authRes.json();
  state.user = authData.authenticated ? authData.user : null;

  let hasInviteAccess = false;
  if (!state.user && state.inviteToken) {
    const invRes = await apiFetch('/api/auth/verify-invite');
    if (invRes.ok) {
      const invData = await invRes.json();
      hasInviteAccess = true;
      state.inviteLabel = invData.label;
    } else {
      state.inviteToken = null;
      localStorage.removeItem('vinyl_invite_token');
    }
  }

  if (!state.user && !hasInviteAccess) {
    document.getElementById('private-lock-screen').classList.remove('hidden');
    return;
  }

  document.getElementById('private-lock-screen').classList.add('hidden');
  await loadSpacesList();
  if (state.spaces && state.spaces.length > 0 && !state.spaces.some(s => s.slug === state.currentSpace)) {
    state.currentSpace = state.spaces[0].slug;
    localStorage.setItem('vinyl_current_space', state.currentSpace);
    const sel = document.getElementById('space-selector');
    if (sel) sel.value = state.currentSpace;
  }
  await loadPublicSettings();
  await loadVinyls();
  updateAdminUI();
  switchTab('collection');

  document.addEventListener('click', (e) => {
    const drop = document.getElementById('autocomplete-dropdown');
    if (drop && !drop.contains(e.target) && e.target.id !== 'v-artist' && e.target.id !== 'v-title') {
      drop.classList.add('hidden');
    }
  });
}

async function loadSpacesList() {
  const res = await apiFetch('/api/spaces');
  const data = await res.json();
  state.spaces = data.spaces || [];

  if (!state.spaces.some(s => s.slug === state.currentSpace)) {
    state.currentSpace = state.spaces[0] ? state.spaces[0].slug : 'alex';
  }

  const sel = document.getElementById('space-selector');
  sel.innerHTML = state.spaces.map(s => {
    const label = s.slug === 'alex' ? `👑 Espace ${s.name} (${s.counts.collection})` : `💿 Espace ${s.name} (${s.counts.collection})`;
    return `<option value="${s.slug}" ${s.slug === state.currentSpace ? 'selected' : ''}>${label}</option>`;
  }).join('');

  const loginSel = document.getElementById('login-slug');
  if (loginSel) {
    loginSel.innerHTML = state.spaces.map(s =>
      `<option value="${s.slug}" ${s.slug === state.currentSpace ? 'selected' : ''}>${s.name} (${s.slug})</option>`
    ).join('');
  }
}

async function switchSpace(newSpaceSlug) {
  state.currentSpace = newSpaceSlug;
  localStorage.setItem('vinyl_current_space', newSpaceSlug);
  state.selectionMode = false;
  state.selectedIds.clear();
  document.getElementById('bulk-toolbar').classList.add('hidden');

  await loadPublicSettings();
  await loadVinyls();
  updateAdminUI();
  if (state.currentTab === 'settings' && !canEditCurrentSpace()) {
    switchTab('collection');
  }
}

async function loadPublicSettings() {
  const res = await apiFetch('/api/settings/public');
  state.settings = await res.json();
  populateWallSlotsSelect();
  if ((state.currentTab === "users" && !isSuper) || (state.currentTab === "settings" && !canEdit)) { switchTab("collection"); return; }
  syncWallDirectSelects();
}

async function loadVinyls() {
  const res = await apiFetch('/api/vinyls');
  state.vinyls = await res.json();
  updateTabCounts();
  populateGenreFilter();
  renderVinyls();
  renderWall();
  renderStats();
}

function updateTabCounts() {
  const colCount = state.vinyls.filter(v => v.status === 'collection').length;
  const wishCount = state.vinyls.filter(v => v.status === 'wishlist').length;
  document.getElementById('badge-count-col').textContent = `(${colCount})`;
  document.getElementById('badge-count-wish').textContent = `(${wishCount})`;
}

function updateAdminUI() {
  const badge = document.getElementById('role-badge');
  const btnAddVinyl = document.getElementById('btn-add-vinyl');
  const btnLogin = document.getElementById('btn-login');
  const btnLogout = document.getElementById('btn-logout');
  const tabSettings = document.getElementById('tab-settings');
  const tabUsers = document.getElementById('tab-users');
  const btnToggleSelect = document.getElementById('btn-toggle-select');

  const canEdit = canEditCurrentSpace();
  const isSuper = Boolean(state.user && state.user.is_super_admin);
  const spaceObj = state.spaces.find(s => s.slug === state.currentSpace);
  const spaceName = spaceObj ? spaceObj.name : state.currentSpace;

  if (state.user) {
    btnLogin.classList.add('hidden');
    btnLogout.classList.remove('hidden');
    if (canEdit) {
      badge.textContent = `Connecté : ${state.user.name} · Édition active (${spaceName})`;
      badge.className = 'text-[11px] px-2 py-0.5 rounded bg-amber-500/20 text-amber-300 border border-amber-500/40 font-semibold inline-block';
    } else {
      badge.textContent = `Connecté : ${state.user.name} · Visite chez ${spaceName} (Lecture)`;
      badge.className = 'text-[11px] px-2 py-0.5 rounded bg-sky-500/20 text-sky-300 border border-sky-500/40 font-semibold inline-block';
    }
  } else {
    btnLogin.classList.remove('hidden');
    btnLogout.classList.add('hidden');
    badge.textContent = state.inviteLabel ? `Invité (${state.inviteLabel}) · Lecture seule` : `Visite chez ${spaceName} (Lecture)`;
    badge.className = 'text-[11px] px-2 py-0.5 rounded bg-slate-800 text-slate-400 border border-slate-700 inline-block';
  }

  btnAddVinyl.classList.toggle('hidden', !canEdit);
  tabSettings.classList.toggle('hidden', !canEdit);
  btnToggleSelect.classList.toggle('hidden', !canEdit);
  tabUsers.classList.toggle('hidden', !isSuper);

  if (!canEdit) {
    state.selectionMode = false;
    document.getElementById('bulk-toolbar').classList.add('hidden');
  }

  syncWallDirectSelects();
  renderVinyls();
  renderWall();
}

// Changement d'onglet avec REMISE À ZÉRO AUTOMATIQUE des filtres (Recherche, Support, Genre, Tri) entre Disques et Wishlist
function switchTab(tab) {
  const prevTab = state.currentTab;
  state.currentTab = tab;

  if ((prevTab === 'collection' && tab === 'wishlist') || (prevTab === 'wishlist' && tab === 'collection') || tab === 'collection' || tab === 'wishlist') {
    const searchEl = document.getElementById('search-input');
    const genreEl = document.getElementById('filter-genre');
    const sortEl = document.getElementById('sort-by');
    if (searchEl) searchEl.value = '';
    if (genreEl) genreEl.value = '';
    if (sortEl) sortEl.value = 'artist';
    setMediaFilter('all', false);
    populateGenreFilter();
  }

  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.classList.remove('bg-amber-500', 'text-slate-950', 'font-bold');
    btn.classList.add('text-slate-300', 'hover:text-white');
  });
  const activeBtn = document.getElementById(`tab-${tab}`);
  if (activeBtn) {
    activeBtn.classList.add('bg-amber-500', 'text-slate-950', 'font-bold');
    activeBtn.classList.remove('text-slate-300');
  }

  document.getElementById('view-vinyls').classList.toggle('hidden', tab !== 'collection' && tab !== 'wishlist');
  document.getElementById('view-wall').classList.toggle('hidden', tab !== 'wall');
  document.getElementById('view-stats').classList.toggle('hidden', tab !== 'stats');
  document.getElementById('view-users').classList.toggle('hidden', tab !== 'users');
  document.getElementById('view-settings').classList.toggle('hidden', tab !== 'settings');

  if (tab === 'collection' || tab === 'wishlist') renderVinyls();
  if (tab === 'wall') renderWall();
  if (tab === 'stats') renderStats();
  if (tab === 'users' && state.user && state.user.is_super_admin) renderUsersManagement();
  if (tab === 'settings') { renderMemberInvitesList(); if (canEditCurrentSpace()) loadAdminSettingsForm(); }
}

function setMediaFilter(type, shouldRender = true) {
  state.mediaFilter = type;
  ['all', 'vinyl', 'cd'].forEach(k => {
    const btn = document.getElementById(`media-btn-${k}`);
    if (!btn) return;
    if (k === type) {
      btn.className = 'px-3 py-1.5 rounded-md text-xs font-bold bg-amber-500 text-slate-950 transition';
    } else {
      btn.className = 'px-3 py-1.5 rounded-md text-xs font-medium text-slate-300 hover:text-white transition';
    }
  });
  if (shouldRender) renderVinyls();
}

function clearSearchInput() {
  document.getElementById('search-input').value = '';
  renderVinyls();
}

function populateGenreFilter() {
  const select = document.getElementById('filter-genre');
  if (!select) return;
  const current = select.value;
  const targetStatus = state.currentTab === 'wishlist' ? 'wishlist' : 'collection';
  const genres = new Set();
  state.vinyls.filter(v => v.status === targetStatus).forEach(v => {
    if (v.genre) v.genre.split(',').forEach(g => genres.add(g.trim()));
  });
  select.innerHTML = '<option value="">Tous les genres</option>';
  [...genres].sort().forEach(g => {
    if (!g) return;
    const opt = document.createElement('option');
    opt.value = g;
    opt.textContent = g;
    select.appendChild(opt);
  });
  if ([...genres].includes(current)) select.value = current;
}

function getCoverSrc(v) {
  if (v.cover_local) return v.cover_local;
  if (v.cover_url) return v.cover_url;
  return '';
}

function parseTracks(v) {
  try {
    const arr = typeof v.tracklist === 'string' ? JSON.parse(v.tracklist || '[]') : (v.tracklist || []);
    return Array.isArray(arr) ? arr : [];
  } catch (e) {
    return [];
  }
}

function findMatchingTrack(v, q) {
  if (!q || q.length < 2) return null;
  const tracks = parseTracks(v);
  return tracks.find(t => (t.title || '').toLowerCase().includes(q));
}

function renderVinyls() {
  const grid = document.getElementById('vinyls-grid');
  const q = (document.getElementById('search-input').value || '').trim().toLowerCase();
  const genreFilter = document.getElementById('filter-genre').value;
  const sortBy = document.getElementById('sort-by').value;
  const targetStatus = state.currentTab === 'wishlist' ? 'wishlist' : 'collection';
  const canEdit = canEditCurrentSpace();

  let list = state.vinyls.filter(v => v.status === targetStatus);

  // Filtre Support (Tous / Vinyles / CD)
  if (state.mediaFilter !== 'all') {
    list = list.filter(v => (v.media_type || 'vinyl') === state.mediaFilter);
  }

  if (q) {
    list = list.filter(v => {
      const inMeta =
        (v.title || '').toLowerCase().includes(q) ||
        (v.artist || '').toLowerCase().includes(q) ||
        (v.label || '').toLowerCase().includes(q) ||
        (v.barcode || '').toLowerCase().includes(q) ||
        (v.notes || '').toLowerCase().includes(q);
      const inTracks = Boolean(findMatchingTrack(v, q));
      return inMeta || inTracks;
    });
  }

  if (genreFilter) {
    list = list.filter(v => (v.genre || '').toLowerCase().includes(genreFilter.toLowerCase()));
  }

  list.sort((a, b) => {
    if (sortBy === 'year_desc') return (b.year || 0) - (a.year || 0);
    if (sortBy === 'year_asc') return (a.year || 9999) - (b.year || 9999);
    if (sortBy === 'price_desc') return (b.purchase_price || 0) - (a.purchase_price || 0);
    if (sortBy === 'recent') return b.id - a.id;
    return (a.artist || '').localeCompare(b.artist || '');
  });

  if (list.length === 0) {
    grid.innerHTML = `<div class="col-span-full text-center py-12 text-slate-500 text-sm">Aucun disque trouvé dans cet onglet.</div>`;
    return;
  }

  grid.innerHTML = list.map(v => {
    const cover = getCoverSrc(v);
    const isChecked = state.selectedIds.has(v.id);
    const matchedTrack = q ? findMatchingTrack(v, q) : null;
    const tracks = parseTracks(v);
    const tracksCount = tracks.length;
    const isCd = v.media_type === 'cd';

    const mediaBadge = isCd
      ? `<span class="bg-sky-500/90 text-slate-950 text-[10px] font-extrabold px-1.5 py-0.5 rounded shadow">💿 CD</span>`
      : `<span class="bg-amber-500/90 text-slate-950 text-[10px] font-extrabold px-1.5 py-0.5 rounded shadow">⚫ 33T</span>`;

    const wallBadge = v.wall_slot
      ? `<span class="bg-emerald-400 text-slate-950 text-[10px] font-extrabold px-1.5 py-0.5 rounded shadow">Mur ${v.wall_slot}</span>`
      : '';

    const selectOverlay = state.selectionMode
      ? `<div onclick="event.stopPropagation(); toggleSelectVinyl(${v.id})" class="absolute top-2 right-2 z-10 w-6 h-6 rounded-md border-2 ${isChecked ? 'bg-amber-500 border-amber-500 text-slate-950' : 'bg-slate-950/80 border-slate-400 text-transparent'} flex items-center justify-center font-bold text-sm shadow">✓</div>`
      : '';

    const quickAcquireBtn = (canEdit && v.status === 'wishlist' && !state.selectionMode)
      ? `<button onclick="event.stopPropagation(); quickAcquireFromCard(${v.id})" title="Basculer dans ma Collection" class="mt-2 w-full bg-emerald-500/15 hover:bg-emerald-500 hover:text-slate-950 text-emerald-300 border border-emerald-500/40 rounded-lg py-1 text-[11px] font-bold transition">✓ Acheté / Acquis</button>`
      : '';

    const placeholderDisc = isCd
      ? `<div class="w-20 h-20 rounded-full cd-shine border border-slate-400 flex items-center justify-center"><div class="w-6 h-6 rounded-full bg-slate-950 border border-slate-500"></div></div>`
      : `<div class="w-20 h-20 rounded-full vinyl-groove border border-slate-700 flex items-center justify-center"><div class="w-5 h-5 rounded-full bg-amber-500/80"></div></div>`;

    return `
      <div onclick="${state.selectionMode ? `toggleSelectVinyl(${v.id})` : `openVinylModal(${v.id})`}"
        class="group cursor-pointer bg-slate-900 rounded-xl border ${isChecked ? 'border-amber-500 ring-2 ring-amber-500/40' : 'border-slate-800 hover:border-amber-500/60'} overflow-hidden transition flex flex-col shadow">
        <div class="relative aspect-square bg-slate-950 flex items-center justify-center overflow-hidden">
          ${cover
            ? `<img src="${cover}" alt="${v.title}" referrerpolicy="no-referrer" class="w-full h-full object-cover group-hover:scale-105 transition duration-300" onerror="this.style.display='none'" />`
            : placeholderDisc
          }
          <div class="absolute top-2 left-2 flex flex-wrap gap-1">
            ${mediaBadge}
            ${wallBadge}
          </div>
          ${selectOverlay}
          <div class="absolute bottom-1.5 right-1.5 flex items-center gap-1">
            ${tracksCount > 0 ? `<span class="bg-slate-950/85 text-amber-400 text-[10px] px-1.5 py-0.5 rounded border border-slate-700">🎵 ${tracksCount}</span>` : ''}
            <span class="bg-slate-950/85 text-slate-200 text-[10px] px-1.5 py-0.5 rounded border border-slate-700">${v.condition_media || 'NM'}</span>
          </div>
        </div>
        <div class="p-2.5 sm:p-3 flex-1 flex flex-col justify-between">
          <div>
            <div class="text-[11px] text-amber-400 font-semibold truncate">${v.artist}</div>
            <div class="text-xs sm:text-sm font-bold text-white truncate">${v.title}</div>
            ${matchedTrack ? `<div class="mt-1 text-[10px] bg-amber-500/20 text-amber-300 px-1.5 py-0.5 rounded truncate">🎵 ${matchedTrack.position ? matchedTrack.position + ' · ' : ''}${matchedTrack.title}</div>` : ''}
          </div>
          <div>
            <div class="mt-2 pt-1.5 border-t border-slate-800/80 flex items-center justify-between text-[11px] text-slate-400">
              <span>${v.year || v.release_year || '—'}</span>
              <span class="font-medium text-slate-300">${v.purchase_price ? v.purchase_price.toFixed(2) + ' ' + state.settings.currency : ''}</span>
            </div>
            ${quickAcquireBtn}
          </div>
        </div>
      </div>
    `;
  }).join('');
}

// --- SÉLECTION MULTIPLE & RÉGÉNÉRATION EN MASSE ---
function toggleSelectionMode() {
  state.selectionMode = !state.selectionMode;
  state.selectedIds.clear();
  document.getElementById('bulk-toolbar').classList.toggle('hidden', !state.selectionMode);
  updateSelectedCountLabel();
  renderVinyls();
}

function toggleSelectVinyl(id) {
  if (state.selectedIds.has(id)) state.selectedIds.delete(id);
  else state.selectedIds.add(id);
  updateSelectedCountLabel();
  renderVinyls();
}

function updateSelectedCountLabel() {
  document.getElementById('selected-count-label').textContent = `${state.selectedIds.size} sélectionné(s)`;
}

function selectMissingCoversOrTracks() {
  const targetStatus = state.currentTab === 'wishlist' ? 'wishlist' : 'collection';
  state.vinyls.filter(v => v.status === targetStatus).forEach(v => {
    const noCover = !v.cover_local;
    const tracks = parseTracks(v);
    const noTracksOrNoDeezer = tracks.length === 0 || !tracks.some(t => t.preview_url);
    if (noCover || noTracksOrNoDeezer) state.selectedIds.add(v.id);
  });
  updateSelectedCountLabel();
  renderVinyls();
}

function selectAllVisible() {
  const targetStatus = state.currentTab === 'wishlist' ? 'wishlist' : 'collection';
  state.vinyls.filter(v => v.status === targetStatus).forEach(v => state.selectedIds.add(v.id));
  updateSelectedCountLabel();
  renderVinyls();
}

function clearSelection() {
  state.selectedIds.clear();
  updateSelectedCountLabel();
  renderVinyls();
}

async function runBulkRegenerate() {
  const ids = Array.from(state.selectedIds);
  if (ids.length === 0) {
    alert("Coche d'abord un ou plusieurs disques.");
    return;
  }

  const progBox = document.getElementById('regen-progress-box');
  const progBar = document.getElementById('regen-progress-bar');
  const statusText = document.getElementById('regen-status-text');
  const statusPct = document.getElementById('regen-status-pct');
  const btnRun = document.getElementById('btn-run-regen');

  progBox.classList.remove('hidden');
  btnRun.disabled = true;
  btnRun.classList.add('opacity-50');

  for (let i = 0; i < ids.length; i++) {
    const id = ids[i];
    const v = state.vinyls.find(x => x.id === id);
    const pct = Math.round(((i + 1) / ids.length) * 100);
    statusText.textContent = `[${i + 1}/${ids.length}] Pochette, pistes & audio Deezer : ${v ? v.artist + ' - ' + v.title : '#' + id}...`;
    statusPct.textContent = `${pct}%`;
    progBar.style.width = `${pct}%`;

    try {
      const res = await apiFetch(`/api/vinyls/${id}/regenerate`, { method: 'POST', body: {} });
      if (res.ok) {
        const data = await res.json();
        const idx = state.vinyls.findIndex(x => x.id === id);
        if (idx !== -1 && data.vinyl) state.vinyls[idx] = data.vinyl;
        renderVinyls();
      }
    } catch (e) {}

    await new Promise(r => setTimeout(r, 750));
  }

  statusText.textContent = `Terminé ! ${ids.length} disque(s) enrichi(s) avec pochettes et pistes Deezer.`;
  btnRun.disabled = false;
  btnRun.classList.remove('opacity-50');
  setTimeout(() => { progBox.classList.add('hidden'); }, 4000);
}

// --- LECTEUR AUDIO DEEZER (EXTRAIT 30S + OUVERTURE APP DEEZER COMPLÈTE) ---
async function playTrackOnDeezer(idx) {
  const track = state.currentModalTracks[idx];
  if (!track) return;

  const artist = state.currentModalArtist || document.getElementById('v-artist').value || '';
  const album = state.currentModalTitle || document.getElementById('v-title').value || '';

  let previewUrl = track.preview_url || '';
  let deezerLink = track.deezer_link || '';

  // Si la piste n'a pas encore de lien preview Deezer en base, on interroge Deezer en direct
  if (!previewUrl) {
    const res = await fetch(`/api/deezer/track?artist=${encodeURIComponent(artist)}&track=${encodeURIComponent(track.title)}&album=${encodeURIComponent(album)}`);
    const data = await res.json();
    if (data.found) {
      previewUrl = data.preview_url || '';
      deezerLink = data.deezer_link || '';
      track.preview_url = previewUrl;
      track.deezer_link = deezerLink;
      track.deezer_id = data.deezer_id || '';
    }
  }

  if (!previewUrl) {
    alert(`Aucun extrait audio trouvé sur Deezer pour "${track.title}". Tu peux cliquer sur 🎧 pour l'ouvrir dans l'app Deezer.`);
    return;
  }

  const bar = document.getElementById('deezer-player-bar');
  const audio = document.getElementById('dz-audio-element');
  document.getElementById('dz-bar-title').textContent = track.title;
  document.getElementById('dz-bar-artist').textContent = `${artist} — ${album}`;
  document.getElementById('dz-bar-cover').src = state.currentModalCover || '/logo.jpg';

  const appLink = document.getElementById('dz-bar-app-link');
  appLink.href = deezerLink || `https://www.deezer.com/search/${encodeURIComponent(artist + ' ' + track.title)}`;

  bar.classList.remove('hidden');
  audio.src = previewUrl;
  audio.play().catch(() => {});
}

function closeDeezerPlayerBar() {
  const audio = document.getElementById('dz-audio-element');
  audio.pause();
  audio.src = '';
  document.getElementById('deezer-player-bar').classList.add('hidden');
}

async function openAlbumInDeezer() {
  const artist = state.currentModalArtist || document.getElementById('v-artist').value.trim();
  const title = state.currentModalTitle || document.getElementById('v-title').value.trim();
  const dzAlbumId = state.currentModalDeezerAlbumId || document.getElementById('v-deezer-album-id').value.trim();

  if (dzAlbumId) {
    window.open(`https://www.deezer.com/album/${dzAlbumId}`, '_blank');
    return;
  }
  const q = encodeURIComponent(`${artist} ${title}`.trim());
  window.open(`https://www.deezer.com/search/${q}`, '_blank');
}

// --- COPIER UN DISQUE D'UN AMI VERS MON ESPACE ---
async function copyCurrentVinylToMySpace() {
  if (!state.user || !state.currentModalVinylId) return;
  const choice = confirm(`Copier cet album dans ta Wishlist personnelle (${state.user.name}) ?\n(Annuler = ne rien faire)`);
  if (!choice) return;

  const res = await fetch('/api/vinyls/copy-to-my-space', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${state.token}`
    },
    body: JSON.stringify({
      from_space: state.currentSpace,
      vinyl_id: state.currentModalVinylId,
      target_status: 'wishlist'
    })
  });
  if (res.ok) {
    await loadSpacesList();
    alert(`Album copié dans la Wishlist de ton espace (${state.user.name}) !`);
  } else {
    const err = await res.json();
    alert(err.error || 'Erreur lors de la copie');
  }
}

// --- BASCULE RAPIDE WISHLIST -> COLLECTION ---
async function quickAcquireFromCard(id) {
  const v = state.vinyls.find(x => x.id === id);
  if (!v) return;
  const priceStr = prompt(`Basculer "${v.artist} - ${v.title}" dans ta Collection !\n\nPrix payé (€) :`, v.purchase_price || v.target_price || '');
  if (priceStr === null) return;
  const locStr = prompt(`Lieu d'achat (ex: Disquaire, Fnac, Brocante...) :`, 'Disquaire');
  if (locStr === null) return;

  const cleanNotes = (v.notes || '').replace('[À acheter]', '[Acquis]').replace('[À rechercher]', '[Acquis]');
  const res = await apiFetch(`/api/vinyls/${id}`, {
    method: 'PUT',
    body: {
      status: 'collection',
      purchase_price: parseFloat(priceStr) || 0,
      purchase_location: locStr || 'Collection',
      notes: cleanNotes
    }
  });
  if (res.ok) {
    await loadSpacesList();
    await loadVinyls();
  }
}

function switchModalVinylToCollection() {
  document.getElementById('v-status').value = 'collection';
  const locInput = document.getElementById('v-location');
  if (locInput.value.startsWith('À ')) locInput.value = 'Acheté / Collection';
  document.getElementById('wishlist-acquire-banner').classList.add('hidden');
}

// --- MUR D'EXPOSITION ---
function syncWallDirectSelects() {
  const rSel = document.getElementById('wall-rows-direct');
  const cSel = document.getElementById('wall-cols-direct');
  if (!rSel || !cSel) return;
  const canEdit = canEditCurrentSpace();
  rSel.value = String(state.settings.wall_rows || 2);
  cSel.value = String(state.settings.wall_cols || 4);
  rSel.disabled = !canEdit;
  cSel.disabled = !canEdit;
}

async function updateWallDimensionsDirect() {
  if (!canEditCurrentSpace()) return;
  const rows = parseInt(document.getElementById('wall-rows-direct').value, 10) || 2;
  const cols = parseInt(document.getElementById('wall-cols-direct').value, 10) || 4;
  state.settings.wall_rows = rows;
  state.settings.wall_cols = cols;
  populateWallSlotsSelect();
  renderWall();
  await apiFetch('/api/settings', { method: 'PUT', body: { wall_rows: rows, wall_cols: cols } });
}

function populateWallSlotsSelect() {
  const sel = document.getElementById('v-wall-slot');
  if (!sel) return;
  const rows = state.settings.wall_rows || 2;
  const cols = state.settings.wall_cols || 4;
  sel.innerHTML = '<option value="">Non exposé</option>';
  for (let r = 1; r <= rows; r++) {
    for (let c = 1; c <= cols; c++) {
      const code = `R${r}-C${c}`;
      const opt = document.createElement('option');
      opt.value = code;
      opt.textContent = `Cadre Ligne ${r} - Col ${c} (${code})`;
      sel.appendChild(opt);
    }
  }
}

function renderWall() {
  const rows = state.settings.wall_rows || 2;
  const cols = state.settings.wall_cols || 4;
  const canEdit = canEditCurrentSpace();
  const totalEl = document.getElementById('wall-total-frames');
  if (totalEl) totalEl.textContent = `(${rows * cols} cadres)`;

  const matrix = document.getElementById('wall-matrix');
  matrix.style.gridTemplateColumns = `repeat(${cols}, minmax(120px, 210px))`;

  let html = '';
  for (let r = 1; r <= rows; r++) {
    for (let c = 1; c <= cols; c++) {
      const slot = `R${r}-C${c}`;
      const vinyl = state.vinyls.find(v => v.wall_slot === slot);
      if (vinyl) {
        const cover = getCoverSrc(vinyl);
        html += `
          <div onclick="handleWallSlotClick('${slot}', ${vinyl.id})" class="w-full aspect-square bg-slate-900 rounded-xl p-2 border-4 border-slate-800 shadow-2xl cursor-pointer hover:border-amber-500 transition relative group">
            ${cover
              ? `<img src="${cover}" referrerpolicy="no-referrer" class="w-full h-full object-cover rounded-lg" />`
              : `<div class="w-full h-full flex items-center justify-center text-center p-2 text-xs text-slate-300 font-bold">${vinyl.artist}<br>${vinyl.title}</div>`
            }
            <div class="absolute inset-0 bg-black/75 opacity-0 group-hover:opacity-100 transition flex flex-col items-center justify-center p-3 text-center rounded-lg">
              <span class="text-[11px] text-amber-400 font-bold">${slot}</span>
              <span class="text-xs sm:text-sm font-bold text-white mt-1 line-clamp-2">${vinyl.title}</span>
              <span class="text-xs text-slate-300">${vinyl.artist}</span>
              <span class="mt-2 text-[10px] bg-amber-500 text-slate-950 font-bold px-2 py-0.5 rounded">${canEdit ? 'Changer de disque' : 'Voir & Écouter'}</span>
            </div>
          </div>
        `;
      } else {
        html += `
          <div onclick="handleWallSlotClick('${slot}', null)" class="w-full aspect-square bg-slate-900/40 rounded-xl border-2 border-dashed border-slate-800 flex flex-col items-center justify-center p-3 text-slate-500 ${canEdit ? 'cursor-pointer hover:border-amber-500/60 hover:text-amber-400' : ''} transition">
            <span class="text-xs font-mono font-bold">${slot}</span>
            <span class="text-[11px] mt-1 text-center">${canEdit ? '+ Choisir un disque' : 'Cadre libre'}</span>
          </div>
        `;
      }
    }
  }
  matrix.innerHTML = html;
}

function handleWallSlotClick(slot, currentVinylId) {
  if (!canEditCurrentSpace()) {
    if (currentVinylId) openVinylModal(currentVinylId);
    return;
  }
  state.activeWallSlot = slot;
  document.getElementById('wall-picker-title').textContent = `Choisir le disque pour le cadre ${slot}`;
  document.getElementById('wall-picker-search').value = '';
  renderWallPickerList();
  document.getElementById('modal-wall-picker').classList.remove('hidden');
  document.getElementById('modal-wall-picker').classList.add('flex');
}

function closeWallPickerModal() {
  document.getElementById('modal-wall-picker').classList.add('hidden');
  document.getElementById('modal-wall-picker').classList.remove('flex');
}

function renderWallPickerList() {
  const q = (document.getElementById('wall-picker-search').value || '').toLowerCase();
  const grid = document.getElementById('wall-picker-grid');
  let list = state.vinyls.filter(v =>
    (v.artist || '').toLowerCase().includes(q) ||
    (v.title || '').toLowerCase().includes(q)
  );
  list.sort((a, b) => {
    if (a.status !== b.status) return a.status === 'collection' ? -1 : 1;
    return (a.artist || '').localeCompare(b.artist || '');
  });

  grid.innerHTML = list.map(v => {
    const cover = getCoverSrc(v);
    return `
      <div onclick="assignVinylToActiveWallSlot(${v.id})" class="cursor-pointer bg-slate-950 hover:bg-slate-800 border border-slate-800 hover:border-amber-500 rounded-xl p-2 flex items-center gap-2.5 transition">
        <div class="w-12 h-12 rounded bg-slate-900 flex-shrink-0 overflow-hidden flex items-center justify-center">
          ${cover ? `<img src="${cover}" referrerpolicy="no-referrer" class="w-full h-full object-cover" />` : `<span class="text-xs">💿</span>`}
        </div>
        <div class="min-w-0 flex-1">
          <div class="text-[11px] text-amber-400 font-semibold truncate">${v.artist}</div>
          <div class="text-xs font-bold text-white truncate">${v.title}</div>
          <div class="text-[10px] text-slate-500">${v.media_type === 'cd' ? 'CD' : 'Vinyle'} · ${v.status === 'collection' ? 'Collection' : 'Wishlist'}</div>
        </div>
      </div>
    `;
  }).join('');
}

async function assignVinylToActiveWallSlot(vinylId) {
  if (!state.activeWallSlot) return;
  await apiFetch(`/api/vinyls/${vinylId}`, { method: 'PUT', body: { wall_slot: state.activeWallSlot } });
  closeWallPickerModal();
  await loadVinyls();
}

async function clearWallSlotFromPicker() {
  if (!state.activeWallSlot) return;
  const current = state.vinyls.find(v => v.wall_slot === state.activeWallSlot);
  if (current) {
    await apiFetch(`/api/vinyls/${current.id}`, { method: 'PUT', body: { wall_slot: null } });
  }
  closeWallPickerModal();
  await loadVinyls();
}

// --- STATISTIQUES & BUDGET (VINYLES + CD) ---
function renderStats() {
  const col = state.vinyls.filter(v => v.status === 'collection');
  const wish = state.vinyls.filter(v => v.status === 'wishlist');
  const colVinyls = col.filter(v => (v.media_type || 'vinyl') === 'vinyl');
  const colCds = col.filter(v => v.media_type === 'cd');
  const colSpent = col.reduce((acc, v) => acc + (v.purchase_price || 0), 0);
  const wishBudget = wish.reduce((acc, v) => acc + (v.purchase_price || v.target_price || 0), 0);
  const withTracks = state.vinyls.filter(v => parseTracks(v).length > 0).length;
  const cur = state.settings.currency || '€';

  document.getElementById('stats-kpi').innerHTML = `
    <div class="bg-slate-900 p-4 rounded-xl border border-slate-800">
      <div class="text-xs text-slate-400">Total Collection</div>
      <div class="text-2xl font-extrabold text-white mt-1">${col.length}</div>
      <div class="text-[11px] text-emerald-400 mt-1">Valeur : ${colSpent.toFixed(2)} ${cur}</div>
    </div>
    <div class="bg-slate-900 p-4 rounded-xl border border-slate-800">
      <div class="text-xs text-slate-400">Supports en Collection</div>
      <div class="text-lg font-extrabold text-amber-400 mt-1">⚫ ${colVinyls.length} Vinyles · <span class="text-sky-400">💿 ${colCds.length} CD</span></div>
      <div class="text-[11px] text-slate-400 mt-1">Pochettes HD : ${state.vinyls.filter(v => v.cover_local).length}/${state.vinyls.length}</div>
    </div>
    <div class="bg-slate-900 p-4 rounded-xl border border-slate-800">
      <div class="text-xs text-slate-400">Disques en Wishlist</div>
      <div class="text-2xl font-extrabold text-amber-400 mt-1">${wish.length}</div>
      <div class="text-[11px] text-slate-400 mt-1">Budget estimé : ${wishBudget.toFixed(2)} ${cur}</div>
    </div>
    <div class="bg-slate-900 p-4 rounded-xl border border-slate-800">
      <div class="text-xs text-slate-400">Pistes & Audio Deezer</div>
      <div class="text-2xl font-extrabold text-purple-400 mt-1">${withTracks} / ${state.vinyls.length}</div>
      <div class="text-[11px] text-slate-400 mt-1">Albums avec tracklist</div>
    </div>
  `;

  const renderGenreList = (items, targetId) => {
    const counts = {};
    items.forEach(v => {
      const g = (v.genre || 'Non classé').split(',')[0].trim();
      counts[g] = (counts[g] || 0) + 1;
    });
    document.getElementById(targetId).innerHTML = Object.entries(counts)
      .sort((a, b) => b[1] - a[1])
      .map(([g, count]) => `
        <div class="flex items-center justify-between py-1 border-b border-slate-800/60">
          <span class="text-slate-300">${g}</span>
          <span class="font-bold text-amber-400">${count}</span>
        </div>
      `).join('') || '<div class="text-slate-500">Aucune donnée</div>';
  };

  renderGenreList(col, 'stats-genres');
  renderGenreList(wish, 'stats-wishlist-genres');
}

// --- GESTION DES MEMBRES / ESPACES (SUPER-ADMIN ALEX) ---

async function submitLockLogin(e) {
  e.preventDefault();
  const slug = document.getElementById('lock-slug').value.trim().toLowerCase();
  const password = document.getElementById('lock-password').value;
  const res = await apiFetch('/api/auth/login', { method: 'POST', body: { slug, password } });
  if (!res.ok) {
    const errData = await res.json().catch(() => ({})); alert(errData.error || 'Identifiant ou mot de passe incorrect');
    return;
  }
  const data = await res.json();
  state.token = data.token;
  state.user = data.user;
  localStorage.setItem('vinyl_admin_token', data.token);
  document.getElementById('lock-password').value = '';
  document.getElementById('private-lock-screen').classList.add('hidden');
  state.currentSpace = data.user.slug;
  localStorage.setItem('vinyl_current_space', data.user.slug);
  await loadSpacesList();
  await loadPublicSettings();
  await loadVinyls();
  updateAdminUI();
  switchTab('collection');
}

async function renderInvitesList() {
  const cbContainer = document.getElementById('invite-spaces-checkboxes');
  if (cbContainer && state.spaces) {
    cbContainer.innerHTML = state.spaces.map(sp => `
      <label class="inline-flex items-center gap-1.5 bg-slate-900 border border-slate-700 px-2.5 py-1 rounded-lg text-xs text-slate-200 cursor-pointer hover:border-amber-500/50">
        <input type="checkbox" name="invite-space-cb" value="${sp.slug}" ${sp.slug === 'alex' ? 'checked' : ''} class="accent-amber-500 rounded" />
        <span>${sp.name}</span>
      </label>
    `).join('');
  }

  const container = document.getElementById('invites-list-container');
  if (!container) return;
  const res = await apiFetch('/api/invites');
  if (!res.ok) return;
  const data = await res.json();
  const baseUrl = window.location.origin + '/';
  if (!data.invites || data.invites.length === 0) {
    container.innerHTML = '<div class="py-3 text-xs text-slate-500">Aucun lien d\'invitation actif.</div>';
    return;
  }
  container.innerHTML = data.invites.map(inv => {
    const fullLink = baseUrl + '?invite=' + inv.token;
    const spacesBadge = (!inv.allowed_spaces || inv.allowed_spaces === '*')
      ? '<span class="bg-slate-800 text-slate-300 px-2 py-0.5 rounded text-[11px]">Toutes les bases</span>'
      : inv.allowed_spaces.split(',').map(slug => {
          const sp = (state.spaces || []).find(x => x.slug === slug);
          return '<span class="bg-amber-500/15 text-amber-300 border border-amber-500/30 px-2 py-0.5 rounded text-[11px]">' + (sp ? sp.name : slug) + '</span>';
        }).join(' ');
    return `
      <div class="py-3 flex flex-wrap items-center justify-between gap-2">
        <div class="min-w-0 flex-1 space-y-1">
          <div class="flex flex-wrap items-center gap-2">
            <span class="text-sm font-bold text-white">${inv.label}</span>${inv.created_by ? `<span class="text-[11px] text-slate-400">(par ${inv.created_by})</span>` : ""}${inv.created_by ? `<span class="text-[11px] text-slate-400">(par ${inv.created_by})</span>` : ""}
            <div class="flex flex-wrap gap-1">${spacesBadge}</div>
          </div>
          <div class="text-xs font-mono text-sky-400 truncate">${fullLink}</div>
        </div>
        <div class="flex items-center gap-2">
          <button onclick="copyInviteLink('${fullLink}')" class="bg-slate-800 hover:bg-slate-700 text-amber-300 border border-slate-700 px-3 py-1.5 rounded-lg text-xs font-bold">
            📋 Copier le lien
          </button>
          <button onclick="revokeInviteLink('${inv.token}')" class="bg-rose-950 hover:bg-rose-900 text-rose-300 px-3 py-1.5 rounded-lg text-xs">
            Révoquer
          </button>
        </div>
      </div>
    `;
  }).join('');
}

async function createInviteLink(e) {
  e.preventDefault();
  const label = document.getElementById('new-invite-label').value.trim();
  const checked = Array.from(document.querySelectorAll('input[name="invite-space-cb"]:checked')).map(cb => cb.value);
  if (checked.length === 0) {
    alert('Sélectionne au moins une base accessible pour ce lien.');
    return;
  }
  const res = await apiFetch('/api/invites', { method: 'POST', body: { label, allowed_spaces: checked } });
  if (res.ok) {
    document.getElementById('new-invite-label').value = '';
    await renderInvitesList();
  }
}

function copyInviteLink(url) {
  navigator.clipboard.writeText(url).then(() => {
    alert('Lien d\'invitation copié dans le presse-papier !');
  }).catch(() => {
    prompt('Copie ce lien :', url);
  });
}

async function revokeInviteLink(token) {
  if (!confirm('Révoquer ce lien d\'invitation ? Les personnes utilisant ce lien n\'auront plus accès.')) return;
  const res = await apiFetch('/api/invites/' + encodeURIComponent(token), { method: 'DELETE' });
  if (res.ok) await renderInvitesList();
}


async function updateUserVisibility(memberSlug) {
  const checkboxes = document.querySelectorAll(`input[name="vis-${memberSlug}"]`);
  const selected = Array.from(checkboxes).filter(cb => cb.checked).map(cb => cb.value);
  const statusEl = document.getElementById(`vis-status-${memberSlug}`);
  if (statusEl) {
    statusEl.textContent = 'Enregistrement...';
    statusEl.className = 'text-[11px] text-amber-400 ml-1';
  }
  const res = await apiFetch(`/api/users/${encodeURIComponent(memberSlug)}/visibility`, {
    method: 'PUT',
    body: { visible_spaces: selected }
  });
  if (res.ok) {
    await loadSpacesList();
    if (statusEl) {
      statusEl.textContent = '✓ Enregistré';
      statusEl.className = 'text-[11px] text-emerald-400 font-semibold ml-1';
      setTimeout(() => { if (statusEl) statusEl.textContent = ''; }, 2000);
    }
  } else {
    if (statusEl) {
      statusEl.textContent = '✗ Erreur';
      statusEl.className = 'text-[11px] text-rose-400 font-semibold ml-1';
    }
  }
}

async function renderUsersManagement() {
  await renderInvitesList();
  await loadSpacesList();
  const container = document.getElementById('users-list-container');
  container.innerHTML = state.spaces.map(u => `
    <div class="py-3.5 flex flex-wrap items-center justify-between gap-3">
      <div class="flex items-center gap-3">
        <div class="w-9 h-9 rounded-xl bg-amber-500/20 border border-amber-500/40 flex items-center justify-center font-bold text-amber-300">
          ${u.name.slice(0, 1).toUpperCase()}
        </div>
        <div>
          <div class="text-sm font-bold text-white">${u.name} <span class="text-xs font-mono text-slate-400">(${u.slug}.db)</span> ${u.is_super_admin ? '<span class="text-[10px] bg-amber-500 text-slate-950 font-bold px-1.5 py-0.5 rounded ml-1">Super-Admin</span>' : ''}</div>
          <div class="text-xs text-slate-400">${u.counts.collection} disques (${u.counts.vinyl} 33T, ${u.counts.cd} CD) · ${u.counts.wishlist} en wishlist</div>
          ${!u.is_super_admin ? `
            <div class="mt-2 flex flex-wrap items-center gap-1.5">
              <span class="text-[11px] text-slate-400 mr-1">Voit aussi :</span>
              ${state.spaces.filter(other => other.slug !== u.slug).map(other => {
                const isChecked = u.visible_spaces === '*' || (u.visible_spaces || '').split(',').includes(other.slug);
                return `
                  <label class="inline-flex items-center gap-1 bg-slate-950 border border-slate-800 px-2 py-0.5 rounded text-[11px] text-slate-300 cursor-pointer hover:border-amber-500/50">
                    <input type="checkbox" name="vis-${u.slug}" value="${other.slug}" ${isChecked ? 'checked' : ''} onchange="updateUserVisibility('${u.slug}')" class="accent-amber-500 rounded" />
                    <span>${other.name}</span>
                  </label>
                `;
              }).join('')}
            </div>
          ` : ''}
        </div>
      </div>
      <div class="flex items-center gap-2">
        <button onclick="switchSpace('${u.slug}'); switchTab('collection');" class="bg-slate-800 hover:bg-slate-700 text-slate-200 px-3 py-1.5 rounded-lg text-xs">
          Voir l'espace
        </button>
        <button onclick="resetMemberPasswordPrompt('${u.slug}', '${u.name.replace(/'/g, "\\'")}')" class="bg-slate-800 hover:bg-slate-700 text-amber-300 px-3 py-1.5 rounded-lg text-xs">
          Changer MDP
        </button>
        ${!u.is_super_admin ? `<button onclick="deleteMemberSpace('${u.slug}', '${u.name.replace(/'/g, "\\'")}')" class="bg-rose-950 hover:bg-rose-900 text-rose-300 px-3 py-1.5 rounded-lg text-xs">Supprimer</button>` : ''}
      </div>
    </div>
  `).join('');
}

async function createNewMemberSpace(e) {
  e.preventDefault();
  const name = document.getElementById('new-user-name').value.trim();
  const slug = document.getElementById('new-user-slug').value.trim();
  const password = document.getElementById('new-user-pass').value.trim();

  const res = await apiFetch('/api/users', { method: 'POST', body: { name, slug, password } });
  if (!res.ok) {
    const err = await res.json();
    alert(err.error || 'Erreur création espace');
    return;
  }
  document.getElementById('new-user-name').value = '';
  document.getElementById('new-user-slug').value = '';
  document.getElementById('new-user-pass').value = '';
  await renderUsersManagement();
  alert(`L'espace de ${name} a été créé avec sa propre base SQLite !`);
}

async function resetMemberPasswordPrompt(slug, name) {
  const newPass = prompt(`Nouveau mot de passe pour ${name} (${slug}) :`);
  if (!newPass) return;
  const res = await apiFetch(`/api/users/${slug}`, { method: 'PUT', body: { password: newPass } });
  if (res.ok) alert(`Mot de passe mis à jour pour ${name}.`);
}

async function deleteMemberSpace(slug, name) {
  if (!confirm(`Supprimer l'espace de ${name} (${slug}) ? (Un backup .db.bak sera conservé sur le serveur)`)) return;
  const res = await apiFetch(`/api/users/${slug}`, { method: 'DELETE' });
  if (res.ok) {
    if (state.currentSpace === slug) await switchSpace('alex');
    await renderUsersManagement();
  }
}

// --- CONNEXION / DÉCONNEXION ---
function openLoginModal() {
  document.getElementById('login-password').value = '';
  const loginSel = document.getElementById('login-slug');
  if (loginSel) loginSel.value = state.currentSpace;
  document.getElementById('modal-login').classList.remove('hidden');
  document.getElementById('modal-login').classList.add('flex');
}

function closeLoginModal() {
  document.getElementById('modal-login').classList.add('hidden');
  document.getElementById('modal-login').classList.remove('flex');
}

async function submitLogin(e) {
  e.preventDefault();
  const slug = document.getElementById('login-slug').value;
  const password = document.getElementById('login-password').value;
  const res = await apiFetch('/api/auth/login', { method: 'POST', body: { slug, password } });
  if (!res.ok) {
    const errData = await res.json().catch(() => ({})); alert(errData.error || 'Identifiant ou mot de passe incorrect');
    return;
  }
  const data = await res.json();
  state.token = data.token;
  state.user = data.user;
  localStorage.setItem('vinyl_admin_token', data.token);
  closeLoginModal();

  // Recharger la liste des espaces autorisés pour ce compte et basculer sur son espace
  await loadSpacesList();
  if (state.currentSpace !== data.user.slug) {
    await switchSpace(data.user.slug);
  } else {
    await switchSpace(data.user.slug);
    updateAdminUI();
  }
}

async function logoutUser() {
  await apiFetch('/api/auth/logout', { method: 'POST' });
  state.token = null;
  state.user = null;
  localStorage.removeItem('vinyl_admin_token');
  localStorage.removeItem('vinyl_invite_token');
  state.inviteToken = null;
  state.inviteLabel = null;
  state.spaces = [];
  localStorage.removeItem('vinyl_current_space');
  const ul = document.getElementById('users-list-container'); if (ul) ul.innerHTML = '';
  if (!state.inviteToken) {
    state.vinyls = [];
    document.getElementById('vinyls-grid').innerHTML = '';
    document.getElementById('private-lock-screen').classList.remove('hidden');
    return;
  }
  switchTab('collection');
  updateAdminUI();
}

// --- MODALE FICHE DISQUE (AVEC LECTURE DEEZER 30S & LIENS PROFONDS) ---
function setModalPreviewImage(src) {
  state.currentModalCover = src || '';
  const img = document.getElementById('v-preview-img');
  const ph = document.getElementById('v-preview-placeholder');
  if (src) {
    img.src = src;
    img.classList.remove('hidden');
    ph.classList.add('hidden');
  } else {
    img.src = '';
    img.classList.add('hidden');
    ph.classList.remove('hidden');
  }
}

function previewCoverUrlInput() {
  const url = document.getElementById('v-cover-url').value.trim();
  if (url) setModalPreviewImage(url);
}

function handleLocalCoverUpload(e) {
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    document.getElementById('v-cover-base64').value = reader.result;
    setModalPreviewImage(reader.result);
  };
  reader.readAsDataURL(file);
}

function onMediaTypeChange() {
  const mt = document.getElementById('v-media-type').value;
  const fmtInput = document.getElementById('v-format');
  if (mt === 'cd' && (fmtInput.value === 'LP 12" 33T' || !fmtInput.value)) {
    fmtInput.value = 'CD Album';
  } else if (mt === 'vinyl' && (fmtInput.value === 'CD Album' || !fmtInput.value)) {
    fmtInput.value = 'LP 12" 33T';
  }
}

function renderModalTracklist() {
  const container = document.getElementById('v-tracklist-view');
  const canEdit = canEditCurrentSpace();
  const btnAdd = document.getElementById('btn-add-track-row');
  btnAdd.classList.toggle('hidden', !canEdit);

  if (!state.currentModalTracks || state.currentModalTracks.length === 0) {
    container.innerHTML = `<div class="text-slate-500 py-3 text-center">Aucune piste enregistrée pour cet album.${canEdit ? '<br><span class="text-[11px] text-amber-400/80">Clique sur "🔄 Régénérer API & Deezer" pour récupérer les chansons et extraits audio.</span>' : ''}</div>`;
    return;
  }

  container.innerHTML = state.currentModalTracks.map((t, idx) => {
    const artist = state.currentModalArtist || document.getElementById('v-artist').value || '';
    const directDzUrl = t.deezer_link || `https://www.deezer.com/search/${encodeURIComponent(artist + ' ' + t.title)}`;
    return `
      <div class="flex items-center justify-between gap-2 py-1.5 px-2 rounded-lg bg-slate-900/90 border border-slate-800/80 hover:border-amber-500/40 transition">
        <div class="flex items-center gap-2 min-w-0">
          <button type="button" onclick="playTrackOnDeezer(${idx})" title="Écouter l'extrait 30s"
            class="w-6 h-6 rounded-full bg-amber-500 hover:bg-amber-400 text-slate-950 flex items-center justify-center text-[10px] font-bold flex-shrink-0 shadow">
            ▶
          </button>
          <span class="text-[11px] font-mono text-amber-400 w-5 flex-shrink-0">${t.position || (idx + 1)}</span>
          <span class="text-slate-200 truncate font-medium">${t.title}</span>
        </div>
        <div class="flex items-center gap-1.5 flex-shrink-0">
          <span class="text-[11px] text-slate-400 font-mono">${t.duration || ''}</span>
          <a href="${directDzUrl}" target="_blank" rel="noopener" title="Écouter en entier dans Deezer"
            class="text-[10px] bg-purple-600/30 hover:bg-purple-600 text-purple-200 px-1.5 py-0.5 rounded border border-purple-500/40">
            🎧
          </a>
          ${canEdit ? `<button type="button" onclick="removeModalTrack(${idx})" class="text-rose-400 hover:text-rose-300 text-xs ml-1">✕</button>` : ''}
        </div>
      </div>
    `;
  }).join('');
}

function addTrackPrompt() {
  const pos = prompt("Position (ex: A1, B2 ou 1) :", String(state.currentModalTracks.length + 1));
  if (pos === null) return;
  const title = prompt("Titre de la chanson :");
  if (!title) return;
  const dur = prompt("Durée (ex: 4:15) :", "");
  state.currentModalTracks.push({ position: pos.trim(), title: title.trim(), duration: (dur || '').trim() });
  renderModalTracklist();
}

function removeModalTrack(idx) {
  state.currentModalTracks.splice(idx, 1);
  renderModalTracklist();
}

function openVinylModal(id = null) {
  const modal = document.getElementById('modal-vinyl');
  const form = document.getElementById('vinyl-form');
  const roBox = document.getElementById('vinyl-readonly-details');
  const coverTools = document.getElementById('v-cover-admin-tools');
  const statusPill = document.getElementById('vinyl-modal-status-pill');
  const mediaPill = document.getElementById('vinyl-modal-media-pill');
  const acquireBanner = document.getElementById('wishlist-acquire-banner');
  const btnCopy = document.getElementById('btn-copy-to-my-space');

  const canEdit = canEditCurrentSpace();

  form.reset();
  state.currentModalVinylId = id;
  document.getElementById('v-cover-base64').value = '';
  document.getElementById('v-discogs-id').value = '';
  document.getElementById('v-deezer-album-id').value = '';
  document.getElementById('v-cover-picker').classList.add('hidden');
  document.getElementById('autocomplete-dropdown').classList.add('hidden');
  populateWallSlotsSelect();

  coverTools.classList.toggle('hidden', !canEdit);
  form.classList.toggle('hidden', !canEdit);
  roBox.classList.toggle('hidden', canEdit);

  // Afficher le bouton "+ Copier dans ma Wishlist" si un membre connecté visite la collection d'un autre
  const showCopyBtn = Boolean(id && state.user && state.user.slug !== state.currentSpace);
  btnCopy.classList.toggle('hidden', !showCopyBtn);

  if (id) {
    const v = state.vinyls.find(x => x.id === id);
    if (!v) return;
    state.currentModalTracks = parseTracks(v);
    state.currentModalArtist = v.artist || '';
    state.currentModalTitle = v.title || '';
    state.currentModalDeezerAlbumId = v.deezer_album_id || '';
    setModalPreviewImage(getCoverSrc(v));

    const isWish = v.status === 'wishlist';
    const isCd = v.media_type === 'cd';

    mediaPill.textContent = isCd ? '💿 CD Audio' : '⚫ Vinyle';
    mediaPill.className = isCd
      ? 'text-xs px-2.5 py-0.5 rounded-full font-bold bg-sky-500/20 text-sky-300 border border-sky-500/40'
      : 'text-xs px-2.5 py-0.5 rounded-full font-bold bg-amber-500/20 text-amber-300 border border-amber-500/40';

    statusPill.textContent = isWish ? 'Wishlist' : 'En Collection';
    statusPill.className = isWish
      ? 'text-xs px-2.5 py-0.5 rounded-full font-semibold bg-amber-500/20 text-amber-300 border border-amber-500/40'
      : 'text-xs px-2.5 py-0.5 rounded-full font-semibold bg-emerald-500/20 text-emerald-300 border border-emerald-500/40';

    if (canEdit) {
      document.getElementById('vinyl-modal-title').textContent = 'Éditer le disque';
      document.getElementById('v-id').value = v.id;
      document.getElementById('v-media-type').value = v.media_type || 'vinyl';
      document.getElementById('v-artist').value = v.artist || '';
      document.getElementById('v-title').value = v.title || '';
      document.getElementById('v-status').value = v.status || 'collection';
      document.getElementById('v-genre').value = v.genre || '';
      document.getElementById('v-year').value = v.year || '';
      document.getElementById('v-release-year').value = v.release_year || '';
      document.getElementById('v-label').value = v.label || '';
      document.getElementById('v-barcode').value = v.barcode || '';
      document.getElementById('v-format').value = v.format || (isCd ? 'CD Album' : 'LP 12" 33T');
      document.getElementById('v-cond-media').value = v.condition_media || 'NM';
      document.getElementById('v-cond-sleeve').value = v.condition_sleeve || 'NM';
      document.getElementById('v-price').value = v.purchase_price || '';
      document.getElementById('v-location').value = v.purchase_location || '';
      document.getElementById('v-wall-slot').value = v.wall_slot || '';
      document.getElementById('v-cover-url').value = v.cover_url || '';
      document.getElementById('v-notes').value = v.notes || '';
      document.getElementById('v-discogs-id').value = v.discogs_id || '';
      document.getElementById('v-deezer-album-id').value = v.deezer_album_id || '';

      acquireBanner.classList.toggle('hidden', !isWish);
      document.getElementById('btn-delete-vinyl').classList.remove('hidden');
      document.getElementById('btn-regen-single').classList.remove('hidden');
    } else {
      document.getElementById('vinyl-modal-title').textContent = `${v.artist} — ${v.title}`;
      document.getElementById('ro-media').textContent = isCd ? '💿 CD Audio' : '⚫ Vinyle';
      document.getElementById('ro-artist').textContent = v.artist || '';
      document.getElementById('ro-title').textContent = v.title || '';
      document.getElementById('ro-year').textContent = v.year || '—';
      document.getElementById('ro-release-year').textContent = v.release_year || '—';
      document.getElementById('ro-genre').textContent = v.genre || '—';
      document.getElementById('ro-format').textContent = v.format || 'LP';
      document.getElementById('ro-label').textContent = v.label || '—';
      document.getElementById('ro-cond').textContent = `${v.condition_media || 'NM'} / ${v.condition_sleeve || 'NM'}`;
      document.getElementById('ro-price').textContent = v.purchase_price ? `${v.purchase_price.toFixed(2)} ${state.settings.currency}` : '—';
      document.getElementById('ro-location').textContent = v.purchase_location || '—';
      document.getElementById('ro-notes').textContent = v.notes || 'Aucune remarque.';
    }
  } else {
    state.currentModalTracks = [];
    state.currentModalArtist = '';
    state.currentModalTitle = '';
    state.currentModalDeezerAlbumId = '';
    setModalPreviewImage('');
    document.getElementById('vinyl-modal-title').textContent = 'Ajouter un disque (Vinyle ou CD)';
    mediaPill.textContent = state.mediaFilter === 'cd' ? '💿 CD Audio' : '⚫ Vinyle';
    mediaPill.className = 'text-xs px-2.5 py-0.5 rounded-full font-bold bg-amber-500/20 text-amber-300';
    statusPill.textContent = 'Nouveau';
    statusPill.className = 'text-xs px-2.5 py-0.5 rounded-full font-semibold bg-slate-800 text-slate-300';
    document.getElementById('v-id').value = '';
    document.getElementById('v-media-type').value = state.mediaFilter === 'cd' ? 'cd' : 'vinyl';
    onMediaTypeChange();
    document.getElementById('v-status').value = state.currentTab === 'wishlist' ? 'wishlist' : 'collection';
    acquireBanner.classList.add('hidden');
    document.getElementById('btn-delete-vinyl').classList.add('hidden');
    document.getElementById('btn-regen-single').classList.add('hidden');
  }

  renderModalTracklist();
  modal.classList.remove('hidden');
  modal.classList.add('flex');
}

function closeVinylModal() {
  stopBarcodeScanner();
  document.getElementById('modal-vinyl').classList.add('hidden');
  document.getElementById('modal-vinyl').classList.remove('flex');
}

// --- AUTO-COMPLÉTION EN DIRECT (DISCOGS + DEEZER + ITUNES HD) ---
function scheduleAutoComplete() {
  if (!canEditCurrentSpace()) return;
  if (state.autoCompleteTimer) clearTimeout(state.autoCompleteTimer);
  state.autoCompleteTimer = setTimeout(() => {
    triggerManualLookup(true);
  }, 550);
}

async function triggerManualLookup(isSilent = false) {
  const artist = document.getElementById('v-artist').value.trim();
  const title = document.getElementById('v-title').value.trim();
  const mediaType = document.getElementById('v-media-type').value;
  const q = `${artist} ${title}`.trim();
  if (q.length < 3) return;

  const drop = document.getElementById('autocomplete-dropdown');
  if (!isSilent) {
    drop.classList.remove('hidden');
    drop.innerHTML = `<div class="p-3 text-xs text-slate-400">Recherche dans Discogs, Deezer & iTunes HD...</div>`;
  }

  const res = await apiFetch(`/api/external/search?q=${encodeURIComponent(q)}&media_type=${encodeURIComponent(mediaType)}`);
  if (!res.ok) return;
  const data = await res.json();
  const results = data.results || [];

  if (results.length === 0) {
    if (!isSilent) drop.innerHTML = `<div class="p-3 text-xs text-slate-500">Aucun album trouvé pour "${q}".</div>`;
    return;
  }

  drop.classList.remove('hidden');
  drop.innerHTML = results.map(r => `
    <div onclick='applyExternalResult(${JSON.stringify(r).replace(/'/g, "&#39;")})'
      class="p-2.5 hover:bg-slate-900 cursor-pointer flex items-center gap-3 transition">
      <div class="w-10 h-10 rounded bg-slate-900 flex-shrink-0 overflow-hidden flex items-center justify-center border border-slate-800">
        ${r.cover_url ? `<img src="${r.cover_url}" referrerpolicy="no-referrer" class="w-full h-full object-cover" />` : '💿'}
      </div>
      <div class="min-w-0 flex-1">
        <div class="text-xs font-bold text-white truncate">${r.artist} — ${r.title}</div>
        <div class="text-[11px] text-slate-400 truncate">${r.release_year || '—'} · ${r.label || ''} · <span class="text-amber-400">${r.source}</span></div>
      </div>
      <span class="text-xs text-amber-400 font-semibold px-2">Remplir</span>
    </div>
  `).join('');
}

async function applyExternalResult(r) {
  document.getElementById('v-artist').value = r.artist || '';
  document.getElementById('v-title').value = r.title || '';
  state.currentModalArtist = r.artist || '';
  state.currentModalTitle = r.title || '';

  if (r.release_year) {
    document.getElementById('v-release-year').value = r.release_year;
    if (!document.getElementById('v-year').value) document.getElementById('v-year').value = r.release_year;
  }
  if (r.label) document.getElementById('v-label').value = r.label;
  if (r.barcode) document.getElementById('v-barcode').value = r.barcode;
  if (r.genre && !document.getElementById('v-genre').value) document.getElementById('v-genre').value = r.genre;
  if (r.format) document.getElementById('v-format').value = r.format;
  if (r.cover_url) {
    document.getElementById('v-cover-url').value = r.cover_url;
    setModalPreviewImage(r.cover_url);
  }
  document.getElementById('v-discogs-id').value = r.external_id || '';
  if (r.deezer_album_id) {
    document.getElementById('v-deezer-album-id').value = r.deezer_album_id;
    state.currentModalDeezerAlbumId = r.deezer_album_id;
  }
  document.getElementById('autocomplete-dropdown').classList.add('hidden');

  // Récupérer la tracklist enrichie avec les extraits Deezer 30s
  const detRes = await apiFetch(`/api/external/details?source=${encodeURIComponent(r.source)}&id=${encodeURIComponent(r.external_id || '')}&artist=${encodeURIComponent(r.artist || '')}&title=${encodeURIComponent(r.title || '')}`);
  if (detRes.ok) {
    const detData = await detRes.json();
    if (detData.tracklist && detData.tracklist.length > 0) {
      state.currentModalTracks = detData.tracklist;
      renderModalTracklist();
    }
    if (detData.deezer_album_id) {
      document.getElementById('v-deezer-album-id').value = detData.deezer_album_id;
      state.currentModalDeezerAlbumId = detData.deezer_album_id;
    }
  }
}

// --- SÉLECTEUR VISUEL DE POCHETTES ---
async function searchCoverAlternatives() {
  const artist = document.getElementById('v-artist').value.trim();
  const title = document.getElementById('v-title').value.trim();
  const q = `${artist} ${title}`.trim();
  if (!q) {
    alert("Renseigne d'abord l'Artiste et le Titre.");
    return;
  }
  const picker = document.getElementById('v-cover-picker');
  const grid = document.getElementById('v-cover-picker-grid');
  picker.classList.remove('hidden');
  grid.innerHTML = `<div class="col-span-3 text-xs text-slate-400 py-2">Recherche de pochettes HD...</div>`;

  const res = await apiFetch(`/api/external/search?q=${encodeURIComponent(q)}`);
  const data = await res.json();
  const withCovers = (data.results || []).filter(r => r.cover_url);

  if (withCovers.length === 0) {
    grid.innerHTML = `<div class="col-span-3 text-xs text-slate-500 py-2">Aucune pochette trouvée.</div>`;
    return;
  }

  grid.innerHTML = withCovers.map(r => `
    <div onclick="selectCoverFromPicker('${r.cover_url.replace(/'/g, "\\'")}')" class="cursor-pointer group relative aspect-square rounded-lg overflow-hidden border border-slate-800 hover:border-amber-500">
      <img src="${r.cover_url}" referrerpolicy="no-referrer" class="w-full h-full object-cover group-hover:scale-105 transition" />
      <span class="absolute bottom-1 right-1 bg-black/80 text-[9px] text-amber-300 px-1 rounded">${r.source}</span>
    </div>
  `).join('');
}

function selectCoverFromPicker(url) {
  document.getElementById('v-cover-url').value = url;
  document.getElementById('v-cover-base64').value = '';
  setModalPreviewImage(url);
  document.getElementById('v-cover-picker').classList.add('hidden');
}

async function regenerateSingleModalVinyl() {
  const id = document.getElementById('v-id').value;
  if (!id) return;
  const btn = document.getElementById('btn-regen-single');
  btn.textContent = '⏳ Recherche...';
  btn.disabled = true;
  const res = await apiFetch(`/api/vinyls/${id}/regenerate`, { method: 'POST', body: { force_cover: true } });
  btn.textContent = '🔄 Régénérer API & Deezer';
  btn.disabled = false;
  if (res.ok) {
    await loadVinyls();
    openVinylModal(parseInt(id, 10));
  }
}

// --- SCAN CODE-BARRES CAMÉRA ---
function toggleBarcodeScanner() {
  const container = document.getElementById('scanner-container');
  if (!container.classList.contains('hidden')) {
    stopBarcodeScanner();
    return;
  }
  container.classList.remove('hidden');
  state.qrScanner = new Html5Qrcode("reader");
  state.qrScanner.start(
    { facingMode: "environment" },
    { fps: 10, qrbox: { width: 240, height: 110 } },
    async (decodedText) => {
      document.getElementById('v-barcode').value = decodedText;
      stopBarcodeScanner();
      const res = await apiFetch(`/api/external/search?barcode=${encodeURIComponent(decodedText)}`);
      const data = await res.json();
      if (data.results && data.results.length > 0) {
        applyExternalResult(data.results[0]);
      }
    },
    () => {}
  ).catch(err => {
    alert("Caméra indisponible (nécessite HTTPS sur iOS) : " + err);
    container.classList.add('hidden');
  });
}

function stopBarcodeScanner() {
  const container = document.getElementById('scanner-container');
  if (container) container.classList.add('hidden');
  if (state.qrScanner) {
    state.qrScanner.stop().catch(() => {}).finally(() => { state.qrScanner = null; });
  }
}

// --- SAUVEGARDE & SUPPRESSION DISQUE ---
async function saveVinyl(e) {
  e.preventDefault();
  if (!canEditCurrentSpace()) return;
  const id = document.getElementById('v-id').value;
  const payload = {
    media_type: document.getElementById('v-media-type').value,
    artist: document.getElementById('v-artist').value.trim(),
    title: document.getElementById('v-title').value.trim(),
    status: document.getElementById('v-status').value,
    genre: document.getElementById('v-genre').value.trim(),
    year: document.getElementById('v-year').value ? parseInt(document.getElementById('v-year').value, 10) : null,
    release_year: document.getElementById('v-release-year').value ? parseInt(document.getElementById('v-release-year').value, 10) : null,
    label: document.getElementById('v-label').value.trim(),
    barcode: document.getElementById('v-barcode').value.trim(),
    format: document.getElementById('v-format').value.trim(),
    condition_media: document.getElementById('v-cond-media').value,
    condition_sleeve: document.getElementById('v-cond-sleeve').value,
    purchase_price: parseFloat(document.getElementById('v-price').value) || 0,
    purchase_location: document.getElementById('v-location').value.trim(),
    wall_slot: document.getElementById('v-wall-slot').value || null,
    cover_url: document.getElementById('v-cover-url').value.trim(),
    cover_base64: document.getElementById('v-cover-base64').value || null,
    discogs_id: document.getElementById('v-discogs-id').value || '',
    deezer_album_id: document.getElementById('v-deezer-album-id').value || '',
    notes: document.getElementById('v-notes').value,
    tracklist: state.currentModalTracks
  };

  const url = id ? `/api/vinyls/${id}` : '/api/vinyls';
  const method = id ? 'PUT' : 'POST';
  const btn = document.getElementById('btn-save-vinyl');
  btn.textContent = 'Enregistrement...';
  btn.disabled = true;

  const res = await apiFetch(url, { method, body: payload });
  btn.textContent = 'Enregistrer';
  btn.disabled = false;

  if (res.ok) {
    closeVinylModal();
    await loadSpacesList();
    await loadVinyls();
  } else {
    const err = await res.json();
    alert(err.error || 'Erreur lors de la sauvegarde');
  }
}

async function deleteCurrentVinyl() {
  const id = document.getElementById('v-id').value;
  if (!id || !confirm('Supprimer définitivement ce disque ?')) return;
  await apiFetch(`/api/vinyls/${id}`, { method: 'DELETE' });
  closeVinylModal();
  await loadSpacesList();
  await loadVinyls();
}

// --- PARAMÈTRES DE L'ESPACE ---

async function renderMemberInvitesList() {
  const section = document.getElementById('member-invites-section');
  const container = document.getElementById('member-invites-list');
  if (!section || !container) return;

  if (!state.user || state.user.is_super_admin) {
    section.classList.add('hidden');
    return;
  }
  section.classList.remove('hidden');

  const res = await apiFetch('/api/invites');
  if (!res.ok) return;
  const data = await res.json();
  const baseUrl = window.location.origin + '/';

  if (!data.invites || data.invites.length === 0) {
    container.innerHTML = '<div class="py-3 text-xs text-slate-500">Tu n\'as encore créé aucun lien de partage.</div>';
    return;
  }

  container.innerHTML = data.invites.map(inv => {
    const fullLink = baseUrl + '?invite=' + inv.token;
    return `
      <div class="py-3 flex flex-wrap items-center justify-between gap-2">
        <div class="min-w-0 flex-1 space-y-1">
          <div class="text-sm font-bold text-white">${inv.label}</div>
          <div class="text-xs font-mono text-sky-400 truncate">${fullLink}</div>
        </div>
        <div class="flex items-center gap-2">
          <button onclick="copyInviteLink('${fullLink}')" class="bg-slate-800 hover:bg-slate-700 text-amber-300 border border-slate-700 px-3 py-1.5 rounded-lg text-xs font-bold">
            📋 Copier
          </button>
          <button onclick="revokeMemberInviteLink('${inv.token}')" class="bg-rose-950 hover:bg-rose-900 text-rose-300 px-3 py-1.5 rounded-lg text-xs">
            Révoquer
          </button>
        </div>
      </div>
    `;
  }).join('');
}

async function createMemberInviteLink(e) {
  e.preventDefault();
  const input = document.getElementById('member-invite-label');
  const label = input.value.trim();
  if (!label) return;
  const res = await apiFetch('/api/invites', { method: 'POST', body: { label } });
  if (res.ok) {
    input.value = '';
    await renderMemberInvitesList();
  }
}

async function revokeMemberInviteLink(token) {
  if (!confirm('Révoquer ce lien de partage ?')) return;
  const res = await apiFetch('/api/invites/' + encodeURIComponent(token), { method: 'DELETE' });
  if (res.ok) await renderMemberInvitesList();
}

async function loadAdminSettingsForm() {
  const res = await apiFetch('/api/settings/admin');
  if (!res.ok) return;
  const s = await res.json();
  document.getElementById('set-title').value = s.collection_title || '33T-Box';
  document.getElementById('set-rows').value = s.wall_rows || '2';
  document.getElementById('set-cols').value = s.wall_cols || '4';
  document.getElementById('set-currency').value = s.currency || '€';
  document.getElementById('set-password').value = '';

  const discogsBox = document.getElementById('superadmin-discogs-box');
  if (state.user && state.user.is_super_admin) {
    discogsBox.classList.remove('hidden');
    document.getElementById('set-discogs').value = s.discogs_token || '';
  } else {
    discogsBox.classList.add('hidden');
  }
}

async function saveSettings(e) {
  e.preventDefault();
  const payload = {
    collection_title: document.getElementById('set-title').value,
    discogs_token: state.user && state.user.is_super_admin ? document.getElementById('set-discogs').value : undefined,
    wall_rows: document.getElementById('set-rows').value,
    wall_cols: document.getElementById('set-cols').value,
    currency: document.getElementById('set-currency').value,
    new_password: document.getElementById('set-password').value
  };
  const res = await apiFetch('/api/settings', { method: 'PUT', body: payload });
  if (res.ok) {
    alert('Paramètres enregistrés !');
    await loadSpacesList();
    await loadPublicSettings();
    renderWall();
  }
}

async function downloadBackup() {
  const res = await apiFetch('/api/backup/export');
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `33t_box_${state.currentSpace}_backup_${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
}

window.addEventListener('DOMContentLoaded', initApp);


let publicQrScanner = null;

function togglePublicBarcodeScanner() {
  const box = document.getElementById('public-scanner-box');
  if (!box.classList.contains('hidden')) {
    stopPublicBarcodeScanner();
    return;
  }
  document.getElementById('public-scan-result').classList.add('hidden');
  box.classList.remove('hidden');
  publicQrScanner = new Html5Qrcode("public-reader");
  publicQrScanner.start(
    { facingMode: "environment" },
    { fps: 10, qrbox: { width: 250, height: 110 } },
    (decodedText) => {
      stopPublicBarcodeScanner();
      handlePublicBarcodeFound(decodedText);
    },
    () => {}
  ).catch(err => {
    alert("Caméra indisponible : " + err);
    box.classList.add('hidden');
  });
}

function stopPublicBarcodeScanner() {
  const box = document.getElementById('public-scanner-box');
  if (box) box.classList.add('hidden');
  if (publicQrScanner) {
    publicQrScanner.stop().catch(() => {}).finally(() => { publicQrScanner = null; });
  }
}

function handlePublicBarcodeFound(ean) {
  const cleanEan = String(ean || '').trim();
  const resBox = document.getElementById('public-scan-result');
  const matches = state.vinyls.filter(v => (v.barcode || '').replace(/\s+/g, '').includes(cleanEan));

  resBox.classList.remove('hidden');

  if (matches.length > 0) {
    const found = matches[0];
    if (found.status === 'wishlist') {
      switchTab('wishlist');
      resBox.className = 'p-3.5 rounded-xl border bg-emerald-950/70 border-emerald-500/60 text-emerald-200 text-xs sm:text-sm flex flex-wrap items-center justify-between gap-2';
      resBox.innerHTML = '<div>🎁 <strong>Bingo !</strong> Cet album (<em>' + found.artist + ' - ' + found.title + '</em>) est dans la <strong>Wishlist</strong> !</div><button onclick="openVinylModal(' + found.id + ')" class="bg-emerald-500 text-slate-950 font-bold px-3 py-1 rounded-lg text-xs">Voir la fiche</button>';
    } else {
      switchTab('collection');
      resBox.className = 'p-3.5 rounded-xl border bg-rose-950/70 border-rose-500/60 text-rose-200 text-xs sm:text-sm flex flex-wrap items-center justify-between gap-2';
      resBox.innerHTML = '<div>⚠️ <strong>Déjà possédé !</strong> <em>' + found.artist + ' - ' + found.title + '</em> est déjà dans la <strong>Collection</strong>.</div><button onclick="openVinylModal(' + found.id + ')" class="bg-slate-800 text-white font-bold px-3 py-1 rounded-lg text-xs">Voir la fiche</button>';
    }
    document.getElementById('search-input').value = cleanEan;
    renderVinyls();
  } else {
    document.getElementById('search-input').value = cleanEan;
    renderVinyls();
    resBox.className = 'p-3.5 rounded-xl border bg-slate-900 border-amber-500/50 text-amber-200 text-xs sm:text-sm flex flex-wrap items-center justify-between gap-2';
    resBox.innerHTML = '<div>🔍 Code-barres <strong>' + cleanEan + '</strong> non trouvé par EAN. Vérifie aussi en tapant le nom de l\'artiste au cas où l\'édition diffère.</div><button onclick="document.getElementById(\'public-scan-result\').classList.add(\'hidden\'); clearSearchInput();" class="bg-slate-800 text-slate-300 px-2.5 py-1 rounded-lg text-xs">Effacer</button>';
  }
}
