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
//
// IMPORTANT: a student's "average" must always be scoped to a SPECIFIC
// class (see Grade.classId / Attendance.classId comments) — never blended
// across every class they've ever passed through. Otherwise a student's
// average from their OLD class keeps bleeding into whatever NEW class
// they're promoted into (and vice-versa), which is exactly the bug this
// was rewritten to fix. `scopeClassId`:
//   - a specific class id -> average is computed ONLY from records tagged
//     with that class (used when the caller is explicitly reviewing one
//     class, current or historical)
//   - omitted -> defaults to the student's own CURRENT classId, so a
//     general "all students" listing shows each student's average for the
//     class they're in right now, not their lifetime history.
async function enrichStudent(studentDoc, scopeClassId) {
  const classId = scopeClassId || studentDoc.classId || null;
  const gradeFilter = { student: studentDoc._id };
  const attFilter = { student: studentDoc._id };
  if (classId) {
    gradeFilter.classId = classId;
    attFilter.classId = classId;
  }

  const grades = await Grade.find(gradeFilter);
  const avg = grades.length
    ? Math.round(grades.reduce((s, g) => s + g.total, 0) / grades.length)
    : 0;

  const records = await Attendance.find(attFilter);
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
// by aggregating grades/attendance grouped by (student, class) in the
// database, then picking out the right (student, class) cell per row.
//
// `scopeClassId`: same meaning as in enrichStudent above — pass a class id
// when every row in this batch should be scored against ONE specific class
// (e.g. reviewing "Class X"'s roster, including alumni who've since moved
// on). Leave undefined for a mixed-class listing, where each student is
// scored against their OWN current classId so a promoted student's old
// class average never bleeds into their new class (or vice-versa).
async function enrichStudentsBatch(studentDocs, scopeClassId, term) {
  const ids = studentDocs.map((s) => s._id);
  if (!ids.length) return [];

  const [gradeStats, attStats] = await Promise.all([
    Grade.aggregate([
      { $match: { student: { $in: ids }, ...(term ? { term } : {}) } },
      {
        $group: {
          _id: { student: "$student", classId: "$classId" },
          total: { $sum: "$total" },
          count: { $sum: 1 },
        },
      },
    ]),
    Attendance.aggregate([
      { $match: { student: { $in: ids }, ...(term ? { term } : {}) } },
      {
        $group: {
          _id: { student: "$student", classId: "$classId" },
          present: {
            $sum: { $cond: [{ $in: ["$status", ["Present", "Late"]] }, 1, 0] },
          },
          count: { $sum: 1 },
        },
      },
    ]),
  ]);

  const gradeCell = {};
  gradeStats.forEach((g) => {
    const key = `${g._id.student}_${g._id.classId || ""}`;
    gradeCell[key] = g.count ? Math.round(g.total / g.count) : 0;
  });
  const attCell = {};
  attStats.forEach((a) => {
    const key = `${a._id.student}_${a._id.classId || ""}`;
    attCell[key] = a.count ? Math.round((a.present / a.count) * 100) : 100;
  });

  return studentDocs.map((s) => {
    const obj = s.toSafeObject();
    const classId = String(
      scopeClassId || (s.classId && (s.classId._id || s.classId)) || "",
    );
    const key = `${s._id}_${classId}`;
    obj.avg = gradeCell[key] || 0;
    obj.attendanceRate = attCell[key] ?? 100;
    return obj;
  });
}

// Helper: every studentId who has ever left a trace (a Grade or an
// Attendance record) in the given class — i.e. the FULL historical roster
// of that class, including students who've since been promoted out of it.
// Used only when a caller explicitly opts into reviewing class history
// (?history=1); ordinary "who's in this class" queries stay scoped to the
// students' live classId, exactly as before, so day-to-day flows like
// marking attendance or assigning a fee never see an alumnus by accident.
async function historicalStudentIdsForClass(classId) {
  const [gradeIds, attIds] = await Promise.all([
    Grade.find({ classId }).distinct("student"),
    Attendance.find({ classId }).distinct("student"),
  ]);
  const set = new Set([...gradeIds, ...attIds].map(String));
  return [...set];
}

// GET /api/students  (principal/admin: all, juniorAdmin/juniorBursar:
// Nursery-JSS only, seniorBursar: SSS only, teacher: own class)
router.get(
  "/",
  protect,
  authorize("principal", "teacher", "juniorAdmin", "seniorBursar", "juniorBursar"),
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

    // Opt-in only, and only meaningful when a single classId was requested:
    // "history=1" (or "true") pulls in every student who has EVER had a
    // grade or attendance record logged under that class, even if they've
    // since been promoted somewhere else. Without this, a promoted
    // student's records were effectively unreachable through the Students
    // page the moment their live classId changed — the class they earned
    // those records in would show an empty/incomplete roster forever. This
    // is what lets teachers/admins actually review past academic records.
    const wantsHistory =
      (req.query.history === "1" || req.query.history === "true") &&
      !!req.query.classId &&
      // A teacher asking for history on a class outside their own scope
      // still gets nothing — same rule as the live roster above.
      String(filter.classId || "") === String(req.query.classId);
    let alumniIds = [];
    if (wantsHistory) {
      const currentIds = new Set(students.map((s) => String(s._id)));
      const historicalIds = await historicalStudentIdsForClass(
        req.query.classId,
      );
      alumniIds = historicalIds.filter((id) => !currentIds.has(id));
    }
    let alumni = [];
    if (alumniIds.length) {
      alumni = await User.find({ _id: { $in: alumniIds }, role: "student" })
        .populate("classId", "name level classGroup")
        .sort("name");
    }

    // Junior School Admin (Nursery-JSS) and the Junior Bursar can never
    // see SSS students, no matter what level filter is passed in. The
    // Senior Bursar is the mirror case — SSS is all they're ever scoped
    // to, since that's the only fee level they handle. For alumni rows,
    // this is judged by the level of the class being REVIEWED (the class
    // the records actually belong to), not the student's current class —
    // a Junior Admin reviewing an old JSS3 roster can still see a student
    // who has since been promoted into SSS, since JSS3 itself is in scope.
    let reviewedClassLevel = null;
    if (alumni.length && req.query.classId) {
      const SchoolClass = require("../models/SchoolClass");
      const reviewedClass = await SchoolClass.findById(req.query.classId).select("level");
      reviewedClassLevel = reviewedClass?.level || null;
    }
    if (req.user.role === "juniorAdmin" || req.user.role === "juniorBursar") {
      students = students.filter((s) => s.classId?.level !== "SSS");
      alumni = alumni.filter((s) => reviewedClassLevel !== "SSS");
    }
    if (req.user.role === "seniorBursar") {
      students = students.filter((s) => s.classId?.level === "SSS");
      alumni = alumni.filter((s) => reviewedClassLevel === "SSS");
    }
    if (req.query.level) {
      students = students.filter((s) => s.classId?.level === req.query.level);
    }
    if (req.query.classGroup) {
      students = students.filter(
        (s) => s.classId?.classGroup === req.query.classGroup,
      );
    }

    // Scope every average shown here to ONE consistent class: the class
    // being explicitly reviewed (req.query.classId), if any — whether
    // that's the live roster or an alumnus who's moved on. Otherwise (no
    // classId filter — a mixed, org-wide listing) each student is scored
    // against their own current class only, never their whole history.
    const scopeClassId = req.query.classId || undefined;
    // Optional further narrowing to one term (e.g. the admin Dashboard's
    // Class Performance term dropdown) — on top of, not instead of, the
    // class scoping above. Omitted -> every term on file, same as today.
    const termParam = req.query.term || undefined;
    const enrichedCurrent = await enrichStudentsBatch(
      students,
      scopeClassId,
      termParam,
    );
    const enrichedAlumni = alumni.length
      ? (await enrichStudentsBatch(alumni, scopeClassId, termParam)).map((s) => ({
          ...s,
          isAlumnus: true,
        }))
      : [];
    const enriched = [...enrichedCurrent, ...enrichedAlumni];
    res.json({ students: enriched, count: enriched.length });
  },
);

