const { pool } = require("../config/db");

// GET /api/v1/rooms
const getRooms = async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT r.*, u.name as creator_name,
        (SELECT COUNT(*) FROM room_participants rp
         JOIN users u2 ON u2.id=rp.user_id
         WHERE rp.room_id=r.id AND u2.role != 'admin' AND rp.is_spectator=FALSE) as participant_count,
        (SELECT COUNT(*) FROM items i WHERE i.room_id=r.id) as item_count
       FROM rooms r JOIN users u ON u.id=r.created_by
       ORDER BY r.created_at DESC`
    );
    res.json({ success: true, rooms: rows });
  } catch (err) { next(err); }
};

// POST /api/v1/rooms — admin creates a room
// FIX: accept max_players from body
const createRoom = async (req, res, next) => {
  const { name, max_players } = req.body;
  try {
    const maxP = max_players ? parseInt(max_players) : null;
    const { rows } = await pool.query(
      "INSERT INTO rooms(name,created_by,max_players) VALUES($1,$2,$3) RETURNING *",
      [name, req.user.id, maxP]
    );
    res.status(201).json({ success: true, room: rows[0] });
  } catch (err) { next(err); }
};

// GET /api/v1/rooms/:id
const getRoom = async (req, res, next) => {
  try {
    const { rows: room } = await pool.query("SELECT * FROM rooms WHERE id=$1", [req.params.id]);
    if (!room[0]) return res.status(404).json({ success: false, message: "Room not found" });

    const { rows: items } = await pool.query(
      "SELECT * FROM items WHERE room_id=$1 ORDER BY display_order",
      [req.params.id]
    );

    const { rows: topBids } = await pool.query(
      `SELECT DISTINCT ON (b.item_id) b.item_id, b.user_id, b.amount, u.name as user_name
       FROM bids b JOIN users u ON u.id=b.user_id
       WHERE b.item_id = ANY($1::int[])
       ORDER BY b.item_id, b.amount DESC`,
      [items.map((i) => i.id)]
    );

    const { rows: allBids } = await pool.query(
      `SELECT b.item_id, b.user_id, b.amount, b.created_at, u.name as user_name
       FROM bids b JOIN users u ON u.id=b.user_id
       WHERE b.item_id = ANY($1::int[])
       ORDER BY b.item_id, b.amount DESC`,
      [items.map((i) => i.id)]
    );

    res.json({ success: true, room: room[0], items, topBids, allBids });
  } catch (err) { next(err); }
};

// POST /api/v1/rooms/:id/items
const addItem = async (req, res, next) => {
  const { name, description, actual_price, display_order } = req.body;
  try {
    const { rows } = await pool.query(
      `INSERT INTO items(room_id,name,description,actual_price,display_order)
       VALUES($1,$2,$3,$4,$5) RETURNING *`,
      [req.params.id, name, description, actual_price, display_order]
    );
    res.status(201).json({ success: true, item: rows[0] });
  } catch (err) { next(err); }
};

// DELETE /api/v1/rooms/:id/items/:itemId
const deleteItem = async (req, res, next) => {
  try {
    await pool.query("DELETE FROM items WHERE id=$1 AND room_id=$2", [req.params.itemId, req.params.id]);
    res.json({ success: true, message: "Item deleted" });
  } catch (err) { next(err); }
};

// GET /api/v1/rooms/:id/leaderboard
const getLeaderboard = async (req, res, next) => {
  try {
    const { id: roomId } = req.params;
    const { rows: room } = await pool.query("SELECT status FROM rooms WHERE id=$1", [roomId]);
    const isFinished = room[0]?.status === "finished";

    let rows;
    if (isFinished) {
      const result = await pool.query(
        `SELECT u.id, u.name, rp.total_spent, rp.items_won,
                (10000 - rp.total_spent + COALESCE((
                   SELECT SUM(actual_price) FROM items WHERE room_id=$1 AND winner_id=u.id
                ), 0)) as net_worth
         FROM room_participants rp JOIN users u ON u.id=rp.user_id
         WHERE rp.room_id=$1 AND rp.is_spectator = FALSE AND u.role != 'admin'
         ORDER BY net_worth DESC LIMIT 10`,
        [roomId]
      );
      rows = result.rows;
    } else {
      const result = await pool.query(
        `SELECT u.id, u.name, rp.total_spent, rp.items_won,
                (10000 - rp.total_spent) as net_worth
         FROM room_participants rp JOIN users u ON u.id=rp.user_id
         WHERE rp.room_id=$1 AND rp.is_spectator = FALSE AND u.role != 'admin'
         ORDER BY net_worth DESC LIMIT 10`,
        [roomId]
      );
      rows = result.rows;
    }
    res.json({ success: true, leaderboard: rows });
  } catch (err) { next(err); }
};

// DELETE /api/v1/rooms/:id
const deleteRoom = async (req, res, next) => {
  try {
    await pool.query("DELETE FROM rooms WHERE id=$1", [req.params.id]);
    res.json({ success: true, message: "Room deleted" });
  } catch (err) { next(err); }
};

// POST /api/v1/rooms/reset-points
// FIX: After reset, re-fetch user points from DB so the response confirms success
const resetPoints = async (req, res, next) => {
  try {
    await pool.query("UPDATE users SET points=10000 WHERE role='buyer'");
    // FIX: Use pg_notify to trigger all connected WS clients to update
    await pool.query(`SELECT pg_notify('db_notifications', '{"type":"POINTS_RESET"}')`);
    res.json({ success: true, message: "All buyers reset to 10,000 pts" });
  } catch (err) { next(err); }
};

// PATCH /api/v1/rooms/:id — update room settings (e.g. max_players)
const updateRoom = async (req, res, next) => {
  try {
    const { max_players } = req.body;
    const maxP = max_players !== undefined ? parseInt(max_players) || null : undefined;
    if (maxP === undefined) return res.status(400).json({ success: false, message: "No fields to update" });
    const { rows } = await pool.query(
      "UPDATE rooms SET max_players=$1 WHERE id=$2 RETURNING *",
      [maxP, req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ success: false, message: "Room not found" });
    res.json({ success: true, room: rows[0] });
  } catch (err) { next(err); }
};

module.exports = { getRooms, createRoom, getRoom, addItem, deleteItem, getLeaderboard, deleteRoom, resetPoints, updateRoom };