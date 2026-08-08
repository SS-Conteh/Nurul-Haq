const express = require("express");
const BankTransaction = require("../models/BankTransaction");
const { protect, authorize } = require("../middleware/auth");
const router = express.Router();

// Bank record-keeping (deposits/withdrawals) is the General Admin's job —
// it's not something the Principal enters, and it's kept separate from the
// Junior School Admin's day-to-day (fees) scope. The Principal can still
// view everything here, same as fees, for audit purposes.

// GET /api/bank - full ledger, newest first, with a running balance
router.get("/", protect, authorize("principal", "admin"), async (req, res) => {
  const txns = await BankTransaction.find().sort("date createdAt");
  let running = 0;
  const withBalance = txns.map((t) => {
    running += t.type === "Deposit" ? t.amount : -t.amount;
    const obj = t.toObject();
    obj.balanceAfter = running;
    return obj;
  });
  withBalance.reverse(); // newest first for display
  res.json({ transactions: withBalance, balance: running });
});

// GET /api/bank/summary - totals for the finance dashboard
router.get(
  "/summary",
  protect,
  authorize("principal", "admin"),
  async (req, res) => {
    const txns = await BankTransaction.find();
    const totalDeposits = txns
      .filter((t) => t.type === "Deposit")
      .reduce((s, t) => s + t.amount, 0);
    const totalWithdrawals = txns
      .filter((t) => t.type === "Withdrawal")
      .reduce((s, t) => s + t.amount, 0);
    res.json({
      balance: totalDeposits - totalWithdrawals,
      totalDeposits,
      totalWithdrawals,
      count: txns.length,
    });
  },
);

// POST /api/bank - record a deposit or withdrawal. General Admin only —
// this is deliberately not exposed to the Principal or the Junior School
// Admin. There is no PUT/DELETE: for audit integrity, a mistake is
// corrected with a new offsetting entry, never by editing/removing history.
router.post("/", protect, authorize("admin"), async (req, res) => {
  const { type, amount, date, description, reference } = req.body;
  if (!["Deposit", "Withdrawal"].includes(type)) {
    return res.status(400).json({ message: "type must be Deposit or Withdrawal" });
  }
  const numAmount = Number(amount);
  if (!numAmount || numAmount <= 0) {
    return res.status(400).json({ message: "A valid amount is required" });
  }
  const txn = await BankTransaction.create({
    type,
    amount: numAmount,
    date: date ? new Date(date) : new Date(),
    description: description || "",
    reference: reference || "",
    recordedBy: req.user._id,
    recordedByName: req.user.name,
  });
  res.status(201).json({ transaction: txn });
});

module.exports = router;
