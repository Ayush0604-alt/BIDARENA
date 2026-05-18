const WebSocket = require("ws");
const jwt = require("jsonwebtoken");
const nodemailer = require("nodemailer");
const { pool, listenTo } = require("../config/db");

// Map: roomId => Set of ws clients
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

function setupWebSocket(server) {
  const wss = new WebSocket.Server({ server, path: "/ws" });

  // Hook PostgreSQL NOTIFY -> WebSocket broadcast
  listenTo("bid_update", async (payload) => {
    const itemId = payload.item_id;
    const { rows } = await pool.query(
      "SELECT room_id FROM items WHERE id=$1",
      [itemId]
    );
    if (rows[0]) broadcast(rows[0].room_id, { type: "BID_UPDATE", data: payload });
  });

  listenTo("item_update", async (payload) => {
    const { rows } = await pool.query(
      "SELECT room_id FROM items WHERE id=$1",
      [payload.id]
    );
    if (rows[0]) broadcast(rows[0].room_id, { type: "ITEM_UPDATE", data: payload });
  });

  listenTo("db_notifications", (payload) => {
    if (payload.type === "POINTS_RESET") {
      broadcastAll({ type: "POINTS_RESET" });
    }
  });

  wss.on("connection", async (ws, req) => {
    // Auth via ?token=
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

      // Check WS token expiry (within 1 hour)
      if (ws.tokenExp && ws.tokenExp * 1000 - Date.now() < 3600000) {
        ws.send(JSON.stringify({ type: "REAUTH_REQUIRED", reason: "Token expiring soon" }));
      }

      switch (msg.type) {
        case "JOIN_ROOM":
          await handleJoinRoom(ws, msg.roomId);
          break;
        case "PLACE_BID":
          await handlePlaceBid(ws, msg);
          break;
        case "ADMIN_START_ITEM":
          await handleStartItem(ws, msg);
          break;
        case "ADMIN_END_ITEM":
          await handleEndItem(ws, msg);
          break;
        case "ADMIN_REVEAL_PRICES":
          await handleRevealPrices(ws, msg);
          break;
        case "GET_LEADERBOARD":
          await sendLeaderboard(ws, msg.roomId || ws.roomId);
          break;
      }
    });

    ws.on("close", () => {
      if (ws.roomId && roomClients[ws.roomId]) {
        roomClients[ws.roomId].delete(ws);
      }
    });
  });

  return wss;
}

async function handleJoinRoom(ws, roomId) {
  // Leave old room
  if (ws.roomId && roomClients[ws.roomId]) {
    roomClients[ws.roomId].delete(ws);
  }
  ws.roomId = roomId;
  if (!roomClients[roomId]) roomClients[roomId] = new Set();
  
  // Close duplicate connections for this user in this room
  for (const client of roomClients[roomId]) {
    if (String(client.userId) === String(ws.userId) && client !== ws) {
      client.send(JSON.stringify({ type: "ERROR", reason: "Joined from another tab" }));
      client.close(4009, "Joined from another tab");
      roomClients[roomId].delete(client);
    }
  }
  
  roomClients[roomId].add(ws);

  const { rows: room } = await pool.query("SELECT * FROM rooms WHERE id=$1", [roomId]);
  
  // Ensure participant row exists
  await pool.query(
    `INSERT INTO room_participants(room_id,user_id,is_spectator) VALUES($1,$2,$3) ON CONFLICT DO NOTHING`,
    [roomId, ws.userId, room[0]?.status !== "waiting" && ws.userRole !== "admin"]
  );
  
  const { rows: part } = await pool.query("SELECT is_spectator FROM room_participants WHERE room_id=$1 AND user_id=$2", [roomId, ws.userId]);
  ws.isSpectator = part[0]?.is_spectator || false;

  // Send room snapshot
  const { rows: items } = await pool.query(
    "SELECT * FROM items WHERE room_id=$1 ORDER BY display_order",
    [roomId]
  );
  const { rows: topBids } = await pool.query(`
    SELECT DISTINCT ON (item_id) item_id, user_id, amount, created_at
    FROM bids WHERE item_id = ANY($1::int[])
    ORDER BY item_id, amount DESC
  `, [items.map((i) => i.id)]);

  ws.send(JSON.stringify({ type: "ROOM_SNAPSHOT", data: { room: room[0], items, topBids, isSpectator: ws.isSpectator } }));
  await sendLeaderboard(ws, roomId);

  // Notify room of new participant
  broadcast(roomId, { type: "USER_JOINED", data: { userId: ws.userId, name: ws.userName } });
}

