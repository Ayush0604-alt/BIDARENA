// ═══════════════════════════════════════════════
//  BIDArena — Main Application
// ═══════════════════════════════════════════════

const API = (window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1")
  ? "http://localhost:5000/api/v1" : "/api/v1";
const WS_PROTOCOL = window.location.protocol === "https:" ? "wss:" : "ws:";
const WS_URL = (window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1")
  ? "ws://localhost:5000/ws" : `${WS_PROTOCOL}//${window.location.host}/ws`;

// ─── STATE ─────────────────────────────────────
const state = {
  token: localStorage.getItem("ba_token") || null,
  user: JSON.parse(localStorage.getItem("ba_user") || "null"),
  currentRoom: null,
  currentItems: [],
  topBids: {},
  leaderboard: [],
  ws: null,
  resultsRevealed: false,
  allBids: {},
  roomPoints: 0,           // room-scoped points — fresh 10000 each room
  activeCountdowns: {},    // itemId -> { interval, remaining, total }
  leaderboardInterval: null,
  _wsReconnectAttempt: 0,
  _wsReconnectTimer: null,
  _wsIntentionalClose: false,
};

// ─── AUDIO ─────────────────────────────────────
let audioCtx = null;
function getAudioCtx() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  return audioCtx;
}
function playSound(type) {
  try {
    const ctx = getAudioCtx();
    if (ctx.state === "suspended") ctx.resume();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain); gain.connect(ctx.destination);
    const now = ctx.currentTime;
    if (type === "tick") {
      osc.type = "sine"; osc.frequency.setValueAtTime(880, now);
      gain.gain.setValueAtTime(0.25, now); gain.gain.exponentialRampToValueAtTime(0.01, now+0.08);
      osc.start(now); osc.stop(now+0.08);
    } else if (type === "urgent") {
      osc.type = "square"; osc.frequency.setValueAtTime(440, now);
      gain.gain.setValueAtTime(0.3, now); gain.gain.exponentialRampToValueAtTime(0.01, now+0.1);
      osc.start(now); osc.stop(now+0.1);
    } else if (type === "success") {
      osc.type = "triangle"; osc.frequency.setValueAtTime(400, now);
      osc.frequency.linearRampToValueAtTime(800, now+0.2);
      gain.gain.setValueAtTime(0.5, now); gain.gain.linearRampToValueAtTime(0, now+0.5);
      osc.start(now); osc.stop(now+0.5);
    } else if (type === "error") {
      osc.type = "sawtooth"; osc.frequency.setValueAtTime(150, now);
      gain.gain.setValueAtTime(0.4, now); gain.gain.linearRampToValueAtTime(0, now+0.3);
      osc.start(now); osc.stop(now+0.3);
    }
  } catch (_) {}
}

