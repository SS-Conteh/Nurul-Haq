const mongoose = require("mongoose");

const AttendanceSchema = new mongoose.Schema(
  {
    student: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    classId: { type: mongoose.Schema.Types.ObjectId, ref: "SchoolClass" },
    date: { type: Date, required: true, default: Date.now },
    // Same purpose as Grade.academicYear — set once at creation, lets the
    // academic-year dropdown show a past year's attendance register
    // without archiving/deleting anything.
    academicYear: { type: String, default: "" },
    // Same idea, one level finer — the "Term X · YYYY" string current in
    // Settings at the moment this record was marked (see utils/term.js).
    // Empty string on anything marked before this field existed, or on
    // any day the school hadn't set a current term yet — a term-scoped
    // filter simply doesn't match those rows, same as everywhere else
    // this pattern is used.
    term: { type: String, default: "" },
    status: {
      type: String,
      enum: ["Present", "Absent", "Late"],
      required: true,
    },
    reason: { type: String, default: "" },
    approvedBy: { type: String, default: "" },
    markedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    time: { type: String, default: "" },
  },
  { timestamps: true },
);

AttendanceSchema.index({ student: 1, date: 1 }, { unique: true });
AttendanceSchema.index({ classId: 1, date: 1 });

module.exports = mongoose.model("Attendance", AttendanceSchema);