// Active bid windows: itemId => { timeout, highBidderId, amount }
const activeBidWindows = {};

// Rate limiter: userId => { count, firstHit }
const bidRateLimits = {};

async function handlePlaceBid(ws, msg) {
  if (ws.isSpectator) {
    return ws.send(JSON.stringify({ type: "BID_REJECTED", reason: "Spectators cannot place bids" }));
  }
  const { itemId, amount } = msg;
  const roomId = ws.roomId;

  // Check item is active
  const { rows } = await pool.query("SELECT * FROM items WHERE id=$1", [itemId]);
  const item = rows[0];
  if (!item || item.status !== "active") {
    return ws.send(JSON.stringify({ type: "BID_REJECTED", reason: "Item not active" }));
  }

  // Check if this user is already highest bidder
  const window = activeBidWindows[itemId];
  if (window && String(window.highBidderId) === String(ws.userId)) {
    return ws.send(JSON.stringify({ type: "BID_REJECTED", reason: "You are already the highest bidder" }));
  }

  // Enforce amount > current high bid
  const { rows: highRows } = await pool.query(
    "SELECT MAX(amount) as max FROM bids WHERE item_id=$1",
    [itemId]
  );
  const currentHighDB = parseFloat(highRows[0]?.max || 0);
  const currentHigh = Math.max(currentHighDB, window?.amount || 0);
  
  if (parseFloat(amount) < 1) {
    return ws.send(JSON.stringify({ type: "BID_REJECTED", reason: "Minimum bid is 1 point" }));
  }

  if (parseFloat(amount) <= currentHigh) {
    return ws.send(JSON.stringify({ type: "BID_REJECTED", reason: `Bid must exceed current high of ₹${currentHigh}` }));
  }

  // Rate Limiting: 3 attempts per 5s
  const now = Date.now();
  if (!bidRateLimits[ws.userId] || now - bidRateLimits[ws.userId].firstHit > 5000) {
    bidRateLimits[ws.userId] = { count: 1, firstHit: now };
  } else {
    bidRateLimits[ws.userId].count++;
    if (bidRateLimits[ws.userId].count > 3) {
      return ws.send(JSON.stringify({ type: "BID_REJECTED", reason: "Too many attempts. Please wait." }));
    }
  }

  // Check user has enough points
  const { rows: userRows } = await pool.query("SELECT points FROM users WHERE id=$1", [ws.userId]);
  const availablePoints = parseFloat(userRows[0]?.points || 0);
  if (parseFloat(amount) > availablePoints) {
    return ws.send(JSON.stringify({
      type: "BID_REJECTED",
      reason: `Insufficient points. You have ${availablePoints.toFixed(0)} pts, bid requires ${parseFloat(amount).toFixed(0)} pts`
    }));
  }

  // Refund previous bidder if there was one pending
  if (window) {
    await pool.query("UPDATE users SET points = points + $1 WHERE id=$2", [window.amount, window.highBidderId]);
    const prevWs = [...(roomClients[ws.roomId] || [])].find(c => String(c.userId) === String(window.highBidderId));
    if (prevWs) {
      const { rows: updated } = await pool.query("SELECT points FROM users WHERE id=$1", [window.highBidderId]);
      prevWs.send(JSON.stringify({ type: "POINTS_UPDATE", data: { points: updated[0].points } }));
    }
  }

  // Deduct points from new bidder to reserve them
  await pool.query("UPDATE users SET points = points - $1 WHERE id=$2", [amount, ws.userId]);
  const { rows: reserveUpdated } = await pool.query("SELECT points FROM users WHERE id=$1", [ws.userId]);
  ws.send(JSON.stringify({ type: "POINTS_UPDATE", data: { points: reserveUpdated[0].points } }));

  // Start 10-second window — block others during this time
  if (window?.timeout) clearTimeout(window.timeout);

  activeBidWindows[itemId] = {
    highBidderId: ws.userId,
    highBidderName: ws.userName,
    amount: parseFloat(amount),
    timeout: setTimeout(async () => {
      // Commit bid after 10s with no challenge
      await pool.query(
        "INSERT INTO bids(item_id,user_id,amount) VALUES($1,$2,$3)",
        [itemId, ws.userId, amount]
      );
      delete activeBidWindows[itemId];
      // Update item's winning bid
      await pool.query(
        "UPDATE items SET winner_id=$1, winning_bid=$2 WHERE id=$3",
        [ws.userId, amount, itemId]
      );
      
      broadcast(roomId, {
        type: "BID_COMMITTED",
        data: { itemId, userId: ws.userId, userName: ws.userName, amount },
      });
      await broadcastLeaderboard(roomId);
      
      // Send winner email
      sendWinnerEmail(ws.userId, itemId, amount).catch(console.error);
    }, 10000),
  };

  // Tell everyone a bid is pending (10s window open)
  broadcast(roomId, {
    type: "BID_WINDOW_OPEN",
    data: { itemId, userId: ws.userId, userName: ws.userName, amount, expiresIn: 10, bidding_window_started_at: Date.now() },
  });
}

