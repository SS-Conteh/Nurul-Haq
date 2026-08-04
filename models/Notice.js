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
    postedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    // Users who have cleared/deleted this notice for themselves only —
    // the notice still exists for everyone else and for the principal.
    clearedBy: [{ type: mongoose.Schema.Types.ObjectId, ref: "User" }],
  },
  { timestamps: true },
);

module.exports = mongoose.model("Notice", NoticeSchema);
