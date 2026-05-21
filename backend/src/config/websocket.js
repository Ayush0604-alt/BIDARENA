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

// ─── EMAIL ─────────────────────────────────────────────────────────────────
let _transporter = null;

async function initTransporter() {
  const host = process.env.SMTP_HOST || process.env.EMAIL_HOST;
  const port = Number(process.env.SMTP_PORT || process.env.EMAIL_PORT || 587);
  const user = process.env.SMTP_USER || process.env.EMAIL_USER;
  const pass = process.env.SMTP_PASS || process.env.EMAIL_PASS;

  if (!host || !user || !pass) {
    console.warn("⚠️  Email not configured — set SMTP_HOST, SMTP_USER, SMTP_PASS in .env");
    return null;
  }

  const transport = nodemailer.createTransport({
    host, port,
    secure: port === 465,
    auth: { user, pass },
    tls: { rejectUnauthorized: false },
    pool: true,
    maxConnections: 3,
    rateDelta: 1000,
    rateLimit: 3,
  });

  try {
    await transport.verify();
    console.log("✅ SMTP ready —", host);
    return transport;
  } catch (err) {
    console.error("❌ SMTP verify failed:", err.message);
    return null;
  }
}

async function getTransporter() {
  if (_transporter === null) _transporter = await initTransporter();
  return _transporter;
}

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
      if (attempt < retries) await new Promise(r => setTimeout(r, 1000 * attempt));
    }
  }
  return false;
}

// ─── FIX #5: Per-item in-memory lock to prevent race conditions on simultaneous bids ───
// Two buyers hitting PLACE_BID at the same millisecond would both pass the
// `amount > currentHigh` check before either one commits. The lock serialises
// bid processing per item so only one runs at a time.
const itemLocks = new Map();

async function withItemLock(itemId, fn) {
  const prev = itemLocks.get(itemId) || Promise.resolve();
  let resolve;
  const next = new Promise(r => (resolve = r));
  itemLocks.set(itemId, next);
  try {
    await prev;
    return await fn();
  } finally {
    resolve();
    // Clean up the map entry once no further lock is chained to this promise
    if (itemLocks.get(itemId) === next) itemLocks.delete(itemId);
  }
}

// ─── WEBSOCKET SETUP ───────────────────────────────────────────────────────
function setupWebSocket(server) {
  const wss = new WebSocket.Server({ server, path: "/ws" });

  (async () => {
    try {
      await getTransporter().catch(() => {});

      await listenTo("bid_update", async (payload) => {
        const { rows } = await pool.query("SELECT room_id FROM items WHERE id=$1", [payload.item_id]);
        if (rows[0]) broadcast(rows[0].room_id, { type: "BID_UPDATE", data: payload });
      });

      await listenTo("item_update", async (payload) => {
        const { rows } = await pool.query("SELECT room_id FROM items WHERE id=$1", [payload.id]);
        if (rows[0]) broadcast(rows[0].room_id, { type: "ITEM_UPDATE", data: payload });
      });

      await listenTo("db_notifications", async (payload) => {
        if (payload.type === "POINTS_RESET") {
          broadcastAll({ type: "POINTS_RESET" });
          Object.keys(roomClients).forEach(roomId => broadcastLeaderboard(roomId));
        }
      });

    } catch (err) {
      console.error("❌ Failed to set up DB listeners:", err.message);
    }
  })();

  // Heartbeat
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
    ws.userId   = user.id;
    ws.userRole = user.role;
    ws.userName = user.name;
    ws.roomId   = null;
    ws.tokenExp = user.exp;

    ws.on("message", async (raw) => {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }

      if (ws.tokenExp && ws.tokenExp * 1000 - Date.now() < 3600000) {
        ws.send(JSON.stringify({ type: "REAUTH_REQUIRED", reason: "Token expiring soon" }));
      }

      switch (msg.type) {
        case "JOIN_ROOM":           await handleJoinRoom(ws, msg.roomId); break;
        case "PLACE_BID":           await handlePlaceBid(ws, msg); break;
        case "ADMIN_START_ITEM":    await handleStartItem(ws, msg); break;
        case "ADMIN_END_ITEM":      await handleEndItem(ws, msg); break;
        case "ADMIN_REVEAL_PRICES": await handleRevealPrices(ws, msg); break;
        case "GET_LEADERBOARD":     await sendLeaderboard(ws, msg.roomId || ws.roomId); break;
        case "PING":                ws.send(JSON.stringify({ type: "PONG" })); break;
      }
    });

    // ─── FIX #3: Reset room-scoped points on disconnect ──────────────────────
    // When a buyer leaves, restore their points to 10,000 so they start fresh
    // if they rejoin later. Only applies to buyers (admins have no room points).
    ws.on("close", async () => {
      if (ws.roomId && roomClients[ws.roomId]) {
        roomClients[ws.roomId].delete(ws);
      }

      if (ws.roomId && ws.userRole !== "admin") {
        try {
          await pool.query(
            "UPDATE room_player_points SET points = 10000 WHERE room_id=$1 AND user_id=$2",
            [ws.roomId, ws.userId]
          );
        } catch (err) {
          console.error("Failed to reset points on disconnect:", err.message);
        }
      }
    });

    ws.on("error", (err) => console.error("WS client error:", err.message));
  });

  return wss;
}

