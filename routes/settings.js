const express = require("express");
const Settings = require("../models/Settings");
const { protect, authorize } = require("../middleware/auth");
const router = express.Router();

router.get("/", protect, async (req, res) => {
  let settings = await Settings.findOne();
  if (!settings) settings = await Settings.create({});
  res.json({ settings });
});

router.put("/", protect, authorize("principal"), async (req, res) => {
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
