import os
import secrets
import sys
import socket
from pathlib import Path
import uvicorn

def get_local_ip():
    try:
        hostname = socket.gethostname()
        ip = socket.gethostbyname(hostname)
        if ip and not ip.startswith('127.'):
            return ip
    except Exception:
        pass

    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.settimeout(0.2)
        s.connect(('10.255.255.255', 1))
        ip = s.getsockname()[0]
    except Exception:
        ip = '127.0.0.1'
    finally:
        s.close()
    return ip

if __name__ == "__main__":
    # Token akses dashboard host; diteruskan ke worker uvicorn lewat env var
    host_token = os.environ.get("SUDOKU_HOST_TOKEN") or secrets.token_urlsafe(9)
    os.environ["SUDOKU_HOST_TOKEN"] = host_token
    local_ip = get_local_ip()
    port = 8000

    print("\n" + "=" * 65)
    print("🎮  SUDOKU MULTIPLAYER RACE - SERVER SIAP DIGUNAKAN!")
    print("=" * 65)
    print("💻  TAMPILAN LAPTOP SERVER (Host / Spectator Dashboard):")
    print(f"    👉 http://localhost:{port}/host.html?token={host_token}")
    print(f"    👉 http://{local_ip}:{port}/host.html?token={host_token}")
    print("-" * 65)
    print("📱  TAMPILAN SETIAP PEMAIN (Bagikan link ini ke teman se-Wi-Fi):")
    print(f"    👉 http://{local_ip}:{port}")
    print("=" * 65)
    print("💡 Catatan:")
    print(" - Pastikan Laptop dan HP pemain terhubung ke Wi-Fi / Hotspot yang sama.")
    print(" - Host bisa memilih tingkat kesulitan (Easy, Medium, Hard) & klik 'Mulai Permainan'.")
    print(" - Papan permainan setiap pemain akan tampil live di dashboard server!")
    print("=" * 65 + "\n")

    # Add root folder to sys.path
    root_path = Path(__file__).resolve().parent
    sys.path.insert(0, str(root_path))

    uvicorn.run("backend.main:app", host="0.0.0.0", port=port, reload=True)
