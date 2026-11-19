import asyncio
import json
import os
import secrets
import socket
import time
from typing import Dict, Set
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, Response, Request
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
from pathlib import Path
from backend.sudoku_engine import SudokuEngine
import io
import segno

# Token akses dashboard host. Dipakai bersama oleh proses utama dan worker reload lewat env var.
HOST_TOKEN = os.environ.get("SUDOKU_HOST_TOKEN") or secrets.token_urlsafe(9)
os.environ["SUDOKU_HOST_TOKEN"] = HOST_TOKEN

# Jeda minimal antar isian angka per pemain (detik). Menahan bot yang mengisi secepat mungkin.
MIN_MOVE_INTERVAL = 1.5

BASE_DIR = Path(__file__).resolve().parent.parent
FRONTEND_DIR = BASE_DIR / "frontend"

app = FastAPI(title="Sudoku Multiplayer")

# Enable CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.middleware("http")
async def no_cache_static(request: Request, call_next):
    """File frontend sering berubah saat pengembangan; jangan biarkan browser memakai versi lama."""
    response = await call_next(request)
    if not request.url.path.startswith("/api/"):
        response.headers["Cache-Control"] = "no-cache"
    return response
engine = SudokuEngine()

# Game Room State
class GameRoom:
    def __init__(self):
        self.status = "LOBBY"  # LOBBY, COUNTDOWN, PLAYING, FINISHED
        self.difficulty = "medium"
        self.puzzle = None
        self.solution = None
        self.start_timestamp = None
        self.winner = None
        self.rankings = []
        # players: { player_id: dict }
        self.players: Dict[str, dict] = {}
        # host websockets
        self.hosts: Set[WebSocket] = set()
        # chat history (max 50 pesan terakhir)
        self.chat_history = []
        self.results = []

    def get_public_state(self):
        """Returns safe summary of current room state for players/lobby."""
        return {
            "status": self.status,
            "difficulty": self.difficulty,
            "puzzle": self.puzzle,
            "start_timestamp": self.start_timestamp,
            "winner": self.winner,
            "rankings": self.rankings,
            "results": self.results,
            "player_count": len(self.players),
            "players": [
                {
                    "id": pid,
                    "name": p["name"],
                    "progress": p["progress"],
                    "mistakes": p.get("mistakes", 0),
                    "eliminated": p.get("eliminated", False),
                    "finished": p["finished"],
                    "finish_time": p["finish_time"]
                }
                for pid, p in self.players.items()
            ]
        }

    def get_host_state(self):
        """Returns comprehensive state for host spectator dashboard, including boards & errors."""
        return {
            "status": self.status,
            "difficulty": self.difficulty,
            "puzzle": self.puzzle,
            "start_timestamp": self.start_timestamp,
            "winner": self.winner,
            "rankings": self.rankings,
            "players": [
                {
                    "id": pid,
                    "name": p["name"],
                    "board": p["board"],
                    "wrong_cells": list(p.get("wrong_cells", set())),
                    "progress": p["progress"],
                    "filled": p["filled"],
                    "errors": p["errors"],
                    "mistakes": p.get("mistakes", 0),
                    "eliminated": p.get("eliminated", False),
                    "finished": p["finished"],
                    "finish_time": p["finish_time"]
                }
                for pid, p in self.players.items()
            ]
        }

room = GameRoom()

# Pemain yang terputus lebih lama dari ini dianggap sudah selesai (tidak menahan akhir game)
DISCONNECT_GRACE = 20

def is_player_done(p: dict) -> bool:
    if p["finished"] or p.get("eliminated"):
        return True
    if p.get("ws") is None and time.time() - p.get("disconnected_at", 0) > DISCONNECT_GRACE:
        return True
    return False

