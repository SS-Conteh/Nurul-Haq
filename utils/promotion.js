const User = require("../models/User");
const Grade = require("../models/Grade");
const SchoolClass = require("../models/SchoolClass");
const Promotion = require("../models/Promotion");

// Given a student's current class, work out the SchoolClass they'd move
// into if promoted — or null if none exists / they're in a terminal year.
// Nursery/Primary/JSS: classGroup itself IS the year marker ("Nursery 1",
// "Class 3", "JSS 2"), so "next" is just the next entry in
// SchoolClass.CLASS_GROUPS[level]. SSS is different — classGroup there is
// the STREAM (Art/Science/Commercial), so the year has to be read out of
// the class NAME instead (e.g. "SSS 1 Art" -> next is "SSS 2 Art").
async function resolveNextClass(currentClass) {
  if (!currentClass) return { next: null, terminal: false };
  const { level, classGroup, name } = currentClass;

  if (level === "SSS") {
    const match = name.match(/SSS\s*(\d)/i);
    const year = match ? Number(match[1]) : null;
    if (!year) return { next: null, terminal: false };
    if (year >= 3) return { next: null, terminal: true };
    const nextName = name.replace(/SSS\s*\d/i, `SSS ${year + 1}`);
    let next = await SchoolClass.findOne({
      level: "SSS",
      classGroup,
      name: new RegExp(`^${nextName.trim()}$`, "i"),
    });
    if (!next) {
      // Fall back to any SSS class one year up in the same stream, in
      // case naming isn't an exact "SSS N Stream" pattern.
      next = await SchoolClass.findOne({
        level: "SSS",
        classGroup,
        name: new RegExp(`SSS\\s*${year + 1}\\b`, "i"),
      });
    }
    return { next, terminal: false };
  }

  const sequence = SchoolClass.CLASS_GROUPS[level] || [];
  const idx = sequence.indexOf(classGroup);
  if (idx === -1) return { next: null, terminal: false };
  if (idx === sequence.length - 1) return { next: null, terminal: true };
  const nextGroup = sequence[idx + 1];
  const next = await SchoolClass.findOne({ level, classGroup: nextGroup });
  return { next, terminal: false };
}

// A subject's yearly % for one student — the SAME formula the report card
// footer uses: (1st term MN + 2nd term MN + 3rd term MN) / 3. Only counted
// once a Term 3 grade actually exists for the subject; term 1 or term 1+2
// alone are never enough to produce a yearly figure for that subject.
function subjectYearlyMean(gradesBySubject) {
  const { t1, t2, t3 } = gradesBySubject;
  if (!t3) return null; // Term 3 not set for this subject yet — no yearly figure
  const mn = (g) => (g ? ((g.test || 0) + (g.examScore || 0)) / 2 : 0);
  return (mn(t1) + mn(t2) + mn(t3)) / 3;
}

