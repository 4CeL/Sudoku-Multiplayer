let socket = null;
let currentPlayers = {};
let currentPuzzle = null;
let currentSolution = null;
let timerInterval = null;
let startTimestamp = null;

// Kahoot colorful tag palette
const KAHOOT_COLORS = [
  { bg: "#e21b3c", text: "#fff" }, // Red
  { bg: "#1368ce", text: "#fff" }, // Blue
  { bg: "#26890c", text: "#fff" }, // Green
  { bg: "#d89e00", text: "#fff" }, // Yellow/Gold
  { bg: "#864cbf", text: "#fff" }, // Purple
  { bg: "#009999", text: "#fff" }, // Teal
  { bg: "#e65c00", text: "#fff" }, // Orange
  { bg: "#e91e63", text: "#fff" }  // Pink
];

const GAME_AVATARS = [
  "🦊", "🐼", "🐯", "🦁", "🚀", "⚡", "🥑", "🎮",
  "🦄", "🍕", "🎯", "👾", "🐸", "🐨", "🔥", "💎", "⭐", "🐙"
];

function getPlayerKahootColor(nameOrId) {
  let hash = 0;
  const str = String(nameOrId || "player");
  for (let i = 0; i < str.length; i++) {
    hash = (hash << 5) - hash + str.charCodeAt(i);
    hash |= 0;
  }
  return KAHOOT_COLORS[Math.abs(hash) % KAHOOT_COLORS.length];
}

function getPlayerAvatar(nameOrId) {
  let hash = 0;
  const str = String(nameOrId || "player");
  for (let i = 0; i < str.length; i++) {
    hash = (hash << 5) - hash + str.charCodeAt(i);
    hash |= 0;
  }
  return GAME_AVATARS[Math.abs(hash) % GAME_AVATARS.length];
}

// DOM Elements - Views
const hostLobbyView = document.getElementById("hostLobbyView");
const hostGameView = document.getElementById("hostGameView");

// DOM Elements - Lobby
const lobbyPlayerUrlBadge = document.getElementById("lobbyPlayerUrlBadge");
const btnCopyIpLobby = document.getElementById("btnCopyIpLobby");
const lobbyDifficultySelect = document.getElementById("lobbyDifficultySelect");
const btnLobbyStart = document.getElementById("btnLobbyStart");
const lobbyStartHint = document.getElementById("lobbyStartHint");
const lobbyPlayerCountBadge = document.getElementById("lobbyPlayerCountBadge");
const lobbyRosterCount = document.getElementById("lobbyRosterCount");
const lobbyPlayerGrid = document.getElementById("lobbyPlayerGrid");

// DOM Elements - Game / Stage
const playerUrlBadge = document.getElementById("playerUrlBadge");
const btnCopyIp = document.getElementById("btnCopyIp");
const difficultySelect = document.getElementById("difficultySelect");
const btnStartGame = document.getElementById("btnStartGame");
const btnResetGame = document.getElementById("btnResetGame");
const btnReturnToLobby = document.getElementById("btnReturnToLobby");
const playerCountDisplay = document.getElementById("playerCountDisplay");
const activePlayerCount = document.getElementById("activePlayerCount");
const hostTimerDisplay = document.getElementById("hostTimerDisplay");
const roomStatusText = document.getElementById("roomStatusText");
const spectatorGrid = document.getElementById("spectatorGrid");

// Fetch Server & IP Info
async function fetchServerInfo() {
  try {
    const res = await fetch("/api/server-info");
    const data = await res.json();
    if (playerUrlBadge) playerUrlBadge.textContent = data.player_url;
    if (lobbyPlayerUrlBadge) lobbyPlayerUrlBadge.textContent = data.player_url;
  } catch (err) {
    const fallback = `http://${window.location.host}`;
    if (playerUrlBadge) playerUrlBadge.textContent = fallback;
    if (lobbyPlayerUrlBadge) lobbyPlayerUrlBadge.textContent = fallback;
  }
}

