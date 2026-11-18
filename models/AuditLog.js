const mongoose = require("mongoose");

const AuditLogSchema = new mongoose.Schema({
  actor: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null, index: true },
  actorName: { type: String, default: "System", trim: true },
  actorRole: { type: String, default: "system", index: true },
  actorTitle: { type: String, default: "" },
  action: { type: String, required: true, index: true },
  module: { type: String, required: true, index: true },
  description: { type: String, required: true },
  section: { type: String, enum: ["Junior", "Senior", "General"], default: "General", index: true },
  targetId: { type: String, default: "" },
  targetType: { type: String, default: "" },
  method: { type: String, default: "" },
  route: { type: String, default: "" },
  ipAddress: { type: String, default: "" },
  userAgent: { type: String, default: "" },
}, { timestamps: true });

AuditLogSchema.index({ createdAt: -1 });
AuditLogSchema.index({ section: 1, createdAt: -1 });
AuditLogSchema.index({ module: 1, createdAt: -1 });

module.exports = mongoose.model("AuditLog", AuditLogSchema);
