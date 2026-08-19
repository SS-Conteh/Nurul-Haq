const express = require("express");
const User = require("../models/User");
const SchoolClass = require("../models/SchoolClass");
const Grade = require("../models/Grade");
const Attendance = require("../models/Attendance");
const Fee = require("../models/Fee");
const Settings = require("../models/Settings");
const Notice = require("../models/Notice");
const { protect } = require("../middleware/auth");
const { yearFilter } = require("../utils/academicYear");
const router = express.Router();

function avg(arr, fn) {
  return arr.length
    ? Math.round(arr.reduce((s, x) => s + fn(x), 0) / arr.length)
    : 0;
}

// GET /api/dashboard - returns the right stat bundle for the logged-in user's role
router.get("/", protect, async (req, res) => {
  const role = req.user.role;

  if (role === "principal" || role === "admin" || role === "juniorAdmin") {
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const todayEnd = new Date();
    todayEnd.setHours(23, 59, 59, 999);

    // A Junior School Admin's dashboard is scoped to Nursery/Primary/JSS
    // only — never SSS — so its counts/queries are narrowed to students,
    // teachers, and attendance in those classes.
    let scopeStudentFilter = { role: "student" };
    let scopeTeacherFilter = { role: "teacher" };
    let scopeClassIds = null;
    if (role === "juniorAdmin") {
      scopeClassIds = (
        await SchoolClass.find({ level: { $ne: "SSS" } }).select("_id").lean()
      ).map((c) => c._id);
      scopeStudentFilter.classId = { $in: scopeClassIds };
      scopeTeacherFilter.level = { $in: ["Nursery", "Primary", "JSS", ""] };
    }

    // Run every independent query in parallel instead of one-at-a-time,
    // and let MongoDB compute the average/sum instead of pulling every
    // grade/fee document into Node just to reduce it in JS.
    // Fetched first (not in the Promise.all below) because the fee
    // aggregation needs to know the current academic year to scope its sum.
    const settings = await Settings.findOne();
    // Which year this dashboard is reporting on: the nav dropdown's ay=
    // query param when a past year is being reviewed, otherwise the
    // current academic year. EVERY figure below must key off this, not
    // off settings.academicYear directly — otherwise switching the
    // dropdown to a past year silently keeps showing current-year numbers,
    // which is exactly what happened before this fix (the dashboard was
    // the one page in the whole app that never actually looked at ay=).
    const requestedYear = req.query.ay || "";
    const viewingPastYear = !!requestedYear;
    // Scope the average-grade figure to the requested academic year (same
    // fallback-to-blank rule as everywhere else — see utils/academicYear.js
    // — so pre-existing grades from before this field existed still count
    // toward the CURRENT year's average until they age out). Without this,
    // the dashboard's average kept blending every year's grades together
    // forever, so it never visibly "reset" when a new academic year began.
    const gradeYearMatch = yearFilter(settings?.academicYear, requestedYear);
    // Optional further narrowing to one term (the Dashboard's term
    // dropdown) — on top of, not instead of, the academic-year scoping
    // above.
    if (req.query.term) gradeYearMatch.term = req.query.term;

    const [
      teacherCount,
      studentCount,
      gradeAgg,
      todaysAttendance,
      feeAgg,
      notices,
    ] = await Promise.all([
      User.countDocuments(scopeTeacherFilter),
      User.countDocuments(scopeStudentFilter),
      role === "juniorAdmin"
        ? Grade.aggregate([
            { $match: gradeYearMatch },
            { $lookup: { from: "users", localField: "student", foreignField: "_id", as: "s" } },
            { $unwind: "$s" },
            { $match: { "s.classId": { $in: scopeClassIds } } },
            { $group: { _id: null, avg: { $avg: "$total" } } },
          ])
        : Grade.aggregate([
            { $match: gradeYearMatch },
            { $group: { _id: null, avg: { $avg: "$total" } } },
          ]),
      // "Today's attendance rate" is inherently a live, current-day figure
      // — it has no meaning for an archived year, so a past year selection
      // just shows 0 rather than querying at all.
      viewingPastYear
        ? Promise.resolve([])
        : role === "juniorAdmin"
          ? Attendance.find({ date: { $gte: todayStart, $lte: todayEnd }, classId: { $in: scopeClassIds } })
              .select("status")
              .lean()
          : Attendance.find({ date: { $gte: todayStart, $lte: todayEnd } })
              .select("status")
              .lean(),
      // Total cash collected in the requested academic year — every
      // installment a student has paid, whether that installment alone was
      // Paid/Partial/Unpaid (fees are annual now, so a "Partial"
      // installment's amount is still real money in hand and should count
      // toward this figure).
      Fee.aggregate([
        { $match: { academicYear: requestedYear || settings?.academicYear || "" } },
        { $group: { _id: null, total: { $sum: "$amount" } } },
      ]),
      Notice.find().sort("-createdAt").limit(3).lean(),
    ]);

    const avgGrade = gradeAgg[0] ? Math.round(gradeAgg[0].avg) : 0;
    const presentToday = todaysAttendance.filter(
      (a) => a.status !== "Absent",
    ).length;
    const attendanceRateToday = todaysAttendance.length
      ? Math.round((presentToday / todaysAttendance.length) * 100)
      : 0;
    const feesCollected = feeAgg[0]?.total || 0;

    return res.json({
      role,
      teacherCount,
      studentCount,
      attendanceRateToday,
      avgGrade,
      feesCollected,
      pendingReports: 5,
      notices,
    });
  }

  if (role === "teacher") {
    // Same as the admin/principal branch above: honor the nav dropdown's
    // ay= so a teacher reviewing a past year actually sees that year's
    // grade average on their dashboard instead of the current year's.
    const requestedYear = req.query.ay || "";
    const viewingPastYear = !!requestedYear;

    const classId = req.user.classTeacherOf;
    const isClassMaster = !!classId;

    // "Own subject" scope: every class this teacher actually teaches, plus
    // their own class-master class if that's separate.
    const scopeClassIds = [
      ...new Set(
        [
          ...(req.user.classesTaught || []),
          ...(classId ? [classId] : []),
        ].map(String),
      ),
    ];

    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const todayEnd = new Date();
    todayEnd.setHours(23, 59, 59, 999);

    const [classStudents, todaysAttendance, scopeStudents] =
      await Promise.all([
        isClassMaster
          ? User.find({ role: "student", classId }).select("_id").lean()
          : Promise.resolve([]),
        // As with the admin dashboard, "today's" attendance rate has no
        // meaning while reviewing an archived year — skip it and show 0.
        isClassMaster && !viewingPastYear
          ? Attendance.find({
              classId,
              date: { $gte: todayStart, $lte: todayEnd },
            })
              .select("status")
              .lean()
          : Promise.resolve([]),
        scopeClassIds.length
          ? User.find({ role: "student", classId: { $in: scopeClassIds } })
              .select("_id")
              .lean()
          : Promise.resolve([]),
      ]);

    const studentCount = classStudents.length;
    const present = todaysAttendance.filter(
      (a) => a.status !== "Absent",
    ).length;
    const attendanceRate = todaysAttendance.length
      ? Math.round((present / todaysAttendance.length) * 100)
      : 0;

    const settings = await Settings.findOne();
    const subjectGrades = (req.user.subjects || []).length
      ? await Grade.find({
          subject: { $in: req.user.subjects },
          student: { $in: scopeStudents.map((s) => s._id) },
          ...yearFilter(settings?.academicYear, requestedYear),
          ...(req.query.term ? { term: req.query.term } : {}),
        })
          .select("total")
          .lean()
      : [];
    const avgScore = avg(subjectGrades, (g) => g.total);
    // "Pending" grades (students still owed a grade) is a current-year,
    // actionable concept tied to today's class roster — meaningless for a
    // read-only archived year, so it's just 0 there.
    const pendingGrades = viewingPastYear
      ? 0
      : Math.max(0, scopeStudents.length - subjectGrades.length);

    return res.json({
      role,
      isClassMaster,
      studentCount,
      attendanceRate,
      avgScore,
      pendingGrades,
    });
  }

  if (role === "student") {
    // Same year-scoping as the Grades and Attendance pages: default view
    // is the current academic year (plus pre-existing records that predate
    // the academicYear field), not the student's entire history — otherwise
    // "overall average" and "attendance rate" here never reset on a year
    // change, even though the Grades/Attendance pages themselves correctly
    // start fresh.
    const settings = await Settings.findOne();
    const yf = yearFilter(settings?.academicYear, req.query.ay);
    const [grades, attendance] = await Promise.all([
      Grade.find({ student: req.user._id, ...yf }).lean(),
      Attendance.find({ student: req.user._id, ...yf }).select("status").lean(),
    ]);
    const overallAvg = avg(grades, (g) => g.total);
    const present = attendance.filter((a) => a.status !== "Absent").length;
    const attendanceRate = attendance.length
      ? Math.round((present / attendance.length) * 100)
      : 0;

    return res.json({ role, overallAvg, attendanceRate, grades });
  }

  res.json({ role });
});

module.exports = router;
