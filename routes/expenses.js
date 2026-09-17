const express = require("express");
const Expense = require("../models/Expense");
const Settings = require("../models/Settings");
const BankTransaction = require("../models/BankTransaction");
const { protect, authorize } = require("../middleware/auth");
const { yearFilter } = require("../utils/academicYear");
const router = express.Router();

// ─────────────────────────────────────────────────────────────────────────
// EXPENSES — the digital request form / spending voucher.
//
// Who can do what:
//   Record & edit a Pending voucher .... General Admin, Junior School Admin,
//                                        either Bursar
//   Approve / reject / mark paid ....... General Admin and the oversight
//                                        tier (Principal/Proprietor) only —
//                                        the same people who sign the paper
//                                        form's "Approved By" line
//   View ............................... all of the above
//
// A Bursar or Junior Admin can raise a request but can never approve their
// own — that separation is the whole point of the paper form and it is
// enforced here, not just hidden in the UI.
// ─────────────────────────────────────────────────────────────────────────

const VIEW_ROLES = ["principal", "juniorAdmin", "seniorBursar", "juniorBursar"];
const RECORD_ROLES = ["admin", "juniorAdmin", "seniorBursar", "juniorBursar"];
const APPROVE_ROLES = ["principal"]; // authorize() folds "admin" in automatically

const populateFields = [
  { path: "recordedBy", select: "name role" },
  { path: "actionedBy", select: "name role" },
];

// "EXP-2026-014" — sequential within the academic year, so the numbering
// restarts cleanly each year the same way the paper book does.
async function nextVoucherNo(academicYear) {
  const yearPart = (academicYear || "").split("/")[1] || new Date().getFullYear();
  const count = await Expense.countDocuments({ academicYear });
  return `EXP-${yearPart}-${String(count + 1).padStart(3, "0")}`;
}

// Strips anything a client should never be able to set directly (totals,
// voucher number, status, audit fields) and normalises the line items.
function sanitize(body) {
  const items = (Array.isArray(body.items) ? body.items : [])
    .filter((it) => String(it?.description || "").trim())
    .map((it) => ({
      qty: Number(it.qty) || 0,
      description: String(it.description).trim(),
      unitCost: Number(it.unitCost) || 0,
      amount: (Number(it.qty) || 0) * (Number(it.unitCost) || 0),
    }));
  return {
    date: body.date || new Date(),
    items,
    sourceOfFund: body.sourceOfFund || "",
    purpose: body.purpose || "",
    category: body.category || "Other",
    requestedBy: body.requestedBy || "",
    requestedOn: body.requestedOn || null,
    fundPaidTo: body.fundPaidTo || "",
    fundPaidOn: body.fundPaidOn || null,
    purchasedBy: body.purchasedBy || "",
    purchasedOn: body.purchasedOn || null,
    receipt: body.receipt || "",
    receiptName: body.receiptName || "",
    fromBank: !!body.fromBank,
    term: body.term || "",
  };
}

// GET /api/expenses — every voucher for the current (or requested)
// academic year, newest first. Optional ?status= and ?category= filters.
router.get("/", protect, authorize(...VIEW_ROLES), async (req, res) => {
  const settings = await Settings.findOne();
  const filter = { ...yearFilter(settings?.academicYear, req.query.ay) };
  if (req.query.status) filter.status = req.query.status;
  if (req.query.category) filter.category = req.query.category;
  if (req.query.term) filter.term = req.query.term;

  let expenses = await Expense.find(filter).sort("-date -createdAt");
  for (const p of populateFields) expenses = await Expense.populate(expenses, p);
  res.json({ expenses });
});

// GET /api/expenses/summary — the cards above the expenses table. Only
// Approved and Paid vouchers count toward "spent"; a Pending request is
// money the school hasn't parted with yet, so it's reported separately.
router.get("/summary", protect, authorize(...VIEW_ROLES), async (req, res) => {
  const settings = await Settings.findOne();
  const expenses = await Expense.find(
    yearFilter(settings?.academicYear, req.query.ay),
  );

  const sumWhere = (fn) =>
    expenses.filter(fn).reduce((s, e) => s + (e.total || 0), 0);

  const byCategory = {};
  expenses
    .filter((e) => e.status === "Approved" || e.status === "Paid")
    .forEach((e) => {
      byCategory[e.category] = (byCategory[e.category] || 0) + (e.total || 0);
    });

  res.json({
    totalSpent: sumWhere((e) => e.status === "Approved" || e.status === "Paid"),
    pendingValue: sumWhere((e) => e.status === "Pending"),
    pendingCount: expenses.filter((e) => e.status === "Pending").length,
    paidValue: sumWhere((e) => e.status === "Paid"),
    count: expenses.length,
    byCategory: Object.entries(byCategory)
      .map(([category, amount]) => ({ category, amount }))
      .sort((a, b) => b.amount - a.amount),
  });
});

