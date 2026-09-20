/* ============================================================
   script.js  –  SpotScrape frontend logic (Stateless / URL Query Driven)
============================================================ */

'use strict';

/* ── Global State ─────────────────────────────────────────── */
let currentData          = null;
let currentDetailData    = null;
let currentLyrics        = null;
let activeLyricsPreview  = 'synced'; // 'synced' | 'plain'
// Theme switching disabled: the application uses the fixed dark theme.
// let currentTheme         = localStorage.getItem('theme') || 'system';
let activeSearchTab      = 'tracks';

/* ── Init ─────────────────────────────────────────────────── */
document.addEventListener('DOMContentLoaded', () => {
    // Theme switching disabled: dark theme is provided by the stylesheet.

    const urlParams    = new URLSearchParams(window.location.search);
    const prefilledUrl = urlParams.get('url');
    const urlInput     = document.getElementById('spotifyUrl');

    // Home Page: Auto-extract if ?url= query parameter is present on refresh or link
    if (prefilledUrl && urlInput) {
        urlInput.value = prefilledUrl;
        fetchData(false);
    }

    // Search Page: Auto-search & restore tab/detail if query parameters are present
    const searchQuery = urlParams.get('q');
    const searchTab   = urlParams.get('tab');
    const detailUrl   = urlParams.get('detail');
    const searchInput = document.getElementById('searchInput');

    if (searchQuery && searchInput) {
        searchInput.value = searchQuery;
        if (searchTab) {
            activeSearchTab = searchTab;
        }
        searchSpotify(false).then(() => {
            if (detailUrl) {
                openSearchDetail(detailUrl, '', false);
            }
        });
    }

    const lyricsSongQuery = urlParams.get('song');
    const lyricsArtistQuery = urlParams.get('artist');
    const lyricsModeQuery = urlParams.get('mode');
    const lyricsSongInput = document.getElementById('lyricsSearchSong');
    const lyricsArtistInput = document.getElementById('lyricsSearchArtist');

    if (lyricsSongQuery && lyricsSongInput) {
        lyricsSongInput.value = lyricsSongQuery;
        if (lyricsArtistInput) {
            lyricsArtistInput.value = lyricsArtistQuery || '';
        }
        if (lyricsModeQuery) {
            currentLyricsSearchMode = lyricsModeQuery;
        }
        searchLyricsByName(false);
    }

    // Enter key on URL input
    if (urlInput) {
        urlInput.addEventListener('keypress', e => { if (e.key === 'Enter') fetchData(); });
    }

    // Enter key on search input
    if (searchInput) {
        searchInput.addEventListener('keypress', e => { if (e.key === 'Enter') searchSpotify(); });
    }

    if (lyricsSongInput) {
        lyricsSongInput.addEventListener('keypress', e => {
            if (e.key === 'Enter') searchLyricsByName();
        });
    }

    if (lyricsArtistInput) {
        lyricsArtistInput.addEventListener('keypress', e => {
            if (e.key === 'Enter') searchLyricsByName();
        });
    }

    // Close embed / lyrics modals on overlay click
    document.addEventListener('click', e => {
        if (e.target.classList.contains('embed-fullscreen-overlay'))  closeEmbedModal();
        if (e.target.classList.contains('lyrics-fullscreen-overlay')) closeLyricsModal();
    });

    // ESC closes modals
    document.addEventListener('keydown', e => {
        if (e.key === 'Escape') { closeEmbedModal(); closeLyricsModal(); }
    });

    // Window scroll handler for navbar & scroll-to-top button
    window.addEventListener('scroll', () => {
        const navbar = document.querySelector('.navbar');
        const scrollBtn = document.getElementById('scrollTopBtn');
        if (window.scrollY > 40) {
            if (navbar) navbar.classList.add('scrolled');
        } else {
            if (navbar) navbar.classList.remove('scrolled');
        }
        if (window.scrollY > 300) {
            if (scrollBtn) scrollBtn.classList.add('visible');
        } else {
            if (scrollBtn) scrollBtn.classList.remove('visible');
        }
    });

    // Handle Browser Back/Forward navigation with URL state
    window.addEventListener('popstate', () => {
        const params = new URLSearchParams(window.location.search);
        const u = params.get('url');
        if (urlInput) {
            if (u) {
                urlInput.value = u;
                fetchData(false);
            } else {
                urlInput.value = '';
                const card = document.getElementById('resultCard');
                if (card) card.classList.add('d-none');
            }
        }

        if (searchInput) {
            const q = params.get('q');
            const t = params.get('tab');
            const d = params.get('detail');

            if (q) {
                searchInput.value = q;
                if (t) activeSearchTab = t;
                if (d) {
                    openSearchDetail(d, '', false);
                } else {
                    closeSearchDetailScreen(false);
                    if (window._searchData) {
                        renderSearchResults(window._searchData);
                    } else {
                        searchSpotify(false);
                    }
                }
            }
        }

        const lyricsSongInput = document.getElementById('lyricsSearchSong');
        const lyricsArtistInput = document.getElementById('lyricsSearchArtist');
        const song = params.get('song');
        const artist = params.get('artist');
        const mode = params.get('mode');

        if (lyricsSongInput) {
            lyricsSongInput.value = song || lyricsSongInput.value;
        }
        if (lyricsArtistInput) {
            lyricsArtistInput.value = artist || lyricsArtistInput.value;
        }

        if (song && (song !== '' || artist !== null)) {
            if (mode) currentLyricsSearchMode = mode;
            if (lyricsSongInput || lyricsArtistInput) {
                searchLyricsByName(false);
            }
        }
    });
});

