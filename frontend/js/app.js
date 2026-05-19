// ═══════════════════════════════════════════════
//  BIDArena — Main Application
// ═══════════════════════════════════════════════

const API = window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1"
  ? "http://localhost:5000/api/v1"
  : "/api/v1";

const WS_PROTOCOL = window.location.protocol === "https:" ? "wss:" : "ws:";
const WS_URL = window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1"
  ? "ws://localhost:5000/ws"
  : `${WS_PROTOCOL}//${window.location.host}/ws`;

// ─── STATE ────────────────────────────────────
const state = {
  token: localStorage.getItem("ba_token") || null,
  user: JSON.parse(localStorage.getItem("ba_user") || "null"),
  currentRoom: null,
  currentItems: [],
  topBids: {},
  activeBidders: {},
  leaderboard: [],
  ws: null,
  activeItemId: null,
  bidWindowActive: false,
  bidWindowUserId: null,
  countdownInterval: null,
  resultsRevealed: false,
  allBids: {},
  // FIX: leaderboard auto-refresh interval
  leaderboardInterval: null,
};

// ─── AUDIO ────────────────────────────────────
const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
function playSound(type) {
  if (audioCtx.state === "suspended") audioCtx.resume();
  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  osc.connect(gain);
  gain.connect(audioCtx.destination);
  const now = audioCtx.currentTime;
  if (type === "tick") {
    osc.type = "sine"; osc.frequency.setValueAtTime(800, now); osc.frequency.exponentialRampToValueAtTime(10, now + 0.1);
    gain.gain.setValueAtTime(0.3, now); gain.gain.exponentialRampToValueAtTime(0.01, now + 0.1);
    osc.start(now); osc.stop(now + 0.1);
  } else if (type === "success") {
    osc.type = "triangle"; osc.frequency.setValueAtTime(400, now); osc.frequency.linearRampToValueAtTime(800, now + 0.2);
    gain.gain.setValueAtTime(0.5, now); gain.gain.linearRampToValueAtTime(0, now + 0.5);
    osc.start(now); osc.stop(now + 0.5);
  } else if (type === "error") {
    osc.type = "sawtooth"; osc.frequency.setValueAtTime(150, now);
    gain.gain.setValueAtTime(0.5, now); gain.gain.linearRampToValueAtTime(0, now + 0.3);
    osc.start(now); osc.stop(now + 0.3);
  }
}