function copyUrlAction(btnElement, targetBadge) {
  const url = (targetBadge && targetBadge.textContent) ? targetBadge.textContent : `http://${window.location.host}`;
  navigator.clipboard.writeText(url).then(() => {
    const prevText = btnElement.textContent;
    btnElement.textContent = "✓ Tersalin!";
    setTimeout(() => {
      btnElement.textContent = prevText;
    }, 2000);
  });
}

if (btnCopyIp) {
  btnCopyIp.addEventListener("click", () => copyUrlAction(btnCopyIp, playerUrlBadge));
}
if (btnCopyIpLobby) {
  btnCopyIpLobby.addEventListener("click", () => copyUrlAction(btnCopyIpLobby, lobbyPlayerUrlBadge));
}

// Sync Difficulty Selectors
if (lobbyDifficultySelect && difficultySelect) {
  lobbyDifficultySelect.addEventListener("change", () => {
    difficultySelect.value = lobbyDifficultySelect.value;
  });
  difficultySelect.addEventListener("change", () => {
    lobbyDifficultySelect.value = difficultySelect.value;
  });
}

// Timer Management
function startTimer(startTime) {
  stopTimer();
  startTimestamp = startTime;
  updateTimer();
  timerInterval = setInterval(updateTimer, 500);
}

function stopTimer() {
  if (timerInterval) {
    clearInterval(timerInterval);
    timerInterval = null;
  }
}

function updateTimer() {
  if (!startTimestamp) {
    if (hostTimerDisplay) hostTimerDisplay.textContent = "00:00";
    return;
  }
  const elapsed = Math.floor((Date.now() / 1000) - startTimestamp);
  if (elapsed < 0) {
    if (hostTimerDisplay) hostTimerDisplay.textContent = "00:00";
    return;
  }
  const mins = String(Math.floor(elapsed / 60)).padStart(2, "0");
  const secs = String(elapsed % 60).padStart(2, "0");
  if (hostTimerDisplay) hostTimerDisplay.textContent = `${mins}:${secs}`;
}

// View switching
function showLobbyView() {
  if (hostLobbyView) hostLobbyView.style.display = "flex";
  if (hostGameView) hostGameView.style.display = "none";
}

function showGameView() {
  if (hostLobbyView) hostLobbyView.style.display = "none";
  if (hostGameView) hostGameView.style.display = "block";
}

// Render Kahoot Name Wall (Lobby View)
function renderLobbyRoster() {
  if (!lobbyPlayerGrid) return;
  const players = Object.values(currentPlayers);
  const count = players.length;

  if (lobbyPlayerCountBadge) lobbyPlayerCountBadge.textContent = count;
  if (lobbyRosterCount) lobbyRosterCount.textContent = `${count} pemain`;

  if (count === 0) {
    lobbyPlayerGrid.innerHTML = `
      <div class="k-empty-roster">
        <div class="k-empty-icon">🛋️</div>
        <div class="k-empty-title">Panggung Masih Sepi Nih...</div>
        <div class="k-empty-sub">Ajak teman-teman scan barcode atau buka link di atas untuk bertanding serentak!</div>
      </div>
    `;
    if (btnLobbyStart) {
      btnLobbyStart.disabled = true;
      btnLobbyStart.classList.remove("ready");
    }
    if (lobbyStartHint) lobbyStartHint.textContent = "Menunggu minimal 1 pemain bergabung...";
    return;
  }

  // Enabled start button with Kahoot glow
  if (btnLobbyStart) {
    btnLobbyStart.disabled = false;
    btnLobbyStart.classList.add("ready");
  }
  if (lobbyStartHint) {
    lobbyStartHint.textContent = `🚀 Gas! ${count} pemain sudah siap di arena. Klik untuk mulai!`;
  }

  const ROTATIONS = [-1.5, 1.2, -0.8, 1.8, -1.2, 0.9];

  lobbyPlayerGrid.innerHTML = players.map((p, idx) => {
    const col = getPlayerKahootColor(p.id || p.name);
    const avatar = getPlayerAvatar(p.id || p.name);
    const rot = ROTATIONS[idx % ROTATIONS.length];
    return `
      <div class="k-player-chip" style="--chip-bg: ${col.bg}; --chip-rot: ${rot}deg;" data-pid="${p.id}">
        <span class="k-chip-avatar">${avatar}</span>
        <span class="k-chip-name">${escapeHtml(p.name)}</span>
        <button class="k-chip-kick" title="Keluarkan ${escapeHtml(p.name)}" onclick="kickPlayer('${p.id}')">✕</button>
      </div>
    `;
  }).join("");
}

