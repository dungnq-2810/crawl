"""CLI của Viral Radar.

    python -m radar login                               # mở trình duyệt để tự đăng nhập TikTok (1 lần)
    python -m radar search "skincare" "son môi"         # tìm theo từ khóa (mặc định TikTok)
    python -m radar search "skincare" -p youtube        # tìm YouTube Shorts
    python -m radar hashtag reviewlamdep                # tìm theo hashtag
    python -m radar user @abc @xyz                      # lấy video của kênh (theo dõi đối thủ)
    python -m radar enrich --top 20                     # tính view trung vị của kênh -> điểm outlier
    python -m radar top                                 # in bảng video viral nhất ra terminal
"""
from __future__ import annotations

import argparse
import sys

from . import db, scoring
from .tiktok import TikTokSession, median_views, parse_item
from .youtube import YouTubeSession

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

PLATFORMS = ("tiktok", "youtube")


def _tt_pairs(items: list[dict]) -> list[tuple[dict, dict]]:
    return [p for p in (parse_item(i) for i in items) if p]


def _save(conn, pairs, search_id=None) -> int:
    n = 0
    for rank, (video, creator) in enumerate(pairs):
        if not video.get("id") or not creator.get("id"):
            continue
        db.upsert_creator(conn, creator)
        db.upsert_video(conn, video, search_id, rank)
        n += 1
    return n


def _session(platform: str, headless: bool, region: str | None = None):
    if platform == "youtube":
        return YouTubeSession(region=region)
    return TikTokSession(headless=headless)


def cmd_login(args):
    with TikTokSession(headless=False, show=True) as s:
        s.page.goto("https://www.tiktok.com/login", wait_until="domcontentloaded")
        print("Hãy tự đăng nhập TikTok trong cửa sổ trình duyệt (nên dùng tài khoản phụ).")
        input("Đăng nhập xong thì quay lại đây và nhấn Enter... ")
    print("✓ Đã lưu phiên đăng nhập vào data/browser-profile")


def _fetch(s, platform: str, kind: str, q: str, limit: int, conn):
    """Chạy 1 truy vấn, trả về (pairs, creator_id_cần_set_median, median, sample)."""
    if platform == "youtube":
        if kind == "keyword":
            return s.search_keyword(q, limit), None, None, 0
        if kind == "hashtag":
            return s.search_hashtag(q, limit), None, None, 0
        pairs, creator, med, sample = s.channel(q, limit)
        if creator.get("id"):
            db.upsert_creator(conn, creator)
        return pairs, creator.get("id"), med, sample

    if kind == "keyword":
        return _tt_pairs(s.search_keyword(q, limit)), None, None, 0
    if kind == "hashtag":
        return _tt_pairs(s.search_hashtag(q, limit)), None, None, 0
    items, user_info = s.user_videos(q, limit)
    if user_info:
        db.upsert_creator(conn, user_info)
    pairs = _tt_pairs(items)
    med, sample = median_views(items)
    return pairs, (pairs[0][1]["id"] if pairs else None), med, sample


def cmd_collect(args, kind: str):
    with _session(args.platform, args.headless, getattr(args, "region", None)) as s, db.connect() as conn:
        for q in args.queries:
            print(f"🔎 [{args.platform}/{kind}] {q}")
            try:
                pairs, creator_id, med, sample = _fetch(s, args.platform, kind, q, args.limit, conn)
            except Exception as e:  # noqa: BLE001
                print(f"   ✗ lỗi: {e}")
                continue
            sid = db.start_search(conn, kind, q, args.platform)
            n = _save(conn, pairs, sid)
            db.finish_search(conn, sid, n)
            if creator_id and med is not None:
                db.set_creator_median(conn, creator_id, med, sample)
            conn.commit()
            print(f"   ✓ lưu {n} video")
        if args.enrich:
            _enrich(s, conn, args.enrich, args.platform)


def _enrich(s, conn, top: int, platform: str, creator: str | None = None):
    """Mở trang kênh của các creator đứng đầu (hoặc 1 kênh chỉ định) để tính trung vị view -> điểm outlier."""
    df = scoring.load_frame(conn, only_hits=False)
    if df.empty:
        return
    if creator:
        todo = df[(df["platform"] == platform) & (df["creator_id"] == creator)].head(1)
        if todo.empty:
            print(f"✗ không tìm thấy kênh {creator}")
            return
    else:
        todo = (
            df[(df["median_views"].isna()) & (df["platform"] == platform)]
            .sort_values("virality", ascending=False, na_position="last")
            .drop_duplicates("username")
            .head(top)
        )
    for _, r in todo.iterrows():
        print(f"👤 enrich [{platform}] {r['username']}")
        try:
            if platform == "youtube":
                # dùng channel_id cho chắc (handle YouTube có thể chứa ký tự đặc biệt)
                _, creator_info, med, sample = s.channel(r["creator_id"], 30, details=False)
                db.upsert_creator(conn, creator_info)
            else:
                items, user_info = s.user_videos(r["username"], 30)
                if user_info:
                    db.upsert_creator(conn, user_info)
                _save(conn, _tt_pairs(items))
                med, sample = median_views(items)
        except Exception as e:  # noqa: BLE001
            print(f"   ✗ lỗi: {e}")
            continue
        if med is not None:
            db.set_creator_median(conn, r["creator_id"], med, sample)
            print(f"   ✓ trung vị {med:,.0f} view ({sample} video)")
        conn.commit()


