const WebSocket = require("ws");
const jwt = require("jsonwebtoken");
const nodemailer = require("nodemailer");
const { pool, listenTo } = require("../config/db");

const roomClients = {};

function broadcast(roomId, data) {
  const clients = roomClients[roomId];
  if (!clients) return;
  const msg = JSON.stringify(data);
  clients.forEach((ws) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(msg);
  });
}

function broadcastAll(data) {
  Object.values(roomClients).forEach((clients) => {
    clients.forEach((ws) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data));
    });
  });
}

function broadcastToUser(userId, data) {
  const msg = JSON.stringify(data);
  Object.values(roomClients).forEach((clients) => {
    clients.forEach((ws) => {
      if (String(ws.userId) === String(userId) && ws.readyState === WebSocket.OPEN) {
        ws.send(msg);
      }
    });
  });
}

// ─── EMAIL ─────────────────────────────────────────────────────────────────
// Single verified transporter, created once and reused
let _transporter = null;
let _transporterReady = false;

async function initTransporter() {
  // Support both SMTP_* and EMAIL_* naming conventions
  const host = process.env.SMTP_HOST || process.env.EMAIL_HOST;
  const port = Number(process.env.SMTP_PORT || process.env.EMAIL_PORT || 587);
  const user = process.env.SMTP_USER || process.env.EMAIL_USER;
  const pass = process.env.SMTP_PASS || process.env.EMAIL_PASS;

  if (!host || !user || !pass) {
    console.warn("⚠️  Email not configured — set SMTP_HOST, SMTP_USER, SMTP_PASS in .env");
    return null;
  }

  const transport = nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    auth: { user, pass },
    tls: { rejectUnauthorized: false },
    pool: true,            // use connection pool
    maxConnections: 3,
    rateDelta: 1000,       // throttle: max 3 per second
    rateLimit: 3,
  });

  try {
    await transport.verify();
    console.log("✅ SMTP ready —", host);
    _transporterReady = true;
    return transport;
  } catch (err) {
    console.error("❌ SMTP verify failed:", err.message);
    console.error("   Check SMTP_HOST, SMTP_USER, SMTP_PASS in your .env / environment variables");
    return null; // Don't crash — just disable email
  }
}

async function getTransporter() {
  if (_transporter === null) {
    _transporter = await initTransporter();
  }
  return _transporter;
}

// Send with retry on transient failures
async function sendMailWithRetry(mailOptions, retries = 3) {
  const transporter = await getTransporter();
  if (!transporter) {
    console.warn("⚠️  No email transporter — skipping:", mailOptions.to);
    return false;
  }

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const info = await transporter.sendMail(mailOptions);
      console.log(`📧 Email sent → ${mailOptions.to} (${info.messageId})`);
      return true;
    } catch (err) {
      console.error(`📧 Email attempt ${attempt}/${retries} failed → ${mailOptions.to}: ${err.message}`);
      if (attempt < retries) {
        await new Promise(r => setTimeout(r, 1000 * attempt)); // back-off: 1s, 2s
      }
    }
  }
  return false;
}

