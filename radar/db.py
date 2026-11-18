"""Lưu trữ SQLite: video, creator, snapshot chỉ số theo thời gian, lịch sử tìm kiếm."""
import sqlite3
import time
from contextlib import contextmanager

from .config import DB_PATH

SCHEMA = """
CREATE TABLE IF NOT EXISTS creators (
    id              TEXT PRIMARY KEY,
    username        TEXT,
    nickname        TEXT,
    verified        INTEGER,
    followers       INTEGER,
    total_likes     INTEGER,
    video_count     INTEGER,
    median_views    REAL,          -- trung vị view các video gần đây (NULL nếu chưa enrich)
    median_sample   INTEGER,       -- số video dùng để tính trung vị
    updated_at      INTEGER
);

CREATE TABLE IF NOT EXISTS videos (
    id              TEXT PRIMARY KEY,
    url             TEXT,
    creator_id      TEXT,
    username        TEXT,
    caption         TEXT,
    hashtags        TEXT,          -- phân tách bằng dấu cách
    music_title     TEXT,
    music_author    TEXT,
    music_original  INTEGER,
    duration        INTEGER,
    cover           TEXT,
    is_ad           INTEGER,       -- nội dung tài trợ / hợp tác thương hiệu
    products        TEXT,          -- sản phẩm TikTok Shop gắn trong video, phân tách bằng " | "
    created_at      INTEGER,       -- thời điểm đăng (unix)
    views           INTEGER,
    likes           INTEGER,
    comments        INTEGER,
    shares          INTEGER,
    saves           INTEGER,
    first_seen      INTEGER,
    last_seen       INTEGER
);

CREATE TABLE IF NOT EXISTS snapshots (
    video_id    TEXT,
    ts          INTEGER,
    views       INTEGER,
    likes       INTEGER,
    comments    INTEGER,
    shares      INTEGER,
    saves       INTEGER,
    PRIMARY KEY (video_id, ts)
);

CREATE TABLE IF NOT EXISTS searches (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    kind        TEXT,              -- keyword | hashtag | user
    query       TEXT,
    ran_at      INTEGER,
    found       INTEGER
);

CREATE TABLE IF NOT EXISTS search_hits (
    search_id   INTEGER,
    video_id    TEXT,
    rank        INTEGER,
    PRIMARY KEY (search_id, video_id)
);

CREATE INDEX IF NOT EXISTS idx_videos_creator ON videos(creator_id);
CREATE INDEX IF NOT EXISTS idx_hits_video ON search_hits(video_id);

-- Danh sách theo dõi: kênh hoặc truy vấn được quét lại tự động theo lịch
CREATE TABLE IF NOT EXISTS watch (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    platform        TEXT,
    kind            TEXT,              -- search | hashtag | user
    query           TEXT,
    interval_hours  REAL DEFAULT 6,
    enabled         INTEGER DEFAULT 1,
    last_run        INTEGER,
    created_at      INTEGER,
    UNIQUE(platform, kind, query)
);

CREATE TABLE IF NOT EXISTS settings (
    key     TEXT PRIMARY KEY,
    value   TEXT
);

-- bộ từ khóa mở rộng cho mỗi lần tìm: "chó" -> chó, dog, #dog, 狗...
CREATE TABLE IF NOT EXISTS search_terms (
    q           TEXT,          -- từ khóa người dùng gõ (chữ thường)
    term        TEXT,          -- từ khóa thực sự đem đi tìm
    lang        TEXT,          -- vi | en | zh
    source      TEXT,          -- ai | dịch | gốc | người dùng
    pos         INTEGER,
    created_at  INTEGER,
    PRIMARY KEY (q, term)
);

-- kết quả phân tích AI cho từng video (chỉ tạo khi người dùng bấm nút)
CREATE TABLE IF NOT EXISTS ai_analysis (
    video_id    TEXT PRIMARY KEY,
    model       TEXT,
    result      TEXT,          -- JSON
    created_at  INTEGER
);

-- video đã gửi thông báo Telegram (tránh gửi trùng)
CREATE TABLE IF NOT EXISTS notified (
    video_id    TEXT PRIMARY KEY,
    ts          INTEGER
);
"""


