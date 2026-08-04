const mongoose = require("mongoose");

const BookSchema = new mongoose.Schema(
  {
    title: { type: String, required: true },
    author: { type: String, default: "" },
    subject: { type: String, default: "" },
    classLevel: { type: String, default: "All" },
    totalCopies: { type: Number, default: 1 },
    availableCopies: { type: Number, default: 1 },
  },
  { timestamps: true },
);

module.exports = mongoose.model("Book", BookSchema);
