const express = require("express");
const Timetable = require("../models/Timetable");
const Settings = require("../models/Settings");
const { protect, authorize } = require("../middleware/auth");
const { yearFilter } = require("../utils/academicYear");
const router = express.Router();

router.get("/", protect, async (req, res) => {
  const settings = await Settings.findOne();
  const filter = { ...yearFilter(settings?.academicYear, req.query.ay) };
  if (req.query.classId) filter.classId = req.query.classId;
  const entries = await Timetable.find(filter)
    .populate("teacher", "name")
    .sort("sortOrder day");
  res.json({ entries });
});

router.post("/", protect, authorize("admin", "juniorAdmin"), async (req, res) => {
  const settings = await Settings.findOne();
  const entry = await Timetable.create({
    ...req.body,
    academicYear: settings?.academicYear || "",
  });
  res.status(201).json({ entry });
});

// POST /api/timetable/bulk { classId, entries: [{day,time,sortOrder,isBreak,subject,teacher,room}] }
// Replaces the whole week's timetable for one class in a single call — used
// by the principal's "Set Timetable" modal. Each period row the admin adds
// (with its own free-text time label) becomes one entry per day it's not
// left blank for; break rows are stored once per day too (isBreak: true,
// no subject) so the display grid can show a "Break" row in every column.
router.post("/bulk", protect, authorize("admin", "juniorAdmin"), async (req, res) => {
  try {
    const { classId, entries } = req.body;
    if (!classId) return res.status(400).json({ message: "classId is required" });
    const settings = await Settings.findOne();
    const academicYear = settings?.academicYear || "";
    // Only replace THIS class's entries for the CURRENT academic year —
    // a past year's timetable (still tagged with its own academicYear, or
    // "" if it predates this field) is never touched by a bulk re-set.
    await Timetable.deleteMany({ classId, academicYear });
    const created = await Timetable.insertMany(
      (entries || []).map((e) => ({ ...e, classId, academicYear })),
    );
    res.status(201).json({ entries: created });
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

router.put("/:id", protect, authorize("admin", "juniorAdmin"), async (req, res) => {
  const entry = await Timetable.findByIdAndUpdate(req.params.id, req.body, {
    new: true,
  });
  if (!entry)
    return res.status(404).json({ message: "Timetable entry not found" });
  res.json({ entry });
});

router.delete("/:id", protect, authorize("admin", "juniorAdmin"), async (req, res) => {
  const entry = await Timetable.findByIdAndDelete(req.params.id);
  if (!entry)
    return res.status(404).json({ message: "Timetable entry not found" });
  res.json({ message: "Timetable entry removed" });
});

module.exports = router;
