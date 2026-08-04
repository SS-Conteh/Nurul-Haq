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
  Nursery: ["Nursery 1", "Nursery 2"],
  Primary: ["Class 1", "Class 2", "Class 3", "Class 4", "Class 5", "Class 6"],
  JSS: ["JSS 1", "JSS 2", "JSS 3"],
  SSS: ["Art", "Science", "Commercial"],
};

module.exports = mongoose.model("SchoolClass", SchoolClassSchema);
