const mongoose = require("mongoose");

const DailyQRCodeSchema = new mongoose.Schema(
  {
    date: { type: String, required: true }, // "YYYY-MM-DD"
    shift: { type: String, enum: ["Morning", "Afternoon"], required: true },
    code: { type: String, required: true, unique: true },
  },
  { timestamps: true },
);

DailyQRCodeSchema.index({ date: 1, shift: 1 }, { unique: true });

module.exports = mongoose.model("DailyQRCode", DailyQRCodeSchema);
