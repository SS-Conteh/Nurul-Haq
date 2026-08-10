const express = require("express");
const User = require("../models/User");
const SchoolClass = require("../models/SchoolClass");
const Grade = require("../models/Grade");
const Attendance = require("../models/Attendance");
const Fee = require("../models/Fee");
const Settings = require("../models/Settings");
const Notice = require("../models/Notice");
const { protect } = require("../middleware/auth");
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
            { $lookup: { from: "users", localField: "student", foreignField: "_id", as: "s" } },
            { $unwind: "$s" },
            { $match: { "s.classId": { $in: scopeClassIds } } },
            { $group: { _id: null, avg: { $avg: "$total" } } },
          ])
        : Grade.aggregate([{ $group: { _id: null, avg: { $avg: "$total" } } }]),
      role === "juniorAdmin"
        ? Attendance.find({ date: { $gte: todayStart, $lte: todayEnd }, classId: { $in: scopeClassIds } })
            .select("status")
            .lean()
        : Attendance.find({ date: { $gte: todayStart, $lte: todayEnd } })
            .select("status")
            .lean(),
      // Total cash collected this academic year — every installment a
      // student has paid, whether that installment alone was Paid/Partial/
      // Unpaid (fees are annual now, so a "Partial" installment's amount is
      // still real money in hand and should count toward this figure).
      Fee.aggregate([
        { $match: { academicYear: settings?.academicYear || "" } },
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
        isClassMaster
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

    const subjectGrades = (req.user.subjects || []).length
      ? await Grade.find({
          subject: { $in: req.user.subjects },
          student: { $in: scopeStudents.map((s) => s._id) },
        })
          .select("total")
          .lean()
      : [];
    const avgScore = avg(subjectGrades, (g) => g.total);
    const pendingGrades = Math.max(
      0,
      scopeStudents.length - subjectGrades.length,
    );

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
    const [grades, attendance] = await Promise.all([
      Grade.find({ student: req.user._id }).lean(),
      Attendance.find({ student: req.user._id }).select("status").lean(),
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