// ─── JOIN ROOM ─────────────────────────────────────────────────────────────
async function handleJoinRoom(ws, roomId) {
  if (ws.roomId && roomClients[ws.roomId]) roomClients[ws.roomId].delete(ws);
  ws.roomId = roomId;
  if (!roomClients[roomId]) roomClients[roomId] = new Set();

  // Close duplicate connections for same user
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

  // ── ROOM-SCOPED POINTS ────────────────────────────────────────────────────
  // Buyers get fresh 10,000 points each time they enter a room.
  // Points exist only within this room session — they are NOT stored on the
  // users table permanently; we use a separate room_player_points table.
  if (ws.userRole !== "admin") {
    const isSpectator = room[0].status !== "waiting";

    await pool.query(
      `INSERT INTO room_participants(room_id, user_id, is_spectator)
       VALUES($1, $2, $3) ON CONFLICT DO NOTHING`,
      [roomId, ws.userId, isSpectator]
    );

    // Allocate 10,000 room-scoped points (idempotent — only on first join)
    await pool.query(
      `INSERT INTO room_player_points(room_id, user_id, points)
       VALUES($1, $2, 10000)
       ON CONFLICT (room_id, user_id) DO NOTHING`,
      [roomId, ws.userId]
    );

    // Send their current room-points to the client
    const { rows: pts } = await pool.query(
      "SELECT points FROM room_player_points WHERE room_id=$1 AND user_id=$2",
      [roomId, ws.userId]
    );
    ws.send(JSON.stringify({
      type: "ROOM_POINTS",
      data: { points: parseFloat(pts[0]?.points || 10000) }
    }));
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

  // Send current countdown state if an item is actively counting down
  const activeCountdowns = {};
  for (const [itemId, w] of Object.entries(activeBidWindows)) {
    activeCountdowns[itemId] = {
      highBidderId: w.highBidderId,
      highBidderName: w.highBidderName,
      amount: w.amount,
      startedAt: w.startedAt,
      durationSecs: BID_WINDOW_SECS,
    };
  }

  ws.send(JSON.stringify({
    type: "ROOM_SNAPSHOT",
    data: {
      room: room[0],
      items,
      topBids,
      isSpectator: ws.isSpectator,
      activeCountdowns,
      maxPlayers: room[0].max_players || null
    }
  }));

  await sendLeaderboard(ws, roomId);
  broadcast(roomId, { type: "USER_JOINED", data: { userId: ws.userId, name: ws.userName } });
}

// ─── BIDDING MODEL ─────────────────────────────────────────────────────────
//
// When a bid is placed on an active item:
//   1. Validate amount > current high bid
//   2. Deduct points from new bidder (room-scoped)
//   3. Refund previous high bidder (room-scoped)
//   4. Reset 15-second countdown timer
//   5. If no new bid arrives within 15s → auto-finalize, winner declared
//   6. Admin can still force-end at any time
//
// activeBidWindows: itemId => { highBidderId, highBidderName, amount, timeout, startedAt }
// ─────────────────────────────────────────────────────────────────────────────

const BID_WINDOW_SECS = 15;
const activeBidWindows = {};
const bidRateLimits = {};

async function getRoomPoints(roomId, userId) {
  const { rows } = await pool.query(
    "SELECT points FROM room_player_points WHERE room_id=$1 AND user_id=$2",
    [roomId, userId]
  );
  return parseFloat(rows[0]?.points || 0);
}

async function deductRoomPoints(roomId, userId, amount) {
  await pool.query(
    "UPDATE room_player_points SET points = points - $1 WHERE room_id=$2 AND user_id=$3",
    [amount, roomId, userId]
  );
  const { rows } = await pool.query(
    "SELECT points FROM room_player_points WHERE room_id=$1 AND user_id=$2",
    [roomId, userId]
  );
  return parseFloat(rows[0]?.points || 0);
}

async function refundRoomPoints(roomId, userId, amount) {
  await pool.query(
    "UPDATE room_player_points SET points = points + $1 WHERE room_id=$2 AND user_id=$3",
    [amount, roomId, userId]
  );
  const { rows } = await pool.query(
    "SELECT points FROM room_player_points WHERE room_id=$1 AND user_id=$2",
    [roomId, userId]
  );
  return parseFloat(rows[0]?.points || 0);
}

function notifyPoints(roomId, userId, points) {
  const clients = roomClients[roomId] || new Set();
  for (const ws of clients) {
    if (String(ws.userId) === String(userId) && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "ROOM_POINTS", data: { points } }));
    }
  }
}

