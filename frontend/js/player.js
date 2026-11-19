let socket = null;
let playerId = localStorage.getItem("sudoku_player_id");
if (!playerId) {
  playerId = "p_" + Math.random().toString(36).substring(2, 9);
  localStorage.setItem("sudoku_player_id", playerId);
}

let playerName = localStorage.getItem("sudoku_player_name") || "";
let currentPuzzle = null;
let currentBoard = Array(9).fill(null).map(() => Array(9).fill(0));
let wrongCells = new Set(); // set of "r_c" strings
let mistakesCount = 0;
let isEliminated = false;
let selectedCell = null; // { row, col }
let timerInterval = null;
let startTimestamp = null;
let isPlaying = false;
let notesMode = false;
let notes = createEmptyNotes(); // notes[r][c] = Set of numbers (hanya lokal)

// Hint & boost (state dari server)
const HINTS_BY_DIFF = { easy: 0, medium: 2, hard: 3 };
const BOOST_LABELS = { shield: "🛡️ Perisai", heal: "❤️ Pulih", freeze: "🧊 Freeze" };
const BOOST_NEEDS = { shield: 5, heal: 12, freeze: 20 };
let powers = { hints_left: 0, hints_total: 0, fills: 0, boosts: [], shield: false };
let toastTimer = null;

function freshPowers(difficulty) {
  const n = HINTS_BY_DIFF[difficulty] || 0;
  return {
    hints_left: n, hints_total: n, fills: 0, shield: false,
    boosts: Object.keys(BOOST_NEEDS).map(id => ({ id, need: BOOST_NEEDS[id], status: "locked" }))
  };
}

function showPowerToast(text) {
  const el = document.getElementById("powerToast");
  if (!el) return;
  el.textContent = text;
  el.style.display = "block";
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.style.display = "none"; }, 2500);
}

function renderPowers() {
  const hintBtn = document.getElementById("btnHint");
  if (hintBtn) {
    document.getElementById("hintCount").textContent = powers.hints_left;
    hintBtn.style.display = powers.hints_total > 0 ? "" : "none";
    hintBtn.disabled = powers.hints_left <= 0;
  }
  document.querySelectorAll(".boost-btn").forEach(btn => {
    const b = (powers.boosts || []).find(x => x.id === btn.dataset.boost);
    if (!b) return;
    btn.classList.remove("locked", "ready", "used");
    btn.classList.add(b.status);
    btn.classList.toggle("active-shield", b.id === "shield" && powers.shield);
    const need = btn.querySelector(".boost-need");
    if (b.status === "locked") need.textContent = `${Math.min(powers.fills, b.need)}/${b.need}`;
    else if (b.status === "used") need.textContent = "terpakai";
    else need.textContent = "siap!";
  });
}

function useHint() {
  if (!isPlaying || isEliminated || isFrozen() || !selectedCell || !currentPuzzle) return;
  const { row, col } = selectedCell;
  if (currentPuzzle[row][col] !== 0 || powers.hints_left <= 0) return;
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ action: "use_hint", row, col }));
  }
}

// ===== FREEZE =====
let frozenUntil = 0; // ms (jam lokal)
let frozenTimer = null;

function isFrozen() {
  return Date.now() < frozenUntil;
}

function startFrozen(seconds, byName) {
  frozenUntil = Date.now() + seconds * 1000;
  document.getElementById("frozenBy").textContent = byName ? `Dibekukan oleh ${byName}` : "Kamu dibekukan!";
  document.getElementById("frozenOverlay").style.display = "flex";
  const tick = () => {
    const left = Math.ceil((frozenUntil - Date.now()) / 1000);
    if (left <= 0) { clearFrozen(); return; }
    document.getElementById("frozenLeft").textContent = left;
  };
  clearInterval(frozenTimer);
  tick();
  frozenTimer = setInterval(tick, 250);
}

function clearFrozen() {
  frozenUntil = 0;
  clearInterval(frozenTimer);
  frozenTimer = null;
  document.getElementById("frozenOverlay").style.display = "none";
}

function openFreezePicker() {
  const list = document.getElementById("freezeList");
  const targets = Object.values(allPlayers).filter(p => p.id !== playerId && !p.eliminated && !p.finished);
  list.innerHTML = targets.length
    ? targets.map(p => `<button class="freeze-target" data-id="${escapeHtml(p.id)}">${escapeHtml(p.name)} · ${p.progress}%</button>`).join("")
    : '<div class="freeze-empty">Tidak ada lawan yang bisa dibekukan.</div>';
  list.querySelectorAll(".freeze-target").forEach(btn => {
    btn.addEventListener("click", () => {
      if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ action: "use_boost", boost: "freeze", target: btn.dataset.id }));
      }
      closeFreezePicker();
    });
  });
  document.getElementById("freezePicker").style.display = "flex";
}

function closeFreezePicker() {
  document.getElementById("freezePicker").style.display = "none";
}

function useBoost(id) {
  if (!isPlaying || isEliminated || isFrozen()) return;
  const b = (powers.boosts || []).find(x => x.id === id);
  if (!b || b.status !== "ready") return;
  if (id === "freeze") {
    openFreezePicker();
    return;
  }
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ action: "use_boost", boost: id }));
  }
}

function createEmptyNotes() {
  return Array.from({ length: 9 }, () => Array.from({ length: 9 }, () => new Set()));
}

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