def build_results():
    """Urutan akhir: yang selesai (waktu tercepat), lalu sisanya berdasarkan progress."""
    players = list(room.players.values())
    done = sorted([p for p in players if p["finished"]], key=lambda p: p["finish_time"])
    rest = sorted([p for p in players if not p["finished"]], key=lambda p: p["progress"], reverse=True)
    results = []
    for idx, p in enumerate(done + rest):
        if p["finished"]:
            status = "finished"
        elif p.get("eliminated"):
            status = "eliminated"
        else:
            status = "unfinished"
        results.append({
            "rank": idx + 1,
            "id": p["id"],
            "name": p["name"],
            "status": status,
            "time": p["finish_time"],
            "mistakes": p.get("mistakes", 0),
            "progress": p["progress"]
        })
    return results

async def check_game_over():
    """Akhiri permainan bila semua pemain sudah selesai atau gugur."""
    if room.status != "PLAYING" or not room.players:
        return
    if not all(is_player_done(p) for p in room.players.values()):
        return
    room.status = "FINISHED"
    room.results = build_results()
    await broadcast_all({
        "type": "game_over",
        "results": room.results,
        "state": room.get_public_state()
    })
    await broadcast_to_hosts({
        "type": "host_sync",
        "state": room.get_host_state()
    })

async def delayed_game_over_check():
    await asyncio.sleep(DISCONNECT_GRACE + 1)
    await check_game_over()

async def drop_player(pid: str, websocket=None):
    """Pemain terputus. Di lobby dihapus; saat game berjalan statusnya disimpan agar refresh tidak mereset."""
    p = room.players.get(pid)
    if not p:
        return
    if websocket is not None and p.get("ws") is not websocket:
        return  # pemain sudah tersambung ulang dengan koneksi baru
    if room.status == "LOBBY":
        del room.players[pid]
        await broadcast_all({
            "type": "player_left",
            "player_id": pid,
            "state": room.get_public_state()
        })
        await broadcast_to_hosts({
            "type": "host_sync",
            "state": room.get_host_state()
        })
    else:
        p["ws"] = None
        p["disconnected_at"] = time.time()
        asyncio.create_task(delayed_game_over_check())

def find_mentions(text: str, sender_id: str) -> dict:
    """Cari pemain yang di-tag dengan @nama (tanpa membedakan huruf besar/kecil). Return {player_id: nama}."""
    low = text.lower()
    found = {}
    for pid, p in room.players.items():
        if pid == sender_id:
            continue
        token = "@" + p["name"].lower()
        start = 0
        while True:
            i = low.find(token, start)
            if i < 0:
                break
            end = i + len(token)
            before_ok = i == 0 or not low[i - 1].isalnum()
            after_ok = end == len(low) or not low[end].isalnum()
            if before_ok and after_ok:
                found[pid] = p["name"]
                break
            start = i + 1
    return found

async def post_chat(sender_id: str, name: str, text: str):
    """Simpan dan sebarkan pesan chat ke semua host & pemain."""
    text = (text or "").strip()[:200]
    if not text:
        return
    entry = {
        "type": "chat",
        "id": sender_id,
        "name": name,
        "text": text,
        "ts": time.time()
    }
    mentions = find_mentions(text, sender_id)
    entry["mentions"] = list(mentions.keys())
    entry["mention_names"] = list(mentions.values())
    room.chat_history.append(entry)
    del room.chat_history[:-50]
    await broadcast_all(entry)

def get_local_ip():
    """IPv4 LAN milik server. Mencoba rute default dulu agar adapter virtual (VirtualBox/WSL/VPN) tidak terpilih."""
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.settimeout(0.2)
        s.connect(('8.8.8.8', 80))  # tidak mengirim paket, hanya memilih interface
        ip = s.getsockname()[0]
        if ip and not ip.startswith('127.'):
            return ip
    except Exception:
        pass
    finally:
        s.close()

    try:
        ip = socket.gethostbyname(socket.gethostname())
        if ip and not ip.startswith('127.'):
            return ip
    except Exception:
        pass
    return '127.0.0.1'

def get_player_base_url(request: Request) -> str:
    """URL yang harus dibuka pemain. Pakai host yang dipakai membuka dashboard, kecuali localhost."""
    host = request.url.hostname or ""
    port = request.url.port or 8000
    if host in ("", "localhost", "127.0.0.1", "::1"):
        host = get_local_ip()
    return f"http://{host}:{port}"
