const mongoose = require("mongoose");

// One record per student per academic year, created by the General Admin
// explicitly running "Compute Promotions" (see routes/promotions.js +
// utils/promotion.js) once Term 3 grades are in for that year — NEVER
// automatically on an academic-year change. This record is purely a
// DECISION at first ("Promoted to SSS 2", "Repeat", "Pending", "Graduating")
// — it does NOT move the student's own classId. The actual move happens
// later, in one batch, the moment the Admin sets a NEW academic year (see
// applyPromotionsForYear in utils/promotion.js) — that's what `appliedAt`
// tracks. Nothing about a student's grade/attendance history is ever
// touched by any of this; every Grade already permanently remembers which
// class it was recorded in (Grade.classId), so a promoted student's past
// records simply stay exactly where they are.
const PromotionSchema = new mongoose.Schema(
  {
    student: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    // The academic year being evaluated, e.g. "2025/2026" — the year whose
    // Term 3 grades decided this outcome. The student moves into the next
    // class starting the FOLLOWING academic year (or immediately, if the
    // school re-enters the same year's next term under this same year).
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
    // When the outcome was actually EXECUTED — i.e. the student's own
    // classId was moved (Promoted), or confirmed to stay put (Repeat/
    // Graduating). This happens at year-rollover (see
    // utils/promotion.js applyPromotionsForYear, triggered from
    // routes/settings.js when the Admin sets a NEW academic year) — not
    // at the moment the outcome was decided. A "Promoted" record can sit
    // fully decided for weeks with appliedAt still null; the student
    // keeps attending their OLD class as normal right up until the new
    // academic year actually starts. Null means "decided, not yet
    // applied" (or, for Pending, "not decided at all yet").
    appliedAt: { type: Date, default: null },
    // Whether the student has been shown their congratulations/
    // encouragement popup for this outcome yet (see
    // GET/PUT /promotions/mine/pending-notification). Only ever flips
    // once, right after they dismiss it — never reset.
    notified: { type: Boolean, default: false },
  },
  { timestamps: true },
);

// One decision per student per year.
PromotionSchema.index({ student: 1, academicYear: 1 }, { unique: true });

module.exports = mongoose.model("Promotion", PromotionSchema);
