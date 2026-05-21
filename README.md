Readme · MD
# BIDArena — Real-Time Auction Simulator
 
> A full-stack real-time auction platform demonstrating live database-to-client updates using PostgreSQL LISTEN/NOTIFY and WebSockets — built as an assignment submission.
 
![Node.js](https://img.shields.io/badge/Node.js-18%2B-339933?style=flat-square&logo=node.js&logoColor=white)
![PostgreSQL](https://img.shields.io/badge/PostgreSQL-NeonDB-4169E1?style=flat-square&logo=postgresql&logoColor=white)
![WebSocket](https://img.shields.io/badge/Realtime-WebSocket-010101?style=flat-square&logo=socket.io&logoColor=white)
![License](https://img.shields.io/badge/License-MIT-yellow?style=flat-square)
 
---
 
## What This Demonstrates
 
This project directly solves the assignment requirement: *clients must automatically receive updates whenever data changes in the database, without relying on polling.* The solution uses PostgreSQL's native `LISTEN/NOTIFY` mechanism to detect row-level changes instantly, and pushes those changes to connected browsers over a persistent WebSocket connection — with no client polling in the primary update path.
 
The auction domain was chosen deliberately because it makes real-time requirements concrete and immediately observable: every bid placed by one user must appear on every other connected user's screen within milliseconds. If the real-time pipeline fails, it is obvious. This makes the system easier to evaluate than a generic order tracker, while satisfying all the specified technical requirements.
 
The assignment's `orders` table (with `id`, `customer_name`, `product_name`, `status`, `updated_at`) maps directly onto the `items` and `bids` tables in this implementation — described in detail below.
 
---
 
## How It Works — The Real-Time Pipeline
 
Every state change in the database travels to every connected browser client through this pipeline:
 
```
┌─────────────────────────────────────────────────────────────────────┐
│                        REAL-TIME PIPELINE                           │
└─────────────────────────────────────────────────────────────────────┘
 
  Browser (Buyer A)          Node.js Server              PostgreSQL
  ─────────────────          ──────────────              ──────────
 
  [Place Bid] ──WS──────────▶ handlePlaceBid()
                                    │
                                    ▼
                              INSERT INTO bids          ┌──────────────┐
                              UPDATE items    ─────────▶│  DB Trigger  │
                                                        │notify_bid_   │
                                                        │update()      │
                                                        │notify_item_  │
                                                        │update()      │
                                                        └──────┬───────┘
                                                               │
                                                        pg_notify()
                                                               │
                              ┌────────────────────────────────┘
                              │  LISTEN client receives
                              │  notification on channel
                              ▼
                         broadcast() ──────────────────▶ All WebSocket
                                                         clients in room
 
  [UI updates] ◀──WS───────────────────────────────────────────────────
  Browser (All users in room)
```
 
**Step by step:**
 
1. A buyer places a bid — the browser sends a `PLACE_BID` WebSocket message to the server.
2. The server validates the bid and writes it to the `bids` table (INSERT) and updates the `items` table (UPDATE).
3. PostgreSQL triggers fire on both writes: `notify_bid_update()` and `notify_item_update()`. Each calls `pg_notify()` with a JSON payload on a named channel.
4. The Node server holds a single dedicated `LISTEN` client (separate from the connection pool) that is permanently subscribed to these channels. It receives the notification in under 100ms.
5. The server calls `broadcast()`, which iterates over the `Set` of WebSocket clients for that room and sends the update to every open connection.
6. Every connected browser — including Buyer A who placed the bid, Buyer B watching, and the Admin — updates its UI simultaneously.
**No polling.** The only fallback polling (leaderboard refresh, every 15 seconds) only activates when a client's WebSocket is disconnected.
 
---
 
## Assignment Mapping — `orders` Table vs. This Implementation
 
The assignment specifies a table called `orders` with specific fields. Here is how each field and operation maps to this project:
 
| Assignment requirement | This implementation | Table / column |
|---|---|---|
| `id` | Item primary key | `items.id` |
| `customer_name` | Buyer who wins the item | `items.winner_id` → `users.name` |
| `product_name` | The auctioned item name | `items.name` |
| `status` (pending / shipped / delivered) | Item auction state | `items.status` (pending / active / finished) |
| `updated_at` | Timestamp of last state change | `items.bidding_end` |
| INSERT event | A buyer places a new bid | `INSERT INTO bids` → triggers `notify_bid_update` |
| UPDATE event | Item status changes (start / end / reveal) | `UPDATE items` → triggers `notify_item_update` |
| DELETE event | Admin removes a pending item | `DELETE FROM items` (no notify needed; room snapshot refreshes on rejoin) |
| Client receives automatic update | Browser UI re-renders without refresh | WebSocket `BID_PLACED`, `ITEM_STARTED`, `ITEM_ENDED`, `PRICES_REVEALED` |
 
---
 
## Project Structure
 
```
bidarena/
├── backend/
│   ├── src/
│   │   ├── config/
│   │   │   ├── db.js            # NeonDB (PostgreSQL) pool + LISTEN/NOTIFY client
│   │   │   └── websocket.js     # WebSocket server, bidding engine, email dispatch
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
│   │   ├── app.js               # Express app, middleware, route registration
│   │   └── server.js            # HTTP server entry point
│   ├── .env.example
│   └── package.json
└── frontend/
    ├── css/
    │   └── style.css
    ├── js/
    │   └── app.js               # All client-side logic: auth, WS, rendering
    └── index.html
```
 
---
 
## Tech Stack
 
| Layer | Technology | Why chosen |
|---|---|---|
| Frontend | HTML, CSS, Vanilla JS | No build step required; keeps the demo self-contained and easy to evaluate locally |
| Backend | Node.js + Express 5 | Non-blocking I/O suits high-concurrency WebSocket workloads; Express 5 has native async error handling |
| Database | PostgreSQL via NeonDB | Native `LISTEN/NOTIFY` support; NeonDB provides a free serverless instance with built-in connection pooling — no self-hosted DB needed |
| Realtime | `ws` + PostgreSQL LISTEN/NOTIFY | WebSockets for bidirectional client communication; LISTEN/NOTIFY for zero-overhead DB change detection |
| Auth | JWT + bcryptjs | Stateless JWT works well with WebSocket connections (token passed as query param on WS connect); bcrypt handles password hashing |
| Email | Nodemailer (SMTP) | Simple, dependency-light email delivery for result notifications |
| Security | Helmet, CORS, cookie-parser | Standard Express hardening; Helmet sets secure HTTP headers; CORS restricts origin |
| Deployment | Render (`render.yaml` included) | Free-tier hosting for Node services; zero-config deploy from the repo |
 
---
 
## Setup
 
### Prerequisites
 
- Node.js 18 or higher
- A PostgreSQL database — [NeonDB free tier](https://neon.tech) is recommended (no setup beyond creating a project and copying the connection string). Any standard PostgreSQL 14+ instance works.
- An SMTP account for email (Gmail App Password recommended). I have deployed it currently on Render using free tier which does not support opening of SMTP Port.
![image ](image.png)

### Live link: https://bidarena-cky5.onrender.com

### OR

### 1. Clone and install
 
```bash
git clone https://github.com/your-username/bidarena.git
cd bidarena/backend
npm install
```
 
### 2. Configure environment variables
 
```bash
cp .env.example .env
```
 
Open `.env` and fill in the following:
 
| Variable | Description |
|---|---|
| `PORT` | Port for the HTTP/WebSocket server. Default: `5000` |
| `DATABASE_URL` | Full PostgreSQL connection string. From NeonDB: copy the connection string from your project dashboard. |
| `JWT_SECRET` | Any long random string used to sign JWT tokens. |
| `JWT_EXPIRES_IN` | Token lifetime. Example: `7d` |
| `SMTP_HOST` | SMTP server hostname. Example: `smtp.gmail.com` |
| `SMTP_PORT` | SMTP port. `587` for TLS, `465` for SSL |
| `SMTP_USER` | Your email address |
| `SMTP_PASS` | Your email app password (for Gmail: generate at myaccount.google.com/apppasswords) |
| `EMAIL_FROM` | Display name + address for outbound emails. Example: `BIDArena <you@gmail.com>` |
| `CLIENT_ORIGIN` | Frontend origin for CORS. Example: `http://localhost:3000` |
 
Example `.env`:
 
```env
PORT=5000
DATABASE_URL=postgresql://user:password@ep-xxx.us-east-2.aws.neon.tech/bidarena?sslmode=require
JWT_SECRET=some_long_random_secret_here
JWT_EXPIRES_IN=7d
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=you@gmail.com
SMTP_PASS=your_app_password
EMAIL_FROM=BIDArena <you@gmail.com>
CLIENT_ORIGIN=http://localhost:3000
```
 
### 3. Start the backend
 
```bash
npm run dev       # development — nodemon watches for changes
# or
npm start         # production
```
 
The server starts on `http://localhost:5000`. The database schema (all tables and triggers) is created automatically on first run — no migration step needed.
 
You should see:
 
```
✅ NeonDB connected
✅ Schema ready
✅ SMTP ready — smtp.gmail.com   (only if SMTP is configured)
   BIDArena server running on port 5000
   WebSocket ready at ws://localhost:5000/ws
```
 
### 4. Serve the frontend
 
Option A — open directly in a browser (simplest):
 
```bash
open frontend/index.html
# or just double-click the file
```
 
Option B — serve from a local static server (required if you want the frontend to communicate with the backend running on a different port):
 
```bash
npx serve frontend -p 3000
```
 
Then open `http://localhost:3000`.
 
### 5. Testing real-time updates
 
The simplest way to verify the real-time pipeline end-to-end:
 
1. Open **two browser tabs** (or two different browsers).
2. In **Tab 1**: register as `Admin`, create a room, add one item.
3. In **Tab 2**: register as `Buyer`, join the same room.
4. In **Tab 1**: click **START BIDDING** on the item.
5. In **Tab 2**: place a bid. Watch Tab 1 update instantly — no page refresh, no polling.
6. Observe the 15-second countdown bar reset on every new bid across both tabs simultaneously.
Any bid placed in one tab appears in every other tab within milliseconds, delivered through the PostgreSQL → Node → WebSocket pipeline.
 
---
 
## How to Play
 
### Admin Flow
 
1. Register with role **Admin**
2. Create a Room — give it a name, optionally set a maximum player count
3. Add Items — for each item set a name, a description, and an **actual price** (kept secret from buyers)
4. Click **▶ START BIDDING** on an item to open it for bids — only one item can be active at a time
5. After each bid, a 15-second countdown starts and is visible to all players; a new bid resets the clock
6. If no bid arrives within 15 seconds, the item auto-closes and the current highest bidder wins
7. Click **■ END BIDDING** to force-close an item immediately at any time
8. Once all items are finished, click **🔓 REVEAL PRICES** — actual prices are shown to all players, P&L is calculated for each buyer, and result emails are sent to every participant
### Buyer Flow
 
1. Register with role **Buyer**
2. Join any open room from the lobby
3. On entering a room, receive **10,000 fresh points** (room-scoped — not carried between rooms)
4. When an item is active, enter a bid amount and click **PLACE BID** — your points are held immediately
5. If outbid, your points are refunded and the new bidder's points are held
6. Watch the 15-second countdown bar — place a higher bid before it hits zero to take the lead
7. When an item closes, the winner is announced with a banner and sound; if you won, you receive an email
8. After the admin reveals prices, your **P&L per item** is shown (actual price minus your winning bid)
9. On leaving the room, your points reset — you start fresh at 10,000 when you enter any new room
---
 
## WebSocket Events
 
### Client → Server
 
| Event | Description |
|---|---|
| `JOIN_ROOM` | Join a room by ID. Server responds with a full `ROOM_SNAPSHOT`. |
| `PLACE_BID` | Place a bid on the currently active item. Payload: `{ itemId, amount }` |
| `ADMIN_START_ITEM` | (Admin) Open an item for bidding. Payload: `{ itemId }` |
| `ADMIN_END_ITEM` | (Admin) Force-close the active item immediately. Payload: `{ itemId }` |
| `ADMIN_REVEAL_PRICES` | (Admin) Reveal actual prices and end the game. Payload: `{ roomId }` |
| `GET_LEADERBOARD` | Request the current leaderboard for a room. |
| `PING` | Keep-alive ping. Server responds with `PONG`. |
 
### Server → Client
 
| Event | Description |
|---|---|
| `ROOM_SNAPSHOT` | Full room state sent on join: room metadata, all items, top bids, active countdowns |
| `ROOM_POINTS` | Updated room-scoped point balance for the receiving client only |
| `BID_PLACED` | A new bid was placed: bidder name, amount, countdown reset timestamp |
| `ITEM_STARTED` | An item has been opened for bidding by the admin |
| `ITEM_ENDED` | An item's auction has closed: winner name, winning bid, end reason (timeout or admin) |
| `ITEM_UPDATE` | A partial item update relayed directly from the PostgreSQL LISTEN client |
| `LEADERBOARD` | Updated leaderboard array for all players in the room |
| `PRICES_REVEALED` | All items with actual prices revealed; triggers results UI for all clients |
| `POINTS_RESET` | Admin has reset all player points to 10,000 |
| `BID_REJECTED` | The client's bid was rejected, with a human-readable reason |
| `USER_JOINED` | Another user has joined the room |
| `ERROR` | A server-side error with a reason string |
| `PONG` | Response to a client `PING` |
| `REAUTH_REQUIRED` | JWT is close to expiry; client should re-authenticate |
 
---
 
## API Reference
 
### Auth
 
| Method | Path | Auth | Description |
|---|---|---|---|
| `POST` | `/api/v1/auth/register` | None | Register a new user. Body: `{ name, email, password, role }`. Role is `buyer` or `admin`. |
| `POST` | `/api/v1/auth/login` | None | Login. Body: `{ email, password }`. Returns a JWT. |
| `GET` | `/api/v1/auth/me` | Bearer JWT | Returns the authenticated user from the token. |
 
### Rooms
 
| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/api/v1/rooms` | Bearer JWT | List all rooms with participant and item counts. |
| `POST` | `/api/v1/rooms` | Admin JWT | Create a new room. Body: `{ name, max_players? }` |
| `GET` | `/api/v1/rooms/:id` | Bearer JWT | Get full room detail: room, items, top bids, all bids. |
| `PATCH` | `/api/v1/rooms/:id` | Admin JWT | Update room settings (currently: `max_players`). |
| `DELETE` | `/api/v1/rooms/:id` | Admin JWT | Delete a room and all its items and bids. |
| `POST` | `/api/v1/rooms/:id/items` | Admin JWT | Add an item to a room. Body: `{ name, description?, actual_price, display_order }` |
| `DELETE` | `/api/v1/rooms/:id/items/:itemId` | Admin JWT | Delete a pending item from a room. |
| `GET` | `/api/v1/rooms/:id/leaderboard` | Bearer JWT | Get the current leaderboard for a room (used as polling fallback). |
| `POST` | `/api/v1/rooms/reset-points` | Admin JWT | Reset all room-scoped player points to 10,000. |
 
---
 
## Why I Built It This Way
 
This section directly answers the assignment's requirement to explain the approach and method choices.
 
### 1. PostgreSQL LISTEN/NOTIFY instead of polling
 
Polling requires every connected client to send a query to the database on a timer, meaning database load scales linearly with the number of clients and the poll frequency. With 50 buyers polling every second, that is 50 queries per second doing nothing useful when no data has changed.
 
`LISTEN/NOTIFY` inverts this: the database pushes a notification to the server only when a row actually changes. The server holds one persistent listener connection regardless of how many WebSocket clients are connected. This means the database load from change detection is constant — it does not grow with client count at all.
 
Notifications arrive in under 100ms in practice, and the mechanism is built into PostgreSQL with no additional infrastructure required.
 
### 2. WebSockets instead of Server-Sent Events (SSE) or long-polling
 
SSE is unidirectional — the server can push to the client, but the client cannot send messages back over the same connection. In an auction, clients actively send bids, not just receive updates. Using SSE would require a separate HTTP request for every bid placed, adding latency and connection overhead.
 
WebSockets provide a single persistent bidirectional connection per client. Bids travel server-bound on the same socket that delivers updates back. This is well-suited to the auction room model where a client is simultaneously a sender (bids) and a receiver (other people's bids, countdowns, leaderboard changes).
 
### 3. Room-scoped points instead of global points
 
A buyer's point balance has no meaning outside the context of a specific auction room. Persisting points globally to the users table would create confusion — points earned in room A should not affect room B, and points should reset to a fair starting value at the beginning of every game.
 
By storing points in a separate `room_player_points` table keyed by `(room_id, user_id)`, each auction is fully isolated. The reset-on-leave behaviour means there is no stale state to clean up between games, and the admin's reset endpoint can instantly restore fairness mid-session.
 
### 4. NeonDB serverless PostgreSQL
 
NeonDB provides a fully managed PostgreSQL instance on a free tier with built-in connection pooling, which removes the need to run or maintain a database server for a demo or assignment submission. It is compatible with the standard `pg` Node.js driver with no code changes — the only difference from a self-hosted instance is the connection string.
 
The LISTEN/NOTIFY mechanism requires a long-lived connection, which NeonDB supports via a dedicated connection outside the pool. This is handled in `db.js` with `getListenerClient()`.
 
### 5. No Redis
 
All ephemeral state — active bid windows, per-room WebSocket client sets, countdown timers — is held in Node.js process memory. All persistent state is in PostgreSQL. This keeps the architecture simple: one Node process, one database, zero additional services to configure.
 
The trade-off is that this only works correctly on a single server instance. If the application is scaled horizontally to multiple Node processes, each would have a separate set of in-memory state and a separate pool of WebSocket connections, so a bid processed by server A would not reach clients connected to server B. The correct fix is to add Redis Pub/Sub as a cross-process message bus. This is documented under Known Limitations.
 
---
 
## Email Notifications
 
After the admin triggers **REVEAL PRICES**, Nodemailer sends each participant a styled HTML email containing:
 
- Their personal P&L breakdown per item (winning bid vs. actual price)
- The top 5 leaderboard for the session
- Net worth calculation (remaining points + actual value of items won)
The winner of each individual item also receives a separate notification email the moment their bid is confirmed.
 
**Note on the Render deployment:** The live demo is deployed on Render's free tier, which blocks outbound SMTP connections on port 587. Email delivery therefore does not work on the deployed instance. The feature works correctly when running locally with a valid SMTP configuration. The screenshot below shows an actual result email received during local development testing.
 
> 📎 *(See attached screenshot — `email-screenshot.png` — showing a received leaderboard result email from a local test session.)*
 
---
 
## Known Limitations and Future Improvements
 
**Single-server only (no horizontal scaling)**
In-process state (bid window timers, `roomClients` map) is not shared between processes. Deploying multiple Node instances behind a load balancer would break real-time consistency. The fix is Redis Pub/Sub for cross-process WebSocket broadcasting. This is a deliberate trade-off for simplicity given the single-server assignment context.
 
**In-process timers lost on restart**
The 15-second bid countdown is implemented using `setTimeout` in Node's event loop. If the server restarts mid-auction (crash, redeploy), active timers are lost. Items in `active` status will remain stuck until an admin manually ends them. A production fix would persist timer state to the database and restore it on startup.
 
**No rate limiting on REST endpoints**
The WebSocket bid handler has rate limiting (max 8 bids per 10 seconds per user). The REST API endpoints have no equivalent — a malicious client could hammer `/api/v1/rooms` or the auth endpoints. Adding `express-rate-limit` middleware per route group would address this.
 
**No WebSocket authentication refresh**
The JWT is verified once at WebSocket connection time. If a token expires mid-session, the client receives a `REAUTH_REQUIRED` message but must reconnect entirely. A more robust approach would support token refresh over the WebSocket channel without disconnecting.
 
---
 
## License
 
MIT — see [LICENSE](LICENSE) for details.