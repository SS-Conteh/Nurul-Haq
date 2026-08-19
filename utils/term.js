// Builds the exact "Term X · YYYY" string a record should be tagged with,
// straight off whatever's currently set in Settings — same format/logic as
// expectedCurrentTermString() in routes/grades.js. Returns "" if either
// currentTerm or academicYear hasn't been set yet, which every caller
// treats as "don't tag this record with a term" (mirrors how legacy /
// pre-feature records also show "" here, and simply fall outside a
// specific-term filter while still showing up under "All Terms").
function currentTermString(settings) {
  if (!settings?.currentTerm || !settings?.academicYear) return "";
  const yearPart = settings.academicYear.split("/")[1] || settings.academicYear;
  return `${settings.currentTerm} · ${yearPart}`;
}

module.exports = { currentTermString };
