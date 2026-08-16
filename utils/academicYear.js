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

module.exports = { yearFilter };
