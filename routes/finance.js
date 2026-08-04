const express = require("express");
const Fee = require("../models/Fee");
const { protect, authorize } = require("../middleware/auth");
const router = express.Router();

// GET /api/finance - all fee records (principal), or own (student/parent)
router.get("/", protect, async (req, res) => {
  const filter = {};
  if (req.query.studentId) filter.student = req.query.studentId;
  if (req.user.role === "student") filter.student = req.user._id;
  if (req.user.role === "parent") filter.student = { $in: req.user.children };

  const fees = await Fee.find(filter)
    .populate({
      path: "student",
      select: "name initials color classId",
      populate: { path: "classId", select: "name" },
    })
    .sort("-paidOn");
  res.json({ fees });
});

// GET /api/finance/summary - totals for the finance dashboard
router.get("/summary", protect, authorize("principal"), async (req, res) => {
  const fees = await Fee.find();
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
});

router.post("/", protect, authorize("principal"), async (req, res) => {
  const fee = await Fee.create(req.body);
  res.status(201).json({ fee });
});

router.put("/:id", protect, authorize("principal"), async (req, res) => {
  const fee = await Fee.findByIdAndUpdate(req.params.id, req.body, {
    new: true,
  });
  if (!fee) return res.status(404).json({ message: "Fee record not found" });
  res.json({ fee });
});

module.exports = router;