def _migrate(conn):
    """Thêm cột mới cho database tạo từ phiên bản cũ."""
    cols = {r[1] for r in conn.execute("PRAGMA table_info(videos)")}
    if "products" not in cols:
        conn.execute("ALTER TABLE videos ADD COLUMN products TEXT")
    # nền tảng: tiktok | youtube (dữ liệu cũ đều là tiktok)
    for table in ("videos", "creators", "searches"):
        tcols = {r[1] for r in conn.execute(f"PRAGMA table_info({table})")}
        if "platform" not in tcols:
            conn.execute(f"ALTER TABLE {table} ADD COLUMN platform TEXT DEFAULT 'tiktok'")


@contextmanager
def connect():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    try:
        conn.executescript(SCHEMA)
        _migrate(conn)
        yield conn
        conn.commit()
    finally:
        conn.close()


def start_search(conn, kind: str, query: str, platform: str = "tiktok") -> int:
    cur = conn.execute(
        "INSERT INTO searches(kind, query, ran_at, found, platform) VALUES (?,?,?,0,?)",
        (kind, query, int(time.time()), platform),
    )
    return cur.lastrowid


def finish_search(conn, search_id: int, found: int):
    conn.execute("UPDATE searches SET found=? WHERE id=?", (found, search_id))


def upsert_creator(conn, c: dict):
    now = int(time.time())
    conn.execute(
        """
        INSERT INTO creators(id, platform, username, nickname, verified, followers, total_likes, video_count, updated_at)
        VALUES (:id, :platform, :username, :nickname, :verified, :followers, :total_likes, :video_count, :now)
        ON CONFLICT(id) DO UPDATE SET
            username=excluded.username, nickname=excluded.nickname, verified=excluded.verified,
            followers=COALESCE(excluded.followers, creators.followers),
            total_likes=COALESCE(excluded.total_likes, creators.total_likes),
            video_count=COALESCE(excluded.video_count, creators.video_count),
            updated_at=excluded.updated_at
        """,
        {"platform": "tiktok", **c, "now": now},
    )


def set_creator_median(conn, creator_id: str, median: float, sample: int):
    conn.execute(
        "UPDATE creators SET median_views=?, median_sample=?, updated_at=? WHERE id=?",
        (median, sample, int(time.time()), creator_id),
    )


def upsert_video(conn, v: dict, search_id: int | None = None, rank: int | None = None):
    now = int(time.time())
    conn.execute(
        """
        INSERT INTO videos(id, platform, url, creator_id, username, caption, hashtags, music_title, music_author,
                           music_original, duration, cover, is_ad, products, created_at, views, likes,
                           comments, shares, saves, first_seen, last_seen)
        VALUES (:id, :platform, :url, :creator_id, :username, :caption, :hashtags, :music_title, :music_author,
                :music_original, :duration, :cover, :is_ad, :products, :created_at, :views, :likes,
                :comments, :shares, :saves, :now, :now)
        ON CONFLICT(id) DO UPDATE SET
            caption=excluded.caption, hashtags=excluded.hashtags, cover=excluded.cover,
            is_ad=excluded.is_ad, products=excluded.products,
            views=excluded.views, likes=excluded.likes, comments=excluded.comments,
            shares=excluded.shares, saves=excluded.saves, last_seen=excluded.last_seen
        """,
        {"platform": "tiktok", **v, "now": now},
    )
    # Mỗi lần thấy video lại ghi 1 snapshot -> dùng để tính tốc độ tăng view
    conn.execute(
        "INSERT OR REPLACE INTO snapshots(video_id, ts, views, likes, comments, shares, saves) VALUES (?,?,?,?,?,?,?)",
        (v["id"], now, v["views"], v["likes"], v["comments"], v["shares"], v["saves"]),
    )
    if search_id is not None:
        conn.execute(
            "INSERT OR IGNORE INTO search_hits(search_id, video_id, rank) VALUES (?,?,?)",
            (search_id, v["id"], rank),
        )
