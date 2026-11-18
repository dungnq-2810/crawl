"""Collector TikTok: mở trang web TikTok bằng Playwright và bắt các response JSON mà trang tự gọi.

Không tải video, chỉ lấy metadata (view, like, follower, caption, link...).
Hỗ trợ 3 nguồn: tìm theo từ khóa, theo hashtag, theo kênh (@username).
"""
from __future__ import annotations

import json
import random
import statistics
import time
from typing import Callable, Iterable
from urllib.parse import quote

from playwright.sync_api import BrowserContext, Page, Response, sync_playwright

from . import config

# Các API nội bộ của TikTok web chứa danh sách video, theo loại trang.
# Chỉ bắt đúng API của trang đó (trang còn gọi explore/repost... sẽ làm bẩn kết quả).
SEARCH_APIS = ("/api/search/item/full", "/api/search/general/full")
HASHTAG_APIS = ("/api/challenge/item_list",)
USER_APIS = ("/api/post/item_list",)

CAPTCHA_SELECTORS = (
    "#captcha-verify-container-main-page",
    "#captcha_container",
    "div[class*='captcha_verify']",
    "div[class*='TUXModal'] div[class*='captcha']",
)


# ----------------------------------------------------------------------------- parse
def _int(x) -> int | None:
    try:
        return int(x)
    except (TypeError, ValueError):
        return None


def _walk_items(obj) -> Iterable[dict]:
    """Duyệt đệ quy JSON, trả về mọi object trông giống một video TikTok."""
    if isinstance(obj, dict):
        if "id" in obj and "stats" in obj and isinstance(obj.get("author"), dict):
            yield obj
            return
        for v in obj.values():
            yield from _walk_items(v)
    elif isinstance(obj, list):
        for v in obj:
            yield from _walk_items(v)


def _shop_products(it: dict) -> list[str]:
    """Tên sản phẩm TikTok Shop gắn vào video (anchor type 33, thường nằm trong extra của anchor type 35)."""
    names: list[str] = []

    def take(a: dict):
        if str(a.get("type")) == "33" and a.get("keyword"):
            names.append(a["keyword"].strip())

    for a in it.get("anchors") or []:
        take(a)
        extra = a.get("extra")
        if isinstance(extra, str) and extra.startswith("["):
            try:
                for sub in json.loads(extra):
                    if isinstance(sub, dict):
                        take(sub)
            except ValueError:
                pass
    return list(dict.fromkeys(names))


def parse_item(it: dict) -> tuple[dict, dict] | None:
    """Chuyển 1 item TikTok thành (video, creator) đã chuẩn hóa."""
    author = it.get("author") or {}
    a_stats = it.get("authorStats") or it.get("authorStatsV2") or {}
    stats = it.get("statsV2") or it.get("stats") or {}
    stats1 = it.get("stats") or {}
    username = author.get("uniqueId")
    vid = str(it.get("id"))
    if not username or not vid:
        return None

    def stat(key):
        return _int(stats.get(key)) if stats.get(key) is not None else _int(stats1.get(key))

    hashtags = [c.get("title") for c in it.get("challenges") or [] if c.get("title")]
    if not hashtags:
        hashtags = [t.get("hashtagName") for t in it.get("textExtra") or [] if t.get("hashtagName")]
    music = it.get("music") or {}
    video = it.get("video") or {}

    creator = {
        "id": str(author.get("id") or username),
        "username": username,
        "nickname": author.get("nickname"),
        "verified": 1 if author.get("verified") else 0,
        "followers": _int(a_stats.get("followerCount")),
        "total_likes": _int(a_stats.get("heartCount") or a_stats.get("heart")),
        "video_count": _int(a_stats.get("videoCount")),
    }
    v = {
        "id": vid,
        "platform": "tiktok",
        "url": f"https://www.tiktok.com/@{username}/video/{vid}",
        "creator_id": creator["id"],
        "username": username,
        "caption": it.get("desc") or "",
        "hashtags": " ".join(dict.fromkeys(hashtags)),
        "music_title": music.get("title"),
        "music_author": music.get("authorName"),
        "music_original": 1 if music.get("original") else 0,
        "duration": _int(video.get("duration")),
        "cover": video.get("cover") or video.get("originCover"),
        # Lưu ý: trường isAd của TikTok = true với hầu hết video nên KHÔNG dùng.
        # brandOrganicType != 0 là nội dung có nhãn hợp tác thương hiệu / tài trợ.
        "is_ad": 1 if _int(it.get("brandOrganicType")) else 0,
        "products": " | ".join(_shop_products(it)),
        "created_at": _int(it.get("createTime")),
        "views": stat("playCount") or 0,
        "likes": stat("diggCount") or 0,
        "comments": stat("commentCount") or 0,
        "shares": stat("shareCount") or 0,
        "saves": stat("collectCount") or 0,
    }
    return v, creator


