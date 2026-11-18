"""Mở rộng từ khóa: "chó" -> chó, cún cưng, dog, puppy, 狗, #dog.

- Có API key Gemini: AI tạo từ đồng nghĩa tiếng Việt, từ tiếng Anh, tiếng Trung và hashtag
  đúng cách người dùng thật hay tìm (hiểu ngữ cảnh ngách, không dịch máy móc).
- Không có key: dùng dịch vụ dịch miễn phí MyMemory để dịch sang tiếng Anh và tiếng Trung.
Mỗi từ khóa gốc chỉ tạo một lần, kết quả lưu trong bảng search_terms.
"""
from __future__ import annotations

import json
import re

import httpx

MAX_TERMS = 6
LANG_LABEL = {"vi": "Việt Nam", "en": "Quốc tế", "zh": "Tiếng Trung"}

PROMPT = """Người dùng muốn tìm video ngắn đang viral trên TikTok và YouTube Shorts về chủ đề: "{q}".
Hãy tạo các từ khóa tìm kiếm mà người dùng THẬT hay gõ cho cùng chủ đề đó, ở 3 thị trường:
- "vi": 1 hoặc 2 biến thể tiếng Việt KHÁC với từ gốc (đồng nghĩa, cách gọi phổ biến). Không lặp lại "{q}".
- "en": 2 từ khóa tiếng Anh phổ biến nhất cho chủ đề này.
- "zh": 1 từ khóa tiếng Trung giản thể.
- "hashtag": 1 hashtag tiếng Anh phổ biến nhất, không kèm dấu #, viết liền không dấu cách.
Mỗi từ khóa ngắn 1 đến 3 từ. Giữ đúng ý định của người dùng (ví dụ "review son" là review son môi, không phải màu sơn)."""

SCHEMA = {"type": "OBJECT", "properties": {
    "vi": {"type": "ARRAY", "items": {"type": "STRING"}},
    "en": {"type": "ARRAY", "items": {"type": "STRING"}},
    "zh": {"type": "ARRAY", "items": {"type": "STRING"}},
    "hashtag": {"type": "STRING"}},
    "required": ["vi", "en", "zh", "hashtag"]}


def _clean(t: str) -> str:
    return " ".join((t or "").strip().split()).lower()


def _gemini(q: str, key: str, model: str) -> dict:
    body = {"contents": [{"role": "user", "parts": [{"text": PROMPT.format(q=q)}]}],
            "generationConfig": {"responseMimeType": "application/json", "responseSchema": SCHEMA, "temperature": 0.3}}
    r = httpx.post(f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent",
                   headers={"x-goog-api-key": key}, json=body, timeout=60)
    r.raise_for_status()
    return json.loads(r.json()["candidates"][0]["content"]["parts"][0]["text"])


def _translate(text: str, target: str) -> str | None:
    """Dịch miễn phí qua MyMemory (không cần key, giới hạn khoảng 5000 ký tự/ngày).
    Dịch vụ trả nhiều phương án; chọn phương án xuất hiện nhiều nhất, hòa thì lấy ngắn nhất
    (ví dụ 'chó' -> 'dog' thay vì 'domestic dog'). Luôn coi từ gốc là tiếng Việt."""
    r = httpx.get("https://api.mymemory.translated.net/get", params={"q": text, "langpair": f"vi|{target}"}, timeout=20)
    r.raise_for_status()
    data = r.json()
    cands = [(data.get("responseData") or {}).get("translatedText") or ""]
    cands += [m.get("translation") or "" for m in data.get("matches") or []]
    cleaned = []
    for c in cands:
        c = re.sub(r"[　\s]+", " ", c).strip(" .,!?。，").strip()
        if c and "MYMEMORY" not in c.upper() and c.lower() != text.lower():
            cleaned.append(c.lower() if target == "en" else c)
    if not cleaned:
        return None
    counts = {c: cleaned.count(c) for c in cleaned}
    return sorted(counts, key=lambda c: (-counts[c], len(c)))[0]


def expand(q: str, gemini_key: str | None = None, gemini_model: str | None = None,
           log=print) -> tuple[list[dict], str]:
    """Trả (danh sách {term, lang}, nguồn tạo: 'ai' | 'dịch' | 'gốc'). Luôn có từ gốc ở đầu."""
    q = _clean(q)
    # người dùng là người Việt, hay gõ không dấu: coi từ gốc là tiếng Việt (trừ khi là chữ Trung)
    terms: list[dict] = [{"term": q, "lang": "zh" if re.search(r"[一-鿿]", q) else "vi"}]
    source = "gốc"

    def add(t, lang):
        t = _clean(t).lstrip("#")
        if lang == "tag":
            t = re.sub(r"[^0-9a-z一-鿿]", "", t)  # hashtag chỉ giữ chữ và số
        if not t:
            return
        term = "#" + t if lang == "tag" else t
        if term not in [x["term"] for x in terms]:
            terms.append({"term": term, "lang": "en" if lang == "tag" else lang})

    if gemini_key and gemini_model:
        try:
            log("AI đang tạo từ khóa liên quan…")
            d = _gemini(q, gemini_key, gemini_model)
            # thứ tự ưu tiên khi cắt bớt: 1 vi, 2 en, 1 zh, hashtag, vi thứ 2
            vi, en, zh = d.get("vi") or [], d.get("en") or [], d.get("zh") or []
            order = [(vi[0] if vi else None, "vi")] + [(e, "en") for e in en[:2]] + \
                    [(zh[0] if zh else None, "zh"), (d.get("hashtag"), "tag"), (vi[1] if len(vi) > 1 else None, "vi")]
            for t, lang in order:
                if t:
                    add(t, lang)
            source = "ai"
        except Exception as e:  # noqa: BLE001
            log(f"AI không tạo được từ khóa ({str(e)[:80]}), chuyển sang dịch tự động.")
    if source != "ai":
        try:
            log("Đang dịch từ khóa sang tiếng Anh và tiếng Trung…")
            en = _translate(q, "en")
            # bỏ bản dịch chỉ chép lại một phần từ gốc ('review son' -> 'son')
            if en and set(en.split()) <= set(q.split()):
                en = None
            if en:
                add(en, "en")
                add(en, "tag")
            zh = _translate(q, "zh-CN")
            if zh:
                add(zh, "zh")
            source = "dịch" if len(terms) > 1 else "gốc"
        except Exception as e:  # noqa: BLE001
            log(f"Không dịch được ({str(e)[:80]}), chỉ tìm bằng từ khóa gốc.")
    return terms[:MAX_TERMS], source
