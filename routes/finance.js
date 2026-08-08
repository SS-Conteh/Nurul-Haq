const express = require("express");
const Fee = require("../models/Fee");
const BankTransaction = require("../models/BankTransaction");
const User = require("../models/User");
const SchoolClass = require("../models/SchoolClass");
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
      .reduce((s, f) => s + f.amount, 0);
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

    const rows = students.map((s) => {
      const f = feeByStudent[String(s._id)];
      return {
        student: s,
        fee: f || null,
        status: f ? f.status : "Unpaid",
        amount: f ? f.amount : 0,
      };
    });

    res.json({
      class: {
        _id: cls._id,
        name: cls.name,
        level: cls.level,
        classGroup: cls.classGroup,
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
    const fee = await Fee.create({ ...req.body, recordedBy: req.user._id });
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
    const body = { ...req.body, recordedBy: req.user._id };
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
// but cannot create or edit an entry.
// ─────────────────────────────────────────────────────────────────────────

// GET /api/finance/transactions - Principal (view) + General Admin (view).
router.get("/transactions", protect, authorize("principal"), async (req, res) => {
  const transactions = await BankTransaction.find()
    .populate("recordedBy", "name role")
    .sort("-date");
  res.json({ transactions });
});

// GET /api/finance/transactions/summary
router.get(
  "/transactions/summary",
  protect,
  authorize("principal"),
  async (req, res) => {
    const transactions = await BankTransaction.find();
    const deposits = transactions
      .filter((t) => t.type === "Deposit")
      .reduce((s, t) => s + t.amount, 0);
    const withdrawals = transactions
      .filter((t) => t.type === "Withdrawal")
      .reduce((s, t) => s + t.amount, 0);
    res.json({
      deposits,
      withdrawals,
      balance: deposits - withdrawals,
      count: transactions.length,
    });
  },
);

// POST /api/finance/transactions - General Admin only.
router.post("/transactions", protect, authorize("admin"), async (req, res) => {
  try {
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

// PUT /api/finance/transactions/:id - General Admin only.
router.put("/transactions/:id", protect, authorize("admin"), async (req, res) => {
  try {
    const txn = await BankTransaction.findByIdAndUpdate(
      req.params.id,
      req.body,
      { new: true, runValidators: true },
    ).populate("recordedBy", "name role");
    if (!txn) return res.status(404).json({ message: "Transaction not found" });
    res.json({ transaction: txn });
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

// DELETE /api/finance/transactions/:id - General Admin only.
router.delete("/transactions/:id", protect, authorize("admin"), async (req, res) => {
  const txn = await BankTransaction.findByIdAndDelete(req.params.id);
  if (!txn) return res.status(404).json({ message: "Transaction not found" });
  res.json({ message: "Transaction removed" });
});

module.exports = router;
