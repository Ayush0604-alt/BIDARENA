require("dotenv").config();
const http = require("http");
const app = require("./app");
const { connectDB } = require("./config/db");
const { setupWebSocket } = require("./config/websocket");

const PORT = process.env.PORT || 5000;

const server = http.createServer(app);
setupWebSocket(server);

connectDB().then(() => {
  server.listen(PORT, () => {
    console.log(` BIDArena server running on port ${PORT}`);
    console.log(` WebSocket ready at ws://localhost:${PORT}/ws`);
  });
});