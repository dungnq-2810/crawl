"""Web app của Viral Radar.   Chạy:  python server.py   rồi mở http://localhost:8000"""
from __future__ import annotations

import json
import math
import os
import subprocess
import sys
import tempfile
import threading
import time
import uuid
from collections import deque
from pathlib import Path

import httpx
import pandas as pd
import uvicorn
from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from radar import db, scoring

ROOT = Path(__file__).resolve().parent
WEB = ROOT / "web"
app = FastAPI(title="Viral Radar")

# ---------------------------------------------------------------------------- mật khẩu (khi chạy trên VPS)
# Đặt biến môi trường VR_PASSWORD thì mọi trang và API đều yêu cầu đăng nhập (HTTP Basic).
# Chạy trên máy cá nhân không đặt biến này thì không cần đăng nhập như cũ.
VR_USER = os.environ.get("VR_USER", "admin")
VR_PASSWORD = os.environ.get("VR_PASSWORD", "")


@app.middleware("http")
async def require_password(request, call_next):
    if VR_PASSWORD:
        import base64
        import hmac
        from fastapi.responses import Response
        ok = False
        auth = request.headers.get("authorization", "")
        if auth.lower().startswith("basic "):
            try:
                user, _, pw = base64.b64decode(auth[6:]).decode("utf-8").partition(":")
                ok = hmac.compare_digest(user, VR_USER) and hmac.compare_digest(pw, VR_PASSWORD)
            except Exception:  # noqa: BLE001
                ok = False
        if not ok:
            return Response("Cần đăng nhập", status_code=401,
                            headers={"WWW-Authenticate": 'Basic realm="Viral Radar", charset="UTF-8"'})
    return await call_next(request)

PLATFORMS = ("tiktok", "youtube")
KINDS = ("search", "hashtag", "user")
KIND_DB = {"search": "keyword", "hashtag": "hashtag", "user": "user"}  # tên kind lưu trong bảng searches


# ============================================================================ hàng đợi lượt quét
# Mỗi nền tảng một hàng đợi riêng, chạy song song với nhau; trong cùng nền tảng thì chạy lần lượt
# (TikTok chỉ có 1 cửa sổ trình duyệt dùng chung hồ sơ đăng nhập).
JOBS: dict[str, dict] = {}
QUEUES: dict[str, deque[str]] = {p: deque() for p in PLATFORMS}
LOCK = threading.Lock()


def _enqueue(label: str, cmd: list[str], source: str = "manual", meta: dict | None = None) -> str:
    job_id = uuid.uuid4().hex[:8]
    meta = meta or {}
    with LOCK:
        JOBS[job_id] = {"id": job_id, "label": label, "status": "queued", "log": [], "source": source,
                        "created": time.time(), "started": None, "finished": None, "meta": meta}
        QUEUES[meta.get("platform") or "tiktok"].append(job_id)
    return job_id


def _worker(platform: str):
    queue = QUEUES[platform]
    while True:
        job_id = None
        with LOCK:
            if queue:
                job_id = queue.popleft()
        if not job_id:
            time.sleep(0.5)
            continue
        job = JOBS[job_id]
        job["status"], job["started"] = "running", time.time()
        try:
            proc = subprocess.Popen(job["meta"]["cmd"], cwd=ROOT, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                    text=True, encoding="utf-8", errors="replace",
                                    env={**os.environ, "PYTHONIOENCODING": "utf-8", "PYTHONUNBUFFERED": "1"})
            for line in proc.stdout:
                line = line.rstrip()
                if line:
                    job["log"].append(line)
            proc.wait()
            job["status"] = "done" if proc.returncode == 0 else "error"
        except Exception as e:  # noqa: BLE001
            job["log"].append(f"✗ {e}")
            job["status"] = "error"
        job["finished"] = time.time()
        if job["meta"].get("watch_id"):
            with db.connect() as conn:
                conn.execute("UPDATE watch SET last_run=? WHERE id=?", (int(time.time()), job["meta"]["watch_id"]))
        if job["status"] == "done" and job["meta"].get("notify"):
            try:
                _notify_new_virals()
            except Exception as e:  # noqa: BLE001
                job["log"].append(f"Telegram lỗi: {e}")


def _collect_cmd(platform: str, kind: str, queries: list[str], limit: int, enrich: int) -> list[str]:
    cmd = [sys.executable, "-m", "radar", kind, *queries, "-p", platform, "--limit", str(max(5, min(limit, 300)))]
    if enrich:
        cmd += ["--enrich", str(max(0, min(enrich, 50)))]
    return cmd


class CollectReq(BaseModel):
    platform: str = "tiktok"
    kind: str = "search"
    queries: list[str]
    limit: int = 60
    enrich: int = 0


