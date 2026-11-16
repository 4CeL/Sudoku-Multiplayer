import asyncio
import json
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
            "solution": self.solution,
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
# WebSocket for Host / Spectator Dashboard
@app.websocket("/ws/host")
async def websocket_host(websocket: WebSocket):
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
                        "finish_time": me["finish_time"]
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
                if room.status != "PLAYING" or player_id not in room.players:
                    continue

                player = room.players[player_id]
                if player.get("eliminated") or player.get("finished"):
                    continue

                r = msg.get("row")
                c = msg.get("col")
                val = msg.get("value", 0)

                # Validate coordinates & value
                if 0 <= r < 9 and 0 <= c < 9 and 0 <= val <= 9:
                    # Prevent overwriting initial puzzle clues
                    if room.puzzle and room.puzzle[r][c] == 0:
                        is_error = False

                        if val == 0:
                            # Erasing cell
                            player["board"][r][c] = 0
                            player["wrong_cells"].discard(f"{r}_{c}")
                        else:
                            expected = room.solution[r][c] if room.solution else 0
                            player["board"][r][c] = val
                            if val != expected:
                                is_error = True
                                player["wrong_cells"].add(f"{r}_{c}")
                                player["mistakes"] = player.get("mistakes", 0) + 1
                                if player["mistakes"] >= 3:
                                    player["eliminated"] = True
                            else:
                                is_error = False
                                player["wrong_cells"].discard(f"{r}_{c}")

                        # Evaluate stats
                        eval_res = engine.evaluate_board(player["board"], room.solution)
                        player["progress"] = eval_res["progress"]
                        player["filled"] = eval_res["filled"]
                        player["errors"] = eval_res["errors"]

                        # 1. Send instant cell result back to current player
                        await websocket.send_text(json.dumps({
                            "type": "cell_result",
                            "row": r,
                            "col": c,
                            "value": val,
                            "is_error": is_error,
                            "mistakes": player["mistakes"],
                            "max_mistakes": 3,
                            "eliminated": player["eliminated"],
                            "wrong_cells": list(player["wrong_cells"])
                        }))

                        # 2. Update Host Spectator Screen in Real-Time!
                        await broadcast_to_hosts({
                            "type": "player_board_updated",
                            "player_id": player_id,
                            "row": r,
                            "col": c,
                            "value": val,
                            "is_error": is_error,
                            "board": player["board"],
                            "wrong_cells": list(player["wrong_cells"]),
                            "progress": player["progress"],
                            "filled": player["filled"],
                            "errors": player["errors"],
                            "mistakes": player["mistakes"],
                            "eliminated": player["eliminated"]
                        })

                        # 3. Broadcast progress bar percentage to other players (competitive ticker)
                        await broadcast_to_players({
                            "type": "opponent_progress",
                            "player_id": player_id,
                            "name": player["name"],
                            "progress": player["progress"],
                            "mistakes": player["mistakes"],
                            "eliminated": player["eliminated"]
                        })

                        # If player is eliminated, notify all
                        if player["eliminated"]:
                            await broadcast_all({
                                "type": "player_eliminated",
                                "player_id": player_id,
                                "name": player["name"],
                                "mistakes": player["mistakes"]
                            })
                            await check_game_over()
                            continue

                        # Check if player completed correctly!
                        if eval_res["is_complete"]:
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

                            # First person to solve is the winner
                            if not room.winner:
                                room.winner = ranking_entry

                            # Notify all players and hosts
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
    print(f"   👉 http://localhost:8000/host.html")
    print(f"   👉 http://{local_ip}:8000/host.html")
    print("-" * 60)
    print(f"📱 Layar Pemain (Bisa diakses dari HP / Laptop lain via Wi-Fi):")
    print(f"   👉 http://{local_ip}:8000")
    print("=" * 60 + "\n")
    uvicorn.run("backend.main:app", host="0.0.0.0", port=8000, reload=True)