// Kick player handler
window.kickPlayer = function(pid) {
  if (!socket || socket.readyState !== WebSocket.OPEN) return;
  const p = currentPlayers[pid];
  const name = p ? p.name : "pemain ini";
  if (confirm(`Keluarkan ${name} dari ruangan?`)) {
    socket.send(JSON.stringify({
      action: "kick_player",
      player_id: pid
    }));
  }
};

// WebSocket Connection
function connectHostWebSocket() {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const wsUrl = `${protocol}//${window.location.host}/ws/host`;

  socket = new WebSocket(wsUrl);

  socket.onopen = () => {
    if (roomStatusText) {
      roomStatusText.textContent = "Host Terhubung";
      roomStatusText.classList.add("active");
    }
  };

  socket.onmessage = (event) => {
    const msg = jsonSafeParse(event.data);
    if (!msg) return;

    if (msg.type === "chat") {
      Chat.add(msg);
    }
    else if (msg.type === "chat_history") {
      Chat.history(msg.messages);
    }
    else if (msg.type === "host_sync") {
      syncFullState(msg.state);
    }
    else if (msg.type === "game_over") {
      stopTimer();
      startTimestamp = null;
      if (hostTimerDisplay) hostTimerDisplay.textContent = "00:00";
      if (roomStatusText) {
        roomStatusText.textContent = "Permainan Selesai";
        roomStatusText.classList.remove("active");
      }
      showGameView();
    }
    else if (msg.type === "countdown") {
      if (roomStatusText) {
        roomStatusText.textContent = `Hitungan Mundur: ${msg.count}...`;
      }
      showGameView();
    }
    else if (msg.type === "game_start") {
      if (roomStatusText) {
        roomStatusText.textContent = "Permainan Sedang Berlangsung!";
      }
      showGameView();
      syncFullState(msg.state);
    }
    else if (msg.type === "game_reset") {
      stopTimer();
      startTimestamp = null;
      if (hostTimerDisplay) hostTimerDisplay.textContent = "00:00";
      if (roomStatusText) {
        roomStatusText.textContent = "Menunggu Permainan Dimulai";
      }
      showLobbyView();
      syncFullState(msg.state);
    }
    else if (msg.type === "player_board_updated") {
      updatePlayerLiveBoard(msg);
    }
    else if (msg.type === "player_eliminated") {
      handlePlayerEliminated(msg);
    }
    else if (msg.type === "player_completed") {
      handlePlayerCompleted(msg);
    }
    else if (msg.type === "player_left" || msg.type === "lobby_update") {
      if (msg.state) {
        updatePlayerCounts(msg.state.players ? msg.state.players.length : 0);
        // Update players dictionary
        if (msg.state.players) {
          const newMap = {};
          msg.state.players.forEach(p => {
            newMap[p.id] = {
              ...currentPlayers[p.id],
              ...p
            };
          });
          currentPlayers = newMap;
          renderLobbyRoster();
          renderHostLeaderboard();
        }
      }
    }
  };

  socket.onclose = () => {
    if (roomStatusText) {
      roomStatusText.textContent = "Terputus dari server. Mencoba ulang...";
      roomStatusText.classList.remove("active");
    }
    setTimeout(connectHostWebSocket, 2000);
  };
}

function jsonSafeParse(str) {
  try {
    return JSON.parse(str);
  } catch (e) {
    return null;
  }
}

