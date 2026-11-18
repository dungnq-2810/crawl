# Viral Radar · TikTok + YouTube Shorts

Tìm video viral trên TikTok và YouTube Shorts theo từ khóa, hashtag hoặc kênh, chấm điểm viral và hiển thị trên web có link để mở xem.
Không tải video, không cần API key, hoàn toàn miễn phí.

## Cài đặt (1 lần)

```bash
python -m venv .venv
.venv\Scripts\python -m pip install -r requirements.txt
.venv\Scripts\python -m playwright install chromium
```

## Dùng bằng giao diện web

```bash
.venv\Scripts\python server.py
```

Mở http://localhost:8000, gõ chủ đề (ví dụ `chó`) rồi Enter.

**Cài đặt** (nút bánh răng góc phải trên): dán API key Gemini, chọn thị trường/ngôn ngữ cần tìm (Việt Nam, Quốc tế, Tiếng Trung), số từ khóa tối đa và số video mỗi từ khóa. Áp dụng từ lần tìm tiếp theo.

**Mở rộng từ khóa:** tool tự tạo bộ từ khóa ở 3 thị trường, ví dụ `chó` → `chó, dog, #dog, 狗`, rồi tìm **từng từ khóa** trên TikTok và YouTube Shorts (4 từ khóa = 4 lượt mỗi nguồn), gộp kết quả và bỏ trùng.
- Có API key Gemini: AI tạo từ đồng nghĩa, tiếng Anh, tiếng Trung, hashtag (chính xác, hiểu ngữ cảnh).
- Chưa có key: dịch tự động miễn phí qua MyMemory (kém chính xác hơn).
- YouTube tìm đúng thị trường của từng từ khóa (tiếng Việt → Việt Nam, tiếng Anh → Mỹ, tiếng Trung → Đài Loan). TikTok luôn theo IP của máy (Việt Nam).
- Trên trang kết quả: lọc theo từng từ khóa và theo thị trường; bấm "Sửa từ khóa" để bỏ/thêm từ khóa rồi tìm lại.
- Trong lúc quét có bảng tiến độ theo từng từ khóa × nguồn và nhật ký chi tiết. Một lần tìm mới mất khoảng 2–4 phút, video hiện dần. Bấm một video để xem trang phân tích: vì sao nó viral, tương tác so với các video cùng chủ đề, dạng nội dung, độ dài, âm thanh, hashtag, sản phẩm và gợi ý làm video tương tự.