async def broadcast_to_hosts(message: dict):
    """Send JSON payload to all connected host spectator screens."""
    dead_hosts = set()
    for host in room.hosts:
        try:
            await host.send_text(json.dumps(message))
        except Exception:
            dead_hosts.add(host)
    room.hosts.difference_update(dead_hosts)

async def broadcast_to_players(message: dict):
    """Send JSON payload to all active player clients."""
    dead_players = set()
    for pid, p in room.players.items():
        ws = p.get("ws")
        if ws:
            try:
                await ws.send_text(json.dumps(message))
            except Exception:
                dead_players.add(pid)
    for pid in dead_players:
        await drop_player(pid)

async def broadcast_all(message: dict):
    """Broadcast to both hosts and players."""
    await broadcast_to_hosts(message)
    await broadcast_to_players(message)

# REST Endpoint to get server info & IPs
@app.get("/api/server-info")
def server_info(request: Request):
    base = get_player_base_url(request)
    return {
        "local_ip": get_local_ip(),
        "player_url": base,
        "host_url": f"{base}/host.html",
        "qr_code_url": "/api/qr-code"
    }

# REST Endpoint to stream QR Code SVG directly
@app.get("/api/qr-code")
def qr_code_endpoint(request: Request):
    url = get_player_base_url(request)
    qr = segno.make(url, error="m")
    buf = io.BytesIO()
    qr.save(buf, kind="svg", scale=10, border=2, dark="#0f172a", light="#ffffff", xmldecl=False, svgns=True)
    return Response(
        content=buf.getvalue(),
        media_type="image/svg+xml",
        headers={"Cache-Control": "no-store"}
    )
# ===== Hint & Boost =====
HINTS_BY_DIFFICULTY = {"easy": 0, "medium": 2, "hard": 3}
# (id, jumlah kotak yang harus diisi benar untuk membuka boost)
REACTION_EMOJIS = {"🔥", "👏", "😎", "🎉"}
FREEZE_SECONDS = 15
BOOSTS = [("shield", 5), ("heal", 12), ("freeze", 20)]

def init_powers(p: dict):
    p["hints_left"] = HINTS_BY_DIFFICULTY.get(room.difficulty, 0)
    p["correct_cells"] = set()   # kotak yang diisi benar oleh pemain (bukan hint)
    p["boosts_used"] = set()
    p["shield"] = False
    p["frozen_until"] = 0
    p["last_move"] = 0

def is_frozen(p: dict) -> bool:
    return p.get("frozen_until", 0) > time.time()

def frozen_remaining(p: dict) -> float:
    return max(0.0, round(p.get("frozen_until", 0) - time.time(), 1))

def ready_boosts(p: dict) -> set:
    n = len(p.get("correct_cells", ()))
    return {bid for bid, need in BOOSTS if n >= need}

def powers_payload(p: dict) -> dict:
    n = len(p.get("correct_cells", ()))
    boosts = []
    for bid, need in BOOSTS:
        if bid in p.get("boosts_used", ()):
            status = "used"
        elif n >= need:
            status = "ready"
        else:
            status = "locked"
        boosts.append({"id": bid, "need": need, "status": status})
    return {
        "hints_left": p.get("hints_left", 0),
        "hints_total": HINTS_BY_DIFFICULTY.get(room.difficulty, 0),
        "fills": n,
        "boosts": boosts,
        "shield": p.get("shield", False),
    }

async def push_player_update(player_id: str, p: dict):
    """Hitung ulang statistik dan kabari host serta pemain lain."""
    res = engine.evaluate_board(p["board"], room.solution)
    p["progress"] = res["progress"]
    p["filled"] = res["filled"]
    p["errors"] = res["errors"]
    await broadcast_to_hosts({
        "type": "player_board_updated",
        "player_id": player_id,
        "board": p["board"],
        "wrong_cells": list(p["wrong_cells"]),
        "progress": p["progress"],
        "filled": p["filled"],
        "errors": p["errors"],
        "mistakes": p["mistakes"],
        "eliminated": p["eliminated"]
    })
    await broadcast_to_players({
        "type": "opponent_progress",
        "player_id": player_id,
        "name": p["name"],
        "progress": p["progress"],
        "mistakes": p["mistakes"],
        "eliminated": p["eliminated"]
    })
    return res

