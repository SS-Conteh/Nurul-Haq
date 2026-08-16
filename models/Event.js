const mongoose = require("mongoose");

const EventSchema = new mongoose.Schema(
  {
    title: { type: String, required: true },
    date: { type: Date, required: true },
    icon: { type: String, default: "📅" },
    description: { type: String, default: "" },
    audience: { type: String, default: "Entire school" },
    // Same purpose as Grade.academicYear — set once at creation.
    academicYear: { type: String, default: "" },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  },
  { timestamps: true },
);

module.exports = mongoose.model("Event", EventSchema);
