const mongoose = require("mongoose");

// ─────────────────────────────────────────────────────────────────────────
// EXPENSE / REQUEST VOUCHER
//
// The digital version of the school's paper "REQUEST FORM" — one document
// per spending request, with a line item per thing bought, who requested
// it, where the money came from, and the approval/payment trail at the
// bottom. Kept deliberately close to the paper layout so anyone who has
// filled the paper form can fill this one, but with the things paper
// can't do: automatic line totals and grand total, a voucher number, an
// approval workflow, receipt attachments, and the whole thing searchable
// and totalled per academic year.
//
// Lifecycle: Pending → Approved → Paid   (or Pending → Rejected)
// Nothing is ever deleted once it has been Approved or Paid — a mistake is
// corrected with a new offsetting voucher, the same rule the bank ledger
// follows.
// ─────────────────────────────────────────────────────────────────────────

const ExpenseItemSchema = new mongoose.Schema(
  {
    qty: { type: Number, default: 1, min: 0 },
    description: { type: String, required: true, trim: true },
    unitCost: { type: Number, default: 0, min: 0 },
    // qty × unitCost, recomputed server-side on every save so a client can
    // never post a line total that doesn't match its own numbers.
    amount: { type: Number, default: 0, min: 0 },
  },
  { _id: false },
);

const ExpenseSchema = new mongoose.Schema(
  {
    // Human-facing voucher number, e.g. "EXP-2026-014". Generated on
    // creation in routes/expenses.js, unique per academic year.
    voucherNo: { type: String, default: "", index: true },
    date: { type: Date, default: Date.now },

    items: {
      type: [ExpenseItemSchema],
      validate: {
        validator: (v) => Array.isArray(v) && v.length > 0,
        message: "At least one expense item is required",
      },
    },
    // Sum of every line's amount — recomputed server-side, never trusted
    // from the client.
    total: { type: Number, default: 0, min: 0 },

    // Free text, exactly as on the paper form: "Partly from money taken
    // from Sheik Ibrahim and partly fees", "2026/2027 fees", etc.
    sourceOfFund: { type: String, default: "", trim: true },
    // Why the school needed to spend this.
    purpose: { type: String, default: "", trim: true },
    // Broad bucket for reporting — what kind of spending this was.
    category: {
      type: String,
      enum: [
        "Stationery",
        "Teaching Materials",
        "Maintenance & Repairs",
        "Utilities",
        "Transport & Fuel",
        "Salaries & Allowances",
        "Examination",
        "Furniture & Equipment",
        "Refreshment & Hospitality",
        "Other",
      ],
      default: "Other",
    },

    // ── The signature block at the foot of the paper form ──
    requestedBy: { type: String, default: "", trim: true },
    requestedOn: { type: Date },
    fundPaidTo: { type: String, default: "", trim: true },
    fundPaidOn: { type: Date },
    purchasedBy: { type: String, default: "", trim: true },
    purchasedOn: { type: Date },
    approvedBy: { type: String, default: "", trim: true },
    approvedOn: { type: Date },

    status: {
      type: String,
      enum: ["Pending", "Approved", "Rejected", "Paid"],
      default: "Pending",
    },
    // Why a request was turned down — shown on the voucher so the record
    // explains itself later.
    rejectionReason: { type: String, default: "", trim: true },

    // Optional photo/scan of the receipt(s) or the signed paper form,
    // stored the same way fee receipts and bank slips are (base64 data
    // URL — see readFileAsDataUrl in app.js).
    receipt: { type: String, default: "" },
    receiptName: { type: String, default: "" },

    // Whether this spending should also be taken out of the bank ledger.
    // Left false for petty cash paid straight out of collected fees.
    fromBank: { type: Boolean, default: false },

    // Which academic year this voucher belongs to — snapshotted at
    // creation from Settings.academicYear so a new school year's expense
    // totals start clean while every past voucher stays exactly where it
    // is, one dropdown away.
    academicYear: { type: String, default: "", index: true },
    term: { type: String, default: "" },

    recordedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    actionedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  },
  { timestamps: true },
);

ExpenseSchema.index({ date: -1 });
ExpenseSchema.index({ status: 1 });

// Keeps every line total and the grand total honest, whatever the client
// sent. Runs on .save() and is called explicitly on findByIdAndUpdate in
// routes/expenses.js (where middleware wouldn't otherwise fire).
ExpenseSchema.statics.recalc = function (doc) {
  (doc.items || []).forEach((it) => {
    it.amount = (Number(it.qty) || 0) * (Number(it.unitCost) || 0);
  });
  doc.total = (doc.items || []).reduce((s, it) => s + (Number(it.amount) || 0), 0);
  return doc;
};

ExpenseSchema.pre("save", function (next) {
  this.constructor.recalc(this);
  next();
});

module.exports = mongoose.model("Expense", ExpenseSchema);
