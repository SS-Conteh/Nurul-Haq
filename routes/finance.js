const express = require("express");
const Fee = require("../models/Fee");
const BankTransaction = require("../models/BankTransaction");
const User = require("../models/User");
const SchoolClass = require("../models/SchoolClass");
const Settings = require("../models/Settings");
const { protect, authorize } = require("../middleware/auth");
const { yearFilter } = require("../utils/academicYear");
const router = express.Router();

// ─────────────────────────────────────────────────────────────────────────
// FEES
// Entering/editing a fee payment is General Admin work, the Junior School
// Admin's for Nursery–JSS, or a Bursar's for their own level (Senior
// Bursar: SSS, Junior Bursar: Nursery–JSS — enforced by
// levelScopeViolation() below on every write route). Never the Principal,
// who can view every payment but never records or changes one. A receipt
// upload is mandatory on every entry, for every one of these roles alike.
// ─────────────────────────────────────────────────────────────────────────

const feePopulate = {
  path: "student",
  select: "name initials color classId admissionNo",
  populate: { path: "classId", select: "name level classGroup" },
};

// Looks up the ANNUAL required fee for a student's level (Nursery/Primary/
// JSS/SSS) from Settings.feeAmounts, then derives Paid/Partial/Unpaid from
// the student's cumulative payments for the current academic year — this
// installment plus every other one already on file (excluding, on an edit,
// the record being edited itself, so it isn't counted twice). Used by both
// POST and PUT below so a payment's status is always computed the same
// way, never trusted from the client.
async function computeFeeStatus(studentId, amount, excludeFeeId = null) {
  const student = await User.findById(studentId).populate({
    path: "classId",
    select: "level",
  });
  const level = student?.classId?.level;
  const settings = await Settings.findOne();
  const requiredFee = (level && settings?.feeAmounts?.[level]) || 0;
  const academicYear = settings?.academicYear || "";

  const otherFilter = { student: studentId, academicYear };
  if (excludeFeeId) otherFilter._id = { $ne: excludeFeeId };
  const otherFees = await Fee.find(otherFilter).select("amount");
  const paidSoFar =
    otherFees.reduce((s, f) => s + (f.amount || 0), 0) + amount;

  let status = "Unpaid";
  if (paidSoFar > 0) {
    status = requiredFee > 0 ? (paidSoFar >= requiredFee ? "Paid" : "Partial") : "Paid";
  }
  return { status, expectedAmount: requiredFee, academicYear };
}