async function handlePlaceBid(ws, msg) {
  // FIX #5: Wrap entire bid logic in a per-item lock to serialise concurrent bids.
  // Without this, two buyers hitting PLACE_BID at the same millisecond can both
  // pass the `amount > currentHigh` check before either one commits to the DB.
  return withItemLock(msg.itemId, async () => {

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

    // Rate limiting
    const now = Date.now();
    if (!bidRateLimits[ws.userId] || now - bidRateLimits[ws.userId].firstHit > 10000) {
      bidRateLimits[ws.userId] = { count: 1, firstHit: now };
    } else if (++bidRateLimits[ws.userId].count > 8) {
      return ws.send(JSON.stringify({ type: "BID_REJECTED", reason: "Too many bids — please wait." }));
    }

    const bidAmount = parseFloat(amount);

    // FIX #4: Validate bid is a finite number and within the allowed range.
    // This catches floats like 9999999999, NaN, Infinity, etc.
    if (!Number.isFinite(bidAmount) || bidAmount < 1 || bidAmount > 10000) {
      return ws.send(JSON.stringify({
        type: "BID_REJECTED",
        reason: "Bid must be between 1 and 10,000 points"
      }));
    }

    // Current high bid
    const window = activeBidWindows[itemId];
    const currentHigh = window?.amount || 0;

    if (bidAmount <= currentHigh) {
      return ws.send(JSON.stringify({
        type: "BID_REJECTED",
        reason: `Bid must exceed current high of ₹${currentHigh}`
      }));
    }

    // Can't outbid yourself
    if (window && String(window.highBidderId) === String(ws.userId)) {
      return ws.send(JSON.stringify({
        type: "BID_REJECTED",
        reason: "You are already the highest bidder"
      }));
    }

    // Check room-scoped points
    const availablePoints = await getRoomPoints(roomId, ws.userId);
    if (bidAmount > availablePoints) {
      return ws.send(JSON.stringify({
        type: "BID_REJECTED",
        reason: `Insufficient points (you have ₹${availablePoints.toFixed(0)} pts in this room)`
      }));
    }

    // Refund previous high bidder
    if (window && window.highBidderId) {
      const refunded = await refundRoomPoints(roomId, window.highBidderId, window.amount);
      notifyPoints(roomId, window.highBidderId, refunded);
      // Clear the old countdown
      if (window.timeout) clearTimeout(window.timeout);
    }

    // Deduct new bidder
    const newPoints = await deductRoomPoints(roomId, ws.userId, bidAmount);
    notifyPoints(roomId, ws.userId, newPoints);

    // Record bid in DB
    await pool.query(
      "INSERT INTO bids(item_id, user_id, amount) VALUES($1, $2, $3)",
      [itemId, ws.userId, bidAmount]
    );
    await pool.query(
      "UPDATE items SET winner_id=$1, winning_bid=$2 WHERE id=$3",
      [ws.userId, bidAmount, itemId]
    );

    const startedAt = Date.now();

    // Start / reset 15-second countdown
    const timeout = setTimeout(async () => {
      // Timer fired — no new bid came in — auto-close
      const w = activeBidWindows[itemId];
      if (!w) return; // already finalized
      const { rows: check } = await pool.query("SELECT status FROM items WHERE id=$1", [itemId]);
      if (check[0]?.status !== "active") return;
      await finalizeItem(itemId, roomId, parseInt(w.highBidderId), w.highBidderName, w.amount, "timeout");
    }, BID_WINDOW_SECS * 1000);

    activeBidWindows[itemId] = {
      highBidderId: String(ws.userId),
      highBidderName: ws.userName,
      amount: bidAmount,
      timeout,
      startedAt,
    };

    // Broadcast to all in room
    broadcast(roomId, {
      type: "BID_PLACED",
      data: {
        itemId,
        userId: ws.userId,
        userName: ws.userName,
        amount: bidAmount,
        countdownSecs: BID_WINDOW_SECS,
        startedAt,
      }
    });

    await broadcastLeaderboard(roomId);

  }); // end withItemLock
}

