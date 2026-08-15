const mongoose = require("mongoose");

const SettingsSchema = new mongoose.Schema(
  {
    schoolName: { type: String, default: "Nurul-Haq Islamic Academy" },
    address: { type: String, default: "Angola Town, New Jersey" },
    phone: { type: String, default: "+23279481354 / +23278221886" },
    motto: { type: String, default: "Knowledge and Perseverance" },
    logoUrl: { type: String, default: "/assets/logo.jpeg" },
    // Shown in the "History" section of the public landing page. Edited by
    // the General Admin from Settings — updates here reflect on the landing
    // page immediately, no redeploy needed.
    schoolHistory: { type: String, default: "" },
    // Houses a student can be enrolled into (name + a hex color used for
    // their house badge). Managed from Settings → School Info by the
    // General Admin; offered as a dropdown when enrolling a student.
    houseColors: {
      type: [{ name: { type: String, trim: true }, color: { type: String, default: "#4f8cff" } }],
      default: [
        { name: "Red House", color: "#f87171" },
        { name: "Blue House", color: "#4f8cff" },
        { name: "Green House", color: "#22d3a0" },
        { name: "Yellow House", color: "#fbbf24" },
      ],
    },
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
    // The TOTAL fee a student owes for the whole academic year (not per
    // term), set once per level by the Principal or General Admin. A
    // student can pay this off however they like — in termly installments
    // or as a single lump sum — and every fee payment's Paid/Partial/Unpaid
    // status is derived from comparing what a student has paid so far this
    // academic year, in total, against their level's figure here — see
    // routes/finance.js.
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
