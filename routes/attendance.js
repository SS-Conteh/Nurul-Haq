const express = require("express");
const crypto = require("crypto");
const Attendance = require("../models/Attendance");
const User = require("../models/User");
const TeacherAttendance = require("../models/TeacherAttendance");
const DailyQRCode = require("../models/DailyQRCode");
const Settings = require("../models/Settings");
const { protect, authorize } = require("../middleware/auth");
const { yearFilter, currentTermString } = require("../utils/academicYear");

const router = express.Router();

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

// Every admin-layer account (General Admin, Junior School Admin, Senior/
// Junior Bursar, and the Senior/Junior Principal & Vice Principal seats)
// scans in/out for their own attendance, exactly like a teacher — the only
// exception is the Proprietor, who is purely an overseer and is never
// tracked this way.
function isProprietor(user) {
  return user.role === "principal" && user.principalTitle === "Proprietor";
}
const STAFF_ATTENDANCE_ROLES = [
  "teacher",
  "admin",
  "juniorAdmin",
  "principal",
  "seniorBursar",
  "juniorBursar",
];

function nowLabel() {
  return new Date().toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  });
}

// "08:00" -> minutes since midnight, compared against current local time
function isLate(cutoff) {
  const [h, m] = (cutoff || "08:00").split(":").map(Number);
  const now = new Date();
  const cutoffMinutes = h * 60 + (m || 0);
  const nowMinutes = now.getHours() * 60 + now.getMinutes();
  return nowMinutes > cutoffMinutes;
}

// ── Principal: generate (or fetch) today's morning + afternoon QR codes ──
// POST /api/attendance/qr/generate
router.post(
  "/qr/generate",
  protect,
  authorize("admin", "juniorAdmin"),
  async (req, res) => {
    const date = todayStr();
    const shifts = ["Morning", "Afternoon"];
    const codes = {};
    for (const shift of shifts) {
      let doc = await DailyQRCode.findOne({ date, shift });
      if (!doc) {
        doc = await DailyQRCode.create({
          date,
          shift,
          code: `${date}-${shift}-${crypto.randomBytes(8).toString("hex")}`,
        });
      }
      codes[shift] = doc.code;
    }
    res.json({ date, codes });
  },
);

// GET /api/attendance/qr/today - fetch (without regenerating) today's codes
router.get("/qr/today", protect, authorize("admin", "juniorAdmin", "principal"), async (req, res) => {
  const date = todayStr();
  const docs = await DailyQRCode.find({ date });
  const codes = {};
  docs.forEach((d) => (codes[d.shift] = d.code));
  res.json({ date, codes });
});

// ── Any staff member: scan a QR code to clock in / clock out ──
// POST /api/attendance/qr/scan  { code }
// Every admin-layer role scans exactly like a teacher does — the
// Proprietor is the sole exception, since they're purely an overseer and
// isn't tracked at all.
router.post(
  "/qr/scan",
  protect,
  authorize(...STAFF_ATTENDANCE_ROLES),
  async (req, res) => {
    if (isProprietor(req.user)) {
      return res
        .status(403)
        .json({ message: "The Proprietor's attendance isn't tracked" });
    }
    try {
      const { code } = req.body;
      const qr = await DailyQRCode.findOne({ code });
      if (!qr || qr.date !== todayStr()) {
        return res
          .status(400)
          .json({ message: "This QR code is invalid or has expired" });
      }
      const settings = (await Settings.findOne()) || {};
      const cutoff =
        qr.shift === "Morning"
          ? settings.morningShiftStart
          : settings.afternoonShiftStart;

      let record = await TeacherAttendance.findOne({
        teacher: req.user._id,
        date: qr.date,
        shift: qr.shift,
      });

      if (!record) {
        record = await TeacherAttendance.create({
          teacher: req.user._id,
          date: qr.date,
          shift: qr.shift,
          timeIn: nowLabel(),
          lateTag: isLate(cutoff) ? "Late" : "On Time",
          status: "Active",
          academicYear: settings.academicYear || "",
        });
        return res.status(201).json({ record, action: "clock-in" });
      }

      if (!record.timeOut) {
        record.timeOut = nowLabel();
        await record.save();
        return res.json({ record, action: "clock-out" });
      }

      return res.json({ record, action: "already-complete" });
    } catch (err) {
      res.status(400).json({ message: err.message });
    }
  },
);

// GET /api/attendance/teachers?date=YYYY-MM-DD - the staff attendance
// table (teachers AND every admin-layer account that scans in/out).
// Viewed by the General Admin, Junior School Admin, and the oversight tier
// (including the Proprietor, who can watch this table even though their
// own attendance is never tracked).
router.get("/teachers", protect, authorize("admin", "juniorAdmin", "principal"), async (req, res) => {
  const date = req.query.date || todayStr();
  const records = await TeacherAttendance.find({ date }).populate(
    "teacher",
    "name initials color phone level teacherRole classTeacherOf role principalTitle",
  );
  res.json({ date, records });
});