// GET /api/finance - fee records. Principal/Admin/Junior Admin see the
// whole school (Junior Admin never sees SSS); a student only ever sees
// their own records; a Teacher sees the whole school too (view-only, same
// as before) since class teachers are often asked about a student's fee
// status.
router.get("/", protect, async (req, res) => {
  const settings = await Settings.findOne();
  const filter = { ...yearFilter(settings?.academicYear, req.query.ay) };
  if (req.query.studentId) filter.student = req.query.studentId;
  if (req.query.term) filter.term = req.query.term;
  if (req.user.role === "student") filter.student = req.user._id;

  let fees = await Fee.find(filter).populate(feePopulate).sort("-paidOn");

  if (req.user.role === "juniorAdmin" || req.user.role === "juniorBursar") {
    fees = fees.filter((f) => f.student?.classId?.level !== "SSS");
  }
  // The Senior Bursar handles SSS fees only.
  if (req.user.role === "seniorBursar") {
    fees = fees.filter((f) => f.student?.classId?.level === "SSS");
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
// Principal, General Admin, Junior Admin, and both Bursars can all view
// this. The Junior Admin deliberately sees the FULL school's totals here
// (including SSS) for transparency, even though they can only ever record
// or drill into Nursery–JSS fees elsewhere — a Bursar's totals, by
// contrast, only ever cover their own level. Fees are annual now, so this
// groups every payment by student first (a student may have several
// installment records) and works out each student's year-to-date total
// before summing up — a per-record sum would double-count a student who
// paid in more than one installment.
router.get(
  "/summary",
  protect,
  authorize("principal", "juniorAdmin", "seniorBursar", "juniorBursar"),
  async (req, res) => {
    const settings = await Settings.findOne();
    const academicYear = req.query.ay || settings?.academicYear || "";
    let fees = await Fee.find({ academicYear }).populate({
      path: "student",
      select: "classId",
      populate: { path: "classId", select: "level" },
    });
    // Only a Bursar's totals are scoped to their own level — the Junior
    // Admin sees the whole school here for transparency (see comment
    // above).
    if (req.user.role === "juniorBursar") {
      fees = fees.filter((f) => f.student?.classId?.level !== "SSS");
    }
    if (req.user.role === "seniorBursar") {
      fees = fees.filter((f) => f.student?.classId?.level === "SSS");
    }

    const byStudent = {};
    fees.forEach((f) => {
      const sid = String(f.student?._id || f.student);
      if (!byStudent[sid]) {
        byStudent[sid] = { level: f.student?.classId?.level, total: 0 };
      }
      byStudent[sid].total += f.amount || 0;
    });

    let totalCollected = 0;
    let outstanding = 0;
    let paidCount = 0;
    let seniorCollected = 0;
    let juniorCollected = 0;
    const totalCount = Object.keys(byStudent).length;
    Object.values(byStudent).forEach(({ level, total }) => {
      const requiredFee = (level && settings?.feeAmounts?.[level]) || 0;
      totalCollected += total;
      if (level === "SSS") seniorCollected += total;
      else if (level) juniorCollected += total;
      outstanding += Math.max(0, requiredFee - total);
      const isPaid = requiredFee > 0 ? total >= requiredFee : total > 0;
      if (isPaid) paidCount += 1;
    });

    res.json({
      totalCollected,
      outstanding,
      paidCount,
      totalCount,
      seniorCollected,
      juniorCollected,
    });
  },
);

// GET /api/finance/by-class?classId= - every student in a class alongside
// their YEAR-TO-DATE fee position (defaulting to "Unpaid"/0 for a student
// with no fee record at all yet). `amount` is the sum of every installment
// a student has paid this academic year — however many payments that took,
// and whichever terms they were tagged against — compared to the level's
// annual fee. `payments` carries the full installment history for that
// student so the Admin can see how the total was built up. This is what
// the Fee Payment screen uses to build the "Fully Paid" / "Partial or
// Unpaid" tables for a level+class the Admin has picked. View-only for the
// Principal.
router.get(
  "/by-class",
  protect,
  authorize("principal", "juniorAdmin", "seniorBursar", "juniorBursar"),
  async (req, res) => {
    const { classId } = req.query;
    if (!classId) {
      return res.status(400).json({ message: "classId is required" });
    }
    const cls = await SchoolClass.findById(classId);
    if (!cls) return res.status(404).json({ message: "Class not found" });
    if ((req.user.role === "juniorAdmin" || req.user.role === "juniorBursar") && cls.level === "SSS") {
      return res.status(403).json({
        message: "A Junior School Admin/Bursar cannot view SSS fee records",
      });
    }
    if (req.user.role === "seniorBursar" && cls.level !== "SSS") {
      return res.status(403).json({
        message: "The Senior Bursar only handles SSS fee records",
      });
    }

    const students = await User.find({ role: "student", classId })
      .select("name initials color admissionNo")
      .sort("name");
    const studentIds = students.map((s) => s._id);

    const settings = await Settings.findOne();
    const academicYear = req.query.ay || settings?.academicYear || "";
    const requiredFee = (cls.level && settings?.feeAmounts?.[cls.level]) || 0;

    const fees = await Fee.find({
      student: { $in: studentIds },
      academicYear,
    }).sort("-paidOn");

    // Every installment payment a student has made this academic year,
    // most recent first.
    const paymentsByStudent = {};
    fees.forEach((f) => {
      const key = String(f.student);
      (paymentsByStudent[key] ||= []).push(f);
    });

    const rows = students.map((s) => {
      const payments = paymentsByStudent[String(s._id)] || [];
      const amount = payments.reduce((sum, f) => sum + (f.amount || 0), 0);
      const latest = payments[0] || null;
      const status =
        amount <= 0 ? "Unpaid" : requiredFee > 0 ? (amount >= requiredFee ? "Paid" : "Partial") : "Paid";
      return {
        student: s,
        fee: latest, // most recent installment — kept for date/receipt display
        payments, // full installment history for this student, this year
        status,
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

// A bursar, or the Junior School Admin, may only record a fee for a
// student in their own scope — Senior Bursar: SSS, Junior Bursar/Junior
// School Admin: Nursery/Primary/JSS. General Admin has no restriction.
// Returns an error message string if out of scope, otherwise null.
async function levelScopeViolation(role, studentId) {
  if (role !== "seniorBursar" && role !== "juniorBursar" && role !== "juniorAdmin") return null;
  const student = await User.findById(studentId).populate({ path: "classId", select: "level" });
  const level = student?.classId?.level;
  const inScope = role === "seniorBursar" ? level === "SSS" : level && level !== "SSS";
  return inScope ? null : "This student is outside your level";
}

// POST /api/finance - record an installment fee payment. General Admin,
// the Junior School Admin (Nursery–JSS only), or a Bursar for their own
// level (Senior Bursar: SSS, Junior Bursar: Nursery–JSS). Never the
// Principal. A receipt upload is mandatory on every entry — enforced here
// as well as in the schema — for every one of these roles alike.
router.post(
  "/",
  protect,
  authorize("admin", "juniorAdmin", "seniorBursar", "juniorBursar"),
  async (req, res) => {
    try {
      const violation = await levelScopeViolation(req.user.role, req.body.student);
      if (violation) return res.status(403).json({ message: violation });
      if (!req.body.receipt) {
        return res.status(400).json({
          message: "A receipt upload is required to record this payment",
        });
      }
      const amount = Number(req.body.amount) || 0;
      const { status, expectedAmount, academicYear } = await computeFeeStatus(
        req.body.student,
        amount,
      );
      const fee = await Fee.create({
        ...req.body,
        amount,
        status,
        expectedAmount,
        academicYear,
        recordedBy: req.user._id,
      });
      await fee.populate(feePopulate);
      res.status(201).json({ fee });
    } catch (err) {
      res.status(400).json({ message: err.message });
    }
  },
);

// PUT /api/finance/:id - update an installment fee payment. Same roles and
// scope as POST above. The record being edited is excluded from its own
// cumulative total so editing an amount doesn't count it twice.
router.put(
  "/:id",
  protect,
  authorize("admin", "juniorAdmin", "seniorBursar", "juniorBursar"),
  async (req, res) => {
    try {
      const violation = await levelScopeViolation(req.user.role, req.body.student);
      if (violation) return res.status(403).json({ message: violation });
      if (!req.body.receipt) {
        return res.status(400).json({
          message: "A receipt upload is required to record this payment",
        });
      }
      const amount = Number(req.body.amount) || 0;
      const { status, expectedAmount, academicYear } = await computeFeeStatus(
        req.body.student,
        amount,
        req.params.id,
      );
      const body = {
        ...req.body,
        amount,
        status,
        expectedAmount,
        academicYear,
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
  },
);

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

// GET /api/finance/transactions - Principal (view), General Admin, Junior
// School Admin (view), and both Bursars (the bank ledger isn't
// level-split, so either bursar can see and record the whole school's
// deposits/withdrawals).
// The ledger itself is NEVER year-scoped — every transaction ever
// recorded, from every academic year, stays visible and in the database
// permanently (real money moved; nothing about it is ever reset or
// deleted). Only the SUMMARY totals below reset per academic year.
router.get(
  "/transactions",
  protect,
  authorize("principal", "juniorAdmin", "seniorBursar", "juniorBursar"),
  async (req, res) => {
  const transactions = await BankTransaction.find()
    .populate("recordedBy", "name role")
    .sort("-date");
  res.json({ transactions });
});

// GET /api/finance/transactions/summary - also reports the one-time
// opening balance (and who/when set it, once it has been) so the ledger's
// running balance always includes whatever was in the account before this
// system started tracking it.
//
// `deposits` / `withdrawals` are scoped to the CURRENT academic year (or
// the one requested via ?ay=) — these are what "reset" the moment a new
// academic year is set, per the General Admin's requirement: nothing in
// the bank ledger is ever deleted, but the "Total Deposits" / "Total
// Withdrawals" cards on the finance dashboard should start again from
// zero for the new year. `balance`, by contrast, is real money and is
// deliberately computed from the OPENING balance + every transaction ever
// recorded (all academic years) — a bank balance can never "reset" itself,
// only the on-screen yearly totals do.
router.get(
  "/transactions/summary",
  protect,
  authorize("principal", "juniorAdmin", "seniorBursar", "juniorBursar"),
  async (req, res) => {
    const settings = await Settings.findOne();
    const [allTransactions, yearTransactions] = await Promise.all([
      BankTransaction.find(),
      BankTransaction.find(yearFilter(settings?.academicYear, req.query.ay)),
    ]);
    const openingBalance = settings?.bankOpeningBalance ?? null;
    const sumByType = (list, type) =>
      list.filter((t) => t.type === type).reduce((s, t) => s + t.amount, 0);
    const allDeposits = sumByType(allTransactions, "Deposit");
    const allWithdrawals = sumByType(allTransactions, "Withdrawal");
    res.json({
      deposits: sumByType(yearTransactions, "Deposit"),
      withdrawals: sumByType(yearTransactions, "Withdrawal"),
      count: yearTransactions.length,
      // Real, all-time running balance — never scoped to a single year.
      balance: (openingBalance || 0) + allDeposits - allWithdrawals,
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

// POST /api/finance/transactions - General Admin or either Bursar. A
// slip/receipt upload is required on every entry (slipUrl) — enforced here
// as well as in the schema, so a request that omits it gets a clear
// message instead of a raw Mongoose validation error.
router.post(
  "/transactions",
  protect,
  authorize("admin", "seniorBursar", "juniorBursar"),
  async (req, res) => {
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