// POST /api/expenses — raise a new request/voucher.
router.post("/", protect, authorize(...RECORD_ROLES), async (req, res) => {
  try {
    const clean = sanitize(req.body);
    if (!clean.items.length) {
      return res
        .status(400)
        .json({ message: "Add at least one item with a description" });
    }
    const settings = await Settings.findOne();
    const academicYear = settings?.academicYear || "";
    const expense = new Expense({
      ...clean,
      academicYear,
      voucherNo: await nextVoucherNo(academicYear),
      status: "Pending",
      recordedBy: req.user._id,
      requestedBy: clean.requestedBy || req.user.name,
      requestedOn: clean.requestedOn || new Date(),
    });
    await expense.save();
    for (const p of populateFields) await expense.populate(p);
    res.status(201).json({ expense });
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

// PUT /api/expenses/:id — edit a voucher. Only while it is still Pending:
// once it has been approved or paid the figures are part of the financial
// record and a correction has to be a new voucher, not a quiet rewrite.
router.put("/:id", protect, authorize(...RECORD_ROLES), async (req, res) => {
  try {
    const existing = await Expense.findById(req.params.id);
    if (!existing) return res.status(404).json({ message: "Voucher not found" });
    if (existing.status !== "Pending") {
      return res.status(400).json({
        message: `This voucher is already ${existing.status} and can no longer be edited. Raise a correcting voucher instead.`,
      });
    }
    const clean = sanitize(req.body);
    if (!clean.items.length) {
      return res
        .status(400)
        .json({ message: "Add at least one item with a description" });
    }
    Object.assign(existing, clean);
    await existing.save(); // pre-save hook recomputes line totals + grand total
    for (const p of populateFields) await existing.populate(p);
    res.json({ expense: existing });
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

// PATCH /api/expenses/:id/status — approve, reject, or mark as paid.
// General Admin and the oversight tier only, and never on your own
// request: whoever raised it cannot be the one who signs it off.
router.patch(
  "/:id/status",
  protect,
  authorize(...APPROVE_ROLES),
  async (req, res) => {
    try {
      const { status, rejectionReason } = req.body;
      if (!["Approved", "Rejected", "Paid"].includes(status)) {
        return res.status(400).json({ message: "Invalid status" });
      }
      const expense = await Expense.findById(req.params.id);
      if (!expense) return res.status(404).json({ message: "Voucher not found" });

      if (String(expense.recordedBy) === String(req.user._id)) {
        return res.status(403).json({
          message:
            "You raised this request, so you cannot approve it yourself. Another approver has to sign it off.",
        });
      }
      if (status === "Paid" && expense.status !== "Approved") {
        return res
          .status(400)
          .json({ message: "A voucher has to be approved before it is paid" });
      }

      expense.status = status;
      expense.actionedBy = req.user._id;
      if (status === "Approved") {
        expense.approvedBy = req.user.name;
        expense.approvedOn = new Date();
        expense.rejectionReason = "";
      }
      if (status === "Rejected") {
        expense.rejectionReason = rejectionReason || "";
        expense.approvedBy = "";
        expense.approvedOn = null;
      }
      if (status === "Paid") {
        expense.fundPaidOn = expense.fundPaidOn || new Date();
        // A voucher flagged as coming out of the bank writes a matching
        // withdrawal into the ledger so the running balance stays true —
        // the ledger itself is still append-only, exactly as before.
        if (expense.fromBank) {
          const already = await BankTransaction.findOne({
            purpose: `Expense voucher ${expense.voucherNo}`,
          });
          if (!already && expense.receipt) {
            await BankTransaction.create({
              type: "Withdrawal",
              amount: expense.total,
              date: new Date(),
              purpose: `Expense voucher ${expense.voucherNo}`,
              slipUrl: expense.receipt,
              slipName: expense.receiptName || `${expense.voucherNo}.jpg`,
              recordedBy: req.user._id,
              academicYear: expense.academicYear,
            });
          }
        }
      }
      await expense.save();
      for (const p of populateFields) await expense.populate(p);
      res.json({ expense });
    } catch (err) {
      res.status(400).json({ message: err.message });
    }
  },
);

// DELETE /api/expenses/:id — General Admin only, and only for a voucher
// still sitting at Pending. Anything approved or paid is permanent record.
router.delete("/:id", protect, authorize("admin"), async (req, res) => {
  const expense = await Expense.findById(req.params.id);
  if (!expense) return res.status(404).json({ message: "Voucher not found" });
  if (expense.status !== "Pending") {
    return res.status(400).json({
      message: `A ${expense.status} voucher is part of the financial record and cannot be deleted.`,
    });
  }
  await expense.deleteOne();
  res.json({ message: "Voucher deleted" });
});

module.exports = router;