def _parse_rehydration(page: Page) -> tuple[list[dict], dict | None]:
    """Dữ liệu render sẵn trong HTML (trang hashtag/kênh có sẵn 1 phần video + thông tin kênh)."""
    try:
        raw = page.locator("#__UNIVERSAL_DATA_FOR_REHYDRATION__").text_content(timeout=3000)
    except Exception:
        return [], None
    if not raw:
        return [], None
    data = json.loads(raw)
    items = list(_walk_items(data))
    user_info = None
    scope = data.get("__DEFAULT_SCOPE__", {})
    ud = scope.get("webapp.user-detail", {}).get("userInfo")
    if ud and ud.get("user"):
        u, s = ud["user"], ud.get("stats") or ud.get("statsV2") or {}
        user_info = {
            "id": str(u.get("id") or u.get("uniqueId")),
            "username": u.get("uniqueId"),
            "nickname": u.get("nickname"),
            "verified": 1 if u.get("verified") else 0,
            "followers": _int(s.get("followerCount")),
            "total_likes": _int(s.get("heartCount") or s.get("heart")),
            "video_count": _int(s.get("videoCount")),
        }
    return items, user_info


# ----------------------------------------------------------------------------- browser
class TikTokSession:
    """Một phiên trình duyệt dùng lại cho nhiều lần tìm kiếm."""

    def __init__(self, headless: bool = False, log: Callable[[str], None] = print, show: bool | None = None):
        """headless: không có cửa sổ (TikTok hay bắt captcha, không giải được).
        show: hiện cửa sổ trên màn hình. Mặc định (None) theo config.HIDE_BROWSER: cửa sổ thật
        nhưng đặt ngoài màn hình, chỉ kéo vào khi TikTok bắt giải captcha."""
        self.headless = headless
        self.hidden = (not headless) and (not show) and (show is not None or config.HIDE_BROWSER)
        self.log = log
        self._pw = None
        self._cdp = None
        self._win = None
        self.ctx: BrowserContext | None = None
        self.page: Page | None = None

    def __enter__(self):
        self._pw = sync_playwright().start()
        flags = ["--disable-blink-features=AutomationControlled"]
        if self.hidden:
            flags += [f"--window-position={config.OFFSCREEN_POS},{config.OFFSCREEN_POS}", "--window-size=1280,900"]
        args = dict(
            user_data_dir=str(config.BROWSER_PROFILE),
            headless=self.headless,
            viewport={"width": 1280, "height": 900},
            locale="vi-VN",
            args=flags,
        )
        try:  # ưu tiên Chrome thật nếu máy có cài, ít bị nhận diện là bot hơn
            self.ctx = self._pw.chromium.launch_persistent_context(channel="chrome", **args)
        except Exception:
            self.ctx = self._pw.chromium.launch_persistent_context(**args)
        self.page = self.ctx.pages[0] if self.ctx.pages else self.ctx.new_page()
        if self.hidden:
            self._move(offscreen=True)
        return self

    def _move(self, offscreen: bool):
        """Đưa cửa sổ ra ngoài màn hình (ẩn) hoặc vào giữa màn hình (để người dùng giải captcha)."""
        try:
            if self._cdp is None:
                self._cdp = self.ctx.new_cdp_session(self.page)
                self._win = self._cdp.send("Browser.getWindowForTarget")["windowId"]
            pos = config.OFFSCREEN_POS if offscreen else 120
            self._cdp.send("Browser.setWindowBounds", {"windowId": self._win, "bounds": {"windowState": "normal"}})
            self._cdp.send("Browser.setWindowBounds", {"windowId": self._win,
                                                       "bounds": {"left": pos, "top": pos if offscreen else 60}})
            if not offscreen:
                self.page.bring_to_front()
        except Exception:  # noqa: BLE001 - không di chuyển được thì vẫn chạy tiếp
            pass

    def __exit__(self, *exc):
        try:
            if self.ctx:
                self.ctx.close()
        finally:
            if self._pw:
                self._pw.stop()

    # ------------------------------------------------------------------ helpers
    def goto(self, url: str):
        """Mở trang. Nếu TikTok từ chối (đang giới hạn truy cập) thì báo lỗi rõ ràng, không cố lách."""
        try:
            self.page.goto(url, wait_until="domcontentloaded", timeout=60000)
        except Exception as e:  # noqa: BLE001
            if "ERR_HTTP_RESPONSE_CODE_FAILURE" in str(e) or "403" in str(e):
                raise RuntimeError("TikTok đang tạm giới hạn truy cập từ máy này. Đợi một lúc (thường vài giờ) rồi thử lại, "
                                   "và quét chậm lại.") from None
            raise

    def _wait_for_human(self):
        """Nếu TikTok hiện captcha, chờ người dùng tự giải trong cửa sổ trình duyệt."""
        page = self.page
        for sel in CAPTCHA_SELECTORS:
            if page.locator(sel).count() > 0:
                if self.headless:
                    raise RuntimeError("TikTok yêu cầu captcha. Chạy lại không dùng --headless để tự giải.")
                if self.hidden:
                    self._move(offscreen=False)
                self.log(f"⚠️  TikTok cần xác minh captcha. Cửa sổ Chrome đã hiện lên, hãy tự giải (chờ tối đa {config.HUMAN_WAIT_SECONDS}s)...")
                deadline = time.time() + config.HUMAN_WAIT_SECONDS
                try:
                    while time.time() < deadline:
                        time.sleep(2)
                        if all(page.locator(s).count() == 0 for s in CAPTCHA_SELECTORS):
                            self.log("✓ Đã qua captcha, tiếp tục quét.")
                            return
                    raise RuntimeError("Hết thời gian chờ giải captcha.")
                finally:
                    if self.hidden:
                        self._move(offscreen=True)

    def _collect(self, url: str, limit: int, apis: tuple[str, ...],
                 only_author: str | None = None) -> tuple[list[dict], dict | None]:
        """Mở url, cuộn trang, gom item từ response API cho tới khi đủ `limit` hoặc hết."""
        page = self.page
        found: dict[str, dict] = {}

        def keep(it: dict) -> bool:
            if only_author is None:
                return True
            return (it.get("author") or {}).get("uniqueId", "").lower() == only_author.lower()

        def on_response(resp: Response):
            if not any(m in resp.url for m in apis):
                return
            try:
                data = resp.json()
            except Exception:
                return
            for it in _walk_items(data):
                if keep(it):
                    found.setdefault(str(it.get("id")), it)

        page.on("response", on_response)
        try:
            self.goto(url)
            time.sleep(random.uniform(3, 5))
            self._wait_for_human()

            ssr_items, user_info = _parse_rehydration(page)
            if only_author is not None:  # chỉ tin dữ liệu SSR trên trang kênh
                for it in ssr_items:
                    if keep(it):
                        found.setdefault(str(it.get("id")), it)

            idle = 0
            last = -1
            while len(found) < limit and idle < config.MAX_IDLE_SCROLLS:
                # đưa chuột vào vùng kết quả rồi mới cuộn (chuột ở góc trái sẽ cuộn sidebar)
                page.mouse.move(random.randint(600, 900), random.randint(400, 700))
                page.mouse.wheel(0, random.randint(1800, 3200))
                if idle >= 2:  # cuộn bằng phím nếu chuột không ăn
                    page.keyboard.press("End")
                time.sleep(random.uniform(*config.SCROLL_DELAY))
                self._wait_for_human()
                if len(found) == last:
                    idle += 1
                else:
                    idle, last = 0, len(found)
                self.log(f"   ... {len(found)} video")
        finally:
            page.remove_listener("response", on_response)

        items = list(found.values())[:limit]
        if not items and "/search" in url:
            self.log("⚠️  Không thấy kết quả. TikTok có thể yêu cầu đăng nhập để tìm kiếm: chạy `python -m radar login`.")
        return items, user_info

    # ------------------------------------------------------------------ public
    def search_keyword(self, keyword: str, limit: int = 60):
        return self._collect(f"https://www.tiktok.com/search/video?q={quote(keyword)}", limit, SEARCH_APIS)[0]

    def search_hashtag(self, tag: str, limit: int = 60):
        tag = tag.lstrip("#")
        items = self._collect(f"https://www.tiktok.com/tag/{quote(tag)}", limit, HASHTAG_APIS)[0]
        if not items:
            # TikTok chặn trang hashtag khi chưa đăng nhập -> tìm "#tag" thay thế
            self.log("   trang hashtag không trả video (thường do chưa đăng nhập), chuyển sang tìm '#" + tag + "'")
            items = self.search_keyword("#" + tag, limit)
        return items

    def user_videos(self, username: str, limit: int = 30):
        username = username.lstrip("@")
        return self._collect(f"https://www.tiktok.com/@{quote(username)}", limit, USER_APIS, only_author=username)


