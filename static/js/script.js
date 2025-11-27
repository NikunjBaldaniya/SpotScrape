let currentData = null;
let currentTheme = localStorage.getItem('theme') || 'system';

// Initialize theme on page load
document.addEventListener('DOMContentLoaded', function() {
    applyTheme(currentTheme);
    updateThemeDropdown();
    
    // Check for URL parameter and pre-fill
    const urlParams = new URLSearchParams(window.location.search);
    const prefilledUrl = urlParams.get('url');
    const urlInput = document.getElementById('spotifyUrl');
    
    if (prefilledUrl && urlInput) {
        urlInput.value = prefilledUrl;
        // Auto-fetch if URL is provided
        setTimeout(() => fetchData(), 500);
    }
    
    // Add enter key support for search
    if (urlInput) {
        urlInput.addEventListener('keypress', function(e) {
            if (e.key === 'Enter') {
                fetchData();
            }
        });
    }
    
    // Add debounced search for track filtering
    const trackSearch = document.getElementById('trackSearch');
    if (trackSearch) {
        trackSearch.addEventListener('input', debouncedFilter);
    }
});

// Theme Functions
function setTheme(theme) {
    currentTheme = theme;
    applyTheme(theme);
    localStorage.setItem('theme', theme);
    updateThemeDropdown();
}

function getSystemTheme() {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function applyTheme(theme) {
    const root = document.documentElement;
    const navThemeIcon = document.getElementById('navThemeIcon');
    
    let actualTheme = theme === 'system' ? getSystemTheme() : theme;

    // Add/remove theme classes 🔥 (main fix)
    if (actualTheme === 'light') {
        document.body.classList.add("light-theme");
        document.body.classList.remove("dark-theme");
    } else {
        document.body.classList.add("dark-theme");
        document.body.classList.remove("light-theme");
    }
    
    // Update CSS variables
    if (actualTheme === 'light') {
        root.style.setProperty('--bg-primary', '#ffffff');
        root.style.setProperty('--bg-secondary', '#f8f9fa');
        root.style.setProperty('--bg-tertiary', '#e9ecef');
        root.style.setProperty('--text-primary', '#212529');
        root.style.setProperty('--text-secondary', '#6c757d');
        root.style.setProperty('--border-color', 'rgba(0, 0, 0, 0.1)');
    } else {
        root.style.setProperty('--bg-primary', '#121212');
        root.style.setProperty('--bg-secondary', '#181818');
        root.style.setProperty('--bg-tertiary', '#282828');
        root.style.setProperty('--text-primary', '#ffffff');
        root.style.setProperty('--text-secondary', '#b3b3b3');
        root.style.setProperty('--border-color', 'rgba(255, 255, 255, 0.1)');
    }

    // Update nav icon
    if (navThemeIcon) {
        if (theme === 'system') {
            navThemeIcon.className = 'bi bi-circle-half me-1';
        } else if (actualTheme === 'light') {
            navThemeIcon.className = 'bi bi-sun-fill me-1';
        } else {
            navThemeIcon.className = 'bi bi-moon-fill me-1';
        }
    }
}

function updateThemeDropdown() {
    const dropdownItems = document.querySelectorAll('.theme-dropdown .dropdown-item');
    dropdownItems.forEach(item => {
        item.classList.remove('active');
        if ((item.textContent.includes('Light') && currentTheme === 'light') ||
            (item.textContent.includes('Dark') && currentTheme === 'dark') ||
            (item.textContent.includes('System') && currentTheme === 'system')) {
            item.classList.add('active');
        }
    });
}

// Listen for system theme changes
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (currentTheme === 'system') {
        applyTheme('system');
    }
});

// Enhanced fetch data function
async function fetchData() {
    const urlInput = document.getElementById('spotifyUrl');
    const btn = document.getElementById('searchBtn');
    const spinner = document.getElementById('loading');
    const card = document.getElementById('resultCard');
    const errorBox = document.getElementById('errorBox');
    const errorText = document.getElementById('errorText');
    
    const url = urlInput.value.trim();
    
    if (!url) {
        showError('Please enter a Spotify URL');
        return;
    }
    
    if (!url.includes('spotify.com')) {
        showError('Please enter a valid Spotify URL');
        return;
    }

    // Redirect to playlist page if it's a playlist URL
    if (url.includes('/playlist/')) {
        window.location.href = `/playlist?url=${encodeURIComponent(url)}`;
        return;
    }

    // UI Reset
    hideElements([card, errorBox]);
    showElements([spinner]);
    btn.disabled = true;
    btn.innerHTML = '<i class="bi bi-hourglass-split me-2"></i>Extracting...';

    try {
        const response = await fetch('/get-data', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url: url })
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
        console.error('Fetch error:', err);
        showError('Server connection failed. Please try again.');
    } finally {
        hideElements([spinner]);
        btn.disabled = false;
        btn.innerHTML = '<i class="bi bi-search me-2"></i>Extract Data';
    }
}