// Leaderboard in Spectator Dashboard
function renderHostLeaderboard() {
  const body = document.getElementById("hostLeaderboardBody");
  if (!body) return;
  const sorted = Object.values(currentPlayers).sort((a, b) => {
    if (a.finished && !b.finished) return -1;
    if (!a.finished && b.finished) return 1;
    if (a.finished && b.finished) return (a.finish_time || 0) - (b.finish_time || 0);
    if (a.eliminated && !b.eliminated) return 1;
    if (!a.eliminated && b.eliminated) return -1;
    return (b.progress || 0) - (a.progress || 0);
  });

  if (sorted.length === 0) {
    body.innerHTML = '<div style="color: var(--text-muted); font-size: 0.9rem;">Menunggu pemain bergabung...</div>';
    return;
  }

  body.innerHTML = sorted.map((p, idx) => {
    const rank = idx + 1;
    const medal = rank === 1 ? "🥇" : rank === 2 ? "🥈" : rank === 3 ? "🥉" : `#${rank}`;
    const mistakes = Math.min(p.mistakes || 0, 3);
    const progress = p.finished ? 100 : (p.progress || 0);
    let status = `${progress}%`;
    let statusClass = "";
    let barClass = "";
    let rowClass = "lb-row";
    if (p.finished) {
      status = `🏁 ${p.finish_time}s`; statusClass = "lb-finished"; barClass = "lb-bar-done";
    } else if (p.eliminated) {
      status = "💀 Gugur"; statusClass = "lb-eliminated"; barClass = "lb-bar-dead"; rowClass += " lb-row-eliminated";
    }
    return `<div class="${rowClass}">
      <span class="lb-rank">${medal}</span>
      <span class="lb-name">${escapeHtml(p.name)}</span>
      <div class="lb-bar-wrap"><div class="lb-bar ${barClass}" style="width: ${progress}%"></div></div>
      <span class="lb-strikes">${"✖".repeat(mistakes)}<span class="lb-strike-empty">${"○".repeat(3 - mistakes)}</span></span>
      <span class="lb-status ${statusClass}">${status}</span>
    </div>`;
  }).join("");
}

// Sync full state from server
function syncFullState(state) {
  if (!state) return;

  currentPuzzle = state.puzzle;
  currentSolution = state.solution;

  updatePlayerCounts(state.players ? state.players.length : 0);

  // Sync dictionary of players
  currentPlayers = {};
  if (state.players) {
    state.players.forEach(p => {
      currentPlayers[p.id] = p;
    });
  }

  // View state determination
  if (state.status === "LOBBY") {
    showLobbyView();
    renderLobbyRoster();
  } else {
    showGameView();
    if (state.status === "PLAYING" && state.start_timestamp) {
      startTimer(state.start_timestamp);
      if (roomStatusText) roomStatusText.textContent = "Permainan Berlangsung!";
    } else if (state.status === "FINISHED") {
      stopTimer();
      startTimestamp = null;
      if (hostTimerDisplay) hostTimerDisplay.textContent = "00:00";
      if (roomStatusText) roomStatusText.textContent = "Permainan Selesai";
    }
  }

  // Render cards for all players in spectator grid
  if (spectatorGrid) {
    spectatorGrid.innerHTML = "";
    if (state.players) {
      state.players.forEach(p => {
        renderPlayerCard(p);
      });
    }
  }

  renderHostLeaderboard();
}

function updatePlayerCounts(count) {
  if (playerCountDisplay) playerCountDisplay.textContent = count;
  if (activePlayerCount) activePlayerCount.textContent = count;
  if (lobbyPlayerCountBadge) lobbyPlayerCountBadge.textContent = count;
  if (lobbyRosterCount) lobbyRosterCount.textContent = `${count} pemain`;
}

