from flask import Flask, render_template, request, jsonify, send_file, session, redirect, url_for
from flask_sqlalchemy import SQLAlchemy
from bs4 import BeautifulSoup
import requests
import datetime
import io
import json
import os
import hashlib
import re
from spotify_playlist_scraper import SpotifyPlaylistScraper

app = Flask(__name__)
app.config['SQLALCHEMY_DATABASE_URI'] = 'sqlite:///database.db'
app.config['SQLALCHEMY_TRACK_MODIFICATIONS'] = False
app.config['SECRET_KEY'] = 'your-secret-key-here'
db = SQLAlchemy(app)

@app.context_processor
def inject_user():
    return dict(user_logged_in='user_id' in session)

# --- Database Models ---
class User(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    username = db.Column(db.String(80), unique=True, nullable=False)
    email = db.Column(db.String(120), unique=True, nullable=False)
    password_hash = db.Column(db.String(128), nullable=False)
    security_question = db.Column(db.String(200), nullable=False)
    security_answer = db.Column(db.String(200), nullable=False)
    created_at = db.Column(db.DateTime, default=datetime.datetime.utcnow)

class History(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    title = db.Column(db.String(200))
    description = db.Column(db.String(500))
    image_url = db.Column(db.String(500))
    spotify_url = db.Column(db.String(500))
    date = db.Column(db.DateTime, default=datetime.datetime.utcnow)
    user_id = db.Column(db.Integer, db.ForeignKey('user.id'), nullable=False)
    
    # Relationship to User model
    user = db.relationship('User', backref=db.backref('history', lazy=True, cascade='all, delete-orphan'))

# --- Scraper Function ---
def scrape_spotify(url):
    headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
    }
    try:
        response = requests.get(url, headers=headers)
        if response.status_code != 200:
            return None
        
        soup = BeautifulSoup(response.text, 'html.parser')
        
        # Extract Meta Tags
        title = soup.find("meta", property="og:title")
        desc = soup.find("meta", property="og:description")
        image = soup.find("meta", property="og:image")
        
        if not title: return None

        return {
            "title": title["content"],
            "description": desc["content"] if desc else "No description",
            "image_url": image["content"] if image else "https://via.placeholder.com/300",
            "spotify_url": url
        }
    except:
        return None

# --- Routes ---

@app.route('/')
def index():
    return render_template('index.html')

@app.route('/history')
def history():
    if 'user_id' not in session:
        return redirect(url_for('signin'))
    
    user_id = session['user_id']
    # Get last 20 searches for logged-in user only
    items = History.query.filter_by(user_id=user_id).order_by(History.date.desc()).limit(20).all()
    return render_template('history.html', items=items)

@app.route('/playlist')
def playlist():
    return render_template('playlist.html')

@app.route('/stats')
def stats():
    if 'user_id' not in session:
        return redirect(url_for('signin'))
    
    user_id = session['user_id']
    user = User.query.get(user_id)
    
    # Calculate user-specific statistics
    total_extractions = History.query.filter_by(user_id=user_id).count()
    unique_tracks = History.query.filter_by(user_id=user_id).filter(History.spotify_url.contains('/track/')).count()
    playlists_count = History.query.filter_by(user_id=user_id).filter(History.spotify_url.contains('/playlist/')).count()
    albums_count = History.query.filter_by(user_id=user_id).filter(History.spotify_url.contains('/album/')).count()
    
    return render_template('stats.html', 
                         total_extractions=total_extractions,
                         unique_tracks=unique_tracks,
                         playlists_count=playlists_count,
                         albums_count=albums_count,
                         username=user.username,
                         member_since=user.created_at.strftime('%B %Y'))

@app.route('/signin')
def signin():
    return render_template('signin.html')

@app.route('/signup')
def signup():
    return render_template('signup.html')

@app.route('/forgot-password')
def forgot_password():
    return render_template('forgot_password.html')

@app.route('/faqs')
def faqs():
    return render_template('faqs.html')

@app.route('/settings')
def settings():
    if 'user_id' not in session:
        return redirect(url_for('signin'))
    
    user_id = session['user_id']
    user = User.query.get(user_id)
    total_extractions = History.query.filter_by(user_id=user_id).count()
    
    return render_template('settings.html',
                         username=user.username,
                         email=user.email,
                         member_since=user.created_at.strftime('%B %Y'),
                         total_extractions=total_extractions)

@app.route('/privacy')
def privacy():
    return render_template('privacy.html')

@app.route('/about')
def about():
    return render_template('about.html')

@app.route('/get-data', methods=['POST'])
def get_data():
    url = request.json.get('url')
    if not url or 'spotify.com' not in url:
        return jsonify({'error': 'Invalid Spotify URL'}), 400

    data = scrape_spotify(url)
    
    if data:
        # Only store history for logged-in users
        if 'user_id' in session:
            new_entry = History(
                title=data['title'],
                description=data['description'],
                image_url=data['image_url'],
                spotify_url=data['spotify_url'],
                user_id=session['user_id']
            )
            db.session.add(new_entry)
            db.session.commit()
        return jsonify(data)
    else:
        return jsonify({'error': 'Could not extract data. Page might be restricted or invalid.'}), 500

@app.route('/download-json', methods=['POST'])
def download_json():
    data = request.json
    # Create an in-memory file
    mem = io.BytesIO()
    mem.write(json.dumps(data, indent=4).encode('utf-8'))
    mem.seek(0)
    return send_file(mem, as_attachment=True, download_name='spotify_data.json', mimetype='application/json')

@app.route('/scrape-playlist', methods=['POST'])
def scrape_playlist():
    url = request.json.get('url')
    if not url or 'spotify.com/playlist/' not in url:
        return jsonify({'error': 'Invalid Spotify playlist URL'}), 400

    try:
        scraper = SpotifyPlaylistScraper(url, headless=True)
        data = scraper.scrape()
        
        if data:
            # Only save to history for logged-in users
            if 'user_id' in session:
                new_entry = History(
                    title=data['playlist_info']['title'],
                    description=data['playlist_info']['description'],
                    image_url=data['playlist_info']['image_url'],
                    spotify_url=url,
                    user_id=session['user_id']
                )
                db.session.add(new_entry)
                db.session.commit()
            
            return jsonify(data)
        else:
            return jsonify({'error': 'Could not scrape playlist data'}), 500
    except Exception as e:
        return jsonify({'error': f'Scraping failed: {str(e)}'}), 500

@app.route('/get-youtube-url', methods=['POST'])
def get_youtube_url():
    query = request.json.get('query')
    if not query:
        return jsonify({'error': 'No query provided'}), 400
    
    try:
        # yt-dlp command to get official YouTube watch URL of first result
        cmd = f'yt-dlp "ytsearch1:{query}" --print "%(webpage_url)s"'
        
        # run command and get video URL
        url = os.popen(cmd).read().strip()
        
        if url and 'youtube.com' in url:
            # Convert to embed URL
            video_id = url.split('watch?v=')[-1].split('&')[0]
            embed_url = f"https://www.youtube-nocookie.com/embed/{video_id}?autoplay=1&start=30&end=60"
            return jsonify({
                'embed_url': embed_url,
                'youtube_url': url,
                'video_id': video_id
            })
        else:
            return jsonify({'error': 'No video found'}), 404
    except Exception as e:
        return jsonify({'error': str(e)}), 500

@app.route('/get-yt-link-by-music-name', methods=['POST'])
def get_yt_link_by_music_name():
    music_name = request.json.get('music_name') 
    if not music_name:
        return jsonify({'error': 'Music name required'}), 400

    try:
        # Parse "music by artist" format
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
        
        html = requests.get(url, headers={
            "User-Agent": "Mozilla/5.0"
        }).text
        
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

@app.route('/delete-history-item/<int:item_id>', methods=['DELETE'])
def delete_history_item(item_id):
    if 'user_id' not in session:
        return jsonify({'error': 'Authentication required'}), 401
    
    try:
        # Only allow users to delete their own history items
        item = History.query.filter_by(id=item_id, user_id=session['user_id']).first_or_404()
        db.session.delete(item)
        db.session.commit()
        return jsonify({'success': True})
    except Exception as e:
        return jsonify({'error': str(e)}), 500

@app.route('/auth/signin', methods=['POST'])
def auth_signin():
    data = request.json
    user = User.query.filter_by(email=data['email']).first()
    if user and hashlib.sha256(data['password'].encode()).hexdigest() == user.password_hash:
        session['user_id'] = user.id
        return jsonify({'success': True})
    return jsonify({'error': 'Invalid credentials'}), 401

@app.route('/auth/signup', methods=['POST'])
def auth_signup():
    data = request.json
    if User.query.filter_by(email=data['email']).first():
        return jsonify({'error': 'Email already exists'}), 400
    
    user = User(
        username=data['username'],
        email=data['email'],
        password_hash=hashlib.sha256(data['password'].encode()).hexdigest(),
        security_question=data['security_question'],
        security_answer=data['security_answer'].lower()
    )
    db.session.add(user)
    db.session.commit()
    session['user_id'] = user.id
    return jsonify({'success': True})

@app.route('/auth/get-security-question', methods=['POST'])
def get_security_question():
    data = request.json
    user = User.query.filter_by(email=data['email']).first()
    if user:
        return jsonify({'question': user.security_question})
    return jsonify({'error': 'Email not found'}), 404

@app.route('/auth/forgot-password', methods=['POST'])
def auth_forgot_password():
    data = request.json
    user = User.query.filter_by(email=data['email']).first()
    if user and user.security_answer.lower() == data['security_answer'].lower():
        user.password_hash = hashlib.sha256(data['new_password'].encode()).hexdigest()
        db.session.commit()
        return jsonify({'success': True})
    return jsonify({'error': 'Invalid email or security answer'}), 400

@app.route('/auth/signout')
def auth_signout():
    session.pop('user_id', None)
    return redirect(url_for('index'))

@app.route('/auth/delete-account', methods=['DELETE'])
def auth_delete_account():
    if 'user_id' not in session:
        return jsonify({'error': 'Not authenticated'}), 401
    
    user = User.query.get(session['user_id'])
    History.query.filter_by(user_id=user.id).delete()
    db.session.delete(user)
    db.session.commit()
    session.pop('user_id', None)
    return jsonify({'success': True})

@app.route('/clear-history')
def clear_history():
    if 'user_id' not in session:
        return jsonify({'error': 'Authentication required'}), 401
    
    # Only clear history for the logged-in user
    History.query.filter_by(user_id=session['user_id']).delete()
    db.session.commit()
    return jsonify({'success': True})

if __name__ == '__main__':
    with app.app_context():
        try:
            # Check if the database schema is compatible
            result = db.session.execute("SELECT user_id FROM history WHERE user_id IS NULL LIMIT 1")
            # If we reach here, old schema exists with nullable user_id
            print("Updating database schema...")
            db.drop_all()
            db.create_all()
            print("Database schema updated successfully!")
        except Exception:
            # Either table doesn't exist or schema is already correct
            db.create_all()
    app.run(debug=True, host='0.0.0.0', port=8000)