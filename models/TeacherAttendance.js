const mongoose = require("mongoose");

const TeacherAttendanceSchema = new mongoose.Schema(
  {
    teacher: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    date: { type: Date, required: true },
    // Same purpose as Grade.academicYear — set once at creation.
    academicYear: { type: String, default: "" },
    shift: { type: String, enum: ["Morning", "Afternoon"], required: true },
    timeIn: { type: String, default: "" }, // e.g. "07:52 AM"
    lateTag: { type: String, enum: ["Late", "On Time", ""], default: "" },
    timeOut: { type: String, default: "" },
    status: {
      type: String,
      enum: ["Active", "Absent", "On Leave", "Suspended", "Sick"],
      default: "Active",
    },
  },
  { timestamps: true },
);

TeacherAttendanceSchema.index({ teacher: 1, date: 1, shift: 1 }, { unique: true });

module.exports = mongoose.model("TeacherAttendance", TeacherAttendanceSchema);
