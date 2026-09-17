const express = require("express");
const Settings = require("../models/Settings");
const { protect, authorize } = require("../middleware/auth");
const { applyPromotionsForYear, computePromotions } = require("../utils/promotion");
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
// enter grades again (see routes/grades.js).
//
// UPDATE: a year change can no longer be relied on to have had the
// separate "Run Term 3 Promotions" button clicked first — if it wasn't,
// this route now runs computePromotions(previousYear) itself, right
// before applying, so a class actually empties out and refills on year
// change even if nobody remembered that separate step (computePromotions
// is safe to re-run: already-decided students are skipped, see
// utils/promotion.js). Auto-promotion (deciding WHO
// gets promoted) is NOT run here — that's a separate, explicit action (see
// routes/promotions.js POST /compute) tied to Term 3 grades being in, not
// to the calendar year changing. What DOES happen here, immediately and
// synchronously, is APPLYING every already-decided promotion from the year
// that just ended (see applyPromotionsForYear in utils/promotion.js): each
// Promoted student's classId is moved to their new class right now, a
// Repeat student's is confirmed unchanged, and both become eligible for
// their congratulations/encouragement popup on next login. Grades,
// attendance, and every other record are still never deleted or archived —
// they already carry the academic year they were created under, and a
// promoted student's grades additionally carry the CLASS they were
// recorded in (Grade.classId), so their new class starts genuinely empty
// while their old records stay exactly where they are, one dropdown away.
// Opening/bank balance, Teachers, Admins, Library, Settings itself, and
// Classes are completely unaffected by a year change — they were never
// year-scoped to begin with.
// Builds the exact term string a grade/exam under the given settings would
// carry — see the identical helper in routes/grades.js. Duplicated rather
// than imported to keep this route free of a grades.js dependency; the two
// are kept in lockstep by comment, not by import.
function termStringFor(settings) {
  if (!settings?.currentTerm || !settings?.academicYear) return null;
  const yearPart = settings.academicYear.split("/")[1] || settings.academicYear;
  return `${settings.currentTerm} · ${yearPart}`;
}

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

  // Whenever the resulting currentTerm+academicYear settle on a real term
  // string, record it in termHistory (a plain add-if-missing — never
  // removed, same append-only pattern as academicYearHistory above) so the
  // Term dropdown on Grades keeps offering every term the school has ever
  // graded under, including this one, forever.
  const newTermString = termStringFor(settings);
  if (newTermString && !(settings.termHistory || []).includes(newTermString)) {
    settings.termHistory = [...(settings.termHistory || []), newTermString];
  }

  await settings.save();

  // Immediately apply every decided-but-not-yet-applied promotion from the
  // year that just ended — see the big comment above PUT "/" for why this
  // lives here rather than at compute time.
  let promotionResults = null;
  if (isNewYear) {
    // Make sure every student with Term 3 grades on file for the year that
    // just ended actually has a decided Promotion record before we apply —
    // covers the case where "Run Term 3 Promotions" was never clicked
    // separately. No-op for students already decided (manually approved/
    // rejected or previously auto-computed).
    await computePromotions(previousYear);
    promotionResults = await applyPromotionsForYear(previousYear);
  }

  res.json({ settings, isNewYear: !!isNewYear, promotionResults });
});

// ─────────────────────────────────────────────────────────────────────────
// PER-CLASS FEE STRUCTURE
//
// Rather than putting the whole classFees array through the generic PUT
// above (where one stale browser tab could wipe out every other class's
// figure), each class's fee is saved on its own through these two routes:
// PUT upserts exactly one rule, DELETE removes exactly one. Everything
// else in classFees is left untouched, so two admins editing two different
// classes at the same time can't overwrite each other.
//
// A rule is identified by level + classGroup + className. className blank
// means "the whole class group" (every section in it); className set means
// that one registered class only. See utils/fees.js for how the two are
// resolved against each other at read time.
// ─────────────────────────────────────────────────────────────────────────

const LEVELS = ["Nursery", "Primary", "JSS", "SSS"];

function sameRule(r, level, classGroup, className) {
  const eq = (a, b) =>
    String(a || "").trim().toLowerCase() === String(b || "").trim().toLowerCase();
  return eq(r.level, level) && eq(r.classGroup, classGroup) && eq(r.className, className);
}

// PUT /api/settings/class-fee — set (or update) one class's annual fee.
// General Admin only, same as every other settings write.
router.put("/class-fee", protect, authorize("admin"), async (req, res) => {
  try {
    const level = String(req.body.level || "").trim();
    const classGroup = String(req.body.classGroup || "").trim();
    const className = String(req.body.className || "").trim();
    const amount = Number(req.body.amount);

    if (!LEVELS.includes(level)) {
      return res.status(400).json({ message: "Pick a valid level" });
    }
    if (!className) {
      return res.status(400).json({ message: "Pick a registered class to set the fee for" });
    }
    if (!Number.isFinite(amount) || amount < 0) {
      return res.status(400).json({ message: "Enter a valid fee amount" });
    }

    let settings = await Settings.findOne();
    if (!settings) settings = new Settings();

    const rules = [...(settings.classFees || [])];
    const idx = rules.findIndex((r) => sameRule(r, level, classGroup, className));
    const rule = {
      level,
      classGroup,
      className,
      amount,
      updatedBy: req.user.name,
      updatedAt: new Date(),
    };
    if (idx >= 0) rules[idx] = rule;
    else rules.push(rule);

    settings.classFees = rules;
    await settings.save();
    res.json({ classFees: settings.classFees });
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

// DELETE /api/settings/class-fee — clear one class's fee. Nothing else is touched.
router.delete("/class-fee", protect, authorize("admin"), async (req, res) => {
  const { level = "", classGroup = "", className = "" } = req.query;
  let settings = await Settings.findOne();
  if (!settings) return res.json({ classFees: [] });
  settings.classFees = (settings.classFees || []).filter(
    (r) => !sameRule(r, level, classGroup, className),
  );
  await settings.save();
  res.json({ classFees: settings.classFees });
});

module.exports = router;