async function handleStartItem(ws, msg) {
  if (ws.userRole !== "admin") return;
  const { itemId } = msg;
  
  // Enforce item order
  const { rows: prevItems } = await pool.query(
    "SELECT id FROM items WHERE room_id=$1 AND status='active'",
    [ws.roomId]
  );
  if (prevItems.length > 0) {
    return ws.send(JSON.stringify({ type: "ERROR", reason: "Another item is currently active." }));
  }

  await pool.query(
    "UPDATE items SET status='active', bidding_start=NOW() WHERE id=$1",
    [itemId]
  );
  
  // Set room to active
  await pool.query("UPDATE rooms SET status='active' WHERE id=$1", [ws.roomId]);
  // trigger from DB notify — but also broadcast directly for speed
  const { rows } = await pool.query("SELECT * FROM items WHERE id=$1", [itemId]);
  broadcast(ws.roomId, { type: "ITEM_STARTED", data: rows[0] });
}

async function handleEndItem(ws, msg) {
  if (ws.userRole !== "admin") return;
  const { itemId } = msg;

  // Clear any pending bid window and commit it immediately
  if (activeBidWindows[itemId]) {
    clearTimeout(activeBidWindows[itemId].timeout);
    const w = activeBidWindows[itemId];
    await pool.query(
      "INSERT INTO bids(item_id,user_id,amount) VALUES($1,$2,$3)",
      [itemId, w.highBidderId, w.amount]
    );
    await pool.query(
      "UPDATE items SET winner_id=$1, winning_bid=$2 WHERE id=$3",
      [w.highBidderId, w.amount, itemId]
    );
    // Points are already deducted on place bid, no need to deduct again.
    delete activeBidWindows[itemId];
    
    // Send winner email
    sendWinnerEmail(w.highBidderId, itemId, w.amount).catch(console.error);
  }

  await pool.query(
    "UPDATE items SET status='finished', bidding_end=NOW() WHERE id=$1",
    [itemId]
  );

  // Update room_participants totals
  const { rows: item } = await pool.query("SELECT * FROM items WHERE id=$1", [itemId]);
  if (item[0]?.winner_id) {
    await pool.query(
      `UPDATE room_participants SET total_spent=total_spent+$1, items_won=items_won+1
       WHERE room_id=$2 AND user_id=$3`,
      [item[0].winning_bid, ws.roomId, item[0].winner_id]
    );
  }

  broadcast(ws.roomId, { type: "ITEM_ENDED", data: item[0] });
  await broadcastLeaderboard(ws.roomId);
}