// PUT /api/attendance/teachers/:id - Admin/Junior School Admin manually sets
// a teacher's status for a shift they didn't scan for (On Leave, Suspended,
// Sick, Absent). The Principal can view this table but never edits it.
router.put(
  "/teachers/:id",
  protect,
  authorize("admin", "juniorAdmin"),
  async (req, res) => {
    const { status } = req.body;
    const allowed = ["Active", "Absent", "On Leave", "Suspended", "Sick"];
    if (!allowed.includes(status)) {
      return res.status(400).json({ message: "Invalid status" });
    }
    const record = await TeacherAttendance.findByIdAndUpdate(
      req.params.id,
      { status },
      { new: true },
    );
    if (!record)
      return res.status(404).json({ message: "Attendance record not found" });
    res.json({ record });
  },
);

// POST /api/attendance/teachers - Admin/Junior School Admin marks a
// teacher's status for a shift/date the teacher never scanned for at all
// (e.g. On Leave, Sick), or records a manual sign-in/sign-out time from the
// physical attendance cards for teachers without a phone (timeIn/timeOut
// are optional — only sent when that toggle applies). The Principal can
// view this table but never marks attendance.
router.post(
  "/teachers",
  protect,
  authorize("admin", "juniorAdmin"),
  async (req, res) => {
    const { teacher, date, shift, status, timeIn, timeOut } = req.body;
    const allowed = ["Active", "Absent", "On Leave", "Suspended", "Sick"];
    if (!allowed.includes(status)) {
      return res.status(400).json({ message: "Invalid status" });
    }
    const settings = await Settings.findOne();
    const update = { teacher, date, shift, status, academicYear: settings?.academicYear || "" };
    if (timeIn !== undefined) update.timeIn = timeIn;
    if (timeOut !== undefined) update.timeOut = timeOut;
    const record = await TeacherAttendance.findOneAndUpdate(
      { teacher, date, shift },
      update,
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );
    res.status(201).json({ record });
  },
);

// GET /api/attendance/my?ay= - the signed-in staff member's OWN QR
// sign-in/out history (not student attendance). Every scanning role uses
// this — the admin-layer "Overview" screens pull any staff member's
// history via /teachers instead.
router.get(
  "/my",
  protect,
  authorize(...STAFF_ATTENDANCE_ROLES),
  async (req, res) => {
    const settings = await Settings.findOne();
    const records = await TeacherAttendance.find({
      teacher: req.user._id,
      ...yearFilter(settings?.academicYear, req.query.ay),
    }).sort("-date");
    res.json({ records });
  },
);

// GET /api/attendance?classId=&date=&studentId=&ay=&term=
router.get("/", protect, async (req, res) => {
  const settings = await Settings.findOne();
  const filter = { ...yearFilter(settings?.academicYear, req.query.ay) };
  if (req.query.term) filter.term = req.query.term;
  if (req.query.classId) filter.classId = req.query.classId;
  if (req.query.studentId) filter.student = req.query.studentId;
  if (req.query.date) {
    const d = new Date(req.query.date);
    const next = new Date(d);
    next.setDate(d.getDate() + 1);
    filter.date = { $gte: d, $lt: next };
  }
  if (req.user.role === "student") filter.student = req.user._id;
  if (req.user.role === "teacher") {
    // Only a Class Master may see student attendance records, and only for
    // their own class — a plain subject teacher has no access here at all.
    if (!req.user.classTeacherOf) return res.json({ records: [] });
    filter.classId = req.user.classTeacherOf;
  }

  const records = await Attendance.find(filter)
    .populate("student", "name initials color")
    .sort("-date");
  res.json({ records });
});

// GET /api/attendance/summary/:studentId - term stats used across dashboards
router.get("/summary/:studentId", protect, async (req, res) => {
  const records = await Attendance.find({ student: req.params.studentId });
  const total = records.length || 1;
  const present = records.filter((r) => r.status === "Present").length;
  const absent = records.filter((r) => r.status === "Absent").length;
  const late = records.filter((r) => r.status === "Late").length;
  res.json({
    total: records.length,
    present,
    absent,
    late,
    rate: Math.round(((present + late) / total) * 100),
  });
});

// POST /api/attendance/bulk - teacher marks a whole class for a date. The
// Principal can view attendance but never marks it.
router.post(
  "/bulk",
  protect,
  authorize("teacher", "admin", "juniorAdmin"),
  async (req, res) => {
    try {
      const { classId, date, records } = req.body; // records: [{student, status}]
      const settings = await Settings.findOne();
      const term = currentTermString(settings) || "";
      const d = new Date(date);
      const results = [];
      for (const r of records) {
        const doc = await Attendance.findOneAndUpdate(
          {
            student: r.student,
            date: {
              $gte: new Date(d.setHours(0, 0, 0, 0)),
              $lt: new Date(d.setHours(23, 59, 59, 999)),
            },
          },
          {
            student: r.student,
            classId,
            date: new Date(date),
            status: r.status,
            markedBy: req.user._id,
            academicYear: settings?.academicYear || "",
            term,
          },
          { upsert: true, new: true, setDefaultsOnInsert: true },
        );
        results.push(doc);
      }
      res.status(201).json({ records: results });
    } catch (err) {
      res.status(400).json({ message: err.message });
    }
  },
);

// PUT /api/attendance/:id
router.put(
  "/:id",
  protect,
  authorize("teacher", "admin", "juniorAdmin"),
  async (req, res) => {
    const record = await Attendance.findByIdAndUpdate(req.params.id, req.body, {
      new: true,
    });
    if (!record)
      return res.status(404).json({ message: "Attendance record not found" });
    res.json({ record });
  },
);

module.exports = router;