// ─── WEBSOCKET SETUP ───────────────────────────────────────────────────────
function setupWebSocket(server) {
  const wss = new WebSocket.Server({ server, path: "/ws" });

  // Eagerly initialise the email transporter so problems show in startup logs
  getTransporter().catch(() => {});

  listenTo("bid_update", async (payload) => {
    const { rows } = await pool.query("SELECT room_id FROM items WHERE id=$1", [payload.item_id]);
    if (rows[0]) broadcast(rows[0].room_id, { type: "BID_UPDATE", data: payload });
  });

  listenTo("item_update", async (payload) => {
    const { rows } = await pool.query("SELECT room_id FROM items WHERE id=$1", [payload.id]);
    if (rows[0]) broadcast(rows[0].room_id, { type: "ITEM_UPDATE", data: payload });
  });

  listenTo("db_notifications", async (payload) => {
    if (payload.type === "POINTS_RESET") {
      const { rows: buyers } = await pool.query("SELECT id, points FROM users WHERE role='buyer'");
      const buyerMap = {};
      buyers.forEach(b => { buyerMap[String(b.id)] = b.points; });

      broadcastAll({ type: "POINTS_RESET" });

      Object.values(roomClients).forEach((clients) => {
        clients.forEach((ws) => {
          if (ws.readyState === WebSocket.OPEN && ws.userRole === "buyer") {
            const newPts = buyerMap[String(ws.userId)];
            if (newPts !== undefined) {
              ws.send(JSON.stringify({ type: "POINTS_UPDATE", data: { points: newPts } }));
            }
          }
        });
      });

      Object.keys(roomClients).forEach(roomId => {
        broadcastLeaderboard(roomId);
      });
    }
  });

  // Heartbeat — detect dead connections every 30s
  const heartbeatInterval = setInterval(() => {
    wss.clients.forEach((ws) => {
      if (ws.isAlive === false) { ws.terminate(); return; }
      ws.isAlive = false;
      ws.ping();
    });
  }, 30000);

  wss.on("close", () => clearInterval(heartbeatInterval));

  wss.on("connection", async (ws, req) => {
    ws.isAlive = true;
    ws.on("pong", () => { ws.isAlive = true; });

    const url = new URL(req.url, "http://localhost");
    const token = url.searchParams.get("token");
    let user;
    try {
      user = jwt.verify(token, process.env.JWT_SECRET);
    } catch {
      ws.close(4001, "Unauthorized");
      return;
    }
    ws.userId = user.id;
    ws.userRole = user.role;
    ws.userName = user.name;
    ws.roomId = null;
    ws.tokenExp = user.exp;

    ws.on("message", async (raw) => {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }

      // Warn client if token expires within 1 hour
      if (ws.tokenExp && ws.tokenExp * 1000 - Date.now() < 3600000) {
        ws.send(JSON.stringify({ type: "REAUTH_REQUIRED", reason: "Token expiring soon" }));
      }

      switch (msg.type) {
        case "JOIN_ROOM":          await handleJoinRoom(ws, msg.roomId); break;
        case "PLACE_BID":          await handlePlaceBid(ws, msg); break;
        case "WITHDRAW_BID":       await handleWithdrawBid(ws, msg); break;
        case "ADMIN_START_ITEM":   await handleStartItem(ws, msg); break;
        case "ADMIN_END_ITEM":     await handleEndItem(ws, msg); break;
        case "ADMIN_REVEAL_PRICES": await handleRevealPrices(ws, msg); break;
        case "GET_LEADERBOARD":    await sendLeaderboard(ws, msg.roomId || ws.roomId); break;
        case "PING":               ws.send(JSON.stringify({ type: "PONG" })); break;
      }
    });

    ws.on("close", () => {
      if (ws.roomId && roomClients[ws.roomId]) {
        roomClients[ws.roomId].delete(ws);
      }
    });

    ws.on("error", (err) => {
      console.error("WS client error:", err.message);
    });
  });

  return wss;
}

// ─── JOIN ROOM ─────────────────────────────────────────────────────────────
async function handleJoinRoom(ws, roomId) {
  if (ws.roomId && roomClients[ws.roomId]) roomClients[ws.roomId].delete(ws);
  ws.roomId = roomId;
  if (!roomClients[roomId]) roomClients[roomId] = new Set();

  // Close duplicate connections for the same user
  for (const client of roomClients[roomId]) {
    if (String(client.userId) === String(ws.userId) && client !== ws) {
      client.send(JSON.stringify({ type: "ERROR", reason: "Joined from another tab" }));
      client.close(4009, "Joined from another tab");
      roomClients[roomId].delete(client);
    }
  }

  const { rows: room } = await pool.query("SELECT * FROM rooms WHERE id=$1", [roomId]);
  if (!room[0]) {
    ws.send(JSON.stringify({ type: "ERROR", reason: "Room not found" }));
    return;
  }

  if (ws.userRole !== "admin") {
    const maxPlayers = room[0].max_players;
    if (maxPlayers && room[0].status === "waiting") {
      const existing = await pool.query(
        "SELECT COUNT(*) as cnt FROM room_participants WHERE room_id=$1 AND is_spectator=FALSE",
        [roomId]
      );
      const alreadyJoined = await pool.query(
        "SELECT 1 FROM room_participants WHERE room_id=$1 AND user_id=$2",
        [roomId, ws.userId]
      );
      if (!alreadyJoined.rows.length && parseInt(existing.rows[0].cnt) >= maxPlayers) {
        ws.send(JSON.stringify({
          type: "ERROR",
          reason: `Room is full (max ${maxPlayers} players)`
        }));
        ws.close(4010, "Room full");
        return;
      }
    }

    const isSpectator = room[0]?.status !== "waiting";
    await pool.query(
      `INSERT INTO room_participants(room_id, user_id, is_spectator)
       VALUES($1, $2, $3) ON CONFLICT DO NOTHING`,
      [roomId, ws.userId, isSpectator]
    );
  }

  roomClients[roomId].add(ws);

  const { rows: part } = await pool.query(
    "SELECT is_spectator FROM room_participants WHERE room_id=$1 AND user_id=$2",
    [roomId, ws.userId]
  );
  ws.isSpectator = part[0]?.is_spectator || false;

  const { rows: items } = await pool.query(
    "SELECT * FROM items WHERE room_id=$1 ORDER BY display_order", [roomId]
  );
  const { rows: topBids } = await pool.query(`
    SELECT DISTINCT ON (item_id) item_id, user_id, amount, created_at
    FROM bids WHERE item_id = ANY($1::int[])
    ORDER BY item_id, amount DESC
  `, [items.map(i => i.id)]);

  const activeBidderMap = {};
  for (const [itemId, w] of Object.entries(activeBidWindows)) {
    activeBidderMap[itemId] = [...w.activeBidders.entries()].map(([uid, info]) => ({
      userId: uid, userName: info.userName, amount: info.amount
    }));
  }

  ws.send(JSON.stringify({
    type: "ROOM_SNAPSHOT",
    data: {
      room: room[0],
      items,
      topBids,
      isSpectator: ws.isSpectator,
      activeBidderMap,
      maxPlayers: room[0].max_players || null
    }
  }));

  await sendLeaderboard(ws, roomId);

  broadcast(roomId, { type: "USER_JOINED", data: { userId: ws.userId, name: ws.userName } });

  const { rows: pCount } = await pool.query(
    "SELECT COUNT(*) as cnt FROM room_participants WHERE room_id=$1 AND is_spectator=FALSE",
    [roomId]
  );
  broadcast(roomId, {
    type: "PARTICIPANT_COUNT",
    data: { count: parseInt(pCount.rows[0]?.cnt || 0), maxPlayers: room[0].max_players || null }
  });
}

