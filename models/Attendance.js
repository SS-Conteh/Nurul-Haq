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
    // Same purpose as academicYear, but for the current TERM — set once
    // at creation from Settings.currentTerm/academicYear (see
    // utils/academicYear.js currentTermString). Lets the term dropdown
    // on the Attendance page show one term's register at a time without
    // archiving/deleting anything. Empty string on records created
    // before this field existed — treated as "unscoped" the same way an
    // empty academicYear is.
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