/* ================================================================
   SAMPLE CHIPS HELPER
================================================================ */
function setAndFetch(url) {
    const urlInput = document.getElementById('spotifyUrl');
    if (urlInput) {
        urlInput.value = url;
        fetchData();
        urlInput.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
}

/* Theme switching disabled: the application uses the fixed dark theme. */

/* ================================================================
   SKELETON LOADING HELPERS
================================================================ */
function showSkeleton(statusText = 'Fetching data…') {
    const el = document.getElementById('skeletonLoader');
    const st = document.getElementById('skeletonStatus');
    if (el) el.classList.remove('d-none');
    if (st) st.textContent = statusText;
}

function hideSkeleton() {
    const el = document.getElementById('skeletonLoader');
    if (el) el.classList.add('d-none');
}

function updateSkeletonStatus(text) {
    const st = document.getElementById('skeletonStatus');
    if (st) st.textContent = text;
}

/* ================================================================
   FETCH / EXTRACT (Home Page with URL Query persistence)
================================================================ */
async function fetchData(updateUrl = true) {
    const urlInput = document.getElementById('spotifyUrl');
    const btn      = document.getElementById('searchBtn');
    const card     = document.getElementById('resultCard');
    const errorBox = document.getElementById('errorBox');
    const url      = (urlInput ? urlInput.value.trim() : '');

    if (!url) { showError('Please enter a Spotify URL'); return; }
    if (!url.includes('spotify.com')) { showError('Please enter a valid Spotify URL'); return; }

    if (updateUrl) {
        const newUrl = `${window.location.pathname}?url=${encodeURIComponent(url)}`;
        window.history.pushState({ url }, '', newUrl);
    }

    hideElements([card, errorBox]);
    showSkeleton('Connecting to Spotify…');
    if (btn) {
        btn.disabled = true;
        btn.classList.add('btn-loading');
        btn.innerHTML = `
            <span class="btn-spinner-anim">
                <span class="btn-mini-equalizer">
                    <span></span><span></span><span></span><span></span>
                </span>
                <span>Extracting Data…</span>
            </span>`;
    }

    const ct = url.includes('/track/')    ? 'track'
             : url.includes('/album/')    ? 'album'
             : url.includes('/playlist/') ? 'playlist'
             : url.includes('/artist/')   ? 'artist'
             : url.includes('/show/')     ? 'show'
             : url.includes('/episode/')  ? 'episode'
             : 'content';

    const statusMap = {
        track:    'Fetching track metadata…',
        album:    'Fetching album & tracks…',
        playlist: 'Fetching playlist & tracks…',
        artist:   'Fetching artist top tracks…',
        show:     'Fetching podcast episodes…',
        episode:  'Fetching episode details…',
        content:  'Fetching Spotify data…',
    };

    updateSkeletonStatus(statusMap[ct]);
    setTimeout(() => updateSkeletonStatus('Resolving media embeds & links…'), 1800);

    try {
        const response = await fetch('/extract', {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({ url })
        });
        const data = await response.json();

        if (response.ok) {
            currentData = data;
            displayResult(data);
            showElements([card]);
        } else {
            showError(data.error || 'An unknown error occurred');
        }
    } catch (err) {
        showError('Server connection failed. Please try again.');
    } finally {
        hideSkeleton();
        if (btn) {
            btn.disabled = false;
            btn.classList.remove('btn-loading');
            btn.innerHTML = '<i class="bi bi-lightning-charge-fill me-2"></i>Extract Data';
        }
    }
}

/* ================================================================
   DISPLAY RESULT (Home Page)
================================================================ */
function displayResult(data) {
    const ct = data.content_type || 'track';

    const badgeEl = document.getElementById('contentType');
    if (badgeEl) {
        const badgeCls = { track:'badge-track', album:'badge-album', playlist:'badge-playlist', artist:'badge-artist', show:'badge-show', episode:'badge-episode' };
        badgeEl.textContent = ct.charAt(0).toUpperCase() + ct.slice(1);
        badgeEl.className   = `content-badge ms-2 ${badgeCls[ct] || 'badge-track'}`;
    }

    const img = document.getElementById('resImage');
    if (img) img.src = data.image_url || 'https://via.placeholder.com/300';

    setText('resTitle', data.title || 'Unknown');
    const descParts = [];
    if (data.artist)       descParts.push(data.artist);
    if (data.release_date) descParts.push(data.release_date);
    if (data.duration)     descParts.push(data.duration);
    if (data.followers)    descParts.push(data.followers.toLocaleString() + ' followers');
    if (data.tracks_count) descParts.push(data.tracks_count + ' tracks');
    setText('resDesc', descParts.join(' • ') || data.description || '');

    const spotUrl = data.spotify_url || data.track_url || data.album_url || data.artist_url || data.playlist_url || data.episode_url || data.show_url || '';
    window._currentResultSpotifyUrl = spotUrl;
    const linkEl  = document.getElementById('resLink');
    if (linkEl) linkEl.href = spotUrl || '#';

    // Spotify Embed button
    const spotEmbedBtn = document.getElementById('spotifyEmbedBtn');
    if (spotEmbedBtn) {
        if (data.spotify_embed_url) {
            spotEmbedBtn.style.display = 'inline-flex';
            spotEmbedBtn.onclick = () => openSpotifyEmbed(data.spotify_embed_url, data.title, spotUrl);
        } else {
            spotEmbedBtn.style.display = 'none';
        }
    }

    // Store YouTube URL for home result card
    window._currentResultYtUrl = data.youtube_url || '';
    const shareYtBtn = document.getElementById('shareYouTubeBtn');
    if (shareYtBtn) {
        shareYtBtn.style.display = data.youtube_url ? 'inline-flex' : 'none';
    }

    // YouTube Embed button
    const ytEmbedBtn = document.getElementById('youtubeEmbedBtn');
    if (ytEmbedBtn) {
        if ((ct === 'track' || ct === 'episode') && data.youtube_url) {
            ytEmbedBtn.style.display = 'inline-flex';
            const vidId = extractYouTubeId(data.youtube_url);
            const embedUrl = vidId ? `https://www.youtube-nocookie.com/embed/${vidId}?autoplay=1` : null;
            ytEmbedBtn.onclick = () => {
                if (embedUrl) openYouTubeEmbed(embedUrl, data.title, data.youtube_url);
                else previewYouTube(`${data.title} ${data.artist || ''}`, data.title, data.youtube_url);
            };
        } else if (ct === 'track' || ct === 'episode') {
            ytEmbedBtn.style.display = 'inline-flex';
            ytEmbedBtn.onclick = () => previewYouTube(`${data.title} ${data.artist || ''}`, data.title);
        } else {
            ytEmbedBtn.style.display = 'none';
        }
    }

    // Lyrics button
    const lyricsBtn = document.getElementById('lyricsBtn');
    if (lyricsBtn) {
        if (ct === 'track') {
            lyricsBtn.style.display = 'inline-flex';
            lyricsBtn.onclick = () => findLyrics(data.title, data.artist || '');
        } else {
            lyricsBtn.style.display = 'none';
        }
    }

    // Collection tracks
    const tracks   = data.tracks   || [];
    const episodes = data.episodes || [];
    const items    = tracks.length ? tracks : episodes;

    const listSection = document.getElementById('playlistSongs');
    const listEl      = document.getElementById('songsList');

    if (items.length && listSection && listEl) {
        listEl.innerHTML = '';
        items.forEach((item, idx) => renderTrackItem(listEl, item, idx + 1, ct));
        listSection.classList.remove('d-none');

        const countEl = document.getElementById('trackCountHeader');
        if (countEl) countEl.textContent = `${items.length} ${tracks.length ? 'tracks' : 'episodes'}`;
    } else if (listSection) {
        listSection.classList.add('d-none');
    }

    currentData = data;
}

function renderTrackItem(container, item, idx, parentType) {
    const el    = document.createElement('div');
    el.className = 'song-item d-flex align-items-center gap-3';

    const title    = item.title || item.name || 'Unknown';
    const artist   = item.artist || '';
    const duration = item.duration || '';
    const thumb    = item.image_url || '';
    const trackUrl = item.track_url || item.episode_url || '';
    const ytEmbed  = item.youtube_embed_url || '';
    const ytUrl    = item.youtube_url || '';

    // Resolve Spotify embed URL — use provided or derive from episode/track URL
    let embedUrl = item.spotify_embed_url || '';
    if (!embedUrl && trackUrl) {
        const m = trackUrl.match(/open\.spotify\.com\/(track|episode|show)\/([A-Za-z0-9]+)/);
        if (m) {
            const cType = m[1];
            const cId   = m[2];
            embedUrl = (cType === 'episode' || cType === 'show')
                ? `https://open.spotify.com/embed/${cType}/${cId}/video?utm_source=generator`
                : `https://open.spotify.com/embed/${cType}/${cId}?utm_source=generator&theme=0`;
        }
    }

    let finalYtEmbed = ytEmbed;
    if (!finalYtEmbed && ytUrl) {
        const vid = extractYouTubeId(ytUrl);
        if (vid) finalYtEmbed = `https://www.youtube-nocookie.com/embed/${vid}?autoplay=1`;
    }

    el.innerHTML = `
        <div class="song-number">${idx}</div>
        ${thumb ? `<img src="${escHtml(thumb)}" class="track-thumb" alt="" loading="lazy">` : ''}
        <div class="flex-grow-1 overflow-hidden">
            <div class="fw-bold text-truncate">${escHtml(title)}</div>
            <div class="text-secondary small text-truncate">${escHtml(artist)}</div>
        </div>
        <div class="text-secondary small me-2 d-none d-sm-block">${escHtml(duration)}</div>
        <div class="track-actions">
            ${embedUrl ? `<button class="btn-icon spotify" title="Spotify Player"
                            onclick="event.stopPropagation(); openSpotifyEmbed('${escHtml(embedUrl)}', '${escHtml(title).replace(/'/g,'\\\'')}', '${escHtml(trackUrl).replace(/'/g,'\\\'')}')"><i class="bi bi-spotify"></i></button>` : ''}
            <button class="btn-icon youtube" title="YouTube Video Preview"
                onclick="event.stopPropagation(); ${finalYtEmbed ? `openYouTubeEmbed('${escHtml(finalYtEmbed)}', '${escHtml(title).replace(/'/g,'\\\'')}', '${escHtml(ytUrl).replace(/'/g,'\\\'')}')` : `previewYouTube('${escHtml(title).replace(/'/g,'\\\'')} ${escHtml(artist).replace(/'/g,'\\\'')}', '${escHtml(title).replace(/'/g,'\\\'')}', '${escHtml(ytUrl).replace(/'/g,'\\\'')}')`}">
                <i class="bi bi-youtube"></i>
            </button>
            ${(parentType !== 'show') ? `<button class="btn-icon lyrics" title="Find Lyrics"
                                onclick="event.stopPropagation(); findLyrics('${escHtml(title).replace(/'/g,'\\\'')}', '${escHtml(artist).replace(/'/g,'\\\'')}')"><i class="bi bi-music-note-beamed"></i></button>` : ''}
        </div>
    `;
    container.appendChild(el);
}

/* ================================================================
   SEARCH CATALOG (with URL Query persistence)
================================================================ */
async function searchSpotify(updateUrl = true) {
    const inputEl  = document.getElementById('searchInput');
    const btn      = document.getElementById('searchBtn2');
    const errorBox = document.getElementById('searchError');
    const query    = inputEl ? inputEl.value.trim() : '';

    if (!query) { showSearchError('Please enter a search query.'); return; }

    if (updateUrl) {
        const newUrl = `${window.location.pathname}?q=${encodeURIComponent(query)}&tab=${activeSearchTab}`;
        window.history.pushState({ q: query, tab: activeSearchTab }, '', newUrl);
    }

    hideElements([errorBox]);
    showSearchSkeleton();
    if (btn) {
        btn.disabled = true;
        btn.classList.add('btn-loading');
        btn.innerHTML = `
            <span class="btn-spinner-anim">
                <span class="btn-mini-equalizer">
                    <span></span><span></span><span></span><span></span>
                </span>
                <span>Searching Spotify…</span>
            </span>`;
    }

    try {
        const resp = await fetch('/search', {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({ query })
        });
        const data = await resp.json();

        if (resp.ok) {
            renderSearchResults(data);
        } else {
            showSearchError(data.error || 'Search failed.');
        }
    } catch (e) {
        showSearchError('Network error. Please try again.');
    } finally {
        hideSearchSkeleton();
        if (btn) {
            btn.disabled = false;
            btn.classList.remove('btn-loading');
            btn.innerHTML = '<i class="bi bi-search me-2"></i>Search';
        }
    }
}

function renderSearchResults(data) {
    const resultsEl = document.getElementById('searchResults');
    if (!resultsEl) return;
    resultsEl.classList.remove('d-none');

    window._searchData = data;
    switchSearchTab(activeSearchTab, false);
}

function switchSearchTab(tab, updateUrl = true) {
    activeSearchTab = tab;
    window._searchData = window._searchData || {};
    const data = window._searchData;

    const inputEl = document.getElementById('searchInput');
    const query   = inputEl ? inputEl.value.trim() : '';
    if (updateUrl && query) {
        const newUrl = `${window.location.pathname}?q=${encodeURIComponent(query)}&tab=${tab}`;
        window.history.replaceState({ q: query, tab }, '', newUrl);
    }

    document.querySelectorAll('.search-tab-btn').forEach(b => {
        b.classList.toggle('active', b.dataset.tab === tab);
    });

    const gridEl = document.getElementById('searchGrid');
    if (!gridEl) return;
    gridEl.innerHTML = '';

    const tabMap = {
        tracks:    { block: data.searched_tracks,    key: 'tracks',    render: renderTrackCard    },
        albums:    { block: data.searched_albums,    key: 'albums',    render: renderAlbumCard    },
        artists:   { block: data.searched_artists,   key: 'artists',   render: renderArtistCard   },
        playlists: { block: data.searched_playlists, key: 'playlists', render: renderPlaylistCard  },
        shows:     { block: data.searched_shows,     key: 'shows',     render: renderShowCard     },
    };

    const info = tabMap[tab];
    if (!info || !info.block) return;

    const items = info.block[info.key] || [];
    if (!items.length) {
        gridEl.innerHTML = '<p class="text-secondary text-center py-4 col-12">No results found in this category.</p>';
        return;
    }
    items.forEach(item => gridEl.appendChild(info.render(item)));
}

function renderTrackCard(item) {
    const card = makeSearchCard(item.image_url, item.title, item.artist, item.duration, item.track_url);
    const actions = card.querySelector('.search-result-actions');

    if (item.spotify_embed_url) {
        actions.appendChild(makeBadgeBtn('bi-spotify', 'spotify', 'Spotify',
            () => openSpotifyEmbed(item.spotify_embed_url, item.title, item.track_url)));
    }
    actions.appendChild(makeBadgeBtn('bi-youtube', 'youtube', 'YouTube',
        () => previewYouTube(`${item.title} ${item.artist || ''}`, item.title, item.youtube_url)));

    actions.appendChild(makeBadgeBtn('bi-music-note-beamed', 'lyrics-purple', 'Lyrics',
        () => findLyrics(item.title, item.artist || '')));

    actions.appendChild(makeBadgeBtn('bi-info-circle', 'details', 'Details',
        () => openSearchDetail(item.track_url, item.title)));

    return card;
}

function renderAlbumCard(item) {
    const card = makeSearchCard(item.image_url, item.title, 'Album', '', item.album_url);
    const actions = card.querySelector('.search-result-actions');
    
    if (item.spotify_embed_url) {
        actions.appendChild(makeBadgeBtn('bi-spotify', 'spotify', 'Spotify',
            () => openSpotifyEmbed(item.spotify_embed_url, item.title, item.album_url)));
    }

    actions.appendChild(makeBadgeBtn('bi-music-note-list', 'details', 'View Tracks',
        () => openSearchDetail(item.album_url, item.title), !item.spotify_embed_url));

    return card;
}

function renderArtistCard(item) {
    const card = makeSearchCard(item.image_url, item.title, 'Artist', '', item.artist_url);
    const actions = card.querySelector('.search-result-actions');
    
    if (item.spotify_embed_url) {
        actions.appendChild(makeBadgeBtn('bi-spotify', 'spotify', 'Spotify',
            () => openSpotifyEmbed(item.spotify_embed_url, item.title, item.artist_url)));
    }

    actions.appendChild(makeBadgeBtn('bi-person-lines-fill', 'details', 'Top Tracks',
        () => openSearchDetail(item.artist_url, item.title), !item.spotify_embed_url));

    return card;
}

function renderPlaylistCard(item) {
    const card = makeSearchCard(item.image_url, item.title, 'Playlist', '', item.playlist_url);
    const actions = card.querySelector('.search-result-actions');
    
    if (item.spotify_embed_url) {
        actions.appendChild(makeBadgeBtn('bi-spotify', 'spotify', 'Spotify',
            () => openSpotifyEmbed(item.spotify_embed_url, item.title, item.playlist_url)));
    }

    actions.appendChild(makeBadgeBtn('bi-music-note-list', 'details', 'View Tracks',
        () => openSearchDetail(item.playlist_url, item.title), !item.spotify_embed_url));

    return card;
}

function renderShowCard(item) {
    const card = makeSearchCard(item.image_url, item.title, 'Podcast', '', item.show_url);
    const actions = card.querySelector('.search-result-actions');
    
    if (item.spotify_embed_url) {
        actions.appendChild(makeBadgeBtn('bi-spotify', 'spotify', 'Spotify',
            () => openSpotifyEmbed(item.spotify_embed_url, item.title, item.show_url)));
    }

    actions.appendChild(makeBadgeBtn('bi-broadcast', 'details', 'Episodes',
        () => openSearchDetail(item.show_url, item.title), !item.spotify_embed_url));

    return card;
}

function makeSearchCard(imgSrc, title, sub, extra, targetUrl) {
    const card = document.createElement('div');
    card.className = 'search-result-card';
    card.onclick = () => {
        if (targetUrl) openSearchDetail(targetUrl, title);
    };
    card.innerHTML = `
        <div style="position: relative; overflow: hidden;">
            <img src="${imgSrc || 'https://via.placeholder.com/300x300?text=No+Image'}" alt="" loading="lazy"
                 onerror="this.src='https://via.placeholder.com/300x300?text=No+Image'">
            <div class="search-card-hover-overlay">
                <i class="bi bi-eye-fill fs-3 text-white"></i>
                <span class="small text-white mt-1">View Details</span>
            </div>
        </div>
        <div class="search-result-info">
            <div class="search-result-title" title="${escHtml(title || '')}">${escHtml(title || 'Unknown')}</div>
            <div class="search-result-sub">${escHtml(sub || '')}${extra ? ' • ' + escHtml(extra) : ''}</div>
            <div class="search-result-actions" onclick="event.stopPropagation()"></div>
        </div>`;
    return card;
}

function makeBadgeBtn(icon, colorClass, label, onClick, isFullWidth = false) {
    const btn = document.createElement('button');
    const colorMap = {
        spotify:       'btn-outline-success',
        youtube:       'btn-outline-danger',
        'lyrics-purple': 'btn-outline-secondary',
        details:       'btn-success',
    };
    btn.className = `btn ${colorMap[colorClass] || 'btn-outline-secondary'} btn-sm${isFullWidth ? ' btn-full' : ''}`;
    btn.innerHTML = `<i class="bi ${icon} me-1"></i><span>${label}</span>`;
    btn.onclick   = e => { e.stopPropagation(); onClick(); };
    return btn;
}

function showSearchSkeleton() {
    const sk = document.getElementById('searchSkeleton');
    const gr = document.getElementById('searchResults');
    if (sk) sk.classList.remove('d-none');
    if (gr) gr.classList.add('d-none');
}
function hideSearchSkeleton() {
    const sk = document.getElementById('searchSkeleton');
    if (sk) sk.classList.add('d-none');
}
function showSearchError(msg) {
    const el = document.getElementById('searchError');
    if (el) { el.textContent = msg; el.classList.remove('d-none'); }
}

/* ================================================================
   ITEM DETAIL SCREEN (with URL Query persistence)
================================================================ */
async function openSearchDetail(url, fallbackTitle, updateUrl = true) {
    if (!url) return;

    const mainScreen   = document.getElementById('searchMainScreen');
    const detailScreen = document.getElementById('searchDetailScreen');
    const skeleton     = document.getElementById('detailSkeleton');
    const content      = document.getElementById('detailContent');
    const errorBox     = document.getElementById('detailErrorBox');
    const badge        = document.getElementById('detailContentTypeBadge');

    if (!detailScreen) return;

    if (updateUrl) {
        const inputEl = document.getElementById('searchInput');
        const query   = inputEl ? inputEl.value.trim() : '';
        const newUrl  = `${window.location.pathname}?q=${encodeURIComponent(query)}&tab=${activeSearchTab}&detail=${encodeURIComponent(url)}`;
        window.history.pushState({ q: query, tab: activeSearchTab, detail: url }, '', newUrl);
    }

    if (mainScreen) mainScreen.classList.add('d-none');
    detailScreen.classList.remove('d-none');
    hideElements([content, errorBox]);
    showElements([skeleton]);
    window.scrollTo({ top: 0, behavior: 'smooth' });

    if (badge) badge.textContent = 'Loading Details…';

    try {
        const resp = await fetch('/extract', {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({ url })
        });
        const data = await resp.json();

        if (resp.ok) {
            currentDetailData = data;
            renderSearchDetailContent(data);
            hideElements([skeleton]);
            showElements([content]);
        } else {
            hideElements([skeleton]);
            if (errorBox) {
                errorBox.textContent = data.error || 'Failed to extract item details.';
                showElements([errorBox]);
            }
        }
    } catch (err) {
        hideElements([skeleton]);
        if (errorBox) {
            errorBox.textContent = 'Network error while fetching details.';
            showElements([errorBox]);
        }
    }
}

function closeSearchDetailScreen(updateUrl = true) {
    const mainScreen   = document.getElementById('searchMainScreen');
    const detailScreen = document.getElementById('searchDetailScreen');
    if (detailScreen) detailScreen.classList.add('d-none');
    if (mainScreen)   mainScreen.classList.remove('d-none');
    currentDetailData = null;

    if (updateUrl) {
        const inputEl = document.getElementById('searchInput');
        const query   = inputEl ? inputEl.value.trim() : '';
        const newUrl  = query
            ? `${window.location.pathname}?q=${encodeURIComponent(query)}&tab=${activeSearchTab}`
            : window.location.pathname;
        window.history.pushState({ q: query, tab: activeSearchTab }, '', newUrl);
    }

    window.scrollTo({ top: 0, behavior: 'smooth' });
}

function renderSearchDetailContent(data) {
    const ct = data.content_type || 'track';

    const topBadge = document.getElementById('detailContentTypeBadge');
    if (topBadge) {
        const topBadgeCls = { track:'badge-track', album:'badge-album', playlist:'badge-playlist', artist:'badge-artist', show:'badge-show', episode:'badge-episode' };
        topBadge.textContent = ct.toUpperCase();
        topBadge.className = `content-badge ${topBadgeCls[ct] || 'badge-track'}`;
    }

    const badgeEl = document.getElementById('detailBadgeType');
    if (badgeEl) {
        const badgeCls = { track:'badge-track', album:'badge-album', playlist:'badge-playlist', artist:'badge-artist', show:'badge-show', episode:'badge-episode' };
        badgeEl.textContent = ct.charAt(0).toUpperCase() + ct.slice(1);
        badgeEl.className   = `content-badge ms-2 ${badgeCls[ct] || 'badge-track'}`;
    }

    const img = document.getElementById('detailImage');
    if (img) img.src = data.image_url || 'https://via.placeholder.com/300';

    setText('detailTitle', data.title || 'Unknown');
    const descParts = [];
    if (data.artist)       descParts.push(data.artist);
    if (data.release_date) descParts.push(data.release_date);
    if (data.duration)     descParts.push(data.duration);
    if (data.followers)    descParts.push(data.followers.toLocaleString() + ' followers');
    if (data.tracks_count) descParts.push(data.tracks_count + ' tracks');
    setText('detailDesc', descParts.join(' • ') || data.description || '');

    const spotUrl = data.spotify_url || data.track_url || data.album_url || data.artist_url || data.playlist_url || data.episode_url || data.show_url || '';
    window._currentDetailSpotifyUrl = spotUrl;
    const linkEl  = document.getElementById('detailSpotifyLink');
    if (linkEl) linkEl.href = spotUrl || '#';

    // Spotify Embed Button
    const spotEmbedBtn = document.getElementById('detailSpotifyEmbedBtn');
    if (spotEmbedBtn) {
        if (data.spotify_embed_url) {
            spotEmbedBtn.style.display = 'inline-flex';
            spotEmbedBtn.onclick = () => openSpotifyEmbed(data.spotify_embed_url, data.title, spotUrl);
        } else {
            spotEmbedBtn.style.display = 'none';
        }
    }

    // Store YouTube URL for search detail card
    window._currentDetailYtUrl = data.youtube_url || '';
    const detailShareYtBtn = document.getElementById('detailShareYouTubeBtn');
    if (detailShareYtBtn) {
        detailShareYtBtn.style.display = data.youtube_url ? 'inline-flex' : 'none';
    }

    // YouTube Embed Button (Tracks & Episodes only)
    const ytEmbedBtn = document.getElementById('detailYouTubeEmbedBtn');
    if (ytEmbedBtn) {
        if (ct === 'track' || ct === 'episode') {
            ytEmbedBtn.style.display = 'inline-flex';
            ytEmbedBtn.onclick = () => previewYouTube(`${data.title} ${data.artist || ''}`, data.title, data.youtube_url);
        } else {
            ytEmbedBtn.style.display = 'none';
        }
    }

    // Lyrics Button
    const lyricsBtn = document.getElementById('detailLyricsBtn');
    if (lyricsBtn) {
        if (ct === 'track') {
            lyricsBtn.style.display = 'inline-flex';
            lyricsBtn.onclick = () => findLyrics(data.title, data.artist || '');
        } else {
            lyricsBtn.style.display = 'none';
        }
    }

    // Collection tracks
    const tracks   = data.tracks   || [];
    const episodes = data.episodes || [];
    const items    = tracks.length ? tracks : episodes;

    const listSection = document.getElementById('detailTracksSection');
    const listEl      = document.getElementById('detailSongsList');

    if (items.length && listSection && listEl) {
        listEl.innerHTML = '';
        items.forEach((item, idx) => renderTrackItem(listEl, item, idx + 1, ct));
        listSection.classList.remove('d-none');

        const countEl = document.getElementById('detailTrackCount');
        if (countEl) countEl.textContent = `${items.length} ${tracks.length ? 'tracks' : 'episodes'}`;
    } else if (listSection) {
        listSection.classList.add('d-none');
    }
}

function shareDetailData() {
    if (!currentDetailData) return;
    const shareUrl = currentDetailData.track_url || currentDetailData.album_url || currentDetailData.playlist_url || currentDetailData.artist_url || '';
    if (navigator.share) {
        navigator.share({ title: currentDetailData.title, url: shareUrl });
    } else {
        navigator.clipboard.writeText(shareUrl).then(() => showToast('Link copied!', 'success'));
    }
}

/* ================================================================
   DYNAMIC YOUTUBE PREVIEW HELPER
================================================================ */
async function previewYouTube(query, title, knownYtUrl = '') {
    showToast('Locating YouTube video…', 'info');
    try {
        const resp = await fetch('/get-yt-link-by-music-name', {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({ music_name: query })
        });
        const data = await resp.json();

        if (resp.ok && data.embed_url) {
            openYouTubeEmbed(data.embed_url, title || query, data.youtube_url || knownYtUrl);
        } else {
            showToast('No YouTube video found.', 'error');
        }
    } catch (e) {
        showToast('Failed to fetch YouTube link.', 'error');
    }
}

/* ================================================================
   SPOTIFY EMBED MODAL (with Open on Spotify button)
================================================================ */
function openSpotifyEmbed(embedUrl, title, spotifyUrl = '') {
    const overlay = document.getElementById('spotifyEmbedOverlay');
    const iframe  = document.getElementById('spotifyEmbedIframe');
    const titleEl = document.getElementById('spotifyEmbedTitle');
    const openBtn = document.getElementById('spotifyOpenLink');
    const inner   = overlay ? overlay.querySelector('.spotify-embed-inner') : null;

    if (!overlay || !iframe) return;

    // Detect playlist, podcast/show or episode embed vs track embed
    const isExpandedLayout = embedUrl.includes('/video') || embedUrl.includes('/playlist/') || embedUrl.includes('/show/') || embedUrl.includes('/album/');

    iframe.src = embedUrl;
    iframe.style.height = '351px';

    // Optimized modal width for playlists, shows, episodes & collections
    if (inner) {
        inner.style.maxWidth = isExpandedLayout ? '720px' : '560px';
    }

    if (titleEl) titleEl.textContent = title || 'Spotify Player';
    
    // Direct open link on modal header
    const finalSpotifyUrl = spotifyUrl || embedUrl.replace('/embed/', '/').replace('/video', '').split('?')[0];
    if (openBtn) openBtn.href = finalSpotifyUrl;

    overlay.classList.remove('d-none');
    document.body.style.overflow = 'hidden';
}

function closeSpotifyEmbed() {
    const overlay = document.getElementById('spotifyEmbedOverlay');
    const iframe  = document.getElementById('spotifyEmbedIframe');
    if (overlay) overlay.classList.add('d-none');
    if (iframe)  iframe.src = '';
    document.body.style.overflow = '';
}

/* ================================================================
   YOUTUBE EMBED MODAL (with Open on YouTube button)
================================================================ */
function openYouTubeEmbed(embedUrl, title, youtubeUrl = '') {
    const overlay = document.getElementById('youtubeEmbedOverlay');
    const iframe  = document.getElementById('youtubeEmbedIframe');
    const titleEl = document.getElementById('youtubeEmbedTitle');
    const openBtn = document.getElementById('youtubeOpenLink');

    if (!overlay || !iframe) return;
    iframe.src = embedUrl;
    if (titleEl) titleEl.textContent = title || 'YouTube Player';

    // Direct open link on modal header
    let finalYtUrl = youtubeUrl;
    if (!finalYtUrl) {
        const vid = extractYouTubeId(embedUrl);
        if (vid) finalYtUrl = `https://www.youtube.com/watch?v=${vid}`;
    }
    if (openBtn) openBtn.href = finalYtUrl || '#';

    overlay.classList.remove('d-none');
    document.body.style.overflow = 'hidden';
}