// ─── FINALIZE ──────────────────────────────────────────────────────────────
async function finalizeItem(itemId, roomId, winnerId, winnerName, winningBid, reason = "admin") {
  const w = activeBidWindows[itemId];
  if (w) {
    if (w.timeout) clearTimeout(w.timeout);
    delete activeBidWindows[itemId];
  }

  await pool.query(
    "UPDATE items SET status='finished', winner_id=$1, winning_bid=$2, bidding_end=NOW() WHERE id=$3",
    [winnerId, winningBid, itemId]
  );
  const { rows: item } = await pool.query("SELECT * FROM items WHERE id=$1", [itemId]);

  // Update room_participants totals
  await pool.query(
    `UPDATE room_participants SET total_spent=total_spent+$1, items_won=items_won+1
     WHERE room_id=$2 AND user_id=$3`,
    [winningBid, roomId, winnerId]
  );

  broadcast(roomId, {
    type: "ITEM_ENDED",
    data: { ...item[0], winner_name: winnerName, end_reason: reason }
  });

  await broadcastLeaderboard(roomId);
  sendWinnerEmail(winnerId, itemId, winningBid).catch(e => console.error("Winner email:", e.message));
}

// ─── ADMIN: START ITEM ─────────────────────────────────────────────────────
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

  const { rows } = await pool.query("SELECT * FROM items WHERE id=$1", [itemId]);
  broadcast(ws.roomId, { type: "ITEM_STARTED", data: rows[0] });
  await broadcastLeaderboard(ws.roomId);
}

// ─── ADMIN: END ITEM ───────────────────────────────────────────────────────
async function handleEndItem(ws, msg) {
  if (ws.userRole !== "admin") return;
  const { itemId } = msg;
  const roomId = ws.roomId;

  const { rows: item } = await pool.query("SELECT status FROM items WHERE id=$1", [itemId]);
  if (!item[0] || item[0].status !== "active") return;

  const window = activeBidWindows[itemId];

  if (window && window.highBidderId) {
    // Finalize with current highest bidder
    await finalizeItem(
      itemId, roomId,
      parseInt(window.highBidderId),
      window.highBidderName,
      window.amount,
      "admin"
    );
  } else {
    // No bids at all — end with no winner
    if (window) { if (window.timeout) clearTimeout(window.timeout); delete activeBidWindows[itemId]; }
    await pool.query(
      "UPDATE items SET status='finished', winner_id=NULL, winning_bid=NULL, bidding_end=NOW() WHERE id=$1",
      [itemId]
    );
    const { rows: ended } = await pool.query("SELECT * FROM items WHERE id=$1", [itemId]);
    broadcast(roomId, { type: "ITEM_ENDED", data: { ...ended[0], winner_name: null, end_reason: "admin" } });
    await broadcastLeaderboard(roomId);
  }
}

// ─── ADMIN: REVEAL PRICES ──────────────────────────────────────────────────
async function handleRevealPrices(ws, msg) {
  if (ws.userRole !== "admin") return;
  const { roomId } = msg;

  await pool.query("UPDATE items SET revealed=TRUE WHERE room_id=$1", [roomId]);
  await pool.query("UPDATE rooms SET status='finished' WHERE id=$1", [roomId]);

  const { rows: items } = await pool.query(
    "SELECT * FROM items WHERE room_id=$1 ORDER BY display_order", [roomId]
  );
  broadcast(roomId, { type: "PRICES_REVEALED", data: { items } });
  await broadcastLeaderboard(roomId);

  sendLeaderboardEmail(roomId).catch(e => console.error("Leaderboard email failed:", e.message));
}

