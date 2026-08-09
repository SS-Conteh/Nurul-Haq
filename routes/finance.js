const express = require("express");
const Fee = require("../models/Fee");
const BankTransaction = require("../models/BankTransaction");
const User = require("../models/User");
const SchoolClass = require("../models/SchoolClass");
const Settings = require("../models/Settings");
const { protect, authorize } = require("../middleware/auth");
const router = express.Router();

// ─────────────────────────────────────────────────────────────────────────
// FEES
// Entering/editing a fee payment is General Admin work only — not even the
// Junior Admin, and never the Principal (who can view every payment but
// never records or changes one). `authorize("admin")` is used verbatim on
// every write route below instead of the usual `authorize("principal", …)`
// helper (which would silently let the Principal through too).
// ─────────────────────────────────────────────────────────────────────────

const feePopulate = {
  path: "student",
  select: "name initials color classId admissionNo",
  populate: { path: "classId", select: "name level classGroup" },
};

// Looks up the required fee for a student's level (Nursery/Primary/JSS/SSS)
// from Settings.feeAmounts, and derives Paid/Partial/Unpaid from the amount
// actually paid. Used by both POST and PUT below so a payment's status is
// always computed the same way, never trusted from the client.
async function computeFeeStatus(studentId, amount) {
  const student = await User.findById(studentId).populate({
    path: "classId",
    select: "level",
  });
  const level = student?.classId?.level;
  const settings = await Settings.findOne();
  const requiredFee = (level && settings?.feeAmounts?.[level]) || 0;
  let status = "Unpaid";
  if (amount > 0) {
    status = requiredFee > 0 ? (amount >= requiredFee ? "Paid" : "Partial") : "Paid";
  }
  return { status, expectedAmount: requiredFee };
}

// GET /api/finance - fee records. Principal/Admin/Junior Admin see the
// whole school (Junior Admin never sees SSS); a student only ever sees
// their own records; a Teacher sees the whole school too (view-only, same
// as before) since class teachers are often asked about a student's fee
// status.
router.get("/", protect, async (req, res) => {
  const filter = {};
  if (req.query.studentId) filter.student = req.query.studentId;
  if (req.query.term) filter.term = req.query.term;
  if (req.user.role === "student") filter.student = req.user._id;

  let fees = await Fee.find(filter).populate(feePopulate).sort("-paidOn");

  if (req.user.role === "juniorAdmin") {
    fees = fees.filter((f) => f.student?.classId?.level !== "SSS");
  }
  if (req.query.level) {
    fees = fees.filter((f) => f.student?.classId?.level === req.query.level);
  }
  if (req.query.classId) {
    fees = fees.filter(
      (f) => String(f.student?.classId?._id) === req.query.classId,
    );
  }
  res.json({ fees });
});

// GET /api/finance/summary - totals for the finance dashboard. The
// Principal, General Admin, and Junior Admin can all view this (Junior
// Admin's totals only ever cover Nursery-JSS).
router.get(
  "/summary",
  protect,
  authorize("principal", "juniorAdmin"),
  async (req, res) => {
    let fees = await Fee.find().populate({
      path: "student",
      select: "classId",
      populate: { path: "classId", select: "level" },
    });
    if (req.user.role === "juniorAdmin") {
      fees = fees.filter((f) => f.student?.classId?.level !== "SSS");
    }
    const totalCollected = fees
      .filter((f) => f.status === "Paid")
      .reduce((s, f) => s + f.amount, 0);
    const outstanding = fees
      .filter((f) => f.status !== "Paid")
      .reduce((s, f) => s + Math.max(0, (f.expectedAmount || 0) - f.amount), 0);
    res.json({
      totalCollected,
      outstanding,
      paidCount: fees.filter((f) => f.status === "Paid").length,
      totalCount: fees.length,
    });
  },
);

// GET /api/finance/by-class?classId=&term= - every student in a class
// alongside their fee status for a term (defaulting to "Unpaid"/0 for a
// student with no fee record at all yet). This is what the Fee Payment
// screen uses to build the "Fully Paid" / "Partial or Unpaid" tables for a
// level+class the Admin has picked. View-only for the Principal.
router.get(
  "/by-class",
  protect,
  authorize("principal", "juniorAdmin"),
  async (req, res) => {
    const { classId, term } = req.query;
    if (!classId) {
      return res.status(400).json({ message: "classId is required" });
    }
    const cls = await SchoolClass.findById(classId);
    if (!cls) return res.status(404).json({ message: "Class not found" });
    if (req.user.role === "juniorAdmin" && cls.level === "SSS") {
      return res.status(403).json({
        message: "A Junior School Admin cannot view SSS fee records",
      });
    }

    const students = await User.find({ role: "student", classId })
      .select("name initials color admissionNo")
      .sort("name");
    const studentIds = students.map((s) => s._id);

    const feeFilter = { student: { $in: studentIds } };
    if (term) feeFilter.term = term;
    const fees = await Fee.find(feeFilter).sort("-createdAt");

    // Most recent fee record per student for this term.
    const feeByStudent = {};
    fees.forEach((f) => {
      const key = String(f.student);
      if (!feeByStudent[key]) feeByStudent[key] = f;
    });

    const settings = await Settings.findOne();
    const requiredFee = (cls.level && settings?.feeAmounts?.[cls.level]) || 0;

    const rows = students.map((s) => {
      const f = feeByStudent[String(s._id)];
      const amount = f ? f.amount : 0;
      return {
        student: s,
        fee: f || null,
        status: f ? f.status : "Unpaid",
        amount,
        requiredFee,
        balance: Math.max(0, requiredFee - amount),
      };
    });

    res.json({
      class: {
        _id: cls._id,
        name: cls.name,
        level: cls.level,
        classGroup: cls.classGroup,
        requiredFee,
      },
      fullyPaid: rows.filter((r) => r.status === "Paid"),
      notFullyPaid: rows.filter((r) => r.status !== "Paid"),
    });
  },
);