function closeYouTubeEmbed() {
    const overlay = document.getElementById('youtubeEmbedOverlay');
    const iframe  = document.getElementById('youtubeEmbedIframe');
    if (overlay) overlay.classList.add('d-none');
    if (iframe)  iframe.src = '';
    document.body.style.overflow = '';
}

function closeEmbedModal() {
    closeSpotifyEmbed();
    closeYouTubeEmbed();
}

/* ================================================================
   SHARE HELPERS (Spotify & YouTube Link Sharing)
================================================================ */
async function shareSpotifyLink(url, title = 'Spotify Content') {
    let finalUrl = url;
    if (!finalUrl || finalUrl === '#' || finalUrl === 'undefined' || !finalUrl.includes('open.spotify.com')) {
        finalUrl = window._currentDetailSpotifyUrl || window._currentResultSpotifyUrl || '';
    }
    if (!finalUrl || !finalUrl.includes('open.spotify.com')) {
        showToast('No Spotify link available to share.', 'danger');
        return;
    }
    if (navigator.share && /mobile|android|iphone|ipad/i.test(navigator.userAgent)) {
        try {
            await navigator.share({
                title: title,
                text: `Listen to "${title}" on Spotify`,
                url: finalUrl
            });
            showToast('Spotify link shared!', 'success');
            return;
        } catch (e) {
            if (e.name === 'AbortError') return;
        }
    }
    copyToClipboard(finalUrl);
    showToast('Spotify link copied to clipboard!', 'success');
}

