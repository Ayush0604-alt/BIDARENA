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

function createTransporter() {
  const host = process.env.SMTP_HOST || process.env.EMAIL_HOST;
  const port = Number(process.env.SMTP_PORT || process.env.EMAIL_PORT || 587);
  const user = process.env.SMTP_USER || process.env.EMAIL_USER;
  const pass = process.env.SMTP_PASS || process.env.EMAIL_PASS;

  if (!host || !user || !pass) {
    console.warn("⚠️  Email not configured — set SMTP_HOST, SMTP_USER, SMTP_PASS in .env");
    return null;
  }

  return nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    auth: { user, pass },
    tls: { rejectUnauthorized: false },
  });
}

function setupWebSocket(server) {
  const wss = new WebSocket.Server({ server, path: "/ws" });

  listenTo("bid_update", async (payload) => {
    const { rows } = await pool.query("SELECT room_id FROM items WHERE id=$1", [payload.item_id]);
    if (rows[0]) broadcast(rows[0].room_id, { type: "BID_UPDATE", data: payload });
  });

  listenTo("item_update", async (payload) => {
    const { rows } = await pool.query("SELECT room_id FROM items WHERE id=$1", [payload.id]);
    if (rows[0]) broadcast(rows[0].room_id, { type: "ITEM_UPDATE", data: payload });
  });

  listenTo("db_notifications", (payload) => {
    if (payload.type === "POINTS_RESET") broadcastAll({ type: "POINTS_RESET" });
  });

  wss.on("connection", async (ws, req) => {
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

      if (ws.tokenExp && ws.tokenExp * 1000 - Date.now() < 3600000) {
        ws.send(JSON.stringify({ type: "REAUTH_REQUIRED", reason: "Token expiring soon" }));
      }

      switch (msg.type) {
        case "JOIN_ROOM": await handleJoinRoom(ws, msg.roomId); break;
        case "PLACE_BID": await handlePlaceBid(ws, msg); break;
        case "WITHDRAW_BID": await handleWithdrawBid(ws, msg); break;
        case "ADMIN_START_ITEM": await handleStartItem(ws, msg); break;
        case "ADMIN_END_ITEM": await handleEndItem(ws, msg); break;
        case "ADMIN_REVEAL_PRICES": await handleRevealPrices(ws, msg); break;
        case "GET_LEADERBOARD": await sendLeaderboard(ws, msg.roomId || ws.roomId); break;
      }
    });

    ws.on("close", () => {
      if (ws.roomId && roomClients[ws.roomId]) roomClients[ws.roomId].delete(ws);
    });
  });

  return wss;
}

async function handleJoinRoom(ws, roomId) {
  if (ws.roomId && roomClients[ws.roomId]) roomClients[ws.roomId].delete(ws);
  ws.roomId = roomId;
  if (!roomClients[roomId]) roomClients[roomId] = new Set();

  for (const client of roomClients[roomId]) {
    if (String(client.userId) === String(ws.userId) && client !== ws) {
      client.send(JSON.stringify({ type: "ERROR", reason: "Joined from another tab" }));
      client.close(4009, "Joined from another tab");
      roomClients[roomId].delete(client);
    }
  }
  roomClients[roomId].add(ws);

  const { rows: room } = await pool.query("SELECT * FROM rooms WHERE id=$1", [roomId]);

  // Admin is NEVER a participant — skip inserting them into room_participants
  if (ws.userRole !== "admin") {
    const isSpectator = room[0]?.status !== "waiting";
    await pool.query(
      `INSERT INTO room_participants(room_id, user_id, is_spectator)
       VALUES($1, $2, $3) ON CONFLICT DO NOTHING`,
      [roomId, ws.userId, isSpectator]
    );
  }

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

  // Include current live bidder list for active items
  const activeBidderMap = {};
  for (const [itemId, w] of Object.entries(activeBidWindows)) {
    activeBidderMap[itemId] = [...w.activeBidders.entries()].map(([uid, info]) => ({
      userId: uid, userName: info.userName, amount: info.amount
    }));
  }

  ws.send(JSON.stringify({
    type: "ROOM_SNAPSHOT",
    data: { room: room[0], items, topBids, isSpectator: ws.isSpectator, activeBidderMap }
  }));
  await sendLeaderboard(ws, roomId);
  broadcast(roomId, { type: "USER_JOINED", data: { userId: ws.userId, name: ws.userName } });
}

