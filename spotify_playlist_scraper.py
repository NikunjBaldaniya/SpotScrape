import re
import time
import json
import requests
from bs4 import BeautifulSoup
from selenium import webdriver
from selenium.webdriver.chrome.service import Service
from webdriver_manager.chrome import ChromeDriverManager
from selenium.webdriver.common.by import By

class SpotifyPlaylistScraper:
    def __init__(self, url, headless=True):
        """
        Initialize the scraper with a playlist URL.
        :param url: Spotify Playlist URL
        :param headless: Run Chrome in background (default True)
        """
        self.url = url
        self.headless = headless
        self.data = None  # Stores the final result dictionary
        self.tracks_list = [] # Shortcut to access tracks list
        
    # ---------------------------------------------------------
    # PUBLIC METHODS (User facing)
    # ---------------------------------------------------------
    
    def scrape(self):
        """
        Main method to trigger the scraping process.
        Populates self.data and self.tracks_list.
        """
        print(f"--- Starting Scrape for: {self.url} ---")
        
        # 1. Get Metadata (Title, Image, Owner, Count)
        meta = self._fetch_metadata()
        if not meta:
            print("Error: Could not fetch metadata.")
            return

        print(f"Found: {meta['title']} ({meta['total_tracks']} tracks)")
        print("Launching Selenium to scrape tracks...")

        # 2. Get Tracks (Selenium)
        tracks = self._fetch_tracks_selenium(expected_count=meta['total_tracks'])
        
        # 3. Calculate Totals
        total_seconds = sum(self._text_to_seconds(t['duration']) for t in tracks)
        formatted_duration = self._seconds_to_text(total_seconds)

        # 4. Store Result
        self.tracks_list = tracks
        self.data = {
            "playlist_info": {
                "title": meta['title'],
                "owner": meta['owner'],
                "description": meta['description'],
                "image_url": meta['image_url'],
                "url": meta['spotify_url'],
                "total_tracks_declared": meta['total_tracks'],
                "total_tracks_scraped": len(tracks),
                "total_duration_str": formatted_duration,
                "total_duration_seconds": total_seconds
            },
            "tracks": tracks
        }
        print(f"--- Scrape Complete: {len(tracks)} tracks retrieved ---")
        return self.data

    def get_column_data(self, column_name):
        """
        Returns a list of values for a specific column.
        Valid columns: 'title', 'artist', 'album', 'duration', 'image_url', 'index'
        """
        if not self.tracks_list:
            print("No data found. Please run .scrape() first.")
            return []
        
        if column_name not in ["title", "artist", "album", "duration", "image_url", "index"]:
            print(f"Invalid column name: {column_name}")
            return []

        return [t.get(column_name, "N/A") for t in self.tracks_list]

    def get_track_range(self, start_index, end_index):
        """
        Returns a subset of tracks based on index range (1-based index).
        e.g., get_track_range(1, 10) returns first 10 tracks.
        """
        if not self.tracks_list:
            print("No data found. Please run .scrape() first.")
            return []
        
        # Adjust for 0-based indexing (User inputs 1-10, we slice 0-10)
        start = max(0, start_index - 1)
        end = min(len(self.tracks_list), end_index)
        
        return self.tracks_list[start:end]

    def save_to_json(self, filename="playlist_data.json"):
        """Downloads/Saves the scraped data to a JSON file."""
        if not self.data:
            print("No data to save. Please run .scrape() first.")
            return
        
        try:
            with open(filename, "w", encoding="utf-8") as f:
                json.dump(self.data, f, ensure_ascii=False, indent=2)
            print(f"Successfully saved to {filename}")
        except Exception as e:
            print(f"Error saving file: {e}")

    # ---------------------------------------------------------
    # INTERNAL / HELPER METHODS
    # ---------------------------------------------------------

    def _fetch_metadata(self):
        headers = {'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'}
        try:
            response = requests.get(self.url, headers=headers, timeout=10)
            if response.status_code != 200:
                return None
            
            soup = BeautifulSoup(response.text, 'html.parser')
            title = soup.find("meta", property="og:title")
            desc = soup.find("meta", property="og:description")
            image = soup.find("meta", property="og:image")
            
            description_text = desc["content"].strip() if desc else ""
            
            # Extract Owner
            owner = "Unknown"
            owner_match = re.search(r'Playlist\s*[·•]\s*(.*?)\s*[·•]', description_text)
            if owner_match:
                owner = owner_match.group(1).strip()
            elif "Spotify" in description_text:
                owner = "Spotify"

            # Extract Total Tracks
            total_tracks = None
            count_match = re.search(r'([\d,]+)\s*(?:items|songs|tracks)', description_text, flags=re.IGNORECASE)
            if count_match:
                total_tracks = int(count_match.group(1).replace(',', ''))

            return {
                "title": title["content"].strip() if title else "Unknown",
                "description": description_text,
                "image_url": image["content"] if image else "",
                "owner": owner,
                "total_tracks": total_tracks,
                "spotify_url": self.url
            }
        except Exception as e:
            print(f"Metadata Error: {e}")
            return None

    def _fetch_tracks_selenium(self, expected_count=None):
        options = webdriver.ChromeOptions()
        if self.headless:
            options.add_argument("--headless=new")
        
        options.add_argument("--no-sandbox")
        options.add_argument("--disable-dev-shm-usage")
        options.add_argument("--window-size=1920,1080")
        options.add_argument("--disable-blink-features=AutomationControlled")
        options.add_argument("--log-level=3")

        driver = webdriver.Chrome(service=Service(ChromeDriverManager().install()), options=options)
        unique_tracks = {}

        try:
            driver.get(self.url)
            time.sleep(3)

            last_len = 0
            no_change = 0
            
            while True:
                soup = BeautifulSoup(driver.page_source, "html.parser")
                rows = soup.find_all("div", {"data-testid": "tracklist-row"})

                for row in rows:
                    try:
                        # Basic Info
                        title_div = row.find("div", {"dir": "auto"})
                        title = title_div.get_text().strip() if title_div else "Unknown"

                        # Artist
                        artist_links = row.find_all("a", href=lambda h: h and "/artist/" in h)
                        if artist_links:
                            artists = [a.get_text().strip() for a in artist_links]
                            artist_str = ", ".join(dict.fromkeys(artists))
                        else:
                            artist_str = "Unknown Artist"

                        key = f"{title}|{artist_str}"
                        
                        if key not in unique_tracks:
                            album_link = row.find("a", href=lambda h: h and "/album/" in h)
                            album = album_link.get_text().strip() if album_link else "Unknown Album"

                            # Image
                            img_tag = row.find("img")
                            track_img = img_tag.get("src") or img_tag.get("srcset", "").split(" ")[0] if img_tag else ""

                            # Duration (Strict parsing from last valid time-string)
                            duration = "Unknown"
                            all_text = [t.strip() for t in row.stripped_strings]
                            for text in reversed(all_text):
                                if re.match(r'^\d{1,2}:\d{2}$', text):
                                    duration = text
                                    break
                            
                            unique_tracks[key] = {
                                "title": title,
                                "artist": artist_str,
                                "album": album,
                                "duration": duration,
                                "image_url": track_img
                            }
                    except:
                        continue
                
                # Check limits
                curr_count = len(unique_tracks)
                if expected_count and curr_count >= expected_count:
                    break
                
                # Scroll
                web_rows = driver.find_elements(By.CSS_SELECTOR, '[data-testid="tracklist-row"]')
                if web_rows:
                    driver.execute_script("arguments[0].scrollIntoView(true);", web_rows[-1])
                    time.sleep(1.5)
                else:
                    time.sleep(1)

                if curr_count == last_len:
                    no_change += 1
                else:
                    no_change = 0
                    last_len = curr_count
                
                if no_change >= 15:
                    break

            # Convert to list with index
            track_list = []
            for i, (k, v) in enumerate(unique_tracks.items(), 1):
                v['index'] = i
                track_list.append(v)
            
            if expected_count and len(track_list) > expected_count:
                track_list = track_list[:expected_count]
                
            return track_list

        finally:
            driver.quit()

    @staticmethod
    def _text_to_seconds(time_str):
        if not time_str or time_str == "Unknown": return 0
        try:
            parts = list(map(int, time_str.split(':')))
            if len(parts) == 3: return parts[0]*3600 + parts[1]*60 + parts[2]
            elif len(parts) == 2: return parts[0]*60 + parts[1]
        except: return 0
        return 0

    @staticmethod
    def _seconds_to_text(total_seconds):
        if total_seconds == 0: return "0 min"
        hours = total_seconds // 3600
        minutes = (total_seconds % 3600) // 60
        if hours > 0: return f"{hours} hr {minutes} min"
        return f"{minutes} min"

# ---------------------------------------------------------
# EXAMPLE USAGE
# ---------------------------------------------------------
if __name__ == "__main__":
    url = "https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M"
    
    # 1. Initialize Class
    scraper = SpotifyPlaylistScraper(url, headless=True)
    
    # 2. Scrape Data
    scraper.scrape()
    
    # 3. Example: Get specific column (e.g., all Artists)
    print("\n--- Testing: Get Column 'artist' (First 5) ---")
    artists = scraper.get_column_data("title")
    print(artists[:5]) # Print first 5 artists
    
    # 4. Example: Get specific range (e.g., Tracks 10 to 15)
    print("\n--- Testing: Get Range (10 to 15) ---")
    range_data = scraper.get_track_range(10, 15)
    for track in range_data:
        print(f"{track['index']}. {track['title']} ({track['duration']})")

    # 5. Example: Download JSON
    print("\n--- Testing: Save to JSON ---")
    scraper.save_to_json("my_playlist.json")