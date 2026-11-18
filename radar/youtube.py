"""Collector YouTube Shorts. Không cần API key, không cần trình duyệt.

- Tìm kiếm: gọi API tìm kiếm nội bộ của YouTube (innertube) với bộ lọc "Shorts" để lấy danh sách ID.
- Chi tiết từng video (like, comment, ngày đăng, subscriber kênh): dùng yt-dlp, chạy song song.
- Kênh: yt-dlp đọc tab /shorts của kênh (view + subscriber) -> tính trung vị view cho điểm outlier.
"""
from __future__ import annotations

import random
import re
import statistics
import time
from concurrent.futures import ThreadPoolExecutor
from typing import Callable

import httpx
import yt_dlp

SEARCH_URL = "https://www.youtube.com/youtubei/v1/search?prettyPrint=false"
SHORTS_FILTER = "EgIQCQ%3D%3D"  # bộ lọc "Shorts" trong trang tìm kiếm
CONTEXT = {"client": {"clientName": "WEB", "clientVersion": "2.20251101.00.00", "hl": "vi", "gl": "VN"}}
HEADERS = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                         "(KHTML, like Gecko) Chrome/131.0 Safari/537.36"}
WORKERS = 5  # nhiều hơn dễ bị YouTube yêu cầu "xác minh không phải bot"
HASHTAG_RE = re.compile(r"#([\wÀ-ỹ]+)")


def _walk(o, key, out):
    if isinstance(o, dict):
        for k, v in o.items():
            if k == key:
                out.append(v)
            _walk(v, key, out)
    elif isinstance(o, list):
        for v in o:
            _walk(v, key, out)
    return out


REGIONS = {"VN": ("vi", "VN"), "US": ("en", "US"), "TW": ("zh-TW", "TW")}


def _context_for(query: str, region: str | None = None) -> dict:
    """Tìm đúng thị trường: theo region truyền vào, nếu không có thì đoán theo chữ của từ khóa."""
    if region in REGIONS:
        hl, gl = REGIONS[region]
    elif re.search(r"[一-鿿]", query):
        hl, gl = "zh-TW", "TW"
    elif re.search(r"[À-ỹđĐ]", query):
        hl, gl = "vi", "VN"
    else:
        hl, gl = "en", "US"
    return {"client": {**CONTEXT["client"], "hl": hl, "gl": gl}}


def _search_ids(query: str, limit: int, log: Callable[[str], None], region: str | None = None) -> list[str]:
    ids: list[str] = []
    ctx = _context_for(query, region)
    log(f"   thị trường YouTube: {ctx['client']['gl']}")
    with httpx.Client(timeout=30, headers=HEADERS) as c:
        data = c.post(SEARCH_URL, json={"context": ctx, "query": query, "params": SHORTS_FILTER}).json()
        for _ in range(10):  # tối đa 10 trang
            for lock in _walk(data, "reelWatchEndpoint", []):
                vid = lock.get("videoId")
                if vid and vid not in ids:
                    ids.append(vid)
            log(f"   ... {len(ids)} short")
            if len(ids) >= limit:
                break
            tokens = _walk(data, "continuationCommand", [])
            if not tokens:
                break
            data = c.post(SEARCH_URL, json={"context": ctx, "continuation": tokens[-1]["token"]}).json()
    return ids[:limit]


class _SilentLogger:
    def debug(self, msg): pass
    def info(self, msg): pass
    def warning(self, msg): pass
    def error(self, msg): pass


def _ydl(flat: bool = False):
    opts = {"quiet": True, "no_warnings": True, "skip_download": True, "noprogress": True,
            "logger": _SilentLogger()}
    if flat:
        opts["extract_flat"] = True
    return yt_dlp.YoutubeDL(opts)


NEXT_URL = "https://www.youtube.com/youtubei/v1/next?prettyPrint=false"
_MULT = {"k": 1e3, "m": 1e6, "b": 1e9, "thousand": 1e3, "million": 1e6, "billion": 1e9}