// ─── BIDDING MODEL ───────────────────────────────────────────────────────────
// Multiple buyers can hold live bids simultaneously on an active item.
// Each buyer can withdraw at any time (points refunded).
// When only 1 bidder remains after a withdrawal → 5-second grace period → auto-close.
// Admin can also force-end (highest active bidder wins, others refunded).
// ─────────────────────────────────────────────────────────────────────────────

// activeBidWindows: itemId => { activeBidders: Map<userId, {userName, amount}> }
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

  // Rate limiting
  const now = Date.now();
  if (!bidRateLimits[ws.userId] || now - bidRateLimits[ws.userId].firstHit > 10000) {
    bidRateLimits[ws.userId] = { count: 1, firstHit: now };
  } else if (++bidRateLimits[ws.userId].count > 5) {
    return ws.send(JSON.stringify({ type: "BID_REJECTED", reason: "Too many bids. Please wait." }));
  }

  if (parseFloat(amount) < 1) {
    return ws.send(JSON.stringify({ type: "BID_REJECTED", reason: "Minimum bid is 1 point" }));
  }

  // Current highest bid among active bidders + DB
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

  if (parseFloat(amount) <= currentHigh) {
    return ws.send(JSON.stringify({
      type: "BID_REJECTED",
      reason: `Bid must exceed current high of ₹${currentHigh}`
    }));
  }

  // Check points
  const { rows: userRows } = await pool.query("SELECT points FROM users WHERE id=$1", [ws.userId]);
  if (parseFloat(amount) > parseFloat(userRows[0]?.points || 0)) {
    return ws.send(JSON.stringify({
      type: "BID_REJECTED",
      reason: `Insufficient points (have ${parseFloat(userRows[0]?.points || 0).toFixed(0)} pts)`
    }));
  }

  // Refund user's previous bid on this item if upgrading
  if (window?.activeBidders?.has(String(ws.userId))) {
    const prev = window.activeBidders.get(String(ws.userId));
    await pool.query("UPDATE users SET points = points + $1 WHERE id=$2", [prev.amount, ws.userId]);
  }

  // Deduct new bid
  await pool.query("UPDATE users SET points = points - $1 WHERE id=$2", [amount, ws.userId]);
  const { rows: updated } = await pool.query("SELECT points FROM users WHERE id=$1", [ws.userId]);
  ws.send(JSON.stringify({ type: "POINTS_UPDATE", data: { points: updated[0].points } }));

  // Register in active bidders
  if (!activeBidWindows[itemId]) activeBidWindows[itemId] = { activeBidders: new Map() };
  activeBidWindows[itemId].activeBidders.set(String(ws.userId), {
    userName: ws.userName, amount: parseFloat(amount)
  });

  // Insert bid record + update item leading bid
  await pool.query("INSERT INTO bids(item_id, user_id, amount) VALUES($1, $2, $3)", [itemId, ws.userId, amount]);
  await pool.query("UPDATE items SET winner_id=$1, winning_bid=$2 WHERE id=$3", [ws.userId, amount, itemId]);

  broadcast(roomId, {
    type: "BID_PLACED",
    data: { itemId, userId: ws.userId, userName: ws.userName, amount: parseFloat(amount) }
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

  // Refund points
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
      data: { itemId, userId: winnerId, userName: winnerInfo.userName, amount: winnerInfo.amount, graceSecs: 5 }
    });
    // 5-second grace: others can jump in
    setTimeout(async () => {
      const w = activeBidWindows[itemId];
      if (!w || w.activeBidders.size !== 1) return;
      const { rows: check } = await pool.query("SELECT status FROM items WHERE id=$1", [itemId]);
      if (check[0]?.status !== "active") return;
      await finalizeItem(itemId, roomId, parseInt(winnerId), winnerInfo.userName, winnerInfo.amount);
    }, 5000);

  } else if (remaining === 0) {
    delete activeBidWindows[itemId];
    // Recalculate highest committed bid from DB
    const { rows: maxBid } = await pool.query(
      "SELECT user_id, amount FROM bids WHERE item_id=$1 ORDER BY amount DESC LIMIT 1", [itemId]
    );
    if (maxBid[0]) {
      const { rows: wUser } = await pool.query("SELECT name FROM users WHERE id=$1", [maxBid[0].user_id]);
      await finalizeItem(itemId, roomId, maxBid[0].user_id, wUser[0]?.name, maxBid[0].amount);
    } else {
      // Truly no bids
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
  // Sort by amount desc
  bidders.sort((a, b) => b.amount - a.amount);
  broadcast(roomId, { type: "BIDDER_LIST", data: { itemId, bidders } });
}

async function finalizeItem(itemId, roomId, winnerId, winnerName, winningBid) {
  if (activeBidWindows[itemId]) delete activeBidWindows[itemId];

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
  sendWinnerEmail(winnerId, itemId, winningBid).catch(e => console.error("Winner email:", e.message));
}

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
}