async function shareYouTubeLink(url, title = 'YouTube Video') {
    if (!url || url === '#' || url === 'undefined') {
        showToast('No YouTube link available to share.', 'danger');
        return;
    }
    if (navigator.share && /mobile|android|iphone|ipad/i.test(navigator.userAgent)) {
        try {
            await navigator.share({
                title: title,
                text: `Watch "${title}" on YouTube`,
                url: url
            });
            showToast('YouTube link shared!', 'success');
            return;
        } catch (e) {
            if (e.name === 'AbortError') return;
        }
    }
    copyToClipboard(url);
    showToast('YouTube link copied to clipboard!', 'success');
}

async function sharePageLink(url, title = 'SpotScrape Music') {
    const finalUrl = url || window.location.href;
    if (navigator.share && /mobile|android|iphone|ipad/i.test(navigator.userAgent)) {
        try {
            await navigator.share({
                title: `SpotScrape — ${title}`,
                text: `View "${title}" on SpotScrape`,
                url: finalUrl
            });
            showToast('SpotScrape page link shared!', 'success');
            return;
        } catch (e) {
            if (e.name === 'AbortError') return;
        }
    }
    copyToClipboard(finalUrl);
    showToast('SpotScrape page link copied to clipboard!', 'success');
}

function shareSpotifyLinkFromModal() {
    const openBtn = document.getElementById('spotifyOpenLink');
    const titleEl = document.getElementById('spotifyEmbedTitle');
    const url     = openBtn ? openBtn.href : '';
    const title   = titleEl ? titleEl.textContent : 'Spotify Content';
    shareSpotifyLink(url, title);
}

