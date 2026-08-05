const express = require("express");
const User = require("../models/User");
const Grade = require("../models/Grade");
const Attendance = require("../models/Attendance");
const { protect, authorize } = require("../middleware/auth");

const router = express.Router();

// Student IDs are auto-generated as NHIA-001, NHIA-002, … — never typed by
// hand. The next number is one more than the highest NHIA-### currently in
// use, so it stays correct even if students were deleted or an older
// non-NHIA admissionNo format exists from before this feature.
const ADMISSION_PREFIX = "NHIA-";
async function generateNextAdmissionNo() {
  const students = await User.find({
    role: "student",
    admissionNo: { $regex: `^${ADMISSION_PREFIX}\\d+$` },
  }).select("admissionNo");
  let max = 0;
  students.forEach((s) => {
    const n = parseInt(s.admissionNo.slice(ADMISSION_PREFIX.length), 10);
    if (!isNaN(n) && n > max) max = n;
  });
  return ADMISSION_PREFIX + String(max + 1).padStart(3, "0");
}

// Helper: compute a student's average score & attendance rate for a single
// student (used by GET /:id, where one extra pair of queries is cheap).
async function enrichStudent(studentDoc) {
  const grades = await Grade.find({ student: studentDoc._id });
  const avg = grades.length
    ? Math.round(grades.reduce((s, g) => s + g.total, 0) / grades.length)
    : 0;

  const records = await Attendance.find({ student: studentDoc._id });
  const present = records.filter(
    (r) => r.status === "Present" || r.status === "Late",
  ).length;
  const attRate = records.length
    ? Math.round((present / records.length) * 100)
    : 100;

  const obj = studentDoc.toSafeObject();
  obj.avg = avg;
  obj.attendanceRate = attRate;
  return obj;
}

// Helper: same enrichment as above, but for a whole list at once. The old
// version ran 2 queries per student (Grade.find + Attendance.find), so a
// class of 200 students meant 400 separate round-trips to MongoDB just to
// load one table — this was the single biggest cause of slow page loads.
// This does it in exactly 2 queries total, no matter how many students,
// by aggregating grades/attendance grouped by student in the database.
async function enrichStudentsBatch(studentDocs) {
  const ids = studentDocs.map((s) => s._id);
  if (!ids.length) return [];

  const [gradeStats, attStats] = await Promise.all([
    Grade.aggregate([
      { $match: { student: { $in: ids } } },
      { $group: { _id: "$student", total: { $sum: "$total" }, count: { $sum: 1 } } },
    ]),
    Attendance.aggregate([
      { $match: { student: { $in: ids } } },
      {
        $group: {
          _id: "$student",
          present: {
            $sum: { $cond: [{ $in: ["$status", ["Present", "Late"]] }, 1, 0] },
          },
          count: { $sum: 1 },
        },
      },
    ]),
  ]);

  const avgByStudent = {};
  gradeStats.forEach((g) => {
    avgByStudent[String(g._id)] = g.count ? Math.round(g.total / g.count) : 0;
  });
  const attByStudent = {};
  attStats.forEach((a) => {
    attByStudent[String(a._id)] = a.count
      ? Math.round((a.present / a.count) * 100)
      : 100;
  });

  return studentDocs.map((s) => {
    const obj = s.toSafeObject();
    obj.avg = avgByStudent[String(s._id)] || 0;
    obj.attendanceRate = attByStudent[String(s._id)] ?? 100;
    return obj;
  });
}

// GET /api/students  (principal/admin: all, juniorAdmin: Nursery-JSS only, teacher: own class)
router.get(
  "/",
  protect,
  authorize("principal", "teacher", "juniorAdmin"),
  async (req, res) => {
    const filter = { role: "student" };
    if (req.user.role === "teacher") {
      // A teacher may only ever see students in classes they actually teach
      // (their own classesTaught) or their own class-master class.
      const scope = [
        ...(req.user.classesTaught || []),
        ...(req.user.classTeacherOf ? [req.user.classTeacherOf] : []),
      ].map(String);
      if (req.query.classId) {
        filter.classId = scope.includes(String(req.query.classId))
          ? req.query.classId
          : null; // asked for a class outside their scope -> no results
      } else if (req.user.classTeacherOf) {
        filter.classId = req.user.classTeacherOf; // default: their own class
      } else if (scope.length) {
        filter.classId = { $in: scope };
      } else {
        filter.classId = null; // not assigned to any class yet
      }
    } else if (req.query.classId) {
      filter.classId = req.query.classId;
    }

    let students = await User.find(filter)
      .populate("classId", "name level classGroup")
      .sort("name");

    // Junior School Admin (Nursery-JSS) can never see SSS students, no
    // matter what level filter is passed in.
    if (req.user.role === "juniorAdmin") {
      students = students.filter((s) => s.classId?.level !== "SSS");
    }
    if (req.query.level) {
      students = students.filter((s) => s.classId?.level === req.query.level);
    }
    if (req.query.classGroup) {
      students = students.filter(
        (s) => s.classId?.classGroup === req.query.classGroup,
      );
    }
    const enriched = await enrichStudentsBatch(students);
    res.json({ students: enriched, count: enriched.length });
  },
);