async function handleEndItem(ws, msg) {
  if (ws.userRole !== "admin") return;
  const { itemId } = msg;
  const roomId = ws.roomId;

  const { rows: item } = await pool.query("SELECT status FROM items WHERE id=$1", [itemId]);
  if (!item[0] || item[0].status !== "active") return;

  const window = activeBidWindows[itemId];

  if (window && window.activeBidders.size > 0) {
    // Find highest bidder
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
    if (window) delete activeBidWindows[itemId];
    await pool.query(
      "UPDATE items SET status='finished', winner_id=NULL, winning_bid=NULL, bidding_end=NOW() WHERE id=$1",
      [itemId]
    );
    const { rows: ended } = await pool.query("SELECT * FROM items WHERE id=$1", [itemId]);
    broadcast(roomId, { type: "ITEM_ENDED", data: { ...ended[0], winner_name: null } });
    await broadcastLeaderboard(roomId);
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
  await sendLeaderboardEmail(roomId);
}

async function sendLeaderboard(ws, roomId) {
  ws.send(JSON.stringify({ type: "LEADERBOARD", data: await getLeaderboard(roomId) }));
}

async function broadcastLeaderboard(roomId) {
  broadcast(roomId, { type: "LEADERBOARD", data: await getLeaderboard(roomId) });
}

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
       WHERE rp.room_id=$1 AND rp.is_spectator=FALSE AND u.role!='admin'
       ORDER BY net_worth DESC LIMIT 10`
    : `SELECT u.id, u.name, rp.total_spent, rp.items_won,
              (10000 - rp.total_spent) as net_worth
       FROM room_participants rp
       JOIN users u ON u.id = rp.user_id
       WHERE rp.room_id=$1 AND rp.is_spectator=FALSE AND u.role!='admin'
       ORDER BY net_worth DESC LIMIT 10`;
  const { rows } = await pool.query(q, [roomId]);
  return rows;
}

async function sendWinnerEmail(winnerId, itemId, amount) {
  try {
    const transporter = createTransporter();
    if (!transporter) return;
    const from = process.env.EMAIL_FROM || process.env.SMTP_USER || process.env.EMAIL_USER;
    const { rows: user } = await pool.query("SELECT email, name FROM users WHERE id=$1", [winnerId]);
    const { rows: item } = await pool.query("SELECT name FROM items WHERE id=$1", [itemId]);
    if (!user[0] || !item[0]) return;

    await transporter.sendMail({
      from,
      to: user[0].email,
      subject: `🏆 You won ${item[0].name}! — BIDArena`,
      html: `
        <div style="font-family:Arial,sans-serif;background:#0f0f0f;color:#f0f0f0;padding:40px;border-radius:8px;max-width:500px;border:1px solid #333;">
          <h1 style="color:#f5c518;font-size:32px;margin:0 0 16px;">You Won! 🏆</h1>
          <p style="font-size:17px;color:#ccc;">Congratulations, <strong style="color:#fff;">${user[0].name}</strong>!</p>
          <div style="background:#1a1a1a;border:1px solid #333;border-radius:6px;padding:20px;margin:24px 0;">
            <div style="font-size:12px;color:#888;letter-spacing:2px;font-family:monospace;">ITEM WON</div>
            <div style="font-size:24px;color:#fff;font-weight:bold;margin-top:6px;">${item[0].name}</div>
            <div style="font-size:12px;color:#888;letter-spacing:2px;font-family:monospace;margin-top:16px;">YOUR WINNING BID</div>
            <div style="font-size:32px;color:#f5c518;font-weight:bold;margin-top:6px;">₹${parseFloat(amount).toFixed(2)}</div>
          </div>
          <p style="color:#999;font-size:14px;">The actual price will be revealed by the admin. Check the arena for final results!</p>
        </div>`,
    });
    console.log(`📧 Winner email → ${user[0].email}`);
  } catch (err) {
    console.error("Winner email error:", err.message);
  }
}

async function sendLeaderboardEmail(roomId) {
  try {
    const transporter = createTransporter();
    if (!transporter) { console.warn("⚠️  No SMTP config — skipping emails"); return; }
    const from = process.env.EMAIL_FROM || process.env.SMTP_USER || process.env.EMAIL_USER;

    const { rows: participants } = await pool.query(
      `SELECT u.id, u.email, u.name
       FROM room_participants rp JOIN users u ON u.id=rp.user_id
       WHERE rp.room_id=$1 AND rp.is_spectator=FALSE AND u.role!='admin'`,
      [roomId]
    );
    if (!participants.length) { console.log("No participants to email"); return; }

    const { rows: room } = await pool.query("SELECT name FROM rooms WHERE id=$1", [roomId]);
    const { rows: items } = await pool.query(
      `SELECT id, name, actual_price, winner_id, winning_bid FROM items
       WHERE room_id=$1 AND status='finished' ORDER BY display_order`, [roomId]
    );
    const { rows: profitBoard } = await pool.query(
      `SELECT u.name,
        SUM(i.actual_price - i.winning_bid) AS total_profit,
        COUNT(i.id) AS items_won,
        SUM(i.winning_bid) AS total_spent
       FROM items i JOIN users u ON u.id=i.winner_id
       WHERE i.room_id=$1 AND i.status='finished' AND i.winner_id IS NOT NULL
       GROUP BY u.id, u.name ORDER BY total_profit DESC LIMIT 5`,
      [roomId]
    );

    const medals = ["🥇", "🥈", "🥉", "4️⃣", "5️⃣"];
    const top5HTML = profitBoard.length
      ? profitBoard.map((r, i) => `
          <tr style="border-bottom:1px solid #2a2a2a;">
            <td style="padding:12px 16px;font-size:18px;">${medals[i]}</td>
            <td style="padding:12px 16px;color:#f0f0f0;font-size:15px;">${r.name}</td>
            <td style="padding:12px 16px;color:#aaa;font-size:14px;">${r.items_won}</td>
            <td style="padding:12px 16px;color:#f5c518;font-size:14px;font-family:monospace;">₹${parseFloat(r.total_spent).toFixed(2)}</td>
            <td style="padding:12px 16px;font-size:14px;font-family:monospace;font-weight:bold;color:${parseFloat(r.total_profit) >= 0 ? "#4ade80" : "#f87171"};">
              ${parseFloat(r.total_profit) >= 0 ? "+" : ""}₹${parseFloat(r.total_profit).toFixed(2)}</td>
          </tr>`).join("")
      : `<tr><td colspan="5" style="padding:16px;color:#888;">No winners this round</td></tr>`;

    for (const p of participants) {
      const myItems = items.filter(i => String(i.winner_id) === String(p.id));
      const totalProfit = myItems.reduce((s, i) => s + parseFloat(i.actual_price) - parseFloat(i.winning_bid), 0);
      const totalSpent = myItems.reduce((s, i) => s + parseFloat(i.winning_bid), 0);
      const pc = totalProfit >= 0 ? "#4ade80" : "#f87171";

      const myItemsHTML = myItems.length
        ? myItems.map(i => {
          const diff = parseFloat(i.actual_price) - parseFloat(i.winning_bid);
          return `
              <tr style="border-bottom:1px solid #2a2a2a;">
                <td style="padding:12px 16px;color:#f0f0f0;font-size:15px;">${i.name}</td>
                <td style="padding:12px 16px;color:#f5c518;font-family:monospace;font-size:14px;">₹${parseFloat(i.winning_bid).toFixed(2)}</td>
                <td style="padding:12px 16px;color:#ccc;font-family:monospace;font-size:14px;">₹${parseFloat(i.actual_price).toFixed(2)}</td>
                <td style="padding:12px 16px;font-family:monospace;font-size:14px;font-weight:bold;color:${diff >= 0 ? "#4ade80" : "#f87171"};">
                  ${diff >= 0 ? "+" : ""}₹${diff.toFixed(2)}</td>
              </tr>`;
        }).join("")
        : `<tr><td colspan="4" style="padding:16px;color:#888;font-size:14px;">You didn't win any items.</td></tr>`;

      const html = `<!DOCTYPE html><html><body style="margin:0;background:#080808;">
        <div style="font-family:Arial,sans-serif;background:#111;color:#f0f0f0;max-width:660px;margin:32px auto;border:1px solid #333;border-radius:8px;overflow:hidden;">
          <div style="background:#111;padding:32px 40px;border-bottom:3px solid #f5c518;">
            <div style="font-size:34px;font-weight:900;color:#f5c518;letter-spacing:5px;font-family:monospace;">BIDARENA</div>
            <div style="font-size:13px;color:#888;letter-spacing:3px;margin-top:6px;font-family:monospace;">FINAL RESULTS — ${room[0]?.name}</div>
          </div>
          <div style="padding:32px 40px 0;">
            <p style="font-size:20px;color:#ccc;margin:0 0 6px;">Hey <strong style="color:#fff;">${p.name}</strong> 👋</p>
            <p style="font-size:15px;color:#999;margin:0 0 32px;">The auction has ended. Here's your scorecard:</p>
          </div>
          <div style="padding:0 40px 32px;">
            <div style="font-size:12px;color:#888;letter-spacing:3px;margin-bottom:12px;font-family:monospace;">YOUR ITEMS</div>
            <table style="width:100%;border-collapse:collapse;background:#1a1a1a;border-radius:6px;overflow:hidden;">
              <thead><tr style="background:#222;border-bottom:1px solid #333;">
                <th style="padding:12px 16px;text-align:left;color:#999;font-size:12px;letter-spacing:2px;font-family:monospace;">ITEM</th>
                <th style="padding:12px 16px;text-align:left;color:#999;font-size:12px;letter-spacing:2px;font-family:monospace;">PAID</th>
                <th style="padding:12px 16px;text-align:left;color:#999;font-size:12px;letter-spacing:2px;font-family:monospace;">ACTUAL</th>
                <th style="padding:12px 16px;text-align:left;color:#999;font-size:12px;letter-spacing:2px;font-family:monospace;">P&amp;L</th>
              </tr></thead>
              <tbody>${myItemsHTML}</tbody>
            </table>
            ${myItems.length ? `
            <div style="margin-top:10px;padding:14px 16px;background:#1a1a1a;border:1px solid #333;border-radius:4px;display:flex;justify-content:space-between;font-family:monospace;font-size:14px;">
              <span style="color:#ccc;">Spent: <strong style="color:#f5c518;">₹${totalSpent.toFixed(2)}</strong></span>
              <span style="color:#ccc;">Net P&amp;L: <strong style="color:${pc};">${totalProfit >= 0 ? "+" : ""}₹${totalProfit.toFixed(2)}</strong></span>
            </div>`: ""}
          </div>
          <div style="padding:0 40px 40px;">
            <div style="font-size:12px;color:#888;letter-spacing:3px;margin-bottom:12px;font-family:monospace;">🏆 TOP 5 LEADERBOARD</div>
            <table style="width:100%;border-collapse:collapse;background:#1a1a1a;border-radius:6px;overflow:hidden;">
              <thead><tr style="background:#222;border-bottom:1px solid #333;">
                <th style="padding:12px 16px;text-align:left;color:#999;font-size:12px;font-family:monospace;">#</th>
                <th style="padding:12px 16px;text-align:left;color:#999;font-size:12px;font-family:monospace;">PLAYER</th>
                <th style="padding:12px 16px;text-align:left;color:#999;font-size:12px;font-family:monospace;">ITEMS</th>
                <th style="padding:12px 16px;text-align:left;color:#999;font-size:12px;font-family:monospace;">SPENT</th>
                <th style="padding:12px 16px;text-align:left;color:#999;font-size:12px;font-family:monospace;">P&amp;L</th>
              </tr></thead>
              <tbody>${top5HTML}</tbody>
            </table>
          </div>
          <div style="padding:20px 40px;background:#0a0a0a;border-top:1px solid #222;font-family:monospace;font-size:12px;color:#555;letter-spacing:2px;">
            THANKS FOR PLAYING BIDARENA
          </div>
        </div></body></html>`;

      await transporter.sendMail({ from, to: p.email, subject: `BIDArena — "${room[0]?.name}" Results & Your P&L`, html });
      console.log(`📧 Results → ${p.email}`);
    }
  } catch (err) {
    console.error("Leaderboard email error:", err.message, err.stack);
  }
}

module.exports = { setupWebSocket, activeBidWindows };