// ─── LEADERBOARD ───────────────────────────────────────────────────────────
async function getLeaderboard(roomId) {
  const { rows: room } = await pool.query("SELECT status FROM rooms WHERE id=$1", [roomId]);
  const isFinished = room[0]?.status === "finished";

  // Use room_player_points as the source of truth for current points balance
  const q = isFinished
    ? `SELECT u.id, u.name, rp.total_spent, rp.items_won,
              COALESCE(rpp.points, 0) + COALESCE((
                SELECT SUM(i.actual_price) FROM items i
                WHERE i.room_id=$1 AND i.winner_id=u.id
              ), 0) AS net_worth
       FROM room_participants rp
       JOIN users u ON u.id = rp.user_id
       LEFT JOIN room_player_points rpp ON rpp.room_id=rp.room_id AND rpp.user_id=u.id
       WHERE rp.room_id=$1 AND rp.is_spectator=FALSE AND u.role!='admin'
       ORDER BY net_worth DESC LIMIT 10`
    : `SELECT u.id, u.name, rp.total_spent, rp.items_won,
              COALESCE(rpp.points, 0) AS net_worth
       FROM room_participants rp
       JOIN users u ON u.id = rp.user_id
       LEFT JOIN room_player_points rpp ON rpp.room_id=rp.room_id AND rpp.user_id=u.id
       WHERE rp.room_id=$1 AND rp.is_spectator=FALSE AND u.role!='admin'
       ORDER BY net_worth DESC LIMIT 10`;

  const { rows } = await pool.query(q, [roomId]);
  return rows;
}

async function sendLeaderboard(ws, roomId) {
  ws.send(JSON.stringify({ type: "LEADERBOARD", data: await getLeaderboard(roomId) }));
}

async function broadcastLeaderboard(roomId) {
  broadcast(roomId, { type: "LEADERBOARD", data: await getLeaderboard(roomId) });
}

// ─── EMAIL: WINNER ─────────────────────────────────────────────────────────
async function sendWinnerEmail(winnerId, itemId, amount) {
  try {
    const { rows: user } = await pool.query("SELECT email, name FROM users WHERE id=$1", [winnerId]);
    const { rows: item } = await pool.query("SELECT name FROM items WHERE id=$1", [itemId]);
    if (!user[0] || !item[0]) return;
    const from = process.env.EMAIL_FROM || process.env.SMTP_USER || process.env.EMAIL_USER;
    await sendMailWithRetry({
      from, to: user[0].email,
      subject: `🏆 You won "${escapeHtml(item[0].name)}"! — BIDArena`,
      html: `
        <div style="font-family:Arial,sans-serif;background:#0f0f0f;color:#f0f0f0;padding:40px;border-radius:8px;max-width:500px;border:1px solid #333;">
          <h1 style="color:#f5c518;font-size:32px;margin:0 0 16px;">You Won! 🏆</h1>
          <p style="font-size:17px;color:#ccc;">Congratulations, <strong style="color:#fff;">${escapeHtml(user[0].name)}</strong>!</p>
          <div style="background:#1a1a1a;border:1px solid #333;border-radius:6px;padding:20px;margin:24px 0;">
            <div style="font-size:12px;color:#888;letter-spacing:2px;font-family:monospace;">ITEM WON</div>
            <div style="font-size:24px;color:#fff;font-weight:bold;margin-top:6px;">${escapeHtml(item[0].name)}</div>
            <div style="font-size:12px;color:#888;letter-spacing:2px;font-family:monospace;margin-top:16px;">YOUR WINNING BID</div>
            <div style="font-size:32px;color:#f5c518;font-weight:bold;margin-top:6px;">₹${parseFloat(amount).toFixed(2)}</div>
          </div>
          <p style="color:#999;font-size:14px;">Actual prices will be revealed by the admin. Check the arena for final results!</p>
        </div>`
    });
  } catch (err) {
    console.error("sendWinnerEmail error:", err.message);
  }
}