const FUN_NICKNAMES = [
  "MasterSudoku", "NinjaAngka", "Kilat99", "OtakEinstein", "RajaPapan",
  "KancilCerdas", "DewaLogika", "SiPalingCepat", "KaptenSudoku", "JagoanAngka",
  "DetektifKotak", "SuperSolver", "BintangGrid", "GamerCerdas", "PahlawanGrid"
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

// Leaderboard data: { player_id: { id, name, progress, mistakes, eliminated, finished, finish_time } }
let allPlayers = {};
let myProgress = 0;

// DOM Elements
const joinModal = document.getElementById("joinModal");
const nicknameInput = document.getElementById("nicknameInput");
const btnJoin = document.getElementById("btnJoin");
const countdownModal = document.getElementById("countdownModal");
const countdownDisplay = document.getElementById("countdownDisplay");
const resultModal = document.getElementById("resultModal");
const resultTitle = document.getElementById("resultTitle");
const resultDesc = document.getElementById("resultDesc");
const rankingsTable = document.getElementById("rankingsTable");
const btnCloseResult = document.getElementById("btnCloseResult");
const sudokuGrid = document.getElementById("sudokuGrid");
const gameTimer = document.getElementById("gameTimer");
const gameStatus = document.getElementById("gameStatus");
const mistakeDisplay = document.getElementById("mistakeDisplay");
const leaderboardBody = document.getElementById("leaderboardBody");
const leaderboardCount = document.getElementById("leaderboardCount");
const lobbyScreen = document.getElementById("lobbyScreen");
const lobbyPlayers = document.getElementById("lobbyPlayers");
const lobbyCount = document.getElementById("lobbyCount");
const btnNotes = document.getElementById("btnNotes");
const notesState = document.getElementById("notesState");
const gameContainer = document.getElementById("gameContainer");
const playerAvatarHero = document.getElementById("playerAvatarHero");
const playerNameHero = document.getElementById("playerNameHero");

const joinAvatarPreview = document.getElementById("joinAvatarPreview");
const btnRandomNick = document.getElementById("btnRandomNick");

function updateHeroCard() {
  if (playerNameHero) playerNameHero.textContent = playerName || "Pemain";
  if (playerAvatarHero) {
    // Kunci harus sama dengan chip di daftar "Teman di Ruangan" (id pemain)
    const avatar = getPlayerAvatar(playerId);
    const col = getPlayerKahootColor(playerId);
    playerAvatarHero.textContent = avatar;
    playerAvatarHero.style.background = col.bg;
  }
}

function updateJoinAvatarPreview() {
  if (!joinAvatarPreview) return;
  const val = nicknameInput ? nicknameInput.value.trim() : "";
  const avatar = getPlayerAvatar(val || "Sudoku");
  const col = getPlayerKahootColor(val || "Sudoku");
  joinAvatarPreview.textContent = avatar;
  joinAvatarPreview.style.background = col.bg;
}

// Initialize Grid (81 cells)
function createGrid() {
  sudokuGrid.innerHTML = "";
  for (let r = 0; r < 9; r++) {
    for (let c = 0; c < 9; c++) {
      const cell = document.createElement("div");
      cell.classList.add("sudoku-cell");
      cell.dataset.row = r;
      cell.dataset.col = c;
      cell.addEventListener("click", () => selectCell(r, c));
      sudokuGrid.appendChild(cell);
    }
  }
}

function getCellElement(r, c) {
  return sudokuGrid.querySelector(`.sudoku-cell[data-row="${r}"][data-col="${c}"]`);
}

function selectCell(r, c) {
  if (isEliminated || viewId !== null) return;
  selectedCell = { row: r, col: c };
  updateHighlights();
}

function updateHighlights() {
  const cells = sudokuGrid.querySelectorAll(".sudoku-cell");
  cells.forEach(el => {
    el.classList.remove("selected", "highlighted", "matching-number");
  });

  if (!selectedCell) return;

  const { row, col } = selectedCell;
  const currentVal = currentBoard[row][col];
  const targetCell = getCellElement(row, col);
  if (targetCell) targetCell.classList.add("selected");

  const startRow = Math.floor(row / 3) * 3;
  const startCol = Math.floor(col / 3) * 3;

  cells.forEach(el => {
    const r = parseInt(el.dataset.row);
    const c = parseInt(el.dataset.col);
    const val = currentBoard[r][c];

    // Highlight row, column, and 3x3 block
    const inRow = r === row;
    const inCol = c === col;
    const inBox = r >= startRow && r < startRow + 3 && c >= startCol && c < startCol + 3;

    if (inRow || inCol || inBox) {
      el.classList.add("highlighted");
    }

    // Highlight identical numbers
    if (currentVal !== 0 && val === currentVal) {
      el.classList.add("matching-number");
    }
  });
}

function renderCell(r, c) {
  const el = getCellElement(r, c);
  if (!el) return;
  const val = currentBoard[r][c];
  const isInitial = currentPuzzle && currentPuzzle[r][c] !== 0;
  const key = `${r}_${c}`;

  el.className = "sudoku-cell";

  if (val !== 0) {
    el.textContent = val;
    if (isInitial) {
      el.classList.add("initial");
    } else {
      el.classList.add("user");
      if (wrongCells.has(key)) el.classList.add("error");
    }
  } else if (notes[r][c].size > 0) {
    let html = '<div class="notes-grid">';
    for (let n = 1; n <= 9; n++) {
      html += `<span>${notes[r][c].has(n) ? n : ""}</span>`;
    }
    html += "</div>";
    el.innerHTML = html;
  } else {
    el.textContent = "";
  }
}

function renderBoard() {
  for (let r = 0; r < 9; r++) {
    for (let c = 0; c < 9; c++) {
      renderCell(r, c);
    }
  }
  updateHighlights();
  updateRemainingCounts();
}

function setNotesMode(on) {
  notesMode = on;
  notesState.textContent = on ? "ON" : "OFF";
  btnNotes.classList.toggle("active", on);
}

// Hapus angka n dari catatan di baris, kolom, dan kotak yang sama
function pruneNotes(row, col, n) {
  const sr = Math.floor(row / 3) * 3;
  const sc = Math.floor(col / 3) * 3;
  for (let r = 0; r < 9; r++) {
    for (let c = 0; c < 9; c++) {
      const peer = r === row || c === col || (r >= sr && r < sr + 3 && c >= sc && c < sc + 3);
      if (peer && notes[r][c].delete(n)) renderCell(r, c);
    }
  }
}

// Calculate and update remaining counts for 1-9
function updateRemainingCounts() {
  const counts = {};
  for (let i = 1; i <= 9; i++) counts[i] = 0;

  for (let r = 0; r < 9; r++) {
    for (let c = 0; c < 9; c++) {
      const val = currentBoard[r][c];
      const key = `${r}_${c}`;
      // Count only valid/non-error placed numbers
      if (val >= 1 && val <= 9 && !wrongCells.has(key)) {
        counts[val] = (counts[val] || 0) + 1;
      }
    }
  }

  for (let i = 1; i <= 9; i++) {
    const remaining = Math.max(0, 9 - counts[i]);
    const subEl = document.getElementById(`rem-${i}`);
    const btn = document.querySelector(`.num-btn[data-val="${i}"]`);

    if (subEl) {
      subEl.textContent = remaining === 0 ? "✓" : remaining;
    }
    if (btn) {
      if (remaining === 0) {
        btn.classList.add("completed");
      } else {
        btn.classList.remove("completed");
      }
    }
  }
}

function handleInput(val) {
  if (!isPlaying || isEliminated || isFrozen() || !selectedCell || !currentPuzzle) return;
  const { row, col } = selectedCell;

  // Cannot modify initial clues
  if (currentPuzzle[row][col] !== 0) return;

  let numVal = parseInt(val) || 0;
  const existing = currentBoard[row][col];

  // Mode catatan: toggle angka kecil, hanya pada sel kosong
  if (notesMode && numVal !== 0) {
    if (existing !== 0) return;
    if (notes[row][col].has(numVal)) notes[row][col].delete(numVal);
    else notes[row][col].add(numVal);
    renderCell(row, col);
    updateHighlights();
    return;
  }

  if (numVal === 0) {
    // Hapus: kalau sel kosong, hapus catatannya
    if (existing === 0) {
      if (notes[row][col].size > 0) {
        notes[row][col].clear();
        renderCell(row, col);
        updateHighlights();
      }
      return;
    }
  } else if (existing === numVal) {
    // Menekan angka yang sama lagi = menghapus angka
    numVal = 0;
  }

  // Send update to server for instant validation
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({
      action: "cell_update",
      row: row,
      col: col,
      value: numVal
    }));
  }
}

