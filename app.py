from flask import Flask, render_template, request, jsonify, send_file, redirect, url_for
import os
import requests
import io
import json
import re
from spotify_extractor import SpotifyExtractor

app = Flask(__name__)

def _spotify_embed_url(url: str) -> str:
    """Convert open.spotify.com URL to embed URL with video/podcast preview support."""
    match = re.search(r'open\.spotify\.com/(track|album|playlist|artist|show|episode)/([A-Za-z0-9]+)', url)
    if match:
        content_type = match.group(1)
        content_id = match.group(2)
        if content_type in ('show', 'episode'):
            return f"https://open.spotify.com/embed/{content_type}/{content_id}/video?utm_source=generator"
        return f"https://open.spotify.com/embed/{content_type}/{content_id}?utm_source=generator&theme=0"
    return url

# --- Page Routes ---

@app.route('/')
def index():
    return render_template('index.html')

@app.route('/search-page')
def search_page():
    return render_template('search.html')

@app.route('/lyrics-search')
def lyrics_search_page():
    return render_template('lyrics_search.html')

@app.route('/playlist')
def playlist():
    return redirect(url_for('search_page'))

@app.route('/about')
def about():
    return render_template('about.html')

@app.route('/faqs')
def faqs():
    return render_template('faqs.html')

@app.route('/privacy')
def privacy():
    return render_template('privacy.html')

@app.route('/terms')
def terms():
    return render_template('terms.html')

# @app.route('/issues')
# @app.route('/report')
# def issues():
#     return render_template('issues.html')

@app.route('/health')
@app.route('/healthz')
def health():
    return jsonify({
        'status': 'healthy',
        'service': 'SpotScrape',
        'version': '1.0.0'
    }), 200

# --- Custom Error Handlers ---

@app.errorhandler(404)
def error_404(e):
    if request.path.startswith(('/extract', '/search', '/lyrics', '/get-yt-link')):
        return jsonify({'error': 'Resource not found'}), 404
    return render_template('errors/404.html'), 404

@app.errorhandler(500)
def error_500(e):
    if request.path.startswith(('/extract', '/search', '/lyrics', '/get-yt-link')):
        return jsonify({'error': 'Internal server error'}), 500
    return render_template('errors/500.html'), 500

@app.errorhandler(403)
def error_403(e):
    if request.path.startswith(('/extract', '/search', '/lyrics', '/get-yt-link')):
        return jsonify({'error': 'Forbidden'}), 403
    return render_template('errors/403.html'), 403

@app.errorhandler(400)
def error_400(e):
    if request.path.startswith(('/extract', '/search', '/lyrics', '/get-yt-link')):
        return jsonify({'error': 'Bad request'}), 400
    return render_template('errors/400.html'), 400

# --- API Endpoints (Stateless, No Database) ---

@app.route('/extract', methods=['POST'])
def extract():
    url = request.json.get('url', '').strip()
    if not url or 'spotify.com' not in url:
        return jsonify({'error': 'Invalid Spotify URL'}), 400

    try:
        sx = SpotifyExtractor(fetch_youtube_links=True)
        data = sx.extract(url)
        sx.close()
    except Exception as e:
        return jsonify({'error': f'Extraction failed: {str(e)}'}), 500

    if data.get('status') == 'fail':
        return jsonify({'error': data.get('error', 'Extraction failed')}), 500

    # Attach embed URL and direct Spotify URL
    data['spotify_embed_url'] = _spotify_embed_url(url)
    data['spotify_url'] = data.get('spotify_url') or url
    ct = data.get('content_type', '')
    if ct == 'track': data.setdefault('track_url', url)
    elif ct == 'album': data.setdefault('album_url', url)
    elif ct == 'playlist': data.setdefault('playlist_url', url)
    elif ct == 'artist': data.setdefault('artist_url', url)
    elif ct == 'show': data.setdefault('show_url', url)
    elif ct == 'episode': data.setdefault('episode_url', url)

    # Attach embed URLs to individual tracks
    for track in data.get('tracks', []):
        tu = track.get('track_url', '')
        if tu:
            track['spotify_embed_url'] = _spotify_embed_url(tu)
        yt = track.get('youtube_url')
        if yt:
            vid_match = re.search(r'v=([A-Za-z0-9_-]{11})', yt)
            if vid_match:
                track['youtube_embed_url'] = f"https://www.youtube-nocookie.com/embed/{vid_match.group(1)}?autoplay=1"

    # Attach embed URLs to individual podcast episodes
    for ep in data.get('episodes', []):
        eu = ep.get('episode_url', '') or ep.get('track_url', '')
        if eu:
            ep['spotify_embed_url'] = _spotify_embed_url(eu)
        yt = ep.get('youtube_url')
        if yt:
            vid_match = re.search(r'v=([A-Za-z0-9_-]{11})', yt)
            if vid_match:
                ep['youtube_embed_url'] = f"https://www.youtube-nocookie.com/embed/{vid_match.group(1)}?autoplay=1"

    return jsonify(data)

