const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

let listenerClient = null;
const listenerCallbacks = {};

async function getListenerClient() {
  if (!listenerClient) {
    listenerClient = await pool.connect();
    listenerClient.on("notification", (msg) => {
      const cbs = listenerCallbacks[msg.channel] || [];
      cbs.forEach((cb) => cb(JSON.parse(msg.payload)));
    });
    listenerClient.on("error", (err) => {
      console.error("Listener client error:", err.message);
      listenerClient = null;
    });
  }
  return listenerClient;
}

async function listenTo(channel, callback) {
  const client = await getListenerClient();
  if (!listenerCallbacks[channel]) {
    listenerCallbacks[channel] = [];
    await client.query(`LISTEN ${channel}`);
  }
  listenerCallbacks[channel].push(callback);
}

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
  // Safe ALTER TABLE migrations
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS points NUMERIC(12,2) DEFAULT 10000;`).catch(() => {});
  // FIX: add max_players column to rooms
  await pool.query(`ALTER TABLE rooms ADD COLUMN IF NOT EXISTS max_players INT DEFAULT NULL;`).catch(() => {});

  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      role TEXT DEFAULT 'buyer' CHECK (role IN ('admin','buyer')),
      points NUMERIC(12,2) DEFAULT 10000,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS rooms (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      status TEXT DEFAULT 'waiting' CHECK (status IN ('waiting','active','finished')),
      created_by INT REFERENCES users(id),
      current_item_index INT DEFAULT 0,
      max_players INT DEFAULT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS items (
      id SERIAL PRIMARY KEY,
      room_id INT REFERENCES rooms(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      description TEXT,
      actual_price NUMERIC(12,2),
      revealed BOOLEAN DEFAULT FALSE,
      display_order INT NOT NULL,
      bidding_start TIMESTAMPTZ,
      bidding_end TIMESTAMPTZ,
      status TEXT DEFAULT 'pending' CHECK (status IN ('pending','active','finished')),
      winner_id INT REFERENCES users(id),
      winning_bid NUMERIC(12,2)
    );

    CREATE TABLE IF NOT EXISTS bids (
      id SERIAL PRIMARY KEY,
      item_id INT REFERENCES items(id) ON DELETE CASCADE,
      user_id INT REFERENCES users(id),
      amount NUMERIC(12,2) NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS room_participants (
      room_id INT REFERENCES rooms(id) ON DELETE CASCADE,
      user_id INT REFERENCES users(id),
      total_spent NUMERIC(12,2) DEFAULT 0,
      items_won INT DEFAULT 0,
      is_spectator BOOLEAN DEFAULT FALSE,
      PRIMARY KEY (room_id, user_id)
    );

    ALTER TABLE room_participants ADD COLUMN IF NOT EXISTS is_spectator BOOLEAN DEFAULT FALSE;

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