// ─── BIDDING ───────────────────────────────────────────────────────────────
const activeBidWindows = {};
const bidRateLimits = {};

async function handlePlaceBid(ws, msg) {
  if (ws.isSpectator) {
    return ws.send(JSON.stringify({ type: "BID_REJECTED", reason: "Spectators cannot place bids" }));
  }

  const { itemId, amount } = msg;
  const roomId = ws.roomId;

  const { rows } = await pool.query("SELECT * FROM items WHERE id=$1", [itemId]);
  const item = rows[0];
  if (!item || item.status !== "active") {
    return ws.send(JSON.stringify({ type: "BID_REJECTED", reason: "Item not active" }));
  }

  // Rate limit: max 5 bids per 10-second window
  const now = Date.now();
  if (!bidRateLimits[ws.userId] || now - bidRateLimits[ws.userId].firstHit > 10000) {
    bidRateLimits[ws.userId] = { count: 1, firstHit: now };
  } else if (++bidRateLimits[ws.userId].count > 5) {
    return ws.send(JSON.stringify({ type: "BID_REJECTED", reason: "Too many bids — please wait." }));
  }

  const bidAmount = parseFloat(amount);
  if (isNaN(bidAmount) || bidAmount < 1) {
    return ws.send(JSON.stringify({ type: "BID_REJECTED", reason: "Minimum bid is 1 point" }));
  }

  // Determine current high bid (committed DB bids + in-window bids)
  const { rows: highRows } = await pool.query(
    "SELECT MAX(amount) as max FROM bids WHERE item_id=$1", [itemId]
  );
  const window = activeBidWindows[itemId];
  let currentHigh = parseFloat(highRows[0]?.max || 0);
  if (window) {
    for (const [, info] of window.activeBidders) {
      if (info.amount > currentHigh) currentHigh = info.amount;
    }
  }

  if (bidAmount <= currentHigh) {
    return ws.send(JSON.stringify({
      type: "BID_REJECTED",
      reason: `Bid must exceed current high of ₹${currentHigh}`
    }));
  }

  // Check user balance from DB (source of truth)
  const { rows: userRows } = await pool.query("SELECT points FROM users WHERE id=$1", [ws.userId]);
  const availablePoints = parseFloat(userRows[0]?.points || 0);
  if (bidAmount > availablePoints) {
    return ws.send(JSON.stringify({
      type: "BID_REJECTED",
      reason: `Insufficient points (have ${availablePoints.toFixed(0)} pts)`
    }));
  }

  // Refund previous bid for this user on this item if they had one in the window
  if (window?.activeBidders?.has(String(ws.userId))) {
    const prev = window.activeBidders.get(String(ws.userId));
    await pool.query("UPDATE users SET points = points + $1 WHERE id=$2", [prev.amount, ws.userId]);
  }

  // Deduct new bid amount
  await pool.query("UPDATE users SET points = points - $1 WHERE id=$2", [bidAmount, ws.userId]);
  const { rows: updated } = await pool.query("SELECT points FROM users WHERE id=$1", [ws.userId]);
  ws.send(JSON.stringify({ type: "POINTS_UPDATE", data: { points: updated[0].points } }));

  // Register or update bid window
  if (!activeBidWindows[itemId]) activeBidWindows[itemId] = { activeBidders: new Map() };

  // Reset grace timer on new bid
  if (activeBidWindows[itemId].graceTimer) {
    clearTimeout(activeBidWindows[itemId].graceTimer);
    activeBidWindows[itemId].graceTimer = null;
  }

  activeBidWindows[itemId].activeBidders.set(String(ws.userId), {
    userName: ws.userName, amount: bidAmount
  });

  // Persist to DB and update item's provisional winner
  await pool.query("INSERT INTO bids(item_id, user_id, amount) VALUES($1, $2, $3)", [itemId, ws.userId, bidAmount]);
  await pool.query("UPDATE items SET winner_id=$1, winning_bid=$2 WHERE id=$3", [ws.userId, bidAmount, itemId]);

  broadcast(roomId, {
    type: "BID_PLACED",
    data: { itemId, userId: ws.userId, userName: ws.userName, amount: bidAmount }
  });
  broadcastBidderList(roomId, itemId);
  await broadcastLeaderboard(roomId);
}

