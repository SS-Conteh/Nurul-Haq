const mongoose = require("mongoose");
const Grade = require("../models/Grade");
const connectDB = require("../config/db");

async function run() {
  await connectDB();
  const grades = await Grade.find({}).select("test examScore total");
  let changed = 0;
  for (const g of grades) {
    const t = Number(g.test || 0);
    const e = Number(g.examScore || 0);
    const next = Math.round(((t + e) / 2 + Number.EPSILON) * 10) / 10;
    if (Number(g.total) !== next) {
      await Grade.updateOne({ _id: g._id }, { $set: { total: next } });
      changed++;
    }
  }
  console.log(`Grade decimal migration complete. Checked ${grades.length}; updated ${changed}.`);
  await mongoose.connection.close();
}

run().catch(async (err) => {
  console.error(err);
  try { await mongoose.connection.close(); } catch {}
  process.exit(1);
});