// GET /api/students/meta/next-admission-no — preview the ID that will be
// assigned to the next enrolled student (shown read-only on the Add form).
// Must stay above GET /:id or Express would treat "meta" as an :id value.
router.get(
  "/meta/next-admission-no",
  protect,
  authorize("principal", "teacher", "juniorAdmin"),
  async (req, res) => {
    res.json({ admissionNo: await generateNextAdmissionNo() });
  },
);

// GET /api/students/:id
router.get("/:id", protect, async (req, res) => {
  const student = await User.findOne({
    _id: req.params.id,
    role: "student",
  }).populate("classId", "name level classGroup");
  if (!student) return res.status(404).json({ message: "Student not found" });
  res.json({ student: await enrichStudent(student) });
});

// POST /api/students  - enroll a new student (principal, admin, juniorAdmin, or teacher)
router.post(
  "/",
  protect,
  authorize("principal", "teacher", "juniorAdmin"),
  async (req, res) => {
    try {
      const {
        name,
        password,
        classId,
        gender,
        dob,
        phone,
        address,
        nationality,
        bloodGroup,
        avatarUrl,
      } = req.body;

      if (req.user.role === "juniorAdmin" && classId) {
        const SchoolClass = require("../models/SchoolClass");
        const cls = await SchoolClass.findById(classId);
        if (cls?.level === "SSS") {
          return res.status(403).json({
            message: "A Junior School Admin cannot enroll a student into an SSS class",
          });
        }
      }

      const initials = name
        .split(" ")
        .map((w) => w[0])
        .slice(0, 2)
        .join("")
        .toUpperCase();
      const student = await User.create({
        name,
        password: password || "student123",
        role: "student",
        classId,
        gender,
        admissionNo: await generateNextAdmissionNo(),
        dob,
        phone,
        address,
        nationality,
        bloodGroup,
        avatarUrl,
        initials,
        color: [
          "#4f8cff",
          "#22d3a0",
          "#fbbf24",
          "#f87171",
          "#fb923c",
          "#f472b6",
          "#22d3ee",
          "#7c5fff",
        ][Math.floor(Math.random() * 8)],
      });
      res.status(201).json({ student: student.toSafeObject() });
    } catch (err) {
      res.status(400).json({ message: err.message });
    }
  },
);

// PUT /api/students/:id
router.put(
  "/:id",
  protect,
  authorize("principal", "teacher", "juniorAdmin"),
  async (req, res) => {
    try {
      const body = { ...req.body };
      if (!body.classId) delete body.classId;
      if (req.user.role === "juniorAdmin" && body.classId) {
        const SchoolClass = require("../models/SchoolClass");
        const cls = await SchoolClass.findById(body.classId);
        if (cls?.level === "SSS") {
          return res.status(403).json({
            message: "A Junior School Admin cannot move a student into an SSS class",
          });
        }
      }
      const student = await User.findOneAndUpdate(
        { _id: req.params.id, role: "student" },
        body,
        { new: true, runValidators: true },
      );
      if (!student)
        return res.status(404).json({ message: "Student not found" });
      res.json({ student: student.toSafeObject() });
    } catch (err) {
      res.status(400).json({ message: err.message });
    }
  },
);

// DELETE /api/students/:id
router.delete(
  "/:id",
  protect,
  authorize("principal", "juniorAdmin"),
  async (req, res) => {
    const student = await User.findOne({
      _id: req.params.id,
      role: "student",
    }).populate("classId", "level");
    if (!student) return res.status(404).json({ message: "Student not found" });
    if (req.user.role === "juniorAdmin" && student.classId?.level === "SSS") {
      return res
        .status(403)
        .json({ message: "A Junior School Admin cannot remove an SSS student" });
    }
    await student.deleteOne();
    res.json({ message: "Student removed" });
  },
);

module.exports = router;