async function handleWithdrawBid(ws, msg) {
  const { itemId } = msg;
  const roomId = ws.roomId;

  const window = activeBidWindows[itemId];
  if (!window?.activeBidders?.has(String(ws.userId))) {
    return ws.send(JSON.stringify({ type: "ERROR", reason: "No active bid to withdraw" }));
  }

  const { rows: item } = await pool.query("SELECT * FROM items WHERE id=$1", [itemId]);
  if (!item[0] || item[0].status !== "active") {
    return ws.send(JSON.stringify({ type: "ERROR", reason: "Item not active" }));
  }

  const prevBid = window.activeBidders.get(String(ws.userId));
  await pool.query("UPDATE users SET points = points + $1 WHERE id=$2", [prevBid.amount, ws.userId]);
  const { rows: updated } = await pool.query("SELECT points FROM users WHERE id=$1", [ws.userId]);
  ws.send(JSON.stringify({ type: "POINTS_UPDATE", data: { points: updated[0].points } }));

  window.activeBidders.delete(String(ws.userId));

  broadcast(roomId, {
    type: "BID_WITHDRAWN",
    data: { itemId, userId: ws.userId, userName: ws.userName }
  });
  broadcastBidderList(roomId, itemId);
  await broadcastLeaderboard(roomId);

  const remaining = window.activeBidders.size;

  if (remaining === 1) {
    const [[winnerId, winnerInfo]] = [...window.activeBidders.entries()];
    broadcast(roomId, {
      type: "LAST_BIDDER_REMAINING",
      data: {
        itemId,
        userId: winnerId,
        userName: winnerInfo.userName,
        amount: winnerInfo.amount,
        graceSecs: 5
      }
    });

    if (window.graceTimer) clearTimeout(window.graceTimer);
    window.graceTimer = setTimeout(async () => {
      const w = activeBidWindows[itemId];
      if (!w || w.activeBidders.size !== 1) return;
      const { rows: check } = await pool.query("SELECT status FROM items WHERE id=$1", [itemId]);
      if (check[0]?.status !== "active") return;
      await finalizeItem(itemId, roomId, parseInt(winnerId), winnerInfo.userName, winnerInfo.amount);
    }, 5000);

  } else if (remaining === 0) {
    if (window.graceTimer) clearTimeout(window.graceTimer);
    delete activeBidWindows[itemId];

    const { rows: maxBid } = await pool.query(
      "SELECT user_id, amount FROM bids WHERE item_id=$1 ORDER BY amount DESC LIMIT 1", [itemId]
    );
    if (maxBid[0]) {
      const { rows: wUser } = await pool.query("SELECT name FROM users WHERE id=$1", [maxBid[0].user_id]);
      await finalizeItem(itemId, roomId, maxBid[0].user_id, wUser[0]?.name, maxBid[0].amount);
    } else {
      await pool.query(
        "UPDATE items SET status='finished', winner_id=NULL, winning_bid=NULL, bidding_end=NOW() WHERE id=$1",
        [itemId]
      );
      const { rows: ended } = await pool.query("SELECT * FROM items WHERE id=$1", [itemId]);
      broadcast(roomId, { type: "ITEM_ENDED", data: { ...ended[0], winner_name: null } });
      await broadcastLeaderboard(roomId);
    }
  }
}

function broadcastBidderList(roomId, itemId) {
  const window = activeBidWindows[itemId];
  const bidders = window
    ? [...window.activeBidders.entries()].map(([uid, info]) => ({
      userId: uid, userName: info.userName, amount: info.amount
    }))
    : [];
  bidders.sort((a, b) => b.amount - a.amount);
  broadcast(roomId, { type: "BIDDER_LIST", data: { itemId, bidders } });
}

