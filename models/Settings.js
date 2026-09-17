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
    // Every academic year the system has ever operated under, oldest
    // first, including the current one — this is what powers the academic
    // year dropdown in the nav for every role. Nothing is ever removed
    // from it; picking an older year from the dropdown just filters
    // existing records down to that year instead of showing "current".
    academicYearHistory: { type: [String], default: ["2025/2026"] },
    // No default on purpose — the system must never assume a term. The
    // General Admin has to explicitly pick one in Settings; every place
    // that reads this (grade entry, dashboards, report cards, promotion)
    // treats "" as "no term set yet" and blocks/labels accordingly.
    currentTerm: { type: String, default: "" },
    // Every full "Term X · YYYY" string the school has ever operated
    // under, oldest first — this is what powers the Term dropdown on the
    // Grades page (and anywhere else a term needs picking) for every
    // role, the same way academicYearHistory powers the academic-year
    // dropdown. Appended to (never removed from) in routes/settings.js
    // whenever currentTerm/academicYear resolve to a term string that
    // isn't already on file. Nothing is ever deleted or moved when a new
    // term is set — a past term's grades simply stay tagged with the term
    // string they were entered under and become visible again the moment
    // that term is picked from the dropdown.
    termHistory: { type: [String], default: [] },
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
    // PER-CLASS annual fees — the newer, more granular version of
    // feeAmounts above. Each entry is one rule:
    //   { level, classGroup, className, amount }
    // A rule with a className applies to that one registered class only
    // ("SSS 1 Art"); a rule with only a classGroup applies to every section
    // in that group ("Class 1" → "Class 1A", "Class 1B"). Set from
    // Settings → Fee Structure by Class (level dropdown → class dropdown →
    // amount → save), and read EXCLUSIVELY through
    // utils/fees.js resolveRequiredFee(), which falls back to the level
    // figure in feeAmounts when a class has no rule of its own — so a
    // school that never touches this screen keeps behaving exactly as it
    // did before.
    classFees: {
      type: [
        {
          level: {
            type: String,
            enum: ["Nursery", "Primary", "JSS", "SSS"],
            required: true,
          },
          // e.g. "Nursery 1", "Class 3", "JSS 2", "Art"
          classGroup: { type: String, default: "", trim: true },
          // e.g. "Class 3B" — blank means the rule covers the whole group
          className: { type: String, default: "", trim: true },
          amount: { type: Number, default: 0, min: 0 },
          updatedBy: { type: String, default: "" },
          updatedAt: { type: Date, default: Date.now },
        },
      ],
      default: [],
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
