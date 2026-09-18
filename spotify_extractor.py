"""
spotify_extractor.py
=====================

A single, self-contained class — `SpotifyExtractor` — that wraps:

  * `spotify_scraper` (PyPI: ``spotifyscraper``, v3.x)  -> metadata scraping
  * `syncedlyrics`    (PyPI: ``syncedlyrics``)           -> lyrics fetching

and normalizes everything into the flat, predictable dict shapes you asked
for (track / artist / playlist / album / show / lyrics / search), plus
`save_to_json`, `save_to_lrc` and `save_to_text` helpers.

Install
-------
    pip install spotifyscraper syncedlyrics

Quick start
-----------
    from spotify_extractor import SpotifyExtractor

    sx = SpotifyExtractor()

    # auto-detects the content type from the URL
    data = sx.extract("https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC")
    sx.save_to_json(data)                       # -> downloads/<title>.json

    lyrics = sx.extract_lyrics("Blinding Lights", "The Weeknd")
    sx.save_to_lrc(lyrics)                      # -> downloads/<title>.lrc
    sx.save_to_text(lyrics)                     # -> downloads/<title>.txt

    results = sx.search("daft punk", limit=5)
    sx.save_to_json(results)

    sx.close()

Notes on known upstream quirks (and how this class works around them)
-----------------------------------------------------------------------
* When a track is embedded inside a **playlist**, Spotify's own public JSON
  frequently omits that track's ``release_date``. If that happens, this
  class makes one extra ``get_track()`` call for that specific track id to
  fill it in (best-effort — silently skipped on failure). Disable with
  ``resolve_missing_track_dates=False`` if you want zero extra requests.
* When a track is embedded inside an **album**, its own ``release_date``
  and cover ``images`` are frequently empty in the scraped payload. Since
  every track on an album shares the album's release date and artwork,
  this class falls back to the parent album's values instead of an extra
  network round trip.
* Search results for **albums** and **shows** come back from Spotify as
    lightweight refs. Search output keeps only the common identifying fields
    and a direct Spotify URL for each result.

YouTube links
-------------
Every track dict (standalone, or inside a playlist/album/artist/search
result) and every episode dict (standalone, or inside a show) also gets a
``youtube_url`` field: Spotify itself never exposes a YouTube link, so this
is resolved separately with one lightweight YouTube search per unique
title (``"{title} {artist}"`` for tracks, ``"{name} {show_title}"`` for
episodes). To keep this fast:

* Requests are pooled (one shared, keep-alive ``httpx.Client``) and run
  concurrently across up to ``youtube_max_workers`` threads at once.
* Identical queries are cached for the lifetime of the instance, so the
  same song appearing in ten playlists only costs one real lookup.
* Every failure (timeout, blocked request, no match, YouTube markup
  changes, etc.) is swallowed and just leaves ``youtube_url`` as ``None`` -
  it never raises and never fails the surrounding extraction.

This is a best-effort match (first search result), not an official/curated
link, so treat it accordingly. Set ``fetch_youtube_links=False`` in the
constructor to skip it entirely (zero extra requests, fastest possible
extraction).
"""

from __future__ import annotations

import json
import re
import unicodedata
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence, Tuple, Union

import httpx  # already a hard dependency of `spotifyscraper` - no extra install needed

from spotify_scraper import SpotifyClient
from spotify_scraper.errors import SpotifyScraperError
from spotify_scraper.urls import parse as parse_spotify_url

try:
    import syncedlyrics
except ImportError:  # pragma: no cover - handled gracefully at call time
    syncedlyrics = None


JsonDict = Dict[str, Any]

# --- lightweight, dependency-free YouTube search --------------------------- #
# We deliberately avoid yt-dlp here: it's accurate but bootstraps a full
# extractor per search (much slower). Instead we do one HTTP GET against
# YouTube's public search page and regex out the first video id - the same
# technique small "youtube-search" utility packages use. It costs one
# request per unique query and is pooled/cached/parallelized below.
_YOUTUBE_SEARCH_URL = "https://www.youtube.com/results"
_YOUTUBE_VIDEO_ID_RE = re.compile(r"watch\?v=([\w-]{11})")
_YOUTUBE_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
    ),
    "Accept-Language": "en-US,en;q=0.9",
}
_YOUTUBE_COOKIES = {"CONSENT": "YES+1"}  # skips the EU consent interstitial page


