const express = require("express");
const Grade = require("../models/Grade");
const User = require("../models/User");
const Settings = require("../models/Settings");
const { protect, authorize } = require("../middleware/auth");
const { yearFilter, currentTermString } = require("../utils/academicYear");

const router = express.Router();

// Grading is locked to the current term for a teacher's first-time
// submission — see the POST / handler below. Kept as a local alias so the
// rest of this file's comments/call sites don't need to change.
const expectedCurrentTermString = currentTermString;

// GET /api/grades?studentId=&classId=&term=&subject=&ay=
router.get("/", protect, async (req, res) => {
  const settings = await Settings.findOne();
  const filter = { ...yearFilter(settings?.academicYear, req.query.ay) };
  if (req.query.studentId) filter.student = req.query.studentId;
  if (req.query.term) filter.term = req.query.term;
  if (req.query.subject) filter.subject = req.query.subject;

  // Students may only see their own grades
  if (req.user.role === "student") filter.student = req.user._id;

  if (req.query.classId && !req.query.studentId) {
    // Match grades actually recorded while the student was in this class
    // — NOT students currently in this class. A promoted student's old
    // grades stay attached to the class they earned them in.
    filter.classId = req.query.classId;
  }

  // A Junior School Admin (Nursery–JSS only) may never see grades for a
  // student in an SSS class, no matter what filters they pass.
  if (req.user.role === "juniorAdmin") {
    const SchoolClass = require("../models/SchoolClass");
    const nonSssClassIds = await SchoolClass.find({
      level: { $ne: "SSS" },
    }).distinct("_id");
    const scopedStudentIds = (
      await User.find({ role: "student", classId: { $in: nonSssClassIds } }).distinct("_id")
    ).map(String);

    if (typeof filter.student === "string") {
      // A specific studentId was requested — only honor it if it's in scope.
      if (!scopedStudentIds.includes(filter.student)) filter.student = { $in: [] };
    } else if (filter.student && filter.student.$in) {
      // Narrowed already by classId — intersect with the in-scope set.
      const already = filter.student.$in.map(String);
      filter.student = { $in: already.filter((id) => scopedStudentIds.includes(id)) };
    } else {
      filter.student = { $in: scopedStudentIds };
    }
  }

  // A teacher may only see: grades in their own subject (for any class they
  // teach), or — if they're a Class Master — grades for any subject but only
  // for the students in their own class.
  if (req.user.role === "teacher") {
    const ownSubjects = req.user.subjects || [];
    const ownClassId = req.user.classTeacherOf
      ? String(req.user.classTeacherOf)
      : null;
    const scopeOr = [];
    if (ownSubjects.length) scopeOr.push({ subject: { $in: ownSubjects } });
    if (ownClassId) {
      // Grades actually recorded while a student was in this teacher's
      // class — not just whichever students happen to be in it today.
      scopeOr.push({ classId: ownClassId });
    }
    if (!scopeOr.length) return res.json({ grades: [] });

    const grades = await Grade.find({ $and: [filter, { $or: scopeOr }] })
      .populate({ path: "student", select: "name initials color classId avatarUrl", populate: { path: "classId", select: "name" } })
      .populate("teacher", "name")
      .populate("classId", "name level")
      .lean();
    return res.json({ grades });
  }

  const grades = await Grade.find(filter)
    .populate({ path: "student", select: "name initials color classId avatarUrl", populate: { path: "classId", select: "name" } })
    .populate("teacher", "name")
    .populate("classId", "name level")
    .lean();
  res.json({ grades });
});

// POST /api/grades - teacher submits a grade; admin/juniorAdmin can submit
// or correct one directly. The Principal can view grades but never
// edits/submits one.
router.post(
  "/",
  protect,
  authorize("teacher", "juniorAdmin", "admin"),
  async (req, res) => {
    try {
      const { student, subject, term, test, examScore, remark, position } = req.body;
      if (
        req.user.role === "teacher" &&
        (req.user.subjects || []).length &&
        !req.user.subjects.includes(subject)
      ) {
        return res
          .status(403)
          .json({ message: "You can only submit grades for your own subject(s)" });
      }
      // A teacher may only ever grade the term the school is CURRENTLY on —
      // never a term of their own choosing. This is what makes the term set
      // in Settings actually govern the whole system: an Admin/Junior Admin
      // may still backfill/correct a past term's grade, but a teacher's
      // first-time submission is always pinned to Settings.currentTerm.
      if (req.user.role === "teacher") {
        const settingsForTerm = await Settings.findOne();
        const expectedTerm = expectedCurrentTermString(settingsForTerm);
        if (!expectedTerm) {
          return res.status(400).json({
            message: "The current term hasn't been set yet — ask an Admin to set it in Settings before grades can be entered.",
          });
        }
        if (term !== expectedTerm) {
          return res.status(400).json({
            message: `Grades can only be submitted for the current term (${expectedTerm}).`,
          });
        }
      }
      let grade = await Grade.findOne({ student, subject, term });
      if (grade) {
        // Once a teacher has entered a grade, it's locked from their side —
        // only an Admin (General or Junior School) can go back and correct
        // it; the Principal can never edit a grade, only view it. This keeps
        // a grade tamper-proof from the entering teacher after the fact.
        if (req.user.role === "teacher") {
          return res.status(403).json({
            message:
              "This grade has already been submitted and can no longer be edited. Contact an admin if it needs to be corrected.",
          });
        }
        Object.assign(grade, {
          test,
          examScore,
          remark,
          position,
          teacher: grade.teacher || req.user._id,
        });
        await grade.save();
      } else {
        const settings = await Settings.findOne();
        const studentDoc = await User.findById(student).select("classId");
        grade = await Grade.create({
          student,
          // Snapshot the class the student is in RIGHT NOW — this is what
          // permanently ties the grade to that class, even if the student
          // is promoted to a different one later.
          classId: studentDoc?.classId || null,
          subject,
          term,
          test,
          examScore,
          remark,
          position,
          teacher: req.user._id,
          academicYear: settings?.academicYear || "",
        });
      }
      res.status(201).json({ grade });
    } catch (err) {
      res.status(400).json({ message: err.message });
    }
  },
);

// PUT /api/grades/:id - admin / juniorAdmin only. The Principal can view
// grades but never edits one.
router.put(
  "/:id",
  protect,
  authorize("admin", "juniorAdmin"),
  async (req, res) => {
    // Admin-only: this is the "edit an existing grade" path. Teachers use
    // POST / to submit a grade for the first time, but can never come back
    // through here — only an Admin (General or Junior School) can amend a
    // grade once it's been entered. The Principal is view-only for grades.
    const grade = await Grade.findById(req.params.id);
    if (!grade) return res.status(404).json({ message: "Grade not found" });
    Object.assign(grade, req.body);
    await grade.save();
    res.json({ grade });
  },
);

// DELETE /api/grades/:id - admin / juniorAdmin only. The Principal can view
// grades but never removes one.
router.delete(
  "/:id",
  protect,
  authorize("admin", "juniorAdmin"),
  async (req, res) => {
    const grade = await Grade.findByIdAndDelete(req.params.id);
    if (!grade) return res.status(404).json({ message: "Grade not found" });
    res.json({ message: "Grade removed" });
  },
);

module.exports = router;
