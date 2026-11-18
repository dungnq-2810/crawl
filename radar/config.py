from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "data"
DB_PATH = DATA_DIR / "radar.db"
# Hồ sơ trình duyệt riêng của tool (giữ cookie đăng nhập TikTok giữa các lần chạy)
BROWSER_PROFILE = DATA_DIR / "browser-profile"

# Độ trễ ngẫu nhiên giữa các lần cuộn trang (giây) - chạy chậm để tránh bị chặn
SCROLL_DELAY = (1.5, 3.5)
# Dừng cuộn khi bao nhiêu lần liên tiếp không có video mới
MAX_IDLE_SCROLLS = 4
# Ẩn cửa sổ Chrome khi quét TikTok: cửa sổ thật nhưng nằm ngoài màn hình,
# chỉ hiện ra khi TikTok bắt giải captcha. Đặt False để luôn thấy cửa sổ.
HIDE_BROWSER = True
OFFSCREEN_POS = -32000
# Thời gian chờ người dùng tự giải captcha / đăng nhập (giây)
HUMAN_WAIT_SECONDS = 180

DATA_DIR.mkdir(exist_ok=True)