// Timer management
function startTimer(startTime) {
  stopTimer();
  startTimestamp = startTime;
  updateTimerDisplay();
  timerInterval = setInterval(updateTimerDisplay, 500);
}

function stopTimer() {
  if (timerInterval) {
    clearInterval(timerInterval);
    timerInterval = null;
  }
}

function updateTimerDisplay() {
  if (!startTimestamp) {
    gameTimer.textContent = "00:00";
    return;
  }
  const elapsedSec = Math.floor((Date.now() / 1000) - startTimestamp);
  if (elapsedSec < 0) {
    gameTimer.textContent = "00:00";
    return;
  }
  const mins = String(Math.floor(elapsedSec / 60)).padStart(2, "0");
  const secs = String(elapsedSec % 60).padStart(2, "0");
  gameTimer.textContent = `${mins}:${secs}`;
}

// ===== LEADERBOARD =====

function updateLeaderboardFromPlayers(players) {
  allPlayers = {};
  (players || []).forEach(p => {
    allPlayers[p.id] = {
      id: p.id,
      name: p.name,
      progress: p.progress || 0,
      mistakes: p.mistakes || 0,
      eliminated: p.eliminated || false,
      finished: p.finished || false,
      finish_time: p.finish_time || null
    };
  });
  // Make sure self is present
  if (!allPlayers[playerId]) {
    allPlayers[playerId] = {
      id: playerId,
      name: playerName,
      progress: myProgress,
      mistakes: mistakesCount,
      eliminated: isEliminated,
      finished: false,
      finish_time: null
    };
  }
  renderLeaderboard();
}

function updateSinglePlayerProgress(data) {
  if (allPlayers[data.player_id]) {
    allPlayers[data.player_id].progress = data.progress ?? allPlayers[data.player_id].progress;
    allPlayers[data.player_id].mistakes = data.mistakes ?? allPlayers[data.player_id].mistakes;
    allPlayers[data.player_id].eliminated = data.eliminated ?? allPlayers[data.player_id].eliminated;
  } else {
    allPlayers[data.player_id] = {
      id: data.player_id,
      name: data.name || "???",
      progress: data.progress || 0,
      mistakes: data.mistakes || 0,
      eliminated: data.eliminated || false,
      finished: false,
      finish_time: null
    };
  }
  renderLeaderboard();
}