function shareYouTubeLinkFromModal() {
    const openBtn = document.getElementById('youtubeOpenLink');
    const titleEl = document.getElementById('youtubeEmbedTitle');
    const url     = openBtn ? openBtn.href : '';
    const title   = titleEl ? titleEl.textContent : 'YouTube Video';
    shareYouTubeLink(url, title);
}

/* ── Universal Share Hub Modal Functions ───────────────────────── */
function openShareModal({ spotifyUrl = '', youtubeUrl = '', pageUrl = '', title = '' } = {}) {
    const overlay    = document.getElementById('shareModalOverlay');
    const titleEl    = document.getElementById('shareModalTitle');
    const spotInput  = document.getElementById('shareSpotifyUrlInput');
    const ytInput    = document.getElementById('shareYtUrlInput');
    const ytCard     = document.getElementById('shareYtOptionCard');
    const pageInput  = document.getElementById('sharePageUrlInput');

    if (!overlay) return;

    let validSpotifyUrl = spotifyUrl;
    if (!validSpotifyUrl || !validSpotifyUrl.includes('open.spotify.com')) {
        validSpotifyUrl = window._currentDetailSpotifyUrl || window._currentResultSpotifyUrl || '';
    }

    if (titleEl) titleEl.textContent = title ? `Share "${title}"` : 'Share Options';
    if (spotInput) spotInput.value = validSpotifyUrl;
    if (pageInput) pageInput.value = pageUrl || window.location.href;

    if (ytInput && ytCard) {
        if (youtubeUrl) {
            ytInput.value = youtubeUrl;
            ytCard.style.display = 'block';
        } else {
            ytInput.value = '';
            ytCard.style.display = 'none';
        }
    }

    overlay.classList.remove('d-none');
    document.body.style.overflow = 'hidden';
}

