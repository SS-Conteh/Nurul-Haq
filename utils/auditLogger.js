const AuditLog = require("../models/AuditLog");
const User = require("../models/User");
const SchoolClass = require("../models/SchoolClass");
const Grade = require("../models/Grade");
const Fee = require("../models/Fee");
const BankTransaction = require("../models/BankTransaction");
const Expense = require("../models/Expense");

function actorDefaultSection(user) {
  if (!user) return "General";
  if (user.role === "juniorAdmin" || user.role === "juniorBursar") return "Junior";
  if (user.role === "seniorBursar") return "Senior";
  if (user.role === "principal") {
    if (user.principalTitle === "Junior Principal") return "Junior";
    if (user.principalTitle === "Proprietor") return "General";
    return "Senior";
  }
  if (user.role === "teacher") {
    const levels = [...new Set([...(user.levelsTaught || []), user.level].filter(Boolean))];
    const junior = levels.some((v) => ["Nursery", "Primary", "JSS"].includes(v));
    const senior = levels.includes("SSS");
    return junior && senior ? "General" : senior ? "Senior" : junior ? "Junior" : "General";
  }
  return "General";
}

function levelSection(level) {
  if (["Nursery", "Primary", "JSS"].includes(String(level || ""))) return "Junior";
  if (String(level || "") === "SSS") return "Senior";
  return null;
}

async function resolveSection(user, req = {}) {
  const body = req.body || {};
  const query = req.query || {};
  const explicit = String(body.section || query.section || "").toLowerCase();
  if (explicit === "junior") return "Junior";
  if (explicit === "senior") return "Senior";

  const levels = [body.level, ...(Array.isArray(body.levelsTaught) ? body.levelsTaught : []), ...(Array.isArray(body.levels) ? body.levels : [])].filter(Boolean);
  if (levels.length) {
    const sections = [...new Set(levels.map(levelSection).filter(Boolean))];
    if (sections.length === 1) return sections[0];
    if (sections.length > 1) return "General";
  }

  const classId = body.classId || body.class || query.classId;
  if (classId) {
    const cls = await SchoolClass.findById(classId).select("level").lean().catch(() => null);
    const section = levelSection(cls?.level);
    if (section) return section;
  }

  const studentId = body.student || body.studentId || body.student_id || query.studentId;
  if (studentId) {
    const student = await User.findById(studentId).select("classId").populate("classId", "level").lean().catch(() => null);
    const section = levelSection(student?.classId?.level);
    if (section) return section;
  }

  const pathname = String(req.path || req.originalUrl || "").split("?")[0];
  const parts = pathname.split("/").filter(Boolean);
  const root = parts[1] || "";
  const id = req.params?.id || parts.find((part, index) => index > 1 && /^[a-f\d]{24}$/i.test(part)) || null;
  if (id) {
    let doc = null;
    if (root === "students" || root === "teachers" || root === "users" || root === "admins") {
      doc = await User.findById(id).select("classId level levelsTaught").populate("classId", "level").lean().catch(() => null);
      const section = levelSection(doc?.classId?.level || doc?.level);
      if (section) return section;
      const found = [...new Set((doc?.levelsTaught || []).map(levelSection).filter(Boolean))];
      if (found.length === 1) return found[0];
      if (found.length > 1) return "General";
    } else if (root === "grades") {
      doc = await Grade.findById(id).select("classId").populate("classId", "level").lean().catch(() => null);
      const section = levelSection(doc?.classId?.level);
      if (section) return section;
    } else if (root === "finance") {
      doc = await Fee.findById(id).select("student").populate({ path: "student", select: "classId", populate: { path: "classId", select: "level" } }).lean().catch(() => null);
      const section = levelSection(doc?.student?.classId?.level);
      if (section) return section;
      const tx = await BankTransaction.findById(id).select("section").lean().catch(() => null);
      if (tx?.section) return tx.section;
    } else if (root === "bank") {
      doc = await BankTransaction.findById(id).select("section").lean().catch(() => null);
      if (doc?.section) return doc.section;
    } else if (root === "expenses") {
      doc = await Expense.findById(id).select("section").lean().catch(() => null);
      if (doc?.section) return doc.section;
    } else if (root === "classes") {
      doc = await SchoolClass.findById(id).select("level").lean().catch(() => null);
      const section = levelSection(doc?.level);
      if (section) return section;
    }
  }

  if (user?.role === "student" && user.classId) {
    const student = await User.findById(user._id).select("classId").populate("classId", "level").lean().catch(() => null);
    const studentSection = levelSection(student?.classId?.level);
    if (studentSection) return studentSection;
  }

  // When a scoped administrator performs an action without a class/student
  // reference, the event still belongs to their own section, never General.
  return actorDefaultSection(user);
}