// Display result with enhanced UI
function displayResult(data) {
    document.getElementById('resImage').src = data.image_url;
    document.getElementById('resTitle').textContent = data.title;
    document.getElementById('resDesc').textContent = data.description;
    document.getElementById('resLink').href = data.spotify_url + '?utm_source=spotscrape';
    
    // Determine content type
    const contentType = document.getElementById('contentType');
    const url = data.spotify_url;
    const youtubeBtn = document.getElementById('youtubeBtn');
    
    if (url.includes('/track/')) {
        contentType.textContent = 'Track';
        contentType.className = 'badge bg-success me-2';
        
        // Show YouTube button for tracks
        if (youtubeBtn) youtubeBtn.style.display = 'inline-block';
        
        // Store track data globally
        window.currentTrackData = {
            title: data.title,
            artist: data.description.split('•')[0] || 'Unknown Artist',
            image_url: data.image_url
        };
    } else {
        if (youtubeBtn) youtubeBtn.style.display = 'none';
    }
    
    if (url.includes('/album/')) {
        contentType.textContent = 'Album';
        contentType.className = 'badge bg-primary me-2';
    } else if (url.includes('/playlist/')) {
        contentType.textContent = 'Playlist';
        contentType.className = 'badge bg-warning me-2';
    } else if (url.includes('/artist/')) {
        contentType.textContent = 'Artist';
        contentType.className = 'badge bg-info me-2';
    }
}

// Fetch playlist songs (mock implementation)
async function fetchPlaylistSongs(url) {
    const playlistSongs = document.getElementById('playlistSongs');
    const songsList = document.getElementById('songsList');
    
    // Mock playlist data - in real implementation, you'd scrape this
    const mockSongs = [
        { number: 1, title: 'Song Title 1', artist: 'Artist Name 1', duration: '3:45' },
        { number: 2, title: 'Song Title 2', artist: 'Artist Name 2', duration: '4:12' },
        { number: 3, title: 'Song Title 3', artist: 'Artist Name 3', duration: '3:28' },
        { number: 4, title: 'Song Title 4', artist: 'Artist Name 4', duration: '5:01' },
        { number: 5, title: 'Song Title 5', artist: 'Artist Name 5', duration: '3:55' }
    ];
    
    songsList.innerHTML = '';
    
    mockSongs.forEach(song => {
        const songElement = document.createElement('div');
        songElement.className = 'song-item d-flex align-items-center';
        songElement.innerHTML = `
            <div class="song-number me-3">${song.number}</div>
            <div class="flex-grow-1">
                <div class="fw-bold">${song.title}</div>
                <div class="text-secondary small">${song.artist}</div>
            </div>
            <div class="text-secondary">${song.duration}</div>
        `;
        songsList.appendChild(songElement);
    });
    
    showElements([playlistSongs]);
}

// Enhanced download function
async function downloadData() {
    if (!currentData) return;

    try {
        const response = await fetch('/download-json', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(currentData)
        });

        const blob = await response.blob();
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `spotify_${currentData.title.replace(/[^a-z0-9]/gi, '_').toLowerCase()}.json`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        window.URL.revokeObjectURL(url);
        
        showToast('Data downloaded successfully!', 'success');
    } catch (error) {
        showToast('Download failed. Please try again.', 'error');
    }
}

// Share function
function shareData() {
    if (!currentData) return;
    
    const shareUrl = currentData.spotify_url + '?utm_source=spotscrape';
    
    if (navigator.share) {
        navigator.share({
            title: currentData.title,
            text: currentData.description,
            url: shareUrl
        });
    } else {
        // Fallback: copy to clipboard
        const shareText = `${currentData.title} - ${shareUrl}`;
        navigator.clipboard.writeText(shareText).then(() => {
            showToast('Link copied to clipboard!', 'success');
        });
    }
}

// Clear history with confirmation
async function clearHistory() {
    if (confirm('Are you sure you want to clear all history? This action cannot be undone.')) {
        try {
            await fetch('/clear-history');
            showToast('History cleared successfully!', 'success');
            setTimeout(() => window.location.reload(), 1000);
        } catch (error) {
            showToast('Failed to clear history. Please try again.', 'error');
        }
    }
}

