const mongoose = require("mongoose");

const FeeSchema = new mongoose.Schema(
  {
    student: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    // A single installment payment toward the student's ANNUAL fee — a
    // student may make several of these across the year (one per term, or
    // any other split) or a single lump-sum payment covering the whole
    // year. This is purely a label for the admin's own record-keeping
    // ("this installment was for Term 1") and is never used to compute
    // balance/status — that's always the sum of every installment against
    // the annual fee. Optional: left blank for a lump-sum/undesignated
    // payment.
    term: { type: String, default: "" },
    amount: { type: Number, required: true },
    // Snapshot of Settings.academicYear at the moment this payment was
    // recorded, so a new school year's fee tracking starts clean instead
    // of mixing with (or being blocked by) last year's payments.
    academicYear: { type: String, default: "" },
    // The student's level fee for the FULL ACADEMIC YEAR (Settings.feeAmounts)
    // at the moment this payment was recorded — status below is computed by
    // comparing the student's cumulative payments for the year (this record
    // plus every other installment already on file) against this figure.
    // Snapshotted rather than looked up live so a later change to the fee
    // structure doesn't retroactively rewrite history.
    expectedAmount: { type: Number, default: 0 },
    paidOn: { type: Date },
    method: {
      type: String,
      enum: ["Cash", "Bank Transfer", "Mobile Money", ""],
      default: "",
    },
    // A photo/scan of the physical receipt handed to the student — kept as
    // proof of payment. Mandatory going forward (enforced in
    // routes/finance.js, not here, so older records recorded before this
    // was required don't fail validation retroactively).
    receipt: { type: String, default: "" },
    // Auto-computed by the server (routes/finance.js) from the student's
    // cumulative year-to-date payments (including this one) vs.
    // expectedAmount — never trusted from the client, so it can't drift out
    // of sync with the configured annual fee. Reflects the running
    // Paid/Partial/Unpaid position as of this payment, not just this
    // installment in isolation.
    status: {
      type: String,
      enum: ["Paid", "Partial", "Unpaid"],
      default: "Unpaid",
    },
    // Which Admin/Junior Admin entered this payment — the Principal never
    // creates or edits fee records (view-only), so this is always an audit
    // trail of admin staff activity for financial record-keeping.
    recordedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  },
  { timestamps: true },
);

FeeSchema.index({ student: 1 });
FeeSchema.index({ status: 1 });

module.exports = mongoose.model("Fee", FeeSchema);