async function handleRevealPrices(ws, msg) {
  if (ws.userRole !== "admin") return;
  const { roomId } = msg;

  await pool.query("UPDATE items SET revealed=TRUE WHERE room_id=$1", [roomId]);
  await pool.query("UPDATE rooms SET status='finished' WHERE id=$1", [roomId]);

  const { rows: items } = await pool.query(
    "SELECT * FROM items WHERE room_id=$1 ORDER BY display_order",
    [roomId]
  );
  broadcast(roomId, { type: "PRICES_REVEALED", data: { items } });

  // Send leaderboard email
  await sendLeaderboardEmail(roomId);
}

async function sendLeaderboard(ws, roomId) {
  const board = await getLeaderboard(roomId);
  ws.send(JSON.stringify({ type: "LEADERBOARD", data: board }));
}

async function broadcastLeaderboard(roomId) {
  const board = await getLeaderboard(roomId);
  broadcast(roomId, { type: "LEADERBOARD", data: board });
}

async function getLeaderboard(roomId) {
  const { rows: room } = await pool.query("SELECT status FROM rooms WHERE id=$1", [roomId]);
  const isFinished = room[0]?.status === "finished";

  if (isFinished) {
    const { rows } = await pool.query(
      `SELECT u.id, u.name, rp.total_spent, rp.items_won,
              (10000 - rp.total_spent + COALESCE((
                 SELECT SUM(actual_price) FROM items WHERE room_id=$1 AND winner_id=u.id
              ), 0)) as net_worth
       FROM room_participants rp
       JOIN users u ON u.id = rp.user_id
       WHERE rp.room_id = $1 AND rp.is_spectator = FALSE
       ORDER BY net_worth DESC
       LIMIT 10`,
      [roomId]
    );
    return rows;
  } else {
    const { rows } = await pool.query(
      `SELECT u.id, u.name, rp.total_spent, rp.items_won,
              (10000 - rp.total_spent) as net_worth
       FROM room_participants rp
       JOIN users u ON u.id = rp.user_id
       WHERE rp.room_id = $1 AND rp.is_spectator = FALSE
       ORDER BY net_worth DESC
       LIMIT 10`,
      [roomId]
    );
    return rows;
  }
}

async function sendWinnerEmail(winnerId, itemId, amount) {
  try {
    const { rows: user } = await pool.query("SELECT email, name FROM users WHERE id=$1", [winnerId]);
    const { rows: item } = await pool.query("SELECT name FROM items WHERE id=$1", [itemId]);
    if (!user[0] || !item[0]) return;

    const transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT),
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    });

    await transporter.sendMail({
      from: process.env.EMAIL_FROM,
      to: user[0].email,
      subject: `🏆 You won ${item[0].name}!`,
      html: `
        <div style="font-family:sans-serif;background:#080808;color:#e0e0e0;padding:32px;border-radius:6px;max-width:500px;">
          <h2 style="color:#f5c518;">Congratulations ${user[0].name}!</h2>
          <p>You won <b>${item[0].name}</b> for <b>₹${amount} pts</b>.</p>
        </div>
      `,
    });
  } catch (err) {
    console.error("Single winner email error:", err.message);
  }
}