async function finalizeItem(itemId, roomId, winnerId, winnerName, winningBid) {
  if (activeBidWindows[itemId]) {
    if (activeBidWindows[itemId].graceTimer) clearTimeout(activeBidWindows[itemId].graceTimer);
    delete activeBidWindows[itemId];
  }

  await pool.query(
    "UPDATE items SET status='finished', winner_id=$1, winning_bid=$2, bidding_end=NOW() WHERE id=$3",
    [winnerId, winningBid, itemId]
  );
  const { rows: item } = await pool.query("SELECT * FROM items WHERE id=$1", [itemId]);

  await pool.query(
    `UPDATE room_participants SET total_spent=total_spent+$1, items_won=items_won+1
     WHERE room_id=$2 AND user_id=$3`,
    [winningBid, roomId, winnerId]
  );

  broadcast(roomId, { type: "ITEM_ENDED", data: { ...item[0], winner_name: winnerName } });
  await broadcastLeaderboard(roomId);

  // Send winner email non-blockingly
  sendWinnerEmail(winnerId, itemId, winningBid).catch(e =>
    console.error("Winner email error:", e.message)
  );
}

// ─── ADMIN HANDLERS ────────────────────────────────────────────────────────
async function handleStartItem(ws, msg) {
  if (ws.userRole !== "admin") return;
  const { itemId } = msg;

  const { rows: active } = await pool.query(
    "SELECT id FROM items WHERE room_id=$1 AND status='active'", [ws.roomId]
  );
  if (active.length > 0) {
    return ws.send(JSON.stringify({ type: "ERROR", reason: "Another item is currently active." }));
  }

  await pool.query("UPDATE items SET status='active', bidding_start=NOW() WHERE id=$1", [itemId]);
  await pool.query("UPDATE rooms SET status='active' WHERE id=$1", [ws.roomId]);
  activeBidWindows[itemId] = { activeBidders: new Map() };

  const { rows } = await pool.query("SELECT * FROM items WHERE id=$1", [itemId]);
  broadcast(ws.roomId, { type: "ITEM_STARTED", data: rows[0] });
  await broadcastLeaderboard(ws.roomId);
}

async function handleEndItem(ws, msg) {
  if (ws.userRole !== "admin") return;
  const { itemId } = msg;
  const roomId = ws.roomId;

  const { rows: item } = await pool.query("SELECT status FROM items WHERE id=$1", [itemId]);
  if (!item[0] || item[0].status !== "active") return;

  const window = activeBidWindows[itemId];

  if (window && window.activeBidders.size > 0) {
    let topId = null, topName = null, topAmt = 0;
    for (const [uid, info] of window.activeBidders.entries()) {
      if (info.amount > topAmt) { topAmt = info.amount; topId = uid; topName = info.userName; }
    }
    // Refund all non-winners
    for (const [uid, info] of window.activeBidders.entries()) {
      if (uid !== topId) {
        await pool.query("UPDATE users SET points = points + $1 WHERE id=$2", [info.amount, uid]);
        const refWs = [...(roomClients[roomId] || [])].find(c => String(c.userId) === uid);
        if (refWs) {
          const { rows: r } = await pool.query("SELECT points FROM users WHERE id=$1", [uid]);
          refWs.send(JSON.stringify({ type: "POINTS_UPDATE", data: { points: r[0].points } }));
        }
      }
    }
    await finalizeItem(itemId, roomId, parseInt(topId), topName, topAmt);
  } else {
    if (window) {
      if (window.graceTimer) clearTimeout(window.graceTimer);
      delete activeBidWindows[itemId];
    }
    const { rows: maxBid } = await pool.query(
      `SELECT b.user_id, b.amount, u.name FROM bids b
       JOIN users u ON u.id=b.user_id
       WHERE b.item_id=$1 ORDER BY b.amount DESC LIMIT 1`,
      [itemId]
    );
    if (maxBid[0]) {
      await finalizeItem(itemId, roomId, maxBid[0].user_id, maxBid[0].name, maxBid[0].amount);
    } else {
      await pool.query(
        "UPDATE items SET status='finished', winner_id=NULL, winning_bid=NULL, bidding_end=NOW() WHERE id=$1",
        [itemId]
      );
      const { rows: ended } = await pool.query("SELECT * FROM items WHERE id=$1", [itemId]);
      broadcast(roomId, { type: "ITEM_ENDED", data: { ...ended[0], winner_name: null } });
      await broadcastLeaderboard(roomId);
    }
  }
}