// Utility functions
function showElements(elements) {
    elements.forEach(el => el && el.classList.remove('d-none'));
}

function hideElements(elements) {
    elements.forEach(el => el && el.classList.add('d-none'));
}

function showError(message) {
    const errorBox = document.getElementById('errorBox');
    const errorText = document.getElementById('errorText');
    
    if (errorText) errorText.textContent = message;
    else errorBox.textContent = message;
    
    showElements([errorBox]);
}

// Toast notification system
function showToast(message, type = 'info') {
    const toast = document.createElement('div');
    toast.className = `toast align-items-center text-white bg-${type === 'success' ? 'success' : 'danger'} border-0`;
    toast.setAttribute('role', 'alert');
    toast.innerHTML = `
        <div class="d-flex">
            <div class="toast-body">
                <i class="bi bi-${type === 'success' ? 'check-circle' : 'exclamation-triangle'} me-2"></i>
                ${message}
            </div>
            <button type="button" class="btn-close btn-close-white me-2 m-auto" data-bs-dismiss="toast"></button>
        </div>
    `;
    
    // Create toast container if it doesn't exist
    let toastContainer = document.getElementById('toastContainer');
    if (!toastContainer) {
        toastContainer = document.createElement('div');
        toastContainer.id = 'toastContainer';
        toastContainer.className = 'toast-container position-fixed bottom-0 end-0 p-3';
        document.body.appendChild(toastContainer);
    }
    
    toastContainer.appendChild(toast);
    
    const bsToast = new bootstrap.Toast(toast);
    bsToast.show();
    
    // Remove toast element after it's hidden
    toast.addEventListener('hidden.bs.toast', () => {
        toast.remove();
    });
}

// Additional utility functions for playlist page
function formatDuration(seconds) {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = seconds % 60;
    
    if (hours > 0) {
        return `${hours}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
    }
    return `${minutes}:${secs.toString().padStart(2, '0')}`;
}

function parseDuration(durationStr) {
    if (!durationStr || durationStr === 'Unknown') return 0;
    const parts = durationStr.split(':').map(Number);
    if (parts.length === 3) {
        return parts[0] * 3600 + parts[1] * 60 + parts[2];
    } else if (parts.length === 2) {
        return parts[0] * 60 + parts[1];
    }
    return 0;
}

function debounce(func, wait) {
    let timeout;
    return function executedFunction(...args) {
        const later = () => {
            clearTimeout(timeout);
            func(...args);
        };
        clearTimeout(timeout);
        timeout = setTimeout(later, wait);
    };
}

// Enhanced search with debouncing
const debouncedFilter = debounce(function() {
    if (typeof filterTracks === 'function') {
        filterTracks();
    }
}, 300);

// Copy to clipboard utility
function copyToClipboard(text) {
    if (navigator.clipboard) {
        navigator.clipboard.writeText(text).then(() => {
            showToast('Copied to clipboard!', 'success');
        }).catch(() => {
            fallbackCopyTextToClipboard(text);
        });
    } else {
        fallbackCopyTextToClipboard(text);
    }
}

function fallbackCopyTextToClipboard(text) {
    const textArea = document.createElement('textarea');
    textArea.value = text;
    textArea.style.top = '0';
    textArea.style.left = '0';
    textArea.style.position = 'fixed';
    document.body.appendChild(textArea);
    textArea.focus();
    textArea.select();
    
    try {
        document.execCommand('copy');
        showToast('Copied to clipboard!', 'success');
    } catch (err) {
        showToast('Failed to copy to clipboard', 'error');
    }
    
    document.body.removeChild(textArea);
}



async function openYouTubeSingle() {
    if (!window.currentTrackData) return;
    
    const youtubeBtn = document.getElementById('youtubeBtn');
    const originalHtml = youtubeBtn.innerHTML;
    youtubeBtn.innerHTML = '<div class="spinner-border spinner-border-sm" role="status"></div><span class="ms-2">Loading...</span>';
    youtubeBtn.disabled = true;
    
    try {
        const response = await fetch('/get-yt-link-by-music-name', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ music_name: window.currentTrackData.title })
        });
        
        const data = await response.json();
        
        if (response.ok && data.youtube_url) {
            window.open(data.youtube_url, '_blank');
            showToast('Opening YouTube video', 'success');
        } else {
            showToast('Video not found', 'error');
        }
    } catch (error) {
        showToast('Failed to load video', 'error');
    } finally {
        youtubeBtn.innerHTML = originalHtml;
        youtubeBtn.disabled = false;
    }
}