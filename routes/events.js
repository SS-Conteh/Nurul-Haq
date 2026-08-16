const express = require("express");
const Event = require("../models/Event");
const Settings = require("../models/Settings");
const { protect, authorize } = require("../middleware/auth");
const { yearFilter } = require("../utils/academicYear");
const router = express.Router();

router.get("/", protect, async (req, res) => {
  const settings = await Settings.findOne();
  const events = await Event.find(yearFilter(settings?.academicYear, req.query.ay)).sort("date");
  res.json({ events });
});

router.post("/", protect, authorize("admin", "juniorAdmin"), async (req, res) => {
  const settings = await Settings.findOne();
  const event = await Event.create({
    ...req.body,
    createdBy: req.user._id,
    academicYear: settings?.academicYear || "",
  });
  res.status(201).json({ event });
});

router.put("/:id", protect, authorize("admin", "juniorAdmin"), async (req, res) => {
  const event = await Event.findByIdAndUpdate(req.params.id, req.body, {
    new: true,
  });
  if (!event) return res.status(404).json({ message: "Event not found" });
  res.json({ event });
});

router.delete("/", protect, authorize("admin", "juniorAdmin"), async (req, res) => {
  await Event.deleteMany({});
  res.json({ message: "All events cleared" });
});

router.delete("/:id", protect, authorize("admin", "juniorAdmin"), async (req, res) => {
  const event = await Event.findByIdAndDelete(req.params.id);
  if (!event) return res.status(404).json({ message: "Event not found" });
  res.json({ message: "Event removed" });
});

module.exports = router;
