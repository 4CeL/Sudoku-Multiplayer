# 🎮 Sudoku Multiplayer Race (Python + JavaScript)

Game Sudoku Multiplayer berbasis web dengan **Backend Python (FastAPI + WebSocket)** dan **Frontend JavaScript (Tema Putih Bersih & Responsif)**.

Semua pemain mendapatkan **soal Sudoku yang sama secara serentak**. Pemain yang menyelesaikan seluruh papan dengan benar dan waktu tercepat akan menang. Layar Laptop Server bertindak sebagai **Spectator & Host Dashboard**, menampilkan gameplay dan kesalahan setiap pemain secara *real-time*!

---

## 🌟 Fitur Baru & Utama

1. **Validasi Kesalahan Langsung (Instant Validation):**
   - Tidak perlu tombol cek manual! Setiap kali angka dimasukkan, sistem langsung memeriksa kebenarannya secara instan.
   - Jika angka salah: sel langsung berkedip/bergetar dengan warna merah dan kesalahan bertambah.
2. **Batas Kesalahan 3 Kali (3 Strikes System):**
   - Setiap pemain memiliki batas maksimal **3 kali kesalahan** (`❌ 0/3`).
   - Jika pemain melakukan kesalahan ke-3, pemain langsung **Gugur (Tereliminasi)** dan papan terkunci.
   - Layar server/host dan lawan akan langsung melihat status `💀 Gugur`.
3. **Indikator Sisa Angka (1 sampai 9):**
   - Pada tombol numpad angka 1-9, tertera jumlah sisa angka yang masih harus dimasukkan ke papan.
   - Jika semua 9 angka tersebut sudah berhasil diisi dengan benar, tombol numpad otomatis memudar dan menampilkan centang hijau (`✓`).
4. **Desain Tema Putih Bersih (Clean Light Theme):**
   - Antarmuka visual bernuansa putih modern, kontras tinggi, dan nyaman di mata (baik di HP maupun layar laptop).
5. **Dashboard Host & Spectator (Layar Laptop Server):**
   - Melihat papan 9x9 mini dari **semua pemain secara langsung (live)**.
   - Angka salah yang dimasukkan pemain akan langsung terlihat berwarna merah di layar host.
   - Indikator kesalahan pemain (`0/3`, `1/3`, `2/3`, `GUGUR`).
   - Kontrol pertandingan: pilihan kesulitan (**Mudah**, **Sedang**, **Sulit**), hitung mundur, dan reset papan.
6. **Gameplay Nyaman di HP dan Laptop:**
   - **Di HP**: Numpad sentuh 1-9 dengan penghitung sisa angka + tombol hapus.
   - **Di Laptop**: Navigasi panah keyboard (Atas, Bawah, Kiri, Kanan), input angka keyboard 1-9, dan tombol Backspace/Delete.

---

## 🚀 Cara Menjalankan

### 1. Prasyarat
Pastikan Python 3.8+ sudah terinstall. Buka terminal di folder project:

```bash
cd sudoku-multiplayer
pip install -r requirements.txt
```

### 2. Jalankan Server
```bash
python run_server.py
```

Saat server berjalan, terminal akan menampilkan alamat IP lokal Anda, contoh:
```text
=================================================================
🎮  SUDOKU MULTIPLAYER RACE - SERVER SIAP DIGUNAKAN!
=================================================================
💻  TAMPILAN LAPTOP SERVER (Host / Spectator Dashboard):
    👉 http://localhost:8000/host.html
    👉 http://192.168.1.15:8000/host.html
-----------------------------------------------------------------
📱  TAMPILAN SETIAP PEMAIN (Bagikan link ini ke teman se-Wi-Fi):
    👉 http://192.168.1.15:8000
=================================================================
```

### 3. Cara Bermain
1. **Host**: Buka browser di laptop server: `http://localhost:8000/host.html`.
2. **Pemain**: Pastikan HP / laptop pemain terhubung ke Wi-Fi atau Hotspot yang sama dengan server. Buka alamat `http://<IP_LAPTOP>:8000`.
3. Masukkan Nickname pemain, lalu tunggu di lobby.
4. Host memilih tingkat kesulitan dan menekan tombol **"Mulai Permainan"**.
5. Hitungan mundur (3, 2, 1) akan muncul serempak di semua layar dan waktu mulai berjalan!
