const express = require("express");
const SchoolClass = require("../models/SchoolClass");
const User = require("../models/User");
const Grade = require("../models/Grade");
const { protect, authorize } = require("../middleware/auth");

const router = express.Router();

// GET /api/classes/public - no auth. Minimal class list (name/level/group/
// subjects only) so the public Teacher/Staff sign-up form can populate its
// Level / Class / Subject dropdowns before the person has an account.
router.get("/public", async (req, res) => {
  const classes = await SchoolClass.find()
    .select("name level classGroup subjects")
    .sort("name")
    .lean();
  res.json({ classes });
});

// GET /api/classes/meta - fixed level + class-group lists for dropdowns
router.get("/meta", protect, (req, res) => {
  res.json({
    levels: SchoolClass.LEVELS,
    classGroups: SchoolClass.CLASS_GROUPS,
  });
});

// GET /api/classes?level=Primary&classGroup=Class%201
router.get("/", protect, async (req, res) => {
  const filter = {};
  if (req.query.level) filter.level = req.query.level;
  if (req.query.classGroup) filter.classGroup = req.query.classGroup;
  // Junior School Admin (Nursery-JSS) never sees SSS classes.
  if (req.user.role === "juniorAdmin") {
    filter.level = filter.level && filter.level !== "SSS" ? filter.level : { $ne: "SSS" };
  }
  const classes = await SchoolClass.find(filter)
    .populate("classTeacher", "name initials color")
    .lean();

  const classIds = classes.map((c) => c._id);

  // One aggregation instead of 2 extra queries per class (N+1): join each
  // student to their grades and roll everything up per classId in the DB.
  const stats = classIds.length
    ? await User.aggregate([
        { $match: { role: "student", classId: { $in: classIds } } },
        {
          $lookup: {
            from: "grades",
            localField: "_id",
            foreignField: "student",
            as: "grades",
          },
        },
        {
          $group: {
            _id: "$classId",
            studentCount: { $sum: 1 },
            totalScore: { $sum: { $sum: "$grades.total" } },
            gradeCount: { $sum: { $size: "$grades" } },
          },
        },
      ])
    : [];

  const statsByClass = {};
  stats.forEach((s) => {
    statsByClass[String(s._id)] = {
      studentCount: s.studentCount,
      avgPerformance: s.gradeCount
        ? Math.round(s.totalScore / s.gradeCount)
        : 0,
    };
  });

  const enriched = classes.map((c) => ({
    ...c,
    studentCount: statsByClass[String(c._id)]?.studentCount || 0,
    subjectCount: (c.subjects || []).length,
    avgPerformance: statsByClass[String(c._id)]?.avgPerformance || 0,
  }));

  res.json({ classes: enriched });
});

// POST /api/classes - admin, or juniorAdmin (Nursery-JSS only). The
// Principal can view classes but never registers one.
router.post("/", protect, authorize("admin", "juniorAdmin"), async (req, res) => {
  try {
    if (req.user.role === "juniorAdmin" && req.body.level === "SSS") {
      return res.status(403).json({
        message: "A Junior School Admin cannot register an SSS class",
      });
    }
    const cls = await SchoolClass.create(req.body);
    res.status(201).json({ class: cls });
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

// PUT /api/classes/:id - admin / juniorAdmin only. The Principal can view
// classes but never edits one.
router.put("/:id", protect, authorize("admin", "juniorAdmin"), async (req, res) => {
  if (req.user.role === "juniorAdmin") {
    const existing = await SchoolClass.findById(req.params.id);
    if (!existing) return res.status(404).json({ message: "Class not found" });
    if (existing.level === "SSS" || req.body.level === "SSS") {
      return res.status(403).json({
        message: "A Junior School Admin cannot manage an SSS class",
      });
    }
  }
  const cls = await SchoolClass.findByIdAndUpdate(req.params.id, req.body, {
    new: true,
  });
  if (!cls) return res.status(404).json({ message: "Class not found" });
  res.json({ class: cls });
});

// DELETE /api/classes/:id - admin / juniorAdmin only. The Principal can
// view classes but never removes one.
router.delete("/:id", protect, authorize("admin", "juniorAdmin"), async (req, res) => {
  const existing = await SchoolClass.findById(req.params.id);
  if (!existing) return res.status(404).json({ message: "Class not found" });
  if (req.user.role === "juniorAdmin" && existing.level === "SSS") {
    return res.status(403).json({ message: "A Junior School Admin cannot remove an SSS class" });
  }
  await existing.deleteOne();
  res.json({ message: "Class removed" });
});

module.exports = router;
