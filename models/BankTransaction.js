const mongoose = require("mongoose");

// Deposit/withdrawal ledger for the school's bank account — entered by the
// General Admin only, for proper financial record-keeping/audit purposes.
// The Principal can view this ledger but never creates or edits entries
// (same view-only relationship the Principal has with fee payments).
const BankTransactionSchema = new mongoose.Schema(
  {
    type: {
      type: String,
      enum: ["Deposit", "Withdrawal"],
      required: true,
    },
    amount: { type: Number, required: true, min: 0 },
    date: { type: Date, default: Date.now },
    bankName: { type: String, default: "" },
    purpose: { type: String, default: "" }, // e.g. "Term 2 fee collections", "Staff salaries"
    // Photo/scan of the deposit slip, withdrawal slip, or transfer receipt —
    // required on every new transaction so there's always something to
    // check the ledger against. Stored the same way avatars/assignment
    // documents are (base64 data URL) — see readFileAsDataUrl in app.js.
    slipUrl: { type: String, required: true },
    slipName: { type: String, default: "" },
    recordedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
  },
  { timestamps: true },
);

BankTransactionSchema.index({ date: -1 });
BankTransactionSchema.index({ type: 1 });

module.exports = mongoose.model("BankTransaction", BankTransactionSchema);
