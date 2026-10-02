const express = require("express");
const Behavior = require("../models/Behavior");
const { protect, authorize } = require("../middleware/auth");
const { sectionScope, scopedClassIds, studentInScope } = require("../utils/accessScope");
const router = express.Router();

router.get("/", protect, async (req, res) => {
  const filter = {};
  if (req.query.studentId) filter.student = req.query.studentId;
  if (req.user.role === "student") filter.student = req.user._id;

  let records = await Behavior.find(filter).populate({ path: "student", select: "name classId", populate: { path: "classId", select: "level name" } }).sort("-date");
  const scope = sectionScope(req.user);
  if (scope !== "all") records = records.filter((r) => r.student?.classId && (scope === "junior" ? r.student.classId.level !== "SSS" : r.student.classId.level === "SSS"));
  res.json({ records });
});

router.post(
  "/",
  protect,
  authorize("teacher", "principal"),
  async (req, res) => {
    if (sectionScope(req.user) !== "all" && !(await studentInScope(req.user, req.body.student))) return res.status(403).json({ message: "This student is outside your school section" });
    const record = await Behavior.create({
      ...req.body,
      recordedBy: req.user._id,
    });
    res.status(201).json({ record });
  },
);

router.put(
  "/:id",
  protect,
  authorize("teacher", "principal"),
  async (req, res) => {
    const record = await Behavior.findByIdAndUpdate(req.params.id, req.body, {
      new: true,
    });
    if (!record)
      return res.status(404).json({ message: "Behavior record not found" });
    res.json({ record });
  },
);

module.exports = router;
