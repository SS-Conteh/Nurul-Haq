const express = require("express");
const User = require("../models/User");
const Attendance = require("../models/Attendance");
const SchoolClass = require("../models/SchoolClass");
const { protect, authorize } = require("../middleware/auth");

const router = express.Router();

// Keep SchoolClass.classTeacher as a backwards-compatible pointer to the
// teacher assigned as master. The authoritative multi-class relationship is
// User.classMasterOf. Each class still has at most one master.
async function syncClassMasters(teacherId, oldClassIds = [], newClassIds = []) {
  const oldIds = [...new Set((oldClassIds || []).map(String))];
  const newIds = [...new Set((newClassIds || []).map(String))];
  const removed = oldIds.filter((id) => !newIds.includes(id));
  for (const id of removed) {
    await SchoolClass.updateOne({ _id: id, classTeacher: teacherId }, { $unset: { classTeacher: "" } });
  }
  for (const id of newIds) {
    const previousMasters = await User.find({
      $or: [{ classMasterOf: id }, { classTeacherOf: id }],
      _id: { $ne: teacherId },
      role: "teacher",
    });
    for (const previous of previousMasters) {
      previous.classMasterOf = (previous.classMasterOf || []).filter((x) => String(x) !== id);
      if (previous.classTeacherOf && String(previous.classTeacherOf) === id) previous.classTeacherOf = previous.classMasterOf[0] || null;
      if (!previous.classMasterOf.length) previous.teacherRole = "Subject Teacher";
      await previous.save();
    }
    await SchoolClass.updateOne({ _id: id }, { $set: { classTeacher: teacherId } });
  }
}

function normalizeTeacherAssignments(body = {}) {
  const classMasterOf = Array.isArray(body.classMasterOf)
    ? body.classMasterOf.filter(Boolean)
    : (body.classTeacherOf ? [body.classTeacherOf] : []);
  const classesTaught = Array.isArray(body.classesTaught) ? body.classesTaught.filter(Boolean) : [];
  const levelsTaught = Array.isArray(body.levelsTaught) ? body.levelsTaught.filter(Boolean) : [];
  return {
    classMasterOf: [...new Set(classMasterOf)],
    classesTaught: [...new Set(classesTaught)],
    levelsTaught: [...new Set(levelsTaught)],
  };
}

// GET /api/teachers?level=Primary&teacherRole=Class%20Master
// Only ever returns Approved teachers — self-signups still awaiting the
// Principal's approval live in /pending instead.
router.get("/", protect, async (req, res) => {
  const filter = { role: "teacher", approvalStatus: { $ne: "Pending" } };
  if (req.query.level) filter.$or = [{ levelsTaught: req.query.level }, { level: req.query.level }];
  if (req.query.teacherRole) filter.teacherRole = req.query.teacherRole;
  // Junior School Admin (Nursery-JSS) never sees SSS-level teachers.
  if (req.user.role === "juniorAdmin") {
    if (req.query.level === "SSS") return res.json({ teachers: [], count: 0 });
    if (req.query.level) filter.$or = [{ levelsTaught: req.query.level }, { level: req.query.level }];
    else filter.levelsTaught = { $in: ["Nursery", "Primary", "JSS"] };
  }
  const teachers = await User.find(filter)
    .populate("classTeacherOf", "name level classGroup")
    .populate("classMasterOf", "name level classGroup")
    .populate("classesTaught", "name level classGroup")
    .sort("name");
  res.json({
    teachers: teachers.map((t) => t.toSafeObject()),
    count: teachers.length,
  });
});

// GET /api/teachers/pending - General Admin / Junior School Admin only. The
// Principal can view teachers but never handles approvals, so is
// deliberately left out here.
router.get("/pending", protect, authorize("admin", "juniorAdmin"), async (req, res) => {
  const pendingFilter = { role: "teacher", approvalStatus: "Pending" };
  if (req.user.role === "juniorAdmin") {
    pendingFilter.levelsTaught = { $in: ["Nursery", "Primary", "JSS"] };
  }
  const pending = await User.find(pendingFilter)
    .populate("classTeacherOf", "name level classGroup")
    .populate("classMasterOf", "name level classGroup")
    .populate("classesTaught", "name level classGroup")
    .sort("-createdAt");
  res.json({
    teachers: pending.map((t) => t.toSafeObject()),
    count: pending.length,
  });
});

// POST /api/teachers/pending/:id/approve - General Admin / Junior School
// Admin only. Moves a self-registered signup into the real Teachers table.
// The Principal can view teachers but never approves them.
router.post(
  "/pending/:id/approve",
  protect,
  authorize("admin", "juniorAdmin"),
  async (req, res) => {
    try {
      const teacher = await User.findOne({
        _id: req.params.id,
        role: "teacher",
        approvalStatus: "Pending",
      });
      if (!teacher) {
        return res.status(404).json({ message: "Pending signup not found" });
      }
      teacher.approvalStatus = "Approved";
      await teacher.save();
      if (teacher.teacherRole === "Class Master") {
        await syncClassMasters(teacher._id, [], teacher.classMasterOf?.length ? teacher.classMasterOf : (teacher.classTeacherOf ? [teacher.classTeacherOf] : []));
      }
      res.json({ teacher: teacher.toSafeObject() });
    } catch (err) {
      res.status(400).json({ message: err.message });
    }
  },
);

// DELETE /api/teachers/pending/:id - General Admin / Junior School Admin
// only. Declines a self-registered signup and removes it entirely.
router.delete(
  "/pending/:id",
  protect,
  authorize("admin", "juniorAdmin"),
  async (req, res) => {
    const teacher = await User.findOneAndDelete({
      _id: req.params.id,
      role: "teacher",
      approvalStatus: "Pending",
    });
    if (!teacher) {
      return res.status(404).json({ message: "Pending signup not found" });
    }
    res.json({ message: "Signup declined" });
  },
);