@app.post("/api/collect")
def collect(req: CollectReq):
    if req.platform not in PLATFORMS or req.kind not in KINDS:
        raise HTTPException(400, "Nền tảng hoặc kiểu tìm không hợp lệ")
    qs = [q.strip() for q in req.queries if q.strip()]
    if not qs:
        raise HTTPException(400, "Nhập ít nhất một từ khóa")
    cmd = _collect_cmd(req.platform, req.kind, qs, req.limit, req.enrich)
    job_id = _enqueue(", ".join(qs), cmd, meta={"cmd": cmd, "platform": req.platform, "kind": req.kind, "queries": qs})
    return {"job_id": job_id}


# ---------------------------------------------------------------------------- tìm 1 từ khóa trên mọi nguồn
def _norm(q: str) -> str:
    return " ".join((q or "").strip().split())


def _search_key(q: str) -> str:
    """Khóa của 1 lần tìm: chữ thường (lower() của Python xử lý đúng chữ có dấu, SQLite thì không)."""
    return _norm(q).lower()


REGION_OF = {"vi": "VN", "en": "US", "zh": "TW"}
SESSIONS: dict[str, dict] = {}  # key -> {"status": expanding|scanning|done|error, "log": [...], "source": ...}


def _load_terms(key: str) -> list[dict]:
    with db.connect() as conn:
        rows = conn.execute("SELECT term, lang, source FROM search_terms WHERE q=? ORDER BY pos", (key,)).fetchall()
    return [dict(r) for r in rows]


def _save_terms(key: str, terms: list[dict], source: str):
    now = int(time.time())
    with db.connect() as conn:
        conn.execute("DELETE FROM search_terms WHERE q=?", (key,))
        for i, t in enumerate(terms):
            conn.execute("INSERT OR IGNORE INTO search_terms(q, term, lang, source, pos, created_at) VALUES (?,?,?,?,?,?)",
                         (key, t["term"], t["lang"], source, i, now))


def _active_jobs(key: str) -> list[dict]:
    return [j for j in JOBS.values() if j["meta"].get("q") == key and j["status"] in ("queued", "running")]


ALL_LANGS = ("vi", "en", "zh")


def _search_prefs() -> dict:
    """Cài đặt tìm kiếm: ngôn ngữ / thị trường, số từ khóa tối đa, số video mỗi từ khóa."""
    s = _get_settings()
    langs = [x for x in (s.get("search_langs") or "vi,en,zh").split(",") if x in ALL_LANGS] or ["vi"]
    return {"langs": langs, "max_terms": int(s.get("max_terms") or 6), "limit": int(s.get("limit_per_term") or 30)}


def _start_session(key: str, terms_override: list[dict] | None, limit: int):
    sess = {"status": "expanding", "log": [], "source": None, "started": time.time()}
    SESSIONS[key] = sess
    log = sess["log"].append
    prefs = _search_prefs()
    limit = prefs["limit"]
    try:
        terms = None
        if terms_override:
            terms = terms_override
            _save_terms(key, terms, "người dùng")
            sess["source"] = "người dùng"
            log("Dùng bộ từ khóa bạn đã chỉnh.")
        else:
            saved = _load_terms(key)
            s = _get_settings()
            if saved:
                src = saved[0].get("source")
                have = {t["lang"] for t in saved[1:]}
                missing = [x for x in prefs["langs"] if x != "vi" and x not in have]
                upgrade_to_ai = src == "dịch" and s.get("gemini_api_key")
                if src == "người dùng" or not (missing or upgrade_to_ai):
                    terms = saved
                    sess["source"] = src
                    log("Dùng lại bộ từ khóa đã tạo lần trước.")
                else:
                    log("Cài đặt đã thay đổi, tạo lại bộ từ khóa." if missing else "Đã có key Gemini, dùng AI tạo lại bộ từ khóa.")
        if not terms:
            from radar import expand
            s = _get_settings()
            gkey, gmodel = s.get("gemini_api_key"), s.get("gemini_model")
            terms, source = expand.expand(key, gkey, gmodel, log=log)
            _save_terms(key, terms, source)
            sess["source"] = source
        if sess["source"] != "người dùng":
            # chỉ giữ ngôn ngữ được bật trong Cài đặt (từ gốc luôn giữ), cắt theo số từ khóa tối đa
            terms = [terms[0]] + [t for t in terms[1:] if t["lang"] in prefs["langs"]]
            terms = terms[:prefs["max_terms"]]
        log("Bộ từ khóa: " + ", ".join(t["term"] for t in terms))
        sess["status"] = "scanning"
        words = [t["term"] for t in terms]
        # TikTok: 1 lượt quét cho tất cả từ khóa (dùng chung 1 cửa sổ Chrome ẩn)
        cmd = _collect_cmd("tiktok", "search", words, limit, 0)
        _enqueue(key, cmd, meta={"cmd": cmd, "platform": "tiktok", "q": key, "terms": words})
        # YouTube: mỗi từ khóa 1 lượt, tìm đúng thị trường của ngôn ngữ đó
        for t in terms:
            cmd = _collect_cmd("youtube", "search", [t["term"]], limit, 0) + ["--region", REGION_OF.get(t["lang"], "VN")]
            _enqueue(t["term"], cmd, meta={"cmd": cmd, "platform": "youtube", "q": key, "terms": [t["term"]]})
        log(f"Đã xếp {len(words)} từ khóa vào hàng quét TikTok và YouTube Shorts.")
    except Exception as e:  # noqa: BLE001
        sess["status"] = "error"
        log(f"Lỗi khi chuẩn bị tìm kiếm: {str(e)[:200]}")


