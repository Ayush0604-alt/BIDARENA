# 🏆 BIDArena — Real-Time Bidding Simulator

A real-time auction platform where users join rooms, place bids on items, compete on a live leaderboard, and discover P&L after the admin reveals actual prices.

---

## 🗂 Project Structure

```
bidarena/
├── backend/
│   ├── src/
│   │   ├── config/
│   │   │   ├── db.js          # NeonDB (PostgreSQL) + LISTEN/NOTIFY setup
│   │   │   └── websocket.js   # WebSocket server + bidding engine
│   │   ├── controllers/
│   │   │   ├── auth.controller.js
│   │   │   └── room.controller.js
│   │   ├── middleware/
│   │   │   ├── auth.middleware.js
│   │   │   ├── role.middleware.js
│   │   │   └── error.middleware.js
│   │   ├── routes/
│   │   │   ├── auth.routes.js
│   │   │   └── room.routes.js
│   │   ├── app.js
│   │   └── server.js
│   ├── .env.example
│   └── package.json
└── frontend/
    ├── css/
    │   └── style.css
    ├── js/
    │   └── app.js
    └── index.html
```

---

## ⚙️ Tech Stack

| Layer      | Technology                              |
|------------|-----------------------------------------|
| Frontend   | HTML, CSS, Vanilla JS                   |
| Backend    | Node.js, Express 5                      |
| Database   | PostgreSQL via NeonDB (serverless)      |
| Realtime   | WebSockets (`ws`) + PostgreSQL LISTEN/NOTIFY |
| Auth       | JWT (jsonwebtoken) + bcryptjs           |
| Email      | Nodemailer (SMTP)                       |
| Security   | Helmet, CORS, Cookie-Parser             |

---

## 🚀 Setup

### 1. Clone & install backend

```bash
cd backend
npm install
```

### 2. Configure environment

```bash
cp .env.example .env
```

Edit `.env`:

```
PORT=5000
DATABASE_URL=postgresql://user:password@ep-xxx.us-east-2.aws.neon.tech/bidarena?sslmode=require
JWT_SECRET=your_secret_here
JWT_EXPIRES_IN=7d
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=you@gmail.com
SMTP_PASS=your_app_password
EMAIL_FROM=BIDArena <you@gmail.com>
CLIENT_ORIGIN=http://localhost:3000
```

> **NeonDB**: Go to [neon.tech](https://neon.tech), create a project, copy the connection string.
> **Gmail**: Enable 2FA, generate an App Password at myaccount.google.com/apppasswords.

### 3. Start backend

```bash
npm run dev
```

Schema is auto-created on first run (tables, triggers, LISTEN/NOTIFY functions).

### 4. Serve frontend

Open `frontend/index.html` directly in a browser, OR use any static server:

```bash
npx serve frontend -p 3000
```

> If using `serve`, set `CLIENT_ORIGIN=http://localhost:3000` in `.env`.

---

## 🎮 How to Play

### Admin Flow
1. Register with role **Admin**
2. Create a Room
3. Add Items (name, description, actual price — kept hidden)
4. Click **▶ START BIDDING** on each item when ready
5. Click **■ END BIDDING** to close that item's auction
6. After all items are done, click **🔓 REVEAL PRICES**
7. All participants receive a leaderboard email

### Buyer Flow
1. Register with role **Buyer**
2. Join any open room
3. When an item is active, enter a bid amount and click **PLACE BID**
4. You have a **10-second exclusive window** — others cannot bid during this time
5. If no one outbids you within 10s, your bid is confirmed
6. Watch the live leaderboard and activity feed
7. After reveal, see your P&L per item

---

## 🔌 WebSocket Events

| Direction     | Event               | Description                        |
|---------------|---------------------|------------------------------------|
| Client → Srv  | `JOIN_ROOM`         | Join a room, get snapshot          |
| Client → Srv  | `PLACE_BID`         | Place a bid on active item         |
| Client → Srv  | `ADMIN_START_ITEM`  | Start bidding on an item           |
| Client → Srv  | `ADMIN_END_ITEM`    | Force-close bidding                |
| Client → Srv  | `ADMIN_REVEAL_PRICES` | Reveal all actual prices         |
| Srv → Client  | `ROOM_SNAPSHOT`     | Full room state on join            |
| Srv → Client  | `BID_WINDOW_OPEN`   | 10s bid window started             |
| Srv → Client  | `BID_COMMITTED`     | Bid confirmed after window         |
| Srv → Client  | `BID_REJECTED`      | Bid was rejected (reason included) |
| Srv → Client  | `ITEM_STARTED`      | Item bidding opened                |
| Srv → Client  | `ITEM_ENDED`        | Item bidding closed                |
| Srv → Client  | `LEADERBOARD`       | Updated leaderboard array          |
| Srv → Client  | `PRICES_REVEALED`   | All items with actual prices       |

---

## 🏗 Architecture Notes

- **PostgreSQL LISTEN/NOTIFY** triggers fire on every `INSERT INTO bids` and `UPDATE items`, which the server relays to all WebSocket clients in the relevant room — zero polling.
- **10-second bid window**: when a user bids, a timer starts. Other users are blocked. If the timer expires with no challenge, the bid commits. A higher bid by another user resets the timer.
- **No Redis** — all state is held in-process on the Node server and persisted directly to NeonDB.
- **JWT auth for WebSocket** — token passed as `?token=` query param on WS connect.

---

## 📧 Email

After `ADMIN_REVEAL_PRICES`, Nodemailer sends every room participant a styled HTML email with the top-5 leaderboard.

---

## 🛠 API Endpoints

```
POST   /api/v1/auth/register
POST   /api/v1/auth/login
GET    /api/v1/auth/me

GET    /api/v1/rooms
POST   /api/v1/rooms              (admin)
GET    /api/v1/rooms/:id
POST   /api/v1/rooms/:id/items    (admin)
DELETE /api/v1/rooms/:id/items/:itemId  (admin)
GET    /api/v1/rooms/:id/leaderboard
```
