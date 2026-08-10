// One-time migration: Fee records created before fees became an annual
// (rather than per-term) figure have no `academicYear` stamped on them —
// every finance query (summary/by-class/dashboard) now scopes its totals to
// Settings.academicYear, so without this those older payments would
// silently vanish from every fees screen instead of counting toward a
// student's year-to-date total.
//
// This stamps every Fee record that's still missing academicYear with the
// school's CURRENT academicYear from Settings. Safe to run more than once —
// it only touches records where academicYear is empty/missing.
//
// Run once from the backend/ folder:
//   node seed/backfill-fee-academic-year.js

require("dotenv").config();
const mongoose = require("mongoose");
const Fee = require("../models/Fee");
const Settings = require("../models/Settings");

async function run() {
  const uri = process.env.MONGO_URI;
  if (!uri) {
    console.error("MONGO_URI not set in backend/.env — aborting.");
    process.exit(1);
  }
  await mongoose.connect(uri, { family: 4, serverSelectionTimeoutMS: 8000 });
  console.log("Connected. Reading current academic year from Settings...");

  const settings = await Settings.findOne();
  const academicYear = settings?.academicYear;
  if (!academicYear) {
    console.error("Settings.academicYear is not set — set it first, then re-run this script.");
    await mongoose.disconnect();
    process.exit(1);
  }
  console.log(`Backfilling existing fee records with academicYear = "${academicYear}"...`);

  const result = await Fee.updateMany(
    { $or: [{ academicYear: { $exists: false } }, { academicYear: "" }] },
    { $set: { academicYear } },
  );

  console.log(`Done. Updated ${result.modifiedCount} fee record(s).`);
  await mongoose.disconnect();
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