class SearchReq(BaseModel):
    q: str
    limit: int = 30            # số video mỗi từ khóa mỗi nguồn
    terms: list[str] | None = None   # bộ từ khóa người dùng tự chỉnh (bỏ qua bước tạo tự động)


@app.post("/api/search")
def search_start(req: SearchReq):
    key = _search_key(req.q)
    if not key:
        raise HTTPException(400, "Nhập từ khóa cần tìm")
    if _active_jobs(key) or (SESSIONS.get(key, {}).get("status") == "expanding"):
        return {"q": key, "started": False}
    override = None
    if req.terms:
        import re as _re
        override = []
        for t in req.terms:
            t = _norm(t).lower()
            if t and t not in [o["term"] for o in override]:
                lang = "zh" if _re.search(r"[一-鿿]", t) else ("vi" if (_re.search(r"[À-ỹđĐ]", t) or t == key) else "en")
                override.append({"term": t, "lang": lang})
        override = override[:8]
    threading.Thread(target=_start_session, args=(key, override, max(10, min(req.limit, 100))), daemon=True).start()
    return {"q": key, "started": True}


def _friendly(platform: str, line: str, cur: str | None) -> tuple[str | None, str | None]:
    """Đổi 1 dòng log kỹ thuật thành câu dễ hiểu. Trả (câu, từ khóa đang chạy)."""
    import re as _re
    name = "TikTok" if platform == "tiktok" else "Shorts"
    m = _re.match(r"🔎 \[\w+/\w+\] (.+)", line.strip())
    if m:
        return f"{name}: bắt đầu tìm “{m.group(1)}”", m.group(1)
    t = line.strip()
    if t.startswith("thị trường YouTube:"):
        reg = {"VN": "Việt Nam", "US": "Mỹ", "TW": "Đài Loan"}.get(t.split(":")[1].strip(), t)
        return f"{name}: “{cur}” tìm ở thị trường {reg}", cur
    m = _re.match(r"\.\.\. chi tiết (\d+)/(\d+)", t)
    if m:
        return f"{name}: “{cur}” đang lấy chi tiết {m.group(1)}/{m.group(2)} video", cur
    m = _re.match(r"\.\.\. (\d+) (?:video|short)", t)
    if m:
        return f"{name}: “{cur}” đã thấy {m.group(1)} video", cur
    m = _re.match(r"✓ lưu (\d+) video", t)
    if m:
        return f"{name}: xong “{cur}”, lưu {m.group(1)} video", cur
    if t.startswith("✗"):
        return f"{name}: “{cur}” gặp lỗi: {t.lstrip('✗ ').replace('lỗi: ', '')[:160]}", cur
    if "captcha" in t or "TikTok" in t:
        return f"{name}: {t.lstrip('⚠️ ').strip()}", cur
    return None, cur


def _term_status(job: dict) -> dict:
    """Trạng thái từng từ khóa trong 1 job: {term: {"state": wait|run|done|error, "count": n}}."""
    import re as _re
    terms = job["meta"].get("terms") or []
    st = {t: {"state": "wait" if job["status"] in ("queued", "running") else "done", "count": None} for t in terms}
    cur = None
    for line in job["log"]:
        t = line.strip()
        m = _re.match(r"🔎 \[\w+/\w+\] (.+)", t)
        if m:
            cur = m.group(1)
            if cur in st:
                st[cur] = {"state": "run", "count": 0}
            continue
        if cur not in st:
            continue
        m = _re.match(r"\.\.\. chi tiết (\d+)/\d+", t) or _re.match(r"\.\.\. (\d+) (?:video|short)", t)
        if m and st[cur]["state"] == "run":
            st[cur]["count"] = int(m.group(1))
        m = _re.match(r"✓ lưu (\d+) video", t)
        if m:
            st[cur] = {"state": "done", "count": int(m.group(1))}
        if t.startswith("✗"):
            st[cur] = {"state": "error", "count": None, "error": t[:160]}
    if job["status"] == "error":
        for t in st:
            if st[t]["state"] in ("wait", "run"):
                st[t] = {"state": "error", "count": None}
    return st


