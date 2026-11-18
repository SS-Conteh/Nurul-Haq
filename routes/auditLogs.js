const express = require("express");
const AuditLog = require("../models/AuditLog");
const { protect } = require("../middleware/auth");
const router = express.Router();

function auditAccess(user) {
  if (!user) return "none";
  if (user.role === "admin") return "all";
  if (user.role === "juniorAdmin") return "junior";
  if (user.role !== "principal") return "none";
  if (["Proprietor", "Senior Principal"].includes(user.principalTitle)) return "all";
  if (user.principalTitle === "Junior Principal") return "junior";
  return "none";
}

router.get("/", protect, async (req, res) => {
  const access = auditAccess(req.user);
  if (access === "none") return res.status(403).json({ message: "You do not have permission to view audit logs" });

  const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
  const limit = Math.min(100, Math.max(10, Number.parseInt(req.query.limit, 10) || 50));
  const filter = {};
  if (access === "junior") filter.section = "Junior";
  else if (["Junior", "Senior", "General"].includes(req.query.section)) filter.section = req.query.section;

  if (req.query.action) filter.action = String(req.query.action).slice(0, 80);
  if (req.query.module) filter.module = String(req.query.module).slice(0, 80);
  if (req.query.from || req.query.to) {
    filter.createdAt = {};
    if (req.query.from) filter.createdAt.$gte = new Date(req.query.from);
    if (req.query.to) {
      const to = new Date(req.query.to);
      to.setHours(23, 59, 59, 999);
      filter.createdAt.$lte = to;
    }
  }
  if (req.query.search) {
    const safe = String(req.query.search).slice(0, 100).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    filter.$or = [
      { actorName: new RegExp(safe, "i") },
      { description: new RegExp(safe, "i") },
      { module: new RegExp(safe, "i") },
      { action: new RegExp(safe, "i") },
    ];
  }

  const [logs, total, moduleNames] = await Promise.all([
    AuditLog.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
    AuditLog.countDocuments(filter),
    AuditLog.distinct("module", access === "junior" ? { section: "Junior" } : {}),
  ]);
  res.json({ logs, total, page, limit, pages: Math.max(1, Math.ceil(total / limit)), access, modules: moduleNames.sort() });
});

module.exports = router;