async def apply_move(player_id: str, player: dict, websocket, r: int, c: int, val: int, via_hint: bool = False):
    """Terapkan isian sel (dari input pemain atau hint), lalu proses akibatnya."""
    if not room.puzzle or room.puzzle[r][c] != 0:
        return  # petunjuk bawaan tidak boleh diubah

    before_ready = ready_boosts(player)
    is_error = False
    shielded = False
    key = f"{r}_{c}"

    if val == 0:
        player["board"][r][c] = 0
        player["wrong_cells"].discard(key)
    else:
        player["board"][r][c] = val
        if val != room.solution[r][c]:
            is_error = True
            player["wrong_cells"].add(key)
            if player.get("shield"):
                player["shield"] = False
                shielded = True
            else:
                player["mistakes"] = player.get("mistakes", 0) + 1
                if player["mistakes"] >= 3:
                    player["eliminated"] = True
        else:
            player["wrong_cells"].discard(key)
            if not via_hint:
                player["correct_cells"].add(key)

    earned = [b for b in ready_boosts(player) - before_ready]
    res = await push_player_update(player_id, player)

    await websocket.send_text(json.dumps({
        "type": "cell_result",
        "row": r,
        "col": c,
        "value": val,
        "is_error": is_error,
        "shielded": shielded,
        "via_hint": via_hint,
        "mistakes": player["mistakes"],
        "max_mistakes": 3,
        "eliminated": player["eliminated"],
        "wrong_cells": list(player["wrong_cells"]),
        "earned": earned,
        "powers": powers_payload(player)
    }))

    if player["eliminated"]:
        await broadcast_all({
            "type": "player_eliminated",
            "player_id": player_id,
            "name": player["name"],
            "mistakes": player["mistakes"]
        })
        await check_game_over()
        return

    if res["is_complete"]:
        elapsed = round(time.time() - room.start_timestamp, 2)
        player["finished"] = True
        player["finish_time"] = elapsed

        rank = len(room.rankings) + 1
        ranking_entry = {
            "rank": rank,
            "id": player_id,
            "name": player["name"],
            "time": elapsed,
            "mistakes": player["mistakes"]
        }
        room.rankings.append(ranking_entry)
        if not room.winner:
            room.winner = ranking_entry

        await broadcast_all({
            "type": "player_completed",
            "player_id": player_id,
            "name": player["name"],
            "time": elapsed,
            "rank": rank,
            "is_winner": (rank == 1),
            "winner": room.winner,
            "rankings": room.rankings
        })
        await check_game_over()

async def apply_boost(player_id: str, player: dict, websocket, boost_id, target_id=None):
    """Pakai boost yang sudah terbuka. Setiap boost hanya sekali per ronde."""
    if boost_id not in ready_boosts(player) or boost_id in player["boosts_used"]:
        return

    if boost_id == "shield":
        if player.get("shield"):
            return
        player["shield"] = True
    elif boost_id == "heal":
        if player.get("mistakes", 0) <= 0:
            return  # tidak ada kesalahan yang dipulihkan, boost tidak terpakai
        player["mistakes"] -= 1
    elif boost_id == "freeze":
        target = room.players.get(target_id) if isinstance(target_id, str) else None
        if (not target or target_id == player_id or not target.get("ws")
                or target.get("eliminated") or target.get("finished") or is_frozen(target)):
            return  # target tidak valid, boost tidak terpakai
        target["frozen_until"] = time.time() + FREEZE_SECONDS
        await broadcast_all({
            "type": "player_frozen",
            "player_id": target_id,
            "name": target["name"],
            "by_name": player["name"],
            "seconds": FREEZE_SECONDS
        })
    else:
        return

    player["boosts_used"].add(boost_id)
    await push_player_update(player_id, player)
    await websocket.send_text(json.dumps({
        "type": "boost_result",
        "boost": boost_id,
        "board": player["board"],
        "wrong_cells": list(player["wrong_cells"]),
        "mistakes": player["mistakes"],
        "powers": powers_payload(player)
    }))