@app.get("/api/search")
def search_get(q: str):
    key = _search_key(q)
    if not key:
        raise HTTPException(400, "Nhập từ khóa cần tìm")
    terms = _load_terms(key) or [{"term": key, "lang": "vi", "source": "gốc"}]
    if terms[0].get("source") != "người dùng":  # chỉ hiện ngôn ngữ đang bật trong Cài đặt
        prefs = _search_prefs()
        terms = ([terms[0]] + [t for t in terms[1:] if t["lang"] in prefs["langs"]])[:prefs["max_terms"]]
    if key.startswith("#") and len(terms) == 1:  # tìm cũ theo hashtag (lưu kind=hashtag, không có dấu #)
        terms.append({"term": key.lstrip("#"), "lang": "vi", "source": "gốc"})
    want = {t["term"]: t["lang"] for t in terms}
    with db.connect() as conn:
        rows = [r for r in conn.execute(
            "SELECT id, platform, ran_at, found, query FROM searches WHERE kind IN ('keyword','hashtag') AND found > 0 "
            "ORDER BY ran_at").fetchall() if _norm(r["query"]).lower() in want]
        ids = [r["id"] for r in rows]
        df = scoring.load_frame(conn, ids) if ids else pd.DataFrame()
        hits = pd.read_sql_query(
            f"SELECT DISTINCT h.video_id AS id, s.platform, s.query FROM search_hits h JOIN searches s ON s.id=h.search_id "
            f"WHERE s.id IN ({','.join('?' * len(ids))})", conn, params=ids) if ids else pd.DataFrame()
    matched: dict[str, list[str]] = {}
    if not hits.empty:
        for vid, qq in zip(hits["id"], hits["query"]):
            t = _norm(qq).lower()
            matched.setdefault(vid, [])
            if t not in matched[vid]:
                matched[vid].append(t)
    videos = []
    if not df.empty:
        for rec in df[COLS].to_dict("records"):
            rec = {k: _clean(v) for k, v in rec.items()}
            rec["terms"] = matched.get(rec["id"], [])
            rec["markets"] = sorted({want.get(t, "vi") for t in rec["terms"]})
            rec["queries"] = [key + "|" + rec["platform"]]
            videos.append(rec)

    # tiến độ: theo từng từ khóa x nguồn, và nhật ký dễ đọc
    jobs = sorted([j for j in JOBS.values() if j["meta"].get("q") == key], key=lambda j: j["created"])
    latest: dict[tuple[str, str], dict] = {}
    for j in jobs:
        for t in j["meta"].get("terms") or []:
            latest[(j["meta"]["platform"], t)] = j
    term_out = []
    for t in terms:
        row = {"term": t["term"], "lang": t["lang"], "status": {}, "found": {}}
        for p in PLATFORMS:
            row["found"][p] = sum(1 for r in rows if r["platform"] == p and _norm(r["query"]).lower() == t["term"]
                                  and r["found"]) and max(r["found"] for r in rows if r["platform"] == p
                                                          and _norm(r["query"]).lower() == t["term"])
            j = latest.get((p, t["term"]))
            row["status"][p] = _term_status(j).get(t["term"], {"state": "done"}) if j else \
                {"state": "done" if row["found"][p] else "none", "count": None}
        term_out.append(row)
    sess = SESSIONS.get(key) or {}
    friendly = list(sess.get("log", []))
    recent_jobs = [j for j in jobs if j["created"] >= sess.get("started", 0)] if sess else []
    progress_words = ("đã thấy", "đang lấy chi tiết")
    for j in recent_jobs:
        cur = (j["meta"].get("terms") or [None])[0]
        for line in j["log"]:
            msg, cur = _friendly(j["meta"]["platform"], line, cur)
            if not msg:
                continue
            # dòng tiến độ của cùng nguồn + từ khóa: chỉ giữ dòng mới nhất
            prefix = msg.split("”")[0]
            if friendly and any(w in msg for w in progress_words) and friendly[-1].split("”")[0] == prefix \
                    and any(w in friendly[-1] for w in progress_words):
                friendly[-1] = msg
            else:
                friendly.append(msg)
    scanning = sess.get("status") == "expanding" or any(j["status"] in ("queued", "running") for j in jobs)
    needs_human = any(j["status"] == "running" and j["log"] and "captcha" in j["log"][-1] for j in jobs)
    sources = {}
    for p in PLATFORMS:
        mine = [r for r in rows if r["platform"] == p]
        pj = [j for j in jobs if j["meta"]["platform"] == p]
        sources[p] = {"last_ran": mine[-1]["ran_at"] if mine else None,
                      "found": int((hits["platform"] == p).sum()) if not hits.empty else 0,
                      "status": "running" if any(j["status"] == "running" for j in pj) else
                                ("queued" if any(j["status"] == "queued" for j in pj) else
                                 (pj[-1]["status"] if pj else None))}
    return {"q": key, "videos": videos, "terms": term_out, "term_source": (terms[0].get("source") if terms else None),
            "scanning": scanning, "phase": sess.get("status") if scanning else "done", "needs_human": needs_human,
            "log": friendly[-60:], "sources": sources}