@app.route('/search', methods=['POST'])
def search():
    query = request.json.get('query', '').strip()
    if not query:
        return jsonify({'error': 'Search query required'}), 400

    try:
        sx = SpotifyExtractor(fetch_youtube_links=False)
        data = sx.search(query, limit=12)
        sx.close()
    except Exception as e:
        return jsonify({'error': f'Search failed: {str(e)}'}), 500

    if data.get('status') == 'fail':
        return jsonify({'error': data.get('error', 'Search failed')}), 500

    # Attach embed URLs
    tracks_block = data.get('searched_tracks', {})
    for track in tracks_block.get('tracks', []):
        tu = track.get('track_url', '')
        if tu:
            track['spotify_embed_url'] = _spotify_embed_url(tu)

    albums_block = data.get('searched_albums', {})
    for album in albums_block.get('albums', []):
        au = album.get('album_url', '')
        if au:
            album['spotify_embed_url'] = _spotify_embed_url(au)

    playlists_block = data.get('searched_playlists', {})
    for pl in playlists_block.get('playlists', []):
        pu = pl.get('playlist_url', '')
        if pu:
            pl['spotify_embed_url'] = _spotify_embed_url(pu)

    artists_block = data.get('searched_artists', {})
    for ar in artists_block.get('artists', []):
        au = ar.get('artist_url', '')
        if au:
            ar['spotify_embed_url'] = _spotify_embed_url(au)

    shows_block = data.get('searched_shows', {})
    for sh in shows_block.get('shows', []):
        su = sh.get('show_url', '')
        if su:
            sh['spotify_embed_url'] = _spotify_embed_url(su)

    return jsonify(data)

@app.route('/lyrics', methods=['POST'])
def lyrics():
    title = request.json.get('title', '').strip()
    artist = request.json.get('artist', '').strip()
    if not title:
        return jsonify({'error': 'Song title required'}), 400

    try:
        sx = SpotifyExtractor(fetch_youtube_links=False)
        data = sx.extract_lyrics(title, artist)
        sx.close()
    except Exception as e:
        return jsonify({'error': f'Lyrics fetch failed: {str(e)}'}), 500

    if data.get('status') == 'fail':
        return jsonify({'error': data.get('error', 'Lyrics not found')}), 404

    return jsonify(data)

@app.route('/lyrics/download', methods=['POST'])
def lyrics_download():
    payload = request.json
    fmt = payload.get('format', 'txt')  # 'lrc' or 'txt'
    title = payload.get('title', 'lyrics')
    raw_lyrics = payload.get('lyrics', '')
    text_lyrics = payload.get('text_lyrics', '')

    content = raw_lyrics if fmt == 'lrc' else text_lyrics
    if not content:
        return jsonify({'error': 'No lyrics content'}), 400

    safe_title = re.sub(r'[^\w\s-]', '', title).strip().replace(' ', '_').lower()
    filename = f"{safe_title}.{fmt}"

    mem = io.BytesIO()
    mem.write(content.encode('utf-8'))
    mem.seek(0)
    return send_file(mem, as_attachment=True, download_name=filename,
                     mimetype='text/plain; charset=utf-8')

@app.route('/get-yt-link-by-music-name', methods=['POST'])
def get_yt_link_by_music_name():
    music_name = request.json.get('music_name')
    if not music_name:
        return jsonify({'error': 'Music name required'}), 400

    try:
        if ' by ' in music_name.lower():
            parts = music_name.lower().split(' by ')
            if len(parts) == 2:
                music = parts[0].strip()
                artist = parts[1].strip()
                query = f"{music} {artist}".replace(" ", "+")
            else:
                query = music_name.replace(" ", "+")
        else:
            query = music_name.replace(" ", "+")

        url = f"https://www.youtube.com/results?search_query={query}"
        html = requests.get(url, headers={"User-Agent": "Mozilla/5.0"}).text
        match = re.search(r'"videoId":"(.*?)"', html)
        if not match:
            return jsonify({"error": "No video found"}), 404

        video_id = match.group(1)
        embed_url = f"https://www.youtube-nocookie.com/embed/{video_id}?autoplay=1"
        youtube_link = f"https://www.youtube.com/watch?v={video_id}"

        return jsonify({
            "embed_url": embed_url,
            "youtube_url": youtube_link,
            "video_id": video_id
        })

    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route('/download-json', methods=['POST'])
def download_json():
    data = request.json
    mem = io.BytesIO()
    mem.write(json.dumps(data, indent=4, ensure_ascii=False).encode('utf-8'))
    mem.seek(0)
    return send_file(mem, as_attachment=True, download_name='spotify_data.json', mimetype='application/json')

if __name__ == '__main__':
    app.run(debug=False, host='0.0.0.0', port=int(os.environ.get('PORT', 8000)))