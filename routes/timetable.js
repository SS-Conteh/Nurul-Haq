const express = require("express");
const Timetable = require("../models/Timetable");
const { protect, authorize } = require("../middleware/auth");
const router = express.Router();

router.get("/", protect, async (req, res) => {
  const filter = {};
  if (req.query.classId) filter.classId = req.query.classId;
  const entries = await Timetable.find(filter)
    .populate("teacher", "name")
    .sort("day time");
  res.json({ entries });
});

router.post("/", protect, authorize("principal"), async (req, res) => {
  const entry = await Timetable.create(req.body);
  res.status(201).json({ entry });
});

// POST /api/timetable/bulk { classId, entries: [{day,time,subject,teacher,room}] }
// Replaces the whole week's timetable for one class in a single call — used
// by the principal's "Set Timetable" modal.
router.post("/bulk", protect, authorize("principal"), async (req, res) => {
  try {
    const { classId, entries } = req.body;
    if (!classId) return res.status(400).json({ message: "classId is required" });
    await Timetable.deleteMany({ classId });
    const created = await Timetable.insertMany(
      (entries || []).map((e) => ({ ...e, classId })),
    );
    res.status(201).json({ entries: created });
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

router.put("/:id", protect, authorize("principal"), async (req, res) => {
  const entry = await Timetable.findByIdAndUpdate(req.params.id, req.body, {
    new: true,
  });
  if (!entry)
    return res.status(404).json({ message: "Timetable entry not found" });
  res.json({ entry });
});

router.delete("/:id", protect, authorize("principal"), async (req, res) => {
  const entry = await Timetable.findByIdAndDelete(req.params.id);
  if (!entry)
    return res.status(404).json({ message: "Timetable entry not found" });
  res.json({ message: "Timetable entry removed" });
});

module.exports = router;
