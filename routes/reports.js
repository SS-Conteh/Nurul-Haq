const express = require("express");
const User = require("../models/User");
const SchoolClass = require("../models/SchoolClass");
const Grade = require("../models/Grade");
const Attendance = require("../models/Attendance");
const Settings = require("../models/Settings");
const { protect, authorize } = require("../middleware/auth");
const generateReportCard = require("../utils/generateReportCard");
const { drawIdCard, CARD_W, CARD_H } = require("../utils/generateIdCard");

const router = express.Router();

const TERM_LABELS = { 1: "FIRST TERM", 2: "SECOND TERM", 3: "THIRD TERM" };

// GET /api/reports/report-card/:studentId?term=3&year=2026&session=2025/2026
// Only the Principal (school admin) can generate report cards.
router.get(
  "/report-card/:studentId",
  protect,
  authorize("principal", "juniorAdmin"),
  async (req, res) => {
    try {
      const student = await User.findOne({
        _id: req.params.studentId,
        role: "student",
      }).populate("classId", "level");
      if (!student)
        return res.status(404).json({ message: "Student not found" });
      if (req.user.role === "juniorAdmin" && student.classId?.level === "SSS") {
        return res.status(403).json({
          message: "A Junior School Admin cannot generate an SSS student's report card",
        });
      }

      const settings = (await Settings.findOne()) || {};
      const termNum = Number(req.query.term) || 3;
      const year =
        req.query.year ||
        (settings.academicYear || "2025/2026").split("/")[1] ||
        "2026";
      const session = req.query.session || settings.academicYear || "2025/2026";
      const terms = [1, 2, 3].map((n) => `Term ${n} · ${year}`);
      const termLabel = TERM_LABELS[termNum] || "THIRD TERM";

      const classDoc = student.classId
        ? await SchoolClass.findById(student.classId).populate(
            "classTeacher",
            "name",
          )
        : null;
      const classDocPlain = classDoc
        ? {
            _id: classDoc._id,
            name: classDoc.name,
            classTeacherName: classDoc.classTeacher?.name || "-",
          }
        : null;

      const subjects = classDoc?.subjects?.length
        ? classDoc.subjects
        : [
            ...new Set(
              await Grade.find({ student: student._id }).distinct("subject"),
            ),
          ];

      const [present, absent, late] = await Promise.all([
        Attendance.countDocuments({ student: student._id, status: "Present" }),
        Attendance.countDocuments({ student: student._id, status: "Absent" }),
        Attendance.countDocuments({ student: student._id, status: "Late" }),
      ]);

      await generateReportCard(res, {
        student,
        classDoc: classDocPlain,
        subjects,
        terms,
        termLabel,
        session,
        settings,
        attendanceCounts: { present, absent, late },
        Grade,
        User,
      });
    } catch (err) {
      res.status(500).json({ message: err.message });
    }
  },
);