@app.get("/api/recent")
def recent():
    with db.connect() as conn:
        groups = conn.execute("SELECT q, MIN(created_at) AS c FROM search_terms GROUP BY q").fetchall()
        grouped_terms = {r["term"] for r in conn.execute("SELECT term FROM search_terms")}
        rows = conn.execute(
            "SELECT kind, query, ran_at, found FROM searches WHERE kind IN ('keyword','hashtag') AND found > 0").fetchall()
        term_rows = conn.execute("SELECT q, term FROM search_terms").fetchall()
    last_by_term: dict[str, int] = {}
    for r in rows:
        t = _norm(r["query"]).lower()
        last_by_term[t] = max(last_by_term.get(t, 0), r["ran_at"])
    out: dict[str, dict] = {}
    for r in term_rows:  # các lần tìm mới (có bộ từ khóa)
        g = out.setdefault(r["q"], {"q": r["q"], "ran_at": 0})
        g["ran_at"] = max(g["ran_at"], last_by_term.get(r["term"], 0))
    for r in rows:  # các lần tìm cũ (trước khi có mở rộng từ khóa)
        t = ("#" if r["kind"] == "hashtag" else "") + _norm(r["query"]).lower()
        if t in grouped_terms or t.lstrip("#") in grouped_terms:
            continue
        g = out.setdefault(t, {"q": t, "ran_at": 0})
        g["ran_at"] = max(g["ran_at"], r["ran_at"])
    return sorted([g for g in out.values() if g["ran_at"]], key=lambda g: g["ran_at"], reverse=True)[:12]


class EnrichReq(BaseModel):
    platform: str
    creator_id: str


@app.post("/api/enrich")
def enrich(req: EnrichReq):
    if req.platform not in PLATFORMS:
        raise HTTPException(400, "Nền tảng không hợp lệ")
    cmd = [sys.executable, "-m", "radar", "enrich", "-p", req.platform, "--creator", req.creator_id]
    job_id = _enqueue("Tính Outlier kênh", cmd, meta={"cmd": cmd, "platform": req.platform, "creator_id": req.creator_id})
    return {"job_id": job_id}


@app.get("/api/jobs")
def jobs():
    items = sorted(JOBS.values(), key=lambda j: j["created"], reverse=True)[:20]
    return [{k: v for k, v in j.items() if k != "meta"} | {"platform": j["meta"].get("platform"),
            "log": j["log"][-30:]} for j in items]


@app.get("/api/jobs/{job_id}")
def job(job_id: str):
    if job_id not in JOBS:
        raise HTTPException(404, "Không tìm thấy lượt quét")
    j = JOBS[job_id]
    return {k: v for k, v in j.items() if k != "meta"} | {"platform": j["meta"].get("platform"), "log": j["log"][-40:]}


# ============================================================================ theo dõi + lịch quét
class WatchReq(BaseModel):
    platform: str
    kind: str = "user"
    query: str
    interval_hours: float = 6


@app.get("/api/watch")
def watch_list():
    with db.connect() as conn:
        rows = [dict(r) for r in conn.execute("SELECT * FROM watch ORDER BY created_at DESC")]
    queued = {(j["meta"].get("watch_id")) for j in JOBS.values() if j["status"] in ("queued", "running")}
    for r in rows:
        r["next_run"] = (r["last_run"] or 0) + r["interval_hours"] * 3600 if r["last_run"] else None
        r["busy"] = r["id"] in queued
    return rows


@app.post("/api/watch")
def watch_add(req: WatchReq):
    q = req.query.strip()
    if req.platform not in PLATFORMS or req.kind not in KINDS or not q:
        raise HTTPException(400, "Thiếu nền tảng, kiểu theo dõi hoặc tên kênh / từ khóa")
    if not 0.5 <= req.interval_hours <= 168:
        raise HTTPException(400, "Tần suất phải từ 0,5 đến 168 giờ")
    with db.connect() as conn:
        try:
            cur = conn.execute(
                "INSERT INTO watch(platform, kind, query, interval_hours, enabled, created_at) VALUES (?,?,?,?,1,?)",
                (req.platform, req.kind, q, req.interval_hours, int(time.time())))
        except Exception:  # noqa: BLE001
            raise HTTPException(409, "Mục này đã có trong danh sách theo dõi") from None
        wid = cur.lastrowid
    _run_watch(wid)  # chạy lần đầu ngay
    return {"id": wid}