// Render individual spectator player card
function renderPlayerCard(player) {
  if (!spectatorGrid) return;
  let card = document.getElementById(`player-card-${player.id}`);
  if (!card) {
    card = document.createElement("div");
    card.id = `player-card-${player.id}`;
    card.className = "spectator-card";
    spectatorGrid.appendChild(card);
  }

  if (player.finished && player.finish_time) {
    card.classList.add("winner");
  } else {
    card.classList.remove("winner");
  }

  if (player.eliminated) {
    card.classList.add("eliminated");
  } else {
    card.classList.remove("eliminated");
  }

  const mistakes = player.mistakes || 0;
  const isElim = player.eliminated || false;
  const chipClass = isElim ? "strike-chip eliminated" : "strike-chip";
  const chipText = isElim ? "💀 GUGUR (3/3)" : `❌ ${mistakes}/3 Kesalahan`;

  card.innerHTML = `
    <div class="spectator-header">
      <div class="player-title">
        <span>👤 ${escapeHtml(player.name)}</span>
        ${player.finish_time ? `<span style="font-size:0.85rem; color:#f59e0b;">(🏁 ${player.finish_time}s)</span>` : ''}
      </div>
      <div class="${chipClass}" id="card-strike-${player.id}">${chipText}</div>
    </div>

    <!-- Progress Bar -->
    <div>
      <div style="display:flex; justify-content:space-between; font-size:0.8rem; margin-bottom:4px;">
        <span style="color:var(--text-muted);">Progress</span>
        <span id="card-pct-text-${player.id}" style="color:#2563eb; font-weight:700;">${player.progress || 0}% (${player.filled || 0}/81)</span>
      </div>
      <div class="progress-bar-bg">
        <div class="progress-bar-fill ${player.finished ? 'finished' : (isElim ? 'eliminated' : '')}" id="card-bar-${player.id}" style="width: ${player.progress || 0}%"></div>
      </div>
    </div>

    <!-- Mini 9x9 Sudoku Board -->
    <div class="mini-sudoku" id="mini-board-${player.id}">
      <!-- 81 mini cells -->
    </div>
  `;

  // Populate mini 9x9 cells
  const miniBoard = card.querySelector(`#mini-board-${player.id}`);
  const boardData = player.board && player.board.length === 9 ? player.board : (currentPuzzle || Array(9).fill(null).map(() => Array(9).fill(0)));
  const wrongSet = new Set(player.wrong_cells || []);

  for (let r = 0; r < 9; r++) {
    for (let c = 0; c < 9; c++) {
      const cell = document.createElement("div");
      cell.className = "mini-cell";
      cell.dataset.r = r;
      cell.dataset.c = c;

      const val = boardData[r][c];
      const isInitial = currentPuzzle && currentPuzzle[r][c] !== 0;
      const key = `${r}_${c}`;

      if (val !== 0) {
        cell.textContent = val;
        if (isInitial) {
          cell.classList.add("initial");
        } else {
          cell.classList.add("filled");
          if (wrongSet.has(key)) {
            cell.classList.add("error");
          }
        }
      }
      miniBoard.appendChild(cell);
    }
  }
}