async function handleRevealPrices(ws, msg) {
  if (ws.userRole !== "admin") return;
  const { roomId } = msg;

  await pool.query("UPDATE items SET revealed=TRUE WHERE room_id=$1", [roomId]);
  await pool.query("UPDATE rooms SET status='finished' WHERE id=$1", [roomId]);

  const { rows: items } = await pool.query(
    "SELECT * FROM items WHERE room_id=$1 ORDER BY display_order", [roomId]
  );
  broadcast(roomId, { type: "PRICES_REVEALED", data: { items } });

  // Broadcast final leaderboard after reveal so net_worth is accurate
  await broadcastLeaderboard(roomId);

  // Send emails non-blockingly — errors logged but don't crash the server
  sendLeaderboardEmail(roomId).catch(e =>
    console.error("Leaderboard email failed:", e.message, e.stack)
  );
}

// ─── LEADERBOARD ───────────────────────────────────────────────────────────
async function getLeaderboard(roomId) {
  const { rows: room } = await pool.query("SELECT status FROM rooms WHERE id=$1", [roomId]);
  const isFinished = room[0]?.status === "finished";

  const q = isFinished
    ? `SELECT u.id, u.name, rp.total_spent, rp.items_won,
              (10000 - rp.total_spent + COALESCE((
                SELECT SUM(actual_price) FROM items WHERE room_id=$1 AND winner_id=u.id
              ), 0)) as net_worth
       FROM room_participants rp
       JOIN users u ON u.id = rp.user_id
       WHERE rp.room_id=$1 AND rp.is_spectator=FALSE AND u.role != 'admin'
       ORDER BY net_worth DESC LIMIT 10`
    : `SELECT u.id, u.name, rp.total_spent, rp.items_won,
              (10000 - rp.total_spent) as net_worth
       FROM room_participants rp
       JOIN users u ON u.id = rp.user_id
       WHERE rp.room_id=$1 AND rp.is_spectator=FALSE AND u.role != 'admin'
       ORDER BY net_worth DESC LIMIT 10`;

  const { rows } = await pool.query(q, [roomId]);
  return rows;
}

async function sendLeaderboard(ws, roomId) {
  ws.send(JSON.stringify({ type: "LEADERBOARD", data: await getLeaderboard(roomId) }));
}

async function broadcastLeaderboard(roomId) {
  const data = await getLeaderboard(roomId);
  broadcast(roomId, { type: "LEADERBOARD", data });
}

// ─── EMAIL: WINNER ─────────────────────────────────────────────────────────
async function sendWinnerEmail(winnerId, itemId, amount) {
  try {
    const { rows: user } = await pool.query("SELECT email, name FROM users WHERE id=$1", [winnerId]);
    const { rows: item } = await pool.query("SELECT name, room_id FROM items WHERE id=$1", [itemId]);
    if (!user[0] || !item[0]) return;

    const from = process.env.EMAIL_FROM || process.env.SMTP_USER || process.env.EMAIL_USER;

    const html = `
      <div style="font-family:Arial,sans-serif;background:#0f0f0f;color:#f0f0f0;padding:40px;border-radius:8px;max-width:500px;border:1px solid #333;">
        <h1 style="color:#f5c518;font-size:32px;margin:0 0 16px;">You Won! 🏆</h1>
        <p style="font-size:17px;color:#ccc;">Congratulations, <strong style="color:#fff;">${escapeHtml(user[0].name)}</strong>!</p>
        <div style="background:#1a1a1a;border:1px solid #333;border-radius:6px;padding:20px;margin:24px 0;">
          <div style="font-size:12px;color:#888;letter-spacing:2px;font-family:monospace;">ITEM WON</div>
          <div style="font-size:24px;color:#fff;font-weight:bold;margin-top:6px;">${escapeHtml(item[0].name)}</div>
          <div style="font-size:12px;color:#888;letter-spacing:2px;font-family:monospace;margin-top:16px;">YOUR WINNING BID</div>
          <div style="font-size:32px;color:#f5c518;font-weight:bold;margin-top:6px;">₹${parseFloat(amount).toFixed(2)}</div>
        </div>
        <p style="color:#999;font-size:14px;">The actual price will be revealed by the admin. Check the arena for final results!</p>
        <p style="color:#666;font-size:12px;margin-top:20px;">— BIDArena</p>
      </div>`;

    await sendMailWithRetry({
      from,
      to: user[0].email,
      subject: `🏆 You won "${escapeHtml(item[0].name)}"! — BIDArena`,
      html,
    });
  } catch (err) {
    console.error("sendWinnerEmail error:", err.message);
  }
}

