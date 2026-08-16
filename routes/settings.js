const express = require("express");
const Settings = require("../models/Settings");
const { protect, authorize } = require("../middleware/auth");
const router = express.Router();

// GET /api/settings/public - no login required. Powers the public landing
// page (school history, name, motto, logo) — nothing sensitive here, so it
// deliberately skips `protect`. IMPORTANT: this must be declared before the
// authenticated GET "/" below, or Express would try to match "public" as a
// param on that route instead.
router.get("/public", async (req, res) => {
  let settings = await Settings.findOne();
  if (!settings) settings = await Settings.create({});
  const { schoolName, motto, logoUrl, address, phone, schoolHistory, houseColors } = settings;
  res.json({ settings: { schoolName, motto, logoUrl, address, phone, schoolHistory, houseColors } });
});

router.get("/", protect, async (req, res) => {
  let settings = await Settings.findOne();
  if (!settings) settings = await Settings.create({});
  res.json({ settings });
});

// PUT /api/settings - General Admin only. Not even the Junior School Admin,
// the Principal, or a Bursar can change system settings — a Bursar may only
// ever read the fee amounts/academic year (via GET "/" above), never write.
//
// Setting a NEW academicYear (one that isn't the current value) is treated
// specially: nothing in the database is deleted or archived — every
// grade/attendance/notice/event/fee record already carries the academic
// year it was created under (see each model's `academicYear` field), so a
// past year's records simply stay exactly where they are and become
// visible again the moment that year is picked from the academic-year
// dropdown.
//
// A genuine year change IS a fresh start for the current-term concept
// specifically: currentTerm is forced back to "" (unset) no matter what the
// request body says, so the school can never accidentally roll into a new
// academic year still "on" the old year's Term 3. The General Admin has to
// come back and explicitly pick Term 1 for the new year before anyone can
// enter grades again (see routes/grades.js). Auto-promotion is NOT run
// here — that's a separate, explicit action (see routes/promotions.js
// POST /compute) tied to Term 3 grades being in, not to the calendar year
// changing. Opening/bank balance, Teachers, Admins, Library, Settings
// itself, and Classes are completely unaffected by a year change — they
// were never year-scoped to begin with.
router.put("/", protect, authorize("admin"), async (req, res) => {
  let settings = await Settings.findOne();
  if (!settings) settings = new Settings();
  const previousYear = settings.academicYear;

  Object.assign(settings, req.body);
  if (req.body.preferences)
    settings.preferences = {
      ...settings.preferences.toObject(),
      ...req.body.preferences,
    };

  const isNewYear =
    req.body.academicYear &&
    req.body.academicYear !== previousYear &&
    previousYear;
  if (isNewYear) {
    const history = new Set(settings.academicYearHistory || []);
    history.add(previousYear);
    history.add(settings.academicYear);
    settings.academicYearHistory = [...history];
    // Fresh start — force the term back to unset, even if the request body
    // tried to carry the old term over.
    settings.currentTerm = "";
  }

  await settings.save();

  res.json({ settings, isNewYear: !!isNewYear });
});

module.exports = router;