def _num(text: str | None) -> int | None:
    """'5,977,588 views' -> 5977588 ; '193 thousand subscribers' / '193K' -> 193000 ; '1.2K' -> 1200."""
    if not text:
        return None
    t = text.lower().replace(",", "")
    m = re.search(r"([\d.]+)\s*(k|m|b|thousand|million|billion)?\b", t)
    if not m:
        return None
    return int(float(m.group(1)) * _MULT.get(m.group(2) or "", 1))


def _date(text: str | None) -> int | None:
    """'Jun 14, 2026' (có thể kèm 'Premiered ...') -> unix; '3 hours ago' -> ước lượng."""
    if not text:
        return None
    import datetime as dt
    m = re.search(r"([A-Z][a-z]{2} \d{1,2}, \d{4})", text)
    if m:
        return int(dt.datetime.strptime(m.group(1), "%b %d, %Y").replace(tzinfo=dt.timezone.utc).timestamp())
    m = re.search(r"(\d+)\s*(second|minute|hour|day|week|month|year)", text)
    if m:
        sec = {"second": 1, "minute": 60, "hour": 3600, "day": 86400, "week": 604800, "month": 2592000, "year": 31536000}
        return int(time.time() - int(m.group(1)) * sec[m.group(2)])
    return None


def _details_next(video_id: str) -> dict | None:
    """Lấy chi tiết 1 Short qua API 'next' nội bộ của YouTube (nhẹ, 1 request, không cần yt-dlp)."""
    ctx = {"client": {**CONTEXT["client"], "hl": "en", "gl": "US"}}  # tiếng Anh để đọc số và ngày ổn định
    r = httpx.post(NEXT_URL, json={"context": ctx, "videoId": video_id}, headers=HEADERS, timeout=30)
    r.raise_for_status()
    d = r.json()
    prim = (_walk(d, "videoPrimaryInfoRenderer", []) or [{}])[0]
    sec = (_walk(d, "videoSecondaryInfoRenderer", []) or [{}])[0]
    if not prim:
        return None
    owner = (sec.get("owner") or {}).get("videoOwnerRenderer") or {}
    browse = ((owner.get("navigationEndpoint") or {}).get("browseEndpoint") or {})
    subs = owner.get("subscriberCountText") or {}
    likes = next((x for x in _walk(d, "accessibilityText", []) if isinstance(x, str) and "along with" in x), None)
    comments = next((("".join(r2.get("text", "") for r2 in c.get("runs", []))) for c in _walk(d, "contextualInfo", [])
                     if isinstance(c, dict)), None)
    from urllib.parse import unquote
    handle = unquote(browse.get("canonicalBaseUrl") or "").lstrip("/").lstrip("@") or None
    return {
        "id": video_id,
        "title": "".join(x.get("text", "") for x in (prim.get("title") or {}).get("runs", [])),
        "description": (sec.get("attributedDescription") or {}).get("content") or "",
        "tags": [],
        "channel": "".join(x.get("text", "") for x in (owner.get("title") or {}).get("runs", [])),
        "channel_id": browse.get("browseId"),
        "uploader_id": ("@" + handle) if handle else None,
        "channel_follower_count": _num((subs.get("accessibility") or {}).get("accessibilityData", {}).get("label")
                                       or subs.get("simpleText")),
        "view_count": _num(((prim.get("viewCount") or {}).get("videoViewCountRenderer") or {})
                           .get("viewCount", {}).get("simpleText")),
        "like_count": (_num(likes) + 1) if likes else None,
        "comment_count": _num(comments),
        "timestamp": _date((prim.get("dateText") or {}).get("simpleText")),
        "duration": None,
    }


def _details(video_id: str) -> dict | None:
    """Ưu tiên API 'next' (nhanh, ít bị chặn). Chỉ khi nó lỗi mới thử yt-dlp, và chỉ 1 lần."""
    try:
        info = _details_next(video_id)
        if info and info.get("view_count") is not None:
            return info
    except Exception:  # noqa: BLE001
        pass
    for attempt in range(1):
        try:
            with _ydl() as y:
                return y.extract_info(f"https://www.youtube.com/shorts/{video_id}", download=False)
        except Exception:  # noqa: BLE001 - bị YouTube nghi bot -> chờ rồi thử lại; video riêng tư -> bỏ qua
            time.sleep(3 * (attempt + 1) + random.random() * 2)
    return None