// GET /api/students/meta/next-admission-no — preview the ID that will be
// assigned to the next enrolled student (shown read-only on the Add form).
// Must stay above GET /:id or Express would treat "meta" as an :id value.
// The Principal never enrolls a student, so is left out here.
router.get(
  "/meta/next-admission-no",
  protect,
  authorize("teacher", "juniorAdmin", "admin"),
  async (req, res) => {
    res.json({ admissionNo: await generateNextAdmissionNo() });
  },
);

// GET /api/students/:id — optionally pass ?classId= to score the returned
// avg/attendanceRate against one specific class (current or a past one the
// student has since moved on from). Without it, defaults to the student's
// own current classId.
router.get("/:id", protect, async (req, res) => {
  const student = await User.findOne({
    _id: req.params.id,
    role: "student",
  }).populate("classId", "name level classGroup");
  if (!student) return res.status(404).json({ message: "Student not found" });
  res.json({
    student: await enrichStudent(student, req.query.classId || undefined),
  });
});

// GET /api/students/:id/history — every class this student has ever left a
// grade or attendance trace in (their current class plus any they've been
// promoted out of), each with its own average computed ONLY from records
// tagged to that class. This is what lets a teacher/admin pull up a
// student's profile and still see the class(es) they came from, with the
// grades/records they earned there intact and un-blended with wherever
// they are now.
router.get("/:id/history", protect, async (req, res) => {
  const student = await User.findOne({ _id: req.params.id, role: "student" });
  if (!student) return res.status(404).json({ message: "Student not found" });

  const SchoolClass = require("../models/SchoolClass");
  const [gradeGroups, attGroups] = await Promise.all([
    Grade.aggregate([
      { $match: { student: student._id } },
      {
        $group: {
          _id: { classId: "$classId", academicYear: "$academicYear" },
          total: { $sum: "$total" },
          count: { $sum: 1 },
        },
      },
    ]),
    Attendance.aggregate([
      { $match: { student: student._id } },
      {
        $group: {
          _id: { classId: "$classId", academicYear: "$academicYear" },
          present: {
            $sum: { $cond: [{ $in: ["$status", ["Present", "Late"]] }, 1, 0] },
          },
          count: { $sum: 1 },
        },
      },
    ]),
  ]);

  // Merge grade + attendance stats per (classId, academicYear) cell.
  const cells = {};
  gradeGroups.forEach((g) => {
    const key = `${g._id.classId || ""}_${g._id.academicYear || ""}`;
    cells[key] = cells[key] || { classId: g._id.classId, academicYear: g._id.academicYear };
    cells[key].avg = g.count ? Math.round(g.total / g.count) : 0;
    cells[key].gradeCount = g.count;
  });
  attGroups.forEach((a) => {
    const key = `${a._id.classId || ""}_${a._id.academicYear || ""}`;
    cells[key] = cells[key] || { classId: a._id.classId, academicYear: a._id.academicYear };
    cells[key].attendanceRate = a.count ? Math.round((a.present / a.count) * 100) : 100;
  });

  const classIds = [...new Set(Object.values(cells).map((c) => String(c.classId || "")))].filter(Boolean);
  const classes = await SchoolClass.find({ _id: { $in: classIds } }).select("name level classGroup");
  const classById = {};
  classes.forEach((c) => (classById[String(c._id)] = c));

  const history = Object.values(cells)
    .map((c) => ({
      classId: c.classId,
      class: c.classId ? classById[String(c.classId)] || null : null,
      academicYear: c.academicYear || "",
      avg: c.avg ?? 0,
      attendanceRate: c.attendanceRate ?? 100,
      isCurrentClass:
        !!student.classId && String(student.classId) === String(c.classId),
    }))
    .sort((a, b) => (b.academicYear || "").localeCompare(a.academicYear || ""));

  res.json({ history });
});

// POST /api/students  - enroll a new student (admin, juniorAdmin, or
// teacher). The Principal can view students but never enrolls one.
router.post(
  "/",
  protect,
  authorize("teacher", "juniorAdmin", "admin"),
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
        house,
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
        house,
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

// PUT /api/students/:id - admin or juniorAdmin only. Neither the
// Principal nor a Class Master/teacher may edit a student's record — a
// student's own information is enrollment/admin-office data, not
// something the class they're in should be able to change.
router.put(
  "/:id",
  protect,
  authorize("juniorAdmin", "admin"),
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

// DELETE /api/students/:id - admin / juniorAdmin only. The Principal can
// view students but never removes one.
router.delete(
  "/:id",
  protect,
  authorize("juniorAdmin", "admin"),
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
