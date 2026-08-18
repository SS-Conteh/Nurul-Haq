const express = require("express");
const Promotion = require("../models/Promotion");
const User = require("../models/User");
const Settings = require("../models/Settings");
const { protect, authorize } = require("../middleware/auth");
const { resolveNextClass, computePromotions } = require("../utils/promotion");
const router = express.Router();

// POST /api/promotions/compute - General Admin only. Explicitly runs
// end-of-year auto-promotion for the CURRENT academic year, using each
// student's Term 3 grades. This is NOT tied to changing the academic year
// (see routes/settings.js) — it only requires that Settings.currentTerm is
// "Term 3", so the school can run it as soon as Term 3 grading is done,
// while still sitting in the same academic year. Safe to re-run: students
// already decided for this year are skipped (see utils/promotion.js).
router.post("/compute", protect, authorize("admin"), async (req, res) => {
  const settings = await Settings.findOne();
  if (!settings?.academicYear) {
    return res.status(400).json({ message: "Set the academic year in Settings first" });
  }
  if (settings.currentTerm !== "Term 3") {
    return res.status(400).json({
      message: "Promotions can only be computed once the current term is set to Term 3",
    });
  }
  const results = await computePromotions(settings.academicYear);
  res.json({ results, academicYear: settings.academicYear });
});

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

// PUT /api/promotions/:id/approve - resolves the next class (worked out
// fresh, in case a matching class has since been registered) and marks the
// record Promoted. Does NOT move the student yet — same deferred-apply
// rule as auto-computed promotions (see utils/promotion.js
// applyPromotionsForYear): the actual classId move only happens once the
// Admin sets a NEW academic year. General Admin / Junior School Admin
// (Nursery–JSS) only — never the Principal.
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

// GET /api/promotions/mine/pending-notification - the one outcome (if any)
// this student hasn't been shown their congratulations/encouragement popup
// for yet. Only ever returns a record once appliedAt is set — i.e. once
// the Admin has actually set the new academic year and the move (or
// same-class confirmation) has really happened, never while it's still
// just a decided-but-not-yet-applied "Promoted" sitting in the old year.
router.get("/mine/pending-notification", protect, authorize("student"), async (req, res) => {
  const promotion = await Promotion.findOne({
    student: req.user._id,
    appliedAt: { $ne: null },
    notified: false,
  })
    .populate(populate)
    .sort("-appliedAt");
  res.json({ promotion });
});

// PUT /api/promotions/mine/pending-notification/:id/dismiss - marks this
// student's own outcome as seen, so the popup never shows again for it.
router.put(
  "/mine/pending-notification/:id/dismiss",
  protect,
  authorize("student"),
  async (req, res) => {
    const promo = await Promotion.findOne({ _id: req.params.id, student: req.user._id });
    if (!promo) return res.status(404).json({ message: "Promotion record not found" });
    promo.notified = true;
    await promo.save();
    res.json({ promotion: promo });
  },
);

module.exports = router;
