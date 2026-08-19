const express = require("express");
const Assignment = require("../models/Assignment");
const Settings = require("../models/Settings");
const { protect, authorize } = require("../middleware/auth");
const { yearFilter, currentTermString } = require("../utils/academicYear");
const router = express.Router();

router.get("/", protect, async (req, res) => {
  const settings = await Settings.findOne();
  const filter = { ...yearFilter(settings?.academicYear, req.query.ay) };
  if (req.query.term) filter.term = req.query.term;
  if (req.user.role === "teacher") {
    // Teachers only ever see assignments THEY created, optionally narrowed
    // down further to one of the classes they teach.
    filter.teacher = req.user._id;
    if (req.query.classId) filter.classId = req.query.classId;
  } else if (req.user.role === "student") {
    filter.classId = req.user.classId;
  } else if (req.query.classId) {
    filter.classId = req.query.classId;
  }
  const assignments = await Assignment.find(filter)
    .populate("teacher", "name")
    .populate("classId", "name")
    .sort("dueDate");
  res.json({ assignments });
});

router.post(
  "/",
  protect,
  authorize("teacher", "principal", "juniorAdmin"),
  async (req, res) => {
    const body = { ...req.body };
    if (req.user.role === "teacher" && !body.subject) {
      body.subject = (req.user.subjects || [])[0] || "";
    }
    const settings = await Settings.findOne();
    const assignment = await Assignment.create({
      ...body,
      teacher: req.user._id,
      academicYear: settings?.academicYear || "",
      term: currentTermString(settings) || "",
    });
    await assignment.populate("classId", "name");
    res.status(201).json({ assignment });
  },
);

router.put(
  "/:id",
  protect,
  authorize("teacher", "principal", "juniorAdmin"),
  async (req, res) => {
    const assignment = await Assignment.findByIdAndUpdate(
      req.params.id,
      req.body,
      { new: true },
    );
    if (!assignment)
      return res.status(404).json({ message: "Assignment not found" });
    res.json({ assignment });
  },
);

// POST /api/assignments/:id/submit - student submits
router.post("/:id/submit", protect, authorize("student"), async (req, res) => {
  const assignment = await Assignment.findById(req.params.id);
  if (!assignment)
    return res.status(404).json({ message: "Assignment not found" });
  assignment.submissions.push({
    student: req.user._id,
    submittedAt: new Date(),
  });
  await assignment.save();
  res.json({ assignment });
});

router.delete(
  "/:id",
  protect,
  authorize("teacher", "principal", "juniorAdmin"),
  async (req, res) => {
    const assignment = await Assignment.findByIdAndDelete(req.params.id);
    if (!assignment)
      return res.status(404).json({ message: "Assignment not found" });
    res.json({ message: "Assignment removed" });
  },
);

module.exports = router;
