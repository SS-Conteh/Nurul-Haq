const express = require("express");
const Behavior = require("../models/Behavior");
const { protect, authorize } = require("../middleware/auth");
const router = express.Router();

router.get("/", protect, async (req, res) => {
  const filter = {};
  if (req.query.studentId) filter.student = req.query.studentId;
  if (req.user.role === "student") filter.student = req.user._id;

  const records = await Behavior.find(filter).sort("-date");
  res.json({ records });
});

router.post(
  "/",
  protect,
  authorize("teacher", "principal"),
  async (req, res) => {
    const record = await Behavior.create({
      ...req.body,
      recordedBy: req.user._id,
    });
    res.status(201).json({ record });
  },
);

router.put(
  "/:id",
  protect,
  authorize("teacher", "principal"),
  async (req, res) => {
    const record = await Behavior.findByIdAndUpdate(req.params.id, req.body, {
      new: true,
    });
    if (!record)
      return res.status(404).json({ message: "Behavior record not found" });
    res.json({ record });
  },
);

module.exports = router;