class WatchPatch(BaseModel):
    interval_hours: float | None = None
    enabled: bool | None = None


@app.patch("/api/watch/{wid}")
def watch_patch(wid: int, req: WatchPatch):
    with db.connect() as conn:
        if req.interval_hours is not None:
            conn.execute("UPDATE watch SET interval_hours=? WHERE id=?", (req.interval_hours, wid))
        if req.enabled is not None:
            conn.execute("UPDATE watch SET enabled=? WHERE id=?", (1 if req.enabled else 0, wid))
    return {"ok": True}


@app.delete("/api/watch/{wid}")
def watch_delete(wid: int):
    with db.connect() as conn:
        conn.execute("DELETE FROM watch WHERE id=?", (wid,))
    return {"ok": True}


def _run_watch(wid: int) -> str | None:
    with db.connect() as conn:
        r = conn.execute("SELECT * FROM watch WHERE id=?", (wid,)).fetchone()
    if not r:
        return None
    for j in JOBS.values():  # đã xếp hàng rồi thì thôi
        if j["meta"].get("watch_id") == wid and j["status"] in ("queued", "running"):
            return j["id"]
    cmd = _collect_cmd(r["platform"], r["kind"], [r["query"]], 40, 0)
    return _enqueue(r["query"], cmd, source="schedule",
                    meta={"cmd": cmd, "platform": r["platform"], "watch_id": wid, "notify": True})


@app.post("/api/watch/{wid}/run")
def watch_run(wid: int):
    job_id = _run_watch(wid)
    if not job_id:
        raise HTTPException(404, "Không tìm thấy mục theo dõi")
    return {"job_id": job_id}


def _scheduler():
    while True:
        try:
            now = time.time()
            with db.connect() as conn:
                due = [r["id"] for r in conn.execute("SELECT * FROM watch WHERE enabled=1")
                       if not r["last_run"] or now - r["last_run"] >= r["interval_hours"] * 3600]
            for wid in due:
                _run_watch(wid)
        except Exception:  # noqa: BLE001
            pass
        time.sleep(60)


# ============================================================================ cài đặt + Telegram
def _get_settings() -> dict:
    with db.connect() as conn:
        return {r["key"]: r["value"] for r in conn.execute("SELECT * FROM settings")}


class SettingsReq(BaseModel):
    telegram_token: str | None = None
    telegram_chat_id: str | None = None
    notify_min_virality: float | None = None
    gemini_api_key: str | None = None
    search_langs: list[str] | None = None
    max_terms: int | None = None
    limit_per_term: int | None = None


@app.get("/api/settings")
def settings_get():
    s = _get_settings()
    token = s.get("telegram_token") or ""
    gkey = s.get("gemini_api_key") or ""
    prefs = _search_prefs()
    return {"gemini_key_set": bool(gkey), "gemini_key_hint": ("…" + gkey[-4:]) if gkey else "",
            "gemini_model": s.get("gemini_model") or "",
            "search_langs": prefs["langs"], "max_terms": prefs["max_terms"], "limit_per_term": prefs["limit"],
            "telegram_token_set": bool(token), "telegram_token_hint": ("…" + token[-4:]) if token else "",
            "telegram_chat_id": s.get("telegram_chat_id") or "",
            "notify_min_virality": float(s.get("notify_min_virality") or 25)}


