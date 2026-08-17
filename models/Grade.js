const mongoose = require("mongoose");

const GradeSchema = new mongoose.Schema(
  {
    student: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    // Snapshot of which class the student was actually IN at the moment
    // this grade was recorded — set once at creation and never touched
    // again, even if the student is later promoted/moved to a different
    // class. Without this, "grades for class X" could only be resolved by
    // checking each student's CURRENT classId, which meant a promoted
    // student's entire grade history would incorrectly follow them into
    // their new class. Filtering/scoping by class must always use THIS
    // field, never the student's live classId.
    classId: { type: mongoose.Schema.Types.ObjectId, ref: "SchoolClass" },
    subject: { type: String, required: true },
    // No default — a grade must always be explicitly tagged with whatever
    // term is currently set in Settings (see routes/grades.js). A stray
    // default here was previously masking grades getting silently mis-tagged
    // whenever the term dropdown wasn't wired up correctly on the frontend.
    term: { type: String, required: true },
    // Which academic year this grade belongs to (e.g. "2025/2026") — set
    // once at creation from Settings.academicYear, never changed after.
    // This is what lets the academic-year dropdown show a past year's
    // grades/report cards without touching a single record: nothing is
    // ever deleted or moved, a query just filters on this field.
    academicYear: { type: String, default: "" },
    teacher: { type: mongoose.Schema.Types.ObjectId, ref: "User" },

    // ── What the teacher actually enters — each an ACTUAL score out of 100 ──
    test: { type: Number, min: 0, max: 100, default: 0 },
    examScore: { type: Number, min: 0, max: 100, default: 0 },

    // ── Auto-computed from test/examScore on every save — never set this
    // directly. Kept as its own field (rather than computed only on read)
    // because the report card, class averages, and analytics all read it
    // straight off the stored document. Shown on the grades table as "Min". ──
    total: { type: Number, default: 0 }, // (test + examScore) / 2, rounded, out of 100

    grade: { type: String, default: "" },
    position: { type: String, default: "" },
    remark: { type: String, default: "" },
  },
  { timestamps: true },
);

GradeSchema.index({ student: 1, term: 1 });
GradeSchema.index({ subject: 1 });

GradeSchema.pre("save", function (next) {
  // Test and Exam are both entered as the actual score out of 100. Total
  // (shown on the grades table as "Min") is their plain average — no more
  // 40/60 weighting. e.g. Test=60, Exam=89 -> Total = (60+89)/2 = 74.5 -> 75
  this.total = Math.round(((this.test || 0) + (this.examScore || 0)) / 2);

  const v = this.total;
  this.grade =
    v >= 80 ? "A" : v >= 70 ? "B" : v >= 60 ? "C" : v >= 50 ? "D" : "F";
  next();
});

module.exports = mongoose.model("Grade", GradeSchema);