class SpotifyExtractor:
    """All-in-one Spotify metadata + lyrics extractor."""

    #: Spotify entity type -> handler method name, used by extract()
    _TYPE_DISPATCH = {
        "track": "extract_track",
        "album": "extract_album",
        "artist": "extract_artist",
        "playlist": "extract_playlist",
        "show": "extract_show",
        "episode": "extract_episode",
    }

    def __init__(
        self,
        cookies: Optional[Union[str, Path, Dict[str, str]]] = None,
        default_download_dir: Union[str, Path] = "downloads",
        playlist_max_tracks: Optional[int] = 100,
        show_max_episodes: Optional[int] = 50,
        resolve_missing_track_dates: bool = True,
        locale: Optional[str] = None,
        fetch_youtube_links: bool = True,
        youtube_max_workers: int = 8,
        youtube_timeout: float = 6.0,
    ) -> None:
        """
        Args:
            cookies: Optional Spotify ``sp_dc`` cookie(s) (file path or dict).
                Only needed for logged-in-only features; everything in this
                class works fine anonymously.
            default_download_dir: Base folder used by the ``save_to_*``
                helpers when no ``download_dir`` is given.
            playlist_max_tracks: Cap on tracks fetched per playlist.
            show_max_episodes: Cap on episodes fetched per show.
            resolve_missing_track_dates: If True, best-effort-fetch a
                playlist track's full record when its release_date is
                missing (see module docstring).
            locale: Optional BCP-47 language tag for localized names.
            fetch_youtube_links: If True, every track/episode dict gets a
                best-effort ``youtube_url`` (see module docstring for how,
                and its accuracy/reliability caveats). Set False to skip
                this entirely for maximum speed and zero extra requests.
            youtube_max_workers: Max concurrent YouTube search requests used
                when resolving links for a batch of tracks/episodes.
            youtube_timeout: Per-request timeout (seconds) for YouTube
                lookups. Failures never raise - they just leave youtube_url
                as None.
        """
        self.client = SpotifyClient(cookies=cookies, locale=locale)
        self.default_download_dir = Path(default_download_dir)
        self.playlist_max_tracks = playlist_max_tracks
        self.show_max_episodes = show_max_episodes
        self.resolve_missing_track_dates = resolve_missing_track_dates
        self.fetch_youtube_links = fetch_youtube_links
        self.youtube_max_workers = youtube_max_workers
        self.youtube_timeout = youtube_timeout

        # Cached so save_to_json()/save_to_lrc()/save_to_text() can be
        # called with no arguments right after an extract()/search() call.
        self._last_result: Optional[JsonDict] = None
        self._last_lyrics: Optional[JsonDict] = None

        # Query -> resolved YouTube URL (or None). Persists for the life of
        # this instance so the same song/episode is never looked up twice.
        self._youtube_cache: Dict[str, Optional[str]] = {}
        self._youtube_client: Optional[httpx.Client] = None  # lazily created

    # ------------------------------------------------------------------ #
    # context-manager support
    # ------------------------------------------------------------------ #
    def __enter__(self) -> "SpotifyExtractor":
        return self

    def __exit__(self, *exc_info: Any) -> None:
        self.close()

    def close(self) -> None:
        """Release the underlying HTTP client's resources."""
        try:
            self.client.close()
        except Exception:
            pass
        if self._youtube_client is not None:
            try:
                self._youtube_client.close()
            except Exception:
                pass

    # ==================================================================== #
    # internal helpers
    # ==================================================================== #
    @staticmethod
    def _fail(content_type: str, message: str, **extra: Any) -> JsonDict:
        return {"status": "fail", "content_type": content_type, "error": message, **extra}

    @staticmethod
    def _format_duration(duration_ms: Optional[int]) -> Tuple[Optional[int], Optional[str]]:
        """(duration_sec, 'MM:SS') from milliseconds, or (None, None)."""
        if not duration_ms:
            return None, None
        total_seconds = int(duration_ms // 1000)
        minutes, seconds = divmod(total_seconds, 60)
        return total_seconds, f"{minutes:02d}:{seconds:02d}"

    @staticmethod
    def _format_date(value: Any) -> Optional[str]:
        """Normalize a datetime/str release date to DD/MM/YYYY, or None."""
        if not value:
            return None
        if isinstance(value, datetime):
            return value.strftime("%d/%m/%Y")
        if isinstance(value, str):
            for fmt in ("%Y-%m-%dT%H:%M:%S", "%Y-%m-%d", "%Y-%m", "%Y"):
                try:
                    return datetime.strptime(value, fmt).strftime("%d/%m/%Y")
                except ValueError:
                    continue
        return None

    @staticmethod
    def _best_image(images: Optional[Sequence[Any]]) -> Optional[str]:
        """Highest-resolution image URL out of a tuple of Image objects."""
        if not images:
            return None
        try:
            best = max(
                images,
                key=lambda img: (getattr(img, "width", None) or 0)
                * (getattr(img, "height", None) or 0),
            )
            return getattr(best, "url", None)
        except Exception:
            return getattr(images[0], "url", None)

    @staticmethod
    def _artists_str(artists: Optional[Sequence[Any]]) -> str:
        if not artists:
            return ""
        names = [getattr(a, "name", None) for a in artists]
        return ", ".join(n for n in names if n)

    @staticmethod
    def _slugify(text: str) -> str:
        """'Blinding Lights - The Weeknd!' -> 'blinding_lights_the_weeknd'."""
        text = unicodedata.normalize("NFKD", text or "").encode("ascii", "ignore").decode("ascii")
        text = re.sub(r"[^\w\s-]", "", text).strip().lower()
        text = re.sub(r"[\s-]+", "_", text)
        return text or "untitled"

    def _resolve_dir(self, download_dir: Optional[Union[str, Path]]) -> Path:
        directory = Path(download_dir) if download_dir else self.default_download_dir
        directory.mkdir(parents=True, exist_ok=True)
        return directory

    def _track_to_dict(self, track: Any) -> JsonDict:
        """Track object -> the shared {title, artist, duration...} shape."""
        duration_sec, duration = self._format_duration(getattr(track, "duration_ms", None))
        track_id = getattr(track, "id", None)
        share_url = getattr(track, "share_url", None)
        return {
            "title": getattr(track, "name", None),
            "artist": self._artists_str(getattr(track, "artists", None)),
            "duration_sec": duration_sec,
            "duration": duration,
            "id": track_id,
            "image_url": self._best_image(getattr(track, "images", None)),
            "release_date": self._format_date(getattr(track, "release_date", None)),
            "track_url": share_url or (f"https://open.spotify.com/track/{track_id}" if track_id else None),
        }

    # ==================================================================== #
    # YouTube link resolution (fast, cached, concurrent, best-effort)
    # ==================================================================== #
    def _get_youtube_client(self) -> httpx.Client:
        if self._youtube_client is None:
            self._youtube_client = httpx.Client(
                headers=_YOUTUBE_HEADERS,
                cookies=_YOUTUBE_COOKIES,
                timeout=self.youtube_timeout,
                follow_redirects=True,
            )
        return self._youtube_client

    def _youtube_search_url(self, query: str) -> Optional[str]:
        """One search -> the first result's watch URL, or None on any failure."""
        query = (query or "").strip()
        if not query:
            return None
        try:
            client = self._get_youtube_client()
            resp = client.get(_YOUTUBE_SEARCH_URL, params={"search_query": query})
            resp.raise_for_status()
            match = _YOUTUBE_VIDEO_ID_RE.search(resp.text)
            if match:
                return f"https://www.youtube.com/watch?v={match.group(1)}"
        except Exception:
            pass
        return None

    def _bulk_youtube_lookup(self, queries: Sequence[str]) -> Dict[str, Optional[str]]:
        """
        Resolve many queries concurrently (bounded by youtube_max_workers),
        reusing pooled connections and this instance's cache. Returns a
        {query: url_or_None} map covering every query passed in.
        """
        pending = [q for q in dict.fromkeys(q.strip() for q in queries if q) if q not in self._youtube_cache]
        if pending:
            workers = max(1, min(self.youtube_max_workers, len(pending)))
            with ThreadPoolExecutor(max_workers=workers) as executor:
                future_map = {executor.submit(self._youtube_search_url, q): q for q in pending}
                for future in as_completed(future_map):
                    q = future_map[future]
                    try:
                        self._youtube_cache[q] = future.result()
                    except Exception:
                        self._youtube_cache[q] = None
        return {q: self._youtube_cache.get((q or "").strip()) for q in queries}

    def _youtube_url_for(self, query: str) -> Optional[str]:
        """Single-query convenience wrapper around _bulk_youtube_lookup."""
        if not self.fetch_youtube_links:
            return None
        return self._bulk_youtube_lookup([query]).get((query or "").strip())

    def _attach_youtube_urls(
        self, items: List[JsonDict], title_key: str = "title", extra_key: Optional[str] = "artist"
    ) -> None:
        """Mutates `items` in place, adding a 'youtube_url' key to each."""
        if not items:
            return
        if not self.fetch_youtube_links:
            for item in items:
                item["youtube_url"] = None
            return

        queries = []
        for item in items:
            title = (item.get(title_key) or "").strip()
            extra = (item.get(extra_key) or "").strip() if extra_key else ""
            queries.append(f"{title} {extra}".strip())

        lookup = self._bulk_youtube_lookup(queries)
        for item, query in zip(items, queries):
            item["youtube_url"] = lookup.get(query)

    # ==================================================================== #
    # extraction: single entities
    # ==================================================================== #
    def extract(self, url: str) -> JsonDict:
        """Auto-detect the Spotify URL's content type and extract it."""
        try:
            entity_type, _entity_id = parse_spotify_url(url)
        except Exception as e:
            return self._fail("unknown", f"Could not detect Spotify URL type: {e}")

        handler_name = self._TYPE_DISPATCH.get(entity_type)
        if handler_name is None:
            return self._fail(
                entity_type,
                f"'{entity_type}' URLs are not supported by extract() "
                f"(supported: {', '.join(self._TYPE_DISPATCH)}).",
            )
        return getattr(self, handler_name)(url)

    def extract_track(self, url: str) -> JsonDict:
        try:
            track = self.client.get_track(url)
        except SpotifyScraperError as e:
            return self._fail("track", str(e))
        except Exception as e:
            return self._fail("track", f"Unexpected error: {e}")

        duration_sec, duration = self._format_duration(track.duration_ms)
        result: JsonDict = {
            "status": "success",
            "content_type": "track",
            "title": track.name,
            "artist": self._artists_str(track.artists),
            "duration_sec": duration_sec,
            "duration": duration,
            "id": track.id,
            "image_url": self._best_image(track.images),
            "release_date": self._format_date(track.release_date),
        }
        result["youtube_url"] = self._youtube_url_for(f"{result['title']} {result['artist']}")
        self._last_result = result
        return result

    def extract_album(self, url: str) -> JsonDict:
        try:
            album = self.client.get_album(url)
        except SpotifyScraperError as e:
            return self._fail("album", str(e))
        except Exception as e:
            return self._fail("album", f"Unexpected error: {e}")

        album_release_date = self._format_date(album.release_date)
        album_image = self._best_image(album.images)

        tracks: List[JsonDict] = []
        for t in album.tracks:
            track_dict = self._track_to_dict(t)
            # known limitation workaround (see module docstring)
            if not track_dict["release_date"]:
                track_dict["release_date"] = album_release_date
            if not track_dict["image_url"]:
                track_dict["image_url"] = album_image
            tracks.append(track_dict)

        self._attach_youtube_urls(tracks)

        album_url = getattr(album, "share_url", None) or (f"https://open.spotify.com/album/{album.id}" if getattr(album, "id", None) else None)
        result: JsonDict = {
            "status": "success",
            "content_type": "album",
            "title": album.name,
            "id": album.id,
            "album_url": album_url,
            "spotify_url": album_url,
            "image_url": album_image,
            "label": album.label,
            "release_date": album_release_date,
            "tracks_count": album.total_tracks if album.total_tracks is not None else len(tracks),
            "tracks": tracks,
        }
        self._last_result = result
        return result

    def extract_playlist(self, url: str) -> JsonDict:
        try:
            playlist = self.client.get_playlist(url, max_tracks=self.playlist_max_tracks)
        except SpotifyScraperError as e:
            return self._fail("playlist", str(e))
        except Exception as e:
            return self._fail("playlist", f"Unexpected error: {e}")

        playlist_image = self._best_image(playlist.images)

        tracks: List[JsonDict] = []
        for playlist_track in playlist.tracks:
            track = getattr(playlist_track, "track", None)
            if track is None:
                continue
            track_dict = self._track_to_dict(track)

            # known limitation workaround (see module docstring)
            if not track_dict["release_date"] and self.resolve_missing_track_dates and track.id:
                try:
                    full_track = self.client.get_track(track.id)
                    track_dict["release_date"] = self._format_date(full_track.release_date)
                    if not track_dict["image_url"]:
                        track_dict["image_url"] = self._best_image(full_track.images)
                except Exception:
                    pass  # best-effort only, never fail the whole playlist

            tracks.append(track_dict)

        self._attach_youtube_urls(tracks)

        playlist_url = getattr(playlist, "share_url", None) or (f"https://open.spotify.com/playlist/{playlist.id}" if getattr(playlist, "id", None) else url)
        result: JsonDict = {
            "status": "success",
            "content_type": "playlist",
            "title": playlist.name,
            "id": playlist.id,
            "playlist_url": playlist_url,
            "spotify_url": playlist_url,
            "image_url": playlist_image,
            "tracks_count": playlist.total_tracks if playlist.total_tracks is not None else len(tracks),
            "tracks": tracks,
        }
        self._last_result = result
        return result

    def extract_artist(self, url: str) -> JsonDict:
        try:
            artist = self.client.get_artist(url)
        except SpotifyScraperError as e:
            return self._fail("artist", str(e))
        except Exception as e:
            return self._fail("artist", f"Unexpected error: {e}")

        artist_image = self._best_image(artist.images)
        tracks: List[JsonDict] = []
        for t in artist.top_tracks:
            track_dict = self._track_to_dict(t)
            if not track_dict["image_url"]:
                track_dict["image_url"] = artist_image
            tracks.append(track_dict)

        self._attach_youtube_urls(tracks)

        artist_url = getattr(artist, "share_url", None) or (f"https://open.spotify.com/artist/{artist.id}" if getattr(artist, "id", None) else url)
        result: JsonDict = {
            "status": "success",
            "content_type": "artist",
            "title": artist.name,
            "id": artist.id,
            "artist_url": artist_url,
            "spotify_url": artist_url,
            "biography": artist.biography,
            "followers": artist.followers,
            "image_url": artist_image,
            "tracks_count": len(tracks),
            "tracks": tracks,
        }
        self._last_result = result
        return result

    def extract_show(self, url: str) -> JsonDict:
        try:
            show = self.client.get_show(url, max_episodes=self.show_max_episodes)
        except SpotifyScraperError as e:
            return self._fail("show", str(e))
        except Exception as e:
            return self._fail("show", f"Unexpected error: {e}")

        show_image = self._best_image(show.images)
        episodes: List[JsonDict] = []
        for ep in show.episodes:
            duration_sec, _duration = self._format_duration(ep.duration_ms)
            ep_id = ep.id
            ep_url = getattr(ep, 'share_url', None) or (
                f"https://open.spotify.com/episode/{ep_id}" if ep_id else None
            )
            episodes.append(
                {
                    "id": ep_id,
                    "name": ep.name,
                    "title": ep.name,
                    "duration_sec": duration_sec,
                    "description": ep.description,
                    "image_url": self._best_image(ep.images) or show_image,
                    "episode_url": ep_url,
                }
            )

        # Episodes don't have an "artist" field - search with the show name
        # instead, which meaningfully improves match accuracy.
        if self.fetch_youtube_links:
            ep_queries = [f"{e['name']} {show.name}".strip() for e in episodes]
            lookup = self._bulk_youtube_lookup(ep_queries)
            for ep_dict, q in zip(episodes, ep_queries):
                ep_dict["youtube_url"] = lookup.get(q)
        else:
            for ep_dict in episodes:
                ep_dict["youtube_url"] = None

        show_url = getattr(show, "share_url", None) or (f"https://open.spotify.com/show/{show.id}" if getattr(show, "id", None) else url)
        result: JsonDict = {
            "status": "success",
            "content_type": "show",
            "title": show.name,
            "id": show.id,
            "show_url": show_url,
            "spotify_url": show_url,
            "image_url": show_image,
            "description": show.description,
            "total_episodes": show.total_episodes if show.total_episodes is not None else len(episodes),
            "episodes": episodes,
        }
        self._last_result = result
        return result

    def extract_episode(self, url: str) -> JsonDict:
        """Extract a single podcast episode by its own Spotify URL."""
        try:
            episode = self.client.get_episode(url)
        except SpotifyScraperError as e:
            return self._fail("episode", str(e))
        except Exception as e:
            return self._fail("episode", f"Unexpected error: {e}")

        duration_sec, duration = self._format_duration(episode.duration_ms)
        show_ref = getattr(episode, "show", None)
        show_title = getattr(show_ref, "name", None)
        image_url = self._best_image(episode.images) or self._best_image(getattr(show_ref, "images", None))
        episode_id = episode.id
        episode_url = episode.share_url or (
            f"https://open.spotify.com/episode/{episode_id}" if episode_id else None
        )

        result: JsonDict = {
            "status": "success",
            "content_type": "episode",
            "title": episode.name,
            "id": episode_id,
            "show_title": show_title,
            "show_id": getattr(show_ref, "id", None),
            "duration_sec": duration_sec,
            "duration": duration,
            "description": episode.description,
            "release_date": self._format_date(episode.release_date),
            "image_url": image_url,
            "episode_url": episode_url,
        }
        result["youtube_url"] = self._youtube_url_for(f"{result['title']} {show_title or ''}")
        self._last_result = result
        return result

    # ==================================================================== #
    # search
    # ==================================================================== #
    def _track_search_item(self, track: Any) -> JsonDict:
        duration_sec, duration = self._format_duration(getattr(track, "duration_ms", None))
        track_id = getattr(track, "id", None)
        return {
            "title": getattr(track, "name", None),
            "artist": self._artists_str(getattr(track, "artists", None)),
            "content_type": "track",
            "duration_sec": duration_sec,
            "duration": duration,
            "id": track_id,
            "image_url": self._best_image(getattr(track, "images", None)),
            "track_url": getattr(track, "share_url", None)
            or (f"https://open.spotify.com/track/{track_id}" if track_id else None),
        }

    def _artist_search_item(self, artist: Any) -> JsonDict:
        artist_id = getattr(artist, "id", None)
        return {
            "content_type": "artist",
            "title": getattr(artist, "name", None),
            "id": artist_id,
            "image_url": self._best_image(getattr(artist, "images", None)),
            "artist_url": getattr(artist, "share_url", None)
            or (f"https://open.spotify.com/artist/{artist_id}" if artist_id else None),
        }

    def _playlist_search_item(self, playlist: Any) -> JsonDict:
        playlist_id = getattr(playlist, "id", None)
        return {
            "content_type": "playlist",
            "title": getattr(playlist, "name", None),
            "id": playlist_id,
            "image_url": self._best_image(getattr(playlist, "images", None)),
            "playlist_url": getattr(playlist, "share_url", None)
            or (f"https://open.spotify.com/playlist/{playlist_id}" if playlist_id else None),
        }

    def _album_search_item(self, album_ref: Any) -> JsonDict:
        album_id = getattr(album_ref, "id", None)
        item: JsonDict = {
            "content_type": "album",
            "title": getattr(album_ref, "name", None),
            "id": album_id,
            "image_url": self._best_image(getattr(album_ref, "images", None)),
            "album_url": getattr(album_ref, "share_url", None)
            or (f"https://open.spotify.com/album/{album_id}" if album_id else None),
        }
        return item

    def _show_search_item(self, show_ref: Any) -> JsonDict:
        show_id = getattr(show_ref, "id", None)
        item: JsonDict = {
            "content_type": "show",
            "title": getattr(show_ref, "name", None),
            "id": show_id,
            "image_url": self._best_image(getattr(show_ref, "images", None)),
            "show_url": getattr(show_ref, "share_url", None)
            or (f"https://open.spotify.com/show/{show_id}" if show_id else None),
        }
        return item

    def _run_single_type_search(
        self, query: str, entity_type: str, result_key: str, limit: int, item_fn: Any
    ) -> JsonDict:
        title = f"{query} - {result_key}"
        try:
            results = self.client.search(query, types=(entity_type,), limit=limit)
            raw_items = getattr(results, result_key, ()) or ()
            items = [item_fn(x) for x in raw_items[:limit]]
            result: JsonDict = {"status": "success", "title": title, result_key: items}
            self._last_result = result
            return result
        except SpotifyScraperError as e:
            return {"status": "fail", "title": title, result_key: [], "error": str(e)}
        except Exception as e:
            return {"status": "fail", "title": title, result_key: [], "error": f"Unexpected error: {e}"}

    def search_tracks(self, query: str, limit: int = 10) -> JsonDict:
        result = self._run_single_type_search(query, "track", "tracks", limit, self._track_search_item)
        if result.get("status") == "success":
            self._attach_youtube_urls(result["tracks"])
        return result

    def search_artists(self, query: str, limit: int = 10) -> JsonDict:
        return self._run_single_type_search(query, "artist", "artists", limit, self._artist_search_item)

    def search_playlists(self, query: str, limit: int = 10) -> JsonDict:
        return self._run_single_type_search(query, "playlist", "playlists", limit, self._playlist_search_item)

    def search_albums(self, query: str, limit: int = 10) -> JsonDict:
        return self._run_single_type_search(query, "album", "albums", limit, self._album_search_item)

    def search_shows(self, query: str, limit: int = 10) -> JsonDict:
        return self._run_single_type_search(query, "show", "shows", limit, self._show_search_item)

    def search(self, query: str, limit: int = 10) -> JsonDict:
        """Search every entity type in one shot."""
        title = f"{query} - all results"

        try:
            results = self.client.search(
                query, types=("track", "artist", "album", "playlist", "show"), limit=limit
            )
        except SpotifyScraperError as e:
            return self._all_search_failure(title, str(e))
        except Exception as e:
            return self._all_search_failure(title, f"Unexpected error: {e}")

        def build(result_key: str, item_fn: Any) -> JsonDict:
            try:
                raw_items = getattr(results, result_key, ()) or ()
                items = [item_fn(x) for x in raw_items[:limit]]
                if result_key == "tracks":
                    self._attach_youtube_urls(items)
                return {"status": "success", result_key: items}
            except Exception as e:
                return {"status": "fail", result_key: [], "error": str(e)}

        result: JsonDict = {
            "status": "success",
            "title": title,
            "searched_tracks": build("tracks", self._track_search_item),
            "searched_playlists": build("playlists", self._playlist_search_item),
            "searched_artists": build("artists", self._artist_search_item),
            "searched_albums": build("albums", self._album_search_item),
            "searched_shows": build("shows", self._show_search_item),
        }
        self._last_result = result
        return result

    @staticmethod
    def _all_search_failure(title: str, error: str) -> JsonDict:
        empty = {"status": "fail", "error": error}
        return {
            "status": "fail",
            "title": title,
            "searched_tracks": {**empty, "tracks": []},
            "searched_playlists": {**empty, "playlists": []},
            "searched_artists": {**empty, "artists": []},
            "searched_albums": {**empty, "albums": []},
            "searched_shows": {**empty, "shows": []},
        }

    # ==================================================================== #
    # lyrics (syncedlyrics)
    # ==================================================================== #
    @staticmethod
    def _lrc_to_plain(raw: str) -> str:
        """Strip `[mm:ss.xx]` LRC timestamp tags, leaving clean readable text."""
        lines = []
        for line in raw.splitlines():
            clean = re.sub(r"\[\d{2}:\d{2}(?:[.:]\d{1,3})?\]", "", line).strip()
            if clean:
                lines.append(clean)
        return "\n".join(lines)

    def extract_lyrics(self, song_name: str, artist_name: str = "") -> JsonDict:
        """Fetch lyrics for a song (synced/LRC preferred, plain-text fallback)."""
        title = f"{song_name} - {artist_name}".strip(" -") if artist_name else song_name

        if syncedlyrics is None:
            result = {
                "status": "fail",
                "title": title,
                "lyrics": None,
                "text_lyrics": None,
                "error": "The `syncedlyrics` package is not installed.",
            }
            self._last_lyrics = result
            return result

        search_term = f"{song_name} {artist_name}".strip()
        error_message: Optional[str] = None
        raw_lyrics: Optional[str] = None
        try:
            raw_lyrics = syncedlyrics.search(search_term)
        except Exception as e:
            error_message = str(e)

        if not raw_lyrics:
            result = {
                "status": "fail",
                "title": title,
                "lyrics": None,
                "text_lyrics": None,
                "error": error_message or f"No lyrics found for '{search_term}'.",
            }
            self._last_lyrics = result
            return result

        result = {
            "status": "success",
            "title": title,
            "lyrics": raw_lyrics,
            "text_lyrics": self._lrc_to_plain(raw_lyrics),
        }
        self._last_lyrics = result
        return result

    # ==================================================================== #
    # saving helpers
    # ==================================================================== #
    def save_to_json(
        self,
        data: Optional[JsonDict] = None,
        file_name: Optional[str] = None,
        download_dir: Optional[Union[str, Path]] = None,
    ) -> JsonDict:
        """
        Save any dict produced by this class (extract_*, search_*, search)
        to a .json file. Defaults to whatever was extracted/searched last.
        """
        payload = data if data is not None else self._last_result
        if payload is None:
            return {
                "status": "fail",
                "path": None,
                "title": None,
                "content_type": None,
                "error": "Nothing to save yet - call extract()/search() first, or pass `data=`.",
            }

        title = payload.get("title") or "untitled"
        content_type = payload.get("content_type")  # None for search_* payloads, that's fine

        try:
            directory = self._resolve_dir(download_dir)
            name = file_name or self._slugify(title)
            path = directory / f"{name}.json"
            with open(path, "w", encoding="utf-8") as f:
                json.dump(payload, f, ensure_ascii=False, indent=2)
            return {"status": "success", "path": str(path), "title": title, "content_type": content_type}
        except Exception as e:
            return {
                "status": "fail",
                "path": None,
                "title": title,
                "content_type": content_type,
                "error": f"Could not write file: {e}",
            }

    def save_to_lrc(
        self,
        lyrics_data: Optional[JsonDict] = None,
        file_name: Optional[str] = None,
        download_dir: Optional[Union[str, Path]] = None,
    ) -> JsonDict:
        """Save an extract_lyrics() result's raw (LRC/plain) lyrics to .lrc."""
        payload = lyrics_data if lyrics_data is not None else self._last_lyrics
        if not payload or payload.get("status") != "success" or not payload.get("lyrics"):
            return {
                "status": "fail",
                "path": None,
                "title": payload.get("title") if payload else None,
                "error": "No lyrics available to save - call extract_lyrics() first.",
            }

        title = payload.get("title") or "untitled"
        try:
            directory = self._resolve_dir(download_dir)
            name = file_name or self._slugify(title)
            path = directory / f"{name}.lrc"
            with open(path, "w", encoding="utf-8") as f:
                f.write(payload["lyrics"])
            return {"status": "success", "path": str(path), "title": title}
        except Exception as e:
            return {"status": "fail", "path": None, "title": title, "error": f"Could not write file: {e}"}

    def save_to_text(
        self,
        lyrics_data: Optional[JsonDict] = None,
        file_name: Optional[str] = None,
        download_dir: Optional[Union[str, Path]] = None,
    ) -> JsonDict:
        """Save an extract_lyrics() result's plain-text lyrics to .txt."""
        payload = lyrics_data if lyrics_data is not None else self._last_lyrics
        if not payload or payload.get("status") != "success" or not payload.get("text_lyrics"):
            return {
                "status": "fail",
                "path": None,
                "title": payload.get("title") if payload else None,
                "error": "No lyrics available to save - call extract_lyrics() first.",
            }

        title = payload.get("title") or "untitled"
        try:
            directory = self._resolve_dir(download_dir)
            name = file_name or self._slugify(title)
            path = directory / f"{name}.txt"
            with open(path, "w", encoding="utf-8") as f:
                f.write(payload["text_lyrics"])
            return {"status": "success", "path": str(path), "title": title}
        except Exception as e:
            return {"status": "fail", "path": None, "title": title, "error": f"Could not write file: {e}"}