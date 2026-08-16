const express = require("express");
const Exam = require("../models/Exam");
const Settings = require("../models/Settings");
const { protect, authorize } = require("../middleware/auth");
const { yearFilter } = require("../utils/academicYear");
const router = express.Router();

router.get("/", protect, async (req, res) => {
  const settings = await Settings.findOne();
  const filter = { ...yearFilter(settings?.academicYear, req.query.ay) };
  if (req.query.term) filter.term = req.query.term;
  const exams = await Exam.find(filter).sort("date");
  res.json({ exams });
});

router.post("/", protect, authorize("admin", "juniorAdmin"), async (req, res) => {
  const settings = await Settings.findOne();
  const exam = await Exam.create({
    ...req.body,
    academicYear: settings?.academicYear || "",
  });
  res.status(201).json({ exam });
});

router.put("/:id", protect, authorize("admin", "juniorAdmin"), async (req, res) => {
  const exam = await Exam.findByIdAndUpdate(req.params.id, req.body, {
    new: true,
  });
  if (!exam) return res.status(404).json({ message: "Exam not found" });
  res.json({ exam });
});

router.delete("/:id", protect, authorize("admin", "juniorAdmin"), async (req, res) => {
  const exam = await Exam.findByIdAndDelete(req.params.id);
  if (!exam) return res.status(404).json({ message: "Exam not found" });
  res.json({ message: "Exam removed" });
});

module.exports = router;
