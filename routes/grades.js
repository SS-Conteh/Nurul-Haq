const express = require("express");
const Grade = require("../models/Grade");
const User = require("../models/User");
const { protect, authorize } = require("../middleware/auth");

const router = express.Router();

// GET /api/grades?studentId=&classId=&term=&subject=
router.get("/", protect, async (req, res) => {
  const filter = {};
  if (req.query.studentId) filter.student = req.query.studentId;
  if (req.query.term) filter.term = req.query.term;
  if (req.query.subject) filter.subject = req.query.subject;

  // Students may only see their own grades
  if (req.user.role === "student") filter.student = req.user._id;

  if (req.query.classId && !req.query.studentId) {
    const studentIds = await User.find({
      role: "student",
      classId: req.query.classId,
    }).distinct("_id");
    filter.student = { $in: studentIds };
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
      const classStudentIds = await User.find({
        role: "student",
        classId: ownClassId,
      }).distinct("_id");
      scopeOr.push({ student: { $in: classStudentIds } });
    }
    if (!scopeOr.length) return res.json({ grades: [] });

    const grades = await Grade.find({ $and: [filter, { $or: scopeOr }] })
      .populate({ path: "student", select: "name initials color classId avatarUrl", populate: { path: "classId", select: "name" } })
      .populate("teacher", "name")
      .lean();
    return res.json({ grades });
  }

  const grades = await Grade.find(filter)
    .populate({ path: "student", select: "name initials color classId avatarUrl", populate: { path: "classId", select: "name" } })
    .populate("teacher", "name")
    .lean();
  res.json({ grades });
});

// POST /api/grades - teacher submits/updates a grade
router.post(
  "/",
  protect,
  authorize("teacher", "principal", "juniorAdmin"),
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
      let grade = await Grade.findOne({ student, subject, term });
      if (grade) {
        // Once a teacher has entered a grade, it's locked from their side —
        // only an Admin/Principal can go back and correct it. This keeps a
        // grade tamper-proof from the entering teacher after the fact.
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
        grade = await Grade.create({
          student,
          subject,
          term,
          test,
          examScore,
          remark,
          position,
          teacher: req.user._id,
        });
      }
      res.status(201).json({ grade });
    } catch (err) {
      res.status(400).json({ message: err.message });
    }
  },
);

// PUT /api/grades/:id
router.put(
  "/:id",
  protect,
  authorize("principal", "juniorAdmin"),
  async (req, res) => {
    // Admin-only: this is the "edit an existing grade" path. Teachers use
    // POST / to submit a grade for the first time, but can never come back
    // through here — only an Admin/Principal can amend a grade once it's
    // been entered.
    const grade = await Grade.findById(req.params.id);
    if (!grade) return res.status(404).json({ message: "Grade not found" });
    Object.assign(grade, req.body);
    await grade.save();
    res.json({ grade });
  },
);

// DELETE /api/grades/:id
router.delete(
  "/:id",
  protect,
  authorize("principal", "juniorAdmin"),
  async (req, res) => {
    const grade = await Grade.findByIdAndDelete(req.params.id);
    if (!grade) return res.status(404).json({ message: "Grade not found" });
    res.json({ message: "Grade removed" });
  },
);

module.exports = router;