async function sendLeaderboardEmail(roomId) {
  try {
    const transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT),
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    });

    const { rows: participants } = await pool.query(
      `SELECT u.id, u.email, u.name FROM room_participants rp JOIN users u ON u.id=rp.user_id WHERE rp.room_id=$1 AND rp.is_spectator = FALSE`,
      [roomId]
    );
    const { rows: room } = await pool.query("SELECT name FROM rooms WHERE id=$1", [roomId]);

    // All finished items with actual prices
    const { rows: items } = await pool.query(
      `SELECT id, name, actual_price, winner_id, winning_bid FROM items
       WHERE room_id=$1 AND status='finished' ORDER BY display_order`,
      [roomId]
    );

    // Build top 5 most profitable: profit = actual_price - winning_bid (lower bid = more profit)
    // Only for items they won
    const { rows: profitBoard } = await pool.query(
      `SELECT u.name,
        SUM(i.actual_price - i.winning_bid) AS total_profit,
        COUNT(i.id) AS items_won,
        SUM(i.winning_bid) AS total_spent
       FROM items i
       JOIN users u ON u.id = i.winner_id
       WHERE i.room_id = $1 AND i.status = 'finished' AND i.winner_id IS NOT NULL
       GROUP BY u.id, u.name
       ORDER BY total_profit DESC
       LIMIT 5`,
      [roomId]
    );

    // Top 5 leaderboard HTML
    const medals = ["🥇", "🥈", "🥉", "4️⃣", "5️⃣"];
    const top5HTML = profitBoard.length ? profitBoard.map((r, i) => `
      <tr style="border-bottom:1px solid #1e1e1e;">
        <td style="padding:10px 12px;font-size:18px;">${medals[i]}</td>
        <td style="padding:10px 12px;color:#e8e8e8;font-weight:500;">${r.name}</td>
        <td style="padding:10px 12px;font-family:monospace;">${r.items_won} items</td>
        <td style="padding:10px 12px;font-family:monospace;color:#f5c518;">₹${parseFloat(r.total_spent).toFixed(2)}</td>
        <td style="padding:10px 12px;font-family:monospace;font-weight:bold;color:${parseFloat(r.total_profit) >= 0 ? "#38a169" : "#e53e3e"};">
          ${parseFloat(r.total_profit) >= 0 ? "+" : ""}₹${parseFloat(r.total_profit).toFixed(2)}
        </td>
      </tr>`).join("") :
      `<tr><td colspan="5" style="padding:16px;color:#666;">No winners yet</td></tr>`;

    // Send personalised email to each participant
    for (const p of participants) {
      // Build this player's P&L table
      const myItems = items.filter(i => String(i.winner_id) === String(p.id));

      const myItemsHTML = myItems.length ? myItems.map(i => {
        const actual = parseFloat(i.actual_price);
        const paid = parseFloat(i.winning_bid);
        const diff = actual - paid;
        const color = diff >= 0 ? "#38a169" : "#e53e3e";
        const sign = diff >= 0 ? "+" : "";
        return `
          <tr style="border-bottom:1px solid #1e1e1e;">
            <td style="padding:10px 12px;color:#e8e8e8;">${i.name}</td>
            <td style="padding:10px 12px;font-family:monospace;color:#f5c518;">₹${paid.toFixed(2)}</td>
            <td style="padding:10px 12px;font-family:monospace;">₹${actual.toFixed(2)}</td>
            <td style="padding:10px 12px;font-family:monospace;font-weight:bold;color:${color};">${sign}₹${diff.toFixed(2)}</td>
          </tr>`;
      }).join("") :
        `<tr><td colspan="4" style="padding:16px;color:#666;">You didn't win any items this round.</td></tr>`;

      const totalProfit = myItems.reduce((sum, i) => sum + parseFloat(i.actual_price) - parseFloat(i.winning_bid), 0);
      const totalSpent = myItems.reduce((sum, i) => sum + parseFloat(i.winning_bid), 0);
      const profitColor = totalProfit >= 0 ? "#38a169" : "#e53e3e";
      const profitSign = totalProfit >= 0 ? "+" : "";

      const html = `
        <div style="font-family:'Segoe UI',sans-serif;background:#080808;color:#e0e0e0;padding:0;max-width:640px;margin:0 auto;border:1px solid #1e1e1e;border-radius:6px;overflow:hidden;">
          <!-- Header -->
          <div style="background:#0f0f0f;padding:32px;border-bottom:1px solid #1e1e1e;">
            <div style="font-family:monospace;font-size:32px;font-weight:bold;color:#f5c518;letter-spacing:6px;">BIDARENA</div>
            <div style="font-family:monospace;font-size:11px;color:#666;letter-spacing:3px;margin-top:4px;">FINAL RESULTS — ${room[0]?.name}</div>
          </div>

          <!-- Greeting -->
          <div style="padding:24px 32px 0;">
            <p style="font-size:15px;color:#aaa;">Hey <strong style="color:#e8e8e8;">${p.name}</strong>, the auction has ended. Here's how you did:</p>
          </div>

          <!-- My P&L -->
          ${myItems.length ? `
          <div style="padding:24px 32px;">
            <div style="font-family:monospace;font-size:11px;color:#666;letter-spacing:3px;margin-bottom:12px;">YOUR ITEMS</div>
            <table style="width:100%;border-collapse:collapse;background:#0f0f0f;border-radius:4px;overflow:hidden;">
              <thead>
                <tr style="border-bottom:1px solid #333;">
                  <th style="padding:10px 12px;text-align:left;color:#888;font-family:monospace;font-size:11px;letter-spacing:2px;">ITEM</th>
                  <th style="padding:10px 12px;text-align:left;color:#888;font-family:monospace;font-size:11px;letter-spacing:2px;">YOU PAID</th>
                  <th style="padding:10px 12px;text-align:left;color:#888;font-family:monospace;font-size:11px;letter-spacing:2px;">ACTUAL</th>
                  <th style="padding:10px 12px;text-align:left;color:#888;font-family:monospace;font-size:11px;letter-spacing:2px;">P&amp;L</th>
                </tr>
              </thead>
              <tbody>${myItemsHTML}</tbody>
            </table>
            <div style="margin-top:12px;padding:12px 16px;background:#0f0f0f;border:1px solid #1e1e1e;border-radius:4px;display:flex;justify-content:space-between;font-family:monospace;font-size:13px;">
              <span>Total spent: <strong style="color:#f5c518;">₹${totalSpent.toFixed(2)}</strong></span>
              <span>Net P&amp;L: <strong style="color:${profitColor};">${profitSign}₹${totalProfit.toFixed(2)}</strong></span>
            </div>
          </div>` : `<div style="padding:16px 32px;color:#666;font-size:13px;">You didn't win any items this round.</div>`}

          <!-- Top 5 Most Profitable -->
          <div style="padding:8px 32px 32px;">
            <div style="font-family:monospace;font-size:11px;color:#666;letter-spacing:3px;margin-bottom:12px;">🏆 TOP 5 MOST PROFITABLE</div>
            <table style="width:100%;border-collapse:collapse;background:#0f0f0f;border-radius:4px;overflow:hidden;">
              <thead>
                <tr style="border-bottom:1px solid #333;">
                  <th style="padding:10px 12px;text-align:left;color:#888;font-family:monospace;font-size:11px;letter-spacing:2px;">#</th>
                  <th style="padding:10px 12px;text-align:left;color:#888;font-family:monospace;font-size:11px;letter-spacing:2px;">PLAYER</th>
                  <th style="padding:10px 12px;text-align:left;color:#888;font-family:monospace;font-size:11px;letter-spacing:2px;">ITEMS</th>
                  <th style="padding:10px 12px;text-align:left;color:#888;font-family:monospace;font-size:11px;letter-spacing:2px;">SPENT</th>
                  <th style="padding:10px 12px;text-align:left;color:#888;font-family:monospace;font-size:11px;letter-spacing:2px;">NET P&amp;L</th>
                </tr>
              </thead>
              <tbody>${top5HTML}</tbody>
            </table>
          </div>

          <div style="padding:16px 32px;background:#0a0a0a;border-top:1px solid #1e1e1e;font-family:monospace;font-size:11px;color:#444;letter-spacing:2px;">
            THANKS FOR PLAYING BIDARENA
          </div>
        </div>`;

      await transporter.sendMail({
        from: process.env.EMAIL_FROM,
        to: p.email,
        subject: `BIDArena — "${room[0]?.name}" Results + Your P&L`,
        html,
      });
    }
    console.log("📧 Result emails sent to all participants");
  } catch (err) {
    console.error("Email error:", err.message);
  }
}

module.exports = { setupWebSocket, activeBidWindows };