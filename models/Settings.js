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
    // The bank account isn't connected to the system, so the school's
    // starting balance (as of whenever bookkeeping switched over to this
    // system) is entered once by the General Admin and never changed again
    // — every balance shown afterwards is this + the deposit/withdrawal
    // ledger. null means it hasn't been recorded yet.
    bankOpeningBalance: { type: Number, default: null },
    bankOpeningBalanceSetAt: { type: Date, default: null },
    bankOpeningBalanceSetBy: { type: String, default: "" },
    // The fee a student owes per term, set once per level by the Principal
    // or General Admin. Every fee payment's Paid/Partial/Unpaid status is
    // derived from comparing what a student has paid against their level's
    // figure here — see routes/finance.js.
    feeAmounts: {
      Nursery: { type: Number, default: 0 },
      Primary: { type: Number, default: 0 },
      JSS: { type: Number, default: 0 },
      SSS: { type: Number, default: 0 },
    },
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
