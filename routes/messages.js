const express = require("express");
const Message = require("../models/Message");
const User = require("../models/User");
const { protect } = require("../middleware/auth");
const router = express.Router();

// GET /api/messages - inbox for the logged in user
router.get("/", protect, async (req, res) => {
  const messages = await Message.find({ to: req.user._id })
    .populate("from", "name initials color role")
    .sort("-createdAt");
  res.json({ messages });
});

// GET /api/messages/sent
router.get("/sent", protect, async (req, res) => {
  const messages = await Message.find({ from: req.user._id })
    .populate("to", "name initials color")
    .sort("-createdAt");
  res.json({ messages });
});

// GET /api/messages/contacts - people this user can message (teachers and
// every admin-layer account, so the oversight tier can query teachers,
// admins, and bursars, and everyone else can reach the office).
router.get("/contacts", protect, async (req, res) => {
  const contacts = await User.find({
    role: { $in: ["teacher", "principal", "admin", "juniorAdmin", "seniorBursar", "juniorBursar"] },
    _id: { $ne: req.user._id },
  }).select("name role subject principalTitle");
  res.json({ contacts });
});

// POST /api/messages
router.post("/", protect, async (req, res) => {
  try {
    const { to, subject, body } = req.body;
    const message = await Message.create({
      from: req.user._id,
      to,
      subject,
      body,
    });
    res.status(201).json({ message });
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

// PUT /api/messages/:id/read
router.put("/:id/read", protect, async (req, res) => {
  const message = await Message.findOneAndUpdate(
    { _id: req.params.id, to: req.user._id },
    { read: true },
    { new: true },
  );
  if (!message) return res.status(404).json({ message: "Message not found" });
  res.json({ message });
});

module.exports = router;