# WebSocket for Host / Spectator Dashboard
@app.websocket("/ws/host")
async def websocket_host(websocket: WebSocket):
    token = websocket.query_params.get("token", "")
    if not secrets.compare_digest(token.encode(), HOST_TOKEN.encode()):
        await websocket.close(code=1008)  # ditolak sebelum menerima koneksi
        return
    await websocket.accept()
    room.hosts.add(websocket)

    # Send current state immediately upon host connecting
    await websocket.send_text(json.dumps({
        "type": "host_sync",
        "state": room.get_host_state()
    }))
    await websocket.send_text(json.dumps({
        "type": "chat_history",
        "messages": room.chat_history
    }))

    try:
        while True:
            data = await websocket.receive_text()
            msg = json.loads(data)
            action = msg.get("action")

            if action == "start_game":
                difficulty = msg.get("difficulty", "medium")
                room.difficulty = difficulty
                room.status = "COUNTDOWN"
                room.winner = None
                room.rankings = []
                room.results = []
                # Buang pemain yang sudah terputus dari ronde sebelumnya
                room.players = {pid: p for pid, p in room.players.items() if p.get("ws")}

                # Generate puzzle
                puzzle_data = engine.generate_puzzle(difficulty)
                room.puzzle = puzzle_data["puzzle"]
                room.solution = puzzle_data["solution"]

                # Reset boards for all players to initial puzzle
                for pid, p in room.players.items():
                    p["board"] = [row[:] for row in room.puzzle]
                    p["wrong_cells"] = set()
                    eval_res = engine.evaluate_board(p["board"], room.solution)
                    p["progress"] = eval_res["progress"]
                    p["filled"] = eval_res["filled"]
                    p["errors"] = 0
                    p["mistakes"] = 0
                    p["eliminated"] = False
                    p["finished"] = False
                    p["finish_time"] = None
                    init_powers(p)

                # 3-Second countdown broadcast
                for count in [3, 2, 1]:
                    await broadcast_all({
                        "type": "countdown",
                        "count": count
                    })
                    await asyncio.sleep(1)

                room.status = "PLAYING"
                room.start_timestamp = time.time()

                # Notify players game has started
                await broadcast_to_players({
                    "type": "game_start",
                    "puzzle": room.puzzle,
                    "difficulty": room.difficulty,
                    "start_timestamp": room.start_timestamp,
                    "state": room.get_public_state()
                })

                # Notify hosts
                await broadcast_to_hosts({
                    "type": "game_start",
                    "state": room.get_host_state()
                })

            elif action == "reset_game":
                room.status = "LOBBY"
                room.puzzle = None
                room.solution = None
                room.start_timestamp = None
                room.winner = None
                room.rankings = []
                room.results = []
                room.players = {pid: p for pid, p in room.players.items() if p.get("ws")}
                for pid, p in room.players.items():
                    p["board"] = []
                    p["wrong_cells"] = set()
                    p["progress"] = 0
                    p["filled"] = 0
                    p["errors"] = 0
                    p["mistakes"] = 0
                    p["eliminated"] = False
                    p["finished"] = False
                    p["finish_time"] = None
                    init_powers(p)

                await broadcast_all({
                    "type": "game_reset",
                    "state": room.get_public_state()
                })
                await broadcast_to_hosts({
                    "type": "host_sync",
                    "state": room.get_host_state()
                })

            elif action == "chat":
                await post_chat("host", "Host", msg.get("text", ""))

            elif action == "kick_player":
                target_pid = msg.get("player_id")
                if target_pid in room.players:
                    t_ws = room.players[target_pid].get("ws")
                    if t_ws:
                        try:
                            await t_ws.send_text(json.dumps({"type": "kicked"}))
                            await t_ws.close()
                        except Exception:
                            pass
                    del room.players[target_pid]
                    await broadcast_all({
                        "type": "lobby_update",
                        "state": room.get_public_state()
                    })
                    await broadcast_to_hosts({
                        "type": "host_sync",
                        "state": room.get_host_state()
                    })

    except WebSocketDisconnect:
        room.hosts.discard(websocket)
    except Exception:
        room.hosts.discard(websocket)

