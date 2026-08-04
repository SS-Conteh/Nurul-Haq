const mongoose = require("mongoose");

const BorrowerSchema = new mongoose.Schema(
  {
    student: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    book: { type: mongoose.Schema.Types.ObjectId, ref: "Book", required: true },
    borrowedAt: { type: Date, default: Date.now },
    dueDate: { type: Date },
    returnedAt: { type: Date, default: null },
    status: { type: String, enum: ["Borrowed", "Returned"], default: "Borrowed" },
  },
  { timestamps: true },
);

module.exports = mongoose.model("Borrower", BorrowerSchema);
