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
    // Free-text period label the Principal/Admin types in when setting the
    // timetable (e.g. "7:30–8:30") — no longer a fixed hardcoded slot list,
    // so every class can run its own bell schedule. `sortOrder` is set from
    // the row's position in the "Set Timetable" grid so the display page
    // can show periods top-to-bottom in the order they were entered, not
    // alphabetically by the free-text time string.
    time: { type: String, required: true },
    sortOrder: { type: Number, default: 0 },
    // A break period (e.g. "Break", "Assembly") has no subject/teacher —
    // it's the same for every class and just occupies a row on the grid.
    isBreak: { type: Boolean, default: false },
    subject: {
      type: String,
      required: function () {
        return !this.isBreak;
      },
      default: "",
    },
    teacher: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    room: { type: String, default: "" },
  },
  { timestamps: true },
);

module.exports = mongoose.model("Timetable", TimetableSchema);
