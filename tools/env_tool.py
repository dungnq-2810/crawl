"""Đọc / tạo file .env cho setup.bat (để batch không phải tự parse .env, dễ sai).

    python tools/env_tool.py get KEY [mặc định]      -> in giá trị ra stdout
    python tools/env_tool.py init                     -> tạo .env từ biến môi trường NEW_*
    python tools/env_tool.py copy-token FILE          -> in NGROK_AUTHTOKEN đọc từ 1 file .env khác
Đường dẫn file .env lấy từ biến môi trường ENV_FILE (mặc định .env cạnh setup.bat).
"""
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ENV = Path(os.environ.get("ENV_FILE") or ROOT / ".env")


def parse(path: Path) -> dict:
    out = {}
    if not path.exists():
        return out
    # utf-8-sig: bỏ ký tự BOM ở đầu file (Notepad hay thêm), nếu không dòng đầu sẽ đọc sai khóa
    for line in path.read_text(encoding="utf-8-sig", errors="replace").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, _, v = line.partition("=")
        v = v.strip()
        if len(v) >= 2 and v[0] == v[-1] and v[0] in "\"'":
            v = v[1:-1]
        out[k.strip()] = v
    return out


def main():
    cmd = sys.argv[1] if len(sys.argv) > 1 else ""
    if cmd == "get":
        key = sys.argv[2]
        default = sys.argv[3] if len(sys.argv) > 3 else ""
        val = parse(ENV).get(key) or default
        if key == "NGROK_DOMAIN":  # ngrok chỉ nhận tên miền trần
            val = val.replace("https://", "").replace("http://", "").strip("/")
        sys.stdout.write(val)
    elif cmd == "copy-token":
        sys.stdout.write(parse(Path(sys.argv[2])).get("NGROK_AUTHTOKEN", ""))
    elif cmd == "init":
        g = os.environ.get
        ENV.write_text(
            "# Cấu hình Viral Radar (setup.bat đọc file này). Không chia sẻ file này cho người khác.\n\n"
            "# Cổng chạy web trên máy này\n"
            f"PORT={g('NEW_PORT') or '8000'}\n\n"
            "# Đăng nhập web (bắt buộc khi mở ra ngoài qua ngrok)\n"
            f"VR_USER={g('NEW_USER') or 'admin'}\n"
            f"VR_PASSWORD={g('NEW_PASSWORD') or ''}\n\n"
            "# ngrok: token lấy tại https://dashboard.ngrok.com/get-started/your-authtoken\n"
            "# Domain phải thuộc đúng tài khoản của token, nếu không sẽ lỗi ERR_NGROK_320\n"
            f"NGROK_AUTHTOKEN={g('NEW_TOKEN') or ''}\n"
            f"NGROK_DOMAIN={g('NEW_DOMAIN') or ''}\n",
            encoding="utf-8")
        print(f"Da tao {ENV}")
    else:
        print(__doc__)
        sys.exit(1)


if __name__ == "__main__":
    main()
