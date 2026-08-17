// ONE-TIME migration — run this once after deploying the Grade.classId
// change, then never again.
//
//   node scripts/backfillGradeClassId.js
//
// (needs MONGO_URI set in the environment, same as the server)
//
// What it does: every Grade document created before this update has no
// `classId` of its own, so it would silently vanish from any class-scoped
// view (Class Reports, Teacher Grade Distribution, the class filter on
// Analytics, etc.) until it's backfilled.
//
// IMPORTANT CAVEAT: for a student who has ALREADY been promoted at least
// once, this script has no way to know which class they were actually in
// when an old grade was recorded — that information was never stored. The
// best it can do is stamp the student's CURRENT class onto their old
// grades, which is exactly the "record follows the student to their new
// class" behavior you're trying to get rid of. In practice this mainly
// matters for students who were promoted BEFORE this fix went in — any
// grade recorded from now on will correctly snapshot the student's class
// at that moment, so this is a one-time, shrinking problem, not an
// ongoing one. If you need last year's class-scoped reports to be exactly
// right for already-promoted students, the accurate fix is re-entering
// those grades against a Promotion record's `fromClass`; this script just
// keeps old data from disappearing outright.
require("dotenv").config();
const mongoose = require("mongoose");
const connectDB = require("../config/db");
const Grade = require("../models/Grade");
const User = require("../models/User");

async function run() {
  await connectDB();

  const missing = await Grade.find({ classId: { $in: [null, undefined] } }).select(
    "_id student",
  );
  console.log(`Found ${missing.length} grade(s) with no classId.`);

  const studentClassCache = new Map();
  let updated = 0;
  let skipped = 0;

  for (const g of missing) {
    const sid = String(g.student);
    if (!studentClassCache.has(sid)) {
      const student = await User.findById(sid).select("classId");
      studentClassCache.set(sid, student?.classId || null);
    }
    const classId = studentClassCache.get(sid);
    if (!classId) {
      skipped++;
      continue;
    }
    await Grade.updateOne({ _id: g._id }, { $set: { classId } });
    updated++;
  }

  console.log(`Backfilled ${updated} grade(s). Skipped ${skipped} (student has no class set).`);
  await mongoose.disconnect();
  process.exit(0);
}

run().catch((err) => {
  console.error("Backfill failed:", err);
  process.exit(1);
});
