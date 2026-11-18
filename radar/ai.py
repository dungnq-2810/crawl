"""Phân tích video bằng Gemini (Google AI Studio, có gói miễn phí).

- YouTube Shorts: gửi thẳng link cho Gemini, không tải video.
- TikTok: tải video về thư mục tạm bằng yt-dlp, upload lên Gemini File API,
  phân tích xong thì xóa cả file trên Gemini lẫn file tạm trên máy.
Chỉ chạy khi người dùng bấm nút; kết quả được lưu vào bảng ai_analysis.
"""
from __future__ import annotations

import json
import mimetypes
import tempfile
import time
from pathlib import Path

import httpx
import yt_dlp

API = "https://generativelanguage.googleapis.com"
PREFERRED_MODELS = ("gemini-2.5-flash", "gemini-flash-latest", "gemini-2.0-flash")
MAX_BYTES = 60 * 1024 * 1024  # video ngắn hiếm khi quá 60 MB

PROMPT = """Bạn là chuyên gia phân tích video ngắn viral (TikTok, YouTube Shorts) cho người làm content và affiliate ở Việt Nam.
Hãy XEM KỸ video được đính kèm (hình ảnh, chữ trên màn hình, lời nói, âm thanh) và phân tích vì sao nó viral.

Thông tin thêm về video:
- Nền tảng: {platform}
- Caption: {caption}
- Lượt xem: {views}, follower của kênh: {followers}, thích: {likes}, bình luận: {comments}
- Đăng cách đây khoảng {age} ngày

Yêu cầu:
- Viết bằng tiếng Việt, câu ngắn, cụ thể, dựa trên những gì THẤY và NGHE trong video. Không bịa chi tiết không có trong video.
- "hook.text": câu nói hoặc chữ trên màn hình trong 3 giây đầu, ghi nguyên văn nếu có (giữ nguyên ngôn ngữ gốc).
- "structure": chia video theo mốc thời gian thực tế (ví dụ "0:00-0:03").
- "script": kịch bản để người dùng LÀM LẠI theo cùng công thức nhưng bằng nội dung của họ, không sao chép video gốc.
- "ideas": 3 ý tưởng video mới dựa trên cùng công thức.
"""

SCHEMA = {
    "type": "OBJECT",
    "properties": {
        "summary": {"type": "STRING", "description": "Tóm tắt video trong 1-2 câu"},
        "hook": {
            "type": "OBJECT",
            "properties": {
                "text": {"type": "STRING"},
                "type": {"type": "STRING", "description": "Loại hook: câu hỏi, gây sốc, tò mò, POV, kết quả trước, đặt vấn đề..."},
                "visual": {"type": "STRING", "description": "Khung hình mở đầu trông như thế nào"},
                "why": {"type": "STRING", "description": "Vì sao hook giữ chân người xem"},
            },
            "required": ["text", "type", "visual", "why"],
        },
        "format": {"type": "STRING", "description": "Dạng nội dung: review, hướng dẫn, POV, hài, trước-sau..."},
        "structure": {
            "type": "ARRAY",
            "items": {"type": "OBJECT", "properties": {"time": {"type": "STRING"}, "what": {"type": "STRING"}},
                      "required": ["time", "what"]},
        },
        "why_viral": {"type": "ARRAY", "items": {"type": "STRING"}},
        "emotion": {"type": "STRING", "description": "Cảm xúc chủ đạo video gợi ra"},
        "audience": {"type": "STRING", "description": "Ai xem và chia sẻ video này"},
        "visual_style": {"type": "STRING", "description": "Cách quay, góc máy, chữ trên màn hình, dựng"},
        "audio": {"type": "STRING", "description": "Lời nói, nhạc, hiệu ứng âm thanh được dùng thế nào"},
        "cta": {"type": "STRING", "description": "Lời kêu gọi hành động nếu có, nếu không có ghi 'Không có'"},
        "script": {
            "type": "ARRAY",
            "items": {"type": "OBJECT", "properties": {"time": {"type": "STRING"}, "beat": {"type": "STRING"},
                                                       "say_or_show": {"type": "STRING"}},
                      "required": ["time", "beat", "say_or_show"]},
        },
        "ideas": {"type": "ARRAY", "items": {"type": "STRING"}},
    },
    "required": ["summary", "hook", "format", "structure", "why_viral", "emotion", "audience",
                 "visual_style", "audio", "cta", "script", "ideas"],
}


class AIError(RuntimeError):
    pass


def _headers(key: str) -> dict:
    return {"x-goog-api-key": key}


def _check(r: httpx.Response, what: str):
    if r.status_code >= 400:
        try:
            msg = r.json().get("error", {}).get("message", r.text)
        except Exception:  # noqa: BLE001
            msg = r.text
        if r.status_code in (401, 403) or "API key" in msg:
            raise AIError("API key Gemini không hợp lệ. Kiểm tra lại key trong Google AI Studio.")
        if r.status_code == 429:
            raise AIError("Đã hết lượt miễn phí của Gemini trong lúc này. Đợi một lúc rồi thử lại.")
        raise AIError(f"{what} lỗi {r.status_code}: {msg[:300]}")