function updateMyProgress() {
  if (allPlayers[playerId]) {
    allPlayers[playerId].progress = myProgress;
    allPlayers[playerId].mistakes = mistakesCount;
    allPlayers[playerId].eliminated = isEliminated;
  }
  renderLeaderboard();
}

function renderLeaderboard() {
  const sorted = Object.values(allPlayers).sort((a, b) => {
    // Finished players first (by finish_time asc)
    if (a.finished && !b.finished) return -1;
    if (!a.finished && b.finished) return 1;
    if (a.finished && b.finished) return (a.finish_time || 0) - (b.finish_time || 0);
    // Eliminated players last
    if (a.eliminated && !b.eliminated) return 1;
    if (!a.eliminated && b.eliminated) return -1;
    // Then by progress descending
    return b.progress - a.progress;
  });

  leaderboardCount.textContent = `${sorted.length} pemain`;

  let html = "";
  sorted.forEach((p, idx) => {
    const rank = idx + 1;
    const isMe = p.id === playerId;
    const medal = rank === 1 ? "🥇" : rank === 2 ? "🥈" : rank === 3 ? "🥉" : `#${rank}`;

    let statusHtml = "";
    let rowClass = "lb-row";
    if (isMe) rowClass += " lb-me";

    if (p.finished) {
      statusHtml = `<span class="lb-status lb-finished">🏁 ${p.finish_time}s</span>`;
      rowClass += " lb-row-finished";
    } else if (p.eliminated) {
      statusHtml = `<span class="lb-status lb-eliminated">💀 Gugur</span>`;
      rowClass += " lb-row-eliminated";
    } else {
      statusHtml = `<span class="lb-status">${p.progress}%</span>`;
    }

    const mistakeDots = p.mistakes >= 3
      ? '<span class="lb-strikes">✖✖✖</span>'
      : '<span class="lb-strikes">' + '✖'.repeat(p.mistakes) + '<span class="lb-strike-empty">' + '○'.repeat(3 - p.mistakes) + '</span></span>';

    html += `
      <div class="${rowClass}">
        <span class="lb-rank">${medal}</span>
        <span class="lb-name">${escapeHtml(p.name)}${isMe ? ' <span class="lb-you">(Anda)</span>' : ''}</span>
        <div class="lb-bar-wrap">
          <div class="lb-bar ${p.finished ? 'lb-bar-done' : (p.eliminated ? 'lb-bar-dead' : '')}" style="width: ${p.progress}%"></div>
        </div>
        ${mistakeDots}
        ${statusHtml}
      </div>
    `;
  });

  leaderboardBody.innerHTML = html || '<div style="padding: 8px; font-size: 0.8rem; color: var(--text-muted);">Menunggu pemain bergabung...</div>';
}

// ===== MODE PENONTON (setelah gugur / selesai) =====

let iFinished = false;
let viewId = null; // null = papan sendiri, selain itu id pemain yang ditonton
let spectatePlayers = [];
let spectatePuzzle = null;
let spectateTimer = null;

const spectateBar = document.getElementById("spectateBar");
const specName = document.getElementById("specName");
const specMeta = document.getElementById("specMeta");
const btnSpecPrev = document.getElementById("btnSpecPrev");
const btnSpecNext = document.getElementById("btnSpecNext");
const btnSpectateFromResult = document.getElementById("btnSpectateFromResult");
const gameOverScreen = document.getElementById("gameOverScreen");
const gameOverBody = document.getElementById("gameOverBody");
const btnBackToLobby = document.getElementById("btnBackToLobby");

function canSpectate() {
  return isEliminated || iFinished;
}

function requestSpectate() {
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ action: "spectate" }));
  }
}

function stopSpectating() {
  viewId = null;
  spectatePlayers = [];
  if (spectateTimer) {
    clearInterval(spectateTimer);
    spectateTimer = null;
  }
}

function updateSpectateUI() {
  const ok = canSpectate();
  document.body.classList.toggle("spectator-eligible", ok);
  spectateBar.style.display = ok ? "flex" : "none";
  if (!ok) {
    stopSpectating();
    return;
  }
  if (!spectateTimer) {
    requestSpectate();
    spectateTimer = setInterval(requestSpectate, 2000);
  }
  renderSpectateInfo();
}

function renderSpectateInfo() {
  const p = spectatePlayers.find(x => x.id === viewId);
  if (!p) {
    specName.textContent = "Papan kamu";
    specMeta.textContent = spectatePlayers.length
      ? `${spectatePlayers.length} pemain lain · tekan ▶ untuk melihat`
      : "Belum ada pemain lain";
    return;
  }
  specName.textContent = p.name;
  let status = `${p.progress}% · ❌ ${p.mistakes}/3`;
  if (p.finished) status = `🏁 Selesai ${p.finish_time}s`;
  else if (p.eliminated) status = "💀 Gugur";
  specMeta.textContent = status;
}

function renderSpectateBoard(p) {
  const wrong = new Set(p.wrong_cells || []);
  for (let r = 0; r < 9; r++) {
    for (let c = 0; c < 9; c++) {
      const el = getCellElement(r, c);
      const val = (p.board && p.board[r] && p.board[r][c]) || 0;
      const isInitial = spectatePuzzle && spectatePuzzle[r][c] !== 0;
      el.className = "sudoku-cell";
      el.textContent = val !== 0 ? val : "";
      if (val !== 0) {
        if (isInitial) el.classList.add("initial");
        else {
          el.classList.add("user");
          if (wrong.has(`${r}_${c}`)) el.classList.add("error");
        }
      }
    }
  }
}