function closeShareModal() {
    const overlay = document.getElementById('shareModalOverlay');
    if (overlay) overlay.classList.add('d-none');
    document.body.style.overflow = '';
}

let currentLyricsSearchData = null;
let currentLyricsSearchMode = 'synced';

async function searchLyricsByName(updateUrl = true) {
    const titleInput = document.getElementById('lyricsSearchSong');
    const artistInput = document.getElementById('lyricsSearchArtist');
    const errorBox = document.getElementById('lyricsSearchError');
    const resultBox = document.getElementById('lyricsSearchResult');
    const button = document.getElementById('lyricsSearchBtn');
    const title = (titleInput ? titleInput.value.trim() : '');
    const artist = (artistInput ? artistInput.value.trim() : '');

    if (!title) {
        if (errorBox) {
            errorBox.classList.remove('d-none');
            errorBox.textContent = 'Please enter a song name.';
        }
        return;
    }

    if (updateUrl) {
        const params = new URLSearchParams();
        params.set('song', title);
        if (artist) params.set('artist', artist);
        params.set('mode', currentLyricsSearchMode);
        const url = `${window.location.pathname}?${params.toString()}`;
        window.history.pushState({ song: title, artist, mode: currentLyricsSearchMode }, '', url);
    }

    if (errorBox) {
        errorBox.classList.add('d-none');
        errorBox.textContent = '';
    }

    if (button) {
        button.disabled = true;
        button.innerHTML = '<span class="spinner-border spinner-border-sm me-2" role="status" aria-hidden="true"></span>Searching…';
    }

    if (resultBox) {
        resultBox.classList.add('d-none');
    }

    try {
        const resp = await fetch('/lyrics', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ title, artist })
        });
        const data = await resp.json();

        if (!resp.ok || !(data.text_lyrics || data.lyrics)) {
            if (errorBox) {
                errorBox.classList.remove('d-none');
                errorBox.textContent = data.error || 'Lyrics not found for that song.';
            }
            return;
        }

        currentLyricsSearchData = data;
        currentLyricsSearchMode = 'synced';
        renderLyricsSearchResult(data);
    } catch (e) {
        if (errorBox) {
            errorBox.classList.remove('d-none');
            errorBox.textContent = 'Network error while searching for lyrics.';
        }
    } finally {
        if (button) {
            button.disabled = false;
            button.innerHTML = '<i class="bi bi-music-note-beamed me-2"></i>Search Lyrics';
        }
    }
}