def download_video(session: "TikTokSession", url: str, dest: str) -> int:
    """Tải file video của 1 bài TikTok qua phiên trình duyệt (dùng cho phân tích AI). Trả số byte."""
    page = session.page
    session.goto(url)
    time.sleep(random.uniform(2, 3))
    session._wait_for_human()
    raw = page.locator("#__UNIVERSAL_DATA_FOR_REHYDRATION__").text_content(timeout=10000)
    data = json.loads(raw or "{}")
    item = (data.get("__DEFAULT_SCOPE__", {}).get("webapp.video-detail", {}).get("itemInfo", {}) or {}).get("itemStruct") or {}
    video = item.get("video") or {}
    candidates = [video.get("playAddr"), video.get("downloadAddr")]
    for b in video.get("bitrateInfo") or []:
        for u in ((b.get("PlayAddr") or {}).get("UrlList") or [])[:1]:
            candidates.append(u)
    for src in [c for c in candidates if c]:
        r = session.ctx.request.get(src, headers={"Referer": "https://www.tiktok.com/"}, timeout=120000)
        if r.ok and len(r.body()) > 50_000:
            body = r.body()
            with open(dest, "wb") as f:
                f.write(body)
            return len(body)
    raise RuntimeError("Không lấy được file video từ trang TikTok")


def median_views(items: list[dict]) -> tuple[float | None, int]:
    views = [p[0]["views"] for p in (parse_item(i) for i in items) if p]
    if not views:
        return None, 0
    return float(statistics.median(views)), len(views)
