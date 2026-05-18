const { pool } = require("../config/db");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");

const registerUser = async (req, res, next) => {
  const { name, email, password, role } = req.body;
  try {
    // Block if email already exists
    const existing = await pool.query("SELECT id FROM users WHERE email=$1", [email]);
    if (existing.rows.length > 0)
      return res.status(400).json({ success: false, message: "User already exists" });

    // Only one admin allowed globally
    const requestedRole = role === "admin" ? "admin" : "buyer";
    if (requestedRole === "admin") {
      const { rows: admins } = await pool.query("SELECT id FROM users WHERE role='admin'");
      if (admins.length > 0)
        return res.status(400).json({ success: false, message: "An admin already exists. Only one admin is allowed." });
    }

    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);

    // Admin gets no points (they are the host, not a bidder)
    const points = requestedRole === "admin" ? 0 : 10000;

    const { rows } = await pool.query(
      "INSERT INTO users(name,email,password,role,points) VALUES($1,$2,$3,$4,$5) RETURNING id,name,email,role,points",
      [name, email, hashedPassword, requestedRole, points]
    );
    const user = rows[0];
    const token = jwt.sign({ id: user.id, role: user.role, name: user.name }, process.env.JWT_SECRET, {
      expiresIn: process.env.JWT_EXPIRES_IN || "7d",
    });
    res.status(201).json({ success: true, message: "Registered", token, user });
  } catch (err) {
    next(err);
  }
};

const loginUser = async (req, res, next) => {
  const { email, password } = req.body;
  try {
    const { rows } = await pool.query("SELECT * FROM users WHERE email=$1", [email]);
    const user = rows[0];
    if (!user) return res.status(400).json({ success: false, message: "Invalid credentials" });

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) return res.status(400).json({ success: false, message: "Invalid credentials" });

    const token = jwt.sign({ id: user.id, role: user.role, name: user.name }, process.env.JWT_SECRET, {
      expiresIn: process.env.JWT_EXPIRES_IN || "7d",
    });
    res.json({
      success: true,
      message: "Login successful",
      token,
      user: { id: user.id, name: user.name, email: user.email, role: user.role, points: user.points },
    });
  } catch (err) {
    next(err);
  }
};

module.exports = { registerUser, loginUser };