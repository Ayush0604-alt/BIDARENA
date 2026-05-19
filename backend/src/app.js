const express = require("express");
const path = require("path");
const morgan = require("morgan");
const cors = require("cors");
const helmet = require("helmet");
const cookieParser = require("cookie-parser");

const app = express();

app.use(helmet({ contentSecurityPolicy: false }));
app.use(morgan("dev"));
app.use(cors({
  origin: process.env.CLIENT_ORIGIN || true,
  credentials: true,
}));
app.use(express.json());
app.use(cookieParser());

// ─── API Routes ────────────────────────────────────────────────────────────
app.use("/api/v1/auth",  require("./routes/auth.routes"));
app.use("/api/v1/rooms", require("./routes/room.routes"));

app.get("/health", (req, res) => res.json({ status: "ok", ts: new Date().toISOString() }));

// ─── Serve Frontend (SPA) ──────────────────────────────────────────────────
const frontendPath = path.join(__dirname, "../../frontend");
app.use(express.static(frontendPath));
app.use((req, res) => {
  res.sendFile(path.join(frontendPath, "index.html"));
});

// ─── Global Error Handler ──────────────────────────────────────────────────
app.use(require("./middleware/error.middleware"));

module.exports = app;