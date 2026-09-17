// ─────────────────────────────────────────────────────────────────────────
// FEE RESOLUTION
//
// The annual fee a student owes is now configured PER CLASS, not just per
// level. Settings holds two things:
//
//   settings.feeAmounts  — the old per-level figures (Nursery/Primary/JSS/
//                          SSS). Kept as a fallback so nothing breaks for a
//                          class that hasn't been given its own figure yet.
//   settings.classFees   — an array of per-class rules:
//                            { level, classGroup, className, amount }
//                          A rule with a className is specific to that one
//                          registered class ("SSS 1 Art"); a rule with only
//                          a classGroup covers every section in that group
//                          ("Class 1" covers "Class 1A" and "Class 1B").
//
// Resolution order, most specific wins:
//   1. a rule matching the exact class NAME
//   2. a rule matching the class GROUP  (e.g. "Class 1", "Nursery 3")
//   3. settings.feeAmounts[level]       (the old level-wide figure)
//   4. 0 — nothing configured yet
//
// Everything that needs to know "what does this student owe for the year?"
// — fee entry, the by-class tables, the finance summary, the student's own
// My Fees screen — goes through resolveRequiredFee() so the answer is
// always the same one, computed in exactly one place.
// ─────────────────────────────────────────────────────────────────────────

function norm(s) {
  return String(s || "").trim().toLowerCase();
}

/**
 * @param {object} settings  the Settings document (or plain object)
 * @param {object} cls       { level, classGroup, name } — any of them may be
 *                           missing; the more that are present, the more
 *                           specific a rule can match.
 * @returns {number} the annual fee for the whole academic year, in Le.
 */
function resolveRequiredFee(settings, cls = {}) {
  const level = cls.level;
  const classGroup = cls.classGroup;
  const className = cls.name || cls.className;
  const rules = settings?.classFees || [];

  if (className) {
    const byName = rules.find(
      (r) => r.className && norm(r.className) === norm(className),
    );
    if (byName && Number(byName.amount) > 0) return Number(byName.amount);
  }

  if (classGroup) {
    const byGroup = rules.find(
      (r) =>
        !r.className &&
        norm(r.classGroup) === norm(classGroup) &&
        (!r.level || !level || norm(r.level) === norm(level)),
    );
    if (byGroup && Number(byGroup.amount) > 0) return Number(byGroup.amount);
  }

  const levelFee = level && settings?.feeAmounts?.[level];
  return Number(levelFee) || 0;
}

/**
 * Same thing, but starting from a populated User document whose classId has
 * been populated with at least { level, classGroup, name }. Returns 0 for a
 * student with no class.
 */
function resolveStudentFee(settings, student) {
  const cls = student?.classId;
  if (!cls) return 0;
  return resolveRequiredFee(settings, {
    level: cls.level,
    classGroup: cls.classGroup,
    name: cls.name,
  });
}

/**
 * A short human label for where a figure came from — shown in the UI so the
 * admin can tell a class-specific fee apart from an inherited level default.
 */
function feeSourceLabel(settings, cls = {}) {
  const rules = settings?.classFees || [];
  const className = cls.name || cls.className;
  if (
    className &&
    rules.some((r) => r.className && norm(r.className) === norm(className) && Number(r.amount) > 0)
  ) {
    return "Class-specific";
  }
  if (
    cls.classGroup &&
    rules.some(
      (r) => !r.className && norm(r.classGroup) === norm(cls.classGroup) && Number(r.amount) > 0,
    )
  ) {
    return "Class fee";
  }
  if (cls.level && Number(settings?.feeAmounts?.[cls.level]) > 0) {
    return "Level default";
  }
  return "Not set";
}

module.exports = { resolveRequiredFee, resolveStudentFee, feeSourceLabel };
