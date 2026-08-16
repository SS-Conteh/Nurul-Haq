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

// Runs once, automatically, whenever the General Admin sets a NEW academic
// year in Settings (see routes/settings.js). `endingYear` is the year that
// just finished — every currently-enrolled student's grades from that year
// are averaged into a single "yearly mean %", and that decides what
// happens to them going into the new year:
//   >= 50%        -> Promoted automatically to the next class
//   45% - 49%      -> Pending — an Admin has to approve or reject it
//   <= 44%        -> Repeat — stays in the same class
// A student in a terminal/outgoing class (SSS 3, JSS 3, Class 6, Nursery
// 3) is skipped entirely — they're graduating out, not being promoted.
// A student with no grades at all for the ending year is skipped too
// (nothing to evaluate yet — most likely a brand new enrollment).
// Nothing is deleted or archived here beyond this one Promotion record per
// student; a student's own history (grades, attendance, fees) is
// completely untouched.
async function computePromotions(endingYear) {
  const students = await User.find({ role: "student" }).populate("classId");
  const results = { promoted: 0, pending: 0, repeat: 0, graduating: 0, skipped: 0 };

  for (const student of students) {
    if (!student.classId) {
      results.skipped++;
      continue;
    }
    // Already decided for this year (e.g. re-running after a crash) —
    // don't recompute and potentially move a class twice.
    const already = await Promotion.findOne({ student: student._id, academicYear: endingYear });
    if (already) {
      results.skipped++;
      continue;
    }

    const grades = await Grade.find({ student: student._id, academicYear: endingYear });
    if (!grades.length) {
      results.skipped++;
      continue;
    }

    const yearlyMean = Math.round(
      grades.reduce((s, g) => s + (g.total || 0), 0) / grades.length,
    );

    const { next, terminal } = await resolveNextClass(student.classId);

    if (terminal) {
      await Promotion.create({
        student: student._id,
        academicYear: endingYear,
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
        academicYear: endingYear,
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
        academicYear: endingYear,
        fromClass: student.classId._id,
        toClass: next ? next._id : null,
        yearlyMean,
        status: "Pending",
      });
      results.pending++;
    } else {
      await Promotion.create({
        student: student._id,
        academicYear: endingYear,
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
