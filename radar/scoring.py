"""Tính điểm viral cho video.

- virality_score = ln(views/followers) * ln(followers)
    Video vượt follower càng nhiều lần càng cao, có cộng thêm cho kênh lớn để 1 video ăn may
    của kênh rất nhỏ không chiếm hết top. Chỉ tính khi views > followers.
    >=35 xuất sắc, 25-35 rất mạnh, 18-25 mạnh, 10-18 có tiềm năng.
- outlier = views / trung vị view của chính kênh đó (cần enrich kênh). >=3 viral, >=10 mega viral.
- engagement = (likes + comments + shares + saves) / views
- views_per_hour: ưu tiên tính từ 2 snapshot gần nhất (tốc độ hiện tại),
  nếu chưa có thì lấy views / số giờ kể từ khi đăng (tốc độ trung bình).
"""
from __future__ import annotations

import math
import time

import pandas as pd

TIERS = [(35, "🔥 Xuất sắc"), (25, "Rất mạnh"), (18, "Mạnh"), (10, "Tiềm năng")]


def virality(views: float, followers: float | None) -> float | None:
    if not followers or followers < 2 or not views or views <= followers:
        return None
    return math.log(views / followers) * math.log(followers)


def tier(score: float | None) -> str:
    if score is None or pd.isna(score):
        return ""
    for th, label in TIERS:
        if score >= th:
            return label
    return "Bình thường"


def load_frame(conn, search_ids: list[int] | None = None, only_hits: bool = True) -> pd.DataFrame:
    """only_hits=True: chỉ lấy video xuất hiện trong kết quả tìm kiếm
    (bỏ các video phụ lấy về khi enrich kênh để tính trung vị)."""
    where, params = "", []
    if search_ids:
        where = f"WHERE v.id IN (SELECT video_id FROM search_hits WHERE search_id IN ({','.join('?' * len(search_ids))}))"
        params = list(search_ids)
    elif only_hits:
        where = "WHERE v.id IN (SELECT video_id FROM search_hits)"
    df = pd.read_sql_query(
        f"""
        SELECT v.*, c.nickname, c.followers, c.verified, c.median_views, c.median_sample,
               (SELECT GROUP_CONCAT(DISTINCT s.query) FROM search_hits h JOIN searches s ON s.id=h.search_id
                 WHERE h.video_id=v.id) AS found_by
        FROM videos v LEFT JOIN creators c ON c.id = v.creator_id
        {where}
        """,
        conn,
        params=params,
    )
    if df.empty:
        return df

    # tốc độ tăng view hiện tại từ 2 snapshot gần nhất cách nhau >= 30 phút
    snaps = pd.read_sql_query("SELECT video_id, ts, views FROM snapshots ORDER BY video_id, ts", conn)
    vel = {}
    for vid, g in snaps.groupby("video_id"):
        if len(g) < 2:
            continue
        last = g.iloc[-1]
        prev = g[g.ts <= last.ts - 1800]
        if prev.empty:
            continue
        p = prev.iloc[-1]
        vel[vid] = max(0.0, (last.views - p.views) / ((last.ts - p.ts) / 3600))

    now = time.time()
    df["age_hours"] = ((now - df["created_at"]) / 3600).clip(lower=0.5)
    df["age_days"] = (df["age_hours"] / 24).round(1)
    df["views_per_hour"] = df.apply(
        lambda r: vel.get(r["id"], r["views"] / r["age_hours"] if r["age_hours"] else None), axis=1
    )
    df["velocity_source"] = df["id"].map(lambda i: "snapshot" if i in vel else "trung bình")
    df["virality"] = df.apply(lambda r: virality(r["views"], r["followers"]), axis=1)
    df["tier"] = df["virality"].map(tier)
    df["x_followers"] = df.apply(
        lambda r: r["views"] / r["followers"] if r["followers"] else None, axis=1
    )
    df["outlier"] = df.apply(
        lambda r: r["views"] / r["median_views"] if r["median_views"] else None, axis=1
    )
    eng = df["likes"] + df["comments"] + df["shares"] + df["saves"]
    df["engagement"] = (eng / df["views"].where(df["views"] > 0)).fillna(0)
    df["share_rate"] = (df["shares"] / df["views"].where(df["views"] > 0)).fillna(0)
    df["posted"] = pd.to_datetime(df["created_at"], unit="s", utc=True).dt.tz_convert("Asia/Ho_Chi_Minh")
    return df