function escapeHTML(str) {
  if (!str) return "";
  return str.replace(/[&<>'"]/g, tag => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[tag]));
}

function updatePointsBar() {
  const wrap = $("points-bar-wrap");
  const fill = $("points-bar-fill");
  if (!wrap || !fill) return;
  if (!state.user || state.user.role === "admin" || state.user.isSpectator) {
    wrap.style.display = "none"; return;
  }
  wrap.style.display = "block";
  const pts = parseFloat(state.user.points || 0);
  const pct = Math.min(100, Math.max(0, (pts / 10000) * 100));
  fill.style.width = `${pct}%`;
  fill.style.background = pts < 2000 ? "var(--red)" : "var(--green)";
}

function showWinnerBanner(userName, itemName, amount) {
  const banner = $("winner-banner");
  if (!banner) return;
  banner.textContent = `🏆 ${userName} won ${itemName} for ${formatCurrency(amount)}!`;
  banner.classList.add("show");
  setTimeout(() => banner.classList.remove("show"), 4000);
}

function toggleMobileSidebar() {
  const sb = $("arena-sidebar");
  if (sb) sb.classList.toggle("open");
}

// ─── UTILS ────────────────────────────────────
function $(id) { return document.getElementById(id); }

function showPage(id) {
  document.querySelectorAll(".page").forEach(p => p.classList.remove("active"));
  $(id).classList.add("active");
}

function toast(msg, type = "info") {
  const c = $("toast-container");
  const el = document.createElement("div");
  el.className = `toast ${type}`;
  const icon = type === "success" ? "✓" : type === "error" ? "✗" : type === "gold" ? "⚡" : "•";
  el.innerHTML = `<span style="color:var(--gold)">${icon}</span> ${msg}`;
  c.appendChild(el);
  setTimeout(() => el.remove(), 3500);
}

function formatCurrency(n) {
  return "₹" + parseFloat(n || 0).toLocaleString("en-IN", { minimumFractionDigits: 2 });
}

function timeNow() {
  return new Date().toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function addFeed(msg, type = "system") {
  const feed = $("activity-feed");
  if (!feed) return;
  const el = document.createElement("div");
  el.className = `feed-entry ${type}`;
  el.innerHTML = `<span class="feed-time">${timeNow()}</span>${msg}`;
  feed.prepend(el);
  while (feed.children.length > 50) feed.lastChild.remove();
}

// ─── API ───────────────────────────────────────
async function apiCall(method, path, body) {
  const headers = { "Content-Type": "application/json" };
  if (state.token) headers["Authorization"] = `Bearer ${state.token}`;
  const res = await fetch(`${API}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.message || "Request failed");
  return data;
}

function saveAuth(token, user) {
  state.token = token;
  state.user = user;
  localStorage.setItem("ba_token", token);
  localStorage.setItem("ba_user", JSON.stringify(user));
}

function logout() {
  state.token = null;
  state.user = null;
  localStorage.removeItem("ba_token");
  localStorage.removeItem("ba_user");
  if (state.ws) state.ws.close();
  stopLeaderboardPolling();
  showPage("page-auth");
  renderNavUser();
}

function renderNavUser() {
  const wrap = $("nav-user-wrap");
  if (!state.user) { wrap.innerHTML = ""; return; }
  const pointsHTML = state.user.role !== "admin"
    ? `<span style="font-family:var(--mono);font-size:13px;color:var(--gold);border:1px solid var(--border-bright);padding:3px 10px;border-radius:2px;" id="nav-points">⚡ ${parseFloat(state.user.points || 0).toFixed(0)} pts</span>`
    : "";
  wrap.innerHTML = `
    ${pointsHTML}
    <span class="nav-user">${escapeHTML(state.user.name)}</span>
    <span class="nav-badge ${state.user.role === "admin" ? "admin" : ""}">${state.user.role.toUpperCase()}</span>
    <button class="btn btn-ghost" onclick="logout()" style="padding:6px 12px">LOGOUT</button>
  `;
  updatePointsBar();
}

// ─── LEADERBOARD POLLING (fallback) ────────────
// FIX: Poll leaderboard every 10s as a fallback in case WS misses an update
function startLeaderboardPolling(roomId) {
  stopLeaderboardPolling();
  state.leaderboardInterval = setInterval(async () => {
    if (!state.currentRoom) return;
    try {
      const data = await apiCall("GET", `/rooms/${roomId}/leaderboard`);
      if (data.leaderboard) {
        state.leaderboard = data.leaderboard;
        renderLeaderboard();
      }
    } catch (e) { /* silent fail — WS is primary */ }
  }, 10000);
}

function stopLeaderboardPolling() {
  if (state.leaderboardInterval) {
    clearInterval(state.leaderboardInterval);
    state.leaderboardInterval = null;
  }
}

// ─── AUTH PAGE ─────────────────────────────────
function showAuthPage() {
  showPage("page-auth");
  $("auth-form").onsubmit = handleAuthSubmit;
  $("auth-toggle-link").onclick = toggleAuthMode;
}

let authMode = "login";

function toggleAuthMode() {
  authMode = authMode === "login" ? "register" : "login";
  $("auth-title").textContent = authMode === "login" ? "SIGN IN" : "JOIN";
  $("auth-submit").textContent = authMode === "login" ? "ENTER ARENA" : "CREATE ACCOUNT";
  $("auth-toggle-text").textContent = authMode === "login" ? "New here?" : "Already have an account?";
  $("auth-toggle-link").textContent = authMode === "login" ? "Create account" : "Sign in";
  $("auth-name-group").style.display = authMode === "register" ? "flex" : "none";
  $("auth-role-group").style.display = authMode === "register" ? "flex" : "none";
  $("auth-error").style.display = "none";
}

async function handleAuthSubmit(e) {
  e.preventDefault();
  const email = $("auth-email").value.trim();
  const password = $("auth-password").value;
  const btn = $("auth-submit");
  btn.disabled = true;
  $("auth-error").style.display = "none";
  try {
    let data;
    if (authMode === "register") {
      const name = $("auth-name").value.trim();
      const role = $("auth-role").value;
      data = await apiCall("POST", "/auth/register", { name, email, password, role });
    } else {
      data = await apiCall("POST", "/auth/login", { email, password });
    }
    saveAuth(data.token, data.user);
    renderNavUser();
    showLobby();
  } catch (err) {
    $("auth-error").textContent = err.message;
    $("auth-error").style.display = "block";
  } finally {
    btn.disabled = false;
  }
}

// ─── LOBBY ─────────────────────────────────────
async function showLobby() {
  stopLeaderboardPolling();
  showPage("page-lobby");
  $("create-room-btn").style.display = state.user?.role === "admin" ? "inline-flex" : "none";
  await loadRooms();
}

async function loadRooms() {
  try {
    const data = await apiCall("GET", "/rooms");
    renderRooms(data.rooms);
  } catch (err) {
    toast("Failed to load rooms: " + err.message, "error");
  }
}

function renderRooms(rooms) {
  const grid = $("rooms-grid");
  if (!rooms.length) {
    grid.innerHTML = `<div style="color:var(--text-dim);font-family:var(--mono);font-size:14px;padding:40px 0;">No rooms yet. ${state.user?.role === "admin" ? "Create one above." : "Ask an admin to create one."}</div>`;
    return;
  }
  grid.innerHTML = rooms.map(r => {
    const maxTag = r.max_players ? `<span>👥 Max ${r.max_players}</span>` : "";
    const isFull = r.max_players && parseInt(r.participant_count) >= r.max_players && r.status === "waiting";
    return `
    <div class="room-card" onclick="joinRoom(${r.id})">
      ${state.user?.role === "admin" ? `
        <div style="position:absolute;top:12px;right:12px;font-size:16px;cursor:pointer;z-index:1;"
             onclick="event.stopPropagation();deleteRoomReq(${r.id},'${escapeHTML(r.name)}','${r.status}')">🗑️</div>
      ` : ""}
      <div class="room-name">${escapeHTML(r.name)}</div>
      <div class="room-meta">
        <span>👤 ${escapeHTML(r.creator_name)}</span>
        <span>🧑‍🤝‍🧑 ${r.participant_count}${r.max_players ? "/" + r.max_players : ""} players</span>
        <span>📦 ${r.item_count} items</span>
        ${maxTag}
      </div>
      <div class="room-status status-${r.status}">${r.status.toUpperCase()}${isFull ? " — FULL" : ""}</div>
    </div>
  `}).join("");
}

async function deleteRoomReq(id, name, status) {
  const confirmMsg = status === "active"
    ? `⚠️ "${name}" is currently active! Deleting will end the auction. Are you sure?`
    : `Delete room "${name}"? This cannot be undone.`;
  if (!confirm(confirmMsg)) return;
  try {
    await apiCall("DELETE", `/rooms/${id}`);
    toast("Room deleted", "success");
    loadRooms();
  } catch (err) { toast(err.message, "error"); }
}

// ─── CREATE ROOM MODAL ─────────────────────────
function openCreateRoomModal() {
  $("create-room-modal").classList.add("open");
  $("room-name-input").focus();
}
function closeCreateRoomModal() {
  $("create-room-modal").classList.remove("open");
  $("room-name-input").value = "";
  const mpInput = $("room-max-players-input");
  if (mpInput) mpInput.value = "";
}

async function submitCreateRoom() {
  const name = $("room-name-input").value.trim();
  const maxPlayersInput = $("room-max-players-input");
  const max_players = maxPlayersInput ? parseInt(maxPlayersInput.value) || null : null;
  if (!name) return toast("Enter a room name", "error");
  try {
    await apiCall("POST", "/rooms", { name, max_players });
    closeCreateRoomModal();
    toast("Room created!", "success");
    await loadRooms();
  } catch (err) { toast(err.message, "error"); }
}

// ─── JOIN ROOM ─────────────────────────────────
async function joinRoom(roomId) {
  try {
    const data = await apiCall("GET", `/rooms/${roomId}`);
    state.currentRoom = data.room;
    state.currentItems = data.items;
    state.topBids = {};
    state.activeBidders = {};
    data.topBids.forEach(b => {
      state.topBids[b.item_id] = { userId: b.user_id, userName: b.user_name, amount: b.amount };
    });
    state.allBids = {};
    if (data.allBids) {
      data.allBids.forEach(b => {
        if (!state.allBids[b.item_id]) state.allBids[b.item_id] = [];
        state.allBids[b.item_id].push(b);
      });
    }
    state.resultsRevealed = data.room.status === "finished";
    renderArena();
    showPage("page-arena");
    connectWebSocket(roomId);
    startLeaderboardPolling(roomId);
  } catch (err) {
    toast("Failed to join room: " + err.message, "error");
  }
}

// ─── ARENA RENDER ──────────────────────────────
function renderArena() {
  const room = state.currentRoom;
  $("arena-room-name").textContent = room.name;
  $("arena-room-status").textContent = room.status.toUpperCase();
  $("arena-room-status").className = `room-status status-${room.status}`;

  // FIX: show max_players info in header
  const maxTag = $("arena-max-players");
  if (maxTag) {
    maxTag.textContent = room.max_players ? `👥 Max ${room.max_players}` : "";
    maxTag.style.display = room.max_players ? "inline-block" : "none";
  }

  const dashBtn = $("admin-dashboard-btn");
  if (dashBtn) dashBtn.style.display = state.user?.role === "admin" ? "inline-flex" : "none";

  renderItems();

  if (state.user?.role === "admin") {
    $("admin-add-item-btn").style.display = "inline-flex";
    $("admin-reveal-btn").style.display = state.resultsRevealed ? "none" : "inline-flex";
  } else {
    $("admin-add-item-btn").style.display = "none";
    $("admin-reveal-btn").style.display = "none";
  }

  if (state.resultsRevealed) renderResults();
}

function renderItems() {
  const container = $("items-container");
  if (!state.currentItems.length) {
    container.innerHTML = `<div style="color:var(--text-dim);font-family:var(--mono);font-size:14px;padding:40px 0;text-align:center;">No items yet. Admin will add items to bid on.</div>`;
    return;
  }

  container.innerHTML = state.currentItems.map((item, idx) => {
    const topBid = state.topBids[item.id];
    const isActive = item.status === "active";
    const isFinished = item.status === "finished";
    const isAdmin = state.user?.role === "admin";
    const isHighestBidder = topBid && String(topBid.userId) === String(state.user?.id);
    const myActiveBid = (state.activeBidders[item.id] || []).find(b => String(b.userId) === String(state.user?.id));

    const revealed = item.revealed && item.actual_price != null;
    const myBid = topBid && String(topBid.userId) === String(state.user?.id) ? topBid.amount : null;
    let pnlHTML = "";
    if (revealed && isFinished) {
      const actual = parseFloat(item.actual_price);
      if (myBid) {
        const diff = actual - parseFloat(myBid);
        const cls = diff >= 0 ? "profit" : "loss";
        const sign = diff >= 0 ? "+" : "";
        pnlHTML = `<div class="${cls}" style="font-family:var(--mono);font-size:13px;margin-top:4px;">
          Your bid: ${formatCurrency(myBid)} → Actual: ${formatCurrency(actual)} → P&L: <span class="${cls}">${sign}${formatCurrency(diff)}</span>
        </div>`;
      } else {
        pnlHTML = `<div style="font-family:var(--mono);font-size:13px;color:var(--text-mute);margin-top:4px;">Actual price: ${formatCurrency(actual)}</div>`;
      }
    }

    let winnerHTML = "";
    if (isFinished && item.winner_id) {
      const winnerName = item.winner_name ||
        (state.leaderboard.find(l => String(l.id) === String(item.winner_id))?.name) ||
        (String(item.winner_id) === String(state.user?.id) ? state.user.name : "Unknown");
      const isMyWin = String(item.winner_id) === String(state.user?.id);
      winnerHTML = `
        <div style="margin-top:12px;padding:10px 14px;background:rgba(245,197,24,0.06);border:1px solid rgba(245,197,24,0.25);border-radius:2px;font-family:var(--mono);font-size:13px;">
          🏆 Won by <strong style="color:var(--gold);">${escapeHTML(winnerName)}</strong>${isMyWin ? ' <span style="color:var(--green);">(You!)</span>' : ''} for ${formatCurrency(item.winning_bid)}
        </div>`;
    } else if (isFinished && !item.winner_id) {
      winnerHTML = `<div style="margin-top:12px;padding:10px 14px;background:var(--bg3);border:1px solid var(--bg4);border-radius:2px;font-family:var(--mono);font-size:13px;color:var(--text-mute);">No bids placed — item unsold</div>`;
    }

    const bidders = state.activeBidders[item.id] || [];
    const liveBiddersHTML = isActive && bidders.length > 0 ? `
      <div class="live-bidders">
        <div class="live-bidders-title">LIVE BIDDERS (${bidders.length})</div>
        ${bidders.map((b, i) => {
      const isMe = String(b.userId) === String(state.user?.id);
      return `<div class="live-bidder-row">
            <span class="live-bidder-name">
              ${i === 0 ? "👑 " : ""}${escapeHTML(b.userName)}${isMe ? '<span class="live-bidder-you">(you)</span>' : ""}
            </span>
            <span class="live-bidder-amount">${formatCurrency(b.amount)}</span>
          </div>`;
    }).join("")}
      </div>
    ` : "";

    return `
    <div class="item-card ${isActive ? "active-item" : ""} ${isFinished ? "finished-item" : ""}" id="item-card-${item.id}">
      <div class="item-number">ITEM ${String(idx + 1).padStart(2, "0")} / ${String(state.currentItems.length).padStart(2, "0")}</div>
      <div class="item-name">${escapeHTML(item.name)}</div>
      ${item.description ? `<div class="item-desc">${escapeHTML(item.description)}</div>` : ""}

      <div class="bid-info">
        <div class="bid-block">
          <div class="bid-label">${isActive ? "Leading Bid" : isFinished ? "Winning Bid" : "Current High Bid"}</div>
          <div class="bid-amount ${topBid ? "" : "dim"}" id="bid-amount-${item.id}">
            ${topBid ? formatCurrency(topBid.amount) : "—"}
          </div>
          <div class="bid-user" id="bid-user-${item.id}">${topBid ? "by " + escapeHTML(topBid.userName) : "No bids yet"}</div>
        </div>
        <div class="bid-block">
          <div class="bid-label">Status</div>
          <div class="room-status status-${item.status}" style="margin-top:4px;" id="item-status-${item.id}">
            ${item.status.toUpperCase()}
          </div>
        </div>
      </div>

      <div class="countdown-wrap" id="countdown-${item.id}">
        <div class="countdown-bar"><div class="countdown-fill" id="countdown-fill-${item.id}" style="width:100%"></div></div>
        <div class="countdown-text" id="countdown-text-${item.id}">10s window — bid to outbid</div>
      </div>

      ${liveBiddersHTML}
      ${winnerHTML}
      ${pnlHTML}

      ${isActive && !isAdmin ? `
        ${state.user?.isSpectator ? `
          <div style="margin-top:16px;">
            <div class="spectating-badge">👀 SPECTATING</div>
          </div>
        ` : `
          <div class="bid-row" id="bid-row-${item.id}" style="margin-top:14px;">
            <div class="bid-input-wrap">
              <span class="bid-currency">₹</span>
              <input class="form-input" type="number" id="bid-val-${item.id}"
                placeholder="${topBid ? Math.ceil(parseFloat(topBid.amount) + 1) : "1000"}"
                min="${topBid ? parseFloat(topBid.amount) + 0.01 : 0.01}" step="0.01" />
            </div>
            <button class="btn btn-gold" id="bid-btn-${item.id}"
              onclick="placeBid(${item.id})"
              ${isHighestBidder ? "disabled" : ""}>
              ${isHighestBidder ? "LEADING" : "PLACE BID"}
            </button>
            ${myActiveBid ? `
              <button class="btn btn-withdraw" id="withdraw-btn-${item.id}"
                onclick="withdrawBid(${item.id})"
                title="Withdraw your bid of ${formatCurrency(myActiveBid.amount)} and get points back">
                ✕ WITHDRAW ${formatCurrency(myActiveBid.amount)}
              </button>
            ` : ""}
          </div>
          <div style="font-family:var(--mono);font-size:11px;color:var(--text-mute);margin-top:6px;">
            Available: <span style="color:var(--gold);">⚡ ${parseFloat(state.user?.points || 0).toFixed(0)} pts</span>
          </div>
        `}
      ` : ""}

      ${isFinished && state.allBids[item.id] && state.allBids[item.id].length > 0 ? `
        <div class="bid-history">
          <div class="bid-history-title" onclick="document.getElementById('bid-hist-${item.id}').classList.toggle('open')">
            <span>BID HISTORY (${state.allBids[item.id].length})</span>
            <span>▼</span>
          </div>
          <div class="bid-history-list" id="bid-hist-${item.id}">
            ${state.allBids[item.id].map(b => `
              <div class="bid-history-item">
                <span>${escapeHTML(b.user_name)}</span>
                <span>${formatCurrency(b.amount)}</span>
              </div>
            `).join("")}
          </div>
        </div>
      ` : ""}

      ${isAdmin ? `
      <div class="admin-controls">
        ${item.status === "pending" ? `<button class="btn btn-gold" onclick="adminStartItem(${item.id})">▶ START BIDDING</button>` : ""}
        ${item.status === "active" ? `<button class="btn btn-danger" onclick="adminEndItem(${item.id})">■ END BIDDING</button>` : ""}
        ${item.status === "pending" ? `<button class="btn btn-ghost" onclick="openDeleteItem(${item.id})">DELETE</button>` : ""}
      </div>
      ` : ""}
    </div>
    `;
  }).join("");
}

// ─── WEBSOCKET ─────────────────────────────────
function connectWebSocket(roomId) {
  if (state.ws) state.ws.close();
  $("ws-dot").className = "ws-indicator";

  const ws = new WebSocket(`${WS_URL}?token=${state.token}`);
  state.ws = ws;

  ws.onopen = () => {
    $("ws-dot").className = "ws-indicator connected";
    ws.send(JSON.stringify({ type: "JOIN_ROOM", roomId }));
    addFeed("Connected to arena", "system");
  };

  ws.onclose = () => {
    $("ws-dot").className = "ws-indicator error";
    addFeed("Disconnected — reconnecting...", "system");
    setTimeout(() => {
      if (state.currentRoom?.id === roomId) connectWebSocket(roomId);
    }, 3000);
  };

  ws.onerror = () => { $("ws-dot").className = "ws-indicator error"; };

  ws.onmessage = (e) => {
    let msg;
    try { msg = JSON.parse(e.data); } catch { return; }
    handleWsMessage(msg);
  };
}

function wsSend(obj) {
  if (state.ws?.readyState === WebSocket.OPEN) state.ws.send(JSON.stringify(obj));
}

// ─── WS MESSAGE HANDLER ────────────────────────
function handleWsMessage(msg) {
  switch (msg.type) {

    case "ROOM_SNAPSHOT": {
      state.currentRoom = msg.data.room;
      state.currentItems = msg.data.items;
      if (msg.data.isSpectator !== undefined) {
        state.user.isSpectator = msg.data.isSpectator;
        updatePointsBar();
      }
      msg.data.topBids.forEach(b => {
        state.topBids[b.item_id] = { userId: b.user_id, userName: b.user_name || "?", amount: b.amount };
      });
      if (msg.data.activeBidderMap) {
        state.activeBidders = {};
        for (const [itemId, bidders] of Object.entries(msg.data.activeBidderMap)) {
          state.activeBidders[itemId] = bidders;
        }
      }
      renderItems();
      break;
    }

    case "REAUTH_REQUIRED":
      toast(msg.reason + " — Please login again.", "error");
      setTimeout(logout, 3000);
      break;

    case "BID_PLACED": {
      const { itemId, userId, userName, amount } = msg.data;
      updateBidDisplay(itemId, { userId, userName, amount });
      addFeed(`<b>${escapeHTML(userName)}</b> bid ${formatCurrency(amount)}`, "bid");
      playSound("tick");
      break;
    }

    case "BIDDER_LIST": {
      const { itemId, bidders } = msg.data;
      state.activeBidders[itemId] = bidders;
      if (bidders.length > 0) {
        const top = bidders[0];
        state.topBids[itemId] = { userId: top.userId, userName: top.userName, amount: top.amount };
        updateBidDisplay(itemId, state.topBids[itemId]);
      }
      renderItems();
      break;
    }

    case "BID_WITHDRAWN": {
      const { itemId, userId, userName } = msg.data;
      addFeed(`<b>${escapeHTML(userName)}</b> withdrew their bid`, "system");
      if (String(userId) === String(state.user?.id)) {
        toast("Your bid was withdrawn and points refunded", "success");
      }
      break;
    }

    case "LAST_BIDDER_REMAINING": {
      const { itemId, userName, amount, graceSecs } = msg.data;
      addFeed(`⏳ Last bidder: <b>${escapeHTML(userName)}</b> @ ${formatCurrency(amount)} — auto-closes in ${graceSecs}s`, "bid");
      startCountdown(itemId, graceSecs);
      break;
    }

    case "BID_WINDOW_OPEN": {
      const { itemId, userId, userName, amount, expiresIn, bidding_window_started_at } = msg.data;
      state.bidWindowActive = true;
      state.bidWindowUserId = userId;
      state.activeItemId = itemId;
      updateBidDisplay(itemId, { userId, userName, amount });
      let remaining = expiresIn;
      if (bidding_window_started_at) {
        const elapsed = (Date.now() - bidding_window_started_at) / 1000;
        remaining = Math.max(1, expiresIn - elapsed);
      }
      startCountdown(itemId, remaining);
      refreshBidButton(itemId, userId);
      addFeed(`<b>${escapeHTML(userName)}</b> placed bid of ${formatCurrency(amount)}`, "bid");
      playSound("tick");
      break;
    }

    case "BID_COMMITTED": {
      const { itemId, userId, userName, amount } = msg.data;
      state.topBids[itemId] = { userId, userName, amount };
      if (!state.allBids[itemId]) state.allBids[itemId] = [];
      state.allBids[itemId].unshift({ item_id: itemId, user_id: userId, amount, user_name: userName });
      state.bidWindowActive = false;
      stopCountdown(itemId);
      updateBidDisplay(itemId, { userId, userName, amount });
      refreshBidButton(itemId, userId);
      addFeed(`✓ Leading bid confirmed: <b>${escapeHTML(userName)}</b> @ ${formatCurrency(amount)}`, "system");
      if (String(userId) === String(state.user?.id)) {
        toast(`Your bid of ${formatCurrency(amount)} is now the leading bid`, "success");
      }
      break;
    }

    case "POINTS_UPDATE": {
      // FIX: update state AND all UI elements consistently
      state.user.points = msg.data.points;
      localStorage.setItem("ba_user", JSON.stringify(state.user));
      const navPts = $("nav-points");
      if (navPts) navPts.textContent = `⚡ ${parseFloat(msg.data.points).toFixed(0)} pts`;
      updatePointsBar();
      // Re-render items to show updated available balance
      renderItems();
      break;
    }

    // FIX: POINTS_RESET — update points display immediately for current user
    case "POINTS_RESET": {
      if (state.user?.role === "buyer") {
        // Points_UPDATE will follow with exact amount from server,
        // but pre-emptively set to 10000 for instant feedback
        state.user.points = 10000;
        localStorage.setItem("ba_user", JSON.stringify(state.user));
        toast("Points reset to 10,000 by admin!", "gold");
        const navPts = $("nav-points");
        if (navPts) navPts.textContent = `⚡ 10000 pts`;
        updatePointsBar();
        renderItems();
        // FIX: re-fetch leaderboard after reset
        if (state.currentRoom) {
          apiCall("GET", `/rooms/${state.currentRoom.id}/leaderboard`)
            .then(data => {
              if (data.leaderboard) {
                state.leaderboard = data.leaderboard;
                renderLeaderboard();
              }
            }).catch(() => {});
        }
      }
      break;
    }

    case "BID_REJECTED":
      playSound("error");
      toast(msg.reason, "error");
      break;

    case "ITEM_STARTED": {
      const item = msg.data;
      updateItemInState(item);
      state.activeBidders[item.id] = [];
      renderItems();
      addFeed(`📦 Bidding started: <b>${escapeHTML(item.name)}</b>`, "system");
      toast(`Bidding open: ${item.name}`, "gold");
      break;
    }

    case "ITEM_ENDED": {
      const item = msg.data;
      stopCountdown(item.id);
      state.bidWindowActive = false;
      delete state.activeBidders[item.id];
      updateItemInState(item);
      renderItems();

      const winnerName = item.winner_name;
      if (winnerName) {
        const isMyWin = String(item.winner_id) === String(state.user?.id);
        addFeed(`🏆 <b>${escapeHTML(item.name)}</b> → <b>${escapeHTML(winnerName)}</b> for ${formatCurrency(item.winning_bid)}`, "win");
        showWinnerBanner(winnerName, item.name, item.winning_bid);
        playSound("success");
        if (isMyWin) toast(`🏆 Congratulations! You won ${item.name}!`, "success");
        else toast(`${winnerName} won ${item.name} for ${formatCurrency(item.winning_bid)}`, "gold");
      } else {
        addFeed(`🔔 <b>${escapeHTML(item.name)}</b> — no bids, item unsold`, "system");
        toast(`Bidding ended for ${item.name} — no winner`, "info");
      }
      break;
    }

    case "ITEM_UPDATE": {
      updateItemInState(msg.data);
      renderItems();
      break;
    }

    // FIX: LEADERBOARD — always update immediately
    case "LEADERBOARD":
      state.leaderboard = msg.data;
      renderLeaderboard();
      break;

    case "PRICES_REVEALED":
      msg.data.items.forEach(i => updateItemInState(i));
      state.resultsRevealed = true;
      if (state.currentRoom) state.currentRoom.status = "finished";
      renderArena();
      toast("🎉 Actual prices revealed!", "gold");
      addFeed("🏁 GAME OVER — Prices revealed!", "win");
      break;

    case "USER_JOINED":
      addFeed(`👤 ${escapeHTML(msg.data.name)} joined the room`, "system");
      break;

    // FIX: handle participant count updates
    case "PARTICIPANT_COUNT": {
      const { count, maxPlayers } = msg.data;
      const arenaStatus = $("arena-room-status");
      if (arenaStatus && maxPlayers) {
        // Update any visible participant count
      }
      break;
    }

    case "ERROR":
      toast(msg.reason || "An error occurred", "error");
      // If room is full, go back to lobby
      if (msg.reason && msg.reason.includes("full")) {
        setTimeout(() => showLobby(), 2000);
      }
      break;
  }
}

function updateItemInState(item) {
  const idx = state.currentItems.findIndex(i => i.id === item.id);
  if (idx !== -1) state.currentItems[idx] = { ...state.currentItems[idx], ...item };
}

function updateBidDisplay(itemId, { userId, userName, amount }) {
  const amtEl = $(`bid-amount-${itemId}`);
  const userEl = $(`bid-user-${itemId}`);
  if (amtEl) { amtEl.textContent = formatCurrency(amount); amtEl.classList.remove("dim"); }
  if (userEl) userEl.textContent = `by ${escapeHTML(userName)}`;
  if (state.topBids[itemId]) {
    state.topBids[itemId] = { ...state.topBids[itemId], userId, userName, amount };
  } else {
    state.topBids[itemId] = { userId, userName, amount };
  }
}

function refreshBidButton(itemId, highBidderUserId) {
  const btn = $(`bid-btn-${itemId}`);
  if (!btn) return;
  const isMe = String(highBidderUserId) === String(state.user?.id);
  btn.disabled = isMe;
  btn.textContent = isMe ? "LEADING" : "PLACE BID";
}

// ─── COUNTDOWN ─────────────────────────────────
function startCountdown(itemId, seconds) {
  const wrap = $(`countdown-${itemId}`);
  const fill = $(`countdown-fill-${itemId}`);
  const text = $(`countdown-text-${itemId}`);
  if (!wrap) return;
  stopCountdown(itemId);
  wrap.classList.add("visible");
  let remaining = Math.ceil(seconds);
  fill.style.width = "100%";
  text.textContent = `${remaining}s — bid now to outbid`;
  const interval = setInterval(() => {
    remaining--;
    if (remaining <= 0) { stopCountdown(itemId); return; }
    playSound("tick");
    fill.style.width = `${(remaining / seconds) * 100}%`;
    text.textContent = `${remaining}s — bid now to outbid`;
  }, 1000);
  state.countdownInterval = { id: itemId, interval };
}

function stopCountdown(itemId) {
  if (state.countdownInterval?.id === itemId) {
    clearInterval(state.countdownInterval.interval);
    state.countdownInterval = null;
  }
  const wrap = $(`countdown-${itemId}`);
  if (wrap) wrap.classList.remove("visible");
}

// ─── BIDDING ───────────────────────────────────
function placeBid(itemId) {
  const input = $(`bid-val-${itemId}`);
  const amount = parseFloat(input?.value);
  if (!amount || amount <= 0) return toast("Enter a valid bid amount", "error");
  const topBid = state.topBids[itemId];
  if (topBid && amount <= parseFloat(topBid.amount)) {
    return toast(`Bid must exceed ${formatCurrency(topBid.amount)}`, "error");
  }
  wsSend({ type: "PLACE_BID", itemId, amount });
  if (input) input.value = "";
}

function withdrawBid(itemId) {
  const myBid = (state.activeBidders[itemId] || []).find(b => String(b.userId) === String(state.user?.id));
  if (!myBid) return toast("No active bid to withdraw", "error");
  if (!confirm(`Withdraw your bid of ${formatCurrency(myBid.amount)}? Points will be refunded.`)) return;
  wsSend({ type: "WITHDRAW_BID", itemId });
}

// ─── ADMIN ACTIONS ─────────────────────────────
function adminStartItem(itemId) {
  wsSend({ type: "ADMIN_START_ITEM", itemId });
}

function adminEndItem(itemId) {
  const item = state.currentItems.find(i => i.id === itemId);
  const topBid = state.topBids[itemId];
  const confirmMsg = topBid
    ? `End bidding for "${item?.name}"?\n\nCurrent leader: ${topBid.userName} @ ${formatCurrency(topBid.amount)}\n\nThey will be declared the winner.`
    : `End bidding for "${item?.name}"? No bids placed — item will be unsold.`;
  if (!confirm(confirmMsg)) return;
  wsSend({ type: "ADMIN_END_ITEM", itemId });
}

function adminRevealPrices() {
  if (!confirm("Reveal actual prices to all players? This ends the game and sends result emails.")) return;
  wsSend({ type: "ADMIN_REVEAL_PRICES", roomId: state.currentRoom.id });
}

async function openAdminDashboard() {
  $("admin-dashboard-modal").classList.add("open");
  const { leaderboard } = state;
  $("dash-total-players").textContent = leaderboard.length;
  const activeItem = state.currentItems.find(i => i.status === "active");
  $("dash-active-item").textContent = activeItem ? activeItem.name : "None";

  // FIX: Show max_players in dashboard
  const maxPlayersEl = $("dash-max-players");
  if (maxPlayersEl) {
    const mp = state.currentRoom?.max_players;
    maxPlayersEl.textContent = mp ? `${leaderboard.length} / ${mp}` : `${leaderboard.length} (no limit)`;
  }

  const list = $("dash-players-list");
  const maxPts = Math.max(...leaderboard.map(p => parseFloat(p.net_worth)), 1);
  list.innerHTML = leaderboard.length ? leaderboard.map(p => {
    const pts = parseFloat(p.net_worth);
    const pct = Math.max(0, (pts / maxPts) * 100);
    return `
    <div style="margin-bottom:8px;">
      <div style="display:flex;justify-content:space-between;margin-bottom:4px;">
        <span style="font-family:var(--mono);font-size:13px;">${escapeHTML(p.name)}</span>
        <span style="color:var(--gold);font-family:var(--mono);font-size:13px;">⚡ ${pts.toFixed(0)} pts</span>
      </div>
      <div style="height:4px;background:var(--bg4);border-radius:2px;overflow:hidden;">
        <div style="height:100%;width:${pct}%;background:var(--gold);"></div>
      </div>
    </div>`;
  }).join("") : `<div style="color:var(--text-mute);font-family:var(--mono);font-size:12px;padding:8px;">No players yet</div>`;
}

function closeAdminDashboard() { $("admin-dashboard-modal").classList.remove("open"); }

async function adminResetPoints() {
  if (!confirm("Reset ALL buyers to 10,000 points? This will immediately update all connected players.")) return;
  try {
    await apiCall("POST", "/rooms/reset-points");
    toast("All buyers reset to 10,000 points — updating all clients...", "success");
    closeAdminDashboard();
    // FIX: re-fetch leaderboard immediately after reset
    if (state.currentRoom) {
      setTimeout(async () => {
        const data = await apiCall("GET", `/rooms/${state.currentRoom.id}/leaderboard`);
        if (data.leaderboard) {
          state.leaderboard = data.leaderboard;
          renderLeaderboard();
        }
      }, 500);
    }
  } catch (err) { toast(err.message, "error"); }
}

// ─── ADD ITEM MODAL ────────────────────────────
function openAddItemModal() { $("add-item-modal").classList.add("open"); $("item-name-input").focus(); }
function closeAddItemModal() {
  $("add-item-modal").classList.remove("open");
  ["item-name-input", "item-desc-input", "item-price-input", "item-order-input"].forEach(id => $(id).value = "");
}

async function submitAddItem() {
  const name = $("item-name-input").value.trim();
  const description = $("item-desc-input").value.trim();
  const actual_price = parseFloat($("item-price-input").value);
  const display_order = parseInt($("item-order-input").value) || (state.currentItems.length + 1);
  if (!name) return toast("Item name required", "error");
  if (!actual_price) return toast("Actual price required", "error");
  try {
    await apiCall("POST", `/rooms/${state.currentRoom.id}/items`, { name, description, actual_price, display_order });
    closeAddItemModal();
    toast("Item added!", "success");
    const data = await apiCall("GET", `/rooms/${state.currentRoom.id}`);
    state.currentItems = data.items;
    renderItems();
  } catch (err) { toast(err.message, "error"); }
}

// ─── DELETE ITEM ───────────────────────────────
async function openDeleteItem(itemId) {
  if (!confirm("Delete this item?")) return;
  try {
    await apiCall("DELETE", `/rooms/${state.currentRoom.id}/items/${itemId}`);
    toast("Item deleted", "success");
    const data = await apiCall("GET", `/rooms/${state.currentRoom.id}`);
    state.currentItems = data.items;
    renderItems();
  } catch (err) { toast(err.message, "error"); }
}

// ─── LEADERBOARD ───────────────────────────────
function renderLeaderboard() {
  const list = $("leaderboard-list");
  if (!list) return;
  const top5 = state.leaderboard.slice(0, 5);
  if (!top5.length) {
    list.innerHTML = `<div style="color:var(--text-mute);font-family:var(--mono);font-size:12px;">No players yet</div>`;
    return;
  }
  list.innerHTML = top5.map((p, i) => {
    const rankClass = i === 0 ? "top-1" : i === 1 ? "top-2" : i === 2 ? "top-3" : "";
    const rankSymbol = i === 0 ? "🥇" : i === 1 ? "🥈" : i === 2 ? "🥉" : `#${i + 1}`;
    // FIX: highlight current user in leaderboard
    const isMe = String(p.id) === String(state.user?.id);
    return `
      <div class="lb-entry ${rankClass}" style="${isMe ? "border-color:var(--green);" : ""}">
        <div class="lb-rank">${rankSymbol}</div>
        <div class="lb-name" style="${isMe ? "color:var(--green);" : ""}">${escapeHTML(p.name)}${isMe ? " ★" : ""}</div>
        <div class="lb-score">
          <div class="lb-won">${p.items_won} won</div>
          <div style="color:var(--gold);">⚡ ${parseFloat(p.net_worth).toFixed(0)} pts</div>
        </div>
      </div>
    `;
  }).join("");
}

// ─── RESULTS PAGE ──────────────────────────────
function renderResults() {
  const wrap = $("results-section");
  if (!wrap) return;
  const finishedItems = state.currentItems.filter(i => i.status === "finished" && i.revealed);
  if (!finishedItems.length) { wrap.style.display = "none"; return; }
  wrap.style.display = "block";

  const itemsHTML = finishedItems.map(item => {
    const actual = parseFloat(item.actual_price || 0);
    const winning = parseFloat(item.winning_bid || 0);
    const isMyWin = String(item.winner_id) === String(state.user?.id);
    const diff = actual - winning;
    const pnlClass = diff >= 0 ? "profit" : "loss";
    const sign = diff >= 0 ? "+" : "";
    const winnerName = item.winner_name ||
      state.leaderboard.find(l => String(l.id) === String(item.winner_id))?.name ||
      (isMyWin ? state.user.name : "Unknown");
    return `
      <div class="result-item">
        <div class="result-item-name">${escapeHTML(item.name)}</div>
        <div class="result-row"><span>Winner</span><span>${item.winner_id ? (isMyWin ? "YOU 🏆" : escapeHTML(winnerName)) : "—"}</span></div>
        <div class="result-row"><span>Winning Bid</span><span>${winning ? formatCurrency(winning) : "—"}</span></div>
        <div class="result-row"><span>Actual Price</span><span>${formatCurrency(actual)}</span></div>
        ${isMyWin ? `<div class="result-pnl ${pnlClass}">${sign}${formatCurrency(diff)} P&L</div>` : ""}
      </div>
    `;
  }).join("");

  const myEntry = state.leaderboard.find(l => String(l.id) === String(state.user?.id));
  const summaryHTML = myEntry ? `
    <div class="card" style="margin-top:0">
      <div class="card-title">YOUR SUMMARY</div>
      <div class="card-sub" style="margin-bottom:16px">FINAL STANDINGS</div>
      <div style="display:flex;flex-direction:column;gap:10px;font-family:var(--mono);font-size:14px;">
        <div style="display:flex;justify-content:space-between;"><span style="color:var(--text-dim)">Items Won</span><span style="color:var(--gold)">${myEntry.items_won}</span></div>
        <div style="display:flex;justify-content:space-between;"><span style="color:var(--text-dim)">Total Spent</span><span>${formatCurrency(myEntry.total_spent)}</span></div>
        <div style="display:flex;justify-content:space-between;border-top:1px solid var(--border);padding-top:10px;">
          <span style="color:var(--text-dim)">Rank</span>
          <span style="color:var(--gold)">#${state.leaderboard.findIndex(l => String(l.id) === String(state.user?.id)) + 1}</span>
        </div>
      </div>
    </div>
  ` : "";

  wrap.innerHTML = `
    <div style="padding:32px;border-top:1px solid var(--border);">
      <div class="results-title">RESULTS</div>
      <div class="results-sub">ACTUAL PRICES REVEALED BY ADMIN</div>
      <div class="results-grid">
        <div class="results-items">${itemsHTML}</div>
        <div>${summaryHTML}</div>
      </div>
    </div>
  `;
}

// ─── BACK TO LOBBY ─────────────────────────────
function backToLobby() {
  if (state.ws) { state.ws.close(); state.ws = null; }
  stopLeaderboardPolling();
  state.currentRoom = null;
  state.currentItems = [];
  state.topBids = {};
  state.activeBidders = {};
  showLobby();
}

// ─── INIT ──────────────────────────────────────
document.addEventListener("DOMContentLoaded", () => {
  if (state.token && state.user) {
    renderNavUser();
    showLobby();
  } else {
    showAuthPage();
  }
});