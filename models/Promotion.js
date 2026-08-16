const mongoose = require("mongoose");

// One record per student per academic year that just ended — created
// automatically when the General Admin sets a NEW academic year in
// Settings (see routes/settings.js + utils/promotion.js). Nothing about a
// student's grade/attendance history is ever touched by this; it's purely
// a decision record so the next report card can print "Promoted to: SSS 2"
// / "To Repeat" / "Pending Promotion", and so the Admin has something to
// approve or reject for the 45–49% band.
const PromotionSchema = new mongoose.Schema(
  {
    student: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    // The academic year being evaluated — the one that just ended, e.g.
    // "2025/2026". The student is moving INTO the year after this one.
    academicYear: { type: String, required: true },
    fromClass: { type: mongoose.Schema.Types.ObjectId, ref: "SchoolClass" },
    // Null while Pending, and stays null for Repeat/Graduating.
    toClass: { type: mongoose.Schema.Types.ObjectId, ref: "SchoolClass", default: null },
    yearlyMean: { type: Number, default: 0 },
    status: {
      type: String,
      enum: ["Promoted", "Pending", "Repeat", "Graduating"],
      required: true,
    },
    // Set only once an Admin has acted on a "Pending" record (approved ->
    // Promoted, or rejected -> Repeat). Auto-decided Promoted/Repeat/
    // Graduating records never get these set — there was no one to decide.
    decidedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    decidedAt: { type: Date, default: null },
    // Filled in only if a same-level "next class" genuinely couldn't be
    // found (e.g. no SSS 2 Art class has been registered yet) — the
    // student's class is left unchanged and this explains why to whoever
    // reviews it.
    note: { type: String, default: "" },
  },
  { timestamps: true },
);

// One decision per student per year.
PromotionSchema.index({ student: 1, academicYear: 1 }, { unique: true });

module.exports = mongoose.model("Promotion", PromotionSchema);