// GET /api/teachers/:id
router.get("/:id", protect, async (req, res) => {
  const teacher = await User.findOne({
    _id: req.params.id,
    role: "teacher",
  })
    .populate("classTeacherOf", "name level classGroup")
    .populate("classMasterOf", "name level classGroup")
    .populate("classesTaught", "name level classGroup");
  if (!teacher) return res.status(404).json({ message: "Teacher not found" });
  res.json({ teacher: teacher.toSafeObject() });
});

// POST /api/teachers - General Admin / Junior School Admin only. Payload
// mirrors the 3-part signup form: personal info, school info, login info.
// The Principal can view teachers but never adds one.
router.post("/", protect, authorize("admin", "juniorAdmin"), async (req, res) => {
  try {
    const {
      name,
      password,
      subjects,
      teacherRole,
      level,
      levelsTaught,
      classMasterOf,
      classTeacherOf,
      classesTaught,
      phone,
      gender,
      dob,
      address,
      nationality,
      shift,
      avatarUrl,
    } = req.body;
    if (req.user.role === "juniorAdmin" && (Array.isArray(levelsTaught) ? levelsTaught : [level]).includes("SSS")) {
      return res.status(403).json({
        message: "A Junior School Admin cannot add an SSS-level teacher",
      });
    }
    const initials = name
      .split(" ")
      .map((w) => w[0])
      .slice(0, 2)
      .join("")
      .toUpperCase();
    const normalized = normalizeTeacherAssignments({ levelsTaught, classesTaught, classMasterOf, classTeacherOf });
    const teacher = await User.create({
      name,
      password: password || "teacher123",
      role: "teacher",
      subjects: subjects || [],
      teacherRole,
      level: normalized.levelsTaught[0] || level || "",
      levelsTaught: normalized.levelsTaught,
      classMasterOf: normalized.classMasterOf,
      classTeacherOf: normalized.classMasterOf[0] || undefined,
      classesTaught: normalized.classesTaught,
      phone,
      gender,
      dob,
      address,
      nationality,
      shift,
      avatarUrl,
      initials,
      color: ["#4f8cff", "#22d3a0", "#fbbf24", "#f87171", "#fb923c", "#f472b6"][
        Math.floor(Math.random() * 6)
      ],
      approvalStatus: "Approved",
    });
    if (teacherRole === "Class Master") {
      await syncClassMasters(teacher._id, [], normalized.classMasterOf);
    }
    res.status(201).json({ teacher: teacher.toSafeObject() });
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

// PUT /api/teachers/:id - General Admin / Junior School Admin only. The
// Principal can view teachers but never edits one.
router.put("/:id", protect, authorize("admin", "juniorAdmin"), async (req, res) => {
  try {
    const existing = await User.findOne({ _id: req.params.id, role: "teacher" });
    if (!existing) return res.status(404).json({ message: "Teacher not found" });
    const incomingLevels = Array.isArray(req.body.levelsTaught) ? req.body.levelsTaught : (req.body.level ? [req.body.level] : (existing.levelsTaught || []));
    if (req.user.role === "juniorAdmin" && ((existing.levelsTaught || []).includes("SSS") || incomingLevels.includes("SSS"))) {
      return res.status(403).json({ message: "A Junior School Admin cannot manage an SSS-level teacher" });
    }

    const body = { ...req.body };
    const normalized = normalizeTeacherAssignments(body);
    body.levelsTaught = normalized.levelsTaught;
    body.level = normalized.levelsTaught[0] || "";
    body.classesTaught = normalized.classesTaught;
    body.classMasterOf = body.teacherRole === "Class Master" ? normalized.classMasterOf : [];
    body.classTeacherOf = body.classMasterOf[0] || null;
    if (!body.password) delete body.password;

    const oldClassIds = existing.classMasterOf?.length ? existing.classMasterOf : (existing.classTeacherOf ? [existing.classTeacherOf] : []);
    Object.assign(existing, body);
    const teacher = await existing.save();
    await syncClassMasters(teacher._id, oldClassIds, teacher.classMasterOf || []);
    res.json({ teacher: teacher.toSafeObject() });
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

// DELETE /api/teachers/:id - General Admin / Junior School Admin only. The
// Principal can view teachers but never removes one.
router.delete("/:id", protect, authorize("admin", "juniorAdmin"), async (req, res) => {
  const existing = await User.findOne({ _id: req.params.id, role: "teacher" });
  if (!existing) return res.status(404).json({ message: "Teacher not found" });
  if (req.user.role === "juniorAdmin" && existing.level === "SSS") {
    return res.status(403).json({ message: "A Junior School Admin cannot remove an SSS-level teacher" });
  }
  const teacher = await User.findOneAndDelete({
    _id: req.params.id,
    role: "teacher",
  });
  if (!teacher) return res.status(404).json({ message: "Teacher not found" });
  await SchoolClass.updateMany(
    { classTeacher: teacher._id },
    { $unset: { classTeacher: "" } },
  );
  res.json({ message: "Teacher removed" });
});

// GET /api/teachers/attendance/today - principal dashboard widget
router.get(
  "/attendance/today",
  protect,
  authorize("principal", "juniorAdmin"),
  async (req, res) => {
    const teachers = await User.find({ role: "teacher" });
    res.json({ teachers: teachers.map((t) => t.toSafeObject()) });
  },
);

module.exports = router;
