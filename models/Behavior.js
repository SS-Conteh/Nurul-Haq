const mongoose = require("mongoose");

const BehaviorSchema = new mongoose.Schema(
  {
    student: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    title: { type: String, required: true },
    note: { type: String, default: "" },
    color: { type: String, default: "#4f8cff" },
    date: { type: Date, default: Date.now },
    recordedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    ratings: {
      punctuality: { type: Number, default: 90 },
      discipline: { type: Number, default: 90 },
      participation: { type: Number, default: 85 },
      homework: { type: Number, default: 88 },
      respect: { type: Number, default: 95 },
      teamwork: { type: Number, default: 85 },
    },
    overallConduct: { type: String, default: "Excellent" },
    disciplinaryCases: { type: Number, default: 0 },
    awards: { type: Number, default: 0 },
  },
  { timestamps: true },
);

module.exports = mongoose.model("Behavior", BehaviorSchema);