**Phân tích bằng AI (tùy chọn, bấm mới chạy):** trên trang chi tiết video, bấm "Phân tích bằng AI". Gemini xem video và chỉ ra câu mở đầu 3 giây đầu, cấu trúc, vì sao viral, kịch bản để làm lại và 3 ý tưởng mới. Lần đầu cần dán API key Gemini miễn phí (lấy ở https://aistudio.google.com/apikey). Mỗi video chỉ gọi AI 1 lần, kết quả lưu trong `data/radar.db`; bấm "Phân tích lại" mới gọi thêm. YouTube Shorts gửi thẳng link cho Gemini; TikTok được tải tạm qua cửa sổ Chrome của tool, gửi cho Gemini rồi xóa ngay.

Gõ `#hashtag` để tìm theo hashtag. Tìm lại cùng từ khóa trong vòng 30 phút thì dùng kết quả cũ, bấm "Quét lại" để cập nhật.

### Các khu nâng cao (đang ẩn khỏi giao diện, vẫn mở được bằng đường dẫn)

- **Khám phá** (`#/explore`): chọn TikTok hoặc YouTube Shorts, gõ từ khóa rồi Enter (gõ được nhiều từ), bấm **Quét**. Kết quả xếp theo tín hiệu viral, xem dạng lưới, bảng hoặc bản đồ outlier. Bấm một video để mở panel chi tiết.
- **Nhóm theo** (`#/groups`): gộp video theo sản phẩm TikTok Shop, hashtag, âm thanh, kênh. Bấm một dòng để lọc video thuộc nhóm đó.
- **Theo dõi** (`#/watch`): thêm kênh đối thủ hoặc từ khóa, tool tự quét lại theo lịch (khi server đang chạy) và đưa video tăng view nhanh nhất lên mục "Đang bùng nổ".
- **Lịch sử quét** (`#/history`): các lượt quét (chạy lần lượt từng cái), nhật ký, quét lại truy vấn cũ.
- **Cài đặt** (`#/settings`): Telegram bot để nhận thông báo video bùng nổ, chế độ sáng/tối.

Với TikTok, tool dùng một cửa sổ Chrome **ẩn** (cửa sổ thật nhưng nằm ngoài màn hình, bạn không thấy). Nếu TikTok bắt giải captcha, cửa sổ tự hiện lên để bạn giải, giải xong tự ẩn lại. Muốn luôn thấy cửa sổ thì đặt `HIDE_BROWSER = False` trong `radar/config.py`.
Nếu TikTok tạm giới hạn truy cập (báo lỗi "đang tạm giới hạn truy cập"), hãy đợi vài giờ rồi quét lại và quét chậm hơn.
YouTube Shorts lấy dữ liệu trực tiếp, không mở trình duyệt.

Brief thiết kế UI/flow: https://claude.ai/artifact/YGmBoVXa3ACr24DgMEDBdT
(`dashboard.py` là bản Streamlit cũ, vẫn chạy được bằng `python -m streamlit run dashboard.py`.)

## Dùng bằng dòng lệnh

```bash
.venv\Scripts\python -m radar search "review son" "máy hút bụi mini"   # tìm theo từ khóa (TikTok)
.venv\Scripts\python -m radar search "review son" -p youtube           # tìm YouTube Shorts
.venv\Scripts\python -m radar user @tenkenh -p youtube                 # Shorts của một kênh YouTube
.venv\Scripts\python -m radar hashtag reviewlamdep                     # tìm theo hashtag
.venv\Scripts\python -m radar user @tenkenh1 @tenkenh2                 # theo dõi kênh đối thủ
.venv\Scripts\python -m radar enrich --top 20                          # tính điểm outlier cho 20 kênh đứng đầu
.venv\Scripts\python -m radar top -n 20 --days 14 --sort virality      # in top video ra terminal
.venv\Scripts\python -m radar login                                    # (tùy chọn) tự đăng nhập TikTok
```

Tùy chọn chung: `--limit 60` (số video mỗi truy vấn), `--enrich N`, `--headless` (chạy ẩn, dễ bị chặn hơn).

## Các chỉ số

| Chỉ số | Công thức | Đọc thế nào |
|---|---|---|
| **Virality** | `ln(view / follower) × ln(follower)` | ≥35 xuất sắc · 25–35 rất mạnh · 18–25 mạnh · 10–18 tiềm năng. Chỉ có khi view > follower. |
| **Outlier** | `view / trung vị view 30 video gần nhất của kênh` | ≥3x viral · ≥10x mega viral. Cần chạy `enrich`. |
| **× Follower** | `view / follower` | 20x đáng chú ý · 100x xuất sắc |
| **Engagement** | `(like + comment + share + save) / view` | >5% khán giả phản ứng mạnh · <1% lan truyền thụ động |
| **View/giờ** | từ 2 lần quét cách nhau ≥30 phút, nếu chưa có thì `view / số giờ từ lúc đăng` | Quét lại cùng từ khóa vài lần trong ngày để có tốc độ thật |

Dashboard có thêm các tab **Sản phẩm** (sản phẩm TikTok Shop gắn trong video), **Hashtag**, **Âm thanh** và **Kênh**.

## Lưu ý

- Dữ liệu nằm trong `data/radar.db` (SQLite). Hồ sơ trình duyệt của tool nằm ở `data/browser-profile`.
- Trang hashtag của TikTok không trả video khi chưa đăng nhập. Khi đó tool tự chuyển sang tìm `#hashtag`.
  Nếu muốn dùng trang hashtag thật, chạy `radar login` và đăng nhập bằng **tài khoản phụ**.
- Kết quả tìm kiếm phụ thuộc IP (đang ở VN thì ra nội dung VN).
- Số view trong kết quả tìm kiếm được TikTok làm tròn (ví dụ 1,3M). Số liệu trên trang kênh thì chính xác.
- Hãy chạy với tốc độ vừa phải. Cào dữ liệu vi phạm điều khoản của TikTok và có thể bị chặn IP tạm thời.

## Cấu trúc

```
radar/
  tiktok.py    # collector Playwright: mở trang TikTok, bắt JSON từ API nội bộ, parse video
  youtube.py   # collector YouTube Shorts: API tìm kiếm nội bộ + yt-dlp, không cần API key
  ai.py        # phân tích video bằng Gemini (chỉ khi người dùng bấm nút)
  expand.py    # mở rộng từ khóa: Gemini hoặc dịch miễn phí (MyMemory)
  db.py        # SQLite: videos, creators, snapshots, searches
  scoring.py   # tính virality, outlier, engagement, tốc độ view
  __main__.py  # CLI
server.py      # FastAPI: API, hàng đợi lượt quét, lịch quét tự động, Telegram
web/           # giao diện web (index.html, app.css, app.js — không cần build)
dashboard.py   # bản Streamlit cũ
```
