const mongoose = require("mongoose");

const NoticeSchema = new mongoose.Schema(
  {
    title: { type: String, required: true },
    body: { type: String, required: true },
    author: { type: String, default: "Principal" },
    type: {
      type: String,
      enum: ["urgent", "info", "normal"],
      default: "normal",
    },
    // Who this notice is for. "teachers" notices are never visible to
    // students. "students" notices are visible to both students and
    // teachers (a teacher needs to see what's been announced to their own
    // classes). The Principal/Admin who post notices always see everything
    // regardless of category — see GET / below.
    category: {
      type: String,
      enum: ["teachers", "students"],
      required: true,
      default: "students",
    },
    postedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    // Same purpose as Grade.academicYear — set once at creation.
    academicYear: { type: String, default: "" },
    // Same purpose as academicYear, but for the current TERM — set once
    // at creation from Settings.currentTerm/academicYear (see
    // utils/academicYear.js currentTermString). Powers the term dropdown
    // on the Notices page. Empty string on notices posted before this
    // field existed.
    term: { type: String, default: "" },
    // Users who have cleared/deleted this notice for themselves only —
    // the notice still exists for everyone else and for the principal.
    clearedBy: [{ type: mongoose.Schema.Types.ObjectId, ref: "User" }],
  },
  { timestamps: true },
);

module.exports = mongoose.model("Notice", NoticeSchema);
