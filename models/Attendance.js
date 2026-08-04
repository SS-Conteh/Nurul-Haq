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