// GET /api/reports/report-cards/bulk?classId=&level=&classGroup=&term=&year=&session=
// Streams ONE combined PDF containing every matching student's report card
// back-to-back, so the principal doesn't have to generate them one by one.
router.get(
  "/report-cards/bulk",
  protect,
  authorize("principal", "juniorAdmin"),
  async (req, res) => {
    try {
      if (req.user.role === "juniorAdmin" && req.query.level === "SSS") {
        return res.status(403).json({
          message: "A Junior School Admin cannot generate SSS report cards",
        });
      }
      const PDFDocument = require("pdfkit");
      const filter = { role: "student" };
      if (req.query.classId) filter.classId = req.query.classId;

      let students = await User.find(filter).sort("name");

      if (req.query.level || req.query.classGroup) {
        const classFilter = {};
        if (req.query.level) classFilter.level = req.query.level;
        if (req.query.classGroup) classFilter.classGroup = req.query.classGroup;
        const matchingClassIds = (
          await SchoolClass.find(classFilter).select("_id")
        ).map((c) => String(c._id));
        students = students.filter((s) =>
          matchingClassIds.includes(String(s.classId)),
        );
      }
      if (req.user.role === "juniorAdmin") {
        const nonSssIds = (
          await SchoolClass.find({ level: { $ne: "SSS" } }).select("_id")
        ).map((c) => String(c._id));
        students = students.filter((s) => nonSssIds.includes(String(s.classId)));
      }

      if (!students.length) {
        return res
          .status(404)
          .json({ message: "No students match that selection" });
      }

      const settings = (await Settings.findOne()) || {};
      const termNum = Number(req.query.term) || 3;
      const year =
        req.query.year ||
        (settings.academicYear || "2025/2026").split("/")[1] ||
        "2026";
      const session = req.query.session || settings.academicYear || "2025/2026";
      const terms = [1, 2, 3].map((n) => `Term ${n} · ${year}`);
      const termLabel = TERM_LABELS[termNum] || "THIRD TERM";

      const doc = new PDFDocument({
        size: "A4",
        margin: 24,
      });
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename=ReportCards-${(req.query.classGroup || req.query.level || "Bulk").replace(/\s+/g, "_")}.pdf`,
      );
      doc.pipe(res);

      for (let i = 0; i < students.length; i++) {
        const student = students[i];
        if (i > 0) doc.addPage();

        const classDoc = student.classId
          ? await SchoolClass.findById(student.classId).populate(
              "classTeacher",
              "name",
            )
          : null;
        const classDocPlain = classDoc
          ? {
              _id: classDoc._id,
              name: classDoc.name,
              classTeacherName: classDoc.classTeacher?.name || "-",
            }
          : null;
        const subjects = classDoc?.subjects?.length
          ? classDoc.subjects
          : [
              ...new Set(
                await Grade.find({ student: student._id }).distinct("subject"),
              ),
            ];
        const [present, absent, late] = await Promise.all([
          Attendance.countDocuments({
            student: student._id,
            status: "Present",
          }),
          Attendance.countDocuments({ student: student._id, status: "Absent" }),
          Attendance.countDocuments({ student: student._id, status: "Late" }),
        ]);

        await generateReportCard(res, {
          student,
          classDoc: classDocPlain,
          subjects,
          terms,
          termLabel,
          session,
          settings,
          attendanceCounts: { present, absent, late },
          Grade,
          User,
          doc,
          isBulk: true,
        });
      }

      doc.end();
    } catch (err) {
      res.status(500).json({ message: err.message });
    }
  },
);

// GET /api/reports/id-card/:studentId
router.get(
  "/id-card/:studentId",
  protect,
  authorize("principal", "juniorAdmin"),
  async (req, res) => {
    try {
      const student = await User.findOne({
        _id: req.params.studentId,
        role: "student",
      }).populate("classId", "name level");
      if (!student)
        return res.status(404).json({ message: "Student not found" });
      if (req.user.role === "juniorAdmin" && student.classId?.level === "SSS") {
        return res.status(403).json({
          message: "A Junior School Admin cannot generate an SSS student's ID card",
        });
      }
      const settings = (await Settings.findOne()) || {};
      const PDFDocument = require("pdfkit");
      const doc = new PDFDocument({ size: [CARD_W, CARD_H], margin: 0 });
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename=IDCard-${(student.admissionNo || student.name).replace(/\s+/g, "_")}.pdf`,
      );
      doc.pipe(res);
      drawIdCard(doc, {
        student,
        schoolName: settings.schoolName || "Nurul-Haq School",
      });
      doc.end();
    } catch (err) {
      res.status(500).json({ message: err.message });
    }
  },
);

// GET /api/reports/id-cards/bulk?level=&classGroup=&classId=
router.get(
  "/id-cards/bulk",
  protect,
  authorize("principal", "juniorAdmin"),
  async (req, res) => {
    try {
      if (req.user.role === "juniorAdmin" && req.query.level === "SSS") {
        return res.status(403).json({
          message: "A Junior School Admin cannot generate SSS ID cards",
        });
      }
      const filter = { role: "student" };
      if (req.query.classId) filter.classId = req.query.classId;
      let students = await User.find(filter)
        .populate("classId", "name level classGroup")
        .sort("name");

      if (req.query.level || req.query.classGroup) {
        const classFilter = {};
        if (req.query.level) classFilter.level = req.query.level;
        if (req.query.classGroup) classFilter.classGroup = req.query.classGroup;
        const matchingIds = (
          await SchoolClass.find(classFilter).select("_id")
        ).map((c) => String(c._id));
        students = students.filter((s) =>
          matchingIds.includes(String(s.classId?._id || s.classId)),
        );
      }
      if (req.user.role === "juniorAdmin") {
        const nonSssIds = (
          await SchoolClass.find({ level: { $ne: "SSS" } }).select("_id")
        ).map((c) => String(c._id));
        students = students.filter((s) => nonSssIds.includes(String(s.classId?._id || s.classId)));
      }

      if (!students.length)
        return res
          .status(404)
          .json({ message: "No students match that selection" });

      const settings = (await Settings.findOne()) || {};
      const PDFDocument = require("pdfkit");
      const doc = new PDFDocument({ size: [CARD_W, CARD_H], margin: 0 });
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename=IDCards-${(req.query.classGroup || req.query.level || "All").replace(/\s+/g, "_")}.pdf`,
      );
      doc.pipe(res);
      students.forEach((student, i) => {
        if (i > 0) doc.addPage({ size: [CARD_W, CARD_H], margin: 0 });
        drawIdCard(doc, {
          student,
          schoolName: settings.schoolName || "Nurul-Haq School",
        });
      });
      doc.end();
    } catch (err) {
      res.status(500).json({ message: err.message });
    }
  },
);

module.exports = router;