// ─── EMAIL: LEADERBOARD / RESULTS ──────────────────────────────────────────
async function sendLeaderboardEmail(roomId) {
  console.log(`📧 Starting leaderboard emails for room ${roomId}…`);

  const from = process.env.EMAIL_FROM || process.env.SMTP_USER || process.env.EMAIL_USER;
  if (!from) {
    console.warn("⚠️  EMAIL_FROM not set — skipping leaderboard emails");
    return;
  }

  // Fetch all non-admin, non-spectator participants
  const { rows: participants } = await pool.query(
    `SELECT u.id, u.email, u.name
     FROM room_participants rp
     JOIN users u ON u.id = rp.user_id
     WHERE rp.room_id=$1
       AND rp.is_spectator = FALSE
       AND u.role != 'admin'`,
    [roomId]
  );

  if (!participants.length) {
    console.log("📧 No participants to email for room", roomId);
    return;
  }

  console.log(`📧 Sending results to ${participants.length} participant(s)…`);

  const { rows: room } = await pool.query("SELECT name FROM rooms WHERE id=$1", [roomId]);
  const roomName = room[0]?.name || "BIDArena Room";

  const { rows: items } = await pool.query(
    `SELECT id, name, actual_price, winner_id, winning_bid
     FROM items
     WHERE room_id=$1 AND status='finished'
     ORDER BY display_order`,
    [roomId]
  );

  // Top-5 leaderboard for the email footer
  const { rows: profitBoard } = await pool.query(
    `SELECT u.name,
            rp.items_won,
            rp.total_spent,
            (10000 - rp.total_spent + COALESCE((
              SELECT SUM(i2.actual_price)
              FROM items i2
              WHERE i2.room_id=$1 AND i2.winner_id=u.id
            ), 0)) AS net_worth
     FROM room_participants rp
     JOIN users u ON u.id = rp.user_id
     WHERE rp.room_id=$1
       AND rp.is_spectator = FALSE
       AND u.role != 'admin'
     ORDER BY net_worth DESC
     LIMIT 5`,
    [roomId]
  );

  const medals = ["🥇", "🥈", "🥉", "4️⃣", "5️⃣"];

  const top5HTML = profitBoard.length
    ? profitBoard.map((r, i) => `
        <tr style="border-bottom:1px solid #2a2a2a;">
          <td style="padding:12px 16px;font-size:18px;">${medals[i]}</td>
          <td style="padding:12px 16px;color:#f0f0f0;font-size:15px;">${escapeHtml(r.name)}</td>
          <td style="padding:12px 16px;color:#aaa;font-size:14px;">${r.items_won}</td>
          <td style="padding:12px 16px;color:#f5c518;font-size:14px;font-family:monospace;">₹${parseFloat(r.total_spent).toFixed(2)}</td>
          <td style="padding:12px 16px;font-size:14px;font-family:monospace;font-weight:bold;color:#f5c518;">₹${parseFloat(r.net_worth).toFixed(2)}</td>
        </tr>`).join("")
    : `<tr><td colspan="5" style="padding:16px;color:#888;">No winners this round</td></tr>`;

  // Build a winner-name lookup from the leaderboard rows we already have
  const winnerNameMap = {};
  profitBoard.forEach(r => winnerNameMap[String(r.id)] = r.name);

  // Send one email per participant (sequentially to avoid hammering SMTP)
  let sent = 0;
  for (const p of participants) {
    const myItems = items.filter(i => String(i.winner_id) === String(p.id));
    const totalSpent  = myItems.reduce((s, i) => s + parseFloat(i.winning_bid  || 0), 0);
    const totalActual = myItems.reduce((s, i) => s + parseFloat(i.actual_price || 0), 0);
    const totalProfit = totalActual - totalSpent;
    const pnlColor = totalProfit >= 0 ? "#4ade80" : "#f87171";

    const myItemsHTML = myItems.length
      ? myItems.map(i => {
          const diff = parseFloat(i.actual_price || 0) - parseFloat(i.winning_bid || 0);
          const diffColor = diff >= 0 ? "#4ade80" : "#f87171";
          return `
            <tr style="border-bottom:1px solid #2a2a2a;">
              <td style="padding:12px 16px;color:#f0f0f0;font-size:15px;">${escapeHtml(i.name)}</td>
              <td style="padding:12px 16px;color:#f5c518;font-family:monospace;font-size:14px;">₹${parseFloat(i.winning_bid).toFixed(2)}</td>
              <td style="padding:12px 16px;color:#ccc;font-family:monospace;font-size:14px;">₹${parseFloat(i.actual_price).toFixed(2)}</td>
              <td style="padding:12px 16px;font-family:monospace;font-size:14px;font-weight:bold;color:${diffColor};">
                ${diff >= 0 ? "+" : ""}₹${diff.toFixed(2)}
              </td>
            </tr>`;
        }).join("")
      : `<tr><td colspan="4" style="padding:16px;color:#888;font-size:14px;">You didn't win any items this round.</td></tr>`;

    const summarySection = myItems.length ? `
      <div style="margin-top:10px;padding:14px 16px;background:#1a1a1a;border:1px solid #333;border-radius:4px;display:flex;justify-content:space-between;font-family:monospace;font-size:14px;">
        <span style="color:#ccc;">Total spent: <strong style="color:#f5c518;">₹${totalSpent.toFixed(2)}</strong></span>
        <span style="color:#ccc;">Net P&amp;L: <strong style="color:${pnlColor};">${totalProfit >= 0 ? "+" : ""}₹${totalProfit.toFixed(2)}</strong></span>
      </div>` : "";

    const html = `<!DOCTYPE html>
<html lang="en">
<body style="margin:0;background:#080808;">
<div style="font-family:Arial,sans-serif;background:#111;color:#f0f0f0;max-width:660px;margin:32px auto;border:1px solid #333;border-radius:8px;overflow:hidden;">

  <!-- Header -->
  <div style="background:#111;padding:32px 40px;border-bottom:3px solid #f5c518;">
    <div style="font-size:34px;font-weight:900;color:#f5c518;letter-spacing:5px;font-family:monospace;">BIDARENA</div>
    <div style="font-size:13px;color:#888;letter-spacing:3px;margin-top:6px;font-family:monospace;">FINAL RESULTS — ${escapeHtml(roomName)}</div>
  </div>

  <!-- Greeting -->
  <div style="padding:32px 40px 0;">
    <p style="font-size:20px;color:#ccc;margin:0 0 6px;">Hey <strong style="color:#fff;">${escapeHtml(p.name)}</strong> 👋</p>
    <p style="font-size:15px;color:#999;margin:0 0 32px;">The auction has ended. Here's your personal scorecard:</p>
  </div>

  <!-- My Items -->
  <div style="padding:0 40px 32px;">
    <div style="font-size:12px;color:#888;letter-spacing:3px;margin-bottom:12px;font-family:monospace;">YOUR ITEMS</div>
    <table style="width:100%;border-collapse:collapse;background:#1a1a1a;border-radius:6px;overflow:hidden;">
      <thead>
        <tr style="background:#222;border-bottom:1px solid #333;">
          <th style="padding:12px 16px;text-align:left;color:#999;font-size:12px;letter-spacing:2px;font-family:monospace;">ITEM</th>
          <th style="padding:12px 16px;text-align:left;color:#999;font-size:12px;letter-spacing:2px;font-family:monospace;">YOUR BID</th>
          <th style="padding:12px 16px;text-align:left;color:#999;font-size:12px;letter-spacing:2px;font-family:monospace;">ACTUAL</th>
          <th style="padding:12px 16px;text-align:left;color:#999;font-size:12px;letter-spacing:2px;font-family:monospace;">P&amp;L</th>
        </tr>
      </thead>
      <tbody>${myItemsHTML}</tbody>
    </table>
    ${summarySection}
  </div>

  <!-- Top 5 Leaderboard -->
  <div style="padding:0 40px 40px;">
    <div style="font-size:12px;color:#888;letter-spacing:3px;margin-bottom:12px;font-family:monospace;">🏆 TOP 5 LEADERBOARD</div>
    <table style="width:100%;border-collapse:collapse;background:#1a1a1a;border-radius:6px;overflow:hidden;">
      <thead>
        <tr style="background:#222;border-bottom:1px solid #333;">
          <th style="padding:12px 16px;text-align:left;color:#999;font-size:12px;font-family:monospace;">#</th>
          <th style="padding:12px 16px;text-align:left;color:#999;font-size:12px;font-family:monospace;">PLAYER</th>
          <th style="padding:12px 16px;text-align:left;color:#999;font-size:12px;font-family:monospace;">ITEMS WON</th>
          <th style="padding:12px 16px;text-align:left;color:#999;font-size:12px;font-family:monospace;">SPENT</th>
          <th style="padding:12px 16px;text-align:left;color:#999;font-size:12px;font-family:monospace;">NET WORTH</th>
        </tr>
      </thead>
      <tbody>${top5HTML}</tbody>
    </table>
  </div>

  <!-- Footer -->
  <div style="padding:20px 40px;background:#0a0a0a;border-top:1px solid #222;font-family:monospace;font-size:12px;color:#555;letter-spacing:2px;">
    THANKS FOR PLAYING BIDARENA
  </div>
</div>
</body>
</html>`;

    const ok = await sendMailWithRetry({
      from,
      to: p.email,
      subject: `BIDArena — "${escapeHtml(roomName)}" Results & Your P&L`,
      html,
    });

    if (ok) sent++;
  }

  console.log(`📧 Leaderboard emails: ${sent}/${participants.length} sent for room ${roomId}`);
}

// Simple HTML escaper for email content (avoid XSS in emails too)
function escapeHtml(str) {
  if (!str) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

module.exports = { setupWebSocket, activeBidWindows };