// POST /api/finance - record a fee payment. General Admin only — neither
// the Junior Admin nor the Principal appears in this authorize() list.
router.post("/", protect, authorize("admin"), async (req, res) => {
  try {
    const amount = Number(req.body.amount) || 0;
    const { status, expectedAmount } = await computeFeeStatus(
      req.body.student,
      amount,
    );
    const fee = await Fee.create({
      ...req.body,
      amount,
      status,
      expectedAmount,
      recordedBy: req.user._id,
    });
    await fee.populate(feePopulate);
    res.status(201).json({ fee });
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

// PUT /api/finance/:id - update a fee payment. General Admin only — same
// restriction as POST above.
router.put("/:id", protect, authorize("admin"), async (req, res) => {
  try {
    const amount = Number(req.body.amount) || 0;
    const { status, expectedAmount } = await computeFeeStatus(
      req.body.student,
      amount,
    );
    const body = {
      ...req.body,
      amount,
      status,
      expectedAmount,
      recordedBy: req.user._id,
    };
    const fee = await Fee.findByIdAndUpdate(req.params.id, body, {
      new: true,
      runValidators: true,
    }).populate(feePopulate);
    if (!fee) return res.status(404).json({ message: "Fee record not found" });
    res.json({ fee });
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────
// BANK TRANSACTIONS (deposits/withdrawals)
// Entering a deposit/withdrawal is General Admin work only — not even the
// Junior Admin (this is the whole-school bank account, not a level-scoped
// one) and never the Principal, who can view the ledger for audit purposes
// but cannot create or edit an entry. There is deliberately no PUT/DELETE
// here: to prevent tampering with the financial record, a mistake is
// corrected with a new offsetting entry, never by editing or removing
// history from the ledger.
// ─────────────────────────────────────────────────────────────────────────

// GET /api/finance/transactions - Principal (view) + General Admin (view).
router.get("/transactions", protect, authorize("principal"), async (req, res) => {
  const transactions = await BankTransaction.find()
    .populate("recordedBy", "name role")
    .sort("-date");
  res.json({ transactions });
});

// GET /api/finance/transactions/summary - also reports the one-time
// opening balance (and who/when set it, once it has been) so the ledger's
// running balance always includes whatever was in the account before this
// system started tracking it.
router.get(
  "/transactions/summary",
  protect,
  authorize("principal"),
  async (req, res) => {
    const [transactions, settings] = await Promise.all([
      BankTransaction.find(),
      Settings.findOne(),
    ]);
    const openingBalance = settings?.bankOpeningBalance ?? null;
    const deposits = transactions
      .filter((t) => t.type === "Deposit")
      .reduce((s, t) => s + t.amount, 0);
    const withdrawals = transactions
      .filter((t) => t.type === "Withdrawal")
      .reduce((s, t) => s + t.amount, 0);
    res.json({
      deposits,
      withdrawals,
      balance: (openingBalance || 0) + deposits - withdrawals,
      count: transactions.length,
      openingBalance,
      openingBalanceSetAt: settings?.bankOpeningBalanceSetAt || null,
      openingBalanceSetBy: settings?.bankOpeningBalanceSetBy || "",
    });
  },
);

// POST /api/finance/transactions/opening-balance - records the account's
// starting balance exactly once. General Admin only. Rejected outright if
// it's already been set — since the system isn't connected to the bank,
// this figure has to come from a real statement and must stay a fixed,
// trustworthy starting point rather than something editable later.
router.post(
  "/transactions/opening-balance",
  protect,
  authorize("admin"),
  async (req, res) => {
    const amount = Number(req.body.amount);
    if (!Number.isFinite(amount) || amount < 0) {
      return res.status(400).json({ message: "A valid balance amount is required" });
    }
    let settings = await Settings.findOne();
    if (!settings) settings = new Settings();
    if (settings.bankOpeningBalanceSetAt) {
      return res.status(400).json({
        message: "The opening bank balance has already been recorded and cannot be changed.",
      });
    }
    settings.bankOpeningBalance = amount;
    settings.bankOpeningBalanceSetAt = new Date();
    settings.bankOpeningBalanceSetBy = req.user.name;
    await settings.save();
    res.status(201).json({
      openingBalance: settings.bankOpeningBalance,
      openingBalanceSetAt: settings.bankOpeningBalanceSetAt,
      openingBalanceSetBy: settings.bankOpeningBalanceSetBy,
    });
  },
);

// POST /api/finance/transactions - General Admin only. A slip/receipt
// upload is required on every entry (slipUrl) — enforced here as well as
// in the schema, so a request that omits it gets a clear message instead
// of a raw Mongoose validation error.
router.post("/transactions", protect, authorize("admin"), async (req, res) => {
  try {
    if (!req.body.slipUrl) {
      return res.status(400).json({
        message: "A photo/scan of the deposit or withdrawal slip is required",
      });
    }
    const txn = await BankTransaction.create({
      ...req.body,
      recordedBy: req.user._id,
    });
    await txn.populate("recordedBy", "name role");
    res.status(201).json({ transaction: txn });
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

module.exports = router;
