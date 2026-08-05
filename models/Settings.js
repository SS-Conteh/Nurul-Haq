const mongoose = require("mongoose");

const SettingsSchema = new mongoose.Schema(
  {
    schoolName: { type: String, default: "Nurul-Haq Islamic Academy" },
    address: { type: String, default: "Angola Town, New Jersey" },
    phone: { type: String, default: "+23279481354 / +23278221886" },
    motto: { type: String, default: "Knowledge and Perseverance" },
    logoUrl: { type: String, default: "/assets/logo.jpeg" },
    academicYear: { type: String, default: "2025/2026" },
    currentTerm: { type: String, default: "Term 2" },
    // Used on the report card header — set these from Settings each term.
    termBegins: { type: String, default: "" },
    termEnd: { type: String, default: "" },
    nextTermBegins: { type: String, default: "" },
    terminalDuration: { type: String, default: "" },
    // Cutoff times used to tag teacher QR clock-ins as Late / On Time
    morningShiftStart: { type: String, default: "08:00" },
    afternoonShiftStart: { type: String, default: "13:00" },
    preferences: {
      smsNotifications: { type: Boolean, default: true },
      autoCalculateGrades: { type: Boolean, default: true },
      darkModeDefault: { type: Boolean, default: true },
      maintenanceMode: { type: Boolean, default: false },
    },
  },
  { timestamps: true },
);

module.exports = mongoose.model("Settings", SettingsSchema);
