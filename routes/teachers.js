const express = require("express");
const User = require("../models/User");
const Attendance = require("../models/Attendance");
const SchoolClass = require("../models/SchoolClass");
const { protect, authorize } = require("../middleware/auth");

const router = express.Router();

// Keeps SchoolClass.classTeacher pointed at whichever teacher currently has
// that class in User.classTeacherOf — the two fields describe the same
// relationship from either side and must never disagree.
async function syncClassMaster(teacherId, oldClassId, newClassId) {
  const oldId = oldClassId ? String(oldClassId) : null;
  const newId = newClassId ? String(newClassId) : null;
  if (oldId && oldId !== newId) {
    // Only clear the old class's master if it still points at THIS teacher
    // (avoids clobbering someone else who may have since taken it over).
    await SchoolClass.updateOne(
      { _id: oldId, classTeacher: teacherId },
      { $unset: { classTeacher: "" } },
    );
  }
  if (newId) {
    // Exactly one Class Master per class: whoever previously held this
    // class is demoted back to a plain Subject Teacher.
    const previousMaster = await User.findOne({
      classTeacherOf: newId,
      _id: { $ne: teacherId },
    });
    if (previousMaster) {
      previousMaster.classTeacherOf = undefined;
      previousMaster.teacherRole = "Subject Teacher";
      await previousMaster.save();
    }
    await SchoolClass.updateOne(
      { _id: newId },
      { $set: { classTeacher: teacherId } },
    );
  }
}

// GET /api/teachers?level=Primary&teacherRole=Class%20Master
// Only ever returns Approved teachers — self-signups still awaiting the
// Principal's approval live in /pending instead.
router.get("/", protect, async (req, res) => {
  const filter = { role: "teacher", approvalStatus: { $ne: "Pending" } };
  if (req.query.level) filter.level = req.query.level;
  if (req.query.teacherRole) filter.teacherRole = req.query.teacherRole;
  // Junior School Admin (Nursery-JSS) never sees SSS-level teachers.
  if (req.user.role === "juniorAdmin") {
    filter.level = filter.level && filter.level !== "SSS" ? filter.level : { $in: ["Nursery", "Primary", "JSS", ""] };
  }
  const teachers = await User.find(filter)
    .populate("classTeacherOf", "name level classGroup")
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
    pendingFilter.level = { $in: ["Nursery", "Primary", "JSS", ""] };
  }
  const pending = await User.find(pendingFilter)
    .populate("classTeacherOf", "name level classGroup")
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
      if (teacher.teacherRole === "Class Master" && teacher.classTeacherOf) {
        await syncClassMaster(teacher._id, null, teacher.classTeacherOf);
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
    if (req.user.role === "juniorAdmin" && level === "SSS") {
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
    const teacher = await User.create({
      name,
      password: password || "teacher123",
      role: "teacher",
      subjects: subjects || [],
      teacherRole,
      level,
      classTeacherOf: classTeacherOf || undefined,
      classesTaught: classesTaught || [],
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
    if (teacherRole === "Class Master" && classTeacherOf) {
      await syncClassMaster(teacher._id, null, classTeacherOf);
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
    if (req.user.role === "juniorAdmin" && (existing.level === "SSS" || req.body.level === "SSS")) {
      return res.status(403).json({
        message: "A Junior School Admin cannot manage an SSS-level teacher",
      });
    }

    const body = { ...req.body };
    // A teacher is only ever a Class Master of a class when both the role
    // AND the class are explicitly set — anything else means "not a master
    // of anything", and that has to actually clear the field, not just
    // leave the old value sitting there stale.
    if (body.teacherRole !== "Class Master" || !body.classTeacherOf) {
      body.classTeacherOf = null;
    }
    if (!body.classesTaught) delete body.classesTaught;
    if (!body.password) delete body.password;

    const oldClassId = existing.classTeacherOf;
    Object.assign(existing, body);
    const teacher = await existing.save();
    await syncClassMaster(teacher._id, oldClassId, teacher.classTeacherOf);
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
  await SchoolClass.updateOne(
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
