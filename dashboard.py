"""Dashboard Viral Radar.  Chạy:  streamlit run dashboard.py"""
import subprocess
import sys
from pathlib import Path

import pandas as pd
import streamlit as st

from radar import db, scoring

ROOT = Path(__file__).resolve().parent
st.set_page_config(page_title="Viral Radar", page_icon="📈", layout="wide")
st.title("📈 Viral Radar · TikTok")

# ----------------------------------------------------------------------------- tìm mới
with st.sidebar:
    st.header("🔎 Tìm video mới")
    with st.form("collect"):
        kind_label = st.selectbox("Tìm theo", ["Từ khóa", "Hashtag", "Kênh (@username)"])
        queries = st.text_area("Mỗi dòng 1 truy vấn", placeholder="review son\nskincare cho da dầu")
        limit = st.number_input("Số video tối đa / truy vấn", 10, 300, 60, step=10)
        enrich = st.number_input("Tính outlier cho N kênh top (chậm hơn)", 0, 50, 0)
        go = st.form_submit_button("Bắt đầu", type="primary")
    st.caption("Một cửa sổ Chrome sẽ bật lên để lấy dữ liệu. Nếu TikTok hiện captcha, hãy tự giải trong cửa sổ đó.")

    if go and queries.strip():
        cmd_name = {"Từ khóa": "search", "Hashtag": "hashtag", "Kênh (@username)": "user"}[kind_label]
        qs = [q.strip() for q in queries.splitlines() if q.strip()]
        cmd = [sys.executable, "-m", "radar", cmd_name, *qs, "--limit", str(limit)]
        if enrich:
            cmd += ["--enrich", str(enrich)]
        with st.status("Đang lấy dữ liệu từ TikTok...", expanded=True) as status:
            log = st.empty()
            lines = []
            proc = subprocess.Popen(cmd, cwd=ROOT, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                    text=True, encoding="utf-8", errors="replace")
            for line in proc.stdout:
                lines.append(line.rstrip())
                log.code("\n".join(lines[-15:]))
            proc.wait()
            status.update(label="Xong" if proc.returncode == 0 else "Có lỗi", state="complete" if proc.returncode == 0 else "error")

# ----------------------------------------------------------------------------- dữ liệu
with db.connect() as conn:
    searches = pd.read_sql_query("SELECT * FROM searches WHERE found > 0 ORDER BY ran_at DESC", conn)
    if searches.empty:
        st.info("Chưa có dữ liệu. Nhập từ khóa ở thanh bên trái rồi bấm **Bắt đầu**.")
        st.stop()
    queries_all = list(dict.fromkeys(searches["query"]))
    with st.sidebar:
        st.header("🎛️ Bộ lọc")
        picked = st.multiselect("Truy vấn", queries_all, default=queries_all)
    ids = searches[searches["query"].isin(picked)]["id"].tolist()
    df = scoring.load_frame(conn, ids) if ids else pd.DataFrame()

if df.empty:
    st.warning("Không có video cho truy vấn đã chọn.")
    st.stop()

with st.sidebar:
    max_days = st.slider("Đăng trong vòng (ngày)", 1, 365, 30)
    min_views = st.number_input("View tối thiểu", 0, value=10_000, step=5_000)
    max_followers = st.number_input("Follower tối đa (0 = không giới hạn)", 0, value=0, step=10_000)
    hide_ads = st.checkbox("Ẩn nội dung tài trợ (nhãn hợp tác thương hiệu)", value=True)
    only_shop = st.checkbox("Chỉ video gắn sản phẩm TikTok Shop", value=False)
    sort_label = st.selectbox("Sắp xếp theo", [
        "Virality Score", "Outlier (so với kênh)", "View / giờ", "View", "Engagement", "Tỉ lệ share"])

sort_col = {"Virality Score": "virality", "Outlier (so với kênh)": "outlier", "View / giờ": "views_per_hour",
            "View": "views", "Engagement": "engagement", "Tỉ lệ share": "share_rate"}[sort_label]

f = df[(df["age_days"] <= max_days) & (df["views"] >= min_views)]
if max_followers:
    f = f[f["followers"].fillna(0) <= max_followers]
if hide_ads:
    f = f[f["is_ad"] == 0]
if only_shop:
    f = f[f["products"].fillna("") != ""]
f = f.sort_values(sort_col, ascending=False, na_position="last")

# ----------------------------------------------------------------------------- KPI
c1, c2, c3, c4 = st.columns(4)
c1.metric("Video", f"{len(f):,}")
c2.metric("Kênh", f"{f['username'].nunique():,}")
c3.metric("Virality ≥ 18 (mạnh)", int((f["virality"] >= 18).sum()))
c4.metric("Outlier ≥ 3x kênh", int((f["outlier"] >= 3).sum()))

tab_v, tab_p, tab_h, tab_m, tab_c = st.tabs(["🎬 Video", "🛒 Sản phẩm", "#️⃣ Hashtag", "🎵 Âm thanh", "👤 Kênh"])

