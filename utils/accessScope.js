const SchoolClass = require("../models/SchoolClass");

// Section policy:
//   all    = Senior Admin (role=admin) and Proprietor
//   junior = Junior Admin, Junior Principal, Junior Bursar
//   senior = Senior Principal, Vice Principal, Senior Bursar
// A principal account without a title is treated as senior for safety.
function sectionScope(user) {
  if (!user) return "none";
  if (user.role === "admin") return "all";
  if (user.role === "juniorAdmin" || user.role === "juniorBursar") return "junior";
  if (user.role === "seniorBursar") return "senior";
  if (user.role === "principal") {
    if (user.principalTitle === "Proprietor") return "all";
    if (user.principalTitle === "Junior Principal") return "junior";
    return "senior"; // Senior Principal, Vice Principal, legacy/untitled Principal
  }
  return "none";
}

function levelsForScope(scope) {
  if (scope === "junior") return ["Nursery", "Primary", "JSS"];
  if (scope === "senior") return ["SSS"];
  return null;
}

function levelAllowed(user, level) {
  const scope = sectionScope(user);
  if (scope === "all") return true;
  return !!levelsForScope(scope)?.includes(level);
}

async function scopedClassIds(user) {
  const scope = sectionScope(user);
  if (scope === "all") return null;
  const levels = levelsForScope(scope);
  if (!levels) return [];
  return SchoolClass.find({ level: { $in: levels } }).distinct("_id");
}

async function addClassScope(filter, user, field = "classId") {
  const ids = await scopedClassIds(user);
  if (ids === null) return filter;
  const existing = filter[field];
  if (!existing) {
    filter[field] = { $in: ids };
  } else if (existing.$in) {
    const allowed = new Set(ids.map(String));
    filter[field].$in = existing.$in.filter((id) => allowed.has(String(id)));
  } else if (existing.$eq || typeof existing !== "object") {
    const id = existing.$eq ?? existing;
    filter[field] = ids.some((x) => String(x) === String(id)) ? existing : { $in: [] };
  }
  return filter;
}

async function studentInScope(user, studentId) {
  const scope = sectionScope(user);
  if (scope === "all") return true;
  if (!studentId) return false;
  const User = require("../models/User");
  const student = await User.findOne({ _id: studentId, role: "student" })
    .populate("classId", "level")
    .select("classId");
  return !!student?.classId && levelAllowed(user, student.classId.level);
}

module.exports = {
  sectionScope,
  levelsForScope,
  levelAllowed,
  scopedClassIds,
  addClassScope,
  studentInScope,
};
