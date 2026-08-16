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

    const grades = await Grade.find({ student: student._id, academicYear });
    const bySubject = new Map();
    grades.forEach((g) => {
      const entry = bySubject.get(g.subject) || {};
      if (g.term.startsWith("Term 1")) entry.t1 = g;
      else if (g.term.startsWith("Term 2")) entry.t2 = g;
      else if (g.term.startsWith("Term 3")) entry.t3 = g;
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
      if (next) {
        await User.findByIdAndUpdate(student._id, { classId: next._id });
      }
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

module.exports = { computePromotions, resolveNextClass };
