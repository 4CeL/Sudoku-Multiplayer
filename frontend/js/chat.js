// Chat ringan yang dipakai bersama oleh halaman pemain dan host.
const Chat = (() => {
  const toggles = document.querySelectorAll(".chat-toggle");
  const badges = document.querySelectorAll(".chat-badge");
  const panel = document.getElementById("chatPanel");
  const closeBtn = document.getElementById("chatClose");
  const messages = document.getElementById("chatMessages");
  const form = document.getElementById("chatForm");
  const input = document.getElementById("chatInput");

  let selfId = null;
  let sendFn = null;
  let unread = 0;
  let enabled = false;

  function isOpen() {
    return panel.style.display !== "none";
  }

  function esc(text) {
    const div = document.createElement("div");
    div.textContent = text || "";
    return div.innerHTML;
  }

  function scrollDown() {
    messages.scrollTop = messages.scrollHeight;
  }

  function setUnread(n) {
    unread = n;
    badges.forEach(b => {
      b.textContent = n > 9 ? "9+" : n;
      b.style.display = n > 0 ? "flex" : "none";
    });
  }

  function syncToggles() {
    toggles.forEach(t => {
      t.style.display = enabled && !isOpen() ? "inline-flex" : "none";
    });
  }

  function open() {
    panel.style.display = "flex";
    syncToggles();
    setUnread(0);
    scrollDown();
    // Fokus otomatis hanya di layar lebar, agar keyboard HP tidak langsung muncul
    if (window.matchMedia("(min-width: 700px)").matches) input.focus();
  }

  function close() {
    panel.style.display = "none";
    syncToggles();
    input.blur();
  }

  function escRe(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  // Bungkus @nama yang valid dengan sorotan
  function formatText(msg) {
    let html = esc(msg.text);
    (msg.mention_names || []).forEach(n => {
      const re = new RegExp("(^|[^\\p{L}\\p{N}])(@" + escRe(esc(n)) + ")(?![\\p{L}\\p{N}])", "giu");
      html = html.replace(re, (_, pre, tag) => pre + '<span class="chat-mention">' + tag + '</span>');
    });
    return html;
  }

  let toastTimer = null;
  function showMention(msg) {
    let el = document.getElementById("mentionToast");
    if (!el) {
      el = document.createElement("button");
      el.id = "mentionToast";
      el.className = "mention-toast";
      el.type = "button";
      el.addEventListener("click", () => { el.style.display = "none"; open(); });
      document.body.appendChild(el);
    }
    el.innerHTML = '<span class="mention-from">' + esc(msg.name) + ' menyebutmu</span><span class="mention-text">' + esc(msg.text) + '</span>';
    el.style.display = "flex";
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.style.display = "none"; }, 6000);
  }

  function render(msg) {
    const mine = msg.id === selfId;
    const row = document.createElement("div");
    row.className = "chat-msg" + (mine ? " chat-mine" : "") + (msg.id === "host" ? " chat-host" : "") + ((msg.mentions || []).includes(selfId) ? " chat-tagged" : "");
    row.innerHTML = `<span class="chat-name">${esc(msg.name)}</span><span class="chat-text">${formatText(msg)}</span>`;
    messages.appendChild(row);
    while (messages.children.length > 100) messages.removeChild(messages.firstChild);
  }

  function add(msg) {
    render(msg);
    scrollDown();
    if (!isOpen() && msg.id !== selfId) setUnread(unread + 1);
    if (msg.id !== selfId && (msg.mentions || []).includes(selfId)) showMention(msg);
  }

  function history(list) {
    messages.innerHTML = "";
    (list || []).forEach(render);
    scrollDown();
  }

  function init(id, send) {
    selfId = id;
    sendFn = send;
  }

  function show() {
    enabled = true;
    syncToggles();
  }

  toggles.forEach(t => t.addEventListener("click", open));
  closeBtn.addEventListener("click", close);
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text || !sendFn) return;
    sendFn(text);
    input.value = "";
  });

  return { init, add, history, show };
})();

// Update badge di semua tombol chat (FAB + tombol lain jika ada)
function updateChatBadges(count) {
  document.querySelectorAll('.chat-badge').forEach(el => {
    el.textContent = count;
    el.style.display = count > 0 ? 'block' : 'none';
  });
}

// Toggle body class saat panel buka/tutup
function toggleChatPanel(open) {
  const panel = document.getElementById('chatPanel');
  if (!panel) return;
  panel.style.display = open ? 'flex' : 'none';
  document.body.classList.toggle('chat-open', open);
}