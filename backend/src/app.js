const express = require("express");
const path = require("path");
const morgan = require("morgan");
const cors = require("cors");
const helmet = require("helmet");
const cookieParser = require("cookie-parser");

const app = express();

app.use(helmet());
app.use(morgan("dev"));
app.use(cors({
  origin: "*", // Relaxed for Render deployment
  credentials: true
}));
app.use(express.json());
app.use(cookieParser());

// Routes
app.use("/api/v1/auth", require("./routes/auth.routes"));
app.use("/api/v1/rooms", require("./routes/room.routes"));

app.get("/health", (req, res) => res.json({ status: "ok" }));

// Error handler
app.use(require("./middleware/error.middleware"));

// Serve Frontend
app.use(express.static(path.join(__dirname, "../../frontend")));
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "../../frontend/index.html"));
});

module.exports = app;