with tab_v:
    show = f.assign(profile="https://www.tiktok.com/@" + f["username"])
    st.dataframe(
        show[["cover", "url", "profile", "caption", "tier", "virality", "outlier", "views", "followers",
              "x_followers", "views_per_hour", "engagement", "share_rate", "age_days", "posted",
              "products", "hashtags", "music_title", "found_by"]],
        hide_index=True,
        width="stretch",
        height=650,
        column_config={
            "cover": st.column_config.ImageColumn("Ảnh", width="small"),
            "url": st.column_config.LinkColumn("Video", display_text="▶ Xem"),
            "profile": st.column_config.LinkColumn("Kênh", display_text=r"https://www\.tiktok\.com/(.*)"),
            "caption": st.column_config.TextColumn("Caption", width="large"),
            "tier": "Mức",
            "virality": st.column_config.NumberColumn("Virality", format="%.1f",
                                                      help="ln(view/follower) × ln(follower). ≥35 xuất sắc, ≥18 mạnh"),
            "outlier": st.column_config.NumberColumn("Outlier", format="%.1fx",
                                                     help="view / trung vị view của kênh. ≥3 viral, ≥10 mega viral"),
            "views": st.column_config.NumberColumn("View", format="localized"),
            "followers": st.column_config.NumberColumn("Follower", format="localized"),
            "x_followers": st.column_config.NumberColumn("× Follower", format="%.1fx"),
            "views_per_hour": st.column_config.NumberColumn("View/giờ", format="localized"),
            "engagement": st.column_config.ProgressColumn("Engagement", format="percent", min_value=0, max_value=0.2),
            "share_rate": st.column_config.NumberColumn("Share", format="percent"),
            "age_days": st.column_config.NumberColumn("Tuổi (ngày)", format="%.1f"),
            "posted": st.column_config.DatetimeColumn("Đăng lúc", format="DD/MM/YY HH:mm"),
            "products": st.column_config.TextColumn("Sản phẩm Shop", width="medium"),
            "hashtags": "Hashtag",
            "music_title": "Âm thanh",
            "found_by": "Tìm thấy qua",
        },
    )
    st.caption("Engagement = (like + comment + share + save) / view. "
               "View/giờ tính từ 2 lần quét gần nhất nếu có, nếu không thì là trung bình từ lúc đăng.")


def _group(col_series: pd.Series, frame: pd.DataFrame, name: str) -> pd.DataFrame:
    g = frame.assign(_k=col_series).dropna(subset=["_k"])
    g = g[g["_k"] != ""]
    if g.empty:
        return pd.DataFrame()
    out = g.groupby("_k").agg(
        videos=("id", "count"),
        total_views=("views", "sum"),
        median_virality=("virality", "median"),
        best_video=("url", "first"),
    ).reset_index().rename(columns={"_k": name})
    return out.sort_values(["videos", "total_views"], ascending=False)


with tab_p:
    prod = f.assign(p=f["products"].fillna("").str.split(r" \| ")).explode("p")
    prod = prod[prod["p"].fillna("") != ""]
    if prod.empty:
        st.info("Không có video nào gắn sản phẩm TikTok Shop trong bộ lọc hiện tại.")
    else:
        st.dataframe(_group(prod["p"], prod, "sản phẩm"), hide_index=True, width="stretch",
                     column_config={"best_video": st.column_config.LinkColumn("Video tốt nhất", display_text="▶ Xem"),
                                    "total_views": st.column_config.NumberColumn("Tổng view", format="localized"),
                                    "median_virality": st.column_config.NumberColumn("Virality TB", format="%.1f")})
        st.caption("Sản phẩm được nhiều video viral gắn cùng lúc là tín hiệu sản phẩm đang bán chạy.")

with tab_h:
    tags = f.assign(tag=f["hashtags"].fillna("").str.split()).explode("tag")
    tags["tag"] = "#" + tags["tag"].fillna("")
    tags = tags[tags["tag"] != "#"]
    st.dataframe(_group(tags["tag"], tags, "hashtag"), hide_index=True, width="stretch",
                 column_config={"best_video": st.column_config.LinkColumn("Video tốt nhất", display_text="▶ Xem"),
                                "total_views": st.column_config.NumberColumn("Tổng view", format="localized"),
                                "median_virality": st.column_config.NumberColumn("Virality TB", format="%.1f")})

with tab_m:
    music = f.assign(m=f["music_title"].fillna("") + " — " + f["music_author"].fillna(""))
    st.dataframe(_group(music["m"], music, "âm thanh"), hide_index=True, width="stretch",
                 column_config={"best_video": st.column_config.LinkColumn("Video tốt nhất", display_text="▶ Xem"),
                                "total_views": st.column_config.NumberColumn("Tổng view", format="localized"),
                                "median_virality": st.column_config.NumberColumn("Virality TB", format="%.1f")})

with tab_c:
    ch = f.groupby("username").agg(
        followers=("followers", "max"),
        videos=("id", "count"),
        best_virality=("virality", "max"),
        best_views=("views", "max"),
        median_views=("median_views", "first"),
    ).reset_index().sort_values("best_virality", ascending=False, na_position="last")
    ch["profile"] = "https://www.tiktok.com/@" + ch["username"]
    st.dataframe(ch, hide_index=True, width="stretch",
                 column_config={"profile": st.column_config.LinkColumn("Kênh", display_text="Mở kênh"),
                                "followers": st.column_config.NumberColumn("Follower", format="localized"),
                                "best_views": st.column_config.NumberColumn("View cao nhất", format="localized"),
                                "median_views": st.column_config.NumberColumn("Trung vị view kênh", format="localized"),
                                "best_virality": st.column_config.NumberColumn("Virality cao nhất", format="%.1f")})
    st.caption("Trung vị view kênh chỉ có khi đã chạy enrich (ô 'Tính outlier cho N kênh top').")