// Live update a single player's board without refreshing entire card
function updatePlayerLiveBoard(data) {
  const pid = data.player_id;
  if (currentPlayers[pid]) {
    currentPlayers[pid].progress = data.progress;
    currentPlayers[pid].filled = data.filled;
    currentPlayers[pid].mistakes = data.mistakes;
    currentPlayers[pid].eliminated = data.eliminated;
    currentPlayers[pid].board = data.board;
    currentPlayers[pid].wrong_cells = data.wrong_cells;
    renderHostLeaderboard();
  }

  const card = document.getElementById(`player-card-${pid}`);
  if (!card) {
    if (currentPlayers[pid]) {
      renderPlayerCard(currentPlayers[pid]);
    }
    return;
  }

  // Update progress text & bar
  const pctText = document.getElementById(`card-pct-text-${pid}`);
  const bar = document.getElementById(`card-bar-${pid}`);
  const strikeChip = document.getElementById(`card-strike-${pid}`);

  if (pctText) pctText.textContent = `${data.progress}% (${data.filled}/81)`;
  if (bar) bar.style.width = `${data.progress}%`;

  if (strikeChip) {
    if (data.eliminated) {
      strikeChip.className = "strike-chip eliminated";
      strikeChip.textContent = "💀 GUGUR (3/3)";
      card.classList.add("eliminated");
      if (bar) bar.className = "progress-bar-fill eliminated";
    } else {
      strikeChip.className = "strike-chip";
      strikeChip.textContent = `❌ ${data.mistakes || 0}/3 Kesalahan`;
    }
  }

  // Update specific cell in mini-board
  const cell = card.querySelector(`.mini-cell[data-r="${data.row}"][data-c="${data.col}"]`);
  if (cell) {
    const val = data.value;
    cell.textContent = val !== 0 ? val : "";
    cell.className = "mini-cell";

    const isInitial = currentPuzzle && currentPuzzle[data.row][data.col] !== 0;
    if (val !== 0) {
      if (isInitial) {
        cell.classList.add("initial");
      } else {
        cell.classList.add("filled");
        if (data.is_error) {
          cell.classList.add("error");
        }
      }
    }
  }
}

function handlePlayerEliminated(data) {
  if (currentPlayers[data.player_id]) {
    currentPlayers[data.player_id].eliminated = true;
    currentPlayers[data.player_id].mistakes = data.mistakes;
    renderHostLeaderboard();
  }
  const card = document.getElementById(`player-card-${data.player_id}`);
  if (card) {
    card.classList.add("eliminated");
    const strikeChip = document.getElementById(`card-strike-${data.player_id}`);
    if (strikeChip) {
      strikeChip.className = "strike-chip eliminated";
      strikeChip.textContent = "💀 GUGUR (3/3)";
    }
    const bar = document.getElementById(`card-bar-${data.player_id}`);
    if (bar) bar.className = "progress-bar-fill eliminated";
  }
}

function handlePlayerCompleted(data) {
  if (currentPlayers[data.player_id]) {
    currentPlayers[data.player_id].finished = true;
    currentPlayers[data.player_id].finish_time = data.time;
    currentPlayers[data.player_id].progress = 100;
    renderHostLeaderboard();
  }
  const card = document.getElementById(`player-card-${data.player_id}`);
  if (card) {
    if (data.is_winner) {
      card.classList.add("winner");
    }
    const title = card.querySelector(".player-title");
    if (title) {
      title.innerHTML = `<span>👤 ${escapeHtml(data.name)}</span> <span style="font-size:0.9rem; color:#f59e0b;">(🏆 #${data.rank} - ${data.time}s)</span>`;
    }
    const bar = document.getElementById(`card-bar-${data.player_id}`);
    if (bar) {
      bar.classList.add("finished");
      bar.style.width = "100%";
    }
  }
}

// Trigger Game Start action
function triggerStartGame() {
  if (socket && socket.readyState === WebSocket.OPEN) {
    const diff = (lobbyDifficultySelect && lobbyDifficultySelect.value) || (difficultySelect && difficultySelect.value) || "medium";
    socket.send(JSON.stringify({
      action: "start_game",
      difficulty: diff
    }));
  }
}

// Trigger Game Reset action
function triggerResetGame() {
  if (confirm("Reset permainan dan kembali ke lobby?")) {
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({
        action: "reset_game"
      }));
    }
  }
}

// Host Control Buttons
if (btnStartGame) btnStartGame.addEventListener("click", triggerStartGame);
if (btnLobbyStart) btnLobbyStart.addEventListener("click", triggerStartGame);
if (btnResetGame) btnResetGame.addEventListener("click", triggerResetGame);
if (btnReturnToLobby) btnReturnToLobby.addEventListener("click", triggerResetGame);

function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text || "";
  return div.innerHTML;
}

Chat.init("host", (text) => {
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ action: "chat", text }));
  }
});

Chat.show();

// Initialization
fetchServerInfo();
connectHostWebSocket();