def _normalize(info: dict) -> tuple[dict, dict]:
    vid = info["id"]
    channel_id = info.get("channel_id") or info.get("uploader_id")
    handle = (info.get("uploader_id") or "").lstrip("@") or channel_id
    text = f"{info.get('title') or ''} {info.get('description') or ''}"
    tags = HASHTAG_RE.findall(text) + [t.replace(" ", "") for t in (info.get("tags") or [])[:10]]
    creator = {
        "id": channel_id,
        "platform": "youtube",
        "username": handle,
        "nickname": info.get("channel") or info.get("uploader"),
        "verified": 1 if info.get("channel_is_verified") else 0,
        "followers": info.get("channel_follower_count"),
        "total_likes": None,
        "video_count": None,
    }
    video = {
        "id": vid,
        "platform": "youtube",
        "url": f"https://www.youtube.com/shorts/{vid}",
        "creator_id": channel_id,
        "username": handle,
        "caption": info.get("title") or "",
        "hashtags": " ".join(dict.fromkeys(tags)),
        "music_title": info.get("track"),
        "music_author": info.get("artist"),
        "music_original": 0,
        "duration": info.get("duration"),
        "cover": f"https://i.ytimg.com/vi/{vid}/hqdefault.jpg",
        "is_ad": 0,
        "products": "",
        "created_at": info.get("timestamp"),
        "views": info.get("view_count") or 0,
        "likes": info.get("like_count") or 0,
        "comments": info.get("comment_count") or 0,
        "shares": 0,   # YouTube không công khai số share / save
        "saves": 0,
    }
    return video, creator


def _fetch_many(ids: list[str], log: Callable[[str], None]) -> list[tuple[dict, dict]]:
    out: list[tuple[dict, dict]] = []
    with ThreadPoolExecutor(WORKERS) as ex:
        for n, info in enumerate(ex.map(_details, ids), 1):
            if info and info.get("id"):
                out.append(_normalize(info))
            if n % 10 == 0:
                log(f"   ... chi tiết {n}/{len(ids)}")
    return out


class YouTubeSession:
    """Cùng giao diện với TikTokSession (dùng được trong `with`)."""

    def __init__(self, log: Callable[[str], None] = print, region: str | None = None, **_):
        self.log = log
        self.region = region

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def search_keyword(self, keyword: str, limit: int = 60) -> list[tuple[dict, dict]]:
        ids = _search_ids(keyword, limit, self.log, self.region)
        return _fetch_many(ids, self.log)

    def search_hashtag(self, tag: str, limit: int = 60) -> list[tuple[dict, dict]]:
        return self.search_keyword("#" + tag.lstrip("#"), limit)

    def channel(self, handle: str, limit: int = 30, details: bool = True
                ) -> tuple[list[tuple[dict, dict]], dict | None, float | None, int]:
        """Trả về (video chi tiết, thông tin kênh, trung vị view, số video dùng để tính)."""
        handle = handle.strip()
        if handle.startswith("http"):
            url = handle.rstrip("/")
            url = url if url.endswith("/shorts") else url + "/shorts"
        elif handle.startswith("UC") and len(handle) == 24:
            url = f"https://www.youtube.com/channel/{handle}/shorts"
        else:
            url = f"https://www.youtube.com/@{handle.lstrip('@')}/shorts"
        with _ydl(flat=True) as y:
            y.params["playlistend"] = limit
            info = y.extract_info(url, download=False)
        entries = [e for e in info.get("entries") or [] if e.get("id")]
        views = [e["view_count"] for e in entries if e.get("view_count") is not None]
        med = float(statistics.median(views)) if views else None
        creator = {
            "id": info.get("channel_id"),
            "platform": "youtube",
            "username": (info.get("uploader_id") or "").lstrip("@") or info.get("channel_id"),
            "nickname": info.get("channel"),
            "verified": 0,
            "followers": info.get("channel_follower_count"),
            "total_likes": None,
            "video_count": None,
        }
        self.log(f"   kênh {creator['nickname']}: {len(entries)} short, trung vị {med or 0:,.0f} view")
        pairs = _fetch_many([e["id"] for e in entries], self.log) if details else []
        return pairs, creator, med, len(views)
