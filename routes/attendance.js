const express = require("express");
const crypto = require("crypto");
const Attendance = require("../models/Attendance");
const User = require("../models/User");
const TeacherAttendance = require("../models/TeacherAttendance");
const DailyQRCode = require("../models/DailyQRCode");
const Settings = require("../models/Settings");
const { protect, authorize } = require("../middleware/auth");

const router = express.Router();

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

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
  authorize("principal"),
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
router.get("/qr/today", protect, authorize("principal"), async (req, res) => {
  const date = todayStr();
  const docs = await DailyQRCode.find({ date });
  const codes = {};
  docs.forEach((d) => (codes[d.shift] = d.code));
  res.json({ date, codes });
});

// ── Teacher: scan a QR code to clock in / clock out ──
// POST /api/attendance/qr/scan  { code }
router.post("/qr/scan", protect, authorize("teacher"), async (req, res) => {
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
});

// GET /api/attendance/teachers?date=YYYY-MM-DD - principal's Teachers attendance table
router.get("/teachers", protect, authorize("principal"), async (req, res) => {
  const date = req.query.date || todayStr();
  const records = await TeacherAttendance.find({ date }).populate(
    "teacher",
    "name initials color phone level teacherRole classTeacherOf",
  );
  res.json({ date, records });
});

// PUT /api/attendance/teachers/:id - principal manually sets a teacher's
// status for a shift they didn't scan for (On Leave, Suspended, Sick, Absent)
router.put(
  "/teachers/:id",
  protect,
  authorize("principal"),
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

// POST /api/attendance/teachers - principal marks a teacher's status for a
// shift/date the teacher never scanned for at all (e.g. On Leave, Sick)
router.post(
  "/teachers",
  protect,
  authorize("principal"),
  async (req, res) => {
    const { teacher, date, shift, status } = req.body;
    const allowed = ["Active", "Absent", "On Leave", "Suspended", "Sick"];
    if (!allowed.includes(status)) {
      return res.status(400).json({ message: "Invalid status" });
    }
    const record = await TeacherAttendance.findOneAndUpdate(
      { teacher, date, shift },
      { teacher, date, shift, status },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );
    res.status(201).json({ record });
  },
);

// GET /api/attendance/my - a teacher's OWN QR sign-in/out history (not
// student attendance). Subject teachers use this; principals can pull any
// teacher's history via /teachers.
router.get(
  "/my",
  protect,
  authorize("teacher", "principal"),
  async (req, res) => {
    const records = await TeacherAttendance.find({
      teacher: req.user._id,
    }).sort("-date");
    res.json({ records });
  },
);

// GET /api/attendance?classId=&date=&studentId=
router.get("/", protect, async (req, res) => {
  const filter = {};
  if (req.query.classId) filter.classId = req.query.classId;
  if (req.query.studentId) filter.student = req.query.studentId;
  if (req.query.date) {
    const d = new Date(req.query.date);
    const next = new Date(d);
    next.setDate(d.getDate() + 1);
    filter.date = { $gte: d, $lt: next };
  }
  if (req.user.role === "student") filter.student = req.user._id;
  if (req.user.role === "parent") filter.student = { $in: req.user.children };
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

// POST /api/attendance/bulk - teacher marks a whole class for a date
router.post(
  "/bulk",
  protect,
  authorize("teacher", "principal"),
  async (req, res) => {
    try {
      const { classId, date, records } = req.body; // records: [{student, status}]
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
  authorize("teacher", "principal"),
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
