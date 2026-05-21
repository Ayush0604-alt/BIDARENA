const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
});

// ─── LISTEN / NOTIFY ───────────────────────────────────────────────────────
let listenerClient = null;
const listenerCallbacks = {};
const subscribedChannels = new Set();
let reconnectTimer = null;

async function getListenerClient() {
  if (listenerClient) return listenerClient;
  listenerClient = await pool.connect();

  listenerClient.on("notification", (msg) => {
    let payload;
    try { payload = JSON.parse(msg.payload); } catch { payload = msg.payload; }
    const cbs = listenerCallbacks[msg.channel] || [];
    cbs.forEach((cb) => { try { cb(payload); } catch (e) { console.error("Listener cb error:", e.message); } });
  });

  listenerClient.on("error", (err) => {
    console.error("⚠️  Listener client error:", err.message, "— reconnecting in 5s…");
    listenerClient = null;
    if (!reconnectTimer) {
      reconnectTimer = setTimeout(async () => {
        reconnectTimer = null;
        try { await rebuildListenerClient(); } catch (e) { console.error("Listener reconnect failed:", e.message); }
      }, 5000);
    }
  });

  for (const channel of subscribedChannels) {
    await listenerClient.query(`LISTEN "${channel}"`);
  }
  return listenerClient;
}

async function rebuildListenerClient() {
  console.log("🔄 Rebuilding LISTEN client…");
  listenerClient = null;
  const client = await getListenerClient();
  console.log("✅ LISTEN client reconnected");
  return client;
}

async function listenTo(channel, callback) {
  if (!listenerCallbacks[channel]) listenerCallbacks[channel] = [];
  listenerCallbacks[channel].push(callback);
  if (!subscribedChannels.has(channel)) {
    subscribedChannels.add(channel);
    const client = await getListenerClient();
    await client.query(`LISTEN "${channel}"`);
  }
}

// ─── CONNECT & SCHEMA ──────────────────────────────────────────────────────
async function connectDB() {
  try {
    await pool.query("SELECT 1");
    console.log("✅ NeonDB connected");
    await initSchema();
  } catch (err) {
    console.error("❌ DB connection failed:", err.message);
    process.exit(1);
  }
}

async function initSchema() {
  // Safe column migrations
  const migrations = [
    `ALTER TABLE rooms ADD COLUMN IF NOT EXISTS max_players INT DEFAULT NULL`,
    `ALTER TABLE room_participants ADD COLUMN IF NOT EXISTS is_spectator BOOLEAN DEFAULT FALSE`,
  ];
  for (const sql of migrations) await pool.query(sql).catch(() => {});

  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id         SERIAL PRIMARY KEY,
      name       TEXT NOT NULL,
      email      TEXT UNIQUE NOT NULL,
      password   TEXT NOT NULL,
      role       TEXT DEFAULT 'buyer' CHECK (role IN ('admin','buyer')),
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS rooms (
      id                  SERIAL PRIMARY KEY,
      name                TEXT NOT NULL,
      status              TEXT DEFAULT 'waiting' CHECK (status IN ('waiting','active','finished')),
      created_by          INT REFERENCES users(id),
      current_item_index  INT DEFAULT 0,
      max_players         INT DEFAULT NULL,
      created_at          TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS items (
      id             SERIAL PRIMARY KEY,
      room_id        INT REFERENCES rooms(id) ON DELETE CASCADE,
      name           TEXT NOT NULL,
      description    TEXT,
      actual_price   NUMERIC(12,2),
      revealed       BOOLEAN DEFAULT FALSE,
      display_order  INT NOT NULL,
      bidding_start  TIMESTAMPTZ,
      bidding_end    TIMESTAMPTZ,
      status         TEXT DEFAULT 'pending' CHECK (status IN ('pending','active','finished')),
      winner_id      INT REFERENCES users(id),
      winning_bid    NUMERIC(12,2)
    );

    CREATE TABLE IF NOT EXISTS bids (
      id         SERIAL PRIMARY KEY,
      item_id    INT REFERENCES items(id) ON DELETE CASCADE,
      user_id    INT REFERENCES users(id),
      amount     NUMERIC(12,2) NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS room_participants (
      room_id      INT REFERENCES rooms(id) ON DELETE CASCADE,
      user_id      INT REFERENCES users(id),
      total_spent  NUMERIC(12,2) DEFAULT 0,
      items_won    INT DEFAULT 0,
      is_spectator BOOLEAN DEFAULT FALSE,
      PRIMARY KEY (room_id, user_id)
    );

    -- Room-scoped points: fresh 10,000 per player per room session
    -- Points are deducted when bidding and refunded when outbid.
    -- They do NOT persist to the users table.
    CREATE TABLE IF NOT EXISTS room_player_points (
      room_id  INT REFERENCES rooms(id) ON DELETE CASCADE,
      user_id  INT REFERENCES users(id),
      points   NUMERIC(12,2) NOT NULL DEFAULT 10000,
      PRIMARY KEY (room_id, user_id)
    );

    CREATE OR REPLACE FUNCTION notify_bid_update() RETURNS trigger AS $$
    BEGIN
      PERFORM pg_notify('bid_update', row_to_json(NEW)::text);
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;

    DROP TRIGGER IF EXISTS bid_inserted ON bids;
    CREATE TRIGGER bid_inserted
      AFTER INSERT ON bids
      FOR EACH ROW EXECUTE FUNCTION notify_bid_update();

    CREATE OR REPLACE FUNCTION notify_item_update() RETURNS trigger AS $$
    BEGIN
      PERFORM pg_notify('item_update', row_to_json(NEW)::text);
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;

    DROP TRIGGER IF EXISTS item_changed ON items;
    CREATE TRIGGER item_changed
      AFTER UPDATE ON items
      FOR EACH ROW EXECUTE FUNCTION notify_item_update();
  `);

  console.log("✅ Schema ready");
}

module.exports = { pool, connectDB, listenTo };