@app.post("/api/settings")
def settings_set(req: SettingsReq):
    data = req.model_dump()
    if data.get("search_langs") is not None:
        langs = [x for x in data["search_langs"] if x in ALL_LANGS]
        if not langs:
            raise HTTPException(400, "Chọn ít nhất một ngôn ngữ / thị trường")
        data["search_langs"] = ",".join(langs)
    if data.get("max_terms") is not None and not 1 <= data["max_terms"] <= 8:
        raise HTTPException(400, "Số từ khóa phải từ 1 đến 8")
    if data.get("limit_per_term") is not None and not 10 <= data["limit_per_term"] <= 100:
        raise HTTPException(400, "Số video mỗi từ khóa phải từ 10 đến 100")
    with db.connect() as conn:
        for k, v in data.items():
            if v is not None:
                conn.execute("INSERT INTO settings(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                             (k, str(v).strip()))
    return settings_get()


def _send_telegram(text: str):
    s = _get_settings()
    token, chat = s.get("telegram_token"), s.get("telegram_chat_id")
    if not token or not chat:
        raise RuntimeError("Chưa cài Telegram bot token và chat id")
    r = httpx.post(f"https://api.telegram.org/bot{token}/sendMessage",
                   json={"chat_id": chat, "text": text, "parse_mode": "HTML", "disable_web_page_preview": False},
                   timeout=20)
    if r.status_code != 200:
        raise RuntimeError(f"Telegram trả lỗi {r.status_code}: {r.text[:200]}")


@app.post("/api/settings/test-telegram")
def settings_test():
    try:
        _send_telegram("✅ Viral Radar đã kết nối Telegram. Video bùng nổ sẽ được gửi vào đây.")
    except Exception as e:  # noqa: BLE001
        raise HTTPException(400, str(e)) from None
    return {"ok": True}


def _notify_new_virals():
    s = _get_settings()
    if not s.get("telegram_token") or not s.get("telegram_chat_id"):
        return
    th = float(s.get("notify_min_virality") or 25)
    with db.connect() as conn:
        df = scoring.load_frame(conn)
        sent = {r[0] for r in conn.execute("SELECT video_id FROM notified")}
    if df.empty:
        return
    fresh = df[(df["virality"] >= th) & (df["age_days"] <= 3) & (df["is_ad"] == 0) & (~df["id"].isin(sent))]
    fresh = fresh.sort_values("virality", ascending=False).head(5)
    for _, v in fresh.iterrows():
        name = {"tiktok": "TikTok", "youtube": "YouTube Shorts"}.get(v["platform"], v["platform"])
        cap = (v["caption"] or "").replace("<", "‹").replace(">", "›")[:140]
        _send_telegram(f"🔥 <b>Video đang bùng nổ</b> ({name})\n{cap}\n\n"
                       f"{int(v['views']):,} view · @{v['username']} ({int(v['followers'] or 0):,} follower)\n"
                       f"Virality {v['virality']:.0f} · đăng {v['age_days']:.0f} ngày trước\n{v['url']}")
        with db.connect() as conn:
            conn.execute("INSERT OR IGNORE INTO notified(video_id, ts) VALUES (?,?)", (v["id"], int(time.time())))


# ============================================================================ dữ liệu
def _clean(v):
    if v is None:
        return None
    if isinstance(v, float) and (math.isnan(v) or math.isinf(v)):
        return None
    if isinstance(v, pd.Timestamp):
        return v.isoformat()
    if hasattr(v, "item"):
        return _clean(v.item())
    return v


COLS = ["id", "platform", "url", "username", "nickname", "caption", "hashtags", "music_title", "music_author",
        "products", "cover", "is_ad", "duration", "views", "likes", "comments", "shares", "saves",
        "followers", "median_views", "virality", "tier", "outlier", "x_followers", "engagement",
        "share_rate", "views_per_hour", "velocity_source", "age_days", "created_at", "creator_id", "last_seen"]


@app.get("/api/searches")
def searches():
    with db.connect() as conn:
        rows = conn.execute(
            "SELECT query, platform, kind, MAX(ran_at) AS ran_at, MAX(found) AS found, COUNT(*) AS runs "
            "FROM searches WHERE found > 0 GROUP BY query, platform, kind ORDER BY ran_at DESC"
        ).fetchall()
    return [dict(r) for r in rows]


@app.get("/api/videos")
def videos():
    """Toàn bộ video đã tìm, đã tính điểm. Lọc và sắp xếp làm phía trình duyệt."""
    with db.connect() as conn:
        df = scoring.load_frame(conn)
        if df.empty:
            return []
        hits = pd.read_sql_query(
            "SELECT DISTINCT h.video_id AS id, s.query || '|' || s.platform AS q "
            "FROM search_hits h JOIN searches s ON s.id = h.search_id", conn)
    qmap = hits.groupby("id")["q"].apply(list).to_dict()
    out = []
    for rec in df[COLS].to_dict("records"):
        rec = {k: _clean(v) for k, v in rec.items()}
        rec["queries"] = qmap.get(rec["id"], [])
        out.append(rec)
    return out


@app.get("/api/videos/{video_id}/snapshots")
def video_snapshots(video_id: str):
    with db.connect() as conn:
        rows = conn.execute("SELECT ts, views, likes, comments, shares, saves FROM snapshots WHERE video_id=? ORDER BY ts",
                            (video_id,)).fetchall()
    return [dict(r) for r in rows]


# ---------------------------------------------------------------------------- phân tích AI (bấm mới chạy)
AI_RUNNING: set[str] = set()


@app.get("/api/videos/{video_id}/ai")
def ai_get(video_id: str):
    with db.connect() as conn:
        r = conn.execute("SELECT * FROM ai_analysis WHERE video_id=?", (video_id,)).fetchone()
    s = _get_settings()
    return {"key_set": bool(s.get("gemini_api_key")), "running": video_id in AI_RUNNING,
            "result": json.loads(r["result"]) if r else None, "model": r["model"] if r else None,
            "created_at": r["created_at"] if r else None}


@app.post("/api/videos/{video_id}/ai")
def ai_run(video_id: str):
    from radar import ai
    key = _get_settings().get("gemini_api_key")
    if not key:
        raise HTTPException(400, "Chưa có API key Gemini")
    if video_id in AI_RUNNING:
        raise HTTPException(409, "Video này đang được phân tích, đợi chút")
    with db.connect() as conn:
        df = scoring.load_frame(conn, only_hits=False)
    row = df[df["id"] == video_id]
    if row.empty:
        raise HTTPException(404, "Không tìm thấy video")
    video = {k: _clean(v) for k, v in row.iloc[0].to_dict().items()}
    AI_RUNNING.add(video_id)
    tmp = tempfile.TemporaryDirectory(prefix="viral-radar-ai-")
    try:
        local = None
        if video["platform"] == "tiktok":
            # Tải tạm qua phiên trình duyệt TikTok, xếp chung hàng đợi TikTok để không đụng lượt quét đang chạy
            local = str(Path(tmp.name) / "video.mp4")
            cmd = [sys.executable, "-m", "radar", "fetch-video", video["url"], local]
            jid = _enqueue("Tải video cho AI", cmd, meta={"cmd": cmd, "platform": "tiktok"})
            deadline = time.time() + 600
            while JOBS[jid]["status"] in ("queued", "running") and time.time() < deadline:
                time.sleep(1)
            if JOBS[jid]["status"] != "done" or not Path(local).exists():
                raise ai.AIError("Không tải được video TikTok để AI xem. Video có thể đã bị xóa hoặc TikTok đang chặn, thử lại sau.")
        result, model = ai.analyze_video(key, video, _get_settings().get("gemini_model"), local)
    except ai.AIError as e:
        raise HTTPException(400, str(e)) from None
    except Exception as e:  # noqa: BLE001
        raise HTTPException(500, f"Lỗi khi phân tích: {str(e)[:200]}") from None
    finally:
        AI_RUNNING.discard(video_id)
        tmp.cleanup()  # xóa file video tạm
    now = int(time.time())
    with db.connect() as conn:
        conn.execute("INSERT INTO ai_analysis(video_id, model, result, created_at) VALUES (?,?,?,?) "
                     "ON CONFLICT(video_id) DO UPDATE SET model=excluded.model, result=excluded.result, "
                     "created_at=excluded.created_at", (video_id, model, json.dumps(result, ensure_ascii=False), now))
    return {"key_set": True, "running": False, "result": result, "model": model, "created_at": now}


class KeyReq(BaseModel):
    key: str


@app.post("/api/settings/gemini")
def gemini_key(req: KeyReq):
    """Lưu API key Gemini sau khi thử gọi được danh sách model."""
    from radar import ai
    key = req.key.strip()
    if not key:
        raise HTTPException(400, "Dán API key vào trước đã")
    try:
        model = ai.pick_model(key)
    except ai.AIError as e:
        raise HTTPException(400, str(e)) from None
    except Exception:  # noqa: BLE001
        raise HTTPException(400, "Không kết nối được Google AI Studio. Kiểm tra mạng rồi thử lại.") from None
    with db.connect() as conn:
        for k, v in (("gemini_api_key", key), ("gemini_model", model)):
            conn.execute("INSERT INTO settings(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", (k, v))
    return {"ok": True, "model": model}


@app.delete("/api/settings/gemini")
def gemini_key_delete():
    with db.connect() as conn:
        conn.execute("DELETE FROM settings WHERE key IN ('gemini_api_key','gemini_model')")
    return {"ok": True}


@app.get("/api/breakouts")
def breakouts():
    """Video đang tăng view nhanh nhất, tính từ 2 lần quét gần nhất (cần quét lại ≥ 30 phút)."""
    with db.connect() as conn:
        df = scoring.load_frame(conn)
    if df.empty:
        return []
    df = df[(df["velocity_source"] == "snapshot") & (df["age_days"] <= 14) & (df["views_per_hour"] > 0)]
    df = df.sort_values("views_per_hour", ascending=False).head(24)
    return [{k: _clean(v) for k, v in r.items()} for r in df[COLS].to_dict("records")]


# ============================================================================ web
class NoCacheStatic(StaticFiles):
    """Luôn bắt trình duyệt kiểm tra file mới (tránh giữ CSS/JS cũ sau khi cập nhật)."""
    async def get_response(self, path, scope):
        resp = await super().get_response(path, scope)
        resp.headers["Cache-Control"] = "no-cache"
        return resp


app.mount("/static", NoCacheStatic(directory=WEB), name="static")


@app.get("/")
def index():
    return FileResponse(WEB / "index.html", headers={"Cache-Control": "no-cache"})


if __name__ == "__main__":
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    for _p in PLATFORMS:
        threading.Thread(target=_worker, args=(_p,), daemon=True).start()
    threading.Thread(target=_scheduler, daemon=True).start()
    port = int(os.environ.get("PORT", 8000))
    print(f"Viral Radar đang chạy: http://localhost:{port}")
    uvicorn.run(app, host="127.0.0.1", port=port, log_level="warning")