function showView() {
  const p = spectatePlayers.find(x => x.id === viewId);
  if (p) {
    renderSpectateBoard(p);
  } else {
    viewId = null;
    renderBoard();
  }
  renderSpectateInfo();
}

function cycleView(dir) {
  if (!canSpectate() || spectatePlayers.length === 0) return;
  const ids = [null, ...spectatePlayers.map(p => p.id)];
  let idx = ids.indexOf(viewId);
  if (idx < 0) idx = 0;
  viewId = ids[(idx + dir + ids.length) % ids.length];
  showView();
}

btnSpecNext.addEventListener("click", () => cycleView(1));
btnSpecPrev.addEventListener("click", () => cycleView(-1));
btnSpectateFromResult.addEventListener("click", () => {
  resultModal.style.display = "none";
  cycleView(1);
});

// ===== AKHIR PERMAINAN =====

function resetToLobbyView() {
  clearFrozen();
  closeFreezePicker();
  isPlaying = false;
  isEliminated = false;
  iFinished = false;
  updateSpectateUI();
  mistakesCount = 0;
  mistakeDisplay.textContent = "0/3";
  wrongCells.clear();
  stopTimer();
  startTimestamp = null;
  currentPuzzle = null;
  currentBoard = Array(9).fill(null).map(() => Array(9).fill(0));
  notes = createEmptyNotes();
  selectedCell = null;
  renderBoard();
  gameTimer.textContent = "00:00";
  gameStatus.textContent = "Menunggu Host...";
  gameStatus.className = "status-badge";
  resultModal.style.display = "none";
  countdownModal.style.display = "none";
  gameOverScreen.style.display = "none";
  joinModal.style.display = "none";
  if (gameContainer) gameContainer.style.display = "none";
  lobbyScreen.style.display = "flex";
  updateHeroCard();
}

function showGameOver(results) {
  clearFrozen();
  closeFreezePicker();
  isPlaying = false;
  stopTimer();
  startTimestamp = null;
  gameTimer.textContent = "00:00";
  gameStatus.textContent = "Permainan Selesai";
  gameStatus.className = "status-badge";
  stopSpectating();
  document.body.classList.remove("spectator-eligible");
  spectateBar.style.display = "none";

  resultModal.style.display = "none";
  countdownModal.style.display = "none";
  lobbyScreen.style.display = "none";
  joinModal.style.display = "none";

  let html = `<table class="go-table"><tr><th>#</th><th>Nama</th><th>Hasil</th><th>Salah</th></tr>`;
  (results || []).forEach(r => {
    const isMe = r.id === playerId;
    const medal = r.status === "finished" && r.rank <= 3 ? ["🥇", "🥈", "🥉"][r.rank - 1] : r.rank;
    let outcome = `⏳ ${r.progress}%`;
    if (r.status === "finished") outcome = `🏁 ${r.time}s`;
    else if (r.status === "eliminated") outcome = "💀 Gugur";
    html += `<tr class="${isMe ? "go-me" : ""}">
      <td>${medal}</td>
      <td>${escapeHtml(r.name)}${isMe ? " (Anda)" : ""}</td>
      <td>${outcome}</td>
      <td>${r.mistakes}/3</td>
    </tr>`;
  });
  html += "</table>";
  gameOverBody.innerHTML = html;
  gameOverScreen.style.display = "flex";
}

btnBackToLobby.addEventListener("click", resetToLobbyView);
// ===== LOBBY =====

function renderLobby() {
  const list = Object.values(allPlayers);
  if (lobbyCount) lobbyCount.textContent = list.length;
  if (!lobbyPlayers) return;

  if (list.length === 0) {
    lobbyPlayers.innerHTML = '<div style="color: var(--text-muted); font-size: 0.85rem; padding: 14px; text-align: center; width: 100%;">Menunggu pemain lain bergabung...</div>';
    return;
  }

  lobbyPlayers.innerHTML = list.map(p => {
    const isMe = p.id === playerId;
    const col = getPlayerKahootColor(p.id || p.name);
    const avatar = getPlayerAvatar(p.id || p.name);
    return `
      <div class="k-lobby-player-chip${isMe ? " k-chip-me" : ""}" style="--chip-bg: ${col.bg};">
        <span class="k-p-chip-avatar">${avatar}</span>
        <span class="k-p-chip-name">${escapeHtml(p.name)}${isMe ? ' <span class="k-chip-you">(Anda)</span>' : ""}</span>
        <span class="k-p-chip-ready">✓ Siap</span>
      </div>`;
  }).join("");
}

function updateOpponents(players) {
  updateLeaderboardFromPlayers(players);
  renderLobby();
}

function updateSingleOpponentProgress(data) {
  updateSinglePlayerProgress(data);
}