function renderLyricsSearchResult(data) {
    const resultBox = document.getElementById('lyricsSearchResult');
    const titleEl = document.getElementById('lyricsSearchResultTitle');
    const bodyEl = document.getElementById('lyricsSearchBody');
    const syncedBtn = document.getElementById('lyricsSearchSyncedBtn');
    const plainBtn = document.getElementById('lyricsSearchPlainBtn');

    if (!resultBox || !titleEl || !bodyEl) return;

    titleEl.textContent = data.title || 'Lyrics';
    resultBox.classList.remove('d-none');

    if (syncedBtn) syncedBtn.classList.toggle('active', currentLyricsSearchMode === 'synced');
    if (plainBtn) plainBtn.classList.toggle('active', currentLyricsSearchMode === 'plain');

    const content = currentLyricsSearchMode === 'synced'
        ? (data.lyrics || data.text_lyrics || '')
        : (data.text_lyrics || data.lyrics || '');

    bodyEl.innerHTML = '';
    const pre = document.createElement('pre');
    pre.className = 'mb-0';
    pre.style.whiteSpace = 'pre-wrap';
    pre.style.wordBreak = 'break-word';
    pre.style.lineHeight = '1.9';
    pre.style.fontSize = currentLyricsSearchMode === 'synced' ? '0.95rem' : '1.05rem';
    pre.style.fontFamily = currentLyricsSearchMode === 'synced' ? 'ui-monospace, SFMono-Regular, Menlo, monospace' : 'inherit';
    pre.textContent = content || 'No lyrics available.';
    bodyEl.appendChild(pre);
}

function switchLyricsSearchMode(mode) {
    if (!currentLyricsSearchData) return;
    currentLyricsSearchMode = mode;

    const params = new URLSearchParams(window.location.search);
    params.set('mode', mode);
    const url = `${window.location.pathname}?${params.toString()}`;
    window.history.replaceState({ song: params.get('song'), artist: params.get('artist'), mode }, '', url);

    renderLyricsSearchResult(currentLyricsSearchData);
}

async function downloadLyricsSearchFile(fmt) {
    if (!currentLyricsSearchData) return;
    try {
        const resp = await fetch('/lyrics/download', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                format: fmt,
                title: currentLyricsSearchData.title,
                lyrics: currentLyricsSearchData.lyrics,
                text_lyrics: currentLyricsSearchData.text_lyrics
            })
        });
        const blob = await resp.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = (currentLyricsSearchData.title || 'lyrics').replace(/[^ -\u007F\w\s-]/g, '').trim().replace(/\s+/g, '_').toLowerCase() + '.' + fmt;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
        showToast(`Lyrics downloaded as .${fmt}`, 'success');
    } catch (e) {
        showToast('Download failed.', 'error');
    }
}

function copyLyricsSearchResult() {
    if (!currentLyricsSearchData) return;
    const content = currentLyricsSearchMode === 'synced'
        ? (currentLyricsSearchData.lyrics || currentLyricsSearchData.text_lyrics)
        : (currentLyricsSearchData.text_lyrics || currentLyricsSearchData.lyrics);
    if (!content) {
        showToast('No lyrics content to copy', 'error');
        return;
    }
    copyToClipboard(content);
    showToast(currentLyricsSearchMode === 'synced' ? 'Synced lyrics copied to clipboard!' : 'Plain text lyrics copied to clipboard!', 'success');
}

function openShareModalFromResult() {
    const spotUrl = window._currentResultSpotifyUrl || '';
    const title   = document.getElementById('resTitle') ? document.getElementById('resTitle').textContent : '';
    const ytUrl   = window._currentResultYtUrl || '';
    openShareModal({ spotifyUrl: spotUrl, youtubeUrl: ytUrl, pageUrl: window.location.href, title: title });
}

function openShareModalFromDetail() {
    const spotUrl = window._currentDetailSpotifyUrl || '';
    const title   = document.getElementById('detailTitle') ? document.getElementById('detailTitle').textContent : '';
    const ytUrl   = window._currentDetailYtUrl || '';
    openShareModal({ spotifyUrl: spotUrl, youtubeUrl: ytUrl, pageUrl: window.location.href, title: title });
}