def pick_model(key: str, wanted: str | None = None) -> str:
    """Chọn model Gemini có thật trong tài khoản: ưu tiên bản Flash (nhanh, có gói free)."""
    r = httpx.get(f"{API}/v1beta/models", headers=_headers(key), params={"pageSize": 200}, timeout=30)
    _check(r, "Lấy danh sách model")
    names = [m["name"].split("/", 1)[1] for m in r.json().get("models", [])
             if "generateContent" in m.get("supportedGenerationMethods", [])]
    if wanted and wanted in names:
        return wanted
    for p in PREFERRED_MODELS:
        if p in names:
            return p
    flash = [n for n in names if "flash" in n and "lite" not in n and "image" not in n and "tts" not in n]
    if flash:
        return sorted(flash)[-1]
    if names:
        return names[0]
    raise AIError("Tài khoản Gemini không có model nào dùng được.")


def _download(url: str, folder: Path) -> Path:
    opts = {"quiet": True, "no_warnings": True, "noprogress": True, "outtmpl": str(folder / "video.%(ext)s"),
            "format": "best[ext=mp4][height<=720]/best[ext=mp4]/best", "max_filesize": MAX_BYTES}
    try:
        with yt_dlp.YoutubeDL(opts) as y:
            y.extract_info(url, download=True)
    except Exception as e:  # noqa: BLE001
        raise AIError(f"Không tải được video để AI xem ({str(e)[:160]}).") from None
    files = [p for p in folder.iterdir() if p.is_file() and not p.name.endswith(".part")]
    if not files:
        raise AIError("Không tải được video để AI xem.")
    return files[0]


def _upload(key: str, path: Path) -> dict:
    mime = mimetypes.guess_type(path.name)[0] or "video/mp4"
    size = path.stat().st_size
    with httpx.Client(timeout=300) as c:
        r = c.post(f"{API}/upload/v1beta/files", headers={
            **_headers(key), "X-Goog-Upload-Protocol": "resumable", "X-Goog-Upload-Command": "start",
            "X-Goog-Upload-Header-Content-Length": str(size), "X-Goog-Upload-Header-Content-Type": mime,
            "Content-Type": "application/json"}, json={"file": {"display_name": "viral-radar-video"}})
        _check(r, "Gửi video lên Gemini")
        up = r.headers.get("x-goog-upload-url")
        if not up:
            raise AIError("Gemini không trả địa chỉ upload.")
        r = c.post(up, headers={"X-Goog-Upload-Offset": "0", "X-Goog-Upload-Command": "upload, finalize",
                                "Content-Length": str(size)}, content=path.read_bytes())
        _check(r, "Gửi video lên Gemini")
        f = r.json()["file"]
        deadline = time.time() + 180
        while f.get("state") == "PROCESSING" and time.time() < deadline:  # Gemini cần vài giây xử lý video
            time.sleep(3)
            r = c.get(f"{API}/v1beta/{f['name']}", headers=_headers(key))
            _check(r, "Kiểm tra video trên Gemini")
            f = r.json()
        if f.get("state") != "ACTIVE":
            raise AIError("Gemini chưa xử lý xong video. Thử lại sau.")
        return f


def _delete_remote(key: str, name: str):
    try:
        httpx.delete(f"{API}/v1beta/{name}", headers=_headers(key), timeout=30)
    except Exception:  # noqa: BLE001
        pass


def analyze_video(key: str, video: dict, model: str | None = None, local_path: str | None = None) -> tuple[dict, str]:
    """Trả (kết quả phân tích dạng dict, tên model đã dùng).
    local_path: file video đã tải sẵn (TikTok tải qua trình duyệt); nếu không có thì tự tải bằng yt-dlp."""
    model = pick_model(key, model)
    prompt = PROMPT.format(
        platform="TikTok" if video["platform"] == "tiktok" else "YouTube Shorts",
        caption=(video.get("caption") or "")[:600], views=video.get("views"), followers=video.get("followers"),
        likes=video.get("likes"), comments=video.get("comments"), age=round(video.get("age_days") or 0))
    remote = None
    with tempfile.TemporaryDirectory(prefix="viral-radar-") as tmp:
        if video["platform"] == "youtube":
            part = {"file_data": {"file_uri": f"https://www.youtube.com/watch?v={video['id']}", "mime_type": "video/*"}}
        else:
            path = Path(local_path) if local_path else _download(video["url"], Path(tmp))
            remote = _upload(key, path)
            part = {"file_data": {"file_uri": remote["uri"], "mime_type": remote.get("mimeType", "video/mp4")}}
        try:
            body = {"contents": [{"role": "user", "parts": [part, {"text": prompt}]}],
                    "generationConfig": {"responseMimeType": "application/json", "responseSchema": SCHEMA,
                                         "temperature": 0.4}}
            r = httpx.post(f"{API}/v1beta/models/{model}:generateContent", headers=_headers(key), json=body,
                           timeout=300)
            _check(r, "Gemini phân tích")
            data = r.json()
        finally:
            if remote:
                _delete_remote(key, remote["name"])
    try:
        text = data["candidates"][0]["content"]["parts"][0]["text"]
        return json.loads(text), model
    except (KeyError, IndexError, json.JSONDecodeError):
        reason = (data.get("promptFeedback") or {}).get("blockReason") or \
                 ((data.get("candidates") or [{}])[0].get("finishReason"))
        raise AIError(f"Gemini không trả được phân tích{f' ({reason})' if reason else ''}. Thử lại.") from None
