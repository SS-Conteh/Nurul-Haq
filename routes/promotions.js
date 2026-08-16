const express = require("express");
const Promotion = require("../models/Promotion");
const User = require("../models/User");
const { protect, authorize } = require("../middleware/auth");
const { resolveNextClass } = require("../utils/promotion");
const router = express.Router();

const populate = [
  { path: "student", select: "name initials color avatarUrl admissionNo classId" },
  { path: "fromClass", select: "name level classGroup" },
  { path: "toClass", select: "name level classGroup" },
];

// GET /api/promotions?academicYear=&status= - the Promoted-to/Repeat/
// Pending list for a given year (defaults to the most recent one on
// file). General Admin sees everyone; Junior School Admin only ever sees
// Nursery–JSS; the Principal can view but never acts on one.
router.get(
  "/",
  protect,
  authorize("admin", "juniorAdmin", "principal"),
  async (req, res) => {
    const filter = {};
    if (req.query.ay) filter.academicYear = req.query.ay;
    if (req.query.status) filter.status = req.query.status;
    let promotions = await Promotion.find(filter)
      .populate(populate)
      .sort("-createdAt");
    if (req.user.role === "juniorAdmin") {
      promotions = promotions.filter((p) => p.fromClass?.level !== "SSS");
    }
    res.json({ promotions });
  },
);

// PUT /api/promotions/:id/approve - moves the student into the resolved
// next class (worked out fresh, in case a matching class has since been
// registered) and marks the record Promoted. General Admin / Junior
// School Admin (Nursery–JSS) only — never the Principal.
router.put(
  "/:id/approve",
  protect,
  authorize("admin", "juniorAdmin"),
  async (req, res) => {
    const promo = await Promotion.findById(req.params.id).populate("fromClass");
    if (!promo) return res.status(404).json({ message: "Promotion record not found" });
    if (promo.status !== "Pending") {
      return res.status(400).json({ message: "This promotion has already been decided" });
    }
    if (req.user.role === "juniorAdmin" && promo.fromClass?.level === "SSS") {
      return res.status(403).json({ message: "A Junior School Admin cannot decide an SSS promotion" });
    }
    const { next } = await resolveNextClass(promo.fromClass);
    promo.status = "Promoted";
    promo.toClass = next ? next._id : promo.toClass;
    promo.note = next ? "" : "No matching next-year class found — placed manually by an Admin";
    promo.decidedBy = req.user._id;
    promo.decidedAt = new Date();
    await promo.save();
    if (next) {
      await User.findByIdAndUpdate(promo.student, { classId: next._id });
    }
    await promo.populate(populate);
    res.json({ promotion: promo });
  },
);

// PUT /api/promotions/:id/reject - keeps the student in their current
// class and marks the record Repeat instead.
router.put(
  "/:id/reject",
  protect,
  authorize("admin", "juniorAdmin"),
  async (req, res) => {
    const promo = await Promotion.findById(req.params.id).populate("fromClass");
    if (!promo) return res.status(404).json({ message: "Promotion record not found" });
    if (promo.status !== "Pending") {
      return res.status(400).json({ message: "This promotion has already been decided" });
    }
    if (req.user.role === "juniorAdmin" && promo.fromClass?.level === "SSS") {
      return res.status(403).json({ message: "A Junior School Admin cannot decide an SSS promotion" });
    }
    promo.status = "Repeat";
    promo.toClass = null;
    promo.decidedBy = req.user._id;
    promo.decidedAt = new Date();
    await promo.save();
    await promo.populate(populate);
    res.json({ promotion: promo });
  },
);

// GET /api/promotions/mine - a student's own promotion record for a given
// year (used on the report card / My Grades page to show "Promoted to:
// SSS 2", "To Repeat", or "Pending Promotion").
router.get("/mine", protect, authorize("student"), async (req, res) => {
  const filter = { student: req.user._id };
  if (req.query.ay) filter.academicYear = req.query.ay;
  const promotions = await Promotion.find(filter).populate(populate).sort("-createdAt");
  res.json({ promotions });
});

module.exports = router;