// WebSocket Connection
function connectWebSocket() {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const wsUrl = `${protocol}//${window.location.host}/ws/player/${playerId}`;

  socket = new WebSocket(wsUrl);

  socket.onopen = () => {
    socket.send(JSON.stringify({
      action: "join",
      name: playerName
    }));
  };

  socket.onmessage = (event) => {
    const data = JSON.parse(event.data);

    if (data.type === "chat") {
      Chat.add(data);
    }
    else if (data.type === "joined_success") {
      Chat.show();
      Chat.history(data.chat_history);
      gameStatus.textContent = "Terhubung - Menunggu Game";
      const roomStatus = data.room_state.status;
      updateOpponents(data.room_state.players);

      if (roomStatus === "PLAYING" && data.puzzle) {
        // Pulihkan keadaan sendiri (refresh tidak boleh mengulang dari awal)
        const you = data.you || {};
        joinModal.style.display = "none";
        lobbyScreen.style.display = "none";
        if (gameContainer) gameContainer.style.display = "flex";
        currentPuzzle = data.puzzle;
        currentBoard = (you.board && you.board.length === 9)
          ? you.board.map(r => r.slice())
          : data.puzzle.map(r => r.slice());
        wrongCells = new Set(you.wrong_cells || []);
        mistakesCount = you.mistakes || 0;
        mistakeDisplay.textContent = `${mistakesCount}/3`;
        isEliminated = !!you.eliminated;
        iFinished = !!you.finished;
        if (you.powers) { powers = you.powers; renderPowers(); }
        if (you.frozen_remaining > 0) startFrozen(you.frozen_remaining, null);
        isPlaying = !isEliminated && !iFinished;
        renderBoard();
        startTimer(data.room_state.start_timestamp);
        if (isEliminated) {
          gameStatus.textContent = "💀 Tereliminasi";
          gameStatus.className = "status-badge danger";
        } else if (iFinished) {
          gameStatus.textContent = "🏁 Selesai";
          gameStatus.className = "status-badge active";
        } else {
          gameStatus.textContent = "Bermain!";
          gameStatus.classList.add("active");
        }
        updateSpectateUI();
      } else if (roomStatus === "FINISHED") {
        showGameOver(data.room_state.results);
      } else {
        joinModal.style.display = "none";
        lobbyScreen.style.display = "flex";
        if (gameContainer) gameContainer.style.display = "none";
        updateHeroCard();
      }
    }
    else if (data.type === "move_rejected") {
      showPowerToast("Terlalu cepat, tunggu sebentar");
    }
    else if (data.type === "slapped") {
      playSlap(data.from_name);
    }
    else if (data.type === "slap_sent") {
      spawnFloatingEmoji("\u{1F44B}", `ke ${data.target_name}`);
    }
    else if (data.type === "reaction") {
      spawnFloatingEmoji(data.emoji, data.name);
    }
    else if (data.type === "game_over") {
      showGameOver(data.results);
    }
    else if (data.type === "countdown") {
      joinModal.style.display = "none";
      lobbyScreen.style.display = "none";
      if (gameContainer) gameContainer.style.display = "none";
      resultModal.style.display = "none";
      countdownModal.style.display = "flex";
      countdownDisplay.textContent = data.count;
    }
    else if (data.type === "spectate_data") {
      spectatePlayers = data.players || [];
      spectatePuzzle = data.puzzle;
      if (viewId !== null) showView();
      else renderSpectateInfo();
    }
    else if (data.type === "game_start") {
      iFinished = false;
      isEliminated = false;
      updateSpectateUI();
      countdownModal.style.display = "none";
      lobbyScreen.style.display = "none";
      joinModal.style.display = "none";
      if (gameContainer) gameContainer.style.display = "flex";
      currentPuzzle = data.puzzle;
      currentBoard = data.puzzle.map(row => row.slice());
      notes = createEmptyNotes();
      if (data.state && data.state.players) updateOpponents(data.state.players);
      wrongCells.clear();
      mistakesCount = 0;
      isEliminated = false;
      mistakeDisplay.textContent = "0/3";
      clearFrozen();
      powers = freshPowers(data.difficulty);
      renderPowers();
      isPlaying = true;
      selectedCell = null;
      renderBoard();
      startTimer(data.start_timestamp);
      gameStatus.textContent = "Bermain!";
      gameStatus.classList.remove("danger");
      gameStatus.classList.add("active");
    }
    else if (data.type === "cell_result") {
      // Instant validation response from server
      const { row, col, value, is_error, mistakes, eliminated } = data;
      currentBoard[row][col] = value;
      const key = `${row}_${col}`;

      mistakesCount = mistakes;
      mistakeDisplay.textContent = `${mistakes}/3`;

      if (value !== 0) notes[row][col].clear();
      if (is_error) wrongCells.add(key);
      else wrongCells.delete(key);

      renderCell(row, col);
      if (value !== 0 && !is_error) pruneNotes(row, col, value);

      if (is_error) {
        const cellEl = getCellElement(row, col);
        if (cellEl) {
          cellEl.classList.add("shake");
          setTimeout(() => cellEl.classList.remove("shake"), 400);
        }
      }

      updateHighlights();
      updateRemainingCounts();
      if (data.powers) { powers = data.powers; renderPowers(); }
      if (data.shielded) showPowerToast("🛡️ Perisai menahan kesalahan!");
      if (data.earned && data.earned.length) {
        showPowerToast("🎁 Boost baru: " + data.earned.map(b => BOOST_LABELS[b]).join(", "));
      }

      if (eliminated) {
        isEliminated = true;
        updateSpectateUI();
        isPlaying = false;
        gameStatus.textContent = "💀 Tereliminasi";
        gameStatus.className = "status-badge danger";
        showEliminationModal();
      }
    }
    else if (data.type === "boost_result") {
      currentBoard = data.board.map(r => r.slice());
      wrongCells = new Set(data.wrong_cells || []);
      mistakesCount = data.mistakes;
      mistakeDisplay.textContent = `${mistakesCount}/3`;
      powers = data.powers;
      renderBoard();
      renderPowers();
      if (data.boost !== "freeze") showPowerToast(BOOST_LABELS[data.boost] + " dipakai");
    }
    else if (data.type === "player_frozen") {
      if (data.player_id === playerId) {
        startFrozen(data.seconds, data.by_name);
      } else if (data.by_name === playerName) {
        showPowerToast(`🧊 ${data.name} dibekukan ${data.seconds} detik`);
      }
    }
    else if (data.type === "player_eliminated") {
      if (data.player_id === playerId) {
        isEliminated = true;
        updateSpectateUI();
        isPlaying = false;
        gameStatus.textContent = "💀 Tereliminasi";
        gameStatus.className = "status-badge danger";
        showEliminationModal();
      }
    }
    else if (data.type === "game_reset") {
      resetToLobbyView();
      if (data.state && data.state.players) {
        updateOpponents(data.state.players);
      }
    }
    else if (data.type === "lobby_update" || data.type === "player_left") {
      if (data.state && data.state.players) {
        updateOpponents(data.state.players);
      }
    }
    else if (data.type === "opponent_progress") {
      updateSingleOpponentProgress(data);
    }
    else if (data.type === "player_completed") {
      if (data.player_id === playerId) {
        isPlaying = false;
        iFinished = true;
        stopTimer();
        updateSpectateUI();
      }
      if (allPlayers[data.player_id]) {
        allPlayers[data.player_id].finished = true;
        allPlayers[data.player_id].finish_time = data.time;
        allPlayers[data.player_id].progress = 100;
        renderLeaderboard();
      }
      // Modal hanya untuk pemain yang baru selesai; pemain lain cukup lihat leaderboard
      if (data.player_id === playerId) {
        showResultModal(data);
      }
    }
  };

  socket.onclose = () => {
    gameStatus.textContent = "Terputus dari server. Mencoba menghubungkan kembali...";
    gameStatus.classList.remove("active");
    setTimeout(connectWebSocket, 2000);
  };
}