/* ================================================================
   LYRICS MODAL (with Synced vs Plain preview tabs and copy)
================================================================ */
async function findLyrics(title, artist) {
    const overlay  = document.getElementById('lyricsOverlay');
    const titleEl  = document.getElementById('lyricsModalTitle');
    const bodyEl   = document.getElementById('lyricsBody');
    const tabsBar  = document.getElementById('lyricsTabsBar');
    const dlBar    = document.getElementById('lyricsDownloadBar');
    if (!overlay) return;

    if (titleEl) titleEl.textContent = `${title}${artist ? ' — ' + artist : ''}`;
    if (bodyEl)  bodyEl.innerHTML    = '<div class="text-center py-5"><div class="spinner-border text-success" role="status"></div><p class="mt-3 text-secondary">Searching for lyrics…</p></div>';
    if (tabsBar) tabsBar.classList.add('d-none');
    if (dlBar)   dlBar.classList.add('d-none');
    overlay.classList.remove('d-none');
    document.body.style.overflow = 'hidden';

    try {
        const resp = await fetch('/lyrics', {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({ title, artist })
        });
        const data = await resp.json();

        if (resp.ok && (data.text_lyrics || data.lyrics)) {
            currentLyrics = data;
            if (tabsBar) tabsBar.classList.remove('d-none');
            if (dlBar)   dlBar.classList.remove('d-none');
            switchLyricsPreview('synced');
        } else {
            if (bodyEl) bodyEl.innerHTML = `<div class="text-center py-5 text-secondary"><i class="bi bi-emoji-frown fs-1 mb-3 d-block"></i>${escHtml(data.error || 'Lyrics not found.')}</div>`;
        }
    } catch (e) {
        if (bodyEl) bodyEl.innerHTML = '<div class="text-center py-5 text-secondary"><i class="bi bi-wifi-off fs-1 mb-3 d-block"></i>Network error.</div>';
    }
}

function switchLyricsPreview(mode) {
    activeLyricsPreview = mode;
    const bodyEl   = document.getElementById('lyricsBody');
    const tabSync  = document.getElementById('tabSyncedLyrics');
    const tabPlain = document.getElementById('tabPlainLyrics');

    if (tabSync)  tabSync.classList.toggle('active', mode === 'synced');
    if (tabPlain) tabPlain.classList.toggle('active', mode === 'plain');

    if (!currentLyrics || !bodyEl) return;

    if (mode === 'synced') {
        const lrcContent = currentLyrics.lyrics || currentLyrics.text_lyrics || '';
        bodyEl.innerHTML = `<div class="lyrics-text font-monospace" style="font-size: 0.95rem; line-height: 1.9; text-align: left;">${escHtml(lrcContent).replace(/\n/g, '<br>')}</div>`;
    } else {
        const plainContent = currentLyrics.text_lyrics || currentLyrics.lyrics || '';
        bodyEl.innerHTML = `<div class="lyrics-text" style="font-size: 1.05rem; line-height: 2.1; text-align: center;">${escHtml(plainContent).replace(/\n/g, '<br>')}</div>`;
    }
}

function copyActiveLyrics() {
    if (!currentLyrics) return;
    const contentToCopy = (activeLyricsPreview === 'synced')
        ? (currentLyrics.lyrics || currentLyrics.text_lyrics)
        : (currentLyrics.text_lyrics || currentLyrics.lyrics);

    if (!contentToCopy) {
        showToast('No lyrics content to copy', 'error');
        return;
    }

    copyToClipboard(contentToCopy);
    showToast(
        activeLyricsPreview === 'synced' ? 'Synced LRC lyrics copied to clipboard!' : 'Plain text lyrics copied to clipboard!',
        'success'
    );
}

function closeLyricsModal() {
    const overlay = document.getElementById('lyricsOverlay');
    if (overlay) overlay.classList.add('d-none');
    document.body.style.overflow = '';
    currentLyrics = null;
}

async function downloadLyrics(fmt) {
    if (!currentLyrics) return;
    try {
        const resp = await fetch('/lyrics/download', {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({
                format:      fmt,
                title:       currentLyrics.title,
                lyrics:      currentLyrics.lyrics,
                text_lyrics: currentLyrics.text_lyrics
            })
        });
        const blob = await resp.blob();
        const url  = URL.createObjectURL(blob);
        const a    = document.createElement('a');
        a.href     = url;
        a.download = (currentLyrics.title || 'lyrics').replace(/[^\w\s-]/g,'').trim().replace(/\s+/g,'_').toLowerCase() + '.' + fmt;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
        showToast(`Lyrics downloaded as .${fmt}`, 'success');
    } catch (e) {
        showToast('Download failed.', 'error');
    }
}

/* ================================================================
   SHARE (Home & Detail Pages)
================================================================ */
function shareData() {
    openShareModalFromResult();
}

function shareDetailData() {
    openShareModalFromDetail();
}

/* ================================================================
   UTILITIES
================================================================ */
function showElements(els) { els.forEach(el => el && el.classList.remove('d-none')); }
function hideElements(els) { els.forEach(el => el && el.classList.add('d-none')); }
function setText(id, text) { const el = document.getElementById(id); if (el) el.textContent = text; }

function showError(message) {
    const errorBox  = document.getElementById('errorBox');
    const errorText = document.getElementById('errorText');
    if (errorText) errorText.textContent = message;
    else if (errorBox) errorBox.textContent = message;
    if (errorBox) errorBox.classList.remove('d-none');
}

function escHtml(str) {
    return String(str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function extractYouTubeId(url) {
    const m = String(url).match(/(?:v=|youtu\.be\/|embed\/)([A-Za-z0-9_-]{11})/);
    return m ? m[1] : null;
}

function copyToClipboard(text) {
    (navigator.clipboard
        ? navigator.clipboard.writeText(text)
        : Promise.reject()
    ).then(() => showToast('Copied to clipboard!','success'))
     .catch(() => {
        const ta = Object.assign(document.createElement('textarea'), { value: text, style:'position:fixed;top:0;left:0' });
        document.body.appendChild(ta); ta.select();
        try { document.execCommand('copy'); showToast('Copied to clipboard!','success'); } catch {}
        ta.remove();
    });
}

/* ================================================================
   TOAST NOTIFICATION
================================================================ */
function showToast(message, type = 'info') {
    let container = document.getElementById('toastContainer');
    if (!container) {
        container = document.createElement('div');
        container.id        = 'toastContainer';
        container.className = 'toast-container position-fixed bottom-0 end-0 p-3';
        container.style.zIndex = '99999';
        document.body.appendChild(container);
    }
    const toast = document.createElement('div');
    toast.className = `toast align-items-center text-white bg-${type === 'success' ? 'success' : type === 'error' ? 'danger' : 'info'} border-0`;
    toast.setAttribute('role','alert');
    toast.innerHTML = `
        <div class="d-flex">
            <div class="toast-body"><i class="bi bi-${type==='success'?'check-circle':type==='error'?'exclamation-triangle':'info-circle'} me-2"></i>${message}</div>
            <button type="button" class="btn-close btn-close-white me-2 m-auto" data-bs-dismiss="toast"></button>
        </div>`;
    container.appendChild(toast);
    new bootstrap.Toast(toast, { delay: 3000 }).show();
    toast.addEventListener('hidden.bs.toast', () => toast.remove());
}