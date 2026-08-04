const mongoose = require("mongoose");

const FeeSchema = new mongoose.Schema(
  {
    student: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    term: { type: String, required: true },
    amount: { type: Number, required: true },
    paidOn: { type: Date },
    method: {
      type: String,
      enum: ["Cash", "Bank Transfer", "Mobile Money", ""],
      default: "",
    },
    receipt: { type: String, default: "" },
    status: {
      type: String,
      enum: ["Paid", "Partial", "Unpaid"],
      default: "Unpaid",
    },
  },
  { timestamps: true },
);

FeeSchema.index({ student: 1 });
FeeSchema.index({ status: 1 });

module.exports = mongoose.model("Fee", FeeSchema);
