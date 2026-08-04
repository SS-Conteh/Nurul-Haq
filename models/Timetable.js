const mongoose = require("mongoose");

const TimetableSchema = new mongoose.Schema(
  {
    classId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "SchoolClass",
      required: true,
    },
    day: {
      type: String,
      // Nurul-Haq Islamic Academy's school week runs Sunday through
      // Thursday (Friday/Saturday are the weekend), so the timetable is
      // built around those five days instead of the usual Mon-Fri.
      enum: ["Sun", "Mon", "Tue", "Wed", "Thu"],
      required: true,
    },
    time: { type: String, required: true },
    subject: { type: String, required: true },
    teacher: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    room: { type: String, default: "" },
  },
  { timestamps: true },
);

module.exports = mongoose.model("Timetable", TimetableSchema);
