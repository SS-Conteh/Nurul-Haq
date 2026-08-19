// Builds the `academicYear` piece of a Mongo filter for any year-scoped
// collection (Grade, Attendance, TeacherAttendance, Notice, Event).
//
// - A specific year requested (the nav dropdown, set to a past year) ->
//   match that year exactly.
// - No year requested (the default "current" view) -> match the current
//   academic year, but ALSO match records with no academicYear at all.
//   Every one of these models only gained an `academicYear` field when
//   this feature shipped, so anything created before that has "" stored —
//   without this fallback, all of a school's pre-existing history would
//   silently vanish from the default view the moment this shipped.
function yearFilter(currentAcademicYear, requestedYear) {
  if (requestedYear) return { academicYear: requestedYear };
  return { academicYear: { $in: [currentAcademicYear, "", null] } };
}

// The exact "Term X · YYYY" string a NEW term-scoped record should carry
// — e.g. Settings.currentTerm "Term 2" + Settings.academicYear
// "2025/2026" -> "Term 2 · 2026". Shared by every route that stamps a
// record with the current term at creation (Grade, Attendance,
// Assignment, Notice), so they can never drift out of sync with each
// other. Returns null if either piece hasn't been set yet in Settings.
function currentTermString(settings) {
  if (!settings?.currentTerm || !settings?.academicYear) return null;
  const yearPart =
    settings.academicYear.split("/")[1] || settings.academicYear;
  return `${settings.currentTerm} · ${yearPart}`;
}

module.exports = { yearFilter, currentTermString };