function escapeHTML(str) {
  if (!str) return "";
  return String(str).replace(/[&<>'"]/g, t => ({"&":"&amp;","<":"&lt;",">":"&gt;","'":"&#39;",'"':"&quot;"}[t]));
}

// ─── UTILS ─────────────────────────────────────
function $(id) { return document.getElementById(id); }
function showPage(id) {
  document.querySelectorAll(".page").forEach(p => p.classList.remove("active"));
  $(id).classList.add("active");
}
function toast(msg, type="info") {
  const c = $("toast-container"); if (!c) return;
  const el = document.createElement("div");
  el.className = `toast ${type}`;
  const icon = type==="success"?"✓":type==="error"?"✗":type==="gold"?"⚡":"•";
  el.innerHTML = `<span style="color:var(--gold)">${icon}</span> ${msg}`;
  c.appendChild(el);
  setTimeout(() => el.remove(), 3500);
}
function formatCurrency(n) {
  return "₹" + parseFloat(n||0).toLocaleString("en-IN", { minimumFractionDigits: 2 });
}
function timeNow() {
  return new Date().toLocaleTimeString("en-IN", { hour:"2-digit", minute:"2-digit", second:"2-digit" });
}
function addFeed(msg, type="system") {
  const feed = $("activity-feed"); if (!feed) return;
  const el = document.createElement("div");
  el.className = `feed-entry ${type}`;
  el.innerHTML = `<span class="feed-time">${timeNow()}</span>${msg}`;
  feed.prepend(el);
  while (feed.children.length > 60) feed.lastChild.remove();
}

// ─── ROOM-SCOPED POINTS ────────────────────────
function updateRoomPointsDisplay() {
  const navPts = $("nav-points");
  const wrap = $("points-bar-wrap");
  const fill = $("points-bar-fill");

  // Only show inside arena and only for buyers
  const inArena = $("page-arena")?.classList.contains("active");
  if (!inArena || !state.user || state.user.role === "admin") {
    if (navPts) navPts.style.display = "none";
    if (wrap) wrap.style.display = "none";
    return;
  }

  const pts = state.roomPoints;
  if (navPts) {
    navPts.style.display = "inline-block";
    navPts.textContent = `⚡ ${pts.toFixed(0)} pts`;
  }
  if (wrap && fill) {
    wrap.style.display = "block";
    const pct = Math.min(100, Math.max(0, (pts / 10000) * 100));
    fill.style.width = `${pct}%`;
    fill.style.background = pts < 2000 ? "var(--red)" : "var(--green)";
  }
}

function showWinnerBanner(userName, itemName, amount) {
  const banner = $("winner-banner"); if (!banner) return;
  banner.textContent = `🏆 ${userName} won ${itemName} for ${formatCurrency(amount)}!`;
  banner.classList.add("show");
  setTimeout(() => banner.classList.remove("show"), 4000);
}
function toggleMobileSidebar() {
  const sb = $("arena-sidebar"); if (sb) sb.classList.toggle("open");
}

// ─── API ───────────────────────────────────────
async function apiCall(method, path, body) {
  const headers = { "Content-Type": "application/json" };
  if (state.token) headers["Authorization"] = `Bearer ${state.token}`;
  const res = await fetch(`${API}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json();
  if (!res.ok) throw new Error(data.message || "Request failed");
  return data;
}
function saveAuth(token, user) {
  state.token = token; state.user = user;
  localStorage.setItem("ba_token", token);
  localStorage.setItem("ba_user", JSON.stringify(user));
}
function logout() {
  state.token = null; state.user = null;
  localStorage.removeItem("ba_token"); localStorage.removeItem("ba_user");
  closeWebSocket(); stopLeaderboardPolling();
  showPage("page-auth"); renderNavUser();
}
function renderNavUser() {
  const wrap = $("nav-user-wrap"); if (!state.user) { wrap.innerHTML = ""; return; }
  const inArena = $("page-arena")?.classList.contains("active");
  // Points shown only in arena for buyers
  const pointsHTML = (state.user.role !== "admin" && inArena)
    ? `<span id="nav-points" style="font-family:var(--mono);font-size:13px;color:var(--gold);border:1px solid var(--border-bright);padding:3px 10px;border-radius:2px;">⚡ ${state.roomPoints.toFixed(0)} pts</span>`
    : `<span id="nav-points" style="display:none;"></span>`;
  wrap.innerHTML = `
    ${pointsHTML}
    <span class="nav-user">${escapeHTML(state.user.name)}</span>
    <span class="nav-badge ${state.user.role==="admin"?"admin":""}">${state.user.role.toUpperCase()}</span>
    <button class="btn btn-ghost" onclick="logout()" style="padding:6px 12px">LOGOUT</button>
  `;
  updateRoomPointsDisplay();
}

// ─── LEADERBOARD POLLING (fallback) ────────────
function startLeaderboardPolling(roomId) {
  stopLeaderboardPolling();
  state.leaderboardInterval = setInterval(async () => {
    if (!state.currentRoom) return;
    try {
      const data = await apiCall("GET", `/rooms/${roomId}/leaderboard`);
      if (data.leaderboard) { state.leaderboard = data.leaderboard; renderLeaderboard(); }
    } catch (_) {}
  }, 15000);
}
function stopLeaderboardPolling() {
  if (state.leaderboardInterval) { clearInterval(state.leaderboardInterval); state.leaderboardInterval = null; }
}

// ─── RULES MODAL ───────────────────────────────
const BUYER_RULES = [
  { icon: "⚡", title: "You start with ₹10,000", body: "Every auction room gives you a fresh ₹10,000 to bid with. Points reset when you enter a new room — spend them wisely." },
  { icon: "🏷️", title: "Bid higher to lead", body: "Each new bid must exceed the current highest bid. Your points are held as soon as you bid, and refunded if someone outbids you." },
  { icon: "⏱️", title: "15-second countdown", body: "Every bid starts a 15-second timer visible to everyone. If nobody outbids you before it hits zero, you win the item automatically." },
  { icon: "🏆", title: "Win items, build wealth", body: "When you win an item, your points are spent. After the admin reveals actual prices, your P&L is calculated: actual price minus what you paid." },
  { icon: "📊", title: "Leaderboard ranks net worth", body: "Your rank = remaining points + actual value of items you won. The closer you bid to the actual price, the better your P&L." },
  { icon: "📧", title: "Results by email", body: "After the admin reveals prices, you'll receive a full P&L breakdown and top-5 leaderboard in your email." },
];
const ADMIN_RULES = [
  { icon: "🏗️", title: "Create a room", body: "Give it a name and optionally set a max player count. Buyers will join from the lobby before you start." },
  { icon: "📦", title: "Add items before starting", body: "For each item set a name, description, and actual price (kept secret from buyers). Set display order to control the sequence." },
  { icon: "▶️", title: "Start bidding per item", body: "Click START BIDDING to open an item for bids. Only one item can be active at a time. Buyers see a live 15-second countdown after each bid." },
  { icon: "⏱️", title: "Auto-close on timeout", body: "If no new bid arrives within 15 seconds of the last bid, the item closes automatically and the highest bidder wins." },
  { icon: "■  Force-end anytime", title: "■ Force-end anytime", body: "You can click END BIDDING at any moment to close the item immediately. The current highest bidder wins." },
  { icon: "🔓", title: "Reveal prices to end the game", body: "Once all items are done, click REVEAL PRICES. Actual prices are shown to all players, P&L is calculated, and result emails are sent to everyone." },
];

function showRulesModal() {
  const isAdmin = state.user?.role === "admin";
  const rules = isAdmin ? ADMIN_RULES : BUYER_RULES;
  const overlay = $("rules-modal-overlay");
  const content = $("rules-modal-content");
  if (!overlay || !content) return;

  content.innerHTML = `
    <div style="display:flex;align-items:flex-start;justify-content:space-between;margin-bottom:28px;">
      <div>
        <div style="font-family:var(--display);font-size:36px;letter-spacing:4px;color:var(--gold);line-height:1;">
          ${isAdmin ? "ADMIN GUIDE" : "HOW TO PLAY"}
        </div>
        <div style="font-family:var(--mono);font-size:11px;color:var(--text-dim);letter-spacing:3px;margin-top:6px;">
          ${isAdmin ? "YOUR CONTROLS & RESPONSIBILITIES" : "BUYER RULES & POWERS"}
        </div>
      </div>
      <button onclick="closeRulesModal()" style="background:transparent;border:1px solid var(--bg4);color:var(--text-dim);font-size:20px;width:36px;height:36px;border-radius:2px;cursor:pointer;display:flex;align-items:center;justify-content:center;flex-shrink:0;" title="Close">✕</button>
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-bottom:28px;">
      ${rules.map(r => `
        <div style="background:var(--bg3);border:1px solid var(--bg4);border-radius:4px;padding:16px 18px;">
          <div style="font-size:22px;margin-bottom:8px;">${r.icon}</div>
          <div style="font-family:var(--mono);font-size:12px;color:var(--gold);letter-spacing:1px;margin-bottom:6px;text-transform:uppercase;">${escapeHTML(r.title)}</div>
          <div style="font-size:13px;color:var(--text-dim);line-height:1.5;">${escapeHTML(r.body)}</div>
        </div>
      `).join("")}
    </div>
    ${!isAdmin ? `
    <div style="background:rgba(245,197,24,0.06);border:1px solid rgba(245,197,24,0.3);border-radius:4px;padding:14px 18px;margin-bottom:24px;font-family:var(--mono);font-size:12px;color:var(--text-dim);letter-spacing:1px;">
      💡 TIP: Watch the countdown bar on each item — jump in just before it expires to steal the win!
    </div>` : `
    <div style="background:rgba(245,197,24,0.06);border:1px solid rgba(245,197,24,0.3);border-radius:4px;padding:14px 18px;margin-bottom:24px;font-family:var(--mono);font-size:12px;color:var(--text-dim);letter-spacing:1px;">
      💡 TIP: Use DASHBOARD to monitor player balances and reset points between rounds if needed.
    </div>`}
    <button onclick="closeRulesModal()" class="btn btn-gold btn-lg" style="width:100%;justify-content:center;">
      ENTER ARENA →
    </button>
  `;

  overlay.classList.add("open");
}

function closeRulesModal() {
  const overlay = $("rules-modal-overlay");
  if (overlay) overlay.classList.remove("open");
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
  const btn = $("auth-submit"); btn.disabled = true;
  $("auth-error").style.display = "none";
  try {
    let data;
    if (authMode === "register") {
      data = await apiCall("POST", "/auth/register", { name: $("auth-name").value.trim(), email, password, role: $("auth-role").value });
    } else {
      data = await apiCall("POST", "/auth/login", { email, password });
    }
    saveAuth(data.token, data.user);
    renderNavUser();
    showLobbyAndRules();
  } catch (err) {
    $("auth-error").textContent = err.message;
    $("auth-error").style.display = "block";
  } finally { btn.disabled = false; }
}

// ─── LOBBY ─────────────────────────────────────
async function showLobbyAndRules() {
  stopLeaderboardPolling();
  showPage("page-lobby");
  renderNavUser(); // hide points in lobby
  $("create-room-btn").style.display = state.user?.role === "admin" ? "inline-flex" : "none";
  await loadRooms();
  // Show rules once per session
  if (!sessionStorage.getItem("ba_rules_shown")) {
    sessionStorage.setItem("ba_rules_shown", "1");
    setTimeout(showRulesModal, 400);
  }
}
async function showLobby() { await showLobbyAndRules(); }
async function loadRooms() {
  try {
    const data = await apiCall("GET", "/rooms");
    renderRooms(data.rooms);
  } catch (err) { toast("Failed to load rooms: " + err.message, "error"); }
}
function renderRooms(rooms) {
  const grid = $("rooms-grid");
  if (!rooms.length) {
    grid.innerHTML = `<div style="color:var(--text-dim);font-family:var(--mono);font-size:14px;padding:40px 0;">No rooms yet. ${state.user?.role==="admin"?"Create one above.":"Ask an admin to create one."}</div>`;
    return;
  }
  grid.innerHTML = rooms.map(r => {
    const isFull = r.max_players && parseInt(r.participant_count) >= r.max_players && r.status === "waiting";
    return `
    <div class="room-card" onclick="joinRoom(${r.id})">
      ${state.user?.role === "admin" ? `
        <div style="position:absolute;top:12px;right:12px;font-size:16px;cursor:pointer;z-index:1;"
             onclick="event.stopPropagation();deleteRoomReq(${r.id},'${escapeHTML(r.name)}','${r.status}')">🗑️</div>` : ""}
      <div class="room-name">${escapeHTML(r.name)}</div>
      <div class="room-meta">
        <span>👤 ${escapeHTML(r.creator_name)}</span>
        <span>🧑‍🤝‍🧑 ${r.participant_count}${r.max_players ? "/"+r.max_players : ""} players</span>
        <span>📦 ${r.item_count} items</span>
      </div>
      <div class="room-status status-${r.status}">${r.status.toUpperCase()}${isFull?" — FULL":""}</div>
    </div>`
  }).join("");
}
async function deleteRoomReq(id, name, status) {
  const msg = status==="active"
    ? `⚠️ "${name}" is active! Deleting ends the auction. Sure?`
    : `Delete room "${name}"? Cannot be undone.`;
  if (!confirm(msg)) return;
  try { await apiCall("DELETE", `/rooms/${id}`); toast("Room deleted","success"); loadRooms(); }
  catch (err) { toast(err.message, "error"); }
}

// ─── CREATE ROOM MODAL ─────────────────────────
function openCreateRoomModal() { $("create-room-modal").classList.add("open"); setTimeout(()=>$("room-name-input").focus(),50); }
function closeCreateRoomModal() {
  $("create-room-modal").classList.remove("open");
  $("room-name-input").value = "";
  const mp = $("room-max-players-input"); if (mp) mp.value = "";
}
async function submitCreateRoom() {
  const name = $("room-name-input").value.trim();
  const mp = $("room-max-players-input");
  const max_players = mp ? parseInt(mp.value) || null : null;
  if (!name) return toast("Enter a room name", "error");
  try {
    await apiCall("POST", "/rooms", { name, max_players });
    closeCreateRoomModal(); toast("Room created!", "success"); await loadRooms();
  } catch (err) { toast(err.message, "error"); }
}

// ─── JOIN ROOM ─────────────────────────────────
async function joinRoom(roomId) {
  try {
    const data = await apiCall("GET", `/rooms/${roomId}`);
    state.currentRoom = data.room;
    state.currentItems = data.items;
    state.topBids = {};
    state.roomPoints = 0; // will be set by ROOM_POINTS event
    state.activeCountdowns = {};
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
    renderNavUser(); // show points in nav now
    connectWebSocket(roomId);
    startLeaderboardPolling(roomId);
  } catch (err) { toast("Failed to join room: " + err.message, "error"); }
}

// ─── ARENA ─────────────────────────────────────
function renderArena() {
  const room = state.currentRoom;
  $("arena-room-name").textContent = room.name;
  $("arena-room-status").textContent = room.status.toUpperCase();
  $("arena-room-status").className = `room-status status-${room.status}`;

  const maxTag = $("arena-max-players");
  if (maxTag) { maxTag.textContent = room.max_players ? `👥 Max ${room.max_players}` : ""; maxTag.style.display = room.max_players ? "inline-block" : "none"; }

  const dashBtn = $("admin-dashboard-btn");
  if (dashBtn) dashBtn.style.display = state.user?.role === "admin" ? "inline-flex" : "none";
  if (state.user?.role === "admin") {
    $("admin-add-item-btn").style.display = "inline-flex";
    $("admin-reveal-btn").style.display = state.resultsRevealed ? "none" : "inline-flex";
  } else {
    $("admin-add-item-btn").style.display = "none";
    $("admin-reveal-btn").style.display = "none";
  }
  renderItems();
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
    const isMyTopBid = topBid && String(topBid.userId) === String(state.user?.id);
    const revealed = item.revealed && item.actual_price != null;
    const myBid = isMyTopBid ? topBid.amount : null;
    const countdown = state.activeCountdowns[item.id];

    let pnlHTML = "";
    if (revealed && isFinished) {
      const actual = parseFloat(item.actual_price);
      if (myBid) {
        const diff = actual - parseFloat(myBid);
        const cls = diff >= 0 ? "profit" : "loss";
        pnlHTML = `<div class="${cls}" style="font-family:var(--mono);font-size:13px;margin-top:4px;">
          Your bid: ${formatCurrency(myBid)} → Actual: ${formatCurrency(actual)} →
          <strong>${diff>=0?"+":""}${formatCurrency(diff)} P&L</strong></div>`;
      } else {
        pnlHTML = `<div style="font-family:var(--mono);font-size:13px;color:var(--text-mute);margin-top:4px;">Actual price: ${formatCurrency(actual)}</div>`;
      }
    }

    let winnerHTML = "";
    if (isFinished && item.winner_id) {
      const wName = item.winner_name || (state.leaderboard.find(l=>String(l.id)===String(item.winner_id))?.name) || (isMyTopBid ? state.user.name : "Unknown");
      const isMyWin = String(item.winner_id) === String(state.user?.id);
      winnerHTML = `<div style="margin-top:12px;padding:10px 14px;background:rgba(245,197,24,0.06);border:1px solid rgba(245,197,24,0.25);border-radius:2px;font-family:var(--mono);font-size:13px;">
        🏆 Won by <strong style="color:var(--gold);">${escapeHTML(wName)}</strong>${isMyWin?' <span style="color:var(--green);">(You!)</span>':''} for ${formatCurrency(item.winning_bid)}
      </div>`;
    } else if (isFinished && !item.winner_id) {
      winnerHTML = `<div style="margin-top:12px;padding:10px 14px;background:var(--bg3);border:1px solid var(--bg4);border-radius:2px;font-family:var(--mono);font-size:13px;color:var(--text-mute);">No bids placed — item unsold</div>`;
    }

    // Countdown bar for active items with a live timer
    let countdownHTML = "";
    if (isActive && countdown) {
      const pct = Math.max(0, (countdown.remaining / countdown.total) * 100);
      const urgent = countdown.remaining <= 5;
      countdownHTML = `
        <div class="countdown-wrap visible" id="countdown-${item.id}">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">
            <span style="font-family:var(--mono);font-size:11px;color:var(--text-dim);letter-spacing:2px;">TIME TO AUTO-CLOSE</span>
            <span id="countdown-text-${item.id}" style="font-family:var(--display);font-size:24px;color:${urgent?"var(--red)":"var(--gold)"};line-height:1;">${countdown.remaining}s</span>
          </div>
          <div class="countdown-bar">
            <div id="countdown-fill-${item.id}" class="countdown-fill" style="width:${pct}%;background:${urgent?"var(--red)":"var(--gold)"};"></div>
          </div>
          <div style="font-family:var(--mono);font-size:11px;color:var(--text-dim);margin-top:4px;letter-spacing:1px;">
            ${topBid ? `<b style="color:var(--text);">${escapeHTML(topBid.userName)}</b> leads with ${formatCurrency(topBid.amount)} — bid now to take the lead!` : "No bids yet — be the first!"}
          </div>
        </div>`;
    } else if (isActive) {
      countdownHTML = `
        <div class="countdown-wrap visible" id="countdown-${item.id}" style="opacity:0.5;">
          <div class="countdown-bar"><div id="countdown-fill-${item.id}" class="countdown-fill" style="width:100%;"></div></div>
          <div style="font-family:var(--mono);font-size:11px;color:var(--text-dim);margin-top:4px;letter-spacing:1px;">Place a bid to start the 15s countdown</div>
        </div>`;
    }

    const nextMin = topBid ? (parseFloat(topBid.amount) + 1).toFixed(0) : "100";

    return `
    <div class="item-card ${isActive?"active-item":""} ${isFinished?"finished-item":""}" id="item-card-${item.id}">
      <div class="item-number">ITEM ${String(idx+1).padStart(2,"0")} / ${String(state.currentItems.length).padStart(2,"0")}</div>
      <div class="item-name">${escapeHTML(item.name)}</div>
      ${item.description ? `<div class="item-desc">${escapeHTML(item.description)}</div>` : ""}

      <div class="bid-info">
        <div class="bid-block">
          <div class="bid-label">${isActive?"Leading Bid":isFinished?"Winning Bid":"Starting Bid"}</div>
          <div class="bid-amount ${topBid?"":"dim"}" id="bid-amount-${item.id}">${topBid ? formatCurrency(topBid.amount) : "—"}</div>
          <div class="bid-user" id="bid-user-${item.id}">${topBid ? "by "+escapeHTML(topBid.userName) : "No bids yet"}</div>
        </div>
        <div class="bid-block">
          <div class="bid-label">Status</div>
          <div class="room-status status-${item.status}" style="margin-top:4px;" id="item-status-${item.id}">${item.status.toUpperCase()}</div>
        </div>
      </div>

      ${countdownHTML}
      ${winnerHTML}
      ${pnlHTML}

      ${isActive && !isAdmin ? `
        ${state.user?.isSpectator ? `<div style="margin-top:16px;"><div class="spectating-badge">👀 SPECTATING</div></div>` : `
          <div class="bid-row" id="bid-row-${item.id}" style="margin-top:14px;">
            <div class="bid-input-wrap">
              <span class="bid-currency">₹</span>
              <input class="form-input" type="number" id="bid-val-${item.id}"
                placeholder="${nextMin}" min="${nextMin}" step="1"
                onkeydown="if(event.key==='Enter') placeBid(${item.id})" />
            </div>
            <button class="btn btn-gold" id="bid-btn-${item.id}"
              onclick="placeBid(${item.id})"
              ${isMyTopBid ? "disabled" : ""}>
              ${isMyTopBid ? "YOU LEAD" : "PLACE BID"}
            </button>
          </div>
          <div style="font-family:var(--mono);font-size:11px;color:var(--text-mute);margin-top:6px;">
            Room balance: <span style="color:var(--gold);">⚡ ${state.roomPoints.toFixed(0)} pts</span>
          </div>
        `}
      ` : ""}

      ${isFinished && state.allBids[item.id] && state.allBids[item.id].length > 0 ? `
        <div class="bid-history">
          <div class="bid-history-title" onclick="document.getElementById('bid-hist-${item.id}').classList.toggle('open')">
            <span>BID HISTORY (${state.allBids[item.id].length})</span><span>▼</span>
          </div>
          <div class="bid-history-list" id="bid-hist-${item.id}">
            ${state.allBids[item.id].map(b => `
              <div class="bid-history-item">
                <span>${escapeHTML(b.user_name)}</span>
                <span>${formatCurrency(b.amount)}</span>
              </div>`).join("")}
          </div>
        </div>` : ""}

      ${isAdmin ? `
        <div class="admin-controls">
          ${item.status==="pending" ? `<button class="btn btn-gold" onclick="adminStartItem(${item.id})">▶ START BIDDING</button>` : ""}
          ${item.status==="active"  ? `<button class="btn btn-danger" onclick="adminEndItem(${item.id})">■ END BIDDING</button>` : ""}
          ${item.status==="pending" ? `<button class="btn btn-ghost" onclick="openDeleteItem(${item.id})">DELETE</button>` : ""}
        </div>` : ""}
    </div>`;
  }).join("");
}

// ─── COUNTDOWN MANAGEMENT ──────────────────────
function startItemCountdown(itemId, totalSecs, startedAt) {
  // Clear any existing countdown for this item
  if (state.activeCountdowns[itemId]?.intervalHandle) {
    clearInterval(state.activeCountdowns[itemId].intervalHandle);
  }

  const elapsed = startedAt ? (Date.now() - startedAt) / 1000 : 0;
  let remaining = Math.max(0, Math.ceil(totalSecs - elapsed));

  state.activeCountdowns[itemId] = { remaining, total: totalSecs, startedAt };

  const tick = () => {
    const w = state.activeCountdowns[itemId];
    if (!w) return;

    // Update DOM directly for performance (no full re-render)
    const fillEl = $(`countdown-fill-${itemId}`);
    const textEl = $(`countdown-text-${itemId}`);
    const pct = Math.max(0, (w.remaining / w.total) * 100);
    const urgent = w.remaining <= 5;

    if (fillEl) {
      fillEl.style.width = `${pct}%`;
      fillEl.style.background = urgent ? "var(--red)" : "var(--gold)";
    }
    if (textEl) {
      textEl.textContent = `${w.remaining}s`;
      textEl.style.color = urgent ? "var(--red)" : "var(--gold)";
    }
    if (urgent) playSound("urgent");

    if (w.remaining <= 0) {
      clearInterval(w.intervalHandle);
      delete state.activeCountdowns[itemId];
      return;
    }
    w.remaining--;
  };

  tick(); // immediate first tick
  const intervalHandle = setInterval(tick, 1000);
  state.activeCountdowns[itemId].intervalHandle = intervalHandle;
}

function clearItemCountdown(itemId) {
  if (state.activeCountdowns[itemId]?.intervalHandle) {
    clearInterval(state.activeCountdowns[itemId].intervalHandle);
  }
  delete state.activeCountdowns[itemId];
}

// ─── WEBSOCKET ─────────────────────────────────
function closeWebSocket() {
  if (state.ws) { state._wsIntentionalClose = true; state.ws.close(); state.ws = null; }
  if (state._wsReconnectTimer) { clearTimeout(state._wsReconnectTimer); state._wsReconnectTimer = null; }
  state._wsReconnectAttempt = 0;
}
function connectWebSocket(roomId) {
  closeWebSocket(); state._wsIntentionalClose = false; state._wsReconnectAttempt = 0; _connectWS(roomId);
}
function _connectWS(roomId) {
  setWsDot("connecting");
  const ws = new WebSocket(`${WS_URL}?token=${state.token}`);
  state.ws = ws;
  ws.onopen = () => {
    state._wsReconnectAttempt = 0; setWsDot("connected");
    ws.send(JSON.stringify({ type: "JOIN_ROOM", roomId }));
    addFeed("Connected to arena", "system");
  };
  ws.onclose = (evt) => {
    setWsDot("error");
    if (state._wsIntentionalClose) return;
    if (evt.code === 4001) { toast("Session expired — please login again","error"); logout(); return; }
    if (evt.code === 4010) return;
    const attempt = ++state._wsReconnectAttempt;
    const delay = Math.min(1000 * Math.pow(2, attempt-1), 30000);
    addFeed(`Disconnected — reconnecting in ${(delay/1000).toFixed(0)}s…`, "system");
    state._wsReconnectTimer = setTimeout(() => {
      if (!state._wsIntentionalClose && state.currentRoom?.id === roomId) _connectWS(roomId);
    }, delay);
  };
  ws.onerror = () => setWsDot("error");
  ws.onmessage = (e) => { let msg; try { msg = JSON.parse(e.data); } catch { return; } handleWsMessage(msg); };
}
function setWsDot(status) {
  const dot = $("ws-dot"); if (!dot) return;
  dot.className = "ws-indicator" + (status==="connected"?" connected":status==="error"?" error":"");
}
function wsSend(obj) {
  if (state.ws?.readyState === WebSocket.OPEN) state.ws.send(JSON.stringify(obj));
  else toast("Not connected — please wait","error");
}

// ─── WS MESSAGE HANDLER ────────────────────────
function handleWsMessage(msg) {
  switch (msg.type) {

    case "ROOM_SNAPSHOT": {
      state.currentRoom = msg.data.room;
      state.currentItems = msg.data.items;
      if (msg.data.isSpectator !== undefined) state.user.isSpectator = msg.data.isSpectator;
      msg.data.topBids.forEach(b => {
        state.topBids[b.item_id] = { userId: b.user_id, userName: b.user_name || "?", amount: b.amount };
      });
      // Restore any active countdowns
      if (msg.data.activeCountdowns) {
        for (const [itemId, cd] of Object.entries(msg.data.activeCountdowns)) {
          startItemCountdown(parseInt(itemId), cd.durationSecs, cd.startedAt);
        }
      }
      renderItems();
      break;
    }

    case "ROOM_POINTS": {
      // Room-scoped points update
      state.roomPoints = parseFloat(msg.data.points);
      updateRoomPointsDisplay();
      renderItems(); // refresh the "room balance" line under bid inputs
      break;
    }

    case "REAUTH_REQUIRED":
      toast(msg.reason + " — Please login again.", "error");
      setTimeout(logout, 3000);
      break;

    case "PONG": break;

    case "BID_PLACED": {
      const { itemId, userId, userName, amount, countdownSecs, startedAt } = msg.data;

      // Update top bid display
      state.topBids[itemId] = { userId, userName, amount };
      const amtEl = $(`bid-amount-${itemId}`);
      const userEl = $(`bid-user-${itemId}`);
      if (amtEl) { amtEl.textContent = formatCurrency(amount); amtEl.classList.remove("dim"); }
      if (userEl) userEl.textContent = `by ${escapeHTML(userName)}`;

      // Update bid button state
      const btn = $(`bid-btn-${itemId}`);
      if (btn) {
        const isMe = String(userId) === String(state.user?.id);
        btn.disabled = isMe;
        btn.textContent = isMe ? "YOU LEAD" : "PLACE BID";
      }

      // Add to local allBids for history
      if (!state.allBids[itemId]) state.allBids[itemId] = [];
      state.allBids[itemId].unshift({ item_id: itemId, user_id: userId, amount, user_name: userName });

      // Start / reset countdown
      startItemCountdown(itemId, countdownSecs || 15, startedAt || Date.now());

      addFeed(`<b>${escapeHTML(userName)}</b> bid ${formatCurrency(amount)} — 15s clock reset`, "bid");
      playSound("tick");
      break;
    }

    case "ITEM_STARTED": {
      const item = msg.data;
      updateItemInState(item);
      state.activeCountdowns[item.id] = null; // no countdown until first bid
      renderItems();
      addFeed(`📦 Bidding open: <b>${escapeHTML(item.name)}</b> — place the first bid!`, "system");
      toast(`Bidding open: ${item.name}`, "gold");
      break;
    }

    case "ITEM_ENDED": {
      const item = msg.data;
      clearItemCountdown(item.id);
      updateItemInState(item);
      renderItems();

      const reason = item.end_reason === "timeout" ? "⏱️ Timer expired" : "■ Admin ended";
      if (item.winner_name) {
        const isMyWin = String(item.winner_id) === String(state.user?.id);
        addFeed(`🏆 ${reason} — <b>${escapeHTML(item.name)}</b> → <b>${escapeHTML(item.winner_name)}</b> for ${formatCurrency(item.winning_bid)}`, "win");
        showWinnerBanner(item.winner_name, item.name, item.winning_bid);
        playSound("success");
        if (isMyWin) toast(`🏆 You won ${item.name}!`, "success");
        else toast(`${item.winner_name} won ${item.name} for ${formatCurrency(item.winning_bid)}`, "gold");
      } else {
        addFeed(`🔔 ${reason} — <b>${escapeHTML(item.name)}</b> unsold (no bids)`, "system");
        toast(`${item.name} ended with no bids`, "info");
      }
      break;
    }

    case "ITEM_UPDATE":
      updateItemInState(msg.data); renderItems(); break;

    case "LEADERBOARD":
      state.leaderboard = msg.data; renderLeaderboard(); break;

    case "PRICES_REVEALED":
      msg.data.items.forEach(i => updateItemInState(i));
      state.resultsRevealed = true;
      if (state.currentRoom) state.currentRoom.status = "finished";
      renderArena();
      toast("🎉 Actual prices revealed! Check your results.", "gold");
      addFeed("🏁 GAME OVER — Prices revealed!", "win");
      break;

    case "POINTS_RESET":
      // Server will follow up with ROOM_POINTS for this user
      toast("Points reset to 10,000 by admin!", "gold");
      break;

    case "BID_REJECTED":
      playSound("error"); toast(msg.reason, "error"); break;

    case "USER_JOINED":
      addFeed(`👤 ${escapeHTML(msg.data.name)} joined the room`, "system"); break;

    case "ERROR":
      toast(msg.reason || "An error occurred", "error");
      if (msg.reason?.includes("full")) setTimeout(showLobby, 2000);
      break;
  }
}

function updateItemInState(item) {
  const idx = state.currentItems.findIndex(i => i.id === item.id);
  if (idx !== -1) state.currentItems[idx] = { ...state.currentItems[idx], ...item };
  else state.currentItems.push(item);
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

// ─── ADMIN ACTIONS ─────────────────────────────
function adminStartItem(itemId) { wsSend({ type: "ADMIN_START_ITEM", itemId }); }
function adminEndItem(itemId) {
  const item = state.currentItems.find(i => i.id === itemId);
  const topBid = state.topBids[itemId];
  const msg = topBid
    ? `End bidding for "${item?.name}"?\n\nCurrent leader: ${topBid.userName} @ ${formatCurrency(topBid.amount)}\n\nThey will win immediately.`
    : `End bidding for "${item?.name}"? No bids placed — item will be unsold.`;
  if (!confirm(msg)) return;
  wsSend({ type: "ADMIN_END_ITEM", itemId });
}
function adminRevealPrices() {
  if (!confirm("Reveal actual prices to all players?\n\nThis ends the game and sends result emails to everyone.")) return;
  wsSend({ type: "ADMIN_REVEAL_PRICES", roomId: state.currentRoom.id });
}

async function openAdminDashboard() {
  $("admin-dashboard-modal").classList.add("open");
  const { leaderboard } = state;
  $("dash-total-players").textContent = leaderboard.length;
  const mp = state.currentRoom?.max_players;
  const mpEl = $("dash-max-players");
  if (mpEl) mpEl.textContent = mp ? `${leaderboard.length} / ${mp}` : `${leaderboard.length} (no limit)`;
  const activeItem = state.currentItems.find(i => i.status === "active");
  $("dash-active-item").textContent = activeItem ? activeItem.name : "None";
  const list = $("dash-players-list");
  const maxPts = Math.max(...leaderboard.map(p => parseFloat(p.net_worth)), 1);
  list.innerHTML = leaderboard.length ? leaderboard.map(p => {
    const pts = parseFloat(p.net_worth);
    const pct = Math.max(0, (pts / maxPts) * 100);
    return `<div style="margin-bottom:8px;">
      <div style="display:flex;justify-content:space-between;margin-bottom:4px;">
        <span style="font-family:var(--mono);font-size:13px;">${escapeHTML(p.name)}</span>
        <span style="color:var(--gold);font-family:var(--mono);font-size:13px;">⚡ ${pts.toFixed(0)} pts</span>
      </div>
      <div style="height:4px;background:var(--bg4);border-radius:2px;overflow:hidden;">
        <div style="height:100%;width:${pct}%;background:var(--gold);transition:width .3s;"></div>
      </div></div>`;
  }).join("") : `<div style="color:var(--text-mute);font-family:var(--mono);font-size:12px;padding:8px;">No players yet</div>`;
}
function closeAdminDashboard() { $("admin-dashboard-modal").classList.remove("open"); }
async function adminResetPoints() {
  if (!confirm("Reset ALL player room-points to 10,000?")) return;
  try {
    await apiCall("POST", "/rooms/reset-points");
    toast("All room points reset to 10,000", "success");
    closeAdminDashboard();
  } catch (err) { toast(err.message, "error"); }
}

// ─── ADD ITEM MODAL ────────────────────────────
function openAddItemModal() { $("add-item-modal").classList.add("open"); setTimeout(()=>$("item-name-input").focus(),50); }
function closeAddItemModal() {
  $("add-item-modal").classList.remove("open");
  ["item-name-input","item-desc-input","item-price-input","item-order-input"].forEach(id => $(id).value = "");
}
async function submitAddItem() {
  const name = $("item-name-input").value.trim();
  const description = $("item-desc-input").value.trim();
  const actual_price = parseFloat($("item-price-input").value);
  const display_order = parseInt($("item-order-input").value) || (state.currentItems.length + 1);
  if (!name) return toast("Item name required","error");
  if (!actual_price || isNaN(actual_price)) return toast("Actual price required","error");
  try {
    await apiCall("POST", `/rooms/${state.currentRoom.id}/items`, { name, description, actual_price, display_order });
    closeAddItemModal(); toast("Item added!", "success");
    const data = await apiCall("GET", `/rooms/${state.currentRoom.id}`);
    state.currentItems = data.items; renderItems();
  } catch (err) { toast(err.message,"error"); }
}
async function openDeleteItem(itemId) {
  if (!confirm("Delete this item?")) return;
  try {
    await apiCall("DELETE", `/rooms/${state.currentRoom.id}/items/${itemId}`);
    toast("Item deleted","success");
    const data = await apiCall("GET", `/rooms/${state.currentRoom.id}`);
    state.currentItems = data.items; renderItems();
  } catch (err) { toast(err.message,"error"); }
}

// ─── LEADERBOARD ───────────────────────────────
function renderLeaderboard() {
  const list = $("leaderboard-list"); if (!list) return;
  const top5 = state.leaderboard.slice(0,5);
  if (!top5.length) { list.innerHTML = `<div style="color:var(--text-mute);font-family:var(--mono);font-size:12px;">Waiting for bids...</div>`; return; }
  list.innerHTML = top5.map((p,i) => {
    const rankClass = i===0?"top-1":i===1?"top-2":i===2?"top-3":"";
    const rankSymbol = i===0?"🥇":i===1?"🥈":i===2?"🥉":`#${i+1}`;
    const isMe = String(p.id) === String(state.user?.id);
    return `<div class="lb-entry ${rankClass}" style="${isMe?"border-color:var(--green);":""}">
      <div class="lb-rank">${rankSymbol}</div>
      <div class="lb-name" style="${isMe?"color:var(--green);":""}">${escapeHTML(p.name)}${isMe?" ★":""}</div>
      <div class="lb-score">
        <div class="lb-won">${p.items_won} won</div>
        <div style="color:var(--gold);">⚡ ${parseFloat(p.net_worth).toFixed(0)} pts</div>
      </div></div>`;
  }).join("");
}

// ─── RESULTS ───────────────────────────────────
function renderResults() {
  const wrap = $("results-section"); if (!wrap) return;
  const finishedItems = state.currentItems.filter(i => i.status==="finished" && i.revealed);
  if (!finishedItems.length) { wrap.style.display="none"; return; }
  wrap.style.display = "block";
  const itemsHTML = finishedItems.map(item => {
    const actual = parseFloat(item.actual_price||0);
    const winning = parseFloat(item.winning_bid||0);
    const isMyWin = String(item.winner_id) === String(state.user?.id);
    const diff = actual - winning;
    const cls = diff>=0?"profit":"loss";
    const wName = item.winner_name || state.leaderboard.find(l=>String(l.id)===String(item.winner_id))?.name || (isMyWin?state.user.name:"Unknown");
    return `<div class="result-item">
      <div class="result-item-name">${escapeHTML(item.name)}</div>
      <div class="result-row"><span>Winner</span><span>${item.winner_id?(isMyWin?"YOU 🏆":escapeHTML(wName)):"—"}</span></div>
      <div class="result-row"><span>Winning Bid</span><span>${winning?formatCurrency(winning):"—"}</span></div>
      <div class="result-row"><span>Actual Price</span><span>${formatCurrency(actual)}</span></div>
      ${isMyWin?`<div class="result-pnl ${cls}">${diff>=0?"+":""}${formatCurrency(diff)} P&L</div>`:""}
    </div>`;
  }).join("");
  const myEntry = state.leaderboard.find(l=>String(l.id)===String(state.user?.id));
  const myRank = state.leaderboard.findIndex(l=>String(l.id)===String(state.user?.id))+1;
  const summaryHTML = myEntry ? `
    <div class="card" style="margin-top:0;">
      <div class="card-title">YOUR SUMMARY</div>
      <div class="card-sub" style="margin-bottom:16px">FINAL STANDINGS</div>
      <div style="display:flex;flex-direction:column;gap:10px;font-family:var(--mono);font-size:14px;">
        <div style="display:flex;justify-content:space-between;"><span style="color:var(--text-dim)">Items Won</span><span style="color:var(--gold)">${myEntry.items_won}</span></div>
        <div style="display:flex;justify-content:space-between;"><span style="color:var(--text-dim)">Total Spent</span><span>${formatCurrency(myEntry.total_spent)}</span></div>
        <div style="display:flex;justify-content:space-between;border-top:1px solid var(--border);padding-top:10px;">
          <span style="color:var(--text-dim)">Rank</span><span style="color:var(--gold);">#${myRank}</span>
        </div>
      </div>
    </div>` : "";
  wrap.innerHTML = `<div style="padding:32px;border-top:1px solid var(--border);">
    <div class="results-title">RESULTS</div>
    <div class="results-sub">ACTUAL PRICES REVEALED BY ADMIN</div>
    <div class="results-grid"><div class="results-items">${itemsHTML}</div><div>${summaryHTML}</div></div>
  </div>`;
}

// ─── BACK TO LOBBY ─────────────────────────────
function backToLobby() {
  closeWebSocket(); stopLeaderboardPolling();
  // Clear all countdowns
  for (const itemId of Object.keys(state.activeCountdowns)) clearItemCountdown(parseInt(itemId));
  state.currentRoom = null; state.currentItems = []; state.topBids = {};
  state.roomPoints = 0; state.activeCountdowns = {};
  showLobby();
}

// ─── INIT ──────────────────────────────────────
document.addEventListener("DOMContentLoaded", () => {
  if (state.token && state.user) { renderNavUser(); showLobbyAndRules(); }
  else showAuthPage();
});