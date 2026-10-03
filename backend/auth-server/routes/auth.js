const express = require("express");
const bcrypt = require("bcrypt");
const { createUser } = require("../models/User");

const router = express.Router();

// ───── Register ─────
router.post("/register", async (req, res) => {
  try {
    const usersCollection = req.app.locals.usersCollection;
    const { username, password, confirmPassword, role } = req.body;

    if (!username || !password || !confirmPassword || !role) {
      return res.status(400).json({ error: "All fields required" });
    }

    if (password !== confirmPassword) {
      return res.status(400).json({ error: "Passwords do not match" });
    }

    const existingUser = await usersCollection.findOne({ username });
    if (existingUser) {
      return res.status(409).json({ error: "User already exists" });
    }

    const status = role === "hospital" ? "pending" : "approved";
    const approvedAt = status === "approved" ? new Date() : null;

    const user = await createUser({
      username,
      password,
      role,
      status,
      approvedAt,
    });

    await usersCollection.insertOne(user);
    res.status(201).json({ message: "User registered successfully" });
  } catch (err) {
    console.error("Registration error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ───── Login ─────
router.post("/login", async (req, res) => {
  try {
    const usersCollection = req.app.locals.usersCollection;
    const { username, password } = req.body;

    if (!username || !password) {
      return res.status(400).json({ error: "All fields required" });
    }

    const user = await usersCollection.findOne({ username });
    if (!user) {
      return res.status(401).json({ error: "Invalid username or password" });
    }

    const match = await bcrypt.compare(password, user.passwordHash);
    if (!match) {
      return res.status(401).json({ error: "Incorrect password" });
    }

    if (user.role === "hospital" && user.status !== "approved") {
      return res.status(403).json({ error: "Awaiting admin approval" });
    }

    res.status(200).json({
      message: "Login successful",
      user: {
        username: user.username,
        role: user.role,
        status: user.status,
      },
    });
  } catch (err) {
    console.error("Login error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ───── Approve Hospital ─────
router.post("/approve/:username", async (req, res) => {
  try {
    const usersCollection = req.app.locals.usersCollection;
    const { username } = req.params;

    const result = await usersCollection.updateOne(
      { username, role: "hospital", status: "pending" },
      {
        $set: {
          status: "approved",
          approvedAt: new Date(),
        },
      }
    );

    if (result.modifiedCount === 1) {
      res.status(200).json({ message: "Hospital approved" });
    } else {
      res.status(404).json({ error: "Hospital not found or already approved" });
    }
  } catch (err) {
    console.error("Approval error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ───── Get All Pending Hospitals ─────
router.get("/pending-hospitals", async (req, res) => {
  try {
    const usersCollection = req.app.locals.usersCollection;

    const pending = await usersCollection
      .find({ role: "hospital", status: { $ne: "approved" } })
      .toArray();

    res.status(200).json(pending);
  } catch (err) {
    console.error("Error fetching pending hospitals:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

module.exports = router;