function showEliminationModal() {
  resultModal.style.display = "flex";
  resultTitle.textContent = "💀 GAME OVER";
  resultTitle.style.color = "#dc2626";
  resultDesc.textContent = "Anda telah melakukan 3 kali kesalahan dan gugur dari pertandingan ini.";
  document.getElementById("resultSticker").style.display = "none";
  rankingsTable.innerHTML = "";
}

function showResultModal(data) {
  resultModal.style.display = "flex";
  // Sticker hanya untuk pemain yang berhasil menyelesaikan papan
  document.getElementById("resultSticker").style.display =
    data.player_id === playerId ? "block" : "none";
  resultTitle.style.color = "#0f172a";

  if (data.is_winner) {
    if (data.player_id === playerId) {
      resultTitle.textContent = "🏆 KAMU MENANG!";
      resultDesc.textContent = `Luar biasa! Kamu menyelesaikan papan tercepat dalam ${data.time} detik!`;
    } else {
      resultTitle.textContent = "🏁 Ada Pemenang!";
      resultDesc.textContent = `${data.name} menjadi yang tercepat dalam ${data.time} detik!`;
    }
  } else {
    resultTitle.textContent = "🏁 Pemain Selesai!";
    resultDesc.textContent = `${data.name} menyelesaikan papan pada peringkat #${data.rank} (${data.time}s)`;
  }

  // Display rankings
  if (data.rankings) {
    let html = `<table style="width:100%; border-collapse: collapse; font-size: 0.95rem;">
      <tr style="border-bottom: 2px solid var(--border-color); color: var(--text-muted);">
        <th style="padding: 8px;">Peringkat</th>
        <th style="padding: 8px;">Nama</th>
        <th style="padding: 8px; text-align: center;">Kesalahan</th>
        <th style="padding: 8px; text-align: right;">Waktu</th>
      </tr>`;
    data.rankings.forEach(r => {
      const isMe = r.id === playerId;
      html += `<tr style="border-bottom: 1px solid #f1f5f9; ${isMe ? 'color: #2563eb; font-weight: bold;' : ''}">
        <td style="padding: 8px;">#${r.rank} ${r.rank === 1 ? '🥇' : r.rank === 2 ? '🥈' : r.rank === 3 ? '🥉' : ''}</td>
        <td style="padding: 8px;">${escapeHtml(r.name)} ${isMe ? '(Anda)' : ''}</td>
        <td style="padding: 8px; text-align: center; color: #dc2626;">${r.mistakes || 0}/3</td>
        <td style="padding: 8px; text-align: right;">${r.time}s</td>
      </tr>`;
    });
    html += `</table>`;
    rankingsTable.innerHTML = html;
  }
}

function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text || "";
  return div.innerHTML;
}

// User Interaction Event Listeners
btnJoin.addEventListener("click", () => {
  const name = nicknameInput.value.trim();
  if (name) {
    playerName = name;
    localStorage.setItem("sudoku_player_name", name);
    joinModal.style.display = "none";
    lobbyScreen.style.display = "flex";
    if (gameContainer) gameContainer.style.display = "none";
    updateHeroCard();
    connectWebSocket();
  }
});

nicknameInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") btnJoin.click();
});

btnCloseResult.addEventListener("click", () => {
  resultModal.style.display = "none";
});

// Numpad Touch / Click
document.querySelectorAll(".num-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    const val = btn.dataset.val;
    const action = btn.dataset.action;

    if (val) {
      handleInput(val);
    } else if (action === "erase") {
      handleInput(0);
    }
  });
});

