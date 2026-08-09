const mongoose = require("mongoose");

const FeeSchema = new mongoose.Schema(
  {
    student: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    term: { type: String, required: true },
    amount: { type: Number, required: true },
    // The student's level fee (Settings.feeAmounts) at the moment this
    // payment was recorded — status below is computed by comparing amount
    // against this. Snapshotted rather than looked up live so a later
    // change to the fee structure doesn't retroactively rewrite history.
    expectedAmount: { type: Number, default: 0 },
    paidOn: { type: Date },
    method: {
      type: String,
      enum: ["Cash", "Bank Transfer", "Mobile Money", ""],
      default: "",
    },
    receipt: { type: String, default: "" },
    // Auto-computed by the server (routes/finance.js) from amount vs.
    // expectedAmount — never trusted from the client, so it can't drift
    // out of sync with the configured level fee.
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