def cmd_enrich(args):
    with _session(args.platform, args.headless) as s, db.connect() as conn:
        _enrich(s, conn, args.top, args.platform, args.creator)


def cmd_fetch_video(args):
    from .tiktok import download_video
    with TikTokSession(headless=args.headless) as s:
        n = download_video(s, args.url, args.out)
    print(f"✓ tải {n / 1e6:.1f} MB")


def cmd_top(args):
    with db.connect() as conn:
        df = scoring.load_frame(conn)
    if df.empty:
        print("Chưa có dữ liệu. Chạy `python -m radar search ...` trước.")
        return
    df = df[(df["age_days"] <= args.days) & (df["is_ad"] == 0)]
    if args.platform:
        df = df[df["platform"] == args.platform]
    df = df.sort_values(args.sort, ascending=False, na_position="last").head(args.n)
    for _, r in df.iterrows():
        vir = f"{r['virality']:.1f}" if r["virality"] == r["virality"] and r["virality"] is not None else "-"
        print(
            f"{vir:>5} | {r['platform']:<7} | {r['views']:>11,} view | {r['followers'] or 0:>10,} fl | "
            f"{r['engagement']*100:4.1f}% eng | {r['age_days']:>5}d | {r['url']}"
        )


def main():
    p = argparse.ArgumentParser(prog="radar", description="Tìm video viral TikTok / YouTube Shorts")
    sub = p.add_subparsers(dest="cmd", required=True)

    sub.add_parser("login", help="Mở trình duyệt để tự đăng nhập TikTok")

    for name, help_ in (("search", "Tìm theo từ khóa"), ("hashtag", "Tìm theo hashtag"),
                        ("user", "Lấy video của kênh (@handle, link kênh, hoặc channel id YouTube)")):
        sp = sub.add_parser(name, help=help_)
        sp.add_argument("queries", nargs="+")
        sp.add_argument("-p", "--platform", choices=PLATFORMS, default="tiktok")
        sp.add_argument("--limit", type=int, default=60, help="số video tối đa mỗi truy vấn (mặc định 60)")
        sp.add_argument("--headless", action="store_true", help="TikTok: chạy ẩn trình duyệt (dễ bị chặn hơn)")
        sp.add_argument("--region", choices=["VN", "US", "TW"], default=None,
                        help="YouTube: thị trường tìm kiếm (mặc định đoán theo chữ của từ khóa)")
        sp.add_argument("--enrich", type=int, default=0, metavar="N",
                        help="sau khi tìm, tính trung vị view cho N kênh đứng đầu")

    sp = sub.add_parser("enrich", help="Tính trung vị view của kênh để có điểm outlier")
    sp.add_argument("-p", "--platform", choices=PLATFORMS, default="tiktok")
    sp.add_argument("--top", type=int, default=20)
    sp.add_argument("--creator", default=None, help="chỉ tính cho 1 kênh (creator_id)")
    sp.add_argument("--headless", action="store_true")

    sp = sub.add_parser("fetch-video", help="Tải tạm 1 video TikTok (dùng cho phân tích AI)")
    sp.add_argument("url")
    sp.add_argument("out")
    sp.add_argument("--headless", action="store_true")

    sp = sub.add_parser("top", help="In video viral nhất")
    sp.add_argument("-n", type=int, default=20)
    sp.add_argument("-p", "--platform", choices=PLATFORMS, default=None)
    sp.add_argument("--days", type=float, default=30, help="chỉ lấy video đăng trong N ngày")
    sp.add_argument("--sort", default="virality",
                    choices=["virality", "outlier", "views_per_hour", "views", "engagement"])

    args = p.parse_args()
    if args.cmd == "login":
        cmd_login(args)
    elif args.cmd == "search":
        cmd_collect(args, "keyword")
    elif args.cmd == "hashtag":
        cmd_collect(args, "hashtag")
    elif args.cmd == "user":
        cmd_collect(args, "user")
    elif args.cmd == "enrich":
        cmd_enrich(args)
    elif args.cmd == "fetch-video":
        cmd_fetch_video(args)
    elif args.cmd == "top":
        cmd_top(args)


if __name__ == "__main__":
    main()
