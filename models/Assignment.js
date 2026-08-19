const mongoose = require("mongoose");

const AssignmentSchema = new mongoose.Schema(
  {
    title: { type: String, required: true },
    subject: { type: String, required: true },
    classId: { type: mongoose.Schema.Types.ObjectId, ref: "SchoolClass" },
    dueDate: { type: Date, required: true },
    priority: {
      type: String,
      enum: ["High", "Medium", "Low"],
      default: "Medium",
    },
    status: {
      type: String,
      enum: ["Not Started", "In Progress", "Pending", "Submitted", "Graded"],
      default: "Not Started",
    },
    description: { type: String, default: "" },
    // Base64 data URL of an uploaded assignment PDF the teacher attaches
    // (same "store it straight on the document" pattern already used for
    // avatarUrl elsewhere in this app). Empty string = no document attached.
    documentUrl: { type: String, default: "" },
    documentName: { type: String, default: "" },
    teacher: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    // Same purpose as Grade.academicYear — set once at creation from
    // Settings.academicYear, never changed after. Lets a new academic
    // year start with a clean assignments list without deleting last
    // year's — see utils/academicYear.js.
    academicYear: { type: String, default: "" },
    // Same idea, one level finer — the "Term X · YYYY" string current in
    // Settings when this assignment was created (see utils/term.js). Empty
    // on anything created before this field existed, or before a current
    // term was ever set — it just won't match a specific-term filter,
    // though it still shows up under "All Terms".
    term: { type: String, default: "" },
    submissions: [
      {
        student: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
        submittedAt: Date,
        grade: String,
      },
    ],
  },
  { timestamps: true },
);

module.exports = mongoose.model("Assignment", AssignmentSchema);