// ─── EMAIL: LEADERBOARD ────────────────────────────────────────────────────
async function sendLeaderboardEmail(roomId) {
  console.log(`📧 Starting leaderboard emails for room ${roomId}…`);
  const from = process.env.EMAIL_FROM || process.env.SMTP_USER || process.env.EMAIL_USER;
  if (!from) { console.warn("⚠️  EMAIL_FROM not set"); return; }

  const { rows: participants } = await pool.query(
    `SELECT u.id, u.email, u.name FROM room_participants rp
     JOIN users u ON u.id=rp.user_id
     WHERE rp.room_id=$1 AND rp.is_spectator=FALSE AND u.role!='admin'`,
    [roomId]
  );
  if (!participants.length) { console.log("No participants to email"); return; }

  const { rows: room } = await pool.query("SELECT name FROM rooms WHERE id=$1", [roomId]);
  const roomName = room[0]?.name || "BIDArena Room";

  const { rows: items } = await pool.query(
    `SELECT id, name, actual_price, winner_id, winning_bid FROM items
     WHERE room_id=$1 AND status='finished' ORDER BY display_order`, [roomId]
  );

  const { rows: profitBoard } = await pool.query(
    `SELECT u.name, rp.items_won, rp.total_spent,
            COALESCE(rpp.points,0) + COALESCE((
              SELECT SUM(i2.actual_price) FROM items i2 WHERE i2.room_id=$1 AND i2.winner_id=u.id
            ),0) AS net_worth
     FROM room_participants rp
     JOIN users u ON u.id=rp.user_id
     LEFT JOIN room_player_points rpp ON rpp.room_id=rp.room_id AND rpp.user_id=u.id
     WHERE rp.room_id=$1 AND rp.is_spectator=FALSE AND u.role!='admin'
     ORDER BY net_worth DESC LIMIT 5`,
    [roomId]
  );

  const medals = ["🥇","🥈","🥉","4️⃣","5️⃣"];
  const top5HTML = profitBoard.length
    ? profitBoard.map((r,i) => `
        <tr style="border-bottom:1px solid #2a2a2a;">
          <td style="padding:12px 16px;font-size:18px;">${medals[i]}</td>
          <td style="padding:12px 16px;color:#f0f0f0;font-size:15px;">${escapeHtml(r.name)}</td>
          <td style="padding:12px 16px;color:#aaa;font-size:14px;">${r.items_won}</td>
          <td style="padding:12px 16px;color:#f5c518;font-size:14px;font-family:monospace;">₹${parseFloat(r.total_spent||0).toFixed(2)}</td>
          <td style="padding:12px 16px;font-size:14px;font-family:monospace;font-weight:bold;color:#f5c518;">₹${parseFloat(r.net_worth||0).toFixed(2)}</td>
        </tr>`).join("")
    : `<tr><td colspan="5" style="padding:16px;color:#888;">No winners this round</td></tr>`;

  let sent = 0;
  for (const p of participants) {
    const myItems = items.filter(i => String(i.winner_id) === String(p.id));
    const totalSpent  = myItems.reduce((s,i) => s + parseFloat(i.winning_bid||0), 0);
    const totalActual = myItems.reduce((s,i) => s + parseFloat(i.actual_price||0), 0);
    const totalProfit = totalActual - totalSpent;
    const pc = totalProfit >= 0 ? "#4ade80" : "#f87171";

    const myItemsHTML = myItems.length
      ? myItems.map(i => {
          const diff = parseFloat(i.actual_price||0) - parseFloat(i.winning_bid||0);
          return `
            <tr style="border-bottom:1px solid #2a2a2a;">
              <td style="padding:12px 16px;color:#f0f0f0;font-size:15px;">${escapeHtml(i.name)}</td>
              <td style="padding:12px 16px;color:#f5c518;font-family:monospace;font-size:14px;">₹${parseFloat(i.winning_bid).toFixed(2)}</td>
              <td style="padding:12px 16px;color:#ccc;font-family:monospace;font-size:14px;">₹${parseFloat(i.actual_price).toFixed(2)}</td>
              <td style="padding:12px 16px;font-family:monospace;font-size:14px;font-weight:bold;color:${diff>=0?"#4ade80":"#f87171"};">
                ${diff>=0?"+":""}₹${diff.toFixed(2)}</td>
            </tr>`;
        }).join("")
      : `<tr><td colspan="4" style="padding:16px;color:#888;">You didn't win any items.</td></tr>`;

    const html = `<!DOCTYPE html><html><body style="margin:0;background:#080808;">
<div style="font-family:Arial,sans-serif;background:#111;color:#f0f0f0;max-width:660px;margin:32px auto;border:1px solid #333;border-radius:8px;overflow:hidden;">
  <div style="background:#111;padding:32px 40px;border-bottom:3px solid #f5c518;">
    <div style="font-size:34px;font-weight:900;color:#f5c518;letter-spacing:5px;font-family:monospace;">BIDARENA</div>
    <div style="font-size:13px;color:#888;letter-spacing:3px;margin-top:6px;font-family:monospace;">FINAL RESULTS — ${escapeHtml(roomName)}</div>
  </div>
  <div style="padding:32px 40px 0;">
    <p style="font-size:20px;color:#ccc;margin:0 0 6px;">Hey <strong style="color:#fff;">${escapeHtml(p.name)}</strong> 👋</p>
    <p style="font-size:15px;color:#999;margin:0 0 32px;">The auction has ended. Here's your personal scorecard:</p>
  </div>
  <div style="padding:0 40px 32px;">
    <div style="font-size:12px;color:#888;letter-spacing:3px;margin-bottom:12px;font-family:monospace;">YOUR ITEMS</div>
    <table style="width:100%;border-collapse:collapse;background:#1a1a1a;border-radius:6px;overflow:hidden;">
      <thead><tr style="background:#222;border-bottom:1px solid #333;">
        <th style="padding:12px 16px;text-align:left;color:#999;font-size:12px;font-family:monospace;">ITEM</th>
        <th style="padding:12px 16px;text-align:left;color:#999;font-size:12px;font-family:monospace;">YOUR BID</th>
        <th style="padding:12px 16px;text-align:left;color:#999;font-size:12px;font-family:monospace;">ACTUAL</th>
        <th style="padding:12px 16px;text-align:left;color:#999;font-size:12px;font-family:monospace;">P&amp;L</th>
      </tr></thead>
      <tbody>${myItemsHTML}</tbody>
    </table>
    ${myItems.length ? `
    <div style="margin-top:10px;padding:14px 16px;background:#1a1a1a;border:1px solid #333;border-radius:4px;display:flex;justify-content:space-between;font-family:monospace;font-size:14px;">
      <span style="color:#ccc;">Spent: <strong style="color:#f5c518;">₹${totalSpent.toFixed(2)}</strong></span>
      <span style="color:#ccc;">Net P&amp;L: <strong style="color:${pc};">${totalProfit>=0?"+":""}₹${totalProfit.toFixed(2)}</strong></span>
    </div>` : ""}
  </div>
  <div style="padding:0 40px 40px;">
    <div style="font-size:12px;color:#888;letter-spacing:3px;margin-bottom:12px;font-family:monospace;">🏆 TOP 5 LEADERBOARD</div>
    <table style="width:100%;border-collapse:collapse;background:#1a1a1a;border-radius:6px;overflow:hidden;">
      <thead><tr style="background:#222;border-bottom:1px solid #333;">
        <th style="padding:12px 16px;text-align:left;color:#999;font-size:12px;font-family:monospace;">#</th>
        <th style="padding:12px 16px;text-align:left;color:#999;font-size:12px;font-family:monospace;">PLAYER</th>
        <th style="padding:12px 16px;text-align:left;color:#999;font-size:12px;font-family:monospace;">ITEMS</th>
        <th style="padding:12px 16px;text-align:left;color:#999;font-size:12px;font-family:monospace;">SPENT</th>
        <th style="padding:12px 16px;text-align:left;color:#999;font-size:12px;font-family:monospace;">NET WORTH</th>
      </tr></thead>
      <tbody>${top5HTML}</tbody>
    </table>
  </div>
  <div style="padding:20px 40px;background:#0a0a0a;border-top:1px solid #222;font-family:monospace;font-size:12px;color:#555;letter-spacing:2px;">
    THANKS FOR PLAYING BIDARENA
  </div>
</div></body></html>`;

    const ok = await sendMailWithRetry({ from, to: p.email, subject: `BIDArena — "${escapeHtml(roomName)}" Results & Your P&L`, html });
    if (ok) sent++;
  }
  console.log(`📧 Leaderboard emails: ${sent}/${participants.length} sent`);
}

function escapeHtml(str) {
  if (!str) return "";
  return String(str).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&#39;");
}

module.exports = { setupWebSocket, activeBidWindows };