function describeActivity(req) {
  const method = String(req.method || "").toUpperCase();
  const route = String(req.originalUrl || req.path || "").split("?")[0];
  const body = req.body || {};
  const parts = route.split("/").filter(Boolean);
  const moduleKey = parts[1] || "system";
  const sub = parts[2] || "";
  const id = req.params?.id || parts.find((part, index) => index > 1 && /^[a-f\d]{24}$/i.test(part)) || "";
  const names = {
    students: "Students", teachers: "Teachers", admins: "Admin accounts", classes: "Classes",
    grades: "Grades", attendance: "Attendance", finance: "Finance & Fees", bank: "Bank Ledger",
    expenses: "Expenses", settings: "Settings", notices: "Notices", events: "Events",
    exams: "Exams", library: "Library", assignments: "Assignments", timetable: "Timetable",
    promotions: "Promotions", behavior: "Behavior", messages: "Messages", users: "User profile",
    notifications: "Notifications", ai: "AI Assistant", auth: "Account", reports: "Reports",
  };
  let module = names[moduleKey] || moduleKey.replace(/[-_]/g, " ").replace(/^\w/, c => c.toUpperCase());
  if (moduleKey === "finance" && sub === "transactions") module = "Bank Ledger";
  if (moduleKey === "finance" && !sub) module = "Fees";
  let action = method === "DELETE" ? "Deleted" : method === "PUT" || method === "PATCH" ? "Updated" : "Created";
  if (moduleKey === "grades" && method === "POST") action = "Submitted";
  if (moduleKey === "finance" && sub === "transactions") action = method === "DELETE" ? "Deleted" : method === "PUT" || method === "PATCH" ? "Edited" : "Recorded";
  if (moduleKey === "bank") action = method === "DELETE" ? "Deleted" : method === "PUT" || method === "PATCH" ? "Edited" : "Recorded";
  if (moduleKey === "finance" && !sub) action = method === "DELETE" ? "Deleted" : method === "PUT" || method === "PATCH" ? "Edited" : "Recorded";
  if (moduleKey === "auth" && route.includes("change-password")) return { action: "Changed password", module: "Account Security", description: `${req.user?.name || "A user"} changed their account password`, targetType: "User", targetId: String(req.user?._id || "") };

  let subject = "";
  if (moduleKey === "students" || moduleKey === "teachers" || moduleKey === "admins") subject = body.name ? `: ${String(body.name).slice(0, 100)}` : "";
  if (moduleKey === "grades") subject = ` for ${body.subject || "a subject"}${body.term ? ` (${body.term})` : ""}`;
  if (moduleKey === "finance" || moduleKey === "bank" || moduleKey === "expenses") {
    const amount = Number(body.amount || body.total || 0);
    if (amount) subject = ` · Le ${amount.toLocaleString("en-US")}`;
    if (body.type) subject = ` · ${body.type}${subject}`;
  }
  if (moduleKey === "attendance") subject = body.date ? ` · ${String(body.date).slice(0, 10)}` : "";
  if (moduleKey === "settings") subject = " · school configuration";
  const description = `${action} ${module}${subject}`;
  return { action, module, description, targetType: moduleKey, targetId: String(id || body._id || body.id || "") };
}

async function recordAudit({ user, action, module, description, section, targetType = "", targetId = "", method = "", route = "", ipAddress = "", userAgent = "" }) {
  try {
    await AuditLog.create({
      actor: user?._id || null,
      actorName: user?.name || "System",
      actorRole: user?.role || "system",
      actorTitle: user?.principalTitle || "",
      action, module, description,
      section: section || actorDefaultSection(user),
      targetType, targetId: String(targetId || ""), method, route,
      ipAddress, userAgent,
    });
  } catch (err) {
    console.error("[AUDIT] Could not write activity log:", err.message);
  }
}

function auditMiddleware(req, res, next) {
  const method = String(req.method || "").toUpperCase();
  if (!["POST", "PUT", "PATCH", "DELETE"].includes(method)) return next();
  const route = String(req.originalUrl || req.path || "").split("?")[0];
  if (route.startsWith("/api/audit-logs") || route.startsWith("/api/auth/login/")) return next();

  res.on("finish", async () => {
    if (res.statusCode < 200 || res.statusCode >= 300 || !req.user) return;
    const info = describeActivity(req);
    const section = await resolveSection(req.user, req).catch(() => actorDefaultSection(req.user));
    await recordAudit({
      user: req.user, ...info, section, method, route,
      ipAddress: req.ip || req.headers["x-forwarded-for"] || "",
      userAgent: req.headers["user-agent"] || "",
    });
  });
  next();
}

module.exports = { auditMiddleware, recordAudit, resolveSection, actorDefaultSection };
