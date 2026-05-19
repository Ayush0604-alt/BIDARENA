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
  updateRoom,
} = require("../controllers/room.controller");

const router = express.Router();

router.get("/", protect, getRooms);
router.post("/reset-points", protect, authorizeRoles("admin"), resetPoints); // must be before /:id
router.post("/", protect, authorizeRoles("admin"), createRoom);
router.get("/:id", protect, getRoom);
router.patch("/:id", protect, authorizeRoles("admin"), updateRoom);
router.post("/:id/items", protect, authorizeRoles("admin"), addItem);
router.delete("/:id/items/:itemId", protect, authorizeRoles("admin"), deleteItem);
router.get("/:id/leaderboard", protect, getLeaderboard);
router.delete("/:id", protect, authorizeRoles("admin"), deleteRoom);

module.exports = router;