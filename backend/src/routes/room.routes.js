const express = require("express");
const protect = require("../middleware/auth.middleware");
const authorizeRoles = require("../middleware/role.middleware");
const {
  getRooms,
  createRoom,
  getRoom,
  addItem,
  deleteItem,
  getLeaderboard,
  deleteRoom,
  resetPoints,
} = require("../controllers/room.controller");

const router = express.Router();

router.get("/", protect, getRooms);
router.post("/", protect, authorizeRoles("admin"), createRoom);
router.get("/:id", protect, getRoom);
router.post("/:id/items", protect, authorizeRoles("admin"), addItem);
router.delete("/:id/items/:itemId", protect, authorizeRoles("admin"), deleteItem);
router.get("/:id/leaderboard", protect, getLeaderboard);
router.delete("/:id", protect, authorizeRoles("admin"), deleteRoom);
router.post("/reset-points", protect, authorizeRoles("admin"), resetPoints);

module.exports = router;