btnNotes.addEventListener("click", () => setNotesMode(!notesMode));
document.getElementById("btnHint").addEventListener("click", useHint);
document.getElementById("btnSlapCancel").addEventListener("click", closeSlapPicker);
document.getElementById("btnFreezeCancel").addEventListener("click", closeFreezePicker);
document.querySelectorAll(".boost-btn").forEach(b => b.addEventListener("click", () => useBoost(b.dataset.boost)));

// Random Nickname generator & Avatar preview
if (btnRandomNick) {
  btnRandomNick.addEventListener("click", () => {
    const randomName = FUN_NICKNAMES[Math.floor(Math.random() * FUN_NICKNAMES.length)];
    if (nicknameInput) {
      nicknameInput.value = randomName;
      updateJoinAvatarPreview();
      nicknameInput.focus();
    }
  });
}

if (nicknameInput) {
  nicknameInput.addEventListener("input", updateJoinAvatarPreview);
  if (nicknameInput.value.trim()) {
    updateJoinAvatarPreview();
  } else if (playerName) {
    nicknameInput.value = playerName;
    updateJoinAvatarPreview();
  } else {
    updateJoinAvatarPreview();
  }
}

// Floating emoji reactions handler
// ===== TAMPAR =====
function openSlapPicker() {
  const list = document.getElementById("slapList");
  const targets = Object.values(allPlayers).filter(p => p.id !== playerId);
  list.innerHTML = targets.length
    ? targets.map(p => `<button class="freeze-target" data-id="${escapeHtml(p.id)}">${escapeHtml(p.name)}</button>`).join("")
    : '<div class="freeze-empty">Belum ada pemain lain di lobby.</div>';
  list.querySelectorAll(".freeze-target").forEach(btn => {
    btn.addEventListener("click", () => {
      if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ action: "slap", target: btn.dataset.id }));
      }
      closeSlapPicker();
    });
  });
  document.getElementById("slapPicker").style.display = "flex";
}

function closeSlapPicker() {
  document.getElementById("slapPicker").style.display = "none";
}

let slapTimer = null;
function playSlap(fromName) {
  const fx = document.getElementById("slapFx");
  document.getElementById("slapFxText").textContent = `Ditampar ${fromName}!`;
  fx.style.display = "none";
  void fx.offsetWidth; // mulai ulang animasi
  fx.style.display = "flex";
  document.body.classList.remove("slap-shake");
  void document.body.offsetWidth;
  document.body.classList.add("slap-shake");
  if (navigator.vibrate) navigator.vibrate([60, 40, 60]);
  clearTimeout(slapTimer);
  slapTimer = setTimeout(() => {
    fx.style.display = "none";
    document.body.classList.remove("slap-shake");
  }, 1600);
}

function spawnFloatingEmoji(emoji, fromName) {
  const container = document.getElementById("floatingReactionLayer");
  if (!container) return;
  const el = document.createElement("div");
  el.className = "floating-emoji-item";
  el.textContent = emoji;
  if (fromName) {
    const label = document.createElement("span");
    label.className = "floating-emoji-name";
    label.textContent = fromName;
    el.appendChild(label);
  }
  const randomX = Math.floor(Math.random() * 70) + 15;
  el.style.left = `${randomX}%`;
  container.appendChild(el);
  setTimeout(() => {
    if (el.parentNode) el.parentNode.removeChild(el);
  }, 2200);
}

document.querySelectorAll(".k-btn-hype").forEach(btn => {
  btn.addEventListener("click", () => {
    if (btn.dataset.action === "slap") { openSlapPicker(); return; }
    const emoji = btn.dataset.emoji || "🔥";
    spawnFloatingEmoji(emoji);
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ action: "reaction", emoji }));
    }
  });
});
Chat.init(playerId, (text) => {
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ action: "chat", text }));
  }
});

// Keyboard Navigation & Inputs
window.addEventListener("keydown", (e) => {
  // Jangan tangkap tombol saat pemain sedang mengetik di chat / nickname
  if (e.target && e.target.tagName === "INPUT") return;

  if (canSpectate()) {
    if (e.key === "ArrowRight") { cycleView(1); e.preventDefault(); }
    else if (e.key === "ArrowLeft") { cycleView(-1); e.preventDefault(); }
    return;
  }
  if (!isPlaying || isEliminated) return;

  if (e.key === "n" || e.key === "N") {
    setNotesMode(!notesMode);
    return;
  }

  // Arrow keys for grid navigation
  if (selectedCell) {
    let { row, col } = selectedCell;
    if (e.key === "ArrowUp") {
      row = Math.max(0, row - 1);
      selectCell(row, col);
      e.preventDefault();
      return;
    } else if (e.key === "ArrowDown") {
      row = Math.min(8, row + 1);
      selectCell(row, col);
      e.preventDefault();
      return;
    } else if (e.key === "ArrowLeft") {
      col = Math.max(0, col - 1);
      selectCell(row, col);
      e.preventDefault();
      return;
    } else if (e.key === "ArrowRight") {
      col = Math.min(8, col + 1);
      selectCell(row, col);
      e.preventDefault();
      return;
    }
  }

  // 1-9 numbers
  if (e.key >= "1" && e.key <= "9") {
    handleInput(e.key);
  }
  // Backspace / Delete / 0 to clear
  else if (e.key === "Backspace" || e.key === "Delete" || e.key === "0") {
    handleInput(0);
  }
});

// Initialization
createGrid();
if (playerName) {
  nicknameInput.value = playerName;
}
