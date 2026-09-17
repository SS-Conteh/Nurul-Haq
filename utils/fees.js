function norm(s) { return String(s || "").trim().toLowerCase(); }

function resolveRequiredFee(settings, cls = {}) {
  const className = cls.name || cls.className;
  if (!className) return 0;
  const rule = (settings?.classFees || []).find(
    (r) => r.className && norm(r.className) === norm(className),
  );
  return rule && Number(rule.amount) > 0 ? Number(rule.amount) : 0;
}

function resolveStudentFee(settings, student) {
  const cls = student?.classId;
  return cls ? resolveRequiredFee(settings, { name: cls.name }) : 0;
}

function feeSourceLabel(settings, cls = {}) {
  const className = cls.name || cls.className;
  if (!className) return "Not set";
  const rule = (settings?.classFees || []).find(
    (r) => r.className && norm(r.className) === norm(className) && Number(r.amount) > 0,
  );
  return rule ? "Class-specific" : "Not set";
}

module.exports = { resolveRequiredFee, resolveStudentFee, feeSourceLabel };
