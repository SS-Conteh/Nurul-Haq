const express = require("express");
const { protect } = require("../middleware/auth");
const {
  configureWebPush,
  getPublicKey,
  saveSubscription,
  removeSubscription,
} = require("../utils/pushNotifications");

const router = express.Router();

// Public VAPID key is safe to expose to browsers. The private key never
// leaves the server and is only read from the server environment.
router.get("/public-key", protect, (req, res) => {
  configureWebPush();
  const publicKey = getPublicKey();
  if (!publicKey) {
    return res.status(503).json({ message: "Push notifications are not configured" });
  }
  res.json({ publicKey });
});

router.post("/subscribe", protect, async (req, res) => {
  try {
    await saveSubscription(req.user._id, req.body);
    res.status(201).json({ subscribed: true });
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

router.post("/unsubscribe", protect, async (req, res) => {
  await removeSubscription(req.user._id, req.body?.endpoint);
  res.json({ subscribed: false });
});

module.exports = router;