// Runs ONLY when the General Admin explicitly triggers it (see
// routes/promotions.js POST /compute) — never automatically, and never on
// an academic-year change. `academicYear` is the year whose Term 3 grades
// are being evaluated — every currently-enrolled student's yearly % (the
// average of each subject's yearly mean, computed above) decides what
// happens to them:
//   >= 50%        -> Promoted automatically to the next class
//   45% - 49%      -> Pending — an Admin has to approve or reject it
//   <= 44%        -> Repeat — stays in the same class
// A student in a terminal/outgoing class (SSS 3, JSS 3, Class 6, Nursery's
// final year) is skipped entirely — they're graduating out, not being
// promoted. A student with no Term 3 grades at all for `academicYear` is
// skipped too — Term 3 hasn't actually been graded for them yet, so there
// is nothing to evaluate. Nothing is deleted or archived here beyond this
// one Promotion record per student; a student's own history (grades,
// attendance, fees) is completely untouched.
async function computePromotions(academicYear) {
  const students = await User.find({ role: "student" }).populate("classId");
  const results = { promoted: 0, pending: 0, repeat: 0, graduating: 0, skipped: 0 };

  // A grade's own `academicYear` field is only reliable for grades entered
  // AFTER Settings.academicYear existed — anything entered earlier can
  // carry a blank/stale value there, which would make an exact-match
  // filter silently miss real Term 3 data. The report card sidesteps this
  // entirely by matching on the `term` string instead (e.g.
  // "Term 3 · 2026"), so promotions match the exact same way here —
  // consistent with what's actually printed on the report card, and
  // immune to that field ever being wrong.
  const yearPart = academicYear.split("/")[1] || academicYear;
  const termStrings = [1, 2, 3].map((n) => `Term ${n} · ${yearPart}`);

  for (const student of students) {
    if (!student.classId) {
      results.skipped++;
      continue;
    }
    // Already decided for this year (e.g. re-running after a correction) —
    // don't recompute and potentially move a class twice.
    const already = await Promotion.findOne({ student: student._id, academicYear });
    if (already) {
      results.skipped++;
      continue;
    }

    const grades = await Grade.find({
      student: student._id,
      term: { $in: termStrings },
    });
    const bySubject = new Map();
    grades.forEach((g) => {
      const entry = bySubject.get(g.subject) || {};
      if (g.term === termStrings[0]) entry.t1 = g;
      else if (g.term === termStrings[1]) entry.t2 = g;
      else if (g.term === termStrings[2]) entry.t3 = g;
      bySubject.set(g.subject, entry);
    });

    const subjectMeans = [...bySubject.values()]
      .map(subjectYearlyMean)
      .filter((m) => m !== null);

    // No subject has a Term 3 grade yet — Term 3 hasn't been set/submitted
    // for this student, so there's nothing to evaluate yet.
    if (!subjectMeans.length) {
      results.skipped++;
      continue;
    }

    const yearlyMean = Math.round(
      subjectMeans.reduce((s, m) => s + m, 0) / subjectMeans.length,
    );

    const { next, terminal } = await resolveNextClass(student.classId);

    if (terminal) {
      await Promotion.create({
        student: student._id,
        academicYear,
        fromClass: student.classId._id,
        toClass: null,
        yearlyMean,
        status: "Graduating",
      });
      results.graduating++;
      continue;
    }

    if (yearlyMean >= 50) {
      await Promotion.create({
        student: student._id,
        academicYear,
        fromClass: student.classId._id,
        toClass: next ? next._id : null,
        yearlyMean,
        status: "Promoted",
        note: next ? "" : "No matching next-year class found — placed manually by an Admin",
      });
      // NOTE: the student's classId is deliberately NOT changed here — they
      // stay in their current class until the Admin actually sets a NEW
      // academic year (see applyPromotionsForYear below), which is when the
      // move is executed for every decided student at once.
      results.promoted++;
    } else if (yearlyMean >= 45) {
      await Promotion.create({
        student: student._id,
        academicYear,
        fromClass: student.classId._id,
        toClass: next ? next._id : null,
        yearlyMean,
        status: "Pending",
      });
      results.pending++;
    } else {
      await Promotion.create({
        student: student._id,
        academicYear,
        fromClass: student.classId._id,
        toClass: null,
        yearlyMean,
        status: "Repeat",
      });
      results.repeat++;
    }
  }

  return results;
}

// Runs exactly once per academic-year change, called from routes/settings.js
// the moment the General Admin sets a NEW academicYear (never on its own,
// never automatically otherwise). `oldYear` is the year that just ended.
// This is where every decided-but-not-yet-applied Promotion for that year
// is actually EXECUTED:
//   Promoted    -> student's classId is moved to toClass (their new class
//                  starts with zero records — every Grade permanently
//                  remembers the class it was recorded in, so nothing
//                  follows them across)
//   Repeat      -> classId is left as-is (already correct); just marked
//                  applied so the student's encouragement popup can fire
//   Graduating  -> classId is left as-is (an Admin handles their actual
//                  exit manually); just marked applied so their popup fires
//   Pending     -> left completely alone — an un-decided promotion is NEVER
//                  auto-resolved by a year change. Counted separately so
//                  the Admin can see how many still need a decision.
// Safe to call even if some/all records were already applied (e.g. this
// year change is being retried) — only ever touches appliedAt: null records.
async function applyPromotionsForYear(oldYear) {
  const results = { promoted: 0, repeat: 0, graduating: 0, stillPending: 0 };
  if (!oldYear) return results;

  const decided = await Promotion.find({
    academicYear: oldYear,
    appliedAt: null,
    status: { $in: ["Promoted", "Repeat", "Graduating"] },
  });

  for (const promo of decided) {
    if (promo.status === "Promoted" && promo.toClass) {
      await User.findByIdAndUpdate(promo.student, { classId: promo.toClass });
    }
    promo.appliedAt = new Date();
    await promo.save();
    if (promo.status === "Promoted") results.promoted++;
    else if (promo.status === "Repeat") results.repeat++;
    else results.graduating++;
  }

  results.stillPending = await Promotion.countDocuments({
    academicYear: oldYear,
    status: "Pending",
  });

  return results;
}

module.exports = { computePromotions, applyPromotionsForYear, resolveNextClass };