# WebSocket for Players
@app.websocket("/ws/player/{player_id}")
async def websocket_player(websocket: WebSocket, player_id: str):
    await websocket.accept()

    try:
        while True:
            data = await websocket.receive_text()
            msg = json.loads(data)
            action = msg.get("action")

            if action == "join":
                name = msg.get("name", f"Player-{player_id[:4]}").strip() or f"Player-{player_id[:4]}"
                initial_board = [row[:] for row in room.puzzle] if room.puzzle else []

                existing = room.players.get(player_id)
                if existing and room.status != "LOBBY":
                    # Refresh / sambung ulang: pulihkan keadaan, jangan mulai dari awal
                    existing["ws"] = websocket
                    existing["name"] = name
                    existing.pop("disconnected_at", None)
                else:
                    room.players[player_id] = {
                        "id": player_id,
                        "name": name,
                        "ws": websocket,
                        "board": initial_board,
                        "wrong_cells": set(),
                        "progress": 0,
                        "filled": 0,
                        "errors": 0,
                        "mistakes": 0,
                        "eliminated": False,
                        "finished": False,
                        "finish_time": None
                    }
                    init_powers(room.players[player_id])

                me = room.players[player_id]

                # Send initial state to joining player
                await websocket.send_text(json.dumps({
                    "type": "joined_success",
                    "player_id": player_id,
                    "you": {
                        "board": me["board"],
                        "wrong_cells": list(me.get("wrong_cells", set())),
                        "mistakes": me.get("mistakes", 0),
                        "eliminated": me.get("eliminated", False),
                        "finished": me["finished"],
                        "finish_time": me["finish_time"],
                        "powers": powers_payload(me),
                        "frozen_remaining": frozen_remaining(me)
                    },
                    "room_state": room.get_public_state(),
                    "puzzle": room.puzzle if room.status == "PLAYING" else None,
                    "chat_history": room.chat_history
                }))

                # Notify everyone of new player
                await broadcast_all({
                    "type": "lobby_update",
                    "state": room.get_public_state()
                })
                await broadcast_to_hosts({
                    "type": "host_sync",
                    "state": room.get_host_state()
                })

            elif action == "chat":
                if player_id in room.players:
                    p = room.players[player_id]
                    now = time.time()
                    if now - p.get("last_chat", 0) >= 0.7:
                        p["last_chat"] = now
                        await post_chat(player_id, p["name"], msg.get("text", ""))

            elif action == "reaction":
                # Reaksi emoji di lobby: teruskan ke pemain lain
                p = room.players.get(player_id)
                emoji = msg.get("emoji")
                if p and emoji in REACTION_EMOJIS:
                    now = time.time()
                    if now - p.get("last_reaction", 0) >= 0.25:
                        p["last_reaction"] = now
                        payload = json.dumps({
                            "type": "reaction",
                            "player_id": player_id,
                            "name": p["name"],
                            "emoji": emoji
                        })
                        for pid, other in list(room.players.items()):
                            ows = other.get("ws")
                            if pid != player_id and ows:
                                try:
                                    await ows.send_text(payload)
                                except Exception:
                                    pass

            elif action == "slap":
                # Tampar pemain lain, hanya saat di lobby
                p = room.players.get(player_id)
                target_id = msg.get("target")
                target = room.players.get(target_id) if isinstance(target_id, str) else None
                if room.status == "LOBBY" and p and target and target_id != player_id and target.get("ws"):
                    now = time.time()
                    if now - p.get("last_slap", 0) >= 1.5:
                        p["last_slap"] = now
                        try:
                            await target["ws"].send_text(json.dumps({
                                "type": "slapped",
                                "from_id": player_id,
                                "from_name": p["name"]
                            }))
                            await websocket.send_text(json.dumps({
                                "type": "slap_sent",
                                "target_name": target["name"]
                            }))
                        except Exception:
                            pass

            elif action == "spectate":
                # Hanya pemain yang sudah gugur / selesai yang boleh melihat papan lain
                me = room.players.get(player_id)
                if me and (me.get("eliminated") or me.get("finished")):
                    await websocket.send_text(json.dumps({
                        "type": "spectate_data",
                        "puzzle": room.puzzle,
                        "players": [
                            {
                                "id": pid,
                                "name": p["name"],
                                "board": p["board"],
                                "wrong_cells": list(p.get("wrong_cells", set())),
                                "progress": p["progress"],
                                "mistakes": p.get("mistakes", 0),
                                "eliminated": p.get("eliminated", False),
                                "finished": p["finished"],
                                "finish_time": p["finish_time"]
                            }
                            for pid, p in room.players.items()
                            if pid != player_id
                        ]
                    }))

            elif action == "cell_update":
                player = room.players.get(player_id)
                if room.status != "PLAYING" or not player:
                    continue
                if player.get("eliminated") or player.get("finished") or is_frozen(player):
                    continue

                r = msg.get("row")
                c = msg.get("col")
                val = msg.get("value", 0)
                if not (isinstance(r, int) and isinstance(c, int) and isinstance(val, int)):
                    continue
                if 0 <= r < 9 and 0 <= c < 9 and 0 <= val <= 9:
                    if val != 0:
                        now = time.time()
                        wait = MIN_MOVE_INTERVAL - (now - player.get("last_move", 0))
                        if wait > 0:
                            await websocket.send_text(json.dumps({
                                "type": "move_rejected",
                                "reason": "too_fast",
                                "wait": round(wait, 1)
                            }))
                            continue
                        player["last_move"] = now
                    await apply_move(player_id, player, websocket, r, c, val)

            elif action == "use_hint":
                player = room.players.get(player_id)
                if room.status != "PLAYING" or not player:
                    continue
                if player.get("eliminated") or player.get("finished") or is_frozen(player):
                    continue
                r = msg.get("row")
                c = msg.get("col")
                if not (isinstance(r, int) and isinstance(c, int) and 0 <= r < 9 and 0 <= c < 9):
                    continue
                # Hanya sel kosong atau sel yang salah, bukan petunjuk bawaan
                if room.puzzle[r][c] != 0 or player["board"][r][c] == room.solution[r][c]:
                    continue
                if player.get("hints_left", 0) <= 0:
                    continue
                player["hints_left"] -= 1
                await apply_move(player_id, player, websocket, r, c, room.solution[r][c], via_hint=True)

            elif action == "use_boost":
                player = room.players.get(player_id)
                if room.status != "PLAYING" or not player:
                    continue
                if player.get("eliminated") or player.get("finished") or is_frozen(player):
                    continue
                await apply_boost(player_id, player, websocket, msg.get("boost"), msg.get("target"))
    except WebSocketDisconnect:
        await drop_player(player_id, websocket)
    except Exception:
        await drop_player(player_id, websocket)

# Mount frontend files at root
app.mount("/", StaticFiles(directory=str(FRONTEND_DIR), html=True), name="frontend")

if __name__ == "__main__":
    import uvicorn
    local_ip = get_local_ip()
    print("\n" + "=" * 60)
    print("🎮 MULTIPLAYER SUDOKU SERVER IS RUNNING!")
    print("=" * 60)
    print(f"💻 Layar Host / Laptop Server (Spectator Dashboard):")
    print(f"   👉 http://localhost:8000/host.html?token={HOST_TOKEN}")
    print(f"   👉 http://{local_ip}:8000/host.html?token={HOST_TOKEN}")
    print("-" * 60)
    print(f"📱 Layar Pemain (Bisa diakses dari HP / Laptop lain via Wi-Fi):")
    print(f"   👉 http://{local_ip}:8000")
    print("=" * 60 + "\n")
    uvicorn.run("backend.main:app", host="0.0.0.0", port=8000, reload=True)
