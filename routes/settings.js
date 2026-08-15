const express = require("express");
const Settings = require("../models/Settings");
const { protect, authorize } = require("../middleware/auth");
const router = express.Router();

// GET /api/settings/public - no login required. Powers the public landing
// page (school history, name, motto, logo) — nothing sensitive here, so it
// deliberately skips `protect`. IMPORTANT: this must be declared before the
// authenticated GET "/" below, or Express would try to match "public" as a
// param on that route instead.
router.get("/public", async (req, res) => {
  let settings = await Settings.findOne();
  if (!settings) settings = await Settings.create({});
  const { schoolName, motto, logoUrl, address, phone, schoolHistory, houseColors } = settings;
  res.json({ settings: { schoolName, motto, logoUrl, address, phone, schoolHistory, houseColors } });
});

router.get("/", protect, async (req, res) => {
  let settings = await Settings.findOne();
  if (!settings) settings = await Settings.create({});
  res.json({ settings });
});

// PUT /api/settings - General Admin only. Not even the Junior School Admin,
// the Principal, or a Bursar can change system settings — a Bursar may only
// ever read the fee amounts/academic year (via GET "/" above), never write.
router.put("/", protect, authorize("admin"), async (req, res) => {
  let settings = await Settings.findOne();
  if (!settings) settings = new Settings();
  Object.assign(settings, req.body);
  if (req.body.preferences)
    settings.preferences = {
      ...settings.preferences.toObject(),
      ...req.body.preferences,
    };
  await settings.save();
  res.json({ settings });
});

module.exports = router;
