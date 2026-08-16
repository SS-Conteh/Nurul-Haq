const mongoose = require("mongoose");

const ExamSchema = new mongoose.Schema(
  {
    name: { type: String, required: true },
    subject: { type: String, required: true },
    classes: { type: String, default: "JSS 1–3" },
    term: { type: String, required: true, default: "Term 2 · 2026" },
    date: { type: String, required: true },
    duration: { type: String, default: "2 hrs" },
    venue: { type: String, default: "Main Hall" },
    // Same purpose as Grade.academicYear — set once at creation from
    // Settings.academicYear — see utils/academicYear.js.
    academicYear: { type: String, default: "" },
    status: {
      type: String,
      enum: ["Upcoming", "Scheduled", "Ongoing", "Completed"],
      default: "Upcoming",
    },
  },
  { timestamps: true },
);

module.exports = mongoose.model("Exam", ExamSchema);
