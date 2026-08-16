const mongoose = require("mongoose");

const SchoolClassSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, unique: true, trim: true }, // e.g. "Class 1A", "JSS 2B"
    level: {
      type: String,
      enum: ["Nursery", "Primary", "JSS", "SSS"],
      required: true,
    },
    // The class-group this section belongs to, e.g. "Class 1" / "JSS 2" / "SSS 3"
    classGroup: { type: String, required: true, trim: true },
    classTeacher: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    subjects: [{ type: String }],
  },
  { timestamps: true },
);

// Handy constant lists other modules can reuse
SchoolClassSchema.statics.LEVELS = ["Nursery", "Primary", "JSS", "SSS"];
SchoolClassSchema.statics.CLASS_GROUPS = {
  Nursery: ["Nursery 1", "Nursery 2", "Nursery 3"],
  Primary: ["Class 1", "Class 2", "Class 3", "Class 4", "Class 5", "Class 6"],
  JSS: ["JSS 1", "JSS 2", "JSS 3"],
  SSS: ["Art", "Science", "Commercial"],
};
// The last classGroup in each level's sequence is a terminal/outgoing
// year — Nursery 3, Class 6, JSS 3 — no further promotion exists for a
// student there; they graduate out of the level instead. SSS is the
// exception: its classGroup is the STREAM (Art/Science/Commercial), not a
// year, so "terminal" there is decided by parsing the year number out of
// the class NAME instead (e.g. "SSS 3 Art") — see utils/promotion.js.
SchoolClassSchema.statics.TERMINAL_CLASS_GROUPS = {
  Nursery: "Nursery 3",
  Primary: "Class 6",
  JSS: "JSS 3",
};

module.exports = mongoose.model("SchoolClass", SchoolClassSchema);
