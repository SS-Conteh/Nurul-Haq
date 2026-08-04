// One-time migration: classes registered before this fix all got saved with
// classGroup = "All Classes" for Primary/JSS (the old form disabled that
// field and auto-filled it). This derives the real group — "Class 1",
// "JSS 2", etc — from each class's name and updates the record. SSS classes
// are left untouched since their Department (Art/Science/Commercial) was
// already being set correctly.
//
// Run once from the backend/ folder:
//   node seed/fix-class-groups.js

require("dotenv").config();
const mongoose = require("mongoose");
const SchoolClass = require("../models/SchoolClass");

async function run() {
  const uri = process.env.MONGO_URI;
  if (!uri) {
    console.error("MONGO_URI not set in backend/.env — aborting.");
    process.exit(1);
  }
  await mongoose.connect(uri, { family: 4, serverSelectionTimeoutMS: 8000 });
  console.log("Connected. Scanning classes...");

  const classes = await SchoolClass.find({ level: { $in: ["Primary", "JSS"] } });
  let updated = 0;

  for (const c of classes) {
    // "Class 1A" -> "Class 1", "JSS 2B" -> "JSS 2"
    const match = c.name.match(/(Class|JSS)\s*(\d+)/i);
    if (!match) {
      console.warn(`  ⚠ Could not parse a grade number out of "${c.name}" — skipped, fix manually.`);
      continue;
    }
    const prefix = c.level === "Primary" ? "Class" : "JSS";
    const correctGroup = `${prefix} ${match[2]}`;
    if (c.classGroup !== correctGroup) {
      console.log(`  ${c.name}: "${c.classGroup}" -> "${correctGroup}"`);
      c.classGroup = correctGroup;
      await c.save();
      updated++;
    }
  }

  console.log(`Done. Updated ${updated} of ${classes.length} Primary/JSS classes.`);
  await mongoose.disconnect();
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
