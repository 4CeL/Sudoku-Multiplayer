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

  function render(msg) {
    const mine = msg.id === selfId;
    const row = document.createElement("div");
    row.className = "chat-msg" + (mine ? " chat-mine" : "") + (msg.id === "host" ? " chat-host" : "");
    row.innerHTML = `<span class="chat-name">${esc(msg.name)}</span><span class="chat-text">${esc(msg.text)}</span>`;
    messages.appendChild(row);
    while (messages.children.length > 100) messages.removeChild(messages.firstChild);
  }

  function add(msg) {
    render(msg);
    scrollDown();
    if (!isOpen() && msg.id !== selfId) setUnread(unread